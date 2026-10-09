// Evaluation scoring, award recommendation and approval (with committee report).
import type { Ctx } from '../ctx.js';
import { auditTx, hasRole } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import { badRequest, camel, conflict, forbidden, now, reqStr, str, uuid } from '../util.js';
import { loadTender, type TenderRow } from './tenders.js';
import { loadBid } from './bids.js';
import { insertDocument, putDocument } from './documents.js';
import { committeeReportHtml, type ReportBid } from './reports.js';

export async function submitEvaluation(ctx: Ctx, actor: Actor, bidId: string, b: any) {
  const bid = await loadBid(ctx, actor.tenantId, bidId);
  const t = await loadTender(ctx, actor, bid.tender_id);
  if (!['OPENED', 'EVALUATION'].includes(t.status)) throw conflict('INVALID_STATE', `Evaluation requires OPENED or EVALUATION (tender is ${t.status})`);
  if (bid.status !== 'OPENED') throw conflict('INVALID_STATE', 'Bid is not opened');
  if (!Array.isArray(b?.scores)) throw badRequest('scores must be an array');
  const byKey = new Map<string, { criterion: string; score: number; comment: string }>();
  for (const s of b.scores) {
    const criterion = s?.criterion; const score = Number(s?.score);
    if (!t.criteria.some((c) => c.key === criterion)) throw badRequest(`Unknown criterion '${criterion}'`);
    if (!Number.isFinite(score) || score < 0 || score > 100) throw badRequest(`Score for ${criterion} must be 0-100`);
    byKey.set(criterion, { criterion, score, comment: str(s?.comment, 'comment', { max: 4000 }) ?? '' });
  }
  const missing = t.criteria.filter((c) => !byKey.has(c.key)).map((c) => c.key);
  if (missing.length) throw badRequest(`Missing scores for criteria: ${missing.join(', ')}`);
  const totalWeight = t.criteria.reduce((a, c) => a + Number(c.weight), 0);
  const weighted = t.criteria.reduce((a, c) => a + byKey.get(c.key)!.score * Number(c.weight), 0) / totalWeight;
  const weightedTotal = Math.round(weighted * 100) / 100;
  const scores = t.criteria.map((c) => byKey.get(c.key)!);
  return ctx.db.tx(async (q) => {
    const rows = await q.query(
      `INSERT INTO evaluations (id, tenant_id, tender_id, bid_id, evaluator_id, scores, weighted_total, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
       ON CONFLICT (bid_id, evaluator_id) DO UPDATE SET scores=EXCLUDED.scores, weighted_total=EXCLUDED.weighted_total, submitted_at=EXCLUDED.submitted_at
       RETURNING *`, [uuid(), actor.tenantId, t.id, bid.id, actor.id, JSON.stringify(scores), weightedTotal, now()]);
    if (t.status === 'OPENED') {
      await q.query(`UPDATE tenders SET status='EVALUATION', updated_at=$1 WHERE id=$2 AND status='OPENED'`, [now(), t.id]);
      await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'TENDER_EVALUATION_STARTED', resourceType: 'TENDER', resourceId: t.id,
        prevState: 'OPENED', newState: 'EVALUATION' });
    }
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'BID_EVALUATED', resourceType: 'BID', resourceId: bid.id,
      details: { tenderId: t.id, weightedTotal } });
    const r = camel<any>(rows[0]);
    r.weightedTotal = Number(r.weightedTotal);
    return r;
  });
}

export async function listEvaluations(ctx: Ctx, actor: Actor, tenderId: string) {
  const t = await loadTender(ctx, actor, tenderId);
  const all = hasRole(actor, 'COMMITTEE_CHAIR', 'DIRECTOR');
  if (!all && !hasRole(actor, 'EVALUATOR')) throw forbidden('Requires COMMITTEE_CHAIR, DIRECTOR or EVALUATOR');
  const rows = await ctx.db.query(
    `SELECT e.*, u.display_name AS evaluator_name FROM evaluations e JOIN users u ON u.id=e.evaluator_id
      WHERE e.tender_id=$1 AND e.tenant_id=$2 AND ($3::boolean OR e.evaluator_id=$4) ORDER BY e.submitted_at`,
    [t.id, actor.tenantId, all, actor.id]);
  return camel<any[]>(rows).map((r) => ({ ...r, weightedTotal: Number(r.weightedTotal) }));
}

