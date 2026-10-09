// Tender lifecycle: draft → approve → publish → (auto) close; cancel; pack/addendum documents; clarifications.
import type { Ctx } from '../ctx.js';
import { auditTx, hasRole, isStaff, isVendor } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import type { Queryable } from '../db.js';
import { SYSTEM_ACTOR } from './audit.js';
import { ApiError, badRequest, camel, conflict, forbidden, isUuid, notFound, now, reqStr, str, uuid } from '../util.js';
import { insertDocument, publicDoc, putDocument, validateUpload, type DocumentRow, type UploadFile } from './documents.js';
import { emitDocumentEvent } from './document-events.js';
import { applyPattern, configOf, getProfile, resolveTemplate, snapshotOf, stageList, type ApprovalLevel } from './templates.js';
import { checkEligibility, purchaseOf, ruleOf } from './eligibility.js';
import { notifyRole, notifyVendorsOfTender } from './notifications.js';

export interface TenderRow {
  id: string; tenant_id: string; tender_number: string; title_en: string; title_ar: string; description_en: string;
  description_ar: string; category: string; estimated_budget: string | number | null; currency: string;
  submission_deadline: Date; criteria: { key: string; name_en: string; name_ar: string; weight: number }[];
  required_documents: { key: string; name_en: string; name_ar: string }[]; status: string; created_by: string;
  approved_by: string | null; published_at: Date | null; closed_at: Date | null; opened_at: Date | null;
  awarded_at: Date | null; created_at: Date; updated_at: Date;
  template_id?: string | null; template_snapshot?: any; request_id?: string | null; eligibility?: any;
  financial_opened_at?: Date | null; records_locked_at?: Date | null;
}

export const PUBLISHED_PLUS = ['PUBLISHED', 'CLOSED', 'OPENED', 'EVALUATION', 'AWARDED'];

export const publicTender = (t: TenderRow) => {
  const o = camel<any>({ ...t, template_snapshot: undefined });
  o.estimatedBudget = t.estimated_budget === null ? null : Number(t.estimated_budget);
  const snap = t.template_snapshot;
  o.template = snap ? { id: snap.templateId, code: snap.code, version: snap.version, nameEn: snap.nameEn, nameAr: snap.nameAr } : null;
  o.cycle = configOf(t);
  return o;
};

function parseEligibility(v: unknown) {
  if (v === undefined || v === null) return {};
  const e = v as any;
  const codes = Array.isArray(e.activityCodes) ? e.activityCodes.filter((x: unknown) => typeof x === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(x)) : [];
  const g = e.minGrade === undefined || e.minGrade === null || e.minGrade === '' ? null : Number(e.minGrade);
  if (g !== null && ![1, 2, 3].includes(g)) throw badRequest('eligibility.minGrade must be 1, 2, 3 or null');
  return { activityCodes: codes, minGrade: g };
}

const keyRe = /^[A-Za-z0-9_-]{1,60}$/;
function parseCriteria(v: unknown) {
  if (!Array.isArray(v) || !v.length) throw badRequest('criteria must be a non-empty array');
  const out = v.map((c: any, i) => {
    const key = c?.key; const weight = Number(c?.weight);
    if (typeof key !== 'string' || !keyRe.test(key)) throw badRequest(`criteria[${i}].key is invalid`);
    if (!Number.isFinite(weight) || weight <= 0 || weight > 100) throw badRequest(`criteria[${i}].weight must be in (0,100]`);
    return { key, name_en: reqStr(c?.nameEn ?? c?.name_en, `criteria[${i}].nameEn`, 300), name_ar: reqStr(c?.nameAr ?? c?.name_ar, `criteria[${i}].nameAr`, 300), weight };
  });
  if (new Set(out.map((c) => c.key)).size !== out.length) throw badRequest('criteria keys must be unique');
  return out;
}
function parseRequiredDocs(v: unknown) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw badRequest('requiredDocuments must be an array');
  return v.map((d: any, i) => {
    if (typeof d?.key !== 'string' || !keyRe.test(d.key)) throw badRequest(`requiredDocuments[${i}].key is invalid`);
    return { key: d.key, name_en: reqStr(d?.nameEn ?? d?.name_en, `requiredDocuments[${i}].nameEn`, 300), name_ar: reqStr(d?.nameAr ?? d?.name_ar, `requiredDocuments[${i}].nameAr`, 300) };
  });
}
function parseDeadline(v: unknown): Date {
  const d = typeof v === 'string' ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) throw badRequest('submissionDeadline must be an ISO date-time');
  return d;
}
function parseBudget(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw badRequest('estimatedBudget must be a non-negative number');
  return n;
}

