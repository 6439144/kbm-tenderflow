// Where the low-code layer meets the tender cycle: facts about an object, custom-field values, and the gates
// (submit for approval, publish, recommend award). Gates are evaluated before the transition's transaction; a gate that
// stops a transition is logged and audited (LOWCODE_GATE_BLOCKED) and the caller gets 409 PROCESS_RULE_BLOCKED with the
// reasons in both languages. Approval levels added by routing rules are stored on the tender (tenders.routing) and
// merged into its chain by configOf().
import type { Ctx } from '../ctx.js';
import { auditTx } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import type { Queryable } from '../db.js';
import { ApiError, now, uuid } from '../util.js';
import { FACTS, type FactDef } from './catalog.js';
import { factsFor, type Facts } from './conditions.js';
import { liveDefinition, liveRuleset } from './definitions.js';
import { missingRequired, presentValues, publicDefinition, validateValues, type FormDefinition, type FormField } from './forms.js';
import { evaluateGate, gateRulesOf, type GateOutcome, type Rule } from './rules.js';
import type { TenderRow } from '../services/tenders.js';

export interface PinnedForm { id: string; version: number }
export interface ProcessSnapshot { definitionId: string; version: number; rules: Rule[] }

const formCache = new Map<string, FormDefinition>();
export async function formById(q: Queryable, id: string | null | undefined): Promise<FormDefinition | null> {
  if (!id) return null;
  const hit = formCache.get(id);
  if (hit) return hit;
  const r = await q.query<{ definition: FormDefinition; status: string }>('SELECT definition, status FROM lowcode_definitions WHERE id=$1', [id]);
  if (!r[0]) return null;
  if (r[0].status !== 'DRAFT') formCache.set(id, r[0].definition); // published / retired versions never change
  return r[0].definition;
}

export async function liveForm(q: Queryable, tenantId: string, code: 'TENDER' | 'REQUEST' | 'VENDOR') {
  const row = await liveDefinition(q, tenantId, 'FORM', code);
  return row ? { pin: { id: row.id, version: row.version } as PinnedForm, def: row.definition as FormDefinition } : null;
}

const toNum = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
const custom = (prefix: string, vals: Record<string, unknown> | null | undefined) =>
  Object.fromEntries(Object.entries(vals ?? {}).map(([k, v]) => [`${prefix}${k}`, v]));

// ---------------------------------------------------------------- facts
export async function tenderFacts(q: Queryable, t: TenderRow & { custom_fields?: any }, actor?: { roles: string[] } | null): Promise<Facts> {
  const counts = (await q.query<{ pack: string; add: string; clar: string }>(
    `SELECT (SELECT count(*) FROM documents WHERE tender_id=$1 AND owner_type='TENDER_PACK')::text AS pack,
            (SELECT count(*) FROM documents WHERE tender_id=$1 AND owner_type='ADDENDUM')::text AS add,
            (SELECT count(*) FROM clarifications WHERE tender_id=$1)::text AS clar`, [t.id]))[0];
  const snap = t.template_snapshot;
  return {
    'tender.estimatedBudget': toNum(t.estimated_budget), 'tender.category': t.category, 'tender.currency': t.currency,
    'tender.templateCode': snap?.code ?? null, 'tender.envelopes': snap?.config?.envelopes ?? 'ONE', 'tender.status': t.status,
    'tender.deadlineDays': Math.floor((new Date(t.submission_deadline).getTime() - now().getTime()) / 86_400_000),
    'tender.packDocuments': Number(counts.pack), 'tender.addenda': Number(counts.add), 'tender.clarifications': Number(counts.clar),
    'tender.criteriaCount': Array.isArray(t.criteria) ? t.criteria.length : 0, 'tender.minGrade': t.eligibility?.minGrade ?? null,
    'tender.fromRequest': !!t.request_id, 'actor.roles': actor?.roles ?? [],
    ...custom('tender.custom.', t.custom_fields),
  };
}

