// Document intelligence: classify every uploaded document and extract its key data (with citations) through the
// watsonx Orchestrate agent tenderflow_document_intelligence; a person accepts, corrects or rejects the result and
// accepted data is put to work (verified vendor documents, classification prefill, extracted financial totals,
// request prefill, pack-check context, FileNet properties). FileNet stores the file; Orchestrate understands it;
// TenderFlow enforces the rules: sealed bid text is never read before the opening, flags are rule-based, nothing is
// applied without a person.
import type { Ctx } from '../../ctx.js';
import { auditTx, hasRole, isStaff, isVendor } from '../../ctx.js';
import type { Actor } from '../../auth/tokens.js';
import type { DocFieldValue, DocText, DocTypeDef, ExtractedField } from '../../ai/index.js';
import { normaliseDate, currencyIn, numbersIn } from '../../ai/parse.js';
import { ApiError, badRequest, camel, conflict, forbidden, isUuid, notFound, now, str, uuid } from '../../util.js';
import { loadReadableDocument, readPlain, readSealed, type DocumentRow } from '../../services/documents.js';
import { extractText } from '../../content/extract.js';
import { BID_READERS, financialSealed, loadBid, type BidRow } from '../../services/bids.js';
import { unwrapKey } from '../../services/vault.js';
import type { TenderRow } from '../../services/tenders.js';
import { configOf, getProfile } from '../../services/templates.js';
import { recordRun } from '../../services/ai-runs.js';
import { notify } from '../../services/notifications.js';
import { setClassification } from '../../services/eligibility.js';
import { catalogueFor, contextOf, typeByCode, CLASSIFIABLE_OWNER_TYPES } from '../../services/doc-catalogue.js';
import { computeFlags, expectedTypeOf, EXPIRY_KEYS, type EffectiveField, type Flag } from './flags.js';

export type InsightStatus = 'PENDING_REVIEW' | 'ACCEPTED' | 'CORRECTED' | 'REJECTED' | 'NOT_EXTRACTABLE' | 'FAILED';
export type Trigger = 'MANUAL' | 'UPLOAD' | 'OPENING' | 'FINANCIAL_OPENING';

export interface InsightRow {
  id: string; tenant_id: string; document_id: string; ai_run_id: string | null; status: InsightStatus; doc_type: string | null;
  language: string | null; fields: ExtractedField[]; summary_en: string | null; summary_ar: string | null; citations: unknown[];
  flags: Flag[]; error: string | null; trigger: Trigger; requested_by: string | null; corrected_doc_type: string | null;
  corrected_fields: (EffectiveField & { corrected?: boolean })[] | null; review_reason: string | null; reviewed_by: string | null;
  reviewed_at: Date | null; filenet: Record<string, unknown> | null; applied: Record<string, unknown>[]; created_at: Date;
}

export const NOT_EXTRACTABLE_EN = 'Scanned image or PDF without a text layer — OCR is not enabled. Roadmap: IBM Datacap or a watsonx.ai vision model.';
export const NOT_EXTRACTABLE_AR = 'صورة ممسوحة ضوئياً أو ملف PDF بلا طبقة نصية — التعرّف الضوئي على الحروف غير مفعّل. ضمن خارطة الطريق: IBM Datacap أو نموذج رؤية من watsonx.ai.';

const OFFICER_REVIEWERS = ['PROCUREMENT_OFFICER', 'TENANT_ADMIN'];
const BID_REVIEWERS = ['COMMITTEE_CHAIR', 'EVALUATOR'];
const isBidDoc = (d: { owner_type: string }) => d.owner_type === 'BID_TECHNICAL' || d.owner_type === 'BID_FINANCIAL';
const today = () => now().toISOString().slice(0, 10);

// ------------------------------------------------------------------ access

/**
 * Loads a document whose insight the actor may see: the same rule as reading the document (GET /documents/:id, shared
 * loadReadableDocument) and, for sealed bid documents, the bid rule (chair/evaluators/director after opening, the
 * financial envelope only once opened). Vendors never see insights of bid documents; never another vendor's.
 */
export async function loadDocForInsight(ctx: Ctx, a: Actor, id: string): Promise<DocumentRow> {
  if (!isUuid(id)) throw notFound('Document');
  const row = (await ctx.db.query<DocumentRow>('SELECT * FROM documents WHERE id=$1 AND tenant_id=$2', [id, a.tenantId]))[0];
  if (!row) throw notFound('Document');
  if (!isBidDoc(row)) return loadReadableDocument(ctx, a, id);
  if (!isStaff(a) || !row.bid_id) throw notFound('Document');
  if (!hasRole(a, ...BID_READERS)) throw forbidden('Only the committee chair, evaluators and the director may read opened bids');
  await assertBidReadable(ctx, row);
  return row;
}

/** Integrity rule: a sealed bid document is unreadable before the opening (financial: before the financial opening). */
async function assertBidReadable(ctx: Ctx, d: DocumentRow): Promise<{ bid: BidRow; tender: TenderRow }> {
  const bid = await loadBid(ctx, d.tenant_id, d.bid_id!);
  if (bid.status !== 'OPENED') throw new ApiError(403, 'BID_SEALED', 'Bid is sealed until the opening ceremony');
  const tender = (await ctx.db.query<TenderRow>('SELECT * FROM tenders WHERE id=$1', [bid.tender_id]))[0];
  if (d.owner_type === 'BID_FINANCIAL' && financialSealed(tender, bid))
    throw new ApiError(403, 'FINANCIAL_SEALED', 'The financial envelope stays sealed until the chair opens it for bids that passed the technical evaluation');
  return { bid, tender };
}

