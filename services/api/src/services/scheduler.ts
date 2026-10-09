// Tiny durable job runner. Features register jobs once at import / start-up:
//
//   registerJob('my-job', 60_000, async (ctx, { tenantId }) => ({ processed: 3 }), { labelEn: '…', labelAr: '…' });
//
// Each run is recorded in `scheduled_jobs` (last start / finish / status / result / error, run count). A run takes a
// lease (`locked_until`) with an atomic UPDATE, so two processes (pg) or an overlapping manual "run now" never run the
// same job twice at once; the lease expires on its own if a process dies mid-run. Timers are unref()'d and stop when
// the app's database is closed. Jobs are OFF under `node --test` unless SCHEDULER_ENABLED=true; "run now" always works.
// A job receives `tenantId` when an entity admin runs it manually: it must then only touch that entity's data.
import crypto from 'node:crypto';
import type { Ctx } from '../ctx.js';

export interface JobContext { tenantId?: string; trigger: 'SCHEDULE' | 'MANUAL' }
export type JobFn = (ctx: Ctx, opts: JobContext) => Promise<Record<string, unknown> | void>;
export interface JobDef { name: string; everyMs: number; fn: JobFn; labelEn?: string; labelAr?: string }
export interface JobRunResult { name: string; status: 'OK' | 'ERROR' | 'SKIPPED_RUNNING'; result?: Record<string, unknown> | null; error?: string; durationMs?: number }

const registry = new Map<string, JobDef>();

interface Runtime {
  ctx: Ctx; owner: string; timers: Map<string, NodeJS.Timeout>; running: Map<string, Promise<JobRunResult>>;
  rerun: Set<string>; stopped: boolean; enabled: boolean;
}
const runtimes = new Map<Ctx, Runtime>();

const LEASE_MS = 10 * 60_000;
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;

/** Register (or replace) a job. Safe to call before or after the scheduler started. */
export function registerJob(name: string, everyMs: number, fn: JobFn, meta: { labelEn?: string; labelAr?: string } = {}): void {
  if (!NAME_RE.test(name)) throw new Error(`invalid job name '${name}'`);
  if (!Number.isFinite(everyMs) || everyMs < 1000) throw new Error('everyMs must be at least 1000');
  registry.set(name, { name, everyMs, fn, ...meta });
  for (const rt of runtimes.values()) void ensureRow(rt, registry.get(name)!).then(() => arm(rt, registry.get(name)!)).catch(() => undefined);
}

export const registeredJobs = (): JobDef[] => [...registry.values()];

async function ensureRow(rt: Runtime, j: JobDef) {
  await rt.ctx.db.query(`INSERT INTO scheduled_jobs (name, every_ms, updated_at) VALUES ($1,$2,$3)
                         ON CONFLICT (name) DO UPDATE SET every_ms=EXCLUDED.every_ms, updated_at=EXCLUDED.updated_at`, [j.name, j.everyMs, new Date()]);
}

function arm(rt: Runtime, j: JobDef) {
  if (!rt.enabled || rt.stopped) return;
  const old = rt.timers.get(j.name);
  if (old) clearInterval(old);
  const t = setInterval(() => { void runJob(rt.ctx, j.name, { trigger: 'SCHEDULE' }); }, j.everyMs);
  t.unref();
  rt.timers.set(j.name, t);
  const first = setTimeout(() => { void runJob(rt.ctx, j.name, { trigger: 'SCHEDULE' }); }, Math.min(5_000, j.everyMs));
  first.unref();
}

/** Start the scheduler for an app (idempotent). Timers only when `enabled`; rows + manual runs always. */
export async function startScheduler(ctx: Ctx, opts: { enabled: boolean }): Promise<void> {
  if (runtimes.has(ctx)) return;
  const rt: Runtime = { ctx, owner: `${process.pid}-${crypto.randomUUID().slice(0, 8)}`, timers: new Map(), running: new Map(), rerun: new Set(), stopped: false, enabled: opts.enabled };
  runtimes.set(ctx, rt);
  // Stop timers and wait for running jobs before the database closes (no edits to app.ts needed).
  const close = ctx.db.close.bind(ctx.db);
  ctx.db.close = async () => { await stopScheduler(ctx); return close(); };
  for (const j of registry.values()) { await ensureRow(rt, j); arm(rt, j); }
}

export async function stopScheduler(ctx: Ctx): Promise<void> {
  const rt = runtimes.get(ctx);
  if (!rt || rt.stopped) return;
  rt.stopped = true;
  for (const t of rt.timers.values()) clearInterval(t);
  rt.timers.clear();
  await Promise.allSettled([...rt.running.values()]);
  runtimes.delete(ctx);
}

