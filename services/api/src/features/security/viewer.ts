// HARDEN: protected document viewer for PDFs and images (docs/SECURITY-FEATURES.md §"Protected document viewer").
//
//   POST /documents/:id/view-grant  → { grant, expiresAt, … }: a random single-use grant, valid 60 s, bound to the
//                                     entity, the document and the signed-in user (only its SHA-256 is stored).
//   GET  /documents/:id/view-bytes   with header X-Viewer-Grant → the document as a PDF with the watermark (user, time,
//                                     entity / vendor, reference) stamped into every page on the server; images are
//                                     wrapped into a one-page PDF first. Cache-Control: no-store, Content-Disposition:
//                                     inline without a file name. The grant is consumed and DOCUMENT_VIEWED audited in
//                                     the same transaction.
//
// Read rules are exactly those of the download routes: loadReadableDocument (deny by default) for entity documents,
// loadReadableBidDocument for bid envelopes — a sealed bid (or a sealed financial envelope) stays sealed. The browser
// renders the PDF with pdf.js into <canvas> only (no text layer, no download / print UI).
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import type { Ctx } from '../../ctx.js';
import { auditTx, isVendor } from '../../ctx.js';
import type { Actor } from '../../auth/tokens.js';
import { ApiError, isUuid, notFound, now, sha256Hex, uuid } from '../../util.js';
import { loadReadableDocument, readPlain, type DocumentRow } from '../../services/documents.js';
import { loadReadableBidDocument, readBidDocument, type BidRow } from '../../services/bids.js';
import { stampPdf } from '../../content/watermark.js';
import { contentModeForDoc, downloadState, purchaseState, tenderOf, watermarkFor } from './content.js';

export const VIEW_GRANT_TTL_MS = 60_000;
export const VIEWER_GRANT_HEADER = 'x-viewer-grant';
const PDF = 'application/pdf';
export const VIEWABLE_TYPES = [PDF, 'image/png', 'image/jpeg'];

const hashGrant = (g: string) => crypto.createHash('sha256').update(g).digest('hex');

/** The document if the actor may read it through the same rules as the download routes. */
async function loadViewable(ctx: Ctx, actor: Actor, id: string): Promise<{ doc: DocumentRow; bid: BidRow | null }> {
  if (!isUuid(id)) throw notFound('Document');
  const row = (await ctx.db.query<{ owner_type: string; bid_id: string | null }>(
    'SELECT owner_type, bid_id FROM documents WHERE id=$1 AND tenant_id=$2', [id, actor.tenantId]))[0];
  if (!row) throw notFound('Document');
  if (row.owner_type.startsWith('BID_')) {
    if (!row.bid_id) throw notFound('Document');
    const { bid, doc } = await loadReadableBidDocument(ctx, actor, row.bid_id, id);
    return { doc, bid };
  }
  return { doc: await loadReadableDocument(ctx, actor, id), bid: null };
}

function assertViewableType(d: DocumentRow) {
  if (!VIEWABLE_TYPES.includes(d.mime_type.toLowerCase()))
    throw new ApiError(415, 'VIEWER_FORMAT_UNSUPPORTED', 'The protected PDF viewer shows PDF, PNG and JPEG files; this document opens in the text viewer');
}

