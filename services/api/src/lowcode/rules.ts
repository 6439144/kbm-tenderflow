// Business rules: "When <trigger>, if <condition>, then <actions>". The rule set is versioned (lowcode_definitions,
// kind RULESET, code PROCESS). Gate rules run inside the transition and may only make it stricter (block it, require
// fields / documents, add approval levels). Event and schedule rules run after the fact (notify, create a task, call a
// webhook, set a custom field). Nothing here can skip an approval, open a bid or edit the audit trail.
import { badRequest, str } from '../util.js';
import {
  ACTIONS, APPROVER_ROLES, BLOCKABLE_GATES, STAFF_TARGET_ROLES, TRIGGERS, triggerDef, type FactDef, type Scope,
} from './catalog.js';
import { describe, evaluate, factsUsed, validateCondition, type Condition, type Facts } from './conditions.js';
import type { FormDefinition, FormField } from './forms.js';
import type { ApprovalLevel } from '../services/templates.js';

export type Action =
  | { type: 'ADD_APPROVER'; role: string; labelEn: string; labelAr: string; dueHours?: number }
  | { type: 'BLOCK'; messageEn: string; messageAr: string }
  | { type: 'REQUIRE_FIELDS'; fields: string[] }
  | { type: 'REQUIRE_DOCUMENTS'; minCount: number; titleContains?: string }
  | { type: 'NOTIFY'; to: 'ROLE' | 'CREATOR' | 'SUBJECT_VENDOR'; role?: string; titleEn: string; titleAr: string }
  | { type: 'CREATE_TASK'; role: string; titleEn: string; titleAr: string; dueHours?: number; blocksGate?: string | null }
  | { type: 'WEBHOOK'; endpoint: string }
  | { type: 'SET_FIELD'; field: string; value: unknown };

export interface Rule {
  id: string; nameEn: string; nameAr: string; enabled: boolean; trigger: string;
  params?: { hoursBefore?: number };
  when: Condition | null; actions: Action[];
}
export interface RulesetDefinition { rules: Rule[] }

export interface RuleContext {
  /** Published (or draft) custom forms by code, to validate custom-field facts and SET_FIELD / REQUIRE_FIELDS. */
  forms: Partial<Record<'TENDER' | 'REQUEST' | 'VENDOR', FormDefinition>>;
  webhookCodes: string[];
}

const RULE_ID = /^[a-z][a-z0-9_-]{1,40}$/;
const MAX_RULES = 100;
const MAX_ACTIONS = 8;

export function customFactSources(forms: RuleContext['forms']) {
  const out: { prefix: string; scopes: Scope[]; fields: FormField[] }[] = [];
  if (forms.TENDER) out.push({ prefix: 'tender.custom.', scopes: ['TENDER', 'AWARD'], fields: forms.TENDER.fields });
  if (forms.VENDOR) out.push({ prefix: 'vendor.custom.', scopes: ['VENDOR'], fields: forms.VENDOR.fields });
  if (forms.REQUEST) out.push({ prefix: 'request.custom.', scopes: ['REQUEST'], fields: forms.REQUEST.fields });
  return out;
}

const formOfScope = (scope: Scope): 'TENDER' | 'VENDOR' | 'REQUEST' | null =>
  scope === 'TENDER' || scope === 'AWARD' ? 'TENDER' : scope === 'VENDOR' ? 'VENDOR' : scope === 'REQUEST' ? 'REQUEST' : null;

export function validateRuleset(raw: any, rc: RuleContext, factsFor: (scope: Scope) => FactDef[]): RulesetDefinition {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.rules)) throw badRequest('definition.rules must be a list');
  if (raw.rules.length > MAX_RULES) throw badRequest(`A rule set may have at most ${MAX_RULES} rules`);
  const rules: Rule[] = raw.rules.map((r: any, i: number) => {
    const p = `rules[${i}]`;
    if (typeof r?.id !== 'string' || !RULE_ID.test(r.id)) throw badRequest(`${p}.id must be 2-41 lower-case letters, digits, _ or - (starting with a letter)`);
    const trig = triggerDef(r.trigger);
    if (!trig) throw badRequest(`${p}.trigger must be one of ${TRIGGERS.map((t) => t.key).join(', ')}`);
    const facts = factsFor(trig.scope);
    const rule: Rule = {
      id: r.id, trigger: trig.key, enabled: r.enabled !== false,
      nameEn: str(r.nameEn, `${p}.nameEn`, { required: true, max: 120 })!, nameAr: str(r.nameAr, `${p}.nameAr`, { required: true, max: 120 })!,
      when: r.when ? validateCondition(r.when, facts, `${p}.when`) : null,
      actions: [],
    };
    if (trig.kind === 'SCHEDULE') {
      const h = Number(r.params?.hoursBefore);
      if (!Number.isInteger(h) || h < 1 || h > 720) throw badRequest(`${p}.params.hoursBefore must be 1-720 hours`);
      rule.params = { hoursBefore: h };
    }
    if (!Array.isArray(r.actions) || !r.actions.length) throw badRequest(`${p}.actions must list at least one action`);
    if (r.actions.length > MAX_ACTIONS) throw badRequest(`${p}: at most ${MAX_ACTIONS} actions per rule`);
    rule.actions = r.actions.map((a: any, j: number) => validateAction(a, `${p}.actions[${j}]`, trig.kind, trig.scope, rc));
    return rule;
  });
  if (new Set(rules.map((r) => r.id)).size !== rules.length) throw badRequest('Rule ids must be unique');
  return { rules };
}