function canReview(a: Actor, d: DocumentRow): boolean {
  return isBidDoc(d) ? hasRole(a, ...BID_REVIEWERS) : hasRole(a, ...OFFICER_REVIEWERS);
}
function canClassify(a: Actor, d: DocumentRow): boolean {
  if (!contextOf(d.owner_type)) return false;
  if (isVendor(a)) return !isBidDoc(d) && d.owner_type === 'VENDOR' && !!a.vendorId && a.vendorId === d.vendor_id;
  return isStaff(a);
}

// ------------------------------------------------------------------ text + context

async function documentText(ctx: Ctx, d: DocumentRow): Promise<DocText> {
  let bytes: Buffer;
  if (d.encrypted) {
    const { bid } = await assertBidReadable(ctx, d); // defence in depth: whoever calls, sealed text is never read
    const key = unwrapKey(ctx.config.bidMasterKey, bid);
    try { bytes = await readSealed(ctx, d, key); } finally { key.fill(0); }
  } else bytes = await readPlain(ctx, d);
  return extractText({ documentId: d.id, title: d.title, mimeType: d.mime_type }, bytes);
}

interface DocContextInfo {
  vendor: { legalNameEn: string; legalNameAr: string } | null;
  tender: TenderRow | null;
  uploaderRole: string;
}
async function contextInfo(ctx: Ctx, d: DocumentRow): Promise<DocContextInfo> {
  const v = d.vendor_id ? (await ctx.db.query<{ legal_name_en: string; legal_name_ar: string }>('SELECT legal_name_en, legal_name_ar FROM vendors WHERE id=$1', [d.vendor_id]))[0] : undefined;
  const t = d.tender_id ? (await ctx.db.query<TenderRow>('SELECT * FROM tenders WHERE id=$1', [d.tender_id]))[0] : undefined;
  const u = d.uploaded_by ? (await ctx.db.query<{ roles: string[] }>('SELECT roles FROM users WHERE id=$1', [d.uploaded_by]))[0] : undefined;
  return { vendor: v ? { legalNameEn: v.legal_name_en, legalNameAr: v.legal_name_ar } : null, tender: t ?? null, uploaderRole: u?.roles?.[0] ?? 'SYSTEM' };
}

// ------------------------------------------------------------------ effective values + flags

export function effectiveOf(r: InsightRow): { docType: string | null; fields: (EffectiveField & { citation?: unknown; corrected?: boolean })[] } {
  return { docType: r.corrected_doc_type ?? r.doc_type, fields: (r.corrected_fields ?? r.fields ?? []) as any[] };
}

async function flagsFor(ctx: Ctx, d: DocumentRow, r: InsightRow, info?: DocContextInfo): Promise<Flag[]> {
  if (!['PENDING_REVIEW', 'ACCEPTED', 'CORRECTED'].includes(r.status)) return [];
  const eff = effectiveOf(r);
  const i = info ?? await contextInfo(ctx, d);
  const typeDef = await typeByCode(ctx, d.tenant_id, eff.docType);
  const ctxName = contextOf(d.owner_type);
  const cat = ctxName ? await catalogueFor(ctx, d.tenant_id, ctxName) : [];
  const flags = computeFlags({
    docType: eff.docType, fields: eff.fields, typeDef, today: today(),
    vendor: d.owner_type === 'VENDOR' || isBidDoc(d) ? i.vendor : null,
    expectedType: expectedTypeOf(d.owner_type, d.title, cat), tenderCurrency: i.tender?.currency ?? null,
  });
  for (const f of flags) {
    if (f.code !== 'TYPE_MISMATCH') continue;
    const [e, x] = [await typeByCode(ctx, d.tenant_id, String(f.data.expected)), await typeByCode(ctx, d.tenant_id, String(f.data.found))];
    Object.assign(f.data, { expectedEn: e?.nameEn ?? f.data.expected, expectedAr: e?.nameAr ?? f.data.expected, foundEn: x?.nameEn ?? f.data.found, foundAr: x?.nameAr ?? f.data.found });
  }
  return flags;
}

// ------------------------------------------------------------------ classification

const INSIGHT_COLS = `i.*, r.agent AS run_agent, r.model AS run_model, r.request -> 'orchestrate' ->> 'runId' AS orchestrate_run_id,
  r.request -> 'orchestrate' ->> 'repaired' AS orchestrate_repaired`;

async function insertInsight(ctx: Ctx, actor: Actor, d: DocumentRow, v: Partial<InsightRow> & { status: InsightStatus; trigger: Trigger }, action: string) {
  const id = uuid();
  return ctx.db.tx(async (q) => {
    const rows = await q.query<InsightRow>(
      `INSERT INTO document_insights (id, tenant_id, document_id, ai_run_id, status, doc_type, language, fields, summary_en, summary_ar,
         citations, flags, error, trigger, requested_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16) RETURNING *`,
      [id, d.tenant_id, d.id, v.ai_run_id ?? null, v.status, v.doc_type ?? null, v.language ?? null, JSON.stringify(v.fields ?? []),
        v.summary_en ?? null, v.summary_ar ?? null, JSON.stringify(v.citations ?? []), JSON.stringify(v.flags ?? []), v.error ?? null,
        v.trigger, isUuid(actor.id) ? actor.id : null, now()]);
    await auditTx(ctx, q, { tenantId: d.tenant_id, actor, action, resourceType: 'DOCUMENT', resourceId: d.id, newState: v.status,
      details: { insightId: id, aiRunId: v.ai_run_id ?? null, docType: v.doc_type ?? null, fields: (v.fields ?? []).map((f) => f.key),
        flags: (v.flags ?? []).map((f) => f.code), trigger: v.trigger, ownerType: d.owner_type, error: v.error?.slice(0, 300) ?? null } });
    return rows[0];
  });
}