/** POST /documents/:id/view-grant */
export async function issueViewGrant(ctx: Ctx, actor: Actor, id: string) {
  const { doc } = await loadViewable(ctx, actor, id);
  assertViewableType(doc);
  const vendor = isVendor(actor);
  const t = doc.tender_id ? await tenderOf(ctx, doc) : null;
  const { mode } = await contentModeForDoc(ctx, doc, t);
  const purchase = vendor ? await purchaseState(ctx, t, actor.vendorId) : { required: false, purchased: false };
  const grant = crypto.randomBytes(32).toString('base64url');
  const issuedAt = now();
  const expiresAt = new Date(issuedAt.getTime() + VIEW_GRANT_TTL_MS);
  await ctx.db.query('DELETE FROM view_grants WHERE expires_at < $1', [new Date(issuedAt.getTime() - 3_600_000)]);
  await ctx.db.query('INSERT INTO view_grants (id, grant_hash, tenant_id, document_id, user_id, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [uuid(), hashGrant(grant), actor.tenantId, doc.id, actor.id, expiresAt, issuedAt]);
  return {
    grant, expiresAt, documentId: doc.id, title: doc.title, sourceMimeType: doc.mime_type, mimeType: PDF,
    mode: vendor ? mode : 'OFF', download: downloadState(mode, doc, !vendor, purchase), watermarked: true,
  };
}

interface GrantRow { id: string; tenant_id: string; document_id: string; user_id: string; expires_at: Date; used_at: Date | null }

const grantInvalid = () => new ApiError(403, 'VIEW_GRANT_INVALID', 'Viewer grant missing or not valid for this document and user; open the document again');

/** Wrap a PNG / JPEG into a one-page PDF (at most A4 portrait / landscape, never enlarged) so it can be stamped. */
export async function imageToPdf(bytes: Buffer, mime: string): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  let img;
  try { img = mime === 'image/png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes); }
  catch { throw new ApiError(409, 'IMAGE_UNREADABLE', 'This image could not be read for the protected viewer'); }
  const [maxW, maxH] = img.width > img.height ? [842, 595] : [595, 842];
  const s = Math.min(1, maxW / img.width, maxH / img.height);
  const page = pdf.addPage([Math.max(1, img.width * s), Math.max(1, img.height * s)]);
  page.drawImage(img, { x: 0, y: 0, width: img.width * s, height: img.height * s });
  return Buffer.from(await pdf.save());
}

/** GET /documents/:id/view-bytes — consumes the grant; returns the watermarked PDF. */
export async function viewBytes(ctx: Ctx, actor: Actor, id: string, grantHeader: unknown): Promise<Buffer> {
  const grant = typeof grantHeader === 'string' ? grantHeader.trim() : '';
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(grant) || !isUuid(id)) throw grantInvalid();
  const hash = hashGrant(grant);
  const g = (await ctx.db.query<GrantRow>('SELECT id, tenant_id, document_id, user_id, expires_at, used_at FROM view_grants WHERE grant_hash=$1', [hash]))[0];
  // Another user's (or another document's) grant is answered exactly like an unknown one.
  if (!g || g.tenant_id !== actor.tenantId || g.user_id !== actor.id || g.document_id !== id) throw grantInvalid();
  if (g.used_at) throw new ApiError(410, 'VIEW_GRANT_USED', 'This viewer grant was already used; open the document again');
  if (new Date(g.expires_at) <= now()) throw new ApiError(410, 'VIEW_GRANT_EXPIRED', 'This viewer grant expired; open the document again');

  // Same read rules as the download routes, checked again at the moment the bytes leave the server.
  const { doc, bid } = await loadViewable(ctx, actor, id);
  assertViewableType(doc);
  const plain = bid ? await readBidDocument(ctx, bid, doc) : await readPlain(ctx, doc);
  const mime = doc.mime_type.toLowerCase();
  const source = mime === PDF ? plain : await imageToPdf(plain, mime);
  const t = doc.tender_id ? await tenderOf(ctx, doc) : null;
  const vendor = isVendor(actor);
  const purchase = vendor && !bid ? await purchaseState(ctx, t, actor.vendorId) : { receipt: null as string | null };
  const wm = await watermarkFor(ctx, actor, g.id, purchase.receipt);
  const stamped = await stampPdf(source, wm, { id: g.id, title: doc.title });
  const { mode } = await contentModeForDoc(ctx, doc, t);

  await ctx.db.tx(async (q) => {
    const used = await q.query('UPDATE view_grants SET used_at=$2 WHERE id=$1 AND used_at IS NULL AND expires_at > $2 RETURNING id', [g.id, now()]);
    if (!used.length) throw new ApiError(410, 'VIEW_GRANT_USED', 'This viewer grant was already used or expired; open the document again');
    // The grant id doubles as the viewer session id for deterrent events (POST /security/content/views/:id/events).
    if (isUuid(actor.id)) await q.query(`INSERT INTO content_views (id, tenant_id, document_id, user_id, vendor_id, kind) VALUES ($1,$2,$3,$4,$5,'VIEW')`,
      [g.id, actor.tenantId, doc.id, actor.id, actor.vendorId]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'DOCUMENT_VIEWED', resourceType: 'DOCUMENT', resourceId: doc.id,
      details: { viewId: g.id, viewer: 'PDFJS', ownerType: doc.owner_type, title: doc.title, tenderId: doc.tender_id, tenderNumber: t?.tender_number ?? null,
        bidId: bid?.id ?? null, vendorId: actor.vendorId, username: actor.username, mode: vendor ? mode : 'OFF', sourceMimeType: doc.mime_type,
        originalSha256: doc.sha256_plain, watermarkedSha256: sha256Hex(stamped) } });
  });
  return stamped;
}
