// Provision a new government entity (tenant): `npm run entity:create` (tools/entity-create.ts) and tests.
//
// Creates, through the regular services (so every step is audited in its own transaction):
//   tenant (+ default document types)  → TENANT_CREATED
//   entity profile (numbering / receipt patterns, local sign-in)
//   first administrator (TENANT_ADMIN) → USER_CREATED (password hashed; never audited, logged or stored in clear)
//   starter cycle templates (published, one default) → TEMPLATE_PUBLISHED ×3
//   notification templates + a default approval service level
//   ENTITY_PROVISIONED summary event.
// Idempotent: running it again for the same code never duplicates or overwrites anything (an existing administrator
// keeps its password); it only completes the parts that are missing (e.g. after an interrupted run) and says so.
import crypto from 'node:crypto';
import type { Ctx } from '../ctx.js';
import { auditTx } from '../ctx.js';
import { SYSTEM_ACTOR } from '../services/audit.js';
import { createTenant, insertUser, type UserRow } from '../services/identity.js';
import { installDefaultDocumentTypes } from '../services/doc-catalogue.js';
import { installStarterTemplates, STARTER_TEMPLATES } from '../services/templates.js';
import { installDefaultTemplates } from '../features/notify/engine.js';
import { badRequest } from '../util.js';
import { assertMayCreateEntity } from '../tenancy.js';

export interface EntityInput {
  code: string;
  nameEn: string;
  nameAr: string;
  colour?: string;
  sector?: string;
  adminUsername?: string;
  adminDisplayName?: string;
  /** Optional fixed first password (e.g. from TF_ENTITY_ADMIN_PASSWORD); otherwise one is generated. */
  adminPassword?: string;
  defaultTemplate?: string;
}

export interface EntityResult {
  tenantId: string;
  dryRun: boolean;
  created: { tenant: boolean; profile: boolean; admin: boolean; templates: number; documentTypes: number; notificationTemplates: number; approvalSla: boolean };
  adminUsername: string;
  /** Present only when the administrator was created now with a generated password: show it once, never store it. */
  oneTimePassword?: string;
  warnings: string[];
}

export const ADMIN_PASSWORD_MIN = 12;
const ARABIC = /[؀-ۿ]/;

export const generatePassword = () => `${crypto.randomBytes(18).toString('base64url')}`;

export function validateEntityInput(i: EntityInput): Required<Omit<EntityInput, 'adminPassword' | 'sector'>> & Pick<EntityInput, 'adminPassword' | 'sector'> {
  const code = String(i.code ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,40}$/.test(code)) throw badRequest('code must be 2-40 characters: a-z, 0-9, _ or -');
  const nameEn = String(i.nameEn ?? '').trim();
  const nameAr = String(i.nameAr ?? '').trim();
  if (!nameEn || nameEn.length > 200) throw badRequest('English name is required (max 200 characters)');
  if (!nameAr || nameAr.length > 200) throw badRequest('Arabic name is required (max 200 characters)');
  if (!ARABIC.test(nameAr)) throw badRequest('Arabic name must be written in Arabic script');
  const colour = (i.colour ?? '#0B4F6C').trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(colour)) throw badRequest('colour must be #RRGGBB');
  const defaultTemplate = (i.defaultTemplate ?? 'PUBLIC_TENDER').trim().toUpperCase();
  if (!STARTER_TEMPLATES.some((t) => t.code === defaultTemplate))
    throw badRequest(`default template must be one of ${STARTER_TEMPLATES.map((t) => t.code).join(', ')}`);
  const sector = i.sector?.trim() || undefined;
  if (sector && sector.length > 100) throw badRequest('sector: max 100 characters');
  if (i.adminPassword !== undefined && i.adminPassword.length < ADMIN_PASSWORD_MIN)
    throw badRequest(`the administrator password must be at least ${ADMIN_PASSWORD_MIN} characters`);
  return {
    code, nameEn, nameAr, colour, defaultTemplate, sector,
    adminUsername: (i.adminUsername ?? 'admin').trim().toLowerCase(),
    adminDisplayName: (i.adminDisplayName ?? 'Entity Administrator / مدير الجهة').trim(),
    adminPassword: i.adminPassword,
  };
}