/**
 * Runs the agent on one document (or records NOT_EXTRACTABLE). Throws 503 AI_NOT_CONFIGURED without writing anything
 * when Orchestrate is not configured. Agent failures are stored as a FAILED insight and rethrown (502).
 */
export async function classifyDocumentRow(ctx: Ctx, actor: Actor, d: DocumentRow, trigger: Trigger): Promise<InsightRow> {
  const context = contextOf(d.owner_type);
  if (!context) throw conflict('NOT_CLASSIFIABLE', `Documents of type ${d.owner_type} are generated by TenderFlow and are not classified`);
  if (!ctx.ai.isConfigured()) throw new ApiError(503, 'AI_NOT_CONFIGURED', 'watsonx Orchestrate is not configured (WXO_INSTANCE_URL / WXO_API_KEY).');
  const text = await documentText(ctx, d);
  if (!text.sections.length) {
    return insertInsight(ctx, actor, d, { status: 'NOT_EXTRACTABLE', trigger, error: `${NOT_EXTRACTABLE_EN} / ${NOT_EXTRACTABLE_AR}` }, 'DOCUMENT_INSIGHT_NOT_EXTRACTABLE');
  }
  const catalogue = await catalogueFor(ctx, d.tenant_id, context);
  const info = await contextInfo(ctx, d);
  let run: any;
  try {
    run = await recordRun(ctx, actor, d.tender_id, 'DOCUMENT_INTELLIGENCE', {
      documentId: d.id, ownerType: d.owner_type, trigger, sections: text.sections.length, catalogue: catalogue.map((t) => t.code),
    }, () => ctx.ai.classifyDocument({
      document: text, catalogue,
      context: { ownerType: d.owner_type, uploaderRole: info.uploaderRole, slotTitle: d.title, fileName: null },
    }), { subjectId: d.id });
  } catch (err) {
    const e = err as ApiError;
    if (e?.code === 'AI_NOT_CONFIGURED') throw err;
    await insertInsight(ctx, actor, d, { status: 'FAILED', trigger, ai_run_id: (e?.details as any)?.aiRunId ?? null, error: e?.message ?? String(err) }, 'DOCUMENT_INSIGHT_FAILED');
    throw err;
  }
  const out = run.response as { docType: string; language: string; fields: ExtractedField[]; summaryEn: string; summaryAr: string; citations: unknown[] };
  const draft = { status: 'PENDING_REVIEW', doc_type: out.docType, fields: out.fields, corrected_doc_type: null, corrected_fields: null } as unknown as InsightRow;
  const flags = await flagsFor(ctx, d, draft, info);
  return insertInsight(ctx, actor, d, {
    status: 'PENDING_REVIEW', trigger, ai_run_id: run.id, doc_type: out.docType, language: out.language, fields: out.fields,
    summary_en: out.summaryEn, summary_ar: out.summaryAr, citations: out.citations, flags,
  }, 'DOCUMENT_INSIGHT_CREATED');
}

export async function classifyManually(ctx: Ctx, actor: Actor, documentId: string) {
  const d = await loadDocForInsight(ctx, actor, documentId);
  if (!canClassify(actor, d)) throw forbidden(isVendor(actor) ? 'Vendors may classify only their own company documents' : 'Not allowed to classify this document');
  const row = await classifyDocumentRow(ctx, actor, d, 'MANUAL');
  return publicInsight(ctx, actor, d, await reloadInsight(ctx, row.id));
}

// ------------------------------------------------------------------ automatic queue (in-process, never blocks uploads)

interface QueueState { chain: Promise<void>; pending: Set<string> }
const queues = new WeakMap<Ctx, QueueState>();
const stateOf = (ctx: Ctx): QueueState => {
  let s = queues.get(ctx);
  if (!s) { s = { chain: Promise.resolve(), pending: new Set() }; queues.set(ctx, s); }
  return s;
};
export const isQueued = (ctx: Ctx, documentId: string) => stateOf(ctx).pending.has(documentId);
/** Resolves when every queued classification has finished (tests, graceful shutdown). */
export const queueIdle = async (ctx: Ctx) => { for (;;) { const c = stateOf(ctx).chain; await c; if (c === stateOf(ctx).chain) return; } };

export function enqueue(ctx: Ctx, actor: Actor, documentId: string, trigger: Trigger): boolean {
  const s = stateOf(ctx);
  if (s.pending.has(documentId) || !ctx.ai.isConfigured()) return false;
  s.pending.add(documentId);
  s.chain = s.chain.then(async () => {
    try {
      const d = (await ctx.db.query<DocumentRow>('SELECT * FROM documents WHERE id=$1', [documentId]))[0];
      if (d) await classifyDocumentRow(ctx, actor, d, trigger);
    } catch (err) {
      const e = err as ApiError;
      if (!['AI_ERROR', 'AI_NOT_CONFIGURED'].includes(String(e?.code))) console.error(`[docintel] auto classification of ${documentId} failed:`, e?.message ?? err);
    } finally { s.pending.delete(documentId); }
  });
  return true;
}

/** Whether uploads of this document are classified automatically (Orchestrate configured is checked by enqueue). */
export async function autoEnabled(ctx: Ctx, d: DocumentRow): Promise<boolean> {
  if (ctx.config.docAiAuto === false) return false;
  if (d.tender_id) {
    const t = (await ctx.db.query<TenderRow>('SELECT * FROM tenders WHERE id=$1', [d.tender_id]))[0];
    return !!t && (configOf(t).ai as any).documentIntelligence !== false;
  }
  const p = await getProfile(ctx, d.tenant_id);
  return typeof p.documentIntelligenceAuto === 'boolean' ? p.documentIntelligenceAuto : ctx.config.docAiAuto === true;
}

