// Calculated fields: a tiny, safe arithmetic language (no eval). Example: `round(budget * bondPercent / 100, 3)`.
// Numbers, + - * / ( ), the functions min, max, round, abs, and names: other numeric custom fields of the same form
// and `budget` (the tender's estimated budget). Division by zero or a missing input gives an empty result.
import { badRequest } from '../util.js';

type Node =
  | { t: 'num'; v: number }
  | { t: 'ref'; name: string }
  | { t: 'neg'; e: Node }
  | { t: 'bin'; op: '+' | '-' | '*' | '/'; a: Node; b: Node }
  | { t: 'fn'; name: 'min' | 'max' | 'round' | 'abs'; args: Node[] };

const FNS = { min: [1, 10], max: [1, 10], round: [1, 2], abs: [1, 1] } as const;

function tokenize(src: string): string[] {
  if (src.length > 300) throw badRequest('A formula may be at most 300 characters');
  const toks: string[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]{0,59})|([-+*/(),]))/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s+$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw badRequest(`Formula: unexpected character at position ${i + 1}`);
    toks.push(m[1] ?? m[2] ?? m[3]);
    i = re.lastIndex;
  }
  return toks;
}

export function parseFormula(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const take = (x?: string) => {
    const t = toks[p++];
    if (x !== undefined && t !== x) throw badRequest(`Formula: expected '${x}'${t ? ` but found '${t}'` : ' at the end'}`);
    return t;
  };
  const expr = (): Node => {
    let a = term();
    while (peek() === '+' || peek() === '-') { const op = take() as '+' | '-'; a = { t: 'bin', op, a, b: term() }; }
    return a;
  };
  const term = (): Node => {
    let a = factor();
    while (peek() === '*' || peek() === '/') { const op = take() as '*' | '/'; a = { t: 'bin', op, a, b: factor() }; }
    return a;
  };
  const factor = (): Node => {
    const t = peek();
    if (t === undefined) throw badRequest('Formula: incomplete expression');
    if (t === '-') { take(); return { t: 'neg', e: factor() }; }
    if (t === '(') { take(); const e = expr(); take(')'); return e; }
    if (/^\d/.test(t)) { take(); return { t: 'num', v: Number(t) }; }
    if (/^[A-Za-z_]/.test(t)) {
      take();
      if (peek() === '(') {
        const name = t.toLowerCase();
        if (!(name in FNS)) throw badRequest(`Formula: unknown function '${t}' (use min, max, round, abs)`);
        take('(');
        const args: Node[] = [expr()];
        while (peek() === ',') { take(); args.push(expr()); }
        take(')');
        const [lo, hi] = FNS[name as keyof typeof FNS];
        if (args.length < lo || args.length > hi) throw badRequest(`Formula: ${name}() takes ${lo === hi ? lo : `${lo}-${hi}`} argument(s)`);
        return { t: 'fn', name: name as any, args };
      }
      return { t: 'ref', name: t };
    }
    throw badRequest(`Formula: unexpected '${t}'`);
  };
  const out = expr();
  if (p !== toks.length) throw badRequest(`Formula: unexpected '${toks[p]}'`);
  return out;
}

export function formulaRefs(n: Node, out = new Set<string>()): Set<string> {
  if (n.t === 'ref') out.add(n.name);
  else if (n.t === 'neg') formulaRefs(n.e, out);
  else if (n.t === 'bin') { formulaRefs(n.a, out); formulaRefs(n.b, out); }
  else if (n.t === 'fn') n.args.forEach((a) => formulaRefs(a, out));
  return out;
}

export function evalFormula(n: Node, vars: Record<string, number | null | undefined>): number | null {
  const ev = (x: Node): number => {
    switch (x.t) {
      case 'num': return x.v;
      case 'ref': { const v = vars[x.name]; if (v === null || v === undefined || !Number.isFinite(v)) throw new Missing(); return v; }
      case 'neg': return -ev(x.e);
      case 'bin': {
        const a = ev(x.a); const b = ev(x.b);
        if (x.op === '/' && b === 0) throw new Missing();
        return x.op === '+' ? a + b : x.op === '-' ? a - b : x.op === '*' ? a * b : a / b;
      }
      case 'fn': {
        const args = x.args.map(ev);
        if (x.name === 'min') return Math.min(...args);
        if (x.name === 'max') return Math.max(...args);
        if (x.name === 'abs') return Math.abs(args[0]);
        const d = Math.max(0, Math.min(6, Math.trunc(args[1] ?? 0)));
        return Math.round(args[0] * 10 ** d) / 10 ** d;
      }
    }
  };
  try {
    const v = ev(n);
    return Number.isFinite(v) ? v : null;
  } catch (e) {
    if (e instanceof Missing) return null;
    throw e;
  }
}
class Missing extends Error {}
