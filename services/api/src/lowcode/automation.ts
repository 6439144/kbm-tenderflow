// Event automation: reads the committed, HMAC-chained audit trail (per entity, from a stored cursor) and runs the
// matching EVENT rules of the entity's published rule set; also runs SCHEDULE rules (deadline approaching, once per
// tender) and forwards events to subscribed integrations. Because it reads the audit trail after commit, an
// automation can never slow down, fail or roll back the user's action, and nothing is lost across a restart.
// Each event is processed in one transaction together with the cursor move (no double runs).
import type { Ctx } from '../ctx.js';
import { auditTx } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import type { Queryable } from '../db.js';
import { SYSTEM_ACTOR } from '../services/audit.js';
import { notify, notifyRole } from '../services/notifications.js';
import { badRequest, conflict, forbidden, isUuid, notFound, now, str, uuid } from '../util.js';
import { hasRole } from '../ctx.js';
import { TRIGGERS, triggerDef } from './catalog.js';
import { evaluate, type Facts } from './conditions.js';
import { liveRuleset, type DefinitionRow } from './definitions.js';
import { awardFacts, documentFacts, formById, requestFacts, taskView, tenderFacts, vendorFacts } from './gates.js';
import { fillText, type Action, type Rule } from './rules.js';
import { validateValues, type FormDefinition } from './forms.js';
import { enqueue } from './webhooks.js';

const ACTION_TO_TRIGGER = new Map<string, string>();
for (const t of TRIGGERS) for (const a of t.auditActions ?? []) ACTION_TO_TRIGGER.set(a, t.key);
export const triggerForAuditAction = (a: string) => ACTION_TO_TRIGGER.get(a) ?? null;

interface AuditEvt { seq: string | number; tenant_id: string; actor_id: string; actor_roles: string[]; action: string; resource_type: string; resource_id: string | null; details: any; at: Date }

export interface Subject {
  type: 'TENDER' | 'VENDOR' | 'REQUEST' | 'DOCUMENT'; id: string; ref: string; facts: Facts;
  vars: Record<string, unknown>; creatorId: string | null; vendorId: string | null; tender?: any; vendor?: any; request?: any;
  publicData: Record<string, unknown>;
}

/** Load the object an event is about, with its facts and the placeholders a message may use. */
export async function loadSubject(q: Queryable, tenantId: string, trigger: string, e: { resourceType: string; resourceId: string | null; details?: any; actorRoles?: string[] }): Promise<Subject | null> {
  const def = triggerDef(trigger);
  if (!def || !e.resourceId) return null;
  const actor = { roles: e.actorRoles ?? [] };
  let tenderId: string | null = null;
  if (e.resourceType === 'TENDER') tenderId = e.resourceId;
  else if (e.resourceType === 'CLARIFICATION') tenderId = (await q.query<any>('SELECT tender_id FROM clarifications WHERE id=$1 AND tenant_id=$2', [e.resourceId, tenantId]))[0]?.tender_id ?? null;
  if (def.scope === 'TENDER' || def.scope === 'AWARD') {
    if (!tenderId) return null;
    const t = (await q.query<any>('SELECT * FROM tenders WHERE id=$1 AND tenant_id=$2', [tenderId, tenantId]))[0];
    if (!t) return null;
    let facts = await tenderFacts(q, t, actor);
    if (def.scope === 'AWARD') {
      const aw = (await q.query<any>('SELECT bid_id FROM awards WHERE tender_id=$1', [t.id]))[0];
      if (aw) facts = await awardFacts(q, t, aw.bid_id, actor);
    }
    return { type: 'TENDER', id: t.id, ref: t.tender_number, facts, creatorId: t.created_by, vendorId: null, tender: t,
      vars: { 'tender.number': t.tender_number, 'tender.title': t.title_en, 'tender.titleAr': t.title_ar, 'tender.status': t.status, 'tender.category': t.category,
        'tender.deadline': new Date(t.submission_deadline).toISOString().slice(0, 16).replace('T', ' ') },
      publicData: { tenderNumber: t.tender_number, titleEn: t.title_en, titleAr: t.title_ar, status: t.status, category: t.category,
        submissionDeadline: new Date(t.submission_deadline).toISOString(), estimatedBudget: t.estimated_budget === null ? null : Number(t.estimated_budget), currency: t.currency } };
  }
  if (def.scope === 'VENDOR') {
    const v = (await q.query<any>('SELECT * FROM vendors WHERE id=$1 AND tenant_id=$2', [e.resourceId, tenantId]))[0];
    if (!v) return null;
    return { type: 'VENDOR', id: v.id, ref: v.cr_number, facts: vendorFacts(v, v.company_grade ?? null, actor), creatorId: null, vendorId: v.id, vendor: v,
      vars: { 'vendor.name': v.legal_name_en, 'vendor.nameAr': v.legal_name_ar, 'vendor.cr': v.cr_number, 'vendor.status': v.status },
      publicData: { vendorId: v.id, legalNameEn: v.legal_name_en, legalNameAr: v.legal_name_ar, crNumber: v.cr_number, status: v.status, categories: v.categories } };
  }
  if (def.scope === 'REQUEST') {
    const r = (await q.query<any>('SELECT * FROM procurement_requests WHERE id=$1 AND tenant_id=$2', [e.resourceId, tenantId]))[0];
    if (!r) return null;
    return { type: 'REQUEST', id: r.id, ref: r.request_number, facts: requestFacts(r, actor), creatorId: r.created_by, vendorId: null, request: r,
      vars: { 'request.number': r.request_number, 'request.subject': r.subject, 'request.department': r.department },
      publicData: { requestNumber: r.request_number, department: r.department, subject: r.subject, source: r.source, status: r.status } };
  }
  if (def.scope === 'DOCUMENT') {
    const d = (await q.query<any>('SELECT id, owner_type, mime_type, byte_size, title, vendor_id, created_at FROM documents WHERE id=$1 AND tenant_id=$2', [e.resourceId, tenantId]))[0];
    if (!d) return null;
    const v = d.vendor_id ? (await q.query<any>('SELECT legal_name_en FROM vendors WHERE id=$1', [d.vendor_id]))[0] : null;
    return { type: 'DOCUMENT', id: d.id, ref: d.title, facts: documentFacts(d, actor), creatorId: null, vendorId: d.vendor_id,
      vars: { 'document.title': d.title, 'vendor.name': v?.legal_name_en ?? '' },
      publicData: { documentId: d.id, title: d.title, kind: d.owner_type, mimeType: d.mime_type, vendorId: d.vendor_id } };
  }
  return null;
}