/** Award facts: counts and scores only (bid prices and files are never facts). */
export async function awardFacts(q: Queryable, t: TenderRow, bidId: string, actor?: { roles: string[] } | null): Promise<Facts> {
  const base = await tenderFacts(q, t, actor);
  const scores = await q.query<{ bid_id: string; avg: string | null }>(
    `SELECT b.id AS bid_id, avg(e.weighted_total)::text AS avg FROM bids b LEFT JOIN evaluations e ON e.bid_id=b.id WHERE b.tender_id=$1 GROUP BY b.id`, [t.id]);
  const ranked = [...scores].sort((a, b) => Number(b.avg ?? -1) - Number(a.avg ?? -1));
  const me = scores.find((s) => s.bid_id === bidId);
  return { ...base, 'award.bidCount': scores.length, 'award.recommendedScore': me?.avg === null || me?.avg === undefined ? null : Number(Number(me.avg).toFixed(2)),
    'award.recommendedRank': me ? ranked.findIndex((s) => s.bid_id === bidId) + 1 : null };
}

export function vendorFacts(v: any, grade: number | null, actor?: { roles: string[] } | null): Facts {
  return { 'vendor.status': v.status, 'vendor.categories': v.categories ?? [], 'vendor.grade': grade, 'actor.roles': actor?.roles ?? [],
    ...custom('vendor.custom.', v.custom_fields) };
}
export function requestFacts(r: any, actor?: { roles: string[] } | null): Facts {
  return { 'request.estimatedBudget': toNum(r.estimated_budget), 'request.department': r.department, 'request.source': r.source,
    'actor.roles': actor?.roles ?? [], ...custom('request.custom.', r.custom_fields) };
}
export function documentFacts(d: any, actor?: { roles: string[] } | null): Facts {
  return { 'document.ownerType': d.owner_type, 'document.mimeType': d.mime_type, 'document.sizeKb': Math.ceil(Number(d.byte_size ?? 0) / 1024),
    'actor.roles': actor?.roles ?? [] };
}

export function tenderFactDefs(form: FormDefinition | null): FactDef[] {
  return factsFor('AWARD', form ? [{ prefix: 'tender.custom.', scopes: ['TENDER', 'AWARD'], fields: form.fields }] : []);
}

// ---------------------------------------------------------------- tenders: pin + custom fields
/** What a new tender pins: the live tender form and the gate rules of the live rule set. */
export async function pinForNewTender(q: Queryable, tenantId: string) {
  const form = await liveForm(q, tenantId, 'TENDER');
  const rs = await liveRuleset(q, tenantId);
  const rules = rs ? gateRulesOf(rs.definition) : [];
  const snapshot: ProcessSnapshot | null = rs ? { definitionId: rs.id, version: rs.version, rules } : null;
  return { form, snapshot };
}

export function tenderCustomValues(form: FormDefinition | null, input: unknown, previous: Record<string, unknown> | undefined, budget: number | null) {
  if (!form) {
    if (input && typeof input === 'object' && Object.keys(input as object).length) throw new ApiError(400, 'VALIDATION_ERROR', 'This entity has no custom tender fields');
    return previous ?? {};
  }
  return validateValues(form, input, { previous, mode: 'SAVE', budget });
}

// ---------------------------------------------------------------- gates
export type TenderGate = 'TENDER_SUBMIT' | 'TENDER_PUBLISH' | 'AWARD_RECOMMEND';
export interface GateCheck extends GateOutcome {
  gate: TenderGate; rulesetVersion: number | null;
  missingFields: { key: string; labelEn: string; labelAr: string }[];
  missingDocuments: { ruleId: string; ruleNameEn: string; ruleNameAr: string; minCount: number; titleContains?: string; found: number }[];
  openTasks: { id: string; titleEn: string; titleAr: string; role: string }[];
  passed: boolean;
}

