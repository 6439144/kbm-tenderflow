// Tenants, users and login.
import bcrypt from 'bcryptjs';
import type { Ctx } from '../ctx.js';
import { auditTx } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import { ROLES, unauthorized } from '../auth/tokens.js';
import { SYSTEM_ACTOR } from './audit.js';
import { ApiError, badRequest, camel, conflict, now, reqStr, uuid } from '../util.js';
import type { Queryable } from '../db.js';
import { installDefaultDocumentTypes } from './doc-catalogue.js';
import { enforceStaffNetwork, type ReqLike } from '../features/security/network.js';
import { secondStepFor, startEnrolment, confirmEnrolment, verifySecondFactor } from '../features/security/mfa.js';
import { loadSettings } from '../features/security/settings.js';

export interface UserRow {
  id: string; tenant_id: string; username: string; password_hash: string; display_name: string;
  roles: string[]; vendor_id: string | null; active: boolean; created_at: Date;
  last_login_at?: Date | null; auth_source?: string; external_subject?: string | null; disabled_at?: Date | null;
}

export const publicUser = (u: UserRow) => ({
  id: u.id, username: u.username, displayName: u.display_name, roles: u.roles, tenantId: u.tenant_id, vendorId: u.vendor_id,
  active: u.active, createdAt: u.created_at, lastLoginAt: u.last_login_at ?? null, authSource: u.auth_source ?? 'LOCAL',
});

export async function createTenant(ctx: Ctx, t: { id: string; nameEn: string; nameAr: string; primaryColor?: string }) {
  if (!/^[a-z0-9_-]{2,40}$/.test(t.id)) throw badRequest('tenant id must be 2-40 chars [a-z0-9_-]');
  return ctx.db.tx(async (q) => {
    await q.query('INSERT INTO tenants (id, name_en, name_ar, primary_color) VALUES ($1,$2,$3,$4)',
      [t.id, t.nameEn, t.nameAr, t.primaryColor ?? '#0B4F6C']);
    await installDefaultDocumentTypes(q, t.id); // document-intelligence catalogue (editable by TENANT_ADMIN)
    await auditTx(ctx, q, { tenantId: t.id, actor: SYSTEM_ACTOR, action: 'TENANT_CREATED', resourceType: 'TENANT', resourceId: t.id, newState: 'ACTIVE' });
  });
}

export function validatePassword(p: unknown): string {
  if (typeof p !== 'string' || p.length < 8) throw badRequest('password must be at least 8 characters');
  if (p.length > 200) throw badRequest('password too long');
  return p;
}

export async function insertUser(ctx: Ctx, q: Queryable, actor: { id: string; roles: string[] }, u: {
  tenantId: string; username: string; password: string; displayName: string; roles: string[]; vendorId?: string | null;
}): Promise<UserRow> {
  const username = reqStr(u.username, 'username', 80).toLowerCase();
  if (!/^[a-z0-9._@-]{3,80}$/.test(username)) throw badRequest('username must be 3-80 chars [a-z0-9._@-]');
  if (!Array.isArray(u.roles) || !u.roles.length || u.roles.some((r) => !(ROLES as readonly string[]).includes(r)))
    throw badRequest(`roles must be a non-empty subset of ${ROLES.join(', ')}`);
  const hash = await bcrypt.hash(validatePassword(u.password), 10);
  const exists = await q.query('SELECT 1 FROM users WHERE tenant_id=$1 AND username=$2', [u.tenantId, username]);
  if (exists.length) throw conflict('USERNAME_TAKEN', 'Username already exists in this tenant');
  const id = uuid();
  const rows = await q.query<UserRow>(
    `INSERT INTO users (id, tenant_id, username, password_hash, display_name, roles, vendor_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6::text[],$7,$8) RETURNING *`,
    [id, u.tenantId, username, hash, reqStr(u.displayName, 'displayName', 200), u.roles, u.vendorId ?? null, now()]);
  await auditTx(ctx, q, { tenantId: u.tenantId, actor, action: 'USER_CREATED', resourceType: 'USER', resourceId: id,
    details: { username, roles: u.roles } });
  return rows[0];
}

