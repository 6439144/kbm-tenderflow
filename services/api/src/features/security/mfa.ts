// TOTP second factor: enrolment (scan → confirm with a code → 8 one-time recovery codes shown once), sign-in step 2,
// recovery-code use (burned), self-service disable (only when the policy is not REQUIRED), admin reset.
// Attempts are limited: 5 wrong codes lock the second factor for 5 minutes. Every outcome is audited.
import QRCode from 'qrcode';
import type { Ctx } from '../../ctx.js';
import { auditTx, STAFF_ROLES } from '../../ctx.js';
import type { Queryable } from '../../db.js';
import { ApiError, conflict, now } from '../../util.js';
import {
  decryptSecret, encryptSecret, hashRecoveryCode, matchRecoveryCode, mfaKey, newRecoveryCodes, newTotpSecret,
  otpauthUri, base32Encode, verifyTotp,
} from '../../auth/totp.js';
import { loadSettings, type MfaPolicy } from './settings.js';

export const MAX_FAILED = 5;
export const LOCK_MINUTES = 5;

export interface MfaRow {
  user_id: string; tenant_id: string; status: 'PENDING' | 'ACTIVE'; secret_enc: string; recovery_hashes: string[];
  last_used_step: string | number | null; failed_attempts: number; locked_until: Date | null; enrolled_at: Date | null;
}
interface UserLite { id: string; tenant_id: string; username: string; roles: string[] }

const keyOf = (ctx: Ctx) => mfaKey(ctx.config.mfaEncKey, ctx.config.auditSigningKey);
const aad = (u: { id: string; tenant_id: string }) => `mfa:${u.tenant_id}:${u.id}`;
const isVendorRoles = (roles: string[]) => roles.includes('VENDOR') && !roles.some((r) => STAFF_ROLES.includes(r));

export async function policyFor(ctx: Ctx, tenantId: string, roles: string[]): Promise<MfaPolicy> {
  const s = await loadSettings(ctx, tenantId);
  return isVendorRoles(roles) ? s.mfaVendors : s.mfaStaff;
}

export async function loadMfa(q: Queryable, userId: string): Promise<MfaRow | null> {
  return (await q.query<MfaRow>('SELECT * FROM user_mfa WHERE user_id=$1', [userId]))[0] ?? null;
}

/** null → no second step; 'verify' → enrolled, ask for a code; 'enrol' → policy REQUIRED and not enrolled yet. */
export async function secondStepFor(ctx: Ctx, u: UserLite): Promise<'verify' | 'enrol' | null> {
  const policy = await policyFor(ctx, u.tenant_id, u.roles);
  if (policy === 'OFF') return null;
  const m = await loadMfa(ctx.db, u.id);
  if (m?.status === 'ACTIVE') return 'verify';
  return policy === 'REQUIRED' ? 'enrol' : null;
}

export async function mfaStatus(ctx: Ctx, u: UserLite) {
  const policy = await policyFor(ctx, u.tenant_id, u.roles);
  const m = await loadMfa(ctx.db, u.id);
  return {
    policy,
    status: m?.status === 'ACTIVE' ? 'ACTIVE' : m?.status === 'PENDING' ? 'PENDING' : 'NOT_ENROLLED',
    enrolledAt: m?.status === 'ACTIVE' ? m.enrolled_at : null,
    recoveryCodesLeft: m?.status === 'ACTIVE' ? m.recovery_hashes.length : 0,
    lockedUntil: m?.locked_until && new Date(m.locked_until) > now() ? m.locked_until : null,
  };
}

