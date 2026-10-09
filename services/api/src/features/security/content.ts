// Content protection for tender documents (MOI SEC-001/002 "no screenshots while viewing", FR-023 watermarked
// download). Mode per tender: template config `contentProtection` → entity security setting → entity profile
// `contentProtection` → OFF. Applies to vendors only and to TENDER_PACK / ADDENDUM documents; staff see originals.
//
// Viewer design (see docs/SECURITY-FEATURES.md): the server extracts the document text page by page (PDF via unpdf,
// DOCX via mammoth, TXT/MD as is; PNG/JPG as the image), adds an invisible per-view fingerprint, audits the view and
// returns it with the watermark lines. The browser paints text + tiled watermark into the same <canvas> pixels — the
// text is never in the DOM, so it cannot be selected/copied, and any screenshot carries the watermark.
import type { Ctx } from '../../ctx.js';
import { policiesOf } from '../../services/entity-policies.js';
import { auditTx, isVendor } from '../../ctx.js';
import type { Actor } from '../../auth/tokens.js';
import { ApiError, conflict, forbidden, isUuid, notFound, now, sha256Hex, uuid } from '../../util.js';
import { loadReadableDocument, readPlain, type DocumentRow } from '../../services/documents.js';
import { configOf } from '../../services/templates.js';
import { purchaseOf } from '../../services/eligibility.js';
import { fingerprintText, stampPdf, type Watermark } from '../../content/watermark.js';
import { splitByHeadings, stripHtml } from '../../content/extract.js';
import { CONTENT_MODES, loadSettings, type ContentMode } from './settings.js';

export const PROTECTED_OWNER_TYPES = ['TENDER_PACK', 'ADDENDUM'];
const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_VIEW_CHARS = 1_500_000;
const PAGE_CHARS = 2_600;
const EVENT_TYPES = ['PRINTSCREEN_KEY', 'PRINT_ATTEMPT', 'COPY_ATTEMPT', 'SAVE_ATTEMPT', 'CONTEXT_MENU'] as const;
const MAX_EVENTS_PER_VIEW = 30;

const validMode = (v: unknown): ContentMode | null => (CONTENT_MODES.includes(v as ContentMode) ? (v as ContentMode) : null);

interface TenderLite { id: string; tenant_id: string; template_snapshot: any; tender_number: string }

async function tenderOf(ctx: Ctx, d: DocumentRow): Promise<TenderLite | null> {
  if (!d.tender_id) return null;
  return (await ctx.db.query<TenderLite>('SELECT id, tenant_id, template_snapshot, tender_number FROM tenders WHERE id=$1 AND tenant_id=$2', [d.tender_id, d.tenant_id]))[0] ?? null;
}

/** Effective protection mode of one document, and where it came from. */
export async function contentModeForDoc(ctx: Ctx, d: DocumentRow, t?: TenderLite | null): Promise<{ mode: ContentMode; source: string }> {
  if (!PROTECTED_OWNER_TYPES.includes(d.owner_type)) return { mode: 'OFF', source: 'NOT_A_TENDER_DOCUMENT' };
  const tender = t === undefined ? await tenderOf(ctx, d) : t;
  const snap = tender?.template_snapshot;
  const fromTemplate = validMode(snap?.config?.contentProtection) ?? validMode(snap?.contentProtection);
  if (fromTemplate) return { mode: fromTemplate, source: 'TEMPLATE' };
  const s = await loadSettings(ctx, d.tenant_id);
  if (s.contentProtection) return { mode: s.contentProtection, source: 'ENTITY_SECURITY_SETTINGS' };
  // Entity policies page (BRD SEC-001/002, FR-023): NONE means "no decision recorded there".
  const pol = (await policiesOf(ctx.db, d.tenant_id)).contentProtection;
  if (pol === 'VIEW_ONLY' || pol === 'WATERMARKED_DOWNLOAD') return { mode: pol, source: 'ENTITY_POLICIES' };
  const prof = (await ctx.db.query<{ profile: any }>('SELECT profile FROM tenants WHERE id=$1', [d.tenant_id]))[0]?.profile;
  const fromProfile = validMode(prof?.contentProtection);
  if (fromProfile) return { mode: fromProfile, source: 'ENTITY_PROFILE' };
  return { mode: 'OFF', source: 'DEFAULT' };
}