type Outcome = { action: string; ok: boolean; detail: string };

/** Run the actions of one matched rule inside the caller's transaction. */
export async function runActions(ctx: Ctx, q: Queryable, tenantId: string, rule: Rule, subject: Subject, trigger: string, rulesetVersion: number | null): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const a of rule.actions) {
    try { out.push(await runAction(ctx, q, tenantId, rule, a, subject, trigger, rulesetVersion)); }
    catch (e) { out.push({ action: a.type, ok: false, detail: (e as Error).message.slice(0, 300) }); }
  }
  return out;
}

async function runAction(ctx: Ctx, q: Queryable, tenantId: string, rule: Rule, a: Action, s: Subject, trigger: string, rsv: number | null): Promise<Outcome> {
  const body = { [s.type === 'TENDER' ? 'tenderId' : s.type === 'VENDOR' ? 'vendorId' : s.type === 'REQUEST' ? 'requestId' : 'documentId']: s.id, rule: rule.id };
  switch (a.type) {
    case 'NOTIFY': {
      const titleEn = fillText(a.titleEn, s.vars); const titleAr = fillText(a.titleAr, s.vars);
      if (a.to === 'ROLE') { const n = await notifyRole(q, tenantId, a.role!, { kind: 'PROCESS_RULE', titleEn, titleAr, body }); return { action: a.type, ok: true, detail: `${n} user(s) with role ${a.role}` }; }
      if (a.to === 'CREATOR') {
        if (!s.creatorId || !isUuid(s.creatorId)) return { action: a.type, ok: false, detail: 'no creator to notify' };
        await notify(q, { tenantId, userId: s.creatorId, kind: 'PROCESS_RULE', titleEn, titleAr, body }); return { action: a.type, ok: true, detail: 'creator' };
      }
      if (!s.vendorId) return { action: a.type, ok: false, detail: 'no vendor to notify' };
      await notify(q, { tenantId, vendorId: s.vendorId, kind: 'PROCESS_RULE', titleEn, titleAr, body }); return { action: a.type, ok: true, detail: 'vendor' };
    }
    case 'CREATE_TASK': {
      const open = await q.query('SELECT 1 FROM lowcode_tasks WHERE tenant_id=$1 AND subject_id=$2 AND rule_id=$3 AND status=\'OPEN\'', [tenantId, s.id, rule.id]);
      if (open.length) return { action: a.type, ok: true, detail: 'task already open' };
      const id = uuid();
      const due = a.dueHours ? new Date(now().getTime() + a.dueHours * 3600_000) : null;
      await q.query(`INSERT INTO lowcode_tasks (id, tenant_id, subject_type, subject_id, subject_ref, rule_id, ruleset_version, title_en, title_ar, role, blocks_gate, due_at, status, created_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'OPEN',$13)`,
        [id, tenantId, s.type, s.id, s.ref, rule.id, rsv, fillText(a.titleEn, s.vars), fillText(a.titleAr, s.vars), a.role, a.blocksGate ?? null, due, now()]);
      await notifyRole(q, tenantId, a.role, { kind: 'PROCESS_TASK', titleEn: `New task: ${fillText(a.titleEn, s.vars)}`, titleAr: `مهمة جديدة: ${fillText(a.titleAr, s.vars)}`, body: { ...body, taskId: id } });
      await auditTx(ctx, q, { tenantId, actor: SYSTEM_ACTOR, action: 'LOWCODE_TASK_CREATED', resourceType: s.type, resourceId: s.id,
        details: { taskId: id, rule: rule.id, role: a.role, blocksGate: a.blocksGate ?? null, trigger } });
      return { action: a.type, ok: true, detail: `task for ${a.role}${a.blocksGate ? `, blocks ${a.blocksGate}` : ''}` };
    }
    case 'WEBHOOK': {
      const ep = (await q.query<any>('SELECT id, enabled FROM webhook_endpoints WHERE tenant_id=$1 AND code=$2', [tenantId, a.endpoint]))[0];
      if (!ep) return { action: a.type, ok: false, detail: `integration '${a.endpoint}' not found` };
      if (!ep.enabled) return { action: a.type, ok: false, detail: `integration '${a.endpoint}' is switched off` };
      await enqueue(q, tenantId, ep.id, trigger, eventPayload(tenantId, trigger, s, rule.id));
      return { action: a.type, ok: true, detail: `queued to ${a.endpoint}` };
    }
    case 'SET_FIELD': {
      const table = s.type === 'TENDER' ? 'tenders' : s.type === 'VENDOR' ? 'vendors' : s.type === 'REQUEST' ? 'procurement_requests' : null;
      const row = s.tender ?? s.vendor ?? s.request;
      if (!table || !row) return { action: a.type, ok: false, detail: 'no object to update' };
      const form: FormDefinition | null = await formById(q, row.custom_form?.id);
      if (!form) return { action: a.type, ok: false, detail: 'object has no custom form' };
      const vals = validateValues(form, { [a.field]: a.value }, { previous: row.custom_fields ?? {}, mode: 'SAVE', budget: row.estimated_budget === undefined || row.estimated_budget === null ? null : Number(row.estimated_budget) });
      await q.query(`UPDATE ${table} SET custom_fields=$1::jsonb WHERE id=$2 AND tenant_id=$3`, [JSON.stringify(vals), s.id, tenantId]);
      row.custom_fields = vals;
      await auditTx(ctx, q, { tenantId, actor: SYSTEM_ACTOR, action: 'LOWCODE_FIELD_SET', resourceType: s.type, resourceId: s.id,
        details: { rule: rule.id, field: a.field, value: vals[a.field] ?? null } });
      return { action: a.type, ok: true, detail: `${a.field} = ${JSON.stringify(vals[a.field] ?? null)}` };
    }
    default:
      return { action: a.type, ok: false, detail: 'not an event action' };
  }
}

