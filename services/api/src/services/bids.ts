// Sealed bid submission, listing, decryption (after opening) and the opening ceremony.
import type { Ctx } from '../ctx.js';
import { auditTx, hasRole, isStaff } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import { ApiError, badRequest, camel, canonicalJson, conflict, forbidden, isUuid, notFound, now, sha256Hex, str, uuid } from '../util.js';
import { insertDocument, putDocument, readSealed, validateUpload, type DocumentRow, type PreparedDoc, type UploadFile } from './documents.js';
import { newDataKey, unwrapKey, wrapKey } from './vault.js';
import { loadTender, type TenderRow } from './tenders.js';
import { getVendorRow } from './vendors.js';
import { openingRecordHtml, type OpeningBidSummary } from './reports.js';
import { assertEligible, assertPurchased } from './eligibility.js';
import { configOf } from './templates.js';
import { escapeHtml } from '../util.js';
import { emitDocumentEvent } from './document-events.js';

export interface BidRow {
  id: string; tenant_id: string; tender_id: string; vendor_id: string; status: string; wrapped_key: string; wrap_iv: string;
  wrap_tag: string; receipt_sha256: string; submitted_at: Date; opened_at: Date | null;
  technical_result?: string | null; technical_score?: string | number | null; financial_opened_at?: Date | null;
}

/** Two-envelope tenders keep the financial envelope sealed until the chair opens it for bids that passed. */
export function financialSealed(t: TenderRow, bid: BidRow): boolean {
  return configOf(t).envelopes === 'TWO' && !bid.financial_opened_at;
}

export const BID_READERS = ['COMMITTEE_CHAIR', 'EVALUATOR', 'DIRECTOR', 'UNDERSECRETARY'];

function receiptOf(bid: { id: string; tender_id: string; vendor_id: string; submitted_at: Date }, files: { title: string; sha256: string; type: string }[]) {
  return sha256Hex(canonicalJson({ bidId: bid.id, tenderId: bid.tender_id, vendorId: bid.vendor_id, submittedAt: bid.submitted_at, files }));
}

export async function submitBid(ctx: Ctx, actor: Actor, tenderId: string, files: { technical?: UploadFile; financial?: UploadFile }) {
  if (!actor.vendorId) throw forbidden('Only vendor users can submit bids');
  const vendor = await getVendorRow(ctx, actor.tenantId, actor.vendorId);
  if (vendor.status !== 'APPROVED') throw forbidden('Vendor is not approved');
  const t = await loadTender(ctx, actor, tenderId); // auto-closes at deadline
  if (t.status !== 'PUBLISHED' || now() >= new Date(t.submission_deadline))
    throw conflict('SUBMISSION_CLOSED', 'Bids are accepted only while the tender is PUBLISHED and before the deadline');
  await assertEligible(ctx.db, t, vendor.id);
  await assertPurchased(ctx.db, t, vendor.id);
  const tech = validateUpload(files.technical, 'technical');
  const fin = validateUpload(files.financial, 'financial');

  const existing = (await ctx.db.query<BidRow>('SELECT * FROM bids WHERE tender_id=$1 AND vendor_id=$2', [t.id, vendor.id]))[0];
  const bidId = existing?.id ?? uuid();
  const dataKey = newDataKey();
  const wrapped = wrapKey(ctx.config.bidMasterKey, dataKey, bidId);
  const submittedAt = now();
  const prepared: PreparedDoc[] = [];
  for (const [ownerType, f] of [['BID_TECHNICAL', tech], ['BID_FINANCIAL', fin]] as const) {
    prepared.push(await putDocument(ctx, {
      tenantId: actor.tenantId, ownerType, ownerId: bidId, tenderId: t.id, tenderNumber: t.tender_number, vendorId: vendor.id,
      bidId, title: f.originalname, fileName: f.originalname, mimeType: f.detectedMime, bytes: f.buffer, uploadedBy: actor.id, dataKey,
    }));
  }
  dataKey.fill(0);
  const fileSummary = prepared.map((p) => ({ title: p.row.title, sha256: p.row.sha256_plain, type: p.row.owner_type }));
  const receipt = receiptOf({ id: bidId, tender_id: t.id, vendor_id: vendor.id, submitted_at: submittedAt }, fileSummary);

  await ctx.db.tx(async (q) => {
    // Re-check state inside the transaction (deadline may pass during upload).
    const cur = (await q.query<TenderRow>('SELECT * FROM tenders WHERE id=$1 FOR UPDATE', [t.id]))[0];
    if (cur.status !== 'PUBLISHED' || submittedAt >= new Date(cur.submission_deadline))
      throw conflict('SUBMISSION_CLOSED', 'Submission deadline passed');
    if (existing) {
      const ex = (await q.query<BidRow>('SELECT * FROM bids WHERE id=$1 FOR UPDATE', [bidId]))[0];
      if (ex.status !== 'SEALED') throw conflict('INVALID_STATE', 'Bid is no longer sealed');
      await q.query('DELETE FROM documents WHERE bid_id=$1', [bidId]); // old ciphertext is unrecoverable once its key is replaced
      await q.query(`UPDATE bids SET wrapped_key=$1, wrap_iv=$2, wrap_tag=$3, receipt_sha256=$4, submitted_at=$5 WHERE id=$6`,
        [wrapped.wrappedKey, wrapped.wrapIv, wrapped.wrapTag, receipt, submittedAt, bidId]);
    } else {
      await q.query(`INSERT INTO bids (id, tenant_id, tender_id, vendor_id, status, wrapped_key, wrap_iv, wrap_tag, receipt_sha256, submitted_at)
                     VALUES ($1,$2,$3,$4,'SEALED',$5,$6,$7,$8,$9)`,
        [bidId, actor.tenantId, t.id, vendor.id, wrapped.wrappedKey, wrapped.wrapIv, wrapped.wrapTag, receipt, submittedAt]);
    }
    for (const p of prepared) await insertDocument(q, p);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: existing ? 'BID_RESUBMITTED' : 'BID_SUBMITTED', resourceType: 'BID',
      resourceId: bidId, newState: 'SEALED', details: { tenderId: t.id, receiptSha256: receipt, files: fileSummary } });
  });
  return { bidId, tenderId: t.id, submittedAt: submittedAt.toISOString(), receiptSha256: receipt, files: fileSummary.map(({ title, sha256 }) => ({ title, sha256 })) };
}

