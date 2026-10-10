// Conditions: a JSON tree the Process Studio builds visually — no code, no eval.
//   { all: [c, …] } | { any: [c, …] } | { not: c } | { fact: 'tender.estimatedBudget', op: 'gt', value: 500000 }
// validateCondition() checks every fact and operator against the catalogue (and the entity's custom fields);
// evaluate() is total: a missing fact is "empty", never an exception.
import { badRequest } from '../util.js';
import { FACTS, OPS, OP_LABELS, type FactDef, type FactType, type Scope } from './catalog.js';
import type { FormField } from './forms.js';

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { fact: string; op: string; value?: unknown };

export type Facts = Record<string, unknown>;

const MAX_DEPTH = 4;
const MAX_LEAVES = 25;

const FIELD_FACT_TYPE: Record<string, FactType> = {
  text: 'string', textarea: 'string', email: 'string', phone: 'string', url: 'string', number: 'number', money: 'number',
  percent: 'number', computed: 'number', date: 'date', select: 'enum', multiselect: 'list', checkbox: 'boolean',
};

/** All facts usable in a scope, including the entity's custom fields. */
export function factsFor(scope: Scope | null, custom: { prefix: string; scopes: Scope[]; fields: FormField[] }[] = []): FactDef[] {
  const out = FACTS.filter((f) => !scope || f.scopes.includes(scope));
  for (const c of custom) {
    if (scope && !c.scopes.includes(scope)) continue;
    for (const f of c.fields) {
      out.push({
        key: `${c.prefix}${f.key}`, labelEn: f.labelEn, labelAr: f.labelAr, type: FIELD_FACT_TYPE[f.type] ?? 'string', scopes: c.scopes,
        options: f.options?.map((x) => ({ value: x.value, labelEn: x.labelEn, labelAr: x.labelAr })),
      });
    }
  }
  return out;
}

export function validateCondition(c: unknown, facts: FactDef[], path = 'when', depth = 0, count = { n: 0 }): Condition {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw badRequest(`${path} must be a condition object`);
  if (depth > MAX_DEPTH) throw badRequest(`${path}: conditions may be nested at most ${MAX_DEPTH} levels`);
  const o = c as any;
  const keys = Object.keys(o);
  if ('all' in o || 'any' in o) {
    const k = 'all' in o ? 'all' : 'any';
    if (keys.length !== 1) throw badRequest(`${path}: a group has exactly one key (all or any)`);
    if (!Array.isArray(o[k]) || !o[k].length) throw badRequest(`${path}.${k} must be a non-empty list`);
    return { [k]: o[k].map((x: unknown, i: number) => validateCondition(x, facts, `${path}.${k}[${i}]`, depth + 1, count)) } as Condition;
  }
  if ('not' in o) {
    if (keys.length !== 1) throw badRequest(`${path}: 'not' takes one condition`);
    return { not: validateCondition(o.not, facts, `${path}.not`, depth + 1, count) };
  }
  if (++count.n > MAX_LEAVES) throw badRequest(`A rule may test at most ${MAX_LEAVES} conditions`);
  const fact = facts.find((f) => f.key === o.fact);
  if (!fact) throw badRequest(`${path}.fact '${String(o.fact)}' is not available here`);
  if (!OPS[fact.type].includes(o.op)) throw badRequest(`${path}.op '${String(o.op)}' cannot be used with ${fact.labelEn} (${fact.type}); use one of ${OPS[fact.type].join(', ')}`);
  return { fact: fact.key, op: o.op, ...(needsValue(o.op) ? { value: normaliseValue(fact, o.op, o.value, path) } : {}) };
}

const needsValue = (op: string) => !['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse'].includes(op);

function normaliseValue(f: FactDef, op: string, v: unknown, path: string): unknown {
  const num = (x: unknown) => {
    const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN;
    if (!Number.isFinite(n)) throw badRequest(`${path}.value must be a number for ${f.labelEn}`);
    return n;
  };
  const text = (x: unknown) => {
    if (typeof x !== 'string' && typeof x !== 'number') throw badRequest(`${path}.value must be text`);
    const s = String(x).trim();
    if (!s || s.length > 200) throw badRequest(`${path}.value must be 1-200 characters`);
    return s;
  };
  const opt = (x: unknown) => {
    const s = text(x);
    if (f.options && !f.options.some((p) => p.value === s)) throw badRequest(`${path}.value '${s}' is not an option of ${f.labelEn}`);
    return s;
  };
  if (op === 'between') {
    if (!Array.isArray(v) || v.length !== 2) throw badRequest(`${path}.value must be [from, to]`);
    const [a, b] = [num(v[0]), num(v[1])];
    if (a > b) throw badRequest(`${path}.value: 'from' must not exceed 'to'`);
    return [a, b];
  }
  if (op === 'in' || op === 'notIn') {
    const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
    const out = arr.map((x) => (f.options ? opt(x) : text(x)));
    if (!out.length || out.length > 50) throw badRequest(`${path}.value must list 1-50 values`);
    return out;
  }
  if (f.type === 'number') return num(v);
  if (f.type === 'date') {
    if (op === 'withinDays') { const n = num(v); if (n < 0 || n > 3650) throw badRequest(`${path}.value must be 0-3650 days`); return n; }
    const d = typeof v === 'string' ? new Date(v) : null;
    if (!d || Number.isNaN(d.getTime())) throw badRequest(`${path}.value must be a date (YYYY-MM-DD)`);
    return d.toISOString().slice(0, 10);
  }
  if (f.type === 'enum' || (f.type === 'list' && f.options)) return opt(v);
  return text(v);
}

