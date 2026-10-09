// Entity policies: per-entity business rules that a customer may still be deciding (e.g. MOI's open BRD questions).
// Each setting is enforced by the server where the code says so; the defaults reproduce TenderFlow v1.0 behaviour,
// so an entity without a policy row behaves exactly as before. Editing is TENANT_ADMIN only and audited.
import type { Ctx } from '../ctx.js';
import { auditTx } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import type { Queryable } from '../db.js';
import { ROLES } from '../auth/tokens.js';
import { badRequest, now } from '../util.js';

export type Visibility = 'CATEGORY' | 'ELIGIBLE_ONLY';
export type GradeMatch = 'EXACT' | 'AT_LEAST';
export type GradeScope = 'COMPANY' | 'PER_ACTIVITY';
export type ExemptionMode = 'PER_VENDOR' | 'CATEGORY';
export type ExemptionWaives = 'TENDER_DOCUMENTS' | 'TENDER_DOCUMENTS_AND_SUBSCRIPTION';
export type BlockEffect = 'PAUSE' | 'CONTINUE';
export type SubscriptionStart = 'PAYMENT_DATE' | 'APPROVAL_DATE';
export type ContentProtection = 'NONE' | 'VIEW_ONLY' | 'WATERMARKED_DOWNLOAD';
export type ActivityCodeSource = 'MANUAL' | 'FILE' | 'MOC_API';
export type AccountProvisioning = 'ADMIN_CREATED' | 'AD_GROUPS';
export interface LabelledCode { code: string; en: string; ar: string }

export interface EntityPolicies {
  // Eligibility (BR-007, FR-020, SEC-006)
  visibility: Visibility;
  gradeMatch: GradeMatch;
  gradeScope: GradeScope;
  // Annual subscription (FR-017, BR-008/009/010, NOT-001)
  subscriptionRequired: boolean;
  subscriptionFee: number;
  subscriptionCurrency: string;
  subscriptionTermMonths: number;
  subscriptionStart: SubscriptionStart;
  retainPurchasedAfterExpiry: boolean;
  renewalReminderDays: number[];
  // Fee exemption (FR-018)
  exemptionMode: ExemptionMode;
  exemptionWaives: ExemptionWaives;
  // Blocking (FR-013/014, BR-006, FR-024)
  blockRoles: string[];
  blockEffectOnSubscription: BlockEffect;
  blockGrounds: LabelledCode[];
  // Functions → roles ("confirmed functions, not confirmed job titles")
  gradingRoles: string[];
  // Content protection (SEC-001/002, FR-023) — stored here; enforcement belongs to the security feature.
  contentProtection: ContentProtection;
  // Registration documents a vendor uploads with the application (FR-015)
  registrationDocuments: LabelledCode[];
  // Activity code sourcing (MoC)
  activityCodeSource: ActivityCodeSource;
  // MOI staff account provisioning (INT-004)
  accountProvisioning: AccountProvisioning;
}

export const DEFAULT_POLICIES: EntityPolicies = {
  visibility: 'CATEGORY',
  gradeMatch: 'AT_LEAST',
  gradeScope: 'PER_ACTIVITY',
  subscriptionRequired: false,
  subscriptionFee: 0,
  subscriptionCurrency: 'KWD',
  subscriptionTermMonths: 12,
  subscriptionStart: 'PAYMENT_DATE',
  retainPurchasedAfterExpiry: true,
  renewalReminderDays: [30, 7, 1],
  exemptionMode: 'PER_VENDOR',
  exemptionWaives: 'TENDER_DOCUMENTS',
  blockRoles: ['TENANT_ADMIN'],
  blockEffectOnSubscription: 'CONTINUE',
  blockGrounds: [
    { code: 'DOCUMENTS_EXPIRED', en: 'Registration documents expired', ar: 'انتهاء صلاحية مستندات التسجيل' },
    { code: 'BREACH', en: 'Breach of tender or contract conditions', ar: 'الإخلال بشروط المناقصة أو العقد' },
    { code: 'AUTHORITY_DECISION', en: 'Decision of the competent authority', ar: 'قرار من الجهة المختصة' },
    { code: 'OTHER', en: 'Other (see reason)', ar: 'أخرى (انظر السبب)' },
  ],
  gradingRoles: ['PROCUREMENT_OFFICER', 'GRADING_AUTHORITY'],
  contentProtection: 'NONE',
  registrationDocuments: [
    { code: 'CR', en: 'Commercial registration certificate', ar: 'شهادة السجل التجاري' },
    { code: 'LICENCE', en: 'Commercial licence', ar: 'الرخصة التجارية' },
  ],
  activityCodeSource: 'MANUAL',
  accountProvisioning: 'ADMIN_CREATED',
};