export async function listBids(ctx: Ctx, actor: Actor, tenderId: string) {
  const t = await loadTender(ctx, actor, tenderId);
  if (!isStaff(actor)) {
    if (!actor.vendorId) throw forbidden();
    const own = await ctx.db.query<BidRow>('SELECT * FROM bids WHERE tender_id=$1 AND vendor_id=$2', [t.id, actor.vendorId]);
    if (!own[0]) return [];
    const docs = await ctx.db.query<DocumentRow>('SELECT * FROM documents WHERE bid_id=$1 ORDER BY owner_type', [own[0].id]);
    return [{ bidId: own[0].id, status: own[0].status, submittedAt: own[0].submitted_at, receiptSha256: own[0].receipt_sha256,
      files: docs.map((d) => ({ documentId: d.id, type: d.owner_type, title: d.title, sha256: d.sha256_plain })) }];
  }
  const rows = await ctx.db.query<BidRow & { legal_name_en: string; legal_name_ar: string }>(
    `SELECT b.*, v.legal_name_en, v.legal_name_ar FROM bids b JOIN vendors v ON v.id=b.vendor_id
      WHERE b.tender_id=$1 AND b.tenant_id=$2 ORDER BY b.submitted_at`, [t.id, actor.tenantId]);
  const out = [];
  for (const b of rows) {
    const item: any = { id: b.id, vendorId: b.vendor_id, vendorNameEn: b.legal_name_en, vendorNameAr: b.legal_name_ar, status: b.status,
      submittedAt: b.submitted_at, receiptSha256: b.receipt_sha256, openedAt: b.opened_at,
      technicalResult: b.technical_result ?? null, technicalScore: b.technical_score === null || b.technical_score === undefined ? null : Number(b.technical_score),
      financialOpenedAt: b.financial_opened_at ?? null, financialSealed: financialSealed(t, b) };
    if (b.status === 'OPENED' && hasRole(actor, ...BID_READERS)) {
      const sealedFin = financialSealed(t, b);
      const docs = (await ctx.db.query<DocumentRow>('SELECT * FROM documents WHERE bid_id=$1 ORDER BY owner_type', [b.id]))
        .filter((d) => !(sealedFin && d.owner_type === 'BID_FINANCIAL'));
      item.documents = docs.map((d) => ({ id: d.id, type: d.owner_type, title: d.title, mimeType: d.mime_type, byteSize: d.byte_size, sha256: d.sha256_plain }));
    }
    out.push(item);
  }
  return out;
}

