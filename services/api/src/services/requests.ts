// Departmental procurement requests (BRD): a department asks for a procurement through Raslni or by a signed GM
// letter whose scan is mandatory. The request passes its own approval chain (template approvals.request of the
// entity's default template) and is then converted into a tender draft that pins a cycle template.
import type { Ctx } from '../ctx.js';
import { auditTx } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import { badRequest, camel, conflict, isUuid, notFound, now, reqStr, str, uuid } from '../util.js';
import { insertDocument, putDocument, validateUpload, type UploadFile } from './documents.js';
import { emitDocumentEvent } from './document-events.js';
import { DEFAULT_CONFIG, applyPattern, type CycleConfig } from './templates.js';
import { approvalChainView, createTender, currentRound, nextLevel } from './tenders.js';
import { notifyRole } from './notifications.js';

export interface RequestRow {
  id: string; tenant_id: string; request_number: string; department: string; subject: string; description: string;
  source: 'RASLNI' | 'LETTER'; source_reference: string | null; estimated_budget: string | number | null; letter_document_id: string | null;
  suggested_template: string | null; status: string; tender_id: string | null; created_by: string; created_at: Date; updated_at: Date;
}

async function requestChain(ctx: Ctx, tenantId: string): Promise<CycleConfig['approvals']['request']> {
  const r = await ctx.db.query<{ config: CycleConfig }>(
    `SELECT config FROM cycle_templates WHERE tenant_id=$1 AND status='PUBLISHED' AND is_default LIMIT 1`, [tenantId]);
  return r[0]?.config.approvals.request ?? DEFAULT_CONFIG.approvals.request;
}

const pub = (r: RequestRow) => {
  const o = camel<any>(r);
  o.estimatedBudget = r.estimated_budget === null ? null : Number(r.estimated_budget);
  return o;
};

export async function createRequest(ctx: Ctx, actor: Actor, b: any, file: UploadFile | undefined) {
  const source = b?.source === 'RASLNI' ? 'RASLNI' : 'LETTER';
  const sourceReference = str(b?.sourceReference, 'sourceReference', { max: 120 }) ?? null;
  if (source === 'RASLNI' && !sourceReference) throw badRequest('A Raslni request needs its Raslni reference number (sourceReference)');
  if (source === 'LETTER' && !file) throw badRequest('A letter request needs the scanned, signed GM letter (field "letter")');
  const f = file ? validateUpload(file, 'letter') : null;
  const budget = b?.estimatedBudget === undefined || b?.estimatedBudget === '' ? null : Number(b.estimatedBudget);
  if (budget !== null && (!Number.isFinite(budget) || budget < 0)) throw badRequest('estimatedBudget must be a non-negative number');
  const id = uuid();
  const n = Number((await ctx.db.query<{ n: string }>('SELECT count(*)::text AS n FROM procurement_requests WHERE tenant_id=$1', [actor.tenantId]))[0].n) + 1;
  const number = applyPattern(`${actor.tenantId.toUpperCase()}-REQ-{YYYY}-{SEQ4}`, n);
  const prepared = f ? await putDocument(ctx, {
    tenantId: actor.tenantId, ownerType: 'REQUEST_LETTER', ownerId: id, folderKey: `requests/${number}`,
    title: str(b?.letterTitle, 'letterTitle', { max: 300 }) ?? `GM letter ${number}`, fileName: f.originalname, mimeType: f.detectedMime,
    bytes: f.buffer, uploadedBy: actor.id,
  }) : null;
  const out = await ctx.db.tx(async (q) => {
    const doc = prepared ? await insertDocument(q, prepared) : null;
    const rows = await q.query<RequestRow>(
      `INSERT INTO procurement_requests (id, tenant_id, request_number, department, subject, description, source, source_reference,
         estimated_budget, letter_document_id, suggested_template, status, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'SUBMITTED',$12,$13,$13) RETURNING *`,
      [id, actor.tenantId, number, reqStr(b?.department, 'department', 200), reqStr(b?.subject, 'subject', 500),
        str(b?.description, 'description', { max: 8000 }) ?? '', source, sourceReference, budget, doc?.id ?? null,
        str(b?.suggestedTemplate, 'suggestedTemplate', { max: 60 }) ?? null, actor.id, now()]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'REQUEST_SUBMITTED', resourceType: 'REQUEST', resourceId: id,
      newState: 'SUBMITTED', details: { requestNumber: number, source, sourceReference, letterDocumentId: doc?.id ?? null, storeRef: doc?.store_ref ?? null } });
    return pub(rows[0]);
  });
  if (out.letterDocumentId) emitDocumentEvent(ctx, { type: 'UPLOADED', tenantId: actor.tenantId, documentIds: [out.letterDocumentId], actor });
  return out;
}

export async function loadRequest(ctx: Ctx, actor: Actor, id: string): Promise<RequestRow> {
  if (!isUuid(id)) throw notFound('Request');
  const r = (await ctx.db.query<RequestRow>('SELECT * FROM procurement_requests WHERE id=$1 AND tenant_id=$2', [id, actor.tenantId]))[0];
  if (!r) throw notFound('Request');
  return r;
}

