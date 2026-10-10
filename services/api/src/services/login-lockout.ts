// Sign-in lockout (HARDEN): N failed password or second-factor attempts within a window lock the sign-in name for
// M minutes (LOGIN_LOCKOUT_ATTEMPTS=5, LOGIN_LOCKOUT_WINDOW_MIN=15, LOGIN_LOCKOUT_MINUTES=15; attempts 0 = off).
//
// No user enumeration: the counter is keyed by (entity, typed username), not by user id, so an unknown username is
// counted, locked and answered exactly like a real one — 423 ACCOUNT_LOCKED with the minutes remaining, checked before
// the password is looked at. The per-IP rate limiter on the sign-in routes stays in front of this.
// Every lock is audited (LOGIN_LOCKED); an administrator can unlock a user (LOGIN_UNLOCKED_BY_ADMIN), which also
// clears the second-factor lock.
import type { Ctx } from '../ctx.js';
import { auditTx } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import type { Queryable } from '../db.js';
import { ApiError, isUuid, notFound, now, str } from '../util.js';
import { SYSTEM_ACTOR } from './audit.js';

interface LockRow {
  tenant_id: string; username: string; failures: number; window_started_at: Date | null; last_failure_at: Date | null;
  locked_until: Date | null; lock_count: number;
}

export type FailureKind = 'PASSWORD' | 'MFA';

const norm = (username: string) => String(username ?? '').trim().toLowerCase().slice(0, 80);
const enabled = (ctx: Ctx) => ctx.config.loginLockout.attempts > 0;

export function lockedError(until: Date): ApiError {
  const ms = Math.max(0, until.getTime() - now().getTime());
  const minutesRemaining = Math.max(1, Math.ceil(ms / 60_000));
  return new ApiError(423, 'ACCOUNT_LOCKED',
    `Too many failed sign-in attempts. Sign-in is locked for ${minutesRemaining} more minute${minutesRemaining === 1 ? '' : 's'}; try again later or ask your entity administrator to unlock the account.`,
    { minutesRemaining, retryAfterSeconds: Math.max(1, Math.ceil(ms / 1000)) });
}

/** Throws 423 ACCOUNT_LOCKED when the sign-in name is locked (whether or not such a user exists). */
export async function assertNotLocked(ctx: Ctx, tenantId: string, username: string): Promise<void> {
  if (!enabled(ctx)) return;
  const r = (await ctx.db.query<{ locked_until: Date | null }>('SELECT locked_until FROM login_lockouts WHERE tenant_id=$1 AND username=$2',
    [tenantId, norm(username)]))[0];
  if (r?.locked_until && new Date(r.locked_until) > now()) throw lockedError(new Date(r.locked_until));
}

let lastSweep = 0;

/**
 * Count one failed attempt. Returns the lock expiry when this attempt locked the name (the caller then answers
 * 423 instead of the normal failure), otherwise null.
 */
export async function recordLoginFailure(ctx: Ctx, tenantId: string, username: string, kind: FailureKind,
  who?: { id: string; roles: string[] } | null, ip?: string | null): Promise<Date | null> {
  if (!enabled(ctx)) return null;
  const name = norm(username);
  if (!name) return null;
  const { attempts, windowMinutes, lockMinutes } = ctx.config.loginLockout;
  const t = now();
  const lockedUntil = await ctx.db.tx(async (q) => {
    await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`login-lock:${tenantId}:${name}`]);
    const cur = (await q.query<LockRow>('SELECT * FROM login_lockouts WHERE tenant_id=$1 AND username=$2', [tenantId, name]))[0];
    if (cur?.locked_until && new Date(cur.locked_until) > t) return new Date(cur.locked_until); // raced with a lock
    const inWindow = cur?.window_started_at && new Date(cur.window_started_at).getTime() + windowMinutes * 60_000 > t.getTime();
    const failures = inWindow ? cur!.failures + 1 : 1;
    const windowStart = inWindow ? new Date(cur!.window_started_at!) : t;
    if (failures < attempts) {
      await q.query(
        `INSERT INTO login_lockouts (tenant_id, username, failures, window_started_at, last_failure_at, locked_until)
         VALUES ($1,$2,$3,$4,$5,NULL)
         ON CONFLICT (tenant_id, username) DO UPDATE SET failures=EXCLUDED.failures, window_started_at=EXCLUDED.window_started_at,
           last_failure_at=EXCLUDED.last_failure_at, locked_until=NULL`, [tenantId, name, failures, windowStart, t]);
      return null;
    }
    const until = new Date(t.getTime() + lockMinutes * 60_000);
    // The counter restarts after a lock: once it expires the user gets the full number of attempts again.
    await q.query(
      `INSERT INTO login_lockouts (tenant_id, username, failures, window_started_at, last_failure_at, locked_until, lock_count)
       VALUES ($1,$2,0,NULL,$3,$4,1)
       ON CONFLICT (tenant_id, username) DO UPDATE SET failures=0, window_started_at=NULL, last_failure_at=EXCLUDED.last_failure_at,
         locked_until=EXCLUDED.locked_until, lock_count=login_lockouts.lock_count+1`, [tenantId, name, t, until]);
    const tenant = (await q.query('SELECT 1 FROM tenants WHERE id=$1', [tenantId]))[0];
    if (tenant) {
      await auditTx(ctx, q, { tenantId, actor: SYSTEM_ACTOR, action: 'LOGIN_LOCKED',
        resourceType: who ? 'USER' : 'SIGN_IN_NAME', resourceId: who?.id ?? null, newState: 'LOCKED',
        details: { username: name, knownUser: !!who, failures, windowMinutes, lockMinutes, lockedUntil: until.toISOString(), lastAttempt: kind, ip: ip ?? null } });
    }
    return until;
  });
  // Opportunistic clean-up of stale counters (at most once an hour per process).
  if (Date.now() - lastSweep > 3_600_000) {
    lastSweep = Date.now();
    await ctx.db.query(`DELETE FROM login_lockouts WHERE (locked_until IS NULL OR locked_until < $1) AND (last_failure_at IS NULL OR last_failure_at < $1)`,
      [new Date(t.getTime() - 24 * 3_600_000)]).catch(() => undefined);
  }
  return lockedUntil;
}

