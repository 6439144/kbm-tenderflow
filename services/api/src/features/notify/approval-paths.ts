// Missing approval path: REJECT of a tender's publication approval (requests already have approve / return / reject;
// tenders had approve / return / cancel). Rejection is decided by the approver of the WAITING level (same role and
// segregation-of-duties checks as approval), requires a reason, records a REJECTED decision in the chain, cancels the
// tender, notifies its creator and is audited — all in one transaction.
import type { Ctx } from '../../ctx.js';
import { auditTx } from '../../ctx.js';
import type { Actor } from '../../auth/tokens.js';
import { conflict, now, reqStr, uuid } from '../../util.js';
import { configOf } from '../../services/templates.js';
import { currentRound, loadTender, nextLevel, publicTender, type TenderRow } from '../../services/tenders.js';
import { notify } from '../../services/notifications.js';

export async function rejectTender(ctx: Ctx, actor: Actor, id: string, b: any) {
  const reason = reqStr(b?.reason, 'reason', 2000);
  const t = await loadTender(ctx, actor, id);
  if (!['DRAFT', 'PENDING_APPROVAL'].includes(t.status)) throw conflict('INVALID_STATE', `Tender is ${t.status}; rejection requires DRAFT or PENDING_APPROVAL`);
  const chain = configOf(t).approvals.publish;
  return ctx.db.tx(async (q) => {
    const done = await currentRound(q, t.id, 'PUBLISH');
    const step = nextLevel(chain, done, actor, [{ id: t.created_by, why: 'the creator cannot reject their own tender' }]);
    const rows = await q.query<TenderRow>(`UPDATE tenders SET status='CANCELLED', updated_at=$1 WHERE id=$2 AND status=$3 RETURNING *`, [now(), t.id, t.status]);
    if (!rows[0]) throw conflict('INVALID_STATE', 'Tender state changed concurrently');
    await q.query(`INSERT INTO approvals (id, tenant_id, subject_type, subject_id, gate, level, role, approver_id, decision, reason, decided_at)
                   VALUES ($1,$2,'TENDER',$3,'PUBLISH',$4,$5,$6,'REJECTED',$7,$8)`, [uuid(), t.tenant_id, t.id, step.levelNo, step.level.role, actor.id, reason, now()]);
    await notify(q, { tenantId: t.tenant_id, userId: t.created_by, kind: 'TENDER_REJECTED', body: { tenderId: t.id, level: step.levelNo, reason },
      titleEn: `Tender rejected: ${t.tender_number}`, titleAr: `تم رفض المناقصة: ${t.tender_number}` });
    await auditTx(ctx, q, { tenantId: t.tenant_id, actor, action: 'TENDER_REJECTED', resourceType: 'TENDER', resourceId: t.id,
      prevState: t.status, newState: 'CANCELLED', reason, details: { level: step.levelNo, of: chain.length, role: step.level.role } });
    return publicTender(rows[0]);
  });
}
