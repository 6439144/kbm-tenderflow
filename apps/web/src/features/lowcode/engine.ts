// Client-side mirror of the server's condition and formula evaluation, used only for live previews
// (show/hide fields, calculated values while typing, plain-language sentences). The server re-validates everything.
import type { Condition, FactDef, FormField } from './api';

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const eq = (a: unknown, b: unknown) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

export function evaluate(c: Condition | null | undefined, facts: Record<string, unknown>): boolean {
  if (!c) return true;
  if ('all' in c) return c.all.every((x) => evaluate(x, facts));
  if ('any' in c) return c.any.some((x) => evaluate(x, facts));
  if ('not' in c) return !evaluate(c.not, facts);
  const v = facts[c.fact];
  const w = c.value as any;
  switch (c.op) {
    case 'isEmpty': return isEmpty(v);
    case 'isNotEmpty': return !isEmpty(v);
    case 'isTrue': return v === true || v === 'true';
    case 'isFalse': return !(v === true || v === 'true');
    case 'eq': return typeof w === 'number' ? num(v) === w : eq(v, w);
    case 'ne': return typeof w === 'number' ? num(v) !== w : !eq(v, w);
    case 'gt': return num(v) > Number(w);
    case 'gte': return num(v) >= Number(w);
    case 'lt': return num(v) < Number(w);
    case 'lte': return num(v) <= Number(w);
    case 'between': return num(v) >= Number(w?.[0]) && num(v) <= Number(w?.[1]);
    case 'in': return !isEmpty(v) && (w as string[]).some((x) => eq(v, x));
    case 'notIn': return !(w as string[]).some((x) => eq(v, x));
    case 'contains': return String(v ?? '').toLowerCase().includes(String(w).toLowerCase());
    case 'startsWith': return String(v ?? '').toLowerCase().startsWith(String(w).toLowerCase());
    case 'includes': return Array.isArray(v) && v.some((x) => eq(x, w));
    case 'excludes': return !Array.isArray(v) || !v.some((x) => eq(x, w));
    case 'before': return !isEmpty(v) && String(v).slice(0, 10) < String(w);
    case 'after': return !isEmpty(v) && String(v).slice(0, 10) > String(w);
    default: return false;
  }
}

export function describe(c: Condition | null | undefined, facts: FactDef[], opLabels: Record<string, { en: string; ar: string }>, lang: 'en' | 'ar'): string {
  if (!c) return lang === 'ar' ? 'دائماً' : 'always';
  const join = (xs: string[], w: string) => (xs.length === 1 ? xs[0] : `(${xs.join(` ${w} `)})`);
  if ('all' in c) return join(c.all.map((x) => describe(x, facts, opLabels, lang)), lang === 'ar' ? 'و' : 'and');
  if ('any' in c) return join(c.any.map((x) => describe(x, facts, opLabels, lang)), lang === 'ar' ? 'أو' : 'or');
  if ('not' in c) return `${lang === 'ar' ? 'ليس' : 'not'} ${describe(c.not, facts, opLabels, lang)}`;
  const f = facts.find((x) => x.key === c.fact);
  const label = f ? (lang === 'ar' ? f.labelAr : f.labelEn) : c.fact;
  const op = opLabels[c.op]?.[lang] ?? c.op;
  const optLabel = (v: unknown) => { const o = f?.options?.find((x) => x.value === v); return o ? (lang === 'ar' ? o.labelAr : o.labelEn) : String(v); };
  const val = c.value === undefined ? '' : Array.isArray(c.value) ? (c.op === 'between' ? c.value.join(' – ') : c.value.map(optLabel).join(', '))
    : typeof c.value === 'number' ? c.value.toLocaleString('en-US') : optLabel(c.value);
  return `${label} ${op}${val !== '' ? ' ' + val : ''}`;
}