export async function onUploaded(ctx: Ctx, actor: Actor, documentIds: string[]) {
  for (const id of documentIds) {
    const d = (await ctx.db.query<DocumentRow>('SELECT * FROM documents WHERE id=$1', [id]))[0];
    if (!d || d.encrypted || isBidDoc(d) || !CLASSIFIABLE_OWNER_TYPES.includes(d.owner_type)) continue; // sealed bids: never at upload
    if (await autoEnabled(ctx, d)) enqueue(ctx, actor, d.id, 'UPLOAD');
  }
}

/** At opening: technical envelopes (and single envelopes); financial envelopes only when not sealed any more. */
export async function onBidsOpened(ctx: Ctx, actor: Actor, tenderId: string, trigger: 'OPENING' | 'FINANCIAL_OPENING') {
  if (ctx.config.docAiAuto === false || !ctx.ai.isConfigured()) return;
  const t = (await ctx.db.query<TenderRow>('SELECT * FROM tenders WHERE id=$1', [tenderId]))[0];
  if (!t || (configOf(t).ai as any).documentIntelligence === false) return;
  const bids = await ctx.db.query<BidRow>(`SELECT * FROM bids WHERE tender_id=$1 AND status='OPENED' ORDER BY submitted_at`, [tenderId]);
  for (const b of bids) {
    const docs = await ctx.db.query<DocumentRow>('SELECT * FROM documents WHERE bid_id=$1 ORDER BY owner_type DESC', [b.id]);
    for (const d of docs) {
      if (d.owner_type === 'BID_FINANCIAL' ? financialSealed(t, b) || (trigger === 'FINANCIAL_OPENING' && !b.financial_opened_at) : trigger !== 'OPENING') continue;
      enqueue(ctx, actor, d.id, trigger);
    }
  }
}

// ------------------------------------------------------------------ read

async function reloadInsight(ctx: Ctx, id: string): Promise<InsightRow & Record<string, any>> {
  return (await ctx.db.query<any>(`SELECT ${INSIGHT_COLS} FROM document_insights i LEFT JOIN ai_runs r ON r.id=i.ai_run_id WHERE i.id=$1`, [id]))[0];
}

async function latestInsight(ctx: Ctx, documentId: string): Promise<(InsightRow & Record<string, any>) | undefined> {
  return (await ctx.db.query<any>(`SELECT ${INSIGHT_COLS} FROM document_insights i LEFT JOIN ai_runs r ON r.id=i.ai_run_id
    WHERE i.document_id=$1 ORDER BY i.created_at DESC LIMIT 1`, [documentId]))[0];
}

/** Classification suggestion for the existing classifications editor (officer confirms; nothing is applied here). */
async function classificationSuggestion(ctx: Ctx, tenantId: string, fields: EffectiveField[]) {
  const by = new Map(fields.map((f) => [f.key, f.value]));
  const codesRaw = by.get('activityCodes');
  const items = Array.isArray(codesRaw) ? codesRaw : typeof codesRaw === 'string' ? codesRaw.split(/[,;،]/) : [];
  const known = await ctx.db.query<{ code: string; name_en: string; name_ar: string }>('SELECT code, name_en, name_ar FROM activity_codes WHERE tenant_id=$1', [tenantId]);
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const matched = known.filter((k) => items.some((x) => {
    const n = norm(String(x));
    return n.includes(norm(k.code)) || n.includes(norm(k.name_en)) || String(x).includes(k.name_ar);
  })).map((k) => k.code);
  const g = String(by.get('grade') ?? '');
  const grade = /\b(first|1st)\b|الأولى|الاولى|الدرجة 1|\b1\b/i.test(g) ? 1 : /\b(second|2nd)\b|الثانية|الثانيه|\b2\b/i.test(g) ? 2 : /\b(third|3rd)\b|الثالثة|الثالثه|\b3\b/i.test(g) ? 3 : null;
  const exp = by.get('expiryDate');
  return { activityCodes: matched, unmatched: items.map(String).filter((x) => !matched.some((c) => norm(x).includes(norm(c)))), grade, validUntil: typeof exp === 'string' ? exp : null };
}