const isEmptyVal = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const asNum = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const eqText = (a: unknown, b: unknown) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

export function evaluate(c: Condition | null | undefined, facts: Facts, today = new Date()): boolean {
  if (!c) return true;
  if ('all' in c) return c.all.every((x) => evaluate(x, facts, today));
  if ('any' in c) return c.any.some((x) => evaluate(x, facts, today));
  if ('not' in c) return !evaluate(c.not, facts, today);
  const v = facts[c.fact];
  const want = c.value;
  switch (c.op) {
    case 'isEmpty': return isEmptyVal(v);
    case 'isNotEmpty': return !isEmptyVal(v);
    case 'isTrue': return v === true || v === 'true';
    case 'isFalse': return !(v === true || v === 'true');
    case 'eq': return typeof want === 'number' ? asNum(v) === want : eqText(v, want);
    case 'ne': return typeof want === 'number' ? asNum(v) !== want : !eqText(v, want);
    case 'gt': return asNum(v) > (want as number);
    case 'gte': return asNum(v) >= (want as number);
    case 'lt': return asNum(v) < (want as number);
    case 'lte': return asNum(v) <= (want as number);
    case 'between': { const n = asNum(v); const [a, b] = want as number[]; return n >= a && n <= b; }
    case 'in': return !isEmptyVal(v) && (want as string[]).some((w) => eqText(v, w));
    case 'notIn': return !(want as string[]).some((w) => eqText(v, w));
    case 'contains': return String(v ?? '').toLowerCase().includes(String(want).toLowerCase());
    case 'startsWith': return String(v ?? '').toLowerCase().startsWith(String(want).toLowerCase());
    case 'includes': return Array.isArray(v) && v.some((x) => eqText(x, want));
    case 'excludes': return !Array.isArray(v) || !v.some((x) => eqText(x, want));
    case 'before': return !isEmptyVal(v) && String(v).slice(0, 10) < String(want);
    case 'after': return !isEmptyVal(v) && String(v).slice(0, 10) > String(want);
    case 'withinDays': {
      if (isEmptyVal(v)) return false;
      const d = new Date(String(v)); if (Number.isNaN(d.getTime())) return false;
      const days = (d.getTime() - today.getTime()) / 86_400_000;
      return days >= 0 && days <= (want as number);
    }
    default: return false;
  }
}

/** Plain-language sentence for a condition (shown in the Studio, the simulator and the audit details). */
export function describe(c: Condition | null | undefined, facts: FactDef[], lang: 'en' | 'ar' = 'en'): string {
  if (!c) return lang === 'ar' ? 'دائماً' : 'always';
  const join = (xs: string[], w: string) => xs.length === 1 ? xs[0] : `(${xs.join(` ${w} `)})`;
  if ('all' in c) return join(c.all.map((x) => describe(x, facts, lang)), lang === 'ar' ? 'و' : 'and');
  if ('any' in c) return join(c.any.map((x) => describe(x, facts, lang)), lang === 'ar' ? 'أو' : 'or');
  if ('not' in c) return `${lang === 'ar' ? 'ليس' : 'not'} ${describe(c.not, facts, lang)}`;
  const f = facts.find((x) => x.key === c.fact);
  const label = f ? (lang === 'ar' ? f.labelAr : f.labelEn) : c.fact;
  const op = OP_LABELS[c.op]?.[lang] ?? c.op;
  const val = c.value === undefined ? '' : Array.isArray(c.value) ? (c.op === 'between' ? c.value.join(' – ') : c.value.join(', '))
    : typeof c.value === 'number' ? c.value.toLocaleString('en-US') : String(c.value);
  return `${label} ${op}${val ? ' ' + val : ''}`;
}

/** Facts referenced by a condition (to warn when a custom field the rule uses is removed from the form). */
export function factsUsed(c: Condition | null | undefined, out = new Set<string>()): Set<string> {
  if (!c) return out;
  if ('all' in c) c.all.forEach((x) => factsUsed(x, out));
  else if ('any' in c) c.any.forEach((x) => factsUsed(x, out));
  else if ('not' in c) factsUsed(c.not, out);
  else out.add(c.fact);
  return out;
}