/** Hook of GET /documents/:id — vendors never receive the original of a protected tender document. */
export async function assertOriginalDownloadAllowed(ctx: Ctx, actor: Actor, d: DocumentRow) {
  if (!isVendor(actor)) return;
  const { mode } = await contentModeForDoc(ctx, d);
  if (mode === 'OFF') return;
  throw new ApiError(403, 'CONTENT_PROTECTED', mode === 'WATERMARKED_DOWNLOAD'
    ? 'This tender document is protected: open it in the protected viewer or download the watermarked copy'
    : 'This tender document is protected: open it in the protected viewer (view only)', { mode });
}

async function purchaseState(ctx: Ctx, t: TenderLite | null, vendorId: string | null) {
  if (!t) return { required: false, purchased: false, receipt: null as string | null };
  const required = configOf(t).stages.documentPurchase;
  const p = vendorId ? await purchaseOf(ctx.db, t.id, vendorId) : null;
  return { required, purchased: !!p, receipt: (p?.receipt_number as string | undefined) ?? null };
}

export type DownloadState = 'ORIGINAL' | 'WATERMARKED' | 'PURCHASE_REQUIRED' | 'VIEW_ONLY_FORMAT' | 'NONE';

function downloadState(mode: ContentMode, d: DocumentRow, staff: boolean, purchase: { required: boolean; purchased: boolean }): DownloadState {
  if (staff || mode === 'OFF') return 'ORIGINAL';
  if (mode === 'VIEW_ONLY') return 'NONE';
  if (d.mime_type !== PDF) return 'VIEW_ONLY_FORMAT';
  if (purchase.required && !purchase.purchased) return 'PURCHASE_REQUIRED';
  return 'WATERMARKED';
}

/** GET /security/content/documents?ids=… — what the document list may offer for each document. */
export async function documentAccess(ctx: Ctx, actor: Actor, idsRaw: unknown) {
  const ids = (Array.isArray(idsRaw) ? idsRaw : String(idsRaw ?? '').split(',')).map(String).filter(isUuid).slice(0, 100);
  const vendor = isVendor(actor);
  const out = [];
  for (const id of ids) {
    let d: DocumentRow;
    try { d = await loadReadableDocument(ctx, actor, id); } catch { continue; }
    const t = await tenderOf(ctx, d);
    const { mode, source } = await contentModeForDoc(ctx, d, t);
    const purchase = vendor ? await purchaseState(ctx, t, actor.vendorId) : { required: false, purchased: false, receipt: null };
    out.push({
      documentId: id, mode: vendor ? mode : 'OFF', source, protected: vendor && mode !== 'OFF',
      viewer: vendor && mode !== 'OFF', download: downloadState(mode, d, !vendor, purchase),
      purchaseRequired: purchase.required, purchased: purchase.purchased,
    });
  }
  return out;
}

async function watermarkFor(ctx: Ctx, actor: Actor, ref: string, receipt: string | null): Promise<Watermark & { linesAr: string[] }> {
  const at = now().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  if (actor.vendorId) {
    const v = (await ctx.db.query<{ legal_name_en: string; legal_name_ar: string; cr_number: string }>(
      'SELECT legal_name_en, legal_name_ar, cr_number FROM vendors WHERE id=$1 AND tenant_id=$2', [actor.vendorId, actor.tenantId]))[0];
    const cr = v?.cr_number ?? '—';
    const idLine = `Vendor ${actor.vendorId.slice(0, 8)} · ${/^CR/i.test(cr) ? cr : `CR ${cr}`}`;
    const lines = [v?.legal_name_en ?? 'Vendor', idLine, `user ${actor.username}`, at, `ref ${ref.slice(0, 8)}`, ...(receipt ? [`receipt ${receipt}`] : [])];
    return {
      lines,
      linesAr: [v?.legal_name_ar ?? v?.legal_name_en ?? 'Vendor', ...lines.slice(1)],
      footer: `Licensed to ${v?.legal_name_en ?? 'vendor'} (${idLine}) · ${actor.username} · ${at} · ref ${ref.slice(0, 8)}${receipt ? ` · receipt ${receipt}` : ''} · TenderFlow — do not redistribute`,
    };
  }
  const lines = [`staff ${actor.username}`, `entity ${actor.tenantId}`, at, `ref ${ref.slice(0, 8)}`];
  return { lines, linesAr: lines, footer: lines.join(' · ') };
}