export async function publicInsight(ctx: Ctx, actor: Actor, d: DocumentRow, r: (InsightRow & Record<string, any>) | undefined) {
  if (!r) return null;
  const eff = effectiveOf(r);
  const typeDef = await typeByCode(ctx, d.tenant_id, eff.docType);
  const aiType = r.doc_type ? await typeByCode(ctx, d.tenant_id, r.doc_type) : null;
  const defs = new Map((typeDef?.fields ?? []).map((f) => [f.key, f]));
  const aiByKey = new Map((r.fields ?? []).map((f) => [f.key, f]));
  const fields = eff.fields.map((f) => {
    const def = defs.get(f.key);
    const ai = aiByKey.get(f.key);
    return { key: f.key, value: f.value, raw: f.raw ?? null, labelEn: def?.labelEn ?? f.key, labelAr: def?.labelAr ?? f.key, type: def?.type ?? 'text',
      citation: (f as any).citation ?? ai?.citation ?? null, corrected: !!(f as any).corrected, aiValue: (f as any).corrected ? ai?.value ?? null : undefined };
  });
  const flags = await flagsFor(ctx, d, r);
  const reviewed = r.status === 'ACCEPTED' || r.status === 'CORRECTED';
  return {
    id: r.id, documentId: r.document_id, status: r.status, trigger: r.trigger,
    docType: eff.docType, docTypeNameEn: typeDef?.nameEn ?? eff.docType, docTypeNameAr: typeDef?.nameAr ?? eff.docType,
    aiDocType: r.doc_type, aiDocTypeNameEn: aiType?.nameEn ?? r.doc_type, aiDocTypeNameAr: aiType?.nameAr ?? r.doc_type,
    language: r.language, fields, aiFields: r.corrected_fields ? r.fields : undefined,
    missingFields: (typeDef?.fields ?? []).filter((f) => !eff.fields.some((x) => x.key === f.key)).map((f) => ({ key: f.key, labelEn: f.labelEn, labelAr: f.labelAr, type: f.type, required: f.required })),
    summaryEn: r.summary_en, summaryAr: r.summary_ar, citations: r.citations ?? [], flags,
    error: r.error, notExtractable: r.status === 'NOT_EXTRACTABLE' ? { en: NOT_EXTRACTABLE_EN, ar: NOT_EXTRACTABLE_AR } : null,
    aiRunId: r.ai_run_id, agent: r.run_agent ?? null, model: r.run_model ?? null, orchestrateRunId: r.orchestrate_run_id ?? null,
    repaired: r.orchestrate_repaired === 'true',
    reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at, reviewReason: r.review_reason, filenet: r.filenet, applied: r.applied ?? [],
    createdAt: r.created_at,
    canReview: r.status === 'PENDING_REVIEW' && canReview(actor, d),
    classificationSuggestion: reviewed && eff.docType === 'MOCI_CLASSIFICATION_CERT' && d.owner_type === 'VENDOR' && hasRole(actor, 'PROCUREMENT_OFFICER', 'TENANT_ADMIN')
      ? await classificationSuggestion(ctx, d.tenant_id, eff.fields) : null,
  };
}

export async function documentInsight(ctx: Ctx, actor: Actor, documentId: string) {
  const d = await loadDocForInsight(ctx, actor, documentId);
  const r = await latestInsight(ctx, d.id);
  return {
    documentId: d.id, configured: ctx.ai.isConfigured(), classifiable: !!contextOf(d.owner_type), queued: isQueued(ctx, d.id),
    canClassify: canClassify(actor, d) && ctx.ai.isConfigured(), insight: await publicInsight(ctx, actor, d, r),
  };
}

/** Latest insight of several documents at once (DocList badges); documents the actor may not read are left out. */
export async function latestForDocuments(ctx: Ctx, actor: Actor, idsRaw: unknown) {
  const ids = String(idsRaw ?? '').split(',').map((s) => s.trim()).filter(isUuid).slice(0, 100);
  const out: Record<string, unknown> = {};
  for (const id of ids) {
    try { out[id] = await documentInsight(ctx, actor, id); } catch { /* not readable → omitted */ }
  }
  return { configured: ctx.ai.isConfigured(), items: out };
}

// ------------------------------------------------------------------ review

function normaliseCorrection(type: string, v: unknown): DocFieldValue {
  const s = typeof v === 'string' ? v.trim() : v;
  switch (type) {
    case 'date': {
      const iso = normaliseDate(String(s ?? ''));
      if (!iso) throw badRequest(`"${String(s)}" is not a date (use YYYY-MM-DD)`);
      return iso;
    }
    case 'amount': {
      if (s && typeof s === 'object' && !Array.isArray(s)) {
        const a = Number((s as any).amount);
        if (!Number.isFinite(a) || a < 0) throw badRequest('amount must be a non-negative number');
        const c = String((s as any).currency ?? '').trim().toUpperCase();
        return { amount: a, currency: /^[A-Z]{3}$/.test(c) ? c : currencyIn(c) };
      }
      const n = numbersIn(String(s ?? ''));
      if (!n.length) throw badRequest(`"${String(s)}" is not an amount`);
      return { amount: Number(n[0]), currency: currencyIn(String(s)) };
    }
    case 'number': {
      const n = typeof s === 'number' ? s : Number(numbersIn(String(s ?? ''))[0]);
      if (!Number.isFinite(n)) throw badRequest(`"${String(s)}" is not a number`);
      return n;
    }
    case 'list': {
      const items = (Array.isArray(s) ? s.map(String) : String(s ?? '').split(/[,;،؛\n]+/)).map((x) => x.trim()).filter(Boolean);
      if (!items.length) throw badRequest('list is empty');
      return items.slice(0, 50).map((x) => x.slice(0, 300));
    }
    default: {
      const t = String(s ?? '').trim();
      if (!t) throw badRequest('value is empty');
      return t.slice(0, 1000);
    }
  }
}

async function loadInsightForActor(ctx: Ctx, actor: Actor, id: string) {
  if (!isUuid(id)) throw notFound('Document insight');
  const r = (await ctx.db.query<InsightRow>('SELECT * FROM document_insights WHERE id=$1 AND tenant_id=$2', [id, actor.tenantId]))[0];
  if (!r) throw notFound('Document insight');
  const d = await loadDocForInsight(ctx, actor, r.document_id);
  return { r, d };
}