function validateAction(a: any, p: string, kind: string, scope: Scope, rc: RuleContext): Action {
  const def = ACTIONS.find((x) => x.type === a?.type);
  if (!def) throw badRequest(`${p}.type must be one of ${ACTIONS.map((x) => x.type).join(', ')}`);
  if (!def.kinds.includes(kind as any)) throw badRequest(`${p}: '${def.labelEn}' cannot be used with this trigger (${kind === 'GATE' ? 'gates can only block, require or add approvers' : 'events cannot block or add approvers — use a gate trigger'})`);
  if (def.scopes && !def.scopes.includes(scope)) throw badRequest(`${p}: '${def.labelEn}' is not available for ${scope.toLowerCase()} triggers`);
  const s = (v: unknown, f: string, max = 200) => str(v, `${p}.${f}`, { required: true, max })!;
  const due = (v: unknown) => {
    if (v === undefined || v === null || v === '') return undefined;
    const h = Number(v); if (!Number.isInteger(h) || h < 1 || h > 8760) throw badRequest(`${p}.dueHours must be 1-8760`); return h;
  };
  switch (def.type) {
    case 'ADD_APPROVER':
      if (!APPROVER_ROLES.includes(a.role)) throw badRequest(`${p}.role must be one of ${APPROVER_ROLES.join(', ')}`);
      return { type: 'ADD_APPROVER', role: a.role, labelEn: s(a.labelEn, 'labelEn', 120), labelAr: s(a.labelAr, 'labelAr', 120), dueHours: due(a.dueHours) };
    case 'BLOCK':
      return { type: 'BLOCK', messageEn: s(a.messageEn, 'messageEn', 400), messageAr: s(a.messageAr, 'messageAr', 400) };
    case 'REQUIRE_FIELDS': {
      const form = rc.forms.TENDER;
      if (!Array.isArray(a.fields) || !a.fields.length) throw badRequest(`${p}.fields must list custom field keys`);
      for (const k of a.fields) if (!form?.fields.some((f) => f.key === k && f.type !== 'computed')) throw badRequest(`${p}.fields: '${k}' is not a field of the tender form`);
      return { type: 'REQUIRE_FIELDS', fields: [...new Set(a.fields as string[])] };
    }
    case 'REQUIRE_DOCUMENTS': {
      const n = Number(a.minCount ?? 1);
      if (!Number.isInteger(n) || n < 1 || n > 50) throw badRequest(`${p}.minCount must be 1-50`);
      const tc = str(a.titleContains, `${p}.titleContains`, { max: 80 });
      return { type: 'REQUIRE_DOCUMENTS', minCount: n, ...(tc ? { titleContains: tc } : {}) };
    }
    case 'NOTIFY': {
      const to = a.to;
      if (!['ROLE', 'CREATOR', 'SUBJECT_VENDOR'].includes(to)) throw badRequest(`${p}.to must be ROLE, CREATOR or SUBJECT_VENDOR`);
      if (to === 'ROLE' && !STAFF_TARGET_ROLES.includes(a.role)) throw badRequest(`${p}.role must be one of ${STAFF_TARGET_ROLES.join(', ')}`);
      if (to === 'SUBJECT_VENDOR' && scope !== 'VENDOR' && scope !== 'DOCUMENT') throw badRequest(`${p}: SUBJECT_VENDOR is only for vendor triggers`);
      if (to === 'CREATOR' && !['TENDER', 'AWARD', 'REQUEST'].includes(scope)) throw badRequest(`${p}: CREATOR is only for tender and request triggers`);
      return { type: 'NOTIFY', to, ...(to === 'ROLE' ? { role: a.role } : {}), titleEn: s(a.titleEn, 'titleEn', 200), titleAr: s(a.titleAr, 'titleAr', 200) };
    }
    case 'CREATE_TASK': {
      if (!STAFF_TARGET_ROLES.includes(a.role)) throw badRequest(`${p}.role must be one of ${STAFF_TARGET_ROLES.join(', ')}`);
      const bg = a.blocksGate || null;
      if (bg && !BLOCKABLE_GATES.includes(bg)) throw badRequest(`${p}.blocksGate must be one of ${BLOCKABLE_GATES.join(', ')} or empty`);
      if (bg && scope !== 'TENDER' && scope !== 'AWARD') throw badRequest(`${p}.blocksGate is only for tender triggers`);
      return { type: 'CREATE_TASK', role: a.role, titleEn: s(a.titleEn, 'titleEn', 200), titleAr: s(a.titleAr, 'titleAr', 200), dueHours: due(a.dueHours), blocksGate: bg };
    }
    case 'WEBHOOK':
      if (typeof a.endpoint !== 'string' || !rc.webhookCodes.includes(a.endpoint)) throw badRequest(`${p}.endpoint '${String(a.endpoint)}' is not a configured integration`);
      return { type: 'WEBHOOK', endpoint: a.endpoint };
    case 'SET_FIELD': {
      const code = formOfScope(scope);
      const form = code ? rc.forms[code] : undefined;
      const f = form?.fields.find((x) => x.key === a.field);
      if (!f || f.type === 'computed') throw badRequest(`${p}.field '${String(a.field)}' is not an editable field of the ${String(code).toLowerCase()} form`);
      if (!['text', 'select', 'checkbox', 'number', 'money', 'percent', 'date'].includes(f.type)) throw badRequest(`${p}: fields of type ${f.type} cannot be set by a rule`);
      return { type: 'SET_FIELD', field: f.key, value: a.value };
    }
    default:
      throw badRequest(`${p}: unsupported action`);
  }
}

