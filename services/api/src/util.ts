import crypto from 'node:crypto';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const notFound = (what = 'Resource') => new ApiError(404, 'NOT_FOUND', `${what} not found`);
export const forbidden = (msg = 'Not allowed') => new ApiError(403, 'FORBIDDEN', msg);
export const conflict = (code: string, msg: string) => new ApiError(409, code, msg);
export const badRequest = (msg: string, code = 'VALIDATION_ERROR') => new ApiError(400, code, msg);

// Clock with an offset (used only by the demo seed to create a tender whose deadline has passed
// through the real services). Everything time-related in the services reads from here.
let clockOffsetMs = 0;
export const now = () => new Date(Date.now() + clockOffsetMs);
export function setClockOffset(ms: number) { clockOffsetMs = ms; }

export const uuid = () => crypto.randomUUID();
export const sha256Hex = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
export const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** Deterministic JSON: object keys sorted recursively, Dates as ISO strings, undefined → null. */
export function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (x === undefined || x === null) return null;
    if (x instanceof Date) return x.toISOString();
    if (Array.isArray(x)) return x.map(norm);
    if (typeof x === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x as object).sort()) out[k] = norm((x as Record<string, unknown>)[k]);
      return out;
    }
    if (typeof x === 'bigint') return x.toString();
    return x;
  };
  return JSON.stringify(norm(v));
}

const camelKey = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
/** Convert DB rows (snake_case, including jsonb contents) to API shape (camelCase). */
export function camel<T = any>(v: unknown): T {
  if (Array.isArray(v)) return v.map((x) => camel(x)) as T;
  if (v instanceof Date || v === null || typeof v !== 'object' || Buffer.isBuffer(v)) return v as T;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as object)) out[camelKey(k)] = camel(val);
  return out as T;
}

export const pick = <T extends object>(o: any, ...keys: string[]): T =>
  Object.fromEntries(keys.map((k) => [k, o?.[k]])) as T;

export function str(v: unknown, field: string, opts: { required?: boolean; max?: number } = {}): string | undefined {
  if (v === undefined || v === null || v === '') {
    if (opts.required) throw badRequest(`${field} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw badRequest(`${field} must be a string`);
  const s = v.trim();
  if (opts.required && !s) throw badRequest(`${field} is required`);
  if (opts.max && s.length > opts.max) throw badRequest(`${field} is too long (max ${opts.max})`);
  return s;
}
export const reqStr = (v: unknown, field: string, max = 2000) => str(v, field, { required: true, max }) as string;

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