export async function recommendAward(ctx: Ctx, actor: Actor, tenderId: string, b: any) {
  const t = await loadTender(ctx, actor, tenderId);
  if (t.status !== 'EVALUATION') throw conflict('INVALID_STATE', `Recommendation requires EVALUATION (tender is ${t.status})`);
  const bid = await loadBid(ctx, actor.tenantId, reqStr(b?.bidId, 'bidId', 60));
  if (bid.tender_id !== t.id) throw badRequest('bidId does not belong to this tender');
  const justification = reqStr(b?.justification, 'justification', 8000);
  return ctx.db.tx(async (q) => {
    const ex = await q.query<any>('SELECT * FROM awards WHERE tender_id=$1', [t.id]);
    if (ex[0]?.status === 'APPROVED') throw conflict('INVALID_STATE', 'Award already approved');
    const rows = ex[0]
      ? await q.query(`UPDATE awards SET bid_id=$1, recommended_by=$2, justification=$3, created_at=$4 WHERE id=$5 RETURNING *`,
        [bid.id, actor.id, justification, now(), ex[0].id])
      : await q.query(`INSERT INTO awards (id, tenant_id, tender_id, bid_id, recommended_by, justification, status, created_at)
                       VALUES ($1,$2,$3,$4,$5,$6,'RECOMMENDED',$7) RETURNING *`, [uuid(), actor.tenantId, t.id, bid.id, actor.id, justification, now()]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'AWARD_RECOMMENDED', resourceType: 'TENDER', resourceId: t.id,
      newState: 'RECOMMENDED', reason: justification, details: { bidId: bid.id } });
    return camel(rows[0]);
  });
}

async function reportBids(ctx: Ctx, t: TenderRow): Promise<ReportBid[]> {
  const bids = await ctx.db.query<any>(`SELECT b.id, b.receipt_sha256, v.legal_name_en, v.legal_name_ar FROM bids b JOIN vendors v ON v.id=b.vendor_id
                                         WHERE b.tender_id=$1 ORDER BY b.submitted_at`, [t.id]);
  const evals = await ctx.db.query<any>(`SELECT e.bid_id, e.weighted_total, u.display_name FROM evaluations e JOIN users u ON u.id=e.evaluator_id WHERE e.tender_id=$1`, [t.id]);
  const screens = await ctx.db.query<any>(`SELECT request, response FROM ai_runs WHERE tender_id=$1 AND kind='COMPLIANCE_SCREEN' AND status='OK' ORDER BY created_at DESC`, [t.id]);
  return bids.map((b) => {
    const ev = evals.filter((e) => e.bid_id === b.id).map((e) => ({ evaluator: e.display_name, weightedTotal: Number(e.weighted_total) }));
    const scr = screens.find((s) => s.request?.bidId === b.id);
    return {
      bidId: b.id, vendorNameEn: b.legal_name_en, vendorNameAr: b.legal_name_ar, receiptSha256: b.receipt_sha256, evaluations: ev,
      averageScore: ev.length ? ev.reduce((a, x) => a + x.weightedTotal, 0) / ev.length : null,
      compliance: scr?.response?.items ?? null,
    };
  });
}

export async function approveAward(ctx: Ctx, actor: Actor, tenderId: string, b: any) {
  const t = await loadTender(ctx, actor, tenderId);
  if (t.status !== 'EVALUATION') throw conflict('INVALID_STATE', `Award approval requires EVALUATION (tender is ${t.status})`);
  const award = (await ctx.db.query<any>(`SELECT * FROM awards WHERE tender_id=$1 AND tenant_id=$2`, [t.id, actor.tenantId]))[0];
  if (!award || award.status !== 'RECOMMENDED') throw conflict('INVALID_STATE', 'No pending award recommendation');
  if (award.recommended_by === actor.id) throw forbidden('Segregation of duties: the recommending chair cannot approve the award');
  const reason = str(b?.reason, 'reason', { max: 4000 }) ?? null;
  const names = new Map((await ctx.db.query<any>('SELECT id, display_name FROM users WHERE tenant_id=$1', [actor.tenantId])).map((u) => [u.id, u.display_name]));
  const approvedAt = now();
  const html = committeeReportHtml({ tender: t, bids: await reportBids(ctx, t), awardedBidId: award.bid_id,
    recommendedBy: names.get(award.recommended_by) ?? award.recommended_by, justification: award.justification,
    approvedBy: names.get(actor.id) ?? actor.username, approvalReason: reason, approvedAt });
  const prepared = await putDocument(ctx, {
    tenantId: actor.tenantId, ownerType: 'COMMITTEE_REPORT', ownerId: award.id, tenderId: t.id, tenderNumber: t.tender_number,
    title: `Committee report ${t.tender_number}`, fileName: `committee-report-${t.tender_number}.html`, mimeType: 'text/html',
    bytes: Buffer.from(html, 'utf8'), uploadedBy: actor.id,
  });
  return ctx.db.tx(async (q) => {
    const upd = await q.query(`UPDATE tenders SET status='AWARDED', awarded_at=$1, updated_at=$1 WHERE id=$2 AND status='EVALUATION' RETURNING id`, [approvedAt, t.id]);
    if (!upd.length) throw conflict('INVALID_STATE', 'Tender state changed concurrently');
    const doc = await insertDocument(q, prepared);
    const rows = await q.query(`UPDATE awards SET status='APPROVED', approved_by=$1, approved_at=$2, report_document_id=$3 WHERE id=$4 AND status='RECOMMENDED' RETURNING *`,
      [actor.id, approvedAt, doc.id, award.id]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'AWARD_APPROVED', resourceType: 'TENDER', resourceId: t.id,
      prevState: 'EVALUATION', newState: 'AWARDED', reason, details: { bidId: award.bid_id, reportDocumentId: doc.id } });
    return { award: camel(rows[0]), reportDocumentId: doc.id };
  });
}
