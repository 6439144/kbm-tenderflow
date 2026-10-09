import path from 'node:path';
import type { ContentStore, TelemetryEntry } from './types.js';
import { FilesystemStore } from './filesystem-store.js';
import { FileNetStore } from './filenet-store.js';

export type { ContentStore } from './types.js';

/** Creates the configured content store, wrapped with operation telemetry. */
export function createContentStore(opts: { type?: string; dataDir: string }): ContentStore {
  const type = (opts.type ?? process.env.CONTENT_STORE_TYPE ?? 'filesystem').toLowerCase();
  if (type === 'filenet') return withTelemetry(new FileNetStore());
  if (type === 'filesystem') return withTelemetry(new FilesystemStore(path.join(opts.dataDir, 'content')));
  throw new Error(`Unknown CONTENT_STORE_TYPE '${type}' (expected 'filesystem' or 'filenet')`);
}

export const TELEMETRY_CAPACITY = 100;

/** Fixed-size ring buffer of content-store operations. Holds no file contents and no credentials. */
export class ContentTelemetry {
  private readonly buf: TelemetryEntry[] = [];
  constructor(readonly capacity = TELEMETRY_CAPACITY) {}
  record(e: TelemetryEntry): void {
    this.buf.push(e);
    if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
  }
  /** Newest first. */
  recent(limit = this.capacity): TelemetryEntry[] {
    return this.buf.slice(-Math.max(0, Math.min(limit, this.capacity))).reverse().map((e) => ({ ...e }));
  }
}

const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 500);

/**
 * Wraps a store so that every put / get / describe / declareRecord is recorded (op, ok, ms, at, ref, error).
 * Optional methods stay optional: the wrapper exposes them only when the wrapped store has them.
 */
export function withTelemetry(inner: ContentStore, telemetry = new ContentTelemetry()): ContentStore {
  if (inner.unwrap) return inner; // already wrapped
  const timed = async <T>(op: TelemetryEntry['op'], ref: string | null, folder: string | null, fn: () => Promise<T>, refOf?: (r: T) => string | null, okOf?: (r: T) => { ok: boolean; error?: string }): Promise<T> => {
    const t0 = performance.now();
    const at = new Date().toISOString();
    try {
      const r = await fn();
      const status = okOf ? okOf(r) : { ok: true };
      telemetry.record({ op, ok: status.ok, ms: Math.round(performance.now() - t0), at, ref: refOf ? refOf(r) : ref, folder, ...(status.error ? { error: status.error } : {}) });
      return r;
    } catch (e) {
      telemetry.record({ op, ok: false, ms: Math.round(performance.now() - t0), at, ref, folder, error: errText(e) });
      throw e;
    }
  };
  const wrapped: ContentStore = {
    type: inner.type,
    ping: () => inner.ping(),
    put: (input) => timed('put', input.supersedesRef ?? null, input.folderPath, () => inner.put(input), (r) => r.storeRef),
    get: (ref) => timed('get', ref, null, () => inner.get(ref)),
    telemetry: (limit?: number) => telemetry.recent(limit),
    unwrap: () => inner,
  };
  if (inner.describe) wrapped.describe = (ref) => timed('describe', ref, null, () => inner.describe!(ref));
  if (inner.declareRecord) {
    wrapped.declareRecord = (ref, info) => timed('declareRecord', ref, null, () => inner.declareRecord!(ref, info), undefined,
      (r) => (r.ok ? { ok: true } : { ok: false, error: r.detail.slice(0, 500) }));
  }
  if (inner.setProperties) {
    wrapped.setProperties = (ref, props) => timed('setProperties', ref, null, () => inner.setProperties!(ref, props), undefined,
      (r) => (r.ok ? { ok: true } : { ok: false, error: r.detail.slice(0, 500) }));
  }
  if (inner.folderTree) wrapped.folderTree = (p, d) => inner.folderTree!(p, d);
  return wrapped;
}