export async function reviewInsight(ctx: Ctx, actor: Actor, id: string, b: any) {
  const { r, d } = await loadInsightForActor(ctx, actor, id);
  if (!canReview(actor, d)) throw forbidden(isBidDoc(d) ? 'Bid document data is reviewed by the committee chair or an evaluator' : 'Document data is reviewed by a procurement officer or the tenant admin');
  const decision = String(b?.decision ?? '').toUpperCase();
  if (!['ACCEPT', 'CORRECT', 'REJECT'].includes(decision)) throw badRequest("decision must be 'ACCEPT', 'CORRECT' or 'REJECT'");
  if (r.status !== 'PENDING_REVIEW') throw conflict('INVALID_STATE', `This result is ${r.status}; only results waiting for review can be decided`);
  const reason = str(b?.reason, 'reason', { max: 2000 }) ?? null;
  if (decision === 'REJECT' && !reason) throw badRequest('reason is required when rejecting');
  let correctedType: string | null = null;
  let correctedFields: (EffectiveField & { citation?: unknown; corrected?: boolean })[] | null = null;
  const changed: string[] = [];
  if (decision === 'CORRECT') {
    const ctxName = contextOf(d.owner_type)!;
    const cat = await catalogueFor(ctx, d.tenant_id, ctxName);
    const newType = b?.docType ? String(b.docType) : r.doc_type;
    const def: DocTypeDef | undefined = cat.find((t) => t.code === newType) ?? (await typeByCode(ctx, d.tenant_id, newType) ?? undefined);
    if (!def) throw badRequest(`docType must be one of: ${cat.map((t) => t.code).join(', ')}`);
    if (newType !== r.doc_type) { correctedType = newType; changed.push('docType'); }
    const base = newType === r.doc_type ? (r.fields ?? []).map((f) => ({ key: f.key, value: f.value, raw: f.raw, citation: f.citation })) : [];
    const map = new Map<string, EffectiveField & { citation?: unknown; corrected?: boolean }>(base.map((f) => [f.key, f]));
    if (b?.fields !== undefined && !Array.isArray(b.fields)) throw badRequest('fields must be an array of {key, value}');
    for (const [i, f] of (Array.isArray(b?.fields) ? b.fields : []).entries()) {
      const fd = def.fields.find((x) => x.key === f?.key);
      if (!fd) throw badRequest(`fields[${i}].key "${f?.key}" is not defined for ${def.code}`);
      if (f.value === null || f.value === '' || (Array.isArray(f.value) && !f.value.length)) { if (map.delete(fd.key)) changed.push(fd.key); continue; }
      const value = normaliseCorrection(fd.type, f.value);
      const prev = map.get(fd.key);
      if (prev && JSON.stringify(prev.value) === JSON.stringify(value)) continue;
      map.set(fd.key, { key: fd.key, value, raw: typeof f.value === 'string' ? f.value : JSON.stringify(f.value), citation: prev?.citation, corrected: true });
      changed.push(fd.key);
    }
    if (!changed.length) throw badRequest('No change: use ACCEPT when the extracted data is correct');
    correctedFields = def.fields.filter((x) => map.has(x.key)).map((x) => map.get(x.key)!);
  }
  const status: InsightStatus = decision === 'ACCEPT' ? 'ACCEPTED' : decision === 'CORRECT' ? 'CORRECTED' : 'REJECTED';
  const reviewedAt = now();
  const updated = await ctx.db.tx(async (q) => {
    const rows = await q.query<InsightRow>(
      `UPDATE document_insights SET status=$1, corrected_doc_type=$2, corrected_fields=$3::jsonb, review_reason=$4, reviewed_by=$5, reviewed_at=$6
        WHERE id=$7 AND status='PENDING_REVIEW' RETURNING *`,
      [status, correctedType, correctedFields ? JSON.stringify(correctedFields) : null, reason, actor.id, reviewedAt, r.id]);
    if (!rows[0]) throw conflict('INVALID_STATE', 'This result was reviewed concurrently');
    if (r.ai_run_id) await q.query(`UPDATE ai_runs SET reviewed_by=$1, review_decision=$2 WHERE id=$3`, [actor.id, status === 'ACCEPTED' ? 'ACCEPTED' : status === 'CORRECTED' ? 'EDITED' : 'IGNORED', r.ai_run_id]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'DOCUMENT_INSIGHT_REVIEWED', resourceType: 'DOCUMENT', resourceId: d.id,
      prevState: 'PENDING_REVIEW', newState: status, reason, details: { insightId: r.id, docType: correctedType ?? r.doc_type, aiDocType: r.doc_type, changed } });
    return rows[0];
  });
  if (status !== 'REJECTED') await afterAcceptance(ctx, actor, d, updated);
  return publicInsight(ctx, actor, d, await reloadInsight(ctx, r.id));
}