export async function loadBid(ctx: Ctx, tenantId: string, id: string): Promise<BidRow> {
  if (!isUuid(id)) throw notFound('Bid');
  const rows = await ctx.db.query<BidRow>('SELECT * FROM bids WHERE id=$1 AND tenant_id=$2', [id, tenantId]);
  if (!rows[0]) throw notFound('Bid');
  return rows[0];
}

/** Decrypted bid documents; used by the download route, compliance screening and the opening integrity check. */
export async function decryptBidDocuments(ctx: Ctx, bid: BidRow, opts: { technicalOnly?: boolean } = {}): Promise<{ doc: DocumentRow; bytes: Buffer }[]> {
  const key = unwrapKey(ctx.config.bidMasterKey, bid);
  try {
    const docs = (await ctx.db.query<DocumentRow>('SELECT * FROM documents WHERE bid_id=$1 ORDER BY owner_type', [bid.id]))
      .filter((d) => !(opts.technicalOnly && d.owner_type === 'BID_FINANCIAL'));
    const out = [];
    for (const d of docs) out.push({ doc: d, bytes: await readSealed(ctx, d, key) });
    return out;
  } finally { key.fill(0); }
}

export async function downloadBidDocument(ctx: Ctx, actor: Actor, bidId: string, docId: string) {
  const bid = await loadBid(ctx, actor.tenantId, bidId);
  const isOwner = !!actor.vendorId && actor.vendorId === bid.vendor_id;
  if (!isOwner) {
    if (!isStaff(actor)) throw notFound('Bid');
    if (!hasRole(actor, ...BID_READERS)) throw forbidden('Only the committee chair, evaluators and the director may read opened bids');
    if (bid.status !== 'OPENED') throw new ApiError(403, 'BID_SEALED', 'Bid is sealed until the opening ceremony');
  }
  if (!isUuid(docId)) throw notFound('Document');
  const d = (await ctx.db.query<DocumentRow>('SELECT * FROM documents WHERE id=$1 AND bid_id=$2 AND tenant_id=$3', [docId, bid.id, actor.tenantId]))[0];
  if (!d) throw notFound('Document');
  if (!isOwner && d.owner_type === 'BID_FINANCIAL') {
    const t = (await ctx.db.query<TenderRow>('SELECT * FROM tenders WHERE id=$1', [bid.tender_id]))[0];
    if (financialSealed(t, bid)) throw new ApiError(403, 'FINANCIAL_SEALED', 'The financial envelope stays sealed until the chair opens it for bids that passed the technical evaluation');
  }
  const key = unwrapKey(ctx.config.bidMasterKey, bid);
  let bytes: Buffer;
  try { bytes = await readSealed(ctx, d, key); } finally { key.fill(0); }
  await ctx.db.tx((q) => auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'BID_DOCUMENT_ACCESSED', resourceType: 'BID',
    resourceId: bid.id, details: { documentId: d.id, owner: isOwner } }));
  return { doc: d, bytes };
}