/** A completed sign-in clears the counter for that name. */
export async function clearLoginFailures(q: Queryable, tenantId: string, username: string): Promise<void> {
  await q.query('DELETE FROM login_lockouts WHERE tenant_id=$1 AND username=$2', [tenantId, norm(username)]);
}

/** username → lock state, for the admin users page. Only names that are currently locked or have failures. */
export async function lockStates(ctx: Ctx, tenantId: string): Promise<Map<string, { lockedUntil: Date | null; failures: number }>> {
  const rows = await ctx.db.query<LockRow>('SELECT * FROM login_lockouts WHERE tenant_id=$1', [tenantId]);
  const t = now();
  const { windowMinutes } = ctx.config.loginLockout;
  const out = new Map<string, { lockedUntil: Date | null; failures: number }>();
  for (const r of rows) {
    const locked = r.locked_until && new Date(r.locked_until) > t ? new Date(r.locked_until) : null;
    const live = r.window_started_at && new Date(r.window_started_at).getTime() + windowMinutes * 60_000 > t.getTime() ? r.failures : 0;
    if (locked || live) out.set(r.username, { lockedUntil: locked, failures: live });
  }
  return out;
}

/** POST /admin/users/:id/unlock — clears the sign-in lockout and the second-factor lock of one user (audited). */
export async function adminUnlockUser(ctx: Ctx, admin: Actor, userId: string, body: any) {
  if (!isUuid(userId)) throw notFound('User');
  const reason = str(body?.reason, 'reason', { max: 500 }) ?? null;
  return ctx.db.tx(async (q) => {
    const u = (await q.query<{ id: string; username: string }>('SELECT id, username FROM users WHERE id=$1 AND tenant_id=$2', [userId, admin.tenantId]))[0];
    if (!u) throw notFound('User');
    const t = now();
    const lock = (await q.query<LockRow>('SELECT * FROM login_lockouts WHERE tenant_id=$1 AND username=$2', [admin.tenantId, u.username]))[0];
    const mfa = (await q.query<{ locked_until: Date | null; failed_attempts: number }>('SELECT locked_until, failed_attempts FROM user_mfa WHERE user_id=$1', [u.id]))[0];
    const wasLocked = !!(lock?.locked_until && new Date(lock.locked_until) > t);
    const mfaWasLocked = !!(mfa?.locked_until && new Date(mfa.locked_until) > t);
    await q.query('DELETE FROM login_lockouts WHERE tenant_id=$1 AND username=$2', [admin.tenantId, u.username]);
    if (mfa) await q.query('UPDATE user_mfa SET failed_attempts=0, locked_until=NULL WHERE user_id=$1', [u.id]);
    await auditTx(ctx, q, { tenantId: admin.tenantId, actor: admin, action: 'LOGIN_UNLOCKED_BY_ADMIN', resourceType: 'USER', resourceId: u.id,
      prevState: wasLocked || mfaWasLocked ? 'LOCKED' : 'NOT_LOCKED', newState: 'NOT_LOCKED', reason,
      details: { username: u.username, signInLocked: wasLocked, secondFactorLocked: mfaWasLocked, failuresCleared: lock?.failures ?? 0 } });
    return { userId: u.id, username: u.username, wasLocked, secondFactorWasLocked: mfaWasLocked, locked: false };
  });
}