/** Close a PUBLISHED tender whose deadline has passed (actor SYSTEM). Returns the current row. */
export async function autoClose(ctx: Ctx, t: TenderRow): Promise<TenderRow> {
  if (t.status !== 'PUBLISHED' || now() < new Date(t.submission_deadline)) return t;
  return ctx.db.tx(async (q) => {
    const rows = await q.query<TenderRow>(
      `UPDATE tenders SET status='CLOSED', closed_at=$1, updated_at=$1 WHERE id=$2 AND status='PUBLISHED' RETURNING *`, [now(), t.id]);
    if (!rows[0]) return (await q.query<TenderRow>('SELECT * FROM tenders WHERE id=$1', [t.id]))[0];
    await auditTx(ctx, q, { tenantId: t.tenant_id, actor: SYSTEM_ACTOR, action: 'TENDER_CLOSED', resourceType: 'TENDER',
      resourceId: t.id, prevState: 'PUBLISHED', newState: 'CLOSED', details: { deadline: new Date(t.submission_deadline).toISOString() } });
    return rows[0];
  });
}

/** Interval job: close every due tender (all tenants). */
export async function closeDueTenders(ctx: Ctx): Promise<number> {
  const due = await ctx.db.query<TenderRow>(`SELECT * FROM tenders WHERE status='PUBLISHED' AND submission_deadline <= $1`, [now()]);
  for (const t of due) await autoClose(ctx, t);
  return due.length;
}

async function vendorCanSee(ctx: Ctx, actor: Actor, t: TenderRow): Promise<boolean> {
  if (!actor.vendorId || !PUBLISHED_PLUS.includes(t.status)) return false;
  const v = await ctx.db.query(`SELECT 1 FROM vendors WHERE id=$1 AND tenant_id=$2 AND status='APPROVED' AND $3 = ANY(categories)`,
    [actor.vendorId, actor.tenantId, t.category]);
  return v.length > 0;
}

/** Load a tender visible to the caller (tenant-scoped; vendors only PUBLISHED+ in their categories). Auto-closes. */
export async function loadTender(ctx: Ctx, actor: Actor, id: string): Promise<TenderRow> {
  if (!isUuid(id)) throw notFound('Tender');
  const rows = await ctx.db.query<TenderRow>('SELECT * FROM tenders WHERE id=$1 AND tenant_id=$2', [id, actor.tenantId]);
  if (!rows[0]) throw notFound('Tender');
  const t = await autoClose(ctx, rows[0]);
  if (isStaff(actor)) return t;
  if (isVendor(actor) && (await vendorCanSee(ctx, actor, t))) return t;
  throw notFound('Tender');
}

export async function listTenders(ctx: Ctx, actor: Actor, status?: unknown) {
  await closeDueTenders(ctx);
  const s = typeof status === 'string' && status ? status : null;
  if (isStaff(actor)) {
    const rows = await ctx.db.query<TenderRow>(
      `SELECT * FROM tenders WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC`, [actor.tenantId, s]);
    return rows.map(publicTender);
  }
  if (!actor.vendorId) return [];
  const rows = await ctx.db.query<TenderRow>(
    `SELECT t.* FROM tenders t JOIN vendors v ON v.id=$2 AND v.tenant_id=t.tenant_id
      WHERE t.tenant_id=$1 AND v.status='APPROVED' AND t.category = ANY(v.categories)
        AND t.status = ANY($3::text[]) AND ($4::text IS NULL OR t.status=$4) ORDER BY t.submission_deadline ASC`,
    [actor.tenantId, actor.vendorId, PUBLISHED_PLUS, s]);
  return rows.map(publicTender);
}