export function eventPayload(tenantId: string, trigger: string, s: Subject, ruleId: string | null, occurredAt = now()) {
  return { event: trigger, entity: tenantId, occurredAt: occurredAt.toISOString(), rule: ruleId, subject: { type: s.type, id: s.id, reference: s.ref }, data: s.publicData };
}

async function logRun(q: Queryable, tenantId: string, trigger: string, rule: Rule, rsv: number | null, s: Subject, seq: string | number | null, out: Outcome[]) {
  const ok = out.filter((o) => o.ok).length;
  await q.query(`INSERT INTO lowcode_runs (id, tenant_id, trigger, rule_id, rule_name, ruleset_version, subject_type, subject_id, subject_ref, audit_seq, outcome, status, created_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)`,
    [uuid(), tenantId, trigger, rule.id, rule.nameEn, rsv, s.type, s.id, s.ref, seq, JSON.stringify(out), ok === out.length ? 'OK' : ok ? 'PARTIAL' : 'ERROR', now()]);
}

/** Process audit events after the cursor for one entity. Returns counts. */
export async function processEvents(ctx: Ctx, tenantId: string, limit = 200) {
  const rs = await liveRuleset(ctx.db, tenantId);
  const hooks = await ctx.db.query<{ id: string; events: string[] }>('SELECT id, events FROM webhook_endpoints WHERE tenant_id=$1 AND enabled AND cardinality(events) > 0', [tenantId]);
  if (!rs && !hooks.length) return { events: 0, runs: 0 };
  let cur = (await ctx.db.query<{ last_seq: string }>('SELECT last_seq FROM lowcode_cursor WHERE tenant_id=$1', [tenantId]))[0];
  if (!cur) {
    await ctx.db.query(`INSERT INTO lowcode_cursor (tenant_id, last_seq, updated_at) SELECT $1, COALESCE(max(seq),0), $2 FROM audit_events WHERE tenant_id=$1
                        ON CONFLICT (tenant_id) DO NOTHING`, [tenantId, now()]);
    return { events: 0, runs: 0 };
  }
  const events = await ctx.db.query<AuditEvt>(
    `SELECT seq, tenant_id, actor_id, actor_roles, action, resource_type, resource_id, details, at FROM audit_events
      WHERE tenant_id=$1 AND seq > $2 ORDER BY seq LIMIT $3`, [tenantId, cur.last_seq, limit]);
  let runs = 0;
  for (const e of events) {
    const trigger = triggerForAuditAction(e.action);
    await ctx.db.tx(async (q) => {
      if (trigger) {
        const rules = (rs?.definition.rules ?? []).filter((r: Rule) => r.enabled && r.trigger === trigger);
        const subs = hooks.filter((h) => h.events.includes(trigger));
        if (rules.length || subs.length) {
          const s = await loadSubject(q, tenantId, trigger, { resourceType: e.resource_type, resourceId: e.resource_id, details: e.details, actorRoles: e.actor_roles });
          if (s) {
            for (const r of rules) {
              if (!evaluate(r.when, s.facts)) continue;
              const out = await runActions(ctx, q, tenantId, r, s, trigger, rs!.version);
              await logRun(q, tenantId, trigger, r, rs!.version, s, e.seq, out);
              runs++;
            }
            for (const h of subs) await enqueue(q, tenantId, h.id, trigger, eventPayload(tenantId, trigger, s, null, new Date(e.at)));
          }
        }
      }
      await q.query('UPDATE lowcode_cursor SET last_seq=$1, updated_at=$2 WHERE tenant_id=$3 AND last_seq < $1', [e.seq, now(), tenantId]);
    });
  }
  return { events: events.length, runs };
}