export async function startEnrolment(ctx: Ctx, u: UserLite) {
  const policy = await policyFor(ctx, u.tenant_id, u.roles);
  if (policy === 'OFF') throw conflict('MFA_NOT_ENABLED', 'Two-step verification is switched off for your account type in this entity');
  const existing = await loadMfa(ctx.db, u.id);
  if (existing?.status === 'ACTIVE') throw conflict('MFA_ALREADY_ENROLLED', 'Two-step verification is already set up; ask an administrator to reset it');
  const tenant = (await ctx.db.query<{ name_en: string }>('SELECT name_en FROM tenants WHERE id=$1', [u.tenant_id]))[0];
  const secret = newTotpSecret();
  const enc = encryptSecret(keyOf(ctx), secret, aad(u));
  await ctx.db.tx(async (q) => {
    await q.query(
      `INSERT INTO user_mfa (user_id, tenant_id, status, secret_enc, recovery_hashes, failed_attempts, created_at)
       VALUES ($1,$2,'PENDING',$3,'{}',0,now())
       ON CONFLICT (user_id) DO UPDATE SET status='PENDING', secret_enc=EXCLUDED.secret_enc, recovery_hashes='{}', last_used_step=NULL,
         failed_attempts=0, locked_until=NULL, enrolled_at=NULL, created_at=now()`, [u.id, u.tenant_id, enc]);
    await auditTx(ctx, q, { tenantId: u.tenant_id, actor: { id: u.id, roles: u.roles }, action: 'MFA_ENROLMENT_STARTED', resourceType: 'USER', resourceId: u.id });
  });
  const issuer = `TenderFlow ${tenant?.name_en ?? u.tenant_id}`.replace(/[:]/g, ' ').slice(0, 60);
  const uri = otpauthUri({ secret, issuer, account: `${u.username}@${u.tenant_id}` });
  return {
    otpauthUri: uri,
    manualKey: base32Encode(secret).replace(/(.{4})/g, '$1 ').trim(),
    qrDataUrl: await QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 220 }),
    algorithm: 'SHA1', digits: 6, periodSeconds: 30,
  };
}

async function recordFailure(ctx: Ctx, q: Queryable, u: UserLite, m: MfaRow, kind: string) {
  const failed = m.failed_attempts + 1;
  const lock = failed >= MAX_FAILED;
  await q.query('UPDATE user_mfa SET failed_attempts=$2, locked_until=$3 WHERE user_id=$1',
    [u.id, lock ? 0 : failed, lock ? new Date(now().getTime() + LOCK_MINUTES * 60_000) : m.locked_until]);
  await auditTx(ctx, q, { tenantId: u.tenant_id, actor: { id: u.id, roles: u.roles }, action: 'MFA_VERIFICATION_FAILED', resourceType: 'USER', resourceId: u.id,
    details: { kind, attempt: failed, locked: lock, lockMinutes: lock ? LOCK_MINUTES : undefined } });
  return lock;
}

const lockedError = (until: Date) => new ApiError(429, 'MFA_LOCKED', `Too many wrong codes. Try again after ${until.toISOString()}`, { lockedUntil: until });

export async function confirmEnrolment(ctx: Ctx, u: UserLite, code: unknown) {
  const out = await ctx.db.tx(async (q) => {
    const m = await loadMfa(q, u.id);
    if (!m || m.status !== 'PENDING') throw conflict('MFA_NO_PENDING_ENROLMENT', 'Start the set-up again (scan a new code)');
    if (m.locked_until && new Date(m.locked_until) > now()) throw lockedError(new Date(m.locked_until));
    const secret = decryptSecret(keyOf(ctx), m.secret_enc, aad(u));
    const step = verifyTotp(secret, String(code ?? ''), now().getTime() / 1000);
    if (step === null) {
      const locked = await recordFailure(ctx, q, u, m, 'ENROLMENT_CODE');
      return { ok: false as const, locked };
    }
    const codes = newRecoveryCodes(8);
    await q.query(`UPDATE user_mfa SET status='ACTIVE', recovery_hashes=$2::text[], last_used_step=$3, failed_attempts=0, locked_until=NULL, enrolled_at=now() WHERE user_id=$1`,
      [u.id, codes.map(hashRecoveryCode), step]);
    await auditTx(ctx, q, { tenantId: u.tenant_id, actor: { id: u.id, roles: u.roles }, action: 'MFA_ENROLLED', resourceType: 'USER', resourceId: u.id,
      details: { method: 'TOTP', recoveryCodesIssued: codes.length } });
    return { ok: true as const, recoveryCodes: codes };
  });
  if (!out.ok) throw new ApiError(400, 'MFA_CODE_INVALID', out.locked ? 'Wrong code. Too many attempts — wait 5 minutes.' : 'Wrong code. Check the time on your phone and try the current code.');
  return { recoveryCodes: out.recoveryCodes };
}