/** Ask for a run soon; if the job is running now, it runs once more right after (used to send queued e-mail promptly). */
export function requestRun(ctx: Ctx, name: string, delayMs = 250): void {
  const rt = runtimes.get(ctx);
  if (!rt || rt.stopped || !registry.has(name)) return;
  if (rt.running.has(name)) { rt.rerun.add(name); return; }
  const t = setTimeout(() => { void runJob(ctx, name, { trigger: 'SCHEDULE' }); }, delayMs);
  t.unref();
}

/** Run one job now (lease-guarded). Never throws for job errors: they are recorded and returned. */
export async function runJob(ctx: Ctx, name: string, opts: JobContext): Promise<JobRunResult> {
  const j = registry.get(name);
  if (!j) throw new Error(`unknown job '${name}'`);
  const rt = runtimes.get(ctx);
  if (rt?.stopped) return { name, status: 'SKIPPED_RUNNING', error: 'scheduler stopped' };
  const owner = rt?.owner ?? `${process.pid}-adhoc`;
  if (rt?.running.has(name)) return { name, status: 'SKIPPED_RUNNING' };
  const p = (async (): Promise<JobRunResult> => {
    const started = new Date();
    await ctx.db.query('INSERT INTO scheduled_jobs (name, every_ms) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING', [name, j.everyMs]);
    const got = await ctx.db.query(
      `UPDATE scheduled_jobs SET locked_until=$2, locked_by=$3, last_started_at=$4, updated_at=$4
        WHERE name=$1 AND (locked_until IS NULL OR locked_until < $4) RETURNING name`,
      [name, new Date(started.getTime() + Math.max(LEASE_MS, j.everyMs * 2)), owner, started]);
    if (!got.length) return { name, status: 'SKIPPED_RUNNING' as const };
    return finish(started);
  })();
  async function finish(started: Date): Promise<JobRunResult> {
    let out: JobRunResult;
    try {
      const result = (await j!.fn(ctx, opts)) ?? null;
      out = { name, status: 'OK', result, durationMs: Date.now() - started.getTime() };
    } catch (err) {
      out = { name, status: 'ERROR', error: (err as Error)?.message ?? String(err), durationMs: Date.now() - started.getTime() };
    }
    try {
      await ctx.db.query(
        `UPDATE scheduled_jobs SET locked_until=NULL, locked_by=NULL, last_finished_at=$2, last_status=$3, last_result=$4::jsonb, last_error=$5,
                run_count=run_count+1, updated_at=$2 WHERE name=$1 AND locked_by=$6`,
        [name, new Date(), out.status, JSON.stringify({ ...(out.result ?? {}), trigger: opts.trigger, scope: opts.tenantId ? 'ENTITY' : 'ALL', ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) }),
          out.error?.slice(0, 2000) ?? null, owner]);
    } catch (err) {
      if (!rt?.stopped) console.error(`[scheduler] ${name}: could not record the run:`, (err as Error).message);
    }
    if (out.status === 'ERROR' && !rt?.stopped) console.error(`[scheduler] ${name} failed:`, out.error);
    return out;
  }
  rt?.running.set(name, p);
  try {
    return await p;
  } catch (err) {
    // database unavailable (e.g. closed during shutdown)
    return { name, status: 'ERROR', error: (err as Error)?.message ?? String(err) };
  } finally {
    rt?.running.delete(name);
    if (rt && rt.rerun.delete(name) && !rt.stopped) requestRun(ctx, name, 50);
  }
}

/** Jobs with their last run. `viewerTenantId`: the result of another entity's manual run is not shown (only its time). */
export async function listJobs(ctx: Ctx, viewerTenantId?: string) {
  const rows = await ctx.db.query<any>('SELECT * FROM scheduled_jobs ORDER BY name');
  const rt = runtimes.get(ctx);
  return [...registry.values()].map((j) => {
    const r = rows.find((x) => x.name === j.name);
    const res = r?.last_result as Record<string, unknown> | null | undefined;
    const foreign = Boolean(viewerTenantId && res?.tenantId && res.tenantId !== viewerTenantId);
    const lastResult = res ? (foreign ? { trigger: res.trigger, scope: 'OTHER_ENTITY' } : Object.fromEntries(Object.entries(res).filter(([k]) => k !== 'tenantId'))) : null;
    return {
      name: j.name, labelEn: j.labelEn ?? j.name, labelAr: j.labelAr ?? j.name, everyMs: j.everyMs,
      scheduled: Boolean(rt?.enabled && !rt.stopped), running: Boolean(rt?.running.has(j.name)) || Boolean(r?.locked_until && new Date(r.locked_until) > new Date()),
      lastStartedAt: r?.last_started_at ?? null, lastFinishedAt: r?.last_finished_at ?? null, lastStatus: r?.last_status ?? null,
      lastResult, lastError: foreign ? null : r?.last_error ?? null, runCount: r?.run_count ?? 0,
    };
  });
}