/** SCHEDULE rules: DEADLINE_APPROACHING fires once per (rule, tender) when a published tender is within N hours. */
export async function processSchedules(ctx: Ctx, tenantId: string) {
  const rs: DefinitionRow | null = await liveRuleset(ctx.db, tenantId);
  const rules = (rs?.definition.rules ?? []).filter((r: Rule) => r.enabled && r.trigger === 'DEADLINE_APPROACHING');
  let runs = 0;
  for (const r of rules) {
    const until = new Date(now().getTime() + (r.params?.hoursBefore ?? 24) * 3600_000);
    const due = await ctx.db.query<{ id: string }>(`SELECT id FROM tenders WHERE tenant_id=$1 AND status='PUBLISHED' AND submission_deadline > $2 AND submission_deadline <= $3`,
      [tenantId, now(), until]);
    for (const t of due) {
      await ctx.db.tx(async (q) => {
        const fired = await q.query(`INSERT INTO lowcode_firings (tenant_id, rule_id, subject_id, fired_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING rule_id`,
          [tenantId, r.id, t.id, now()]);
        if (!fired.length) return;
        const s = await loadSubject(q, tenantId, 'DEADLINE_APPROACHING', { resourceType: 'TENDER', resourceId: t.id });
        if (!s || !evaluate(r.when, s.facts)) return;
        const out = await runActions(ctx, q, tenantId, r, s, 'DEADLINE_APPROACHING', rs!.version);
        await logRun(q, tenantId, 'DEADLINE_APPROACHING', r, rs!.version, s, null, out);
        runs++;
      });
    }
  }
  return { runs };
}