export async function checkTenderGate(q: Queryable, t: TenderRow & { custom_fields?: any; custom_form?: any; process_snapshot?: any }, gate: TenderGate,
  opts: { actor?: Actor | null; bidId?: string } = {}): Promise<GateCheck> {
  const form = await formById(q, t.custom_form?.id);
  const snap = t.process_snapshot as ProcessSnapshot | null;
  const facts = gate === 'AWARD_RECOMMEND' && opts.bidId ? await awardFacts(q, t, opts.bidId, opts.actor) : await tenderFacts(q, t, opts.actor);
  const out = evaluateGate(snap ? { rules: snap.rules } : null, gate, facts, tenderFactDefs(form));
  const vals = (t.custom_fields ?? {}) as Record<string, unknown>;
  const missing: FormField[] = [];
  if (form && gate !== 'AWARD_RECOMMEND') missing.push(...missingRequired(form, vals, 'SUBMIT'));
  for (const rf of out.requiredFields) for (const k of rf.fields) {
    const f = form?.fields.find((x) => x.key === k);
    if (f && (vals[k] === null || vals[k] === undefined || vals[k] === '' || (Array.isArray(vals[k]) && !(vals[k] as unknown[]).length)) && !missing.includes(f)) missing.push(f);
  }
  const missingDocuments: GateCheck['missingDocuments'] = [];
  for (const rd of out.requiredDocuments) {
    const docs = await q.query<{ title: string }>(`SELECT title FROM documents WHERE tender_id=$1 AND owner_type IN ('TENDER_PACK','ADDENDUM')`, [t.id]);
    const needle = rd.titleContains?.toLowerCase();
    const found = docs.filter((d) => !needle || d.title.toLowerCase().includes(needle)).length;
    if (found < rd.minCount) missingDocuments.push({ ...rd, found });
  }
  const openTasks = gate === 'TENDER_SUBMIT' ? [] : await q.query<any>(
    `SELECT id, title_en, title_ar, role FROM lowcode_tasks WHERE subject_id=$1 AND status='OPEN' AND blocks_gate=$2 ORDER BY created_at`, [t.id, gate]);
  return {
    ...out, gate, rulesetVersion: snap?.version ?? null,
    missingFields: missing.map((f) => ({ key: f.key, labelEn: f.labelEn, labelAr: f.labelAr })), missingDocuments,
    openTasks: openTasks.map((x) => ({ id: x.id, titleEn: x.title_en, titleAr: x.title_ar, role: x.role })),
    passed: !out.blocks.length && !missing.length && !missingDocuments.length && !openTasks.length,
  };
}

/** Run a gate for a transition: throws 409 PROCESS_RULE_BLOCKED (logged + audited) when it does not pass. */
export async function enforceTenderGate(ctx: Ctx, actor: Actor, t: TenderRow, gate: TenderGate, opts: { bidId?: string } = {}): Promise<GateCheck> {
  const c = await checkTenderGate(ctx.db, t as any, gate, { actor, bidId: opts.bidId });
  if (c.passed) {
    if (c.matched.length) await ctx.db.tx((q) => logGate(q, t, c, 'OK'));
    return c;
  }
  await ctx.db.tx(async (q) => {
    await logGate(q, t, c, 'BLOCKED');
    await auditTx(ctx, q, { tenantId: t.tenant_id, actor, action: 'LOWCODE_GATE_BLOCKED', resourceType: 'TENDER', resourceId: t.id,
      details: { gate, rulesetVersion: c.rulesetVersion, blocks: c.blocks.map((b) => b.ruleId), missingFields: c.missingFields.map((f) => f.key),
        missingDocuments: c.missingDocuments.map((d) => d.ruleId), openTasks: c.openTasks.map((x) => x.id) } });
  });
  const reasons = [
    ...c.blocks.map((b) => b.messageEn),
    ...(c.missingFields.length ? [`Fill in: ${c.missingFields.map((f) => f.labelEn).join(', ')}`] : []),
    ...c.missingDocuments.map((d) => `${d.ruleNameEn}: needs ${d.minCount} pack document(s)${d.titleContains ? ` titled “${d.titleContains}”` : ''} (found ${d.found})`),
    ...(c.openTasks.length ? [`Open tasks: ${c.openTasks.map((x) => x.titleEn).join('; ')}`] : []),
  ];
  throw new ApiError(409, 'PROCESS_RULE_BLOCKED', `Process rules stop this step — ${reasons.join(' · ')}`, {
    gate, blocks: c.blocks, missingFields: c.missingFields, missingDocuments: c.missingDocuments, openTasks: c.openTasks });
}