const STAFF_FUNCTION_ROLES = ['PROCUREMENT_OFFICER', 'DIRECTOR', 'UNDERSECRETARY', 'TENANT_ADMIN', 'GRADING_AUTHORITY'];

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], field: string, d: T): T => {
  if (v === undefined || v === null || v === '') return d;
  if (!allowed.includes(v as T)) throw badRequest(`${field} must be one of ${allowed.join(', ')}`);
  return v as T;
};
const boolOr = (v: unknown, field: string, d: boolean) => {
  if (v === undefined || v === null) return d;
  if (typeof v !== 'boolean') throw badRequest(`${field} must be true or false`);
  return v;
};
function roleList(v: unknown, field: string, d: string[]): string[] {
  if (v === undefined || v === null) return d;
  if (!Array.isArray(v) || !v.length) throw badRequest(`${field} must be a non-empty list of roles`);
  for (const r of v) if (typeof r !== 'string' || !(ROLES as readonly string[]).includes(r) || !STAFF_FUNCTION_ROLES.includes(r))
    throw badRequest(`${field} may contain only ${STAFF_FUNCTION_ROLES.join(', ')}`);
  return [...new Set(v as string[])];
}
function codes(v: unknown, field: string, d: LabelledCode[]): LabelledCode[] {
  if (v === undefined || v === null) return d;
  if (!Array.isArray(v)) throw badRequest(`${field} must be a list`);
  if (v.length > 30) throw badRequest(`${field} allows at most 30 entries`);
  const out = v.map((x: any, i) => {
    const code = typeof x?.code === 'string' ? x.code.trim().toUpperCase() : '';
    if (!/^[A-Z0-9_]{1,40}$/.test(code)) throw badRequest(`${field}[${i}].code may contain A-Z, 0-9 and _`);
    const en = typeof x?.en === 'string' ? x.en.trim() : ''; const ar = typeof x?.ar === 'string' ? x.ar.trim() : '';
    if (!en || !ar || en.length > 200 || ar.length > 200) throw badRequest(`${field}[${i}] needs an English and an Arabic label (max 200)`);
    return { code, en, ar };
  });
  if (new Set(out.map((x) => x.code)).size !== out.length) throw badRequest(`${field} codes must be unique`);
  return out;
}

/** Validate a full or partial policy object on top of `base`. */
export function parsePolicies(raw: any, base: EntityPolicies = DEFAULT_POLICIES): EntityPolicies {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('policies must be an object');
  const b = base;
  const fee = raw.subscriptionFee === undefined ? b.subscriptionFee : Number(raw.subscriptionFee);
  if (!Number.isFinite(fee) || fee < 0 || fee > 100000) throw badRequest('subscriptionFee must be 0-100000');
  const term = raw.subscriptionTermMonths === undefined ? b.subscriptionTermMonths : Number(raw.subscriptionTermMonths);
  if (!Number.isInteger(term) || term < 1 || term > 60) throw badRequest('subscriptionTermMonths must be 1-60');
  let days = b.renewalReminderDays;
  if (raw.renewalReminderDays !== undefined) {
    if (!Array.isArray(raw.renewalReminderDays) || raw.renewalReminderDays.length > 6) throw badRequest('renewalReminderDays must be a list of up to 6 day counts');
    days = raw.renewalReminderDays.map(Number);
    if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 365)) throw badRequest('renewalReminderDays entries must be whole days 1-365');
    days = [...new Set(days)].sort((x, y) => y - x);
  }
  const cur = raw.subscriptionCurrency === undefined ? b.subscriptionCurrency : String(raw.subscriptionCurrency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) throw badRequest('subscriptionCurrency must be a 3-letter code');
  const subscriptionRequired = boolOr(raw.subscriptionRequired, 'subscriptionRequired', b.subscriptionRequired);
  if (subscriptionRequired && fee <= 0)
    throw badRequest('subscriptionRequired needs subscriptionFee > 0 (use fee exemption for vendors who do not pay)');
  return {
    visibility: oneOf(raw.visibility, ['CATEGORY', 'ELIGIBLE_ONLY'] as const, 'visibility', b.visibility),
    gradeMatch: oneOf(raw.gradeMatch, ['EXACT', 'AT_LEAST'] as const, 'gradeMatch', b.gradeMatch),
    gradeScope: oneOf(raw.gradeScope, ['COMPANY', 'PER_ACTIVITY'] as const, 'gradeScope', b.gradeScope),
    subscriptionRequired,
    subscriptionFee: fee,
    subscriptionCurrency: cur,
    subscriptionTermMonths: term,
    subscriptionStart: oneOf(raw.subscriptionStart, ['PAYMENT_DATE', 'APPROVAL_DATE'] as const, 'subscriptionStart', b.subscriptionStart),
    retainPurchasedAfterExpiry: boolOr(raw.retainPurchasedAfterExpiry, 'retainPurchasedAfterExpiry', b.retainPurchasedAfterExpiry),
    renewalReminderDays: days,
    exemptionMode: oneOf(raw.exemptionMode, ['PER_VENDOR', 'CATEGORY'] as const, 'exemptionMode', b.exemptionMode),
    exemptionWaives: oneOf(raw.exemptionWaives, ['TENDER_DOCUMENTS', 'TENDER_DOCUMENTS_AND_SUBSCRIPTION'] as const, 'exemptionWaives', b.exemptionWaives),
    blockRoles: roleList(raw.blockRoles, 'blockRoles', b.blockRoles),
    blockEffectOnSubscription: oneOf(raw.blockEffectOnSubscription, ['PAUSE', 'CONTINUE'] as const, 'blockEffectOnSubscription', b.blockEffectOnSubscription),
    blockGrounds: codes(raw.blockGrounds, 'blockGrounds', b.blockGrounds),
    gradingRoles: roleList(raw.gradingRoles, 'gradingRoles', b.gradingRoles),
    contentProtection: oneOf(raw.contentProtection, ['NONE', 'VIEW_ONLY', 'WATERMARKED_DOWNLOAD'] as const, 'contentProtection', b.contentProtection),
    registrationDocuments: codes(raw.registrationDocuments, 'registrationDocuments', b.registrationDocuments),
    activityCodeSource: oneOf(raw.activityCodeSource, ['MANUAL', 'FILE', 'MOC_API'] as const, 'activityCodeSource', b.activityCodeSource),
    accountProvisioning: oneOf(raw.accountProvisioning, ['ADMIN_CREATED', 'AD_GROUPS'] as const, 'accountProvisioning', b.accountProvisioning),
  };
}

