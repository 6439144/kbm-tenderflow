// Account administration (MOI FR-035 create/amend/enable/disable accounts for entity and vendor users; FR-036 define
// and assign roles). Creation of staff users stays in identity.adminCreateUser; vendor users come from registration.
// Guards: an administrator cannot disable themself or remove their own administrator role, and the entity always
// keeps at least one active administrator. Vendor users keep exactly the VENDOR role; staff users never get it.
import bcrypt from 'bcryptjs';
import type { Ctx } from '../../ctx.js';
import { auditTx, STAFF_ROLES } from '../../ctx.js';
import type { Actor } from '../../auth/tokens.js';
import { ROLES } from '../../auth/tokens.js';
import type { Queryable } from '../../db.js';
import { badRequest, conflict, isUuid, notFound, reqStr, str } from '../../util.js';
import { publicUser, validatePassword, type UserRow } from '../../services/identity.js';

/** Role catalogue (FR-036): the fixed TenderFlow roles with what each may do. Roles are enforced on the server. */
export const ROLE_CATALOGUE = [
  { role: 'PROCUREMENT_OFFICER', kind: 'STAFF', en: 'Creates tenders, reviews vendors, answers clarifications, publishes', ar: 'ينشئ المناقصات ويراجع الموردين ويجيب على الاستفسارات وينشر' },
  { role: 'DIRECTOR', kind: 'STAFF', en: 'Approves requests, tenders and awards (per cycle template)', ar: 'يعتمد الطلبات والمناقصات والترسية (حسب نموذج الدورة)' },
  { role: 'UNDERSECRETARY', kind: 'STAFF', en: 'Second approval level where the template requires it', ar: 'مستوى الاعتماد الثاني حيث يتطلبه النموذج' },
  { role: 'COMMITTEE_CHAIR', kind: 'STAFF', en: 'Opens bids after the deadline, recommends award', ar: 'يفتح العطاءات بعد الموعد النهائي ويوصي بالترسية' },
  { role: 'EVALUATOR', kind: 'STAFF', en: 'Scores opened bids', ar: 'يقيّم العطاءات المفتوحة' },
  { role: 'TENANT_ADMIN', kind: 'STAFF', en: 'Users, roles, security, cycle templates, entity settings', ar: 'المستخدمون والأدوار والأمان ونماذج الدورة وإعدادات الجهة' },
  { role: 'AUDITOR', kind: 'STAFF', en: 'Reads the audit log and verifies its integrity', ar: 'يطّلع على سجل التدقيق ويتحقق من سلامته' },
  { role: 'VENDOR', kind: 'VENDOR', en: 'Supplier user (assigned through vendor registration only)', ar: 'مستخدم المورد (يُمنح عبر تسجيل المورد فقط)' },
];

async function loadUser(q: Queryable, tenantId: string, id: string): Promise<UserRow> {
  if (!isUuid(id)) throw notFound('User');
  const u = (await q.query<UserRow>('SELECT * FROM users WHERE id=$1 AND tenant_id=$2', [id, tenantId]))[0];
  if (!u) throw notFound('User');
  return u;
}