function paginate(text: string): string[] {
  const pages: string[] = [];
  const sections = splitByHeadings(text);
  let buf = '';
  const push = () => { if (buf.trim()) pages.push(buf.trim()); buf = ''; };
  const blocks = sections.length ? sections.map((s) => (s.section.startsWith('part ') || s.section === 'introduction' ? s.text : `${s.section}\n\n${s.text}`)) : [text];
  for (const b of blocks) {
    if (buf && buf.length + b.length > PAGE_CHARS) push();
    if (b.length > PAGE_CHARS) {
      const paras = b.split(/\n/);
      for (const p of paras) {
        if (buf.length + p.length > PAGE_CHARS) push();
        buf += (buf ? '\n' : '') + p;
      }
    } else buf += (buf ? '\n\n' : '') + b;
  }
  push();
  return pages;
}

type Page = { kind: 'text'; text: string } | { kind: 'image'; dataUrl: string } | { kind: 'empty'; reason: string; pageNumber: number };

async function pagesOf(d: DocumentRow, bytes: Buffer): Promise<Page[]> {
  const mt = d.mime_type.toLowerCase();
  if (mt === PDF) {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: false });
    return text.map((t, i) => (t.trim() ? { kind: 'text', text: t.trim() } : { kind: 'empty', reason: 'NO_TEXT_LAYER', pageNumber: i + 1 }));
  }
  if (mt === DOCX) {
    const mammoth = (await import('mammoth')).default;
    const { value } = await mammoth.extractRawText({ buffer: bytes });
    return paginate(value).map((text) => ({ kind: 'text', text }));
  }
  if (mt === 'text/html') return paginate(stripHtml(bytes.toString('utf8'))).map((text) => ({ kind: 'text', text }));
  if (mt.startsWith('text/')) return paginate(bytes.toString('utf8')).map((text) => ({ kind: 'text', text }));
  if (mt === 'image/png' || mt === 'image/jpeg') return [{ kind: 'image', dataUrl: `data:${mt};base64,${bytes.toString('base64')}` }];
  return [{ kind: 'empty', reason: 'UNSUPPORTED_FORMAT', pageNumber: 1 }];
}

/** POST /security/content/documents/:id/view — open the protected viewer (audited TENDER_DOCUMENT_VIEWED). */
export async function openView(ctx: Ctx, actor: Actor, id: string) {
  const d = await loadReadableDocument(ctx, actor, id);
  const t = await tenderOf(ctx, d);
  const { mode, source } = await contentModeForDoc(ctx, d, t);
  const viewId = uuid();
  const purchase = isVendor(actor) ? await purchaseState(ctx, t, actor.vendorId) : { required: false, purchased: false, receipt: null };
  const wm = await watermarkFor(ctx, actor, viewId, purchase.receipt);
  let pages = await pagesOf(d, await readPlain(ctx, d));
  let chars = 0;
  pages = pages.map((p) => {
    if (p.kind !== 'text') return p;
    chars += p.text.length;
    return { kind: 'text', text: fingerprintText(p.text, viewId) };
  });
  if (chars > MAX_VIEW_CHARS) throw new ApiError(413, 'DOCUMENT_TOO_LARGE_FOR_VIEWER', 'This document is too large for the protected viewer');
  await ctx.db.tx(async (q) => {
    await q.query(`INSERT INTO content_views (id, tenant_id, document_id, user_id, vendor_id, kind) VALUES ($1,$2,$3,$4,$5,'VIEW')`,
      [viewId, actor.tenantId, d.id, actor.id, actor.vendorId]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: d.tender_id ? 'TENDER_DOCUMENT_VIEWED' : 'DOCUMENT_VIEWED_PROTECTED', resourceType: 'DOCUMENT', resourceId: d.id,
      details: { viewId, vendorId: actor.vendorId, username: actor.username, tenderId: d.tender_id, tenderNumber: t?.tender_number ?? null, title: d.title, mode, pages: pages.length } });
  });
  return {
    viewId, documentId: d.id, title: d.title, mimeType: d.mime_type, mode, source,
    download: downloadState(mode, d, !isVendor(actor), purchase),
    watermark: { lines: wm.lines, linesAr: wm.linesAr },
    pages,
  };
}