/** FileNet properties + vendor expiry notification. Never fails the review: errors are recorded on the insight. */
async function afterAcceptance(ctx: Ctx, actor: Actor, d: DocumentRow, r: InsightRow) {
  const eff = effectiveOf(r);
  const flags = await flagsFor(ctx, d, r);
  const expiry = EXPIRY_KEYS.map((k) => eff.fields.find((f) => f.key === k)?.value).find((v): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));
  const props: Record<string, string | boolean> = { TF_DocType: eff.docType ?? 'OTHER', TF_AIReviewed: true };
  if (expiry) props.TF_ExpiryDate = `${expiry}T00:00:00.000Z`;
  let filenet: Record<string, unknown>;
  if (!ctx.config.docAiProperties) filenet = { status: 'SKIPPED', detail: 'FILENET_AI_PROPERTIES is not enabled', at: now().toISOString() };
  else if (!ctx.store.setProperties) filenet = { status: 'SKIPPED', detail: `the ${ctx.store.type} store cannot set properties`, at: now().toISOString() };
  else {
    try {
      const res = await ctx.store.setProperties(d.store_ref, props);
      filenet = { status: res.ok ? 'WRITTEN' : 'SKIPPED', detail: res.detail, store: ctx.store.type, properties: res.ok ? props : undefined, at: now().toISOString() };
    } catch (err) {
      filenet = { status: 'FAILED', detail: String((err as Error)?.message ?? err).slice(0, 800), store: ctx.store.type, at: now().toISOString() };
    }
  }
  await ctx.db.tx(async (q) => {
    await q.query('UPDATE document_insights SET filenet=$1::jsonb WHERE id=$2', [JSON.stringify(filenet), r.id]);
    if (filenet.status === 'WRITTEN') {
      await q.query(`UPDATE documents SET store_meta = store_meta || jsonb_build_object('aiProperties', $1::jsonb) WHERE id=$2`, [JSON.stringify({ ...props, writtenAt: filenet.at }), d.id]);
    }
    if (filenet.status !== 'SKIPPED') {
      await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: filenet.status === 'WRITTEN' ? 'DOCUMENT_PROPERTIES_WRITTEN' : 'DOCUMENT_PROPERTIES_FAILED',
        resourceType: 'DOCUMENT', resourceId: d.id, details: { insightId: r.id, store: ctx.store.type, properties: Object.keys(props), detail: String(filenet.detail).slice(0, 500) } });
    }
    const exp = flags.find((f) => f.code === 'EXPIRED' || f.code === 'EXPIRING_SOON');
    if (exp && d.owner_type === 'VENDOR' && d.vendor_id) {
      const date = String(exp.data.date);
      await notify(q, { tenantId: d.tenant_id, vendorId: d.vendor_id, kind: exp.code === 'EXPIRED' ? 'DOCUMENT_EXPIRED' : 'DOCUMENT_EXPIRING',
        titleEn: exp.code === 'EXPIRED' ? `Your document "${d.title}" expired on ${date}` : `Your document "${d.title}" expires on ${date}`,
        titleAr: exp.code === 'EXPIRED' ? `انتهت صلاحية مستندكم "${d.title}" بتاريخ ${date}` : `تنتهي صلاحية مستندكم "${d.title}" بتاريخ ${date}`,
        body: { documentId: d.id, insightId: r.id, date } });
      await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'DOCUMENT_EXPIRY_NOTIFIED', resourceType: 'DOCUMENT', resourceId: d.id, details: { insightId: r.id, code: exp.code, date } });
    }
  });
}

// ------------------------------------------------------------------ put accepted data to work

export async function applyClassification(ctx: Ctx, actor: Actor, id: string, b: any) {
  const { r, d } = await loadInsightForActor(ctx, actor, id);
  if (!['ACCEPTED', 'CORRECTED'].includes(r.status)) throw conflict('INVALID_STATE', 'Only accepted data can be applied');
  const eff = effectiveOf(r);
  if (eff.docType !== 'MOCI_CLASSIFICATION_CERT' || d.owner_type !== 'VENDOR' || !d.vendor_id)
    throw conflict('NOT_A_CLASSIFICATION_CERT', 'Only an accepted MOCI classification certificate of a vendor can create a classification');
  if (b?.confirm !== true) throw badRequest('The officer must confirm the classification (confirm: true)');
  // Goes through the existing eligibility service (validation + its own audit event).
  const result = await setClassification(ctx, actor, d.vendor_id, { activityCode: b?.activityCode, grade: b?.grade, validUntil: b?.validUntil });
  const entry = { kind: 'VENDOR_CLASSIFICATION', activityCode: String(b.activityCode), grade: Number(b.grade), validUntil: b?.validUntil ?? null, by: actor.id, at: now().toISOString() };
  await ctx.db.tx(async (q) => {
    await q.query(`UPDATE document_insights SET applied = applied || $1::jsonb WHERE id=$2`, [JSON.stringify([entry]), r.id]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'DOCUMENT_INSIGHT_APPLIED', resourceType: 'DOCUMENT', resourceId: d.id,
      details: { insightId: r.id, ...entry } });
  });
  return { classifications: result, applied: entry };
}

/** Accepted data of a vendor's company documents (vendor page "Verified documents", vendor home "My documents"). */
export async function verifiedDocuments(ctx: Ctx, actor: Actor, vendorId: string) {
  if (!isUuid(vendorId)) throw notFound('Vendor');
  const v = (await ctx.db.query<{ id: string }>('SELECT id FROM vendors WHERE id=$1 AND tenant_id=$2', [vendorId, actor.tenantId]))[0];
  if (!v) throw notFound('Vendor');
  const docs = await ctx.db.query<DocumentRow>(`SELECT * FROM documents WHERE tenant_id=$1 AND vendor_id=$2 AND owner_type='VENDOR' ORDER BY created_at`, [actor.tenantId, vendorId]);
  const items = [];
  for (const d of docs) {
    const latest = await latestInsight(ctx, d.id);
    const reviewed = (await ctx.db.query<any>(`SELECT ${INSIGHT_COLS} FROM document_insights i LEFT JOIN ai_runs r ON r.id=i.ai_run_id
      WHERE i.document_id=$1 AND i.status IN ('ACCEPTED','CORRECTED') ORDER BY i.reviewed_at DESC LIMIT 1`, [d.id]))[0];
    items.push({ documentId: d.id, title: d.title, createdAt: d.created_at, latestStatus: latest?.status ?? null,
      verified: reviewed ? await publicInsight(ctx, actor, d, reviewed) : null });
  }
  return { configured: ctx.ai.isConfigured(), items };
}

