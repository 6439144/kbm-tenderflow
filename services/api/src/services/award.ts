// Evaluation scoring, award recommendation and approval (with committee report).
import type { Ctx } from '../ctx.js';
import { auditTx, hasRole } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import { badRequest, camel, conflict, forbidden, now, reqStr, str, uuid } from '../util.js';
import { loadTender, type TenderRow } from './tenders.js';
import { financialSealed, loadBid } from './bids.js';
import { configOf } from './templates.js';
import { approvalChainView, currentRound, nextLevel } from './tenders.js';
import { notify, notifyRole } from './notifications.js';
import { uuid as newId } from '../util.js';
import { insertDocument, putDocument } from './documents.js';
import { committeeReportHtml, type ReportBid } from './reports.js';

export async function submitEvaluation(ctx: Ctx, actor: Actor, bidId: string, b: any) {
  const bid = await loadBid(ctx, actor.tenantId, bidId);
  const t = await loadTender(ctx, actor, bid.tender_id);
  if (!['OPENED', 'EVALUATION'].includes(t.status)) throw conflict('INVALID_STATE', `Evaluation requires OPENED or EVALUATION (tender is ${t.status})`);
  if (bid.status !== 'OPENED') throw conflict('INVALID_STATE', 'Bid is not opened');
  if (!Array.isArray(b?.scores)) throw badRequest('scores must be an array');
  // Two-envelope: before the financial opening only technical criteria are scored; afterwards all criteria,
  // and only for bids that passed. Bids that failed the technical stage cannot receive financial scores.
  const cfg = configOf(t);
  const fin = new Set(cfg.envelopes === 'TWO' ? cfg.evaluation.financialCriteria : []);
  const finSealed = financialSealed(t, bid);
  if (cfg.envelopes === 'TWO' && t.financial_opened_at && bid.technical_result === 'FAILED')
    throw conflict('TECHNICAL_FAILED', 'This bid failed the technical stage; its financial envelope stays sealed');
  if (cfg.envelopes === 'TWO' && t.financial_opened_at && !b.scores.some((s: any) => fin.has(s?.criterion)))
    throw badRequest('Financial envelopes are open: include the financial criteria scores');
  const scored = t.criteria.filter((c) => !(finSealed && fin.has(c.key)));
  const byKey = new Map<string, { criterion: string; score: number; comment: string }>();
  for (const s of b.scores) {
    const criterion = s?.criterion; const score = Number(s?.score);
    if (!t.criteria.some((c) => c.key === criterion)) throw badRequest(`Unknown criterion '${criterion}'`);
    if (finSealed && fin.has(criterion)) throw conflict('FINANCIAL_SEALED', `Criterion '${criterion}' is scored after the financial envelopes are opened`);
    if (!Number.isFinite(score) || score < 0 || score > 100) throw badRequest(`Score for ${criterion} must be 0-100`);
    byKey.set(criterion, { criterion, score, comment: str(s?.comment, 'comment', { max: 4000 }) ?? '' });
  }
  const missing = scored.filter((c) => !byKey.has(c.key)).map((c) => c.key);
  if (missing.length) throw badRequest(`Missing scores for criteria: ${missing.join(', ')}`);
  const totalWeight = scored.reduce((a, c) => a + Number(c.weight), 0);
  const weighted = scored.reduce((a, c) => a + byKey.get(c.key)!.score * Number(c.weight), 0) / totalWeight;
  const weightedTotal = Math.round(weighted * 100) / 100;
  const scores = scored.map((c) => byKey.get(c.key)!);
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
  const all = hasRole(actor, 'COMMITTEE_CHAIR', 'DIRECTOR', 'UNDERSECRETARY');
  if (!all && !hasRole(actor, 'EVALUATOR')) throw forbidden('Requires COMMITTEE_CHAIR, DIRECTOR, UNDERSECRETARY or EVALUATOR');
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
  if (configOf(t).envelopes === 'TWO') {
    if (!t.financial_opened_at) throw conflict('FINANCIAL_SEALED', 'Open the financial envelopes before recommending an award');
    if (bid.technical_result !== 'PASSED') throw conflict('TECHNICAL_FAILED', 'Only a bid that passed the technical stage can be recommended');
  }
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
  const cfg = configOf(t);
  const chain = cfg.approvals.award;
  const since = new Date(award.created_at);
  const done = await currentRound(ctx.db, t.id, 'AWARD', since);
  const step = nextLevel(chain, done, actor, [{ id: award.recommended_by, why: 'the recommending chair cannot approve the award' }]);
  if (!step.final) {
    await ctx.db.tx(async (q) => {
      await q.query(`INSERT INTO approvals (id, tenant_id, subject_type, subject_id, gate, level, role, approver_id, decision, reason, decided_at)
                     VALUES ($1,$2,'TENDER',$3,'AWARD',$4,$5,$6,'APPROVED',$7,$8)`, [newId(), t.tenant_id, t.id, step.levelNo, step.level.role, actor.id, reason, now()]);
      const nxt = chain[step.levelNo];
      await notifyRole(q, t.tenant_id, nxt.role, { kind: 'APPROVAL_WAITING', titleEn: `Award approval level ${step.levelNo + 1} waiting: ${t.tender_number}`,
        titleAr: `بانتظار اعتماد الترسية المستوى ${step.levelNo + 1}: ${t.tender_number}`, body: { tenderId: t.id } });
      await auditTx(ctx, q, { tenantId: t.tenant_id, actor, action: 'AWARD_APPROVAL_LEVEL_APPROVED', resourceType: 'TENDER', resourceId: t.id,
        reason, details: { level: step.levelNo, of: chain.length, role: step.level.role, bidId: award.bid_id } });
    });
    return { award: camel(award), approvalChain: await approvalChainView(ctx.db, t.id, 'AWARD', chain, since), final: false };
  }
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
    await q.query(`INSERT INTO approvals (id, tenant_id, subject_type, subject_id, gate, level, role, approver_id, decision, reason, decided_at)
                   VALUES ($1,$2,'TENDER',$3,'AWARD',$4,$5,$6,'APPROVED',$7,$8)`, [newId(), t.tenant_id, t.id, step.levelNo, step.level.role, actor.id, reason, approvedAt]);
    for (const uid of new Set([t.created_by, award.recommended_by])) await notify(q, { tenantId: t.tenant_id, userId: uid, kind: 'AWARD_APPROVED', body: { tenderId: t.id }, titleEn: `Award approved: ${t.tender_number}`, titleAr: `تم اعتماد الترسية: ${t.tender_number}` });
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'AWARD_APPROVED', resourceType: 'TENDER', resourceId: t.id,
      prevState: 'EVALUATION', newState: 'AWARDED', reason, details: { bidId: award.bid_id, reportDocumentId: doc.id, level: step.levelNo, of: chain.length } });
    return { award: camel(rows[0]), reportDocumentId: doc.id, final: true };
  }).then(async (out) => {
    if (cfg.stages.recordsLock) (out as any).records = await lockRecords(ctx, actor, t.id);
    return out;
  });
}