export async function provisionEntity(ctx: Ctx, input: EntityInput, opts: { dryRun?: boolean } = {}): Promise<EntityResult> {
  const v = validateEntityInput(input);
  await assertMayCreateEntity(ctx, v.code); // dedicated installation: only its own entity (tenancy.ts)
  const dryRun = !!opts.dryRun;
  const tenantId = v.code;
  const warnings: string[] = [];
  const created: EntityResult['created'] = { tenant: false, profile: false, admin: false, templates: 0, documentTypes: 0, notificationTemplates: 0, approvalSla: false };
  const result: EntityResult = { tenantId, dryRun, created, adminUsername: v.adminUsername, warnings };

  // --- 1. tenant (+ default document types) ---
  const existing = (await ctx.db.query<{ name_en: string; name_ar: string; status: string; profile: Record<string, unknown> | null }>(
    'SELECT name_en, name_ar, status, profile FROM tenants WHERE id=$1', [tenantId]))[0];
  if (existing) {
    warnings.push(`entity '${tenantId}' already exists: names and colour are left unchanged (use Admin → Entity settings)`);
    if (existing.name_en !== v.nameEn || existing.name_ar !== v.nameAr) warnings.push('the names given differ from the stored names');
    if (existing.status !== 'ACTIVE') warnings.push(`entity status is ${existing.status}`);
  } else if (dryRun) {
    created.tenant = true; created.profile = true;
  } else {
    await createTenant(ctx, { id: tenantId, nameEn: v.nameEn, nameAr: v.nameAr, primaryColor: v.colour });
    created.tenant = true;
  }
  const profileMissing = !existing || !existing.profile || Object.keys(existing.profile).length === 0;
  if (created.tenant && !dryRun)
    created.documentTypes = Number((await ctx.db.query<{ n: string }>('SELECT count(*)::text AS n FROM document_types WHERE tenant_id=$1', [tenantId]))[0].n);

  // --- 2. first administrator ---
  const admin = (await ctx.db.query<UserRow>('SELECT * FROM users WHERE tenant_id=$1 AND username=$2', [tenantId, v.adminUsername]))[0];
  let adminActor: { id: string; roles: string[]; tenantId: string } | null = admin ? { id: admin.id, roles: admin.roles, tenantId } : null;
  if (admin) {
    warnings.push(`user '${v.adminUsername}' already exists: its password is NOT changed`);
    if (!admin.roles.includes('TENANT_ADMIN')) warnings.push(`user '${v.adminUsername}' is not a TENANT_ADMIN`);
  } else if (dryRun) {
    created.admin = true;
  } else {
    const password = v.adminPassword ?? generatePassword();
    const u = await ctx.db.tx((q) => insertUser(ctx, q, SYSTEM_ACTOR, {
      tenantId, username: v.adminUsername, password, displayName: v.adminDisplayName, roles: ['TENANT_ADMIN'],
    }));
    adminActor = { id: u.id, roles: u.roles, tenantId };
    created.admin = true;
    if (!v.adminPassword) result.oneTimePassword = password;
  }

  // --- 3. starter cycle templates ---
  const hasTemplates = (await ctx.db.query('SELECT 1 FROM cycle_templates WHERE tenant_id=$1 LIMIT 1', [tenantId])).length > 0;
  if (hasTemplates) { if (existing) warnings.push('cycle templates already exist: left unchanged'); }
  else if (dryRun) created.templates = STARTER_TEMPLATES.length;
  else created.templates = (await installStarterTemplates(ctx, adminActor ?? { ...SYSTEM_ACTOR, tenantId }, v.defaultTemplate)).length;

  if (dryRun) {
    const hasSla = existing ? (await ctx.db.query('SELECT 1 FROM approval_sla_settings WHERE tenant_id=$1', [tenantId])).length > 0 : false;
    created.approvalSla = !hasSla;
    return result;
  }

  // --- 4. missing document types, notification templates, approval service level, profile and the summary event (one transaction) ---
  await ctx.db.tx(async (q) => {
    if (!created.tenant) created.documentTypes = await installDefaultDocumentTypes(q, tenantId); // completes a resumed run
    created.notificationTemplates = await installDefaultTemplates(q, tenantId);
    created.approvalSla = (await q.query(`INSERT INTO approval_sla_settings (tenant_id, default_due_hours, escalate_to, remind_before_hours, updated_by)
                                           VALUES ($1, 48, 'NEXT_LEVEL_ROLE', 8, 'SYSTEM') ON CONFLICT (tenant_id) DO NOTHING RETURNING tenant_id`, [tenantId])).length > 0;
    if (profileMissing) {
      const CODE = tenantId.toUpperCase();
      const profile = {
        numberingPattern: `${CODE}-{YYYY}-{SEQ3}`, receiptPattern: `${CODE}-R-{YYYY}-{SEQ5}`, identityProvider: 'LOCAL',
        channels: { knet: false, gazette: true, capt: false }, logoText: CODE.slice(0, 12), ...(v.sector ? { sector: v.sector } : {}),
      };
      await q.query('UPDATE tenants SET profile=$2::jsonb WHERE id=$1', [tenantId, JSON.stringify(profile)]);
      created.profile = true;
    }
    const changed = created.tenant || created.profile || created.admin || created.templates > 0 || created.documentTypes > 0
      || created.notificationTemplates > 0 || created.approvalSla;
    if (changed) {
      await auditTx(ctx, q, { tenantId, actor: SYSTEM_ACTOR, action: 'ENTITY_PROVISIONED', resourceType: 'TENANT', resourceId: tenantId,
        newState: 'ACTIVE', details: {
          tool: 'entity:create', resumed: !!existing, adminUsername: v.adminUsername, adminCreated: created.admin,
          adminPasswordSource: created.admin ? (v.adminPassword ? 'PROVIDED' : 'GENERATED_ONE_TIME') : null,
          cycleTemplates: created.templates, defaultTemplate: created.templates ? v.defaultTemplate : null, documentTypes: created.documentTypes,
          notificationTemplates: created.notificationTemplates, approvalSla: created.approvalSla, profile: created.profile,
        } });
    }
  });
  return result;
}