/** Job body: every entity (or the one an admin ran it for). */
export async function runAutomation(ctx: Ctx, opts: { tenantId?: string } = {}) {
  const tenants = opts.tenantId ? [{ id: opts.tenantId }] : await ctx.db.query<{ id: string }>(
    `SELECT DISTINCT tenant_id AS id FROM lowcode_definitions WHERE kind='RULESET' AND status='PUBLISHED'
     UNION SELECT DISTINCT tenant_id FROM webhook_endpoints WHERE enabled`);
  let events = 0, runs = 0;
  for (const t of tenants) {
    const a = await processEvents(ctx, t.id);
    const b = await processSchedules(ctx, t.id);
    events += a.events; runs += a.runs + b.runs;
  }
  return { entities: tenants.length, events, runs };
}

// ---------------------------------------------------------------- tasks
export async function listTasks(ctx: Ctx, actor: Actor, query: Record<string, unknown>) {
  const all = query.scope === 'all' && hasRole(actor, 'TENANT_ADMIN', 'AUDITOR');
  const subject = typeof query.subjectId === 'string' && isUuid(query.subjectId) ? query.subjectId : null;
  const status = typeof query.status === 'string' && ['OPEN', 'DONE', 'CANCELLED'].includes(query.status) ? query.status : null;
  const rows = await ctx.db.query<any>(
    `SELECT * FROM lowcode_tasks WHERE tenant_id=$1 AND ($2::boolean OR role = ANY($3::text[])) AND ($4::uuid IS NULL OR subject_id=$4::uuid)
       AND ($5::text IS NULL OR status=$5) ORDER BY (status='OPEN') DESC, due_at NULLS LAST, created_at DESC LIMIT 200`,
    [actor.tenantId, all || !!subject, actor.roles, subject, status]);
  return rows.map(taskView);
}

export async function completeTask(ctx: Ctx, actor: Actor, id: string, b: any, cancel = false) {
  if (!isUuid(id)) throw notFound('Task');
  const t = (await ctx.db.query<any>('SELECT * FROM lowcode_tasks WHERE id=$1 AND tenant_id=$2', [id, actor.tenantId]))[0];
  if (!t) throw notFound('Task');
  if (t.status !== 'OPEN') throw conflict('INVALID_STATE', `Task is already ${t.status}`);
  if (cancel ? !hasRole(actor, 'TENANT_ADMIN') : !hasRole(actor, t.role, 'TENANT_ADMIN')) throw forbidden(cancel ? 'Only the entity administrator can cancel a task' : `This task is assigned to role ${t.role}`);
  const note = cancel ? str(b?.reason, 'reason', { required: true, max: 2000 })! : str(b?.note, 'note', { max: 2000 }) ?? null;
  if (!cancel && t.blocks_gate && !note) throw badRequest('A task that blocks a step needs a short completion note');
  return ctx.db.tx(async (q) => {
    const rows = await q.query<any>(`UPDATE lowcode_tasks SET status=$1, completed_by=$2, completed_at=$3, note=$4 WHERE id=$5 AND status='OPEN' RETURNING *`,
      [cancel ? 'CANCELLED' : 'DONE', actor.id, now(), note, id]);
    if (!rows[0]) throw conflict('INVALID_STATE', 'Task changed meanwhile');
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: cancel ? 'LOWCODE_TASK_CANCELLED' : 'LOWCODE_TASK_COMPLETED', resourceType: t.subject_type,
      resourceId: t.subject_id, reason: note, details: { taskId: id, rule: t.rule_id, blocksGate: t.blocks_gate } });
    return taskView(rows[0]);
  });
}

export async function listRuns(ctx: Ctx, actor: Actor, query: Record<string, unknown>) {
  const rows = await ctx.db.query<any>(`SELECT id, trigger, rule_id, rule_name, ruleset_version, subject_type, subject_id, subject_ref, outcome, status, created_at
     FROM lowcode_runs WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC LIMIT 200`,
    [actor.tenantId, typeof query.status === 'string' ? query.status : null]);
  return rows.map((r) => ({ id: r.id, trigger: r.trigger, ruleId: r.rule_id, ruleName: r.rule_name, rulesetVersion: r.ruleset_version, subjectType: r.subject_type,
    subjectId: r.subject_id, subjectRef: r.subject_ref, outcome: r.outcome, status: r.status, createdAt: r.created_at }));
}