/** Second sign-in step: a current TOTP code (replay of an already-used step refused) or a recovery code (burned). */
export async function verifySecondFactor(ctx: Ctx, u: UserLite, body: { code?: unknown; recoveryCode?: unknown }) {
  const out = await ctx.db.tx(async (q) => {
    const m = await loadMfa(q, u.id);
    if (!m || m.status !== 'ACTIVE') throw conflict('MFA_NOT_ENROLLED', 'Two-step verification is not set up for this account');
    if (m.locked_until && new Date(m.locked_until) > now()) throw lockedError(new Date(m.locked_until));
    if (typeof body.recoveryCode === 'string' && body.recoveryCode.trim()) {
      const idx = matchRecoveryCode(body.recoveryCode, m.recovery_hashes);
      if (idx < 0) return { ok: false as const, locked: await recordFailure(ctx, q, u, m, 'RECOVERY_CODE') };
      const left = m.recovery_hashes.filter((_, i) => i !== idx);
      await q.query('UPDATE user_mfa SET recovery_hashes=$2::text[], failed_attempts=0, locked_until=NULL WHERE user_id=$1', [u.id, left]);
      await auditTx(ctx, q, { tenantId: u.tenant_id, actor: { id: u.id, roles: u.roles }, action: 'MFA_RECOVERY_CODE_USED', resourceType: 'USER', resourceId: u.id,
        details: { recoveryCodesLeft: left.length } });
      return { ok: true as const, method: 'RECOVERY_CODE', recoveryCodesLeft: left.length };
    }
    const secret = decryptSecret(keyOf(ctx), m.secret_enc, aad(u));
    const last = m.last_used_step === null ? null : Number(m.last_used_step);
    const step = verifyTotp(secret, String(body.code ?? ''), now().getTime() / 1000, last);
    if (step === null) return { ok: false as const, locked: await recordFailure(ctx, q, u, m, 'TOTP') };
    await q.query('UPDATE user_mfa SET last_used_step=$2, failed_attempts=0, locked_until=NULL WHERE user_id=$1', [u.id, step]);
    return { ok: true as const, method: 'TOTP', recoveryCodesLeft: m.recovery_hashes.length };
  });
  if (!out.ok) throw new ApiError(401, 'MFA_CODE_INVALID', out.locked ? 'Wrong code. Too many attempts — wait 5 minutes.' : 'Wrong or already used code');
  return out;
}

export async function disableOwn(ctx: Ctx, u: UserLite, code: unknown) {
  const policy = await policyFor(ctx, u.tenant_id, u.roles);
  if (policy === 'REQUIRED') throw conflict('MFA_REQUIRED_BY_POLICY', 'Your entity requires two-step verification; it cannot be switched off');
  await verifySecondFactor(ctx, u, { code });
  await ctx.db.tx(async (q) => {
    await q.query('DELETE FROM user_mfa WHERE user_id=$1', [u.id]);
    await auditTx(ctx, q, { tenantId: u.tenant_id, actor: { id: u.id, roles: u.roles }, action: 'MFA_DISABLED_BY_USER', resourceType: 'USER', resourceId: u.id });
  });
  return { status: 'NOT_ENROLLED' };
}

export async function adminResetMfa(ctx: Ctx, admin: { id: string; roles: string[]; tenantId: string }, userId: string, reason: string) {
  return ctx.db.tx(async (q) => {
    const u = (await q.query<{ id: string; username: string }>('SELECT id, username FROM users WHERE id=$1 AND tenant_id=$2', [userId, admin.tenantId]))[0];
    if (!u) throw new ApiError(404, 'NOT_FOUND', 'User not found');
    const m = await loadMfa(q, userId);
    await q.query('DELETE FROM user_mfa WHERE user_id=$1', [userId]);
    await auditTx(ctx, q, { tenantId: admin.tenantId, actor: admin, action: 'MFA_RESET_BY_ADMIN', resourceType: 'USER', resourceId: userId,
      prevState: m?.status ?? 'NOT_ENROLLED', newState: 'NOT_ENROLLED', reason, details: { username: u.username } });
    return { userId, status: 'NOT_ENROLLED' };
  });
}