export async function createTender(ctx: Ctx, actor: Actor, b: any) {
  const deadline = parseDeadline(b?.submissionDeadline);
  if (deadline <= now()) throw badRequest('submissionDeadline must be in the future');
  const t = {
    id: uuid(), titleEn: reqStr(b?.titleEn, 'titleEn', 500), titleAr: reqStr(b?.titleAr, 'titleAr', 500),
    descriptionEn: str(b?.descriptionEn, 'descriptionEn', { max: 10000 }) ?? '', descriptionAr: str(b?.descriptionAr, 'descriptionAr', { max: 10000 }) ?? '',
    category: reqStr(b?.category, 'category', 50), budget: parseBudget(b?.estimatedBudget), currency: str(b?.currency, 'currency', { max: 3 }) ?? 'KWD',
    criteria: parseCriteria(b?.criteria), requiredDocuments: parseRequiredDocs(b?.requiredDocuments),
    eligibility: parseEligibility(b?.eligibility),
  };
  const requestId = b?.requestId && isUuid(b.requestId) ? String(b.requestId) : null;
  const pattern = (await getProfile(ctx, actor.tenantId)).numberingPattern;
  return ctx.db.tx(async (q) => {
    const tpl = await resolveTemplate(ctx, q, actor.tenantId, b?.templateId);
    const snapshot = snapshotOf(tpl);
    if (snapshot?.config.envelopes === 'TWO') {
      const fin = snapshot.config.evaluation.financialCriteria;
      if (!t.criteria.some((c) => fin.includes(c.key)) || t.criteria.every((c) => fin.includes(c.key)))
        throw badRequest(`Two-envelope tenders need at least one financial criterion (${fin.join(', ')}) and at least one technical criterion`);
    }
    let num = str(b?.tenderNumber, 'tenderNumber', { max: 60 });
    if (num && !/^[A-Za-z0-9_-]+$/.test(num)) throw badRequest('tenderNumber may contain only letters, digits, - and _');
    if (!num) {
      const c = await q.query<{ n: string }>('SELECT count(*)::text AS n FROM tenders WHERE tenant_id=$1', [actor.tenantId]);
      const seq = Number(c[0].n) + 1;
      num = pattern ? applyPattern(pattern, seq) : `${actor.tenantId.toUpperCase()}-${now().getUTCFullYear()}-${String(seq).padStart(3, '0')}`;
    }
    const dup = await q.query('SELECT 1 FROM tenders WHERE tenant_id=$1 AND tender_number=$2', [actor.tenantId, num]);
    if (dup.length) throw conflict('TENDER_NUMBER_TAKEN', 'Tender number already exists');
    const rows = await q.query<TenderRow>(
      `INSERT INTO tenders (id, tenant_id, tender_number, title_en, title_ar, description_en, description_ar, category, estimated_budget,
         currency, submission_deadline, criteria, required_documents, status, created_by, created_at, updated_at,
         template_id, template_snapshot, eligibility, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,'DRAFT',$14,$15,$15,$16,$17::jsonb,$18::jsonb,$19) RETURNING *`,
      [t.id, actor.tenantId, num, t.titleEn, t.titleAr, t.descriptionEn, t.descriptionAr, t.category, t.budget, t.currency, deadline,
        JSON.stringify(t.criteria), JSON.stringify(t.requiredDocuments), actor.id, now(),
        tpl?.id ?? null, snapshot ? JSON.stringify(snapshot) : null, JSON.stringify(t.eligibility), requestId]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'TENDER_CREATED', resourceType: 'TENDER', resourceId: t.id,
      newState: 'DRAFT', details: { tenderNumber: num, template: snapshot ? `${snapshot.code} v${snapshot.version}` : 'default', requestId } });
    return publicTender(rows[0]);
  });
}