export async function openTender(ctx: Ctx, actor: Actor, tenderId: string, b: any) {
  const t = await loadTender(ctx, actor, tenderId);
  if (t.status !== 'CLOSED' || now() < new Date(t.submission_deadline))
    throw conflict('INVALID_STATE', `Opening requires a CLOSED tender after its deadline (tender is ${t.status})`);
  const attendees = Array.isArray(b?.attendees) ? b.attendees.filter((a: unknown) => typeof a === 'string' && a.trim()).map((a: string) => a.trim().slice(0, 200)) : [];
  if (!attendees.length) throw badRequest('attendees must list at least one person');
  const notes = str(b?.notes, 'notes', { max: 8000 }) ?? null;
  const bids = await ctx.db.query<BidRow & { legal_name_en: string; legal_name_ar: string }>(
    `SELECT b.*, v.legal_name_en, v.legal_name_ar FROM bids b JOIN vendors v ON v.id=b.vendor_id WHERE b.tender_id=$1 ORDER BY b.submitted_at`, [t.id]);
  // Integrity check: every sealed file must decrypt and match its plaintext hash.
  const bidSummaries: OpeningBidSummary[] = [];
  for (const bid of bids) {
    let integrity = 'VERIFIED';
    let files: { title: string; type: string; sha256: string }[] = [];
    try {
      files = (await decryptBidDocuments(ctx, bid)).map(({ doc }) => ({ title: doc.title, type: doc.owner_type, sha256: doc.sha256_plain }));
    } catch (err) {
      integrity = `FAILED: ${(err as Error).message}`;
    }
    bidSummaries.push({ bidId: bid.id, vendorNameEn: bid.legal_name_en, vendorNameAr: bid.legal_name_ar, submittedAt: bid.submitted_at,
      receiptSha256: bid.receipt_sha256, integrity, files });
  }
  const openedAt = now();
  const openingId = uuid();
  const html = openingRecordHtml({ tender: t, openedAt, chair: actor.username, attendees, notes, bids: bidSummaries });
  const prepared = await putDocument(ctx, {
    tenantId: actor.tenantId, ownerType: 'OPENING_RECORD', ownerId: openingId, tenderId: t.id, tenderNumber: t.tender_number,
    title: `Opening record ${t.tender_number}`, fileName: `opening-record-${t.tender_number}.html`, mimeType: 'text/html',
    bytes: Buffer.from(html, 'utf8'), uploadedBy: actor.id,
  });
  const opened = await ctx.db.tx(async (q) => {
    const upd = await q.query(`UPDATE tenders SET status='OPENED', opened_at=$1, updated_at=$1 WHERE id=$2 AND status='CLOSED' RETURNING id`, [openedAt, t.id]);
    if (!upd.length) throw conflict('INVALID_STATE', 'Tender state changed concurrently');
    const doc = await insertDocument(q, prepared);
    await q.query(`UPDATE bids SET status='OPENED', opened_at=$1 WHERE tender_id=$2 AND status='SEALED'`, [openedAt, t.id]);
    const rows = await q.query(`INSERT INTO openings (id, tenant_id, tender_id, chair_id, attendees, notes, record_document_id, opened_at)
                                VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING *`,
      [openingId, actor.tenantId, t.id, actor.id, JSON.stringify(attendees), notes, doc.id, openedAt]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'TENDER_OPENED', resourceType: 'TENDER', resourceId: t.id,
      prevState: 'CLOSED', newState: 'OPENED', details: { openingId, recordDocumentId: doc.id, bidCount: bids.length,
        envelope: configOf(t).envelopes === 'TWO' ? 'TECHNICAL' : 'SINGLE',
        integrity: bidSummaries.map((s) => ({ bidId: s.bidId, integrity: s.integrity })) } });
    return { opening: camel(rows[0]), recordDocumentId: doc.id, bids: bidSummaries };
  });
  // Bid documents become readable now (financial envelopes of two-envelope tenders stay sealed).
  emitDocumentEvent(ctx, { type: 'BIDS_OPENED', tenantId: actor.tenantId, tenderId: t.id, actor });
  return opened;
}


/**
 * Two-envelope: the chair opens the financial envelopes. Each opened bid's technical score is the average, over
 * evaluators, of its weighted technical criteria. Bids at or above the template pass mark PASS and have their
 * financial envelope opened; the others FAIL and stay sealed. A financial opening record is generated.
 */