async function logGate(q: Queryable, t: TenderRow, c: GateCheck, status: 'OK' | 'BLOCKED') {
  for (const m of c.matched.length ? c.matched : [{ ruleId: '(form)', nameEn: 'Required custom fields', nameAr: 'الحقول المخصصة الإلزامية' }]) {
    await q.query(`INSERT INTO lowcode_runs (id, tenant_id, trigger, rule_id, rule_name, ruleset_version, subject_type, subject_id, subject_ref, outcome, status, created_at)
                   VALUES ($1,$2,$3,$4,$5,$6,'TENDER',$7,$8,$9::jsonb,$10,$11)`,
      [uuid(), t.tenant_id, c.gate, m.ruleId, m.nameEn, c.rulesetVersion, t.id, t.tender_number,
        JSON.stringify({ addLevels: c.addLevels.filter((l) => l.ruleId === m.ruleId).map((l) => l.role), blocks: c.blocks.filter((b) => b.ruleId === m.ruleId).map((b) => b.messageEn),
          missingFields: c.missingFields.map((f) => f.key), openTasks: c.openTasks.length }), status, now()]);
  }
}

/** Approval levels a routing rule adds (stored without the rule's text to keep the chain small). */
export const routedLevels = (c: GateCheck) => c.addLevels.map((l) => ({ role: l.role, labelEn: l.labelEn, labelAr: l.labelAr,
  ...(l.dueHours ? { dueHours: l.dueHours } : {}), ruleId: l.ruleId, ruleNameEn: l.ruleNameEn, ruleNameAr: l.ruleNameAr }));

// ---------------------------------------------------------------- views
/** Process panel of a tender: custom values (vendors: PUBLIC only), gate previews (staff) and tasks. */
export async function tenderProcessView(ctx: Ctx, actor: Actor, t: TenderRow & { custom_fields?: any; custom_form?: any; process_snapshot?: any; routing?: any }, staff: boolean) {
  const form = await formById(ctx.db, t.custom_form?.id);
  const out: any = {
    form: form ? { id: t.custom_form.id, version: t.custom_form.version, definition: staff ? form : publicDefinition(form) } : null,
    values: presentValues(form, t.custom_fields, { publicOnly: !staff }),
  };
  if (!staff) return out;
  out.raw = t.custom_fields ?? {};
  out.ruleset = t.process_snapshot ? { definitionId: t.process_snapshot.definitionId, version: t.process_snapshot.version, gateRules: t.process_snapshot.rules.length } : null;
  out.routing = t.routing ?? null;
  const gates: TenderGate[] = [];
  if (['DRAFT', 'PENDING_APPROVAL'].includes(t.status)) gates.push('TENDER_SUBMIT');
  if (['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(t.status)) gates.push('TENDER_PUBLISH');
  out.gates = {};
  for (const g of gates) out.gates[g] = await checkTenderGate(ctx.db, t, g, { actor });
  out.tasks = (await ctx.db.query<any>(
    `SELECT id, title_en, title_ar, role, blocks_gate, due_at, status, completed_by, completed_at, note, created_at FROM lowcode_tasks
      WHERE tenant_id=$1 AND subject_id=$2 ORDER BY created_at`, [t.tenant_id, t.id])).map(taskView);
  out.runs = await ctx.db.query(`SELECT trigger, rule_id, rule_name, status, outcome, created_at FROM lowcode_runs WHERE tenant_id=$1 AND subject_id=$2 ORDER BY created_at DESC LIMIT 30`,
    [t.tenant_id, t.id]);
  return out;
}

export const taskView = (x: any) => ({ id: x.id, titleEn: x.title_en, titleAr: x.title_ar, role: x.role, blocksGate: x.blocks_gate, dueAt: x.due_at,
  status: x.status, completedBy: x.completed_by, completedAt: x.completed_at, note: x.note, createdAt: x.created_at,
  subjectType: x.subject_type, subjectId: x.subject_id, subjectRef: x.subject_ref, overdue: x.status === 'OPEN' && x.due_at && new Date(x.due_at) < now() });

export { FACTS };