export async function listRequests(ctx: Ctx, actor: Actor) {
  return (await ctx.db.query<RequestRow>('SELECT * FROM procurement_requests WHERE tenant_id=$1 ORDER BY created_at DESC', [actor.tenantId])).map(pub);
}

export async function getRequest(ctx: Ctx, actor: Actor, id: string) {
  const r = await loadRequest(ctx, actor, id);
  const chain = await requestChain(ctx, actor.tenantId);
  const out = pub(r);
  out.approvalChain = await approvalChainView(ctx.db, r.id, 'REQUEST', chain);
  out.letter = r.letter_document_id ? camel((await ctx.db.query(
    'SELECT id, title, mime_type, byte_size, sha256_plain, store_type, store_meta, created_at FROM documents WHERE id=$1', [r.letter_document_id]))[0] ?? null) : null;
  out.aiRuns = camel(await ctx.db.query(
    `SELECT id, kind, agent, model, status, error, response, citations, review_decision, created_at FROM ai_runs WHERE subject_id=$1 ORDER BY created_at DESC`, [r.id]));
  return out;
}

export async function decideRequest(ctx: Ctx, actor: Actor, id: string, b: any) {
  const r = await loadRequest(ctx, actor, id);
  if (!['SUBMITTED', 'IN_APPROVAL'].includes(r.status)) throw conflict('INVALID_STATE', `Request is ${r.status}`);
  const decision = b?.decision;
  if (!['APPROVE', 'RETURN', 'REJECT'].includes(decision)) throw badRequest("decision must be 'APPROVE', 'RETURN' or 'REJECT'");
  const reason = decision === 'APPROVE' ? (str(b?.reason, 'reason', { max: 2000 }) ?? null) : reqStr(b?.reason, 'reason', 2000);
  const chain = await requestChain(ctx, actor.tenantId);
  return ctx.db.tx(async (q) => {
    const done = await currentRound(q, r.id, 'REQUEST');
    const step = nextLevel(chain, done, actor, [{ id: r.created_by, why: 'the person who registered the request cannot approve it' }]);
    const to = decision === 'REJECT' ? 'REJECTED' : decision === 'RETURN' ? 'SUBMITTED' : step.final ? 'APPROVED' : 'IN_APPROVAL';
    await q.query(`INSERT INTO approvals (id, tenant_id, subject_type, subject_id, gate, level, role, approver_id, decision, reason, decided_at)
                   VALUES ($1,$2,'REQUEST',$3,'REQUEST',$4,$5,$6,$7,$8,$9)`,
      [uuid(), r.tenant_id, r.id, step.levelNo, step.level.role, actor.id, decision === 'APPROVE' ? 'APPROVED' : decision === 'RETURN' ? 'RETURNED' : 'REJECTED', reason, now()]);
    const rows = await q.query<RequestRow>(`UPDATE procurement_requests SET status=$1, updated_at=$2 WHERE id=$3 RETURNING *`, [to, now(), r.id]);
    if (decision === 'APPROVE' && !step.final) {
      const nxt = chain[step.levelNo];
      await notifyRole(q, r.tenant_id, nxt.role, { kind: 'APPROVAL_WAITING', titleEn: `Request approval waiting: ${r.request_number}`,
        titleAr: `طلب بانتظار الاعتماد: ${r.request_number}`, body: { requestId: r.id } });
    }
    await auditTx(ctx, q, { tenantId: r.tenant_id, actor, action: `REQUEST_${decision === 'APPROVE' ? 'APPROVED' : decision === 'RETURN' ? 'RETURNED' : 'REJECTED'}`,
      resourceType: 'REQUEST', resourceId: r.id, prevState: r.status, newState: to, reason, details: { level: step.levelNo, of: chain.length } });
    return pub(rows[0]);
  });
}

/** Convert an approved request into a tender draft (the officer completes criteria, pack and deadline). */
export async function convertRequest(ctx: Ctx, actor: Actor, id: string, b: any) {
  const r = await loadRequest(ctx, actor, id);
  if (r.status !== 'APPROVED') throw conflict('INVALID_STATE', 'Only an APPROVED request can become a tender');
  const tender = await createTender(ctx, actor, {
    ...b, requestId: r.id,
    titleEn: b?.titleEn ?? r.subject, titleAr: b?.titleAr ?? r.subject,
    descriptionEn: b?.descriptionEn ?? r.description, descriptionAr: b?.descriptionAr ?? r.description,
    estimatedBudget: b?.estimatedBudget ?? r.estimated_budget,
  });
  await ctx.db.tx(async (q) => {
    await q.query(`UPDATE procurement_requests SET status='CONVERTED', tender_id=$1, updated_at=$2 WHERE id=$3`, [tender.id, now(), r.id]);
    await auditTx(ctx, q, { tenantId: r.tenant_id, actor, action: 'REQUEST_CONVERTED', resourceType: 'REQUEST', resourceId: r.id,
      prevState: 'APPROVED', newState: 'CONVERTED', details: { tenderId: tender.id, tenderNumber: tender.tenderNumber } });
  });
  return tender;
}