export async function patchTender(ctx: Ctx, actor: Actor, id: string, b: any) {
  const t = await loadTender(ctx, actor, id);
  if (t.status !== 'DRAFT') throw conflict('INVALID_STATE', 'Only DRAFT tenders can be edited');
  const sets: string[] = []; const vals: unknown[] = []; const changed: string[] = [];
  const set = (col: string, val: unknown, cast = '') => { vals.push(val); sets.push(`${col}=$${vals.length}${cast}`); changed.push(col); };
  if (b?.titleEn !== undefined) set('title_en', reqStr(b.titleEn, 'titleEn', 500));
  if (b?.titleAr !== undefined) set('title_ar', reqStr(b.titleAr, 'titleAr', 500));
  if (b?.descriptionEn !== undefined) set('description_en', str(b.descriptionEn, 'descriptionEn', { max: 10000 }) ?? '');
  if (b?.descriptionAr !== undefined) set('description_ar', str(b.descriptionAr, 'descriptionAr', { max: 10000 }) ?? '');
  if (b?.category !== undefined) set('category', reqStr(b.category, 'category', 50));
  if (b?.estimatedBudget !== undefined) set('estimated_budget', parseBudget(b.estimatedBudget));
  if (b?.currency !== undefined) set('currency', reqStr(b.currency, 'currency', 3));
  if (b?.submissionDeadline !== undefined) {
    const d = parseDeadline(b.submissionDeadline);
    if (d <= now()) throw badRequest('submissionDeadline must be in the future');
    set('submission_deadline', d);
  }
  if (b?.criteria !== undefined) set('criteria', JSON.stringify(parseCriteria(b.criteria)), '::jsonb');
  if (b?.requiredDocuments !== undefined) set('required_documents', JSON.stringify(parseRequiredDocs(b.requiredDocuments)), '::jsonb');
  if (b?.eligibility !== undefined) set('eligibility', JSON.stringify(parseEligibility(b.eligibility)), '::jsonb');
  if (!sets.length) throw badRequest('No editable fields given');
  set('updated_at', now());
  vals.push(id, actor.tenantId);
  return ctx.db.tx(async (q) => {
    const rows = await q.query<TenderRow>(
      `UPDATE tenders SET ${sets.join(', ')} WHERE id=$${vals.length - 1} AND tenant_id=$${vals.length} AND status='DRAFT' RETURNING *`, vals);
    if (!rows[0]) throw conflict('INVALID_STATE', 'Tender is no longer DRAFT');
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'TENDER_UPDATED', resourceType: 'TENDER', resourceId: id,
      details: { fields: changed.filter((c) => c !== 'updated_at') } });
    return publicTender(rows[0]);
  });
}

export async function uploadTenderDocument(ctx: Ctx, actor: Actor, id: string, file: UploadFile | undefined, body: any) {
  const t = await loadTender(ctx, actor, id);
  const addendum = body?.addendum === true || body?.addendum === 'true';
  if (addendum ? t.status !== 'PUBLISHED' : t.status !== 'DRAFT')
    throw conflict('INVALID_STATE', addendum ? 'Addenda can only be issued while PUBLISHED' : 'Pack files can only be added while DRAFT');
  const f = validateUpload(file);
  const ownerType = addendum ? 'ADDENDUM' : 'TENDER_PACK';
  // An addendum may supersede an earlier pack/addendum document: it becomes the next version of that document.
  let supersedes: DocumentRow | null = null;
  if (body?.supersedesId) {
    if (!isUuid(body.supersedesId)) throw badRequest('supersedesId is invalid');
    supersedes = (await ctx.db.query<DocumentRow>(
      `SELECT * FROM documents WHERE id=$1 AND tender_id=$2 AND owner_type IN ('TENDER_PACK','ADDENDUM')`, [body.supersedesId, t.id]))[0] ?? null;
    if (!supersedes) throw badRequest('supersedesId must be a pack or addendum document of this tender');
  }
  const prepared = await putDocument(ctx, {
    tenantId: actor.tenantId, ownerType, ownerId: t.id, tenderId: t.id, tenderNumber: t.tender_number,
    title: str(body?.title, 'title', { max: 300 }) ?? f.originalname, fileName: f.originalname, mimeType: f.detectedMime,
    bytes: f.buffer, uploadedBy: actor.id, supersedes,
  });
  const d = await ctx.db.tx(async (q) => {
    const d = await insertDocument(q, prepared);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: addendum ? 'ADDENDUM_ISSUED' : 'TENDER_DOCUMENT_UPLOADED',
      resourceType: 'TENDER', resourceId: t.id, details: { documentId: d.id, title: d.title, sha256: d.sha256_plain,
        storeRef: d.store_ref, version: d.version_no, supersedesId: supersedes?.id ?? null } });
    return d;
  });
  emitDocumentEvent(ctx, { type: 'UPLOADED', tenantId: actor.tenantId, documentIds: [d.id], actor });
  return publicDoc(d);
}