export async function openFinancial(ctx: Ctx, actor: Actor, tenderId: string, b: any) {
  const t = await loadTender(ctx, actor, tenderId);
  const cfg = configOf(t);
  if (cfg.envelopes !== 'TWO') throw conflict('NOT_TWO_ENVELOPE', 'This tender uses a single envelope');
  if (!['OPENED', 'EVALUATION'].includes(t.status)) throw conflict('INVALID_STATE', `Financial opening requires OPENED or EVALUATION (tender is ${t.status})`);
  if (t.financial_opened_at) throw conflict('INVALID_STATE', 'Financial envelopes are already opened');
  const fin = new Set(cfg.evaluation.financialCriteria);
  const tech = t.criteria.filter((c) => !fin.has(c.key));
  const techWeight = tech.reduce((a, c) => a + Number(c.weight), 0);
  const pass = Number(cfg.evaluation.technicalPassMark);
  const bids = await ctx.db.query<BidRow & { legal_name_en: string; legal_name_ar: string }>(
    `SELECT b.*, v.legal_name_en, v.legal_name_ar FROM bids b JOIN vendors v ON v.id=b.vendor_id WHERE b.tender_id=$1 AND b.status='OPENED' ORDER BY b.submitted_at`, [t.id]);
  const evals = await ctx.db.query<{ bid_id: string; scores: { criterion: string; score: number }[] }>('SELECT bid_id, scores FROM evaluations WHERE tender_id=$1', [t.id]);
  const results = bids.map((bid) => {
    const mine = evals.filter((e) => e.bid_id === bid.id);
    if (!mine.length) throw conflict('TECHNICAL_EVALUATION_INCOMPLETE', `Bid of ${bid.legal_name_en} has no technical evaluation yet`);
    const perEval = mine.map((e) => tech.reduce((a, c) => a + Number(e.scores.find((s) => s.criterion === c.key)?.score ?? 0) * Number(c.weight), 0) / techWeight);
    const score = Math.round((perEval.reduce((a, x) => a + x, 0) / perEval.length) * 100) / 100;
    return { bid, score, result: score >= pass ? 'PASSED' : 'FAILED' };
  });
  const openedAt = now();
  const notes = str(b?.notes, 'notes', { max: 4000 }) ?? null;
  const rowsHtml = results.map((r) => `<tr><td>${escapeHtml(r.bid.legal_name_en)}<br><span dir="rtl">${escapeHtml(r.bid.legal_name_ar)}</span></td><td>${r.score}</td><td>${r.result === 'PASSED' ? 'PASSED — financial envelope opened / ناجح — فتح المظروف المالي' : 'FAILED — financial envelope stays sealed / غير ناجح — يبقى المظروف المالي مغلقاً'}</td></tr>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Financial opening record ${escapeHtml(t.tender_number)}</title>
<style>body{font-family:system-ui,Segoe UI,Tahoma,sans-serif;margin:32px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:6px 8px;text-align:start}</style></head><body>
<h1>Financial opening record / محضر فتح المظاريف المالية</h1>
<p>Tender ${escapeHtml(t.tender_number)} — ${escapeHtml(t.title_en)} / <span dir="rtl">${escapeHtml(t.title_ar)}</span></p>
<p>Opened at ${openedAt.toISOString()} by ${escapeHtml(actor.username)}. Technical pass mark: ${pass}. ${notes ? 'Notes: ' + escapeHtml(notes) : ''}</p>
<table><thead><tr><th>Vendor / المورد</th><th>Technical score / الدرجة الفنية</th><th>Result / النتيجة</th></tr></thead><tbody>${rowsHtml}</tbody></table>
</body></html>`;
  const prepared = await putDocument(ctx, {
    tenantId: actor.tenantId, ownerType: 'OPENING_RECORD', ownerId: t.id, tenderId: t.id, tenderNumber: t.tender_number,
    title: `Financial opening record ${t.tender_number}`, fileName: `financial-opening-${t.tender_number}.html`, mimeType: 'text/html',
    bytes: Buffer.from(html, 'utf8'), uploadedBy: actor.id,
  });
  const out = await ctx.db.tx(async (q) => {
    const upd = await q.query(`UPDATE tenders SET financial_opened_at=$1, updated_at=$1 WHERE id=$2 AND financial_opened_at IS NULL RETURNING id`, [openedAt, t.id]);
    if (!upd.length) throw conflict('INVALID_STATE', 'Financial envelopes are already opened');
    const doc = await insertDocument(q, prepared);
    for (const r of results)
      await q.query(`UPDATE bids SET technical_result=$1, technical_score=$2, financial_opened_at=$3 WHERE id=$4`,
        [r.result, r.score, r.result === 'PASSED' ? openedAt : null, r.bid.id]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'FINANCIAL_ENVELOPES_OPENED', resourceType: 'TENDER', resourceId: t.id,
      details: { passMark: pass, recordDocumentId: doc.id, results: results.map((r) => ({ bidId: r.bid.id, score: r.score, result: r.result })) } });
    return { recordDocumentId: doc.id, passMark: pass, results: results.map((r) => ({ bidId: r.bid.id, vendorNameEn: r.bid.legal_name_en, vendorNameAr: r.bid.legal_name_ar, technicalScore: r.score, result: r.result })) };
  });
  emitDocumentEvent(ctx, { type: 'FINANCIAL_OPENED', tenantId: actor.tenantId, tenderId: t.id, actor });
  return out;
}