// ---- formula (same grammar as the server)
type Node = { t: 'num'; v: number } | { t: 'ref'; n: string } | { t: 'neg'; e: Node } | { t: 'bin'; op: string; a: Node; b: Node } | { t: 'fn'; n: string; args: Node[] };
export function parseFormula(src: string): Node | null {
  const toks = src.match(/\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|[-+*/(),]|\S/g) ?? [];
  let p = 0;
  const peek = () => toks[p];
  const expr = (): Node => { let a = term(); while (peek() === '+' || peek() === '-') { const op = toks[p++]; a = { t: 'bin', op, a, b: term() }; } return a; };
  const term = (): Node => { let a = factor(); while (peek() === '*' || peek() === '/') { const op = toks[p++]; a = { t: 'bin', op, a, b: factor() }; } return a; };
  const factor = (): Node => {
    const t = toks[p++];
    if (t === undefined) throw new Error('incomplete');
    if (t === '-') return { t: 'neg', e: factor() };
    if (t === '(') { const e = expr(); if (toks[p++] !== ')') throw new Error(')'); return e; }
    if (/^\d/.test(t)) return { t: 'num', v: Number(t) };
    if (/^[A-Za-z_]/.test(t)) {
      if (peek() === '(') { p++; const args = [expr()]; while (peek() === ',') { p++; args.push(expr()); } if (toks[p++] !== ')') throw new Error(')'); return { t: 'fn', n: t.toLowerCase(), args }; }
      return { t: 'ref', n: t };
    }
    throw new Error(t);
  };
  try { const n = expr(); return p === toks.length ? n : null; } catch { return null; }
}
export function evalFormula(n: Node | null, vars: Record<string, number | null>): number | null {
  if (!n) return null;
  const ev = (x: Node): number => {
    switch (x.t) {
      case 'num': return x.v;
      case 'ref': { const v = vars[x.n]; if (v === null || v === undefined || !Number.isFinite(v)) throw 0; return v; }
      case 'neg': return -ev(x.e);
      case 'bin': { const a = ev(x.a); const b = ev(x.b); if (x.op === '/' && b === 0) throw 0; return x.op === '+' ? a + b : x.op === '-' ? a - b : x.op === '*' ? a * b : a / b; }
      case 'fn': {
        const a = x.args.map(ev);
        if (x.n === 'min') return Math.min(...a);
        if (x.n === 'max') return Math.max(...a);
        if (x.n === 'abs') return Math.abs(a[0]);
        if (x.n === 'round') { const d = Math.max(0, Math.min(6, Math.trunc(a[1] ?? 0))); return Math.round(a[0] * 10 ** d) / 10 ** d; }
        throw 0;
      }
    }
  };
  try { const v = ev(n); return Number.isFinite(v) ? v : null; } catch { return null; }
}

export const selfFacts = (vals: Record<string, unknown>) => Object.fromEntries(Object.entries(vals).map(([k, v]) => [`self.${k}`, v]));
export const visible = (f: FormField, vals: Record<string, unknown>) => !f.visibleWhen || evaluate(f.visibleWhen, selfFacts(vals));

/** Values with calculated fields filled in (preview only — the server computes the stored values). */
export function withComputed(fields: FormField[], vals: Record<string, unknown>, budget?: number | null): Record<string, unknown> {
  const out = { ...vals };
  for (let pass = 0; pass < 3; pass++) for (const f of fields.filter((x) => x.type === 'computed')) {
    const v: Record<string, number | null> = { budget: budget ?? null };
    for (const [k, x] of Object.entries(out)) v[k] = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' && !Number.isNaN(Number(x)) ? Number(x) : null;
    const r = evalFormula(parseFormula(f.formula ?? ''), v);
    out[f.key] = r === null ? null : Number(r.toFixed(f.decimals ?? 3));
  }
  return out;
}

export function defaults(fields: FormField[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter((f) => f.type !== 'computed' && f.defaultValue !== undefined).map((f) => [f.key, f.defaultValue]));
}