async function transition(ctx: Ctx, actor: Actor, t: TenderRow, from: string[], to: string, action: string,
  extra: { sets?: string; vals?: unknown[]; reason?: string | null } = {}) {
  if (!from.includes(t.status)) throw conflict('INVALID_STATE', `Tender is ${t.status}; ${action} requires ${from.join(' or ')}`);
  return ctx.db.tx(async (q) => {
    const vals = [to, now(), t.id, t.status, ...(extra.vals ?? [])];
    const rows = await q.query<TenderRow>(
      `UPDATE tenders SET status=$1, updated_at=$2${extra.sets ? ', ' + extra.sets : ''} WHERE id=$3 AND status=$4 RETURNING *`, vals);
    if (!rows[0]) throw conflict('INVALID_STATE', 'Tender state changed concurrently');
    await auditTx(ctx, q, { tenantId: t.tenant_id, actor, action, resourceType: 'TENDER', resourceId: t.id, prevState: t.status,
      newState: to, reason: extra.reason ?? null });
    return publicTender(rows[0]);
  });
}

// ---------------- Approval chains (template-configured, N levels) ----------------
export interface ChainDecision { level: number; role: string; approver_id: string; approver_name?: string; decision: string; reason: string | null; decided_at: Date }

/** Approvals of the current round: decisions after the latest RETURNED for this subject/gate. */
export async function currentRound(q: Queryable, subjectId: string, gate: string, since?: Date | null): Promise<ChainDecision[]> {
  const rows = await q.query<ChainDecision & { decided_at: Date }>(
    `SELECT a.level, a.role, a.approver_id, u.display_name AS approver_name, a.decision, a.reason, a.decided_at
       FROM approvals a LEFT JOIN users u ON u.id=a.approver_id WHERE a.subject_id=$1 AND a.gate=$2 ORDER BY a.decided_at, a.level`, [subjectId, gate]);
  let start = 0;
  rows.forEach((r, i) => { if (r.decision === 'RETURNED') start = i + 1; });
  return rows.slice(start).filter((r) => r.decision === 'APPROVED' && (!since || new Date(r.decided_at) >= since));
}

/** Who may decide the next level; throws with a clear reason otherwise. Returns the level being decided. */
export function nextLevel(chain: ApprovalLevel[], done: ChainDecision[], actor: Actor, excluded: { id: string | null; why: string }[]) {
  const levelNo = done.length + 1;
  const level = chain[levelNo - 1];
  if (!level) throw conflict('INVALID_STATE', 'All approval levels are already complete');
  for (const x of excluded) if (x.id && x.id === actor.id) throw forbidden(`Segregation of duties: ${x.why}`);
  if (done.some((d) => d.approver_id === actor.id)) throw forbidden('Segregation of duties: one person cannot approve two levels of the same chain');
  if (!hasRole(actor, level.role)) throw forbidden(`Level ${levelNo} of ${chain.length} (${level.labelEn}) requires role ${level.role}`);
  return { levelNo, level, final: levelNo === chain.length };
}

export async function approvalChainView(q: Queryable, subjectId: string, gate: string, chain: ApprovalLevel[], since?: Date | null) {
  const done = await currentRound(q, subjectId, gate, since);
  return chain.map((l, i) => {
    const d = done[i];
    return { level: i + 1, role: l.role, labelEn: l.labelEn, labelAr: l.labelAr,
      decision: d ? 'APPROVED' : (i === done.length ? 'WAITING' : 'PENDING'), approverId: d?.approver_id ?? null,
      approverName: d?.approver_name ?? null, decidedAt: d?.decided_at ?? null, reason: d?.reason ?? null };
  });
}