/** Financial totals extracted by Orchestrate per opened bid (shown "verify against the document"; never scores). */
export async function extractedTotals(ctx: Ctx, actor: Actor, tenderId: string) {
  if (!isUuid(tenderId)) throw notFound('Tender');
  const t = (await ctx.db.query<TenderRow>('SELECT * FROM tenders WHERE id=$1 AND tenant_id=$2', [tenderId, actor.tenantId]))[0];
  if (!t) throw notFound('Tender');
  const bids = await ctx.db.query<BidRow>(`SELECT * FROM bids WHERE tender_id=$1 AND status='OPENED' ORDER BY submitted_at`, [t.id]);
  const out = [];
  for (const b of bids) {
    if (financialSealed(t, b)) { out.push({ bidId: b.id, sealed: true, documentId: null, insight: null }); continue; }
    const d = (await ctx.db.query<DocumentRow>(`SELECT * FROM documents WHERE bid_id=$1 AND owner_type='BID_FINANCIAL' ORDER BY created_at LIMIT 1`, [b.id]))[0];
    if (!d) { out.push({ bidId: b.id, sealed: false, documentId: null, insight: null }); continue; }
    const r = await latestInsight(ctx, d.id);
    const p = await publicInsight(ctx, actor, d, r);
    const total = p?.fields.find((f) => f.key === 'totalAmount');
    out.push({ bidId: b.id, sealed: false, documentId: d.id, title: d.title, queued: isQueued(ctx, d.id),
      insight: p ? { id: p.id, status: p.status, docType: p.docType, totalAmount: total?.value ?? null, citation: total?.citation ?? null, flags: p.flags } : null });
  }
  return { configured: ctx.ai.isConfigured(), tenderCurrency: t.currency, items: out };
}

// ------------------------------------------------------------------ staff queue

export async function insightQueue(ctx: Ctx, actor: Actor, q: Record<string, unknown>) {
  const status = typeof q.status === 'string' && q.status ? q.status : null;
  const ownerType = typeof q.ownerType === 'string' && q.ownerType ? q.ownerType : null;
  const docType = typeof q.docType === 'string' && q.docType ? q.docType : null;
  const rows = await ctx.db.query<any>(
    `SELECT * FROM (
       SELECT DISTINCT ON (i.document_id) ${INSIGHT_COLS}, d.title AS doc_title, d.owner_type AS doc_owner_type, d.vendor_id AS doc_vendor_id,
              d.tender_id AS doc_tender_id, d.owner_id AS doc_owner_id, d.bid_id AS doc_bid_id, d.created_at AS doc_created_at,
              t.tender_number, t.title_en AS tender_title_en, t.title_ar AS tender_title_ar, v.legal_name_en, v.legal_name_ar,
              pr.request_number, pr.id AS request_id
         FROM document_insights i JOIN documents d ON d.id=i.document_id
         LEFT JOIN ai_runs r ON r.id=i.ai_run_id
         LEFT JOIN tenders t ON t.id=d.tender_id LEFT JOIN vendors v ON v.id=d.vendor_id
         LEFT JOIN procurement_requests pr ON pr.letter_document_id=d.id
        WHERE i.tenant_id=$1 ORDER BY i.document_id, i.created_at DESC) x
      ORDER BY x.created_at DESC LIMIT 500`, [actor.tenantId]);
  const items = []; const counts: Record<string, number> = {}; const docTypes = new Set<string>();
  for (const x of rows) {
    // Bid documents only for the people who may read the opened bids (same rule as everywhere else).
    if (x.doc_owner_type.startsWith('BID_')) {
      try { await loadDocForInsight(ctx, actor, x.document_id); } catch { continue; }
    }
    const eff = x.corrected_doc_type ?? x.doc_type;
    if (eff) docTypes.add(eff);
    counts[x.status] = (counts[x.status] ?? 0) + 1;
    if ((status && x.status !== status) || (ownerType && x.doc_owner_type !== ownerType) || (docType && eff !== docType)) continue;
    const typeDef = await typeByCode(ctx, actor.tenantId, eff);
    const d = { ...x, id: x.document_id, owner_type: x.doc_owner_type, vendor_id: x.doc_vendor_id, tender_id: x.doc_tender_id, title: x.doc_title, tenant_id: actor.tenantId } as DocumentRow;
    const flags = await flagsFor(ctx, d, x);
    const owner = x.doc_owner_type === 'VENDOR' ? { kind: 'VENDOR', id: x.doc_vendor_id, labelEn: x.legal_name_en, labelAr: x.legal_name_ar }
      : x.doc_owner_type === 'REQUEST_LETTER' ? { kind: 'REQUEST', id: x.request_id ?? x.doc_owner_id, labelEn: x.request_number, labelAr: x.request_number }
      : { kind: 'TENDER', id: x.doc_tender_id, labelEn: `${x.tender_number ?? ''} ${x.tender_title_en ?? ''}`.trim(), labelAr: `${x.tender_number ?? ''} ${x.tender_title_ar ?? ''}`.trim(),
        vendorEn: x.legal_name_en ?? null, vendorAr: x.legal_name_ar ?? null };
    items.push({
      id: x.id, documentId: x.document_id, title: x.doc_title, ownerType: x.doc_owner_type, status: x.status, trigger: x.trigger,
      docType: eff, docTypeNameEn: typeDef?.nameEn ?? eff, docTypeNameAr: typeDef?.nameAr ?? eff, fieldCount: (x.corrected_fields ?? x.fields ?? []).length,
      flags, owner, createdAt: x.created_at, reviewedAt: x.reviewed_at, canReview: x.status === 'PENDING_REVIEW' && canReview(actor, d), agent: x.run_agent ?? null,
    });
  }
  return { configured: ctx.ai.isConfigured(), counts, docTypes: [...docTypes].sort(), items };
}