export async function createUser(ctx: Ctx, actor: { id: string; roles: string[] }, u: Parameters<typeof insertUser>[3]) {
  return ctx.db.tx((q) => insertUser(ctx, q, actor, u));
}

export async function adminCreateUser(ctx: Ctx, actor: Actor, body: any) {
  const roles: string[] = Array.isArray(body?.roles) ? body.roles : [];
  if (roles.includes('VENDOR')) throw badRequest('VENDOR users are created through vendor registration');
  const u = await createUser(ctx, actor, { tenantId: actor.tenantId, username: body?.username, password: body?.password,
    displayName: body?.displayName, roles });
  return publicUser(u);
}

export async function listUsers(ctx: Ctx, actor: Actor) {
  const rows = await ctx.db.query<UserRow>('SELECT * FROM users WHERE tenant_id=$1 ORDER BY username', [actor.tenantId]);
  return rows.map(publicUser);
}

// Pre-computed hash so unknown usernames take comparable time.
const DUMMY_HASH = bcrypt.hashSync('tenderflow-dummy-password', 10);

/**
 * Password sign-in. Order: password → account enabled → staff network allowlist → second factor (TOTP) when the
 * entity policy asks for it. With a second factor the response is `{ mfaRequired, mfaToken, enrolRequired }` and the
 * session token is issued only by /auth/mfa/verify or /auth/mfa/enrol/confirm.
 */
export async function login(ctx: Ctx, body: any, req?: ReqLike) {
  const tenantId = reqStr(body?.tenantId, 'tenantId', 40);
  const username = reqStr(body?.username, 'username', 80).toLowerCase();
  const password = typeof body?.password === 'string' ? body.password : '';
  const rows = await ctx.db.query<UserRow & { tenant_status: string }>(
    `SELECT u.*, t.status AS tenant_status FROM users u JOIN tenants t ON t.id = u.tenant_id
      WHERE u.tenant_id=$1 AND u.username=$2`, [tenantId, username]);
  const u = rows[0];
  const ok = await bcrypt.compare(password, u?.password_hash ?? DUMMY_HASH);
  if (u && ok && !u.active) {
    await ctx.db.tx((q) => auditTx(ctx, q, { tenantId, actor: { id: u.id, roles: u.roles }, action: 'LOGIN_REFUSED_ACCOUNT_DISABLED', resourceType: 'USER', resourceId: u.id }));
    throw new ApiError(403, 'ACCOUNT_DISABLED', 'This account is disabled. Contact your entity administrator.');
  }
  if (!u || !ok || !u.active || u.tenant_status !== 'ACTIVE') {
    if (u) await ctx.db.tx((q) => auditTx(ctx, q, { tenantId, actor: { id: u.id, roles: u.roles }, action: 'LOGIN_FAILED', resourceType: 'USER', resourceId: u.id }));
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid tenant, username or password');
  }
  if (req) await enforceStaffNetwork(ctx, req, { id: u.id, tenantId, roles: u.roles }, 'LOGIN');
  const step = await secondStepFor(ctx, u);
  if (step) {
    const mfaToken = await ctx.tokens.issueMfaPending(u, step);
    await ctx.db.tx((q) => auditTx(ctx, q, { tenantId, actor: { id: u.id, roles: u.roles }, action: 'LOGIN_PASSWORD_ACCEPTED_MFA_PENDING', resourceType: 'USER', resourceId: u.id,
      details: { step } }));
    return { mfaRequired: true, enrolRequired: step === 'enrol', mfaToken, user: { displayName: u.display_name, username: u.username } };
  }
  return completeLogin(ctx, u, 'PASSWORD');
}