export async function approveTender(ctx: Ctx, actor: Actor, id: string, b: any) {
  const t = await loadTender(ctx, actor, id);
  if (t.created_by === actor.id) throw forbidden('Segregation of duties: the creator cannot approve their own tender');
  if (!['DRAFT', 'PENDING_APPROVAL'].includes(t.status)) throw conflict('INVALID_STATE', `Tender is ${t.status}; approval requires DRAFT or PENDING_APPROVAL`);
  if (t.status === 'DRAFT') {
    const docs = await ctx.db.query(`SELECT 1 FROM documents WHERE tender_id=$1 AND owner_type='TENDER_PACK' LIMIT 1`, [t.id]);
    if (!docs.length) throw conflict('PACK_MISSING', 'Upload at least one tender pack document before approval');
  }
  const chain = configOf(t).approvals.publish;
  const reason = str(b?.reason, 'reason', { max: 2000 }) ?? null;
  return ctx.db.tx(async (q) => {
    const done = await currentRound(q, t.id, 'PUBLISH');
    const { levelNo, level, final } = nextLevel(chain, done, actor, [{ id: t.created_by, why: 'the creator cannot approve their own tender' }]);
    const to = final ? 'APPROVED' : 'PENDING_APPROVAL';
    const rows = await q.query<TenderRow>(
      `UPDATE tenders SET status=$1, updated_at=$2${final ? ', approved_by=$5' : ''} WHERE id=$3 AND status=$4 RETURNING *`,
      final ? [to, now(), t.id, t.status, actor.id] : [to, now(), t.id, t.status]);
    if (!rows[0]) throw conflict('INVALID_STATE', 'Tender state changed concurrently');
    await q.query(`INSERT INTO approvals (id, tenant_id, subject_type, subject_id, gate, level, role, approver_id, decision, reason, decided_at)
                   VALUES ($1,$2,'TENDER',$3,'PUBLISH',$4,$5,$6,'APPROVED',$7,$8)`, [uuid(), t.tenant_id, t.id, levelNo, level.role, actor.id, reason, now()]);
    const nxt = chain[levelNo];
    if (nxt) await notifyRole(q, t.tenant_id, nxt.role, { kind: 'APPROVAL_WAITING',
      titleEn: `Approval level ${levelNo + 1} waiting: ${t.tender_number}`, titleAr: `بانتظار اعتماد المستوى ${levelNo + 1}: ${t.tender_number}`, body: { tenderId: t.id } });
    await auditTx(ctx, q, { tenantId: t.tenant_id, actor, action: final ? 'TENDER_APPROVED' : 'TENDER_APPROVAL_LEVEL_APPROVED', resourceType: 'TENDER',
      resourceId: t.id, prevState: t.status, newState: to, reason, details: { level: levelNo, of: chain.length, role: level.role } });
    return publicTender(rows[0]);
  });
}