/** POST /security/content/views/:id/events — deterrent events from the viewer (PrintScreen, print, copy). */
export async function recordViewEvent(ctx: Ctx, actor: Actor, viewId: string, body: any) {
  if (!isUuid(viewId)) throw notFound('View');
  const type = body?.type;
  if (!EVENT_TYPES.includes(type)) throw new ApiError(400, 'VALIDATION_ERROR', `type must be one of ${EVENT_TYPES.join(', ')}`);
  return ctx.db.tx(async (q) => {
    const v = (await q.query<{ id: string; document_id: string; events: number }>(
      'SELECT id, document_id, events FROM content_views WHERE id=$1 AND tenant_id=$2 AND user_id=$3', [viewId, actor.tenantId, actor.id]))[0];
    if (!v) throw notFound('View');
    if (v.events >= MAX_EVENTS_PER_VIEW) return { recorded: false, reason: 'EVENT_LIMIT' };
    await q.query('UPDATE content_views SET events=events+1 WHERE id=$1', [viewId]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'CONTENT_PROTECTION_EVENT', resourceType: 'DOCUMENT', resourceId: v.document_id,
      details: { type, viewId, vendorId: actor.vendorId } });
    return { recorded: true };
  });
}

/** GET /security/content/documents/:id/download — watermarked PDF copy for vendors (mode WATERMARKED_DOWNLOAD). */
export async function watermarkedDownload(ctx: Ctx, actor: Actor, id: string) {
  if (!isVendor(actor) || !actor.vendorId) throw forbidden('The watermarked copy is for vendor users; staff download the original');
  const d = await loadReadableDocument(ctx, actor, id);
  const t = await tenderOf(ctx, d);
  const { mode } = await contentModeForDoc(ctx, d, t);
  if (mode === 'OFF') throw conflict('NOT_PROTECTED', 'This document is not protected; download the original');
  if (mode === 'VIEW_ONLY') throw new ApiError(403, 'CONTENT_PROTECTED', 'This tender document is view-only: downloads are not allowed', { mode });
  const purchase = await purchaseState(ctx, t, actor.vendorId);
  if (purchase.required && !purchase.purchased) throw new ApiError(402, 'PURCHASE_REQUIRED', 'Purchase the tender documents to download a watermarked copy');
  if (d.mime_type !== PDF) throw conflict('VIEW_ONLY_FORMAT', 'Only PDF documents can be downloaded with a watermark; this file is available in the protected viewer');
  const downloadId = uuid();
  const wm = await watermarkFor(ctx, actor, downloadId, purchase.receipt);
  const stamped = await stampPdf(await readPlain(ctx, d), wm, { id: downloadId, title: d.title });
  const sha = sha256Hex(stamped);
  await ctx.db.tx(async (q) => {
    await q.query(`INSERT INTO content_views (id, tenant_id, document_id, user_id, vendor_id, kind) VALUES ($1,$2,$3,$4,$5,'DOWNLOAD')`,
      [downloadId, actor.tenantId, d.id, actor.id, actor.vendorId]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'TENDER_DOCUMENT_DOWNLOADED_WATERMARKED', resourceType: 'DOCUMENT', resourceId: d.id,
      details: { downloadId, vendorId: actor.vendorId, username: actor.username, tenderId: d.tender_id, receipt: purchase.receipt, originalSha256: d.sha256_plain, watermarkedSha256: sha } });
  });
  const title = d.title.replace(/\.pdf$/i, '') + ' (watermarked).pdf';
  return { doc: { ...d, title, sha256_plain: sha, mime_type: PDF }, bytes: stamped };
}