/** Effective policies of an entity (stored values on top of the defaults). Usable inside a transaction. */
export async function policiesOf(db: Queryable, tenantId: string): Promise<EntityPolicies> {
  const r = (await db.query<{ policies: any }>('SELECT policies FROM entity_policies WHERE tenant_id=$1', [tenantId]))[0];
  if (!r) return { ...DEFAULT_POLICIES };
  return { ...DEFAULT_POLICIES, ...(r.policies ?? {}) };
}

export async function policiesRow(db: Queryable, tenantId: string) {
  const r = (await db.query<{ policies: any; reference: string | null; updated_by: string | null; updated_at: Date }>(
    'SELECT policies, reference, updated_by, updated_at FROM entity_policies WHERE tenant_id=$1', [tenantId]))[0];
  return { policies: { ...DEFAULT_POLICIES, ...(r?.policies ?? {}) } as EntityPolicies, reference: r?.reference ?? null,
    updatedBy: r?.updated_by ?? null, updatedAt: r?.updated_at ?? null };
}

/** Admin edit (partial). Audited with the changed keys and their previous / new values. */
export async function updatePolicies(ctx: Ctx, actor: Actor, body: any) {
  const patch = body?.policies ?? body;
  return ctx.db.tx(async (q) => {
    const cur = await policiesOf(q, actor.tenantId);
    const next = parsePolicies(patch, cur);
    const changed = (Object.keys(next) as (keyof EntityPolicies)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(cur[k]));
    if (!changed.length) return policiesRow(q, actor.tenantId);
    await q.query(`INSERT INTO entity_policies (tenant_id, policies, updated_by, updated_at) VALUES ($1,$2::jsonb,$3,$4)
                   ON CONFLICT (tenant_id) DO UPDATE SET policies=EXCLUDED.policies, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
      [actor.tenantId, JSON.stringify(next), actor.id, now()]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'ENTITY_POLICIES_UPDATED', resourceType: 'TENANT', resourceId: actor.tenantId,
      details: { changed, from: Object.fromEntries(changed.map((k) => [k, cur[k]])), to: Object.fromEntries(changed.map((k) => [k, next[k]])) } });
    return policiesRow(q, actor.tenantId);
  });
}

/** Seed / installer: write a full policy set and the requirements reference it is annotated against. */
export async function installPolicies(ctx: Ctx, q: Queryable, actor: { id: string; roles: string[] }, tenantId: string, raw: Partial<EntityPolicies>, reference: string | null) {
  const p = parsePolicies(raw, DEFAULT_POLICIES);
  await q.query(`INSERT INTO entity_policies (tenant_id, policies, reference, updated_by, updated_at) VALUES ($1,$2::jsonb,$3,$4,$5)
                 ON CONFLICT (tenant_id) DO UPDATE SET policies=EXCLUDED.policies, reference=EXCLUDED.reference, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
    [tenantId, JSON.stringify(p), reference, actor.id, now()]);
  await auditTx(ctx, q, { tenantId, actor, action: 'ENTITY_POLICIES_UPDATED', resourceType: 'TENANT', resourceId: tenantId,
    details: { installed: true, reference } });
  return p;
}