async function activeAdmins(q: Queryable, tenantId: string, exceptId: string) {
  const r = await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM users WHERE tenant_id=$1 AND active AND 'TENANT_ADMIN' = ANY(roles) AND id <> $2`, [tenantId, exceptId]);
  return Number(r[0].n);
}

export async function listAccounts(ctx: Ctx, actor: Actor, filter: { kind?: unknown; q?: unknown } = {}) {
  const rows = await ctx.db.query<UserRow & { legal_name_en: string | null; legal_name_ar: string | null; vendor_status: string | null; mfa_status: string | null; mfa_locked_until: Date | null }>(
    `SELECT u.*, v.legal_name_en, v.legal_name_ar, v.status AS vendor_status, m.status AS mfa_status, m.locked_until AS mfa_locked_until
       FROM users u LEFT JOIN vendors v ON v.id = u.vendor_id LEFT JOIN user_mfa m ON m.user_id = u.id
      WHERE u.tenant_id=$1 ORDER BY (u.vendor_id IS NOT NULL), u.username`, [actor.tenantId]);
  const q = typeof filter.q === 'string' ? filter.q.trim().toLowerCase() : '';
  return rows
    .filter((u) => (filter.kind === 'VENDOR' ? !!u.vendor_id : filter.kind === 'STAFF' ? !u.vendor_id : true))
    .filter((u) => !q || u.username.includes(q) || u.display_name.toLowerCase().includes(q) || (u.legal_name_en ?? '').toLowerCase().includes(q))
    .map((u) => ({
      ...publicUser(u),
      kind: u.vendor_id ? 'VENDOR' : 'STAFF',
      vendor: u.vendor_id ? { id: u.vendor_id, legalNameEn: u.legal_name_en, legalNameAr: u.legal_name_ar, status: u.vendor_status } : null,
      mfa: u.mfa_status === 'ACTIVE' ? 'ACTIVE' : u.mfa_status === 'PENDING' ? 'PENDING' : 'NOT_ENROLLED',
      mfaLocked: !!(u.mfa_locked_until && new Date(u.mfa_locked_until) > new Date()),
      disabledAt: u.disabled_at ?? null,
      isSelf: u.id === actor.id,
    }));
}

export async function setActive(ctx: Ctx, actor: Actor, id: string, active: boolean, body: any) {
  const reason = reqStr(body?.reason, 'reason', 500);
  return ctx.db.tx(async (q) => {
    const u = await loadUser(q, actor.tenantId, id);
    if (!active && u.id === actor.id) throw conflict('CANNOT_DISABLE_SELF', 'You cannot disable your own account');
    if (!active && u.roles.includes('TENANT_ADMIN') && (await activeAdmins(q, actor.tenantId, u.id)) === 0)
      throw conflict('LAST_ADMIN', 'The entity must keep at least one active administrator');
    if (u.active === active) throw conflict('NO_CHANGE', active ? 'The account is already enabled' : 'The account is already disabled');
    const rows = await q.query<UserRow>('UPDATE users SET active=$2, disabled_at=$3 WHERE id=$1 RETURNING *', [u.id, active, active ? null : new Date()]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: active ? 'USER_ENABLED' : 'USER_DISABLED', resourceType: 'USER', resourceId: u.id,
      prevState: u.active ? 'ACTIVE' : 'DISABLED', newState: active ? 'ACTIVE' : 'DISABLED', reason, details: { username: u.username, vendorId: u.vendor_id } });
    return publicUser(rows[0]);
  });
}

export async function setRoles(ctx: Ctx, actor: Actor, id: string, body: any) {
  const roles: string[] = Array.isArray(body?.roles) ? [...new Set(body.roles as string[])] : [];
  const reason = str(body?.reason, 'reason', { max: 500 }) ?? null;
  if (!roles.length || roles.some((r) => !(ROLES as readonly string[]).includes(r))) throw badRequest(`roles must be a non-empty subset of ${ROLES.join(', ')}`);
  return ctx.db.tx(async (q) => {
    const u = await loadUser(q, actor.tenantId, id);
    if (u.vendor_id) {
      if (roles.length !== 1 || roles[0] !== 'VENDOR') throw conflict('VENDOR_ROLES_FIXED', 'Vendor users always have exactly the VENDOR role');
    } else if (roles.includes('VENDOR')) throw conflict('VENDOR_ROLE_STAFF', 'The VENDOR role is assigned through vendor registration only');
    if (u.id === actor.id && u.roles.includes('TENANT_ADMIN') && !roles.includes('TENANT_ADMIN'))
      throw conflict('CANNOT_REMOVE_OWN_ADMIN', 'You cannot remove your own administrator role');
    if (u.roles.includes('TENANT_ADMIN') && !roles.includes('TENANT_ADMIN') && u.active && (await activeAdmins(q, actor.tenantId, u.id)) === 0)
      throw conflict('LAST_ADMIN', 'The entity must keep at least one active administrator');
    const before = [...u.roles].sort();
    const after = [...roles].sort();
    if (before.join() === after.join()) throw conflict('NO_CHANGE', 'Roles unchanged');
    const rows = await q.query<UserRow>('UPDATE users SET roles=$2::text[] WHERE id=$1 RETURNING *', [u.id, roles]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'USER_ROLES_CHANGED', resourceType: 'USER', resourceId: u.id,
      prevState: before.join(','), newState: after.join(','), reason, details: { username: u.username, added: after.filter((r) => !before.includes(r)), removed: before.filter((r) => !after.includes(r)) } });
    return publicUser(rows[0]);
  });
}

export async function amendUser(ctx: Ctx, actor: Actor, id: string, body: any) {
  const displayName = str(body?.displayName, 'displayName', { max: 200 });
  const password = body?.password === undefined || body?.password === '' ? undefined : validatePassword(body.password);
  if (!displayName && !password) throw badRequest('Nothing to change (displayName and/or password)');
  const hash = password ? await bcrypt.hash(password, 10) : null;
  return ctx.db.tx(async (q) => {
    const u = await loadUser(q, actor.tenantId, id);
    if (password && u.auth_source === 'OIDC') throw conflict('SSO_ACCOUNT', 'This account signs in through Active Directory; its password is managed there');
    const rows = await q.query<UserRow>('UPDATE users SET display_name=COALESCE($2, display_name), password_hash=COALESCE($3, password_hash) WHERE id=$1 RETURNING *',
      [u.id, displayName ?? null, hash]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'USER_AMENDED', resourceType: 'USER', resourceId: u.id,
      details: { username: u.username, displayNameChanged: !!displayName && displayName !== u.display_name, passwordReset: !!password } });
    return publicUser(rows[0]);
  });
}

export const STAFF_ROLE_LIST = STAFF_ROLES;