/** Warnings that do not stop publishing (e.g. a rule tests a custom field that has no value yet anywhere). */
export function rulesetWarnings(d: RulesetDefinition): string[] {
  const w: string[] = [];
  for (const r of d.rules) {
    if (!r.enabled) w.push(`Rule '${r.nameEn}' is switched off.`);
    if (!r.when && r.actions.some((a) => a.type === 'BLOCK')) w.push(`Rule '${r.nameEn}' blocks ${r.trigger} with no condition: every tender will be stopped.`);
  }
  const ids = d.rules.map((r) => r.trigger);
  if (ids.length && !d.rules.some((r) => r.enabled)) w.push('No rule is switched on.');
  return w;
}

export const factKeysUsed = (d: RulesetDefinition) => {
  const s = new Set<string>();
  d.rules.forEach((r) => factsUsed(r.when, s));
  return s;
};

export interface GateOutcome {
  addLevels: (ApprovalLevel & { ruleId: string; ruleNameEn: string; ruleNameAr: string })[];
  blocks: { ruleId: string; ruleNameEn: string; ruleNameAr: string; messageEn: string; messageAr: string }[];
  requiredFields: { ruleId: string; fields: string[] }[];
  requiredDocuments: { ruleId: string; ruleNameEn: string; ruleNameAr: string; minCount: number; titleContains?: string }[];
  matched: { ruleId: string; nameEn: string; nameAr: string; whenEn: string; whenAr: string }[];
}

/** Evaluate the gate rules of a rule set for one trigger and set of facts (pure; no I/O). */
export function evaluateGate(d: RulesetDefinition | null | undefined, trigger: string, facts: Facts, factDefs: FactDef[]): GateOutcome {
  const out: GateOutcome = { addLevels: [], blocks: [], requiredFields: [], requiredDocuments: [], matched: [] };
  for (const r of d?.rules ?? []) {
    if (!r.enabled || r.trigger !== trigger || !evaluate(r.when, facts)) continue;
    out.matched.push({ ruleId: r.id, nameEn: r.nameEn, nameAr: r.nameAr, whenEn: describe(r.when, factDefs, 'en'), whenAr: describe(r.when, factDefs, 'ar') });
    const tag = { ruleId: r.id, ruleNameEn: r.nameEn, ruleNameAr: r.nameAr };
    for (const a of r.actions) {
      if (a.type === 'ADD_APPROVER') {
        // The same role is never added twice by two rules (it would only make one person unable to approve twice).
        if (!out.addLevels.some((l) => l.role === a.role)) out.addLevels.push({ role: a.role, labelEn: a.labelEn, labelAr: a.labelAr, ...(a.dueHours ? { dueHours: a.dueHours } : {}), ...tag });
      } else if (a.type === 'BLOCK') out.blocks.push({ ...tag, messageEn: a.messageEn, messageAr: a.messageAr });
      else if (a.type === 'REQUIRE_FIELDS') out.requiredFields.push({ ruleId: r.id, fields: a.fields });
      else if (a.type === 'REQUIRE_DOCUMENTS') out.requiredDocuments.push({ ...tag, minCount: a.minCount, ...(a.titleContains ? { titleContains: a.titleContains } : {}) });
    }
  }
  return out;
}

/** Gate rules only (what a tender pins at creation). */
export const gateRulesOf = (d: RulesetDefinition | null | undefined): Rule[] =>
  (d?.rules ?? []).filter((r) => triggerDef(r.trigger)?.kind === 'GATE');

/** Replace {{placeholders}} in notification / task titles. Unknown names are left empty. */
export function fillText(tpl: string, vars: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_.]{0,60})\s*\}\}/g, (_, k: string) => {
    const v = vars[k];
    return v === undefined || v === null ? '' : String(v).slice(0, 200);
  });
}