/** Issue the TenderFlow session and record the sign-in. */
export async function completeLogin(ctx: Ctx, u: UserRow, method: 'PASSWORD' | 'PASSWORD+TOTP' | 'PASSWORD+RECOVERY_CODE' | 'OIDC') {
  const token = await ctx.tokens.issue(u);
  await ctx.db.tx(async (q) => {
    await q.query('UPDATE users SET last_login_at=now() WHERE id=$1', [u.id]);
    await auditTx(ctx, q, { tenantId: u.tenant_id, actor: { id: u.id, roles: u.roles }, action: 'LOGIN', resourceType: 'USER', resourceId: u.id, details: { method } });
  });
  return { token, user: publicUser(u) };
}

/** Load the user behind an MFA-pending token; refuses disabled accounts and (again) the staff network rule. */
async function pendingUser(ctx: Ctx, body: any, req: ReqLike | undefined, purpose: 'verify' | 'enrol' | 'any') {
  const p = await ctx.tokens.verifyMfaPending(body?.mfaToken);
  if (purpose !== 'any' && p.purpose !== purpose) throw new ApiError(409, 'MFA_WRONG_STEP', 'This sign-in step does not apply to your account');
  const u = (await ctx.db.query<UserRow & { tenant_status: string }>(
    'SELECT u.*, t.status AS tenant_status FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.id=$1 AND u.tenant_id=$2', [p.userId, p.tenantId]))[0];
  if (!u || !u.active || u.tenant_status !== 'ACTIVE') throw new ApiError(401, 'MFA_TOKEN_INVALID', 'Sign-in step expired; enter your password again');
  if (req) await enforceStaffNetwork(ctx, req, { id: u.id, tenantId: u.tenant_id, roles: u.roles }, 'LOGIN');
  return u;
}

export async function mfaLoginVerify(ctx: Ctx, body: any, req?: ReqLike) {
  const u = await pendingUser(ctx, body, req, 'verify');
  const r = await verifySecondFactor(ctx, u, { code: body?.code, recoveryCode: body?.recoveryCode });
  const out = await completeLogin(ctx, u, r.method === 'RECOVERY_CODE' ? 'PASSWORD+RECOVERY_CODE' : 'PASSWORD+TOTP');
  return { ...out, recoveryCodesLeft: r.recoveryCodesLeft };
}

export async function mfaLoginEnrolStart(ctx: Ctx, body: any, req?: ReqLike) {
  return startEnrolment(ctx, await pendingUser(ctx, body, req, 'enrol'));
}

export async function mfaLoginEnrolConfirm(ctx: Ctx, body: any, req?: ReqLike) {
  const u = await pendingUser(ctx, body, req, 'enrol');
  const { recoveryCodes } = await confirmEnrolment(ctx, u, body?.code);
  const out = await completeLogin(ctx, u, 'PASSWORD+TOTP');
  return { ...out, recoveryCodes };
}

export async function me(ctx: Ctx, actor: Actor) {
  if (actor.issuer === 'local') {
    const rows = await ctx.db.query<UserRow>('SELECT * FROM users WHERE id=$1 AND tenant_id=$2', [actor.id, actor.tenantId]);
    if (!rows[0]) throw unauthorized('User no longer exists');
    return publicUser(rows[0]);
  }
  return { id: actor.id, username: actor.username, displayName: actor.username, roles: actor.roles, tenantId: actor.tenantId, vendorId: actor.vendorId };
}

export async function publicTenants(ctx: Ctx) {
  const rows = camel<any[]>(await ctx.db.query(`SELECT id, name_en, name_ar, primary_color FROM tenants WHERE status='ACTIVE' ORDER BY id`));
  // Staff single sign-on button on the login page (only what the page needs: label, never issuer/client details).
  for (const t of rows) {
    const o = (await loadSettings(ctx, t.id)).oidc;
    t.sso = o?.enabled ? { labelEn: o.displayNameEn, labelAr: o.displayNameAr } : null;
  }
  return rows;
}