/**
 * Records lock at award: every tender document (pack, addenda, notices, opening records, report, bids) is
 * declared a record in TenderFlow (no further change), and — where the content store supports it — in the
 * repository too. The repository result is reported as-is (never assumed).
 */
export async function lockRecords(ctx: Ctx, actor: Actor, tenderId: string) {
  const docs = await ctx.db.query<any>('SELECT id, store_ref, store_meta FROM documents WHERE tender_id=$1 AND NOT is_record', [tenderId]);
  const at = now();
  const repo: { documentId: string; ok: boolean; detail: string }[] = [];
  for (const d of docs) {
    if (ctx.store.declareRecord) {
      try { const r = await ctx.store.declareRecord(d.store_ref, { reason: `Tender awarded (${tenderId})` }); repo.push({ documentId: d.id, ...r }); }
      catch (e) { repo.push({ documentId: d.id, ok: false, detail: (e as Error).message }); }
    }
  }
  await ctx.db.tx(async (q) => {
    for (const d of docs) {
      const r = repo.find((x) => x.documentId === d.id);
      await q.query(`UPDATE documents SET is_record=true, record_declared_at=$1, store_meta = store_meta || $2::jsonb WHERE id=$3`,
        [at, JSON.stringify({ record: r ? { repository: r.ok, detail: r.detail } : { repository: false, detail: 'content store has no records capability' } }), d.id]);
    }
    await q.query('UPDATE tenders SET records_locked_at=$1 WHERE id=$2', [at, tenderId]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'RECORDS_DECLARED', resourceType: 'TENDER', resourceId: tenderId,
      details: { documents: docs.length, repositoryDeclared: repo.filter((r) => r.ok).length, repositoryFailed: repo.filter((r) => !r.ok).length } });
  });
  return { documents: docs.length, repositoryDeclared: repo.filter((r) => r.ok).length, repository: repo };
}