export async function returnTender(ctx: Ctx, actor: Actor, id: string, b: any) {
  const reason = reqStr(b?.reason, 'reason', 2000);
  const t = await loadTender(ctx, actor, id);
  const chainRoles = configOf(t).approvals.publish.map((l) => l.role);
  if (!hasRole(actor, 'DIRECTOR', ...chainRoles)) throw forbidden('Only an approver in this tender\'s approval chain can return it');
  if (!['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(t.status)) throw conflict('INVALID_STATE', `Tender is ${t.status}; it cannot be returned`);
  return ctx.db.tx(async (q) => {
    const rows = await q.query<TenderRow>(
      `UPDATE tenders SET status='DRAFT', approved_by=NULL, updated_at=$1 WHERE id=$2 AND status=$3 RETURNING *`, [now(), t.id, t.status]);
    if (!rows[0]) throw conflict('INVALID_STATE', 'Tender state changed concurrently');
    const lvl = (await currentRound(q, t.id, 'PUBLISH')).length + 1;
    await q.query(`INSERT INTO approvals (id, tenant_id, subject_type, subject_id, gate, level, role, approver_id, decision, reason, decided_at)
                   VALUES ($1,$2,'TENDER',$3,'PUBLISH',$4,$5,$6,'RETURNED',$7,$8)`, [uuid(), t.tenant_id, t.id, lvl, actor.roles[0], actor.id, reason, now()]);
    await auditTx(ctx, q, { tenantId: t.tenant_id, actor, action: 'TENDER_RETURNED', resourceType: 'TENDER', resourceId: t.id,
      prevState: t.status, newState: 'DRAFT', reason });
    return publicTender(rows[0]);
  });
}

export async function publishTender(ctx: Ctx, actor: Actor, id: string) {
  const t = await loadTender(ctx, actor, id);
  if (t.status === 'APPROVED' && new Date(t.submission_deadline) <= now())
    throw conflict('DEADLINE_PASSED', 'Submission deadline has passed; return the tender to DRAFT and set a new deadline');
  const out = await transition(ctx, actor, t, ['APPROVED'], 'PUBLISHED', 'TENDER_PUBLISHED', { sets: 'published_at=$2' });
  await ctx.db.tx(async (q) => {
    await q.query(`INSERT INTO publications (id, tenant_id, tender_id, channel, status, reference, published_on, created_by, approved_by, created_at, updated_at)
                   VALUES ($1,$2,$3,'PORTAL','PUBLISHED',$4,$5,$6,$6,$7,$7) ON CONFLICT (tender_id, channel) DO NOTHING`,
      [uuid(), t.tenant_id, t.id, t.tender_number, now().toISOString().slice(0, 10), actor.id, now()]);
    const n = await notifyVendorsOfTender(ctx, q, { ...t, status: 'PUBLISHED' });
    if (n) await auditTx(ctx, q, { tenantId: t.tenant_id, actor: SYSTEM_ACTOR, action: 'VENDORS_NOTIFIED', resourceType: 'TENDER', resourceId: t.id,
      details: { vendors: n, basis: 'category + eligibility rule' } });
  });
  return out;
}

export async function cancelTender(ctx: Ctx, actor: Actor, id: string, b: any) {
  const reason = reqStr(b?.reason, 'reason', 2000);
  const t = await loadTender(ctx, actor, id);
  return transition(ctx, actor, t, ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PUBLISHED'], 'CANCELLED', 'TENDER_CANCELLED', { reason });
}

export async function tenderDetail(ctx: Ctx, actor: Actor, id: string) {
  const t = await loadTender(ctx, actor, id);
  const staff = isStaff(actor);
  const docTypes = staff ? ['TENDER_PACK', 'ADDENDUM', 'OPENING_RECORD', 'COMMITTEE_REPORT'] : ['TENDER_PACK', 'ADDENDUM'];
  const docs = await ctx.db.query<DocumentRow>(
    `SELECT * FROM documents WHERE tender_id=$1 AND tenant_id=$2 AND owner_type = ANY($3::text[]) ORDER BY created_at`, [t.id, actor.tenantId, docTypes]);
  const clar = await ctx.db.query<any>(
    `SELECT c.*, v.legal_name_en AS vendor_name_en FROM clarifications c JOIN vendors v ON v.id=c.vendor_id
      WHERE c.tender_id=$1 AND c.tenant_id=$2 ORDER BY c.created_at`, [t.id, actor.tenantId]);
  const visibleClar = staff ? clar : clar
    .filter((c) => c.status === 'ANSWERED' || c.vendor_id === actor.vendorId)
    .map((c) => ({ ...c, vendor_id: c.vendor_id === actor.vendorId ? c.vendor_id : null, vendor_name_en: c.vendor_id === actor.vendorId ? c.vendor_name_en : null }));
  const out: any = { ...publicTender(t), documents: docs.map(publicDoc), clarifications: camel(visibleClar) };
  const cfg = configOf(t);
  out.stages = stageList(cfg);
  out.eligibilityRule = ruleOf(t);
  out.publications = camel(await ctx.db.query(
    `SELECT id, channel, status, reference, published_on, notice_en, notice_ar, ai_run_id, document_id, created_at, updated_at
       FROM publications WHERE tender_id=$1 AND ($2::boolean OR status='PUBLISHED') ORDER BY channel`, [t.id, staff]));
  if (staff) {
    out.approvalChain = await approvalChainView(ctx.db, t.id, 'PUBLISH', cfg.approvals.publish);
    out.purchaseCount = Number((await ctx.db.query<{ n: string }>('SELECT count(*)::text AS n FROM tender_purchases WHERE tender_id=$1', [t.id]))[0].n);
    out.request = t.request_id ? camel((await ctx.db.query(
      'SELECT id, request_number, department, subject, source, source_reference, letter_document_id, status FROM procurement_requests WHERE id=$1', [t.request_id]))[0] ?? null) : null;
  } else if (actor.vendorId) {
    out.myEligibility = await checkEligibility(ctx.db, t, actor.vendorId);
    out.myPurchase = camel(await purchaseOf(ctx.db, t.id, actor.vendorId));
  }
  if (staff) {
    const bc = await ctx.db.query<{ n: string }>('SELECT count(*)::text AS n FROM bids WHERE tender_id=$1', [t.id]);
    out.bidCount = Number(bc[0].n);
    out.aiRuns = camel(await ctx.db.query(
      `SELECT id, kind, agent, model, status, error, response, citations, requested_by, reviewed_by, review_decision, created_at
         FROM ai_runs WHERE tender_id=$1 AND tenant_id=$2 ORDER BY created_at DESC`, [t.id, actor.tenantId]));
    out.opening = camel((await ctx.db.query('SELECT * FROM openings WHERE tender_id=$1', [t.id]))[0] ?? null);
    const awardRow = (await ctx.db.query<any>('SELECT * FROM awards WHERE tender_id=$1', [t.id]))[0] ?? null;
    out.award = camel(awardRow);
    out.awardChain = awardRow ? await approvalChainView(ctx.db, t.id, 'AWARD', cfg.approvals.award, new Date(awardRow.created_at)) : null;
  } else {
    const own = await ctx.db.query('SELECT id, status, receipt_sha256, submitted_at FROM bids WHERE tender_id=$1 AND vendor_id=$2', [t.id, actor.vendorId]);
    out.myBid = camel(own[0] ?? null);
  }
  return out;
}

// ---------------- Clarifications ----------------
export interface ClarificationRow {
  id: string; tenant_id: string; tender_id: string; vendor_id: string; question: string; language: string; answer: string | null;
  answered_by: string | null; status: string; ai_run_id: string | null; created_at: Date; answered_at: Date | null;
}

export async function askClarification(ctx: Ctx, actor: Actor, tenderId: string, b: any) {
  if (!actor.vendorId) throw forbidden('Only vendor users can ask clarifications');
  const t = await loadTender(ctx, actor, tenderId);
  if (t.status !== 'PUBLISHED' || now() >= new Date(t.submission_deadline)) throw conflict('INVALID_STATE', 'Clarifications are accepted only while PUBLISHED and before the deadline');
  const question = reqStr(b?.question, 'question', 4000);
  const language = /[؀-ۿ]/.test(question) ? 'ar' : 'en';
  return ctx.db.tx(async (q) => {
    const rows = await q.query<ClarificationRow>(
      `INSERT INTO clarifications (id, tenant_id, tender_id, vendor_id, question, language, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'OPEN',$7) RETURNING *`, [uuid(), actor.tenantId, t.id, actor.vendorId, question, language, now()]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'CLARIFICATION_ASKED', resourceType: 'CLARIFICATION',
      resourceId: rows[0].id, newState: 'OPEN', details: { tenderId: t.id } });
    return camel(rows[0]);
  });
}

export async function loadClarification(ctx: Ctx, actor: Actor, id: string): Promise<ClarificationRow> {
  if (!isUuid(id)) throw notFound('Clarification');
  const rows = await ctx.db.query<ClarificationRow>('SELECT * FROM clarifications WHERE id=$1 AND tenant_id=$2', [id, actor.tenantId]);
  if (!rows[0]) throw notFound('Clarification');
  return rows[0];
}

export async function answerClarification(ctx: Ctx, actor: Actor, id: string, b: any) {
  const c = await loadClarification(ctx, actor, id);
  if (c.status !== 'OPEN') throw conflict('INVALID_STATE', 'Clarification already answered');
  const answer = reqStr(b?.answer, 'answer', 8000);
  const aiRunId = b?.aiRunId && isUuid(b.aiRunId) ? b.aiRunId : null;
  return ctx.db.tx(async (q) => {
    const rows = await q.query<ClarificationRow>(
      `UPDATE clarifications SET answer=$1, answered_by=$2, answered_at=$3, status='ANSWERED', ai_run_id=COALESCE($4, ai_run_id)
        WHERE id=$5 AND status='OPEN' RETURNING *`, [answer, actor.id, now(), aiRunId, id]);
    if (!rows[0]) throw conflict('INVALID_STATE', 'Clarification already answered');
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'CLARIFICATION_ANSWERED', resourceType: 'CLARIFICATION',
      resourceId: id, prevState: 'OPEN', newState: 'ANSWERED', details: { tenderId: c.tender_id, aiRunId } });
    return camel(rows[0]);
  });
}

export function requireStaffRole(actor: Actor, ...roles: string[]) {
  if (!hasRole(actor, ...roles)) throw forbidden(`Requires one of roles: ${roles.join(', ')}`);
}
export { ApiError, type Queryable };
