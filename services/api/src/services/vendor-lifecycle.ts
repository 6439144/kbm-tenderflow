// Vendor lifecycle (generic; configured for MOI from its BRD): application grading by the grading authority,
// annual subscription issued as a payment link (TEST gateway in the demo, KNET refused until configured), renewal
// reminders (NOT-001), grade upgrade requests with documents (FR-010), fee exemption per vendor or vendor category
// (FR-018), blocking for a date range or permanently with automatic reinstatement (FR-013/014, BR-006).
// Every state change is audited inside the same transaction; jobs act as SYSTEM.
import crypto from 'node:crypto';
import type { Ctx } from '../ctx.js';
import { auditTx, hasRole, isStaff } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import type { Queryable } from '../db.js';
import { SYSTEM_ACTOR } from './audit.js';
import { ApiError, badRequest, camel, conflict, forbidden, isUuid, notFound, now, reqStr, str, uuid } from '../util.js';
import { policiesOf, type EntityPolicies } from './entity-policies.js';
import { applyPattern, configOf, getProfile, scopeOf } from './templates.js';
import { checkEligibility, GRADE_NAMES, nextReceipt, vendorClassifications } from './eligibility.js';
import { notify, notifyRole } from './notifications.js';
import { insertDocument, publicDoc, putDocument, validateUpload, type DocumentRow, type PreparedDoc, type UploadFile } from './documents.js';
import { emitDocumentEvent } from './document-events.js';
import type { TenderRow } from './tenders.js';

const DAY = 86_400_000;
const PUBLISHED_PLUS = ['PUBLISHED', 'CLOSED', 'OPENED', 'EVALUATION', 'AWARDED'];

export interface SubscriptionRow {
  id: string; tenant_id: string; vendor_id: string; kind: 'NEW' | 'RENEWAL'; status: 'PENDING_PAYMENT' | 'ACTIVE' | 'EXPIRED' | 'CANCELLED';
  link_token: string; amount: string | number; currency: string; gateway: string | null; payment_ref: string | null; receipt_number: string | null;
  approved_at: Date | null; starts_at: Date | null; ends_at: Date | null; paused_days: number; issued_by: string | null; paid_by: string | null;
  paid_at: Date | null; created_at: Date;
}
export interface BlockRow {
  id: string; tenant_id: string; vendor_id: string; mode: 'DATE_RANGE' | 'PERMANENT'; starts_at: Date; ends_at: Date | null; ground: string | null;
  reason: string; authorised_by: string; status: 'ACTIVE' | 'ENDED' | 'LIFTED'; ended_at: Date | null; lifted_by: string | null; lift_reason: string | null; created_at: Date;
}

export function addMonths(d: Date, months: number): Date {
  const x = new Date(d.getTime());
  const day = x.getUTCDate();
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + months);
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, last));
  return x;
}

// ---------------------------------------------------------------- state queries

/** The block in force now (starts_at ≤ now and not ended), or null. */
export async function activeBlock(db: Queryable, tenantId: string, vendorId: string): Promise<BlockRow | null> {
  const rows = await db.query<BlockRow>(
    `SELECT * FROM vendor_blocks WHERE tenant_id=$1 AND vendor_id=$2 AND status='ACTIVE' AND starts_at <= $3
       AND (ends_at IS NULL OR ends_at > $3) ORDER BY (ends_at IS NULL) DESC, ends_at DESC LIMIT 1`, [tenantId, vendorId, now()]);
  return rows[0] ?? null;
}

/** The subscription period covering now, or null. */
export async function activeSubscription(db: Queryable, tenantId: string, vendorId: string): Promise<SubscriptionRow | null> {
  const rows = await db.query<SubscriptionRow>(
    `SELECT * FROM vendor_subscriptions WHERE tenant_id=$1 AND vendor_id=$2 AND status='ACTIVE' AND starts_at <= $3 AND ends_at > $3
      ORDER BY ends_at DESC LIMIT 1`, [tenantId, vendorId, now()]);
  return rows[0] ?? null;
}

/** FR-018: is the vendor exempt from paying, under the entity's exemption mode? */
export async function feeExemption(db: Queryable, tenantId: string, vendorId: string, pol?: EntityPolicies)
  : Promise<{ basis: 'PER_VENDOR' | 'CATEGORY'; reason: string; category?: string; waives: EntityPolicies['exemptionWaives'] } | null> {
  const p = pol ?? await policiesOf(db, tenantId);
  const v = (await db.query<{ fee_exempt: boolean; fee_exempt_reason: string | null; vendor_category: string | null }>(
    'SELECT fee_exempt, fee_exempt_reason, vendor_category FROM vendors WHERE id=$1 AND tenant_id=$2', [vendorId, tenantId]))[0];
  if (!v) return null;
  if (p.exemptionMode === 'PER_VENDOR')
    return v.fee_exempt ? { basis: 'PER_VENDOR', reason: v.fee_exempt_reason ?? 'Vendor exempt (per-vendor flag)', waives: p.exemptionWaives } : null;
  if (!v.vendor_category) return null;
  const c = (await db.query<{ fee_exempt: boolean; name_en: string }>('SELECT fee_exempt, name_en FROM vendor_categories WHERE tenant_id=$1 AND code=$2',
    [tenantId, v.vendor_category]))[0];
  return c?.fee_exempt ? { basis: 'CATEGORY', reason: `Vendor category ${v.vendor_category} (${c.name_en}) is fee-exempt`, category: v.vendor_category, waives: p.exemptionWaives } : null;
}

async function subscriptionSatisfied(db: Queryable, tenantId: string, vendorId: string, p: EntityPolicies): Promise<boolean> {
  if (!p.subscriptionRequired) return true;
  if (await activeSubscription(db, tenantId, vendorId)) return true;
  const ex = await feeExemption(db, tenantId, vendorId, p);
  return Boolean(ex && ex.waives === 'TENDER_DOCUMENTS_AND_SUBSCRIPTION');
}

const suspendedError = (b: BlockRow) => new ApiError(403, 'VENDOR_SUSPENDED',
  b.mode === 'PERMANENT' ? 'This vendor account is suspended permanently.' : `This vendor account is suspended until ${new Date(b.ends_at!).toISOString()}.`,
  { suspendedUntil: b.ends_at ? new Date(b.ends_at).toISOString() : null, permanent: b.mode === 'PERMANENT' });

/** Purchases and other vendor transactions: blocked → 403 VENDOR_SUSPENDED; no valid subscription (when required) → 403 SUBSCRIPTION_REQUIRED. */
export async function assertVendorMayTransact(db: Queryable, tenantId: string, vendorId: string) {
  const b = await activeBlock(db, tenantId, vendorId);
  if (b) throw suspendedError(b);
  const p = await policiesOf(db, tenantId);
  if (!(await subscriptionSatisfied(db, tenantId, vendorId, p)))
    throw new ApiError(403, 'SUBSCRIPTION_REQUIRED', 'An active annual vendor subscription is required to view and purchase tenders. Renew it from "My company".');
}

export type TenderAccess = 'OK' | 'HIDDEN' | 'SUSPENDED' | 'SUBSCRIPTION_REQUIRED';

/**
 * Vendor access to one tender (enforced on list, detail and document download — SEC-006): approved vendor, tender
 * PUBLISHED or later, visibility rule (CATEGORY: tender category in the vendor categories; ELIGIBLE_ONLY: BR-007
 * activity + grade), not blocked, and an active subscription when required (BR-008) — except that, with
 * retainPurchasedAfterExpiry (BR-010), a vendor keeps access to tenders whose documents it already bought.
 */
export async function vendorTenderAccess(db: Queryable, tenantId: string, vendorId: string | null, t: TenderRow, pol?: EntityPolicies): Promise<TenderAccess> {
  if (!vendorId || !PUBLISHED_PLUS.includes(t.status)) return 'HIDDEN';
  const v = (await db.query<{ status: string; categories: string[] }>('SELECT status, categories FROM vendors WHERE id=$1 AND tenant_id=$2', [vendorId, tenantId]))[0];
  if (!v || v.status !== 'APPROVED') return 'HIDDEN';
  const p = pol ?? await policiesOf(db, tenantId);
  if (p.visibility === 'ELIGIBLE_ONLY') {
    if (!(await checkEligibility(db, t, vendorId)).eligible) return 'HIDDEN';
  } else if (!(v.categories ?? []).includes(t.category)) return 'HIDDEN';
  const b = await activeBlock(db, tenantId, vendorId);
  if (b) return 'SUSPENDED';
  if (!(await subscriptionSatisfied(db, tenantId, vendorId, p))) {
    const bought = p.retainPurchasedAfterExpiry
      ? (await db.query('SELECT 1 FROM tender_purchases WHERE tender_id=$1 AND vendor_id=$2', [t.id, vendorId])).length > 0 : false;
    if (!bought) return 'SUBSCRIPTION_REQUIRED';
  }
  return 'OK';
}

/** Throws the right error for a non-OK access (404 for hidden: existence is not revealed). */
export async function assertVendorTenderAccess(db: Queryable, tenantId: string, vendorId: string | null, t: TenderRow) {
  const a = await vendorTenderAccess(db, tenantId, vendorId, t);
  if (a === 'OK') return;
  if (a === 'SUSPENDED') throw suspendedError((await activeBlock(db, tenantId, vendorId!))!);
  if (a === 'SUBSCRIPTION_REQUIRED')
    throw new ApiError(403, 'SUBSCRIPTION_REQUIRED', 'An active annual vendor subscription is required to view tenders. Renew it from "My company".');
  throw notFound('Tender');
}

/** List filter for vendors: keeps only the tenders the vendor may open. */
export async function filterVendorTenders<T extends TenderRow>(db: Queryable, tenantId: string, vendorId: string, rows: T[]): Promise<T[]> {
  const p = await policiesOf(db, tenantId);
  const out: T[] = [];
  for (const t of rows) if ((await vendorTenderAccess(db, tenantId, vendorId, t, p)) === 'OK') out.push(t);
  return out;
}

/** Pack / addendum download for vendors: tender access + (policy) documents only after purchase when the cycle sells them. */
export async function vendorMayReadPack(db: Queryable, tenantId: string, vendorId: string | null, t: TenderRow): Promise<boolean> {
  if ((await vendorTenderAccess(db, tenantId, vendorId, t)) !== 'OK') return false;
  return packUnlocked(db, t, vendorId!);
}

/** With documentPurchase on and the PUBLICATION_AND_SALE scope (the purchase IS the product), files open only after purchase. */
export async function packUnlocked(db: Queryable, t: TenderRow, vendorId: string): Promise<boolean> {
  const cfg = configOf(t);
  if (!cfg.stages.documentPurchase || scopeOf(cfg) !== 'PUBLICATION_AND_SALE') return true;
  return (await db.query('SELECT 1 FROM tender_purchases WHERE tender_id=$1 AND vendor_id=$2', [t.id, vendorId])).length > 0;
}

/** Called by login after the password is verified: a blocked vendor gets 403 ACCOUNT_SUSPENDED (FR-013, FR-024). */
export async function assertLoginAllowed(db: Queryable, u: { tenant_id: string; vendor_id: string | null }) {
  if (!u.vendor_id) return;
  const b = await activeBlock(db, u.tenant_id, u.vendor_id);
  if (!b) return;
  throw new ApiError(403, 'ACCOUNT_SUSPENDED',
    b.mode === 'PERMANENT' ? 'This vendor account is suspended.' : `This vendor account is suspended until ${new Date(b.ends_at!).toISOString()}.`,
    { suspendedUntil: b.ends_at ? new Date(b.ends_at).toISOString() : null, permanent: b.mode === 'PERMANENT' });
}

// ---------------------------------------------------------------- views

export async function lifecycleView(db: Queryable, tenantId: string, vendorId: string) {
  const p = await policiesOf(db, tenantId);
  const v = (await db.query<any>('SELECT * FROM vendors WHERE id=$1 AND tenant_id=$2', [vendorId, tenantId]))[0];
  if (!v) throw notFound('Vendor');
  const subs = await db.query<SubscriptionRow>('SELECT * FROM vendor_subscriptions WHERE tenant_id=$1 AND vendor_id=$2 ORDER BY created_at DESC', [tenantId, vendorId]);
  const cur = await activeSubscription(db, tenantId, vendorId);
  const pending = subs.find((s) => s.status === 'PENDING_PAYMENT') ?? null;
  const ex = await feeExemption(db, tenantId, vendorId, p);
  const block = await activeBlock(db, tenantId, vendorId);
  const blocks = await db.query<BlockRow>('SELECT * FROM vendor_blocks WHERE tenant_id=$1 AND vendor_id=$2 ORDER BY created_at DESC', [tenantId, vendorId]);
  const status = cur ? 'ACTIVE' : ex?.waives === 'TENDER_DOCUMENTS_AND_SUBSCRIPTION' ? 'EXEMPT'
    : pending ? 'PENDING_PAYMENT' : subs.some((s) => s.status === 'EXPIRED' || s.status === 'ACTIVE') ? 'EXPIRED' : 'NONE';
  const latestEnd = subs.filter((s) => s.status === 'ACTIVE').map((s) => new Date(s.ends_at!).getTime()).sort((a, b) => b - a)[0];
  const ups = await db.query<any>('SELECT * FROM grade_upgrade_requests WHERE tenant_id=$1 AND vendor_id=$2 ORDER BY created_at DESC', [tenantId, vendorId]);
  return {
    vendorId, vendorStatus: v.status, companyGrade: v.company_grade, vendorCategory: v.vendor_category,
    subscription: {
      required: p.subscriptionRequired, status, fee: p.subscriptionFee, currency: p.subscriptionCurrency, termMonths: p.subscriptionTermMonths,
      startRule: p.subscriptionStart, current: cur ? publicSub(cur) : null, pending: pending ? publicSub(pending, true) : null,
      paidUntil: latestEnd ? new Date(latestEnd).toISOString() : null,
      daysLeft: cur ? Math.max(0, Math.ceil((new Date(cur.ends_at!).getTime() - now().getTime()) / DAY)) : null,
      history: subs.map((s) => publicSub(s)),
    },
    exemption: ex ? { basis: ex.basis, reason: ex.reason, category: ex.category ?? null, waives: ex.waives } : null,
    block: block ? camel(block) : null,
    blocks: camel(blocks),
    classifications: await vendorClassifications(db, tenantId, vendorId),
    upgradeRequests: camel(ups),
    registrationDocuments: p.registrationDocuments,
  };
}

/** The link token is shown only to the vendor (and staff) as the pay link; never inside receipts. */
const publicSub = (s: SubscriptionRow, withLink = false) => {
  const o = camel<any>({ ...s, link_token: undefined });
  o.amount = Number(s.amount);
  if (withLink && s.status === 'PENDING_PAYMENT') o.payLink = `/vendor/subscription?link=${s.link_token}`;
  return o;
};

// ---------------------------------------------------------------- grading (FR-016)

export function assertGradingRole(actor: Actor, p: EntityPolicies) {
  if (!hasRole(actor, ...p.gradingRoles)) throw forbidden(`Grading is assigned to: ${p.gradingRoles.join(', ')} (entity policy)`);
}

export async function gradingQueue(ctx: Ctx, actor: Actor) {
  const p = await policiesOf(ctx.db, actor.tenantId);
  assertGradingRole(actor, p);
  const apps = await ctx.db.query<any>(
    `SELECT v.*, (SELECT count(*) FROM documents d WHERE d.vendor_id=v.id AND d.owner_type='VENDOR')::int AS document_count
       FROM vendors v WHERE v.tenant_id=$1 AND v.status='PENDING_REVIEW' ORDER BY v.created_at`, [actor.tenantId]);
  const ups = await ctx.db.query<any>(
    `SELECT g.*, v.legal_name_en, v.legal_name_ar FROM grade_upgrade_requests g JOIN vendors v ON v.id=g.vendor_id
      WHERE g.tenant_id=$1 ORDER BY (g.status='SUBMITTED') DESC, g.created_at DESC LIMIT 100`, [actor.tenantId]);
  const recent = await ctx.db.query<any>(
    `SELECT id, legal_name_en, legal_name_ar, status, company_grade, graded_at FROM vendors WHERE tenant_id=$1 AND graded_at IS NOT NULL ORDER BY graded_at DESC LIMIT 20`, [actor.tenantId]);
  return { gradeScope: p.gradeScope, applications: camel(apps), upgradeRequests: camel(ups), recentlyGraded: camel(recent) };
}

export async function gradingVendor(ctx: Ctx, actor: Actor, vendorId: string) {
  const p = await policiesOf(ctx.db, actor.tenantId);
  assertGradingRole(actor, p);
  if (!isUuid(vendorId)) throw notFound('Vendor');
  const v = (await ctx.db.query<any>('SELECT * FROM vendors WHERE id=$1 AND tenant_id=$2', [vendorId, actor.tenantId]))[0];
  if (!v) throw notFound('Vendor');
  const docs = await ctx.db.query<DocumentRow>(`SELECT * FROM documents WHERE tenant_id=$1 AND vendor_id=$2 AND owner_type='VENDOR' ORDER BY created_at`, [actor.tenantId, vendorId]);
  return { vendor: camel(v), documents: docs.map(publicDoc), lifecycle: await lifecycleView(ctx.db, actor.tenantId, vendorId), gradeScope: p.gradeScope,
    registrationDocuments: p.registrationDocuments };
}

interface GradeInput { activityCode: string; grade: number }
async function parseGrades(q: Queryable, tenantId: string, b: any, p: EntityPolicies): Promise<{ grades: GradeInput[]; companyGrade: number | null }> {
  const list = Array.isArray(b?.activities) ? b.activities : Array.isArray(b?.grades) ? b.grades : [];
  if (!list.length) throw badRequest('Assign at least one activity code (activities: [{activityCode, grade}])');
  if (list.length > 30) throw badRequest('At most 30 activity codes');
  let companyGrade: number | null = null;
  if (p.gradeScope === 'COMPANY') {
    companyGrade = Number(b?.companyGrade);
    if (![1, 2, 3].includes(companyGrade)) throw badRequest('The entity grades the company as a whole (gradeScope COMPANY): companyGrade must be 1, 2 or 3');
  }
  const grades: GradeInput[] = [];
  for (const [i, x] of list.entries()) {
    const code = reqStr(x?.activityCode, `activities[${i}].activityCode`, 40);
    if (!(await q.query('SELECT 1 FROM activity_codes WHERE tenant_id=$1 AND code=$2', [tenantId, code])).length) throw badRequest(`Unknown activity code '${code}'`);
    const grade = companyGrade ?? Number(x?.grade);
    if (![1, 2, 3].includes(grade)) throw badRequest(`activities[${i}].grade must be 1 (First), 2 (Second) or 3 (Third)`);
    grades.push({ activityCode: code, grade });
  }
  if (new Set(grades.map((g) => g.activityCode)).size !== grades.length) throw badRequest('activity codes must be unique');
  return { grades, companyGrade };
}

async function writeClassifications(ctx: Ctx, q: Queryable, actor: { id: string; roles: string[] }, tenantId: string, vendorId: string, grades: GradeInput[]) {
  for (const g of grades) {
    const prev = (await q.query<{ grade: number }>('SELECT grade FROM vendor_classifications WHERE vendor_id=$1 AND activity_code=$2', [vendorId, g.activityCode]))[0];
    await q.query(
      `INSERT INTO vendor_classifications (tenant_id, vendor_id, activity_code, grade, valid_until, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,NULL,$5,$6) ON CONFLICT (vendor_id, activity_code) DO UPDATE SET grade=EXCLUDED.grade,
         updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`, [tenantId, vendorId, g.activityCode, g.grade, actor.id, now()]);
    await auditTx(ctx, q, { tenantId, actor, action: 'VENDOR_CLASSIFICATION_SET', resourceType: 'VENDOR', resourceId: vendorId,
      prevState: prev ? String(prev.grade) : null, newState: String(g.grade), details: { activityCode: g.activityCode } });
  }
}

/**
 * Grading authority decides an application (FR-016): APPROVE assigns grades (per activity or one company grade,
 * per policy), approves the vendor and — when the entity requires a subscription — issues the payment link (FR-017,
 * NOT-004). REJECT needs a reason. The vendor is notified either way.
 */
export async function gradeVendor(ctx: Ctx, actor: Actor, vendorId: string, b: any) {
  const p = await policiesOf(ctx.db, actor.tenantId);
  assertGradingRole(actor, p);
  if (!isUuid(vendorId)) throw notFound('Vendor');
  const decision = b?.decision;
  if (decision !== 'APPROVE' && decision !== 'REJECT') throw badRequest("decision must be 'APPROVE' or 'REJECT'");
  const reason = decision === 'REJECT' ? reqStr(b?.reason, 'reason', 2000) : (str(b?.reason, 'reason', { max: 2000 }) ?? null);
  return ctx.db.tx(async (q) => {
    const v = (await q.query<any>('SELECT * FROM vendors WHERE id=$1 AND tenant_id=$2', [vendorId, actor.tenantId]))[0];
    if (!v) throw notFound('Vendor');
    if (v.status !== 'PENDING_REVIEW') throw conflict('INVALID_STATE', `Vendor is ${v.status}, not PENDING_REVIEW`);
    if (decision === 'REJECT') {
      await q.query(`UPDATE vendors SET status='REJECTED', decision_reason=$1, decided_by=$2, decided_at=$3 WHERE id=$4`, [reason, actor.id, now(), vendorId]);
      await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'VENDOR_REJECTED', resourceType: 'VENDOR', resourceId: vendorId,
        prevState: 'PENDING_REVIEW', newState: 'REJECTED', reason, details: { by: 'GRADING_AUTHORITY' } });
      await notify(q, { tenantId: actor.tenantId, vendorId, kind: 'VENDOR_APPLICATION_REJECTED',
        titleEn: 'Your registration application was not approved', titleAr: 'لم تتم الموافقة على طلب التسجيل', body: { reason } });
      return { vendorId, status: 'REJECTED' };
    }
    const { grades, companyGrade } = await parseGrades(q, actor.tenantId, b, p);
    await q.query(`UPDATE vendors SET status='APPROVED', decision_reason=$1, decided_by=$2, decided_at=$3, graded_by=$2, graded_at=$3, company_grade=$4 WHERE id=$5`,
      [reason, actor.id, now(), companyGrade, vendorId]);
    await writeClassifications(ctx, q, actor, actor.tenantId, vendorId, grades);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'VENDOR_GRADED', resourceType: 'VENDOR', resourceId: vendorId,
      prevState: 'PENDING_REVIEW', newState: 'APPROVED', reason, details: { grades, companyGrade, gradeScope: p.gradeScope } });
    let link: SubscriptionRow | null = null;
    if (p.subscriptionRequired) link = await issueSubscription(ctx, q, actor, actor.tenantId, vendorId, 'NEW', p);
    else await notify(q, { tenantId: actor.tenantId, vendorId, kind: 'VENDOR_APPROVED', titleEn: 'Your registration was approved and graded',
      titleAr: 'تمت الموافقة على تسجيلكم وتصنيفكم', body: { grades } });
    return { vendorId, status: 'APPROVED', grades, companyGrade, subscription: link ? publicSub(link, true) : null };
  });
}

/** Issue a subscription period as a payment link (or activate directly when the vendor's exemption waives it). */
async function issueSubscription(ctx: Ctx, q: Queryable, actor: { id: string; roles: string[] }, tenantId: string, vendorId: string,
  kind: 'NEW' | 'RENEWAL', p: EntityPolicies): Promise<SubscriptionRow> {
  const ex = await feeExemption(q, tenantId, vendorId, p);
  const token = crypto.randomBytes(18).toString('base64url');
  const rows = await q.query<SubscriptionRow>(
    `INSERT INTO vendor_subscriptions (id, tenant_id, vendor_id, kind, status, link_token, amount, currency, approved_at, issued_by, created_at)
     VALUES ($1,$2,$3,$4,'PENDING_PAYMENT',$5,$6,$7,$8,$9,$8) RETURNING *`,
    [uuid(), tenantId, vendorId, kind, token, ex?.waives === 'TENDER_DOCUMENTS_AND_SUBSCRIPTION' ? 0 : p.subscriptionFee, p.subscriptionCurrency, now(), actor.id]);
  const s = rows[0];
  await auditTx(ctx, q, { tenantId, actor, action: 'SUBSCRIPTION_LINK_ISSUED', resourceType: 'VENDOR', resourceId: vendorId, newState: 'PENDING_PAYMENT',
    details: { subscriptionId: s.id, kind, amount: Number(s.amount), currency: s.currency, termMonths: p.subscriptionTermMonths } });
  await notify(q, { tenantId, vendorId, kind: 'SUBSCRIPTION_LINK',
    titleEn: kind === 'NEW' ? `Approved — pay your annual subscription (${Number(s.amount)} ${s.currency}) to activate your account`
      : `Renewal link — annual subscription ${Number(s.amount)} ${s.currency}`,
    titleAr: kind === 'NEW' ? `تمت الموافقة — ادفع الاشتراك السنوي (${Number(s.amount)} ${s.currency}) لتفعيل حسابكم` : `رابط التجديد — الاشتراك السنوي ${Number(s.amount)} ${s.currency}`,
    templateCode: 'NOT-004_REGISTRATION_APPROVED', body: { brd: 'NOT-004', subscriptionId: s.id, payLink: `/vendor/subscription?link=${token}` } });
  return s;
}

// ---------------------------------------------------------------- subscription payment & renewal

/** Vendor pays its pending subscription link. TEST gateway is simulated and labelled; KNET is refused until configured. */
export async function paySubscription(ctx: Ctx, actor: Actor, b: any) {
  if (!actor.vendorId) throw forbidden('Only vendor users can pay a subscription');
  const token = reqStr(b?.link, 'link', 100);
  const gateway = b?.gateway === 'KNET' ? 'KNET' : 'TEST';
  const b0 = await activeBlock(ctx.db, actor.tenantId, actor.vendorId);
  if (b0) throw suspendedError(b0);
  const p = await policiesOf(ctx.db, actor.tenantId);
  const pattern = (await getProfile(ctx, actor.tenantId)).receiptPattern;
  return ctx.db.tx(async (q) => {
    const s = (await q.query<SubscriptionRow>('SELECT * FROM vendor_subscriptions WHERE link_token=$1 AND tenant_id=$2 AND vendor_id=$3',
      [token, actor.tenantId, actor.vendorId]))[0];
    if (!s) throw notFound('Subscription payment link');
    if (s.status !== 'PENDING_PAYMENT') throw conflict('ALREADY_PAID', 'This subscription link has already been used');
    const free = Number(s.amount) === 0;
    const gw = free ? 'EXEMPT' : gateway;
    // No KNET integration exists yet (needs the merchant account and specification, DEP-004): always refused,
    // never recorded as paid.
    if (gw === 'KNET')
      throw new ApiError(503, 'KNET_NOT_CONFIGURED', 'KNET is not configured for this entity (needs the KNET merchant and specification, DEP-004). Use the TEST gateway in the demo.');
    const paidAt = now();
    // BR-009: the year runs from the payment date (or the approval date, per policy). A renewal paid before the
    // current period ends starts when it ends, so no paid days are lost.
    let start = p.subscriptionStart === 'APPROVAL_DATE' && s.kind === 'NEW' && s.approved_at ? new Date(s.approved_at) : paidAt;
    const latest = (await q.query<{ ends_at: Date }>(
      `SELECT ends_at FROM vendor_subscriptions WHERE vendor_id=$1 AND status='ACTIVE' AND ends_at > $2 ORDER BY ends_at DESC LIMIT 1`, [actor.vendorId, paidAt]))[0];
    if (latest && new Date(latest.ends_at) > start) start = new Date(latest.ends_at);
    const ends = addMonths(start, p.subscriptionTermMonths);
    const receipt = await nextReceipt(q, actor.tenantId, pattern);
    const ref = free ? null : `${gw}-${uuid().slice(0, 8).toUpperCase()}`;
    const rows = await q.query<SubscriptionRow>(
      `UPDATE vendor_subscriptions SET status='ACTIVE', gateway=$1, payment_ref=$2, receipt_number=$3, starts_at=$4, ends_at=$5, paid_by=$6, paid_at=$7
        WHERE id=$8 AND status='PENDING_PAYMENT' RETURNING *`, [gw, ref, receipt, start, ends, actor.id, paidAt, s.id]);
    if (!rows[0]) throw conflict('ALREADY_PAID', 'This subscription link has already been used');
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'SUBSCRIPTION_PAID', resourceType: 'VENDOR', resourceId: actor.vendorId,
      prevState: 'PENDING_PAYMENT', newState: 'ACTIVE', details: { subscriptionId: s.id, kind: s.kind, gateway: gw, paymentRef: ref, receipt,
        amount: Number(s.amount), currency: s.currency, startsAt: start.toISOString(), endsAt: ends.toISOString(), startRule: p.subscriptionStart } });
    await notify(q, { tenantId: actor.tenantId, vendorId: actor.vendorId, kind: 'SUBSCRIPTION_ACTIVE',
      titleEn: `Subscription active until ${ends.toISOString().slice(0, 10)} — receipt ${receipt}`, titleAr: `الاشتراك فعّال حتى ${ends.toISOString().slice(0, 10)} — إيصال ${receipt}`,
      body: { subscriptionId: s.id, receipt } });
    return publicSub(rows[0]);
  });
}

/** Vendor asks for a renewal link (when the current period is within the reminder window, expired, or absent). */
export async function requestRenewal(ctx: Ctx, actor: Actor) {
  if (!actor.vendorId) throw forbidden('Only vendor users can renew a subscription');
  const p = await policiesOf(ctx.db, actor.tenantId);
  if (!p.subscriptionRequired) throw conflict('NOT_REQUIRED', 'This entity does not require a vendor subscription');
  const b0 = await activeBlock(ctx.db, actor.tenantId, actor.vendorId);
  if (b0) throw suspendedError(b0);
  return ctx.db.tx(async (q) => {
    const v = (await q.query<{ status: string }>('SELECT status FROM vendors WHERE id=$1 AND tenant_id=$2', [actor.vendorId, actor.tenantId]))[0];
    if (v?.status !== 'APPROVED') throw conflict('INVALID_STATE', 'Only an approved vendor can renew');
    const pending = (await q.query<SubscriptionRow>(`SELECT * FROM vendor_subscriptions WHERE vendor_id=$1 AND status='PENDING_PAYMENT'`, [actor.vendorId]))[0];
    if (pending) return publicSub(pending, true);
    const window = Math.max(...p.renewalReminderDays, 30);
    const latest = (await q.query<{ ends_at: Date }>(`SELECT ends_at FROM vendor_subscriptions WHERE vendor_id=$1 AND status='ACTIVE' ORDER BY ends_at DESC LIMIT 1`, [actor.vendorId]))[0];
    if (latest && new Date(latest.ends_at).getTime() - now().getTime() > window * DAY)
      throw conflict('TOO_EARLY', `Renewal opens ${window} days before the current period ends (${new Date(latest.ends_at).toISOString().slice(0, 10)})`);
    const hadAny = (await q.query('SELECT 1 FROM vendor_subscriptions WHERE vendor_id=$1 AND status IN (\'ACTIVE\',\'EXPIRED\') LIMIT 1', [actor.vendorId])).length > 0;
    return publicSub(await issueSubscription(ctx, q, actor, actor.tenantId, actor.vendorId!, hadAny ? 'RENEWAL' : 'NEW', p), true);
  });
}

// ---------------------------------------------------------------- receipts (FR-007, FR-022)

/** A printable receipt: tender document purchase or subscription payment, in the entity's own number series. */
export async function receiptView(ctx: Ctx, actor: Actor, receiptNumber: string) {
  const no = reqStr(receiptNumber, 'receipt', 80);
  const prof = await getProfile(ctx, actor.tenantId);
  const purchase = (await ctx.db.query<any>(
    `SELECT p.*, t.tender_number, t.title_en, t.title_ar, v.legal_name_en, v.legal_name_ar, v.cr_number FROM tender_purchases p
       JOIN tenders t ON t.id=p.tender_id JOIN vendors v ON v.id=p.vendor_id WHERE p.tenant_id=$1 AND p.receipt_number=$2`, [actor.tenantId, no]))[0];
  const sub = purchase ? null : (await ctx.db.query<any>(
    `SELECT s.*, v.legal_name_en, v.legal_name_ar, v.cr_number FROM vendor_subscriptions s JOIN vendors v ON v.id=s.vendor_id
      WHERE s.tenant_id=$1 AND s.receipt_number=$2`, [actor.tenantId, no]))[0];
  const row = purchase ?? sub;
  if (!row) throw notFound('Receipt');
  if (!isStaff(actor) && row.vendor_id !== actor.vendorId) throw notFound('Receipt');
  return {
    entity: { nameEn: prof.nameEn, nameAr: prof.nameAr, logoText: prof.logoText ?? null },
    kind: purchase ? 'TENDER_DOCUMENTS' : 'SUBSCRIPTION',
    receiptNumber: row.receipt_number, gateway: row.gateway, gatewayTransactionId: row.payment_ref ?? null,
    amount: Number(row.amount), currency: row.currency, paidAt: row.paid_at,
    vendor: { nameEn: row.legal_name_en, nameAr: row.legal_name_ar, crNumber: row.cr_number },
    tender: purchase ? { number: row.tender_number, titleEn: row.title_en, titleAr: row.title_ar } : null,
    period: sub ? { startsAt: sub.starts_at, endsAt: sub.ends_at } : null,
    status: row.status,
    test: row.gateway === 'TEST',
  };
}

// ---------------------------------------------------------------- grade upgrades (FR-010, NOT-003)

const MAX_UPGRADE_FILES = 5;

export async function createUpgradeRequest(ctx: Ctx, actor: Actor, b: any, files: UploadFile[]) {
  if (!actor.vendorId) throw forbidden('Only vendor users can request a grade upgrade');
  const p = await policiesOf(ctx.db, actor.tenantId);
  const v = (await ctx.db.query<any>('SELECT * FROM vendors WHERE id=$1 AND tenant_id=$2', [actor.vendorId, actor.tenantId]))[0];
  if (!v || v.status !== 'APPROVED') throw conflict('INVALID_STATE', 'Only an approved vendor can request a grade upgrade');
  const b0 = await activeBlock(ctx.db, actor.tenantId, actor.vendorId);
  if (b0) throw suspendedError(b0);
  const requested = Number(b?.requestedGrade);
  if (![1, 2, 3].includes(requested)) throw badRequest('requestedGrade must be 1 (First), 2 (Second) or 3 (Third)');
  const activity = p.gradeScope === 'COMPANY' ? null : reqStr(b?.activityCode, 'activityCode', 40);
  let current: number | null;
  if (activity) {
    const c = (await ctx.db.query<{ grade: number }>('SELECT grade FROM vendor_classifications WHERE vendor_id=$1 AND activity_code=$2', [actor.vendorId, activity]))[0];
    if (!c) throw badRequest(`You are not registered for activity '${activity}'; an upgrade applies to an existing activity`);
    current = Number(c.grade);
  } else current = v.company_grade ?? null;
  if (current !== null && requested >= current) throw badRequest(`Requested ${GRADE_NAMES[requested].en} is not higher than the current ${GRADE_NAMES[current].en}`);
  if (!files.length) throw badRequest('Attach at least one supporting document (field "files")');
  if (files.length > MAX_UPGRADE_FILES) throw badRequest(`At most ${MAX_UPGRADE_FILES} files`);
  const checked = files.map((f) => validateUpload(f, 'files'));
  const justification = str(b?.justification, 'justification', { max: 4000 }) ?? '';
  const id = uuid();
  const n = Number((await ctx.db.query<{ n: string }>('SELECT count(*)::text AS n FROM grade_upgrade_requests WHERE tenant_id=$1', [actor.tenantId]))[0].n) + 1;
  const number = applyPattern(`${actor.tenantId.toUpperCase()}-GUR-{YYYY}-{SEQ4}`, n);
  const prepared: PreparedDoc[] = [];
  for (const f of checked) prepared.push(await putDocument(ctx, {
    tenantId: actor.tenantId, ownerType: 'VENDOR', ownerId: actor.vendorId, vendorId: actor.vendorId, folderKey: `vendors/${number}`,
    title: `${number} — ${f.originalname}`, fileName: f.originalname, mimeType: f.detectedMime, bytes: f.buffer, uploadedBy: actor.id,
  }));
  const out = await ctx.db.tx(async (q) => {
    const docs = [];
    for (const pd of prepared) docs.push(await insertDocument(q, pd));
    const rows = await q.query<any>(
      `INSERT INTO grade_upgrade_requests (id, tenant_id, vendor_id, request_number, activity_code, current_grade, requested_grade, justification,
         document_ids, status, requested_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::uuid[],'SUBMITTED',$10,$11) RETURNING *`,
      [id, actor.tenantId, actor.vendorId, number, activity, current, requested, justification, docs.map((d) => d.id), actor.id, now()]);
    for (const d of docs) await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'VENDOR_DOCUMENT_UPLOADED', resourceType: 'DOCUMENT', resourceId: d.id,
      details: { vendorId: actor.vendorId, sha256: d.sha256_plain, title: d.title, upgradeRequestId: id, storeRef: d.store_ref } });
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'GRADE_UPGRADE_REQUESTED', resourceType: 'VENDOR', resourceId: actor.vendorId!,
      newState: 'SUBMITTED', details: { upgradeRequestId: id, requestNumber: number, activityCode: activity, currentGrade: current, requestedGrade: requested, documents: docs.length } });
    for (const role of p.gradingRoles) await notifyRole(q, actor.tenantId, role, { kind: 'GRADE_UPGRADE_SUBMITTED',
      titleEn: `Grade upgrade request ${number}: ${v.legal_name_en}`, titleAr: `طلب ترقية تصنيف ${number}: ${v.legal_name_ar}`, body: { brd: 'NOT-002', upgradeRequestId: id } });
    return { row: rows[0], docIds: docs.map((d) => d.id) };
  });
  emitDocumentEvent(ctx, { type: 'UPLOADED', tenantId: actor.tenantId, documentIds: out.docIds, actor });
  return camel(out.row);
}

export async function listUpgradeRequests(ctx: Ctx, actor: Actor) {
  if (actor.vendorId && !isStaff(actor))
    return camel(await ctx.db.query('SELECT * FROM grade_upgrade_requests WHERE tenant_id=$1 AND vendor_id=$2 ORDER BY created_at DESC', [actor.tenantId, actor.vendorId]));
  assertGradingRole(actor, await policiesOf(ctx.db, actor.tenantId));
  return camel(await ctx.db.query(
    `SELECT g.*, v.legal_name_en, v.legal_name_ar FROM grade_upgrade_requests g JOIN vendors v ON v.id=g.vendor_id WHERE g.tenant_id=$1 ORDER BY g.created_at DESC`, [actor.tenantId]));
}

export async function getUpgradeRequest(ctx: Ctx, actor: Actor, id: string) {
  if (!isUuid(id)) throw notFound('Upgrade request');
  const g = (await ctx.db.query<any>(
    `SELECT g.*, v.legal_name_en, v.legal_name_ar, v.cr_number FROM grade_upgrade_requests g JOIN vendors v ON v.id=g.vendor_id WHERE g.id=$1 AND g.tenant_id=$2`, [id, actor.tenantId]))[0];
  if (!g) throw notFound('Upgrade request');
  if (actor.vendorId && !isStaff(actor)) { if (g.vendor_id !== actor.vendorId) throw notFound('Upgrade request'); }
  else assertGradingRole(actor, await policiesOf(ctx.db, actor.tenantId));
  const docs = await ctx.db.query<DocumentRow>('SELECT * FROM documents WHERE id = ANY($1::uuid[]) AND tenant_id=$2 ORDER BY created_at', [g.document_ids, actor.tenantId]);
  return { ...camel(g), documents: docs.map(publicDoc), classifications: await vendorClassifications(ctx.db, actor.tenantId, g.vendor_id) };
}

export async function decideUpgrade(ctx: Ctx, actor: Actor, id: string, b: any) {
  const p = await policiesOf(ctx.db, actor.tenantId);
  assertGradingRole(actor, p);
  if (!isUuid(id)) throw notFound('Upgrade request');
  const decision = b?.decision;
  if (decision !== 'APPROVE' && decision !== 'REJECT') throw badRequest("decision must be 'APPROVE' or 'REJECT'");
  const reason = decision === 'REJECT' ? reqStr(b?.reason, 'reason', 2000) : (str(b?.reason, 'reason', { max: 2000 }) ?? null);
  return ctx.db.tx(async (q) => {
    const g = (await q.query<any>('SELECT * FROM grade_upgrade_requests WHERE id=$1 AND tenant_id=$2', [id, actor.tenantId]))[0];
    if (!g) throw notFound('Upgrade request');
    if (g.status !== 'SUBMITTED') throw conflict('INVALID_STATE', `Upgrade request is ${g.status}`);
    if (g.requested_by === actor.id) throw forbidden('Segregation of duties: the requester cannot decide their own upgrade request');
    let granted: number | null = null;
    if (decision === 'APPROVE') {
      granted = b?.grade === undefined || b?.grade === null || b?.grade === '' ? Number(g.requested_grade) : Number(b.grade);
      if (![1, 2, 3].includes(granted)) throw badRequest('grade must be 1, 2 or 3');
      if (g.current_grade !== null && granted >= Number(g.current_grade)) throw badRequest('The granted grade must be higher than the current grade');
      if (g.activity_code) await writeClassifications(ctx, q, actor, actor.tenantId, g.vendor_id, [{ activityCode: g.activity_code, grade: granted }]);
      else {
        await q.query('UPDATE vendors SET company_grade=$1, graded_by=$2, graded_at=$3 WHERE id=$4', [granted, actor.id, now(), g.vendor_id]);
        const acts = await q.query<{ activity_code: string }>('SELECT activity_code FROM vendor_classifications WHERE vendor_id=$1', [g.vendor_id]);
        await writeClassifications(ctx, q, actor, actor.tenantId, g.vendor_id, acts.map((a) => ({ activityCode: a.activity_code, grade: granted! })));
      }
    }
    const status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const rows = await q.query<any>(`UPDATE grade_upgrade_requests SET status=$1, decided_by=$2, decided_at=$3, decision_reason=$4, granted_grade=$5 WHERE id=$6 RETURNING *`,
      [status, actor.id, now(), reason, granted, id]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: decision === 'APPROVE' ? 'GRADE_UPGRADE_APPROVED' : 'GRADE_UPGRADE_REJECTED',
      resourceType: 'VENDOR', resourceId: g.vendor_id, prevState: g.current_grade === null ? null : String(g.current_grade), newState: granted === null ? null : String(granted),
      reason, details: { upgradeRequestId: id, requestNumber: g.request_number, activityCode: g.activity_code, requestedGrade: g.requested_grade } });
    const gName = granted ? GRADE_NAMES[granted] : null;
    await notify(q, { tenantId: actor.tenantId, vendorId: g.vendor_id, kind: 'GRADE_UPGRADE_DECIDED',
      titleEn: decision === 'APPROVE' ? `Grade upgrade ${g.request_number} approved: ${gName!.en}` : `Grade upgrade ${g.request_number} was not approved`,
      titleAr: decision === 'APPROVE' ? `تمت الموافقة على ترقية التصنيف ${g.request_number}: ${gName!.ar}` : `لم تتم الموافقة على ترقية التصنيف ${g.request_number}`,
      templateCode: 'NOT-003_GRADE_UPGRADE_APPROVED', body: { brd: 'NOT-003', upgradeRequestId: id, reason } });
    return camel(rows[0]);
  });
}

// ---------------------------------------------------------------- fee exemption (FR-018)

export async function listVendorCategories(ctx: Ctx, tenantId: string) {
  return camel(await ctx.db.query('SELECT code, name_en, name_ar, fee_exempt FROM vendor_categories WHERE tenant_id=$1 ORDER BY code', [tenantId]));
}

export async function upsertVendorCategory(ctx: Ctx, actor: Actor, b: any) {
  const code = reqStr(b?.code, 'code', 40).toUpperCase();
  if (!/^[A-Z0-9_]{1,40}$/.test(code)) throw badRequest('code may contain A-Z, 0-9 and _');
  const nameEn = reqStr(b?.nameEn, 'nameEn', 200); const nameAr = reqStr(b?.nameAr, 'nameAr', 200);
  const feeExempt = b?.feeExempt === true;
  await ctx.db.tx(async (q) => {
    const prev = (await q.query<{ fee_exempt: boolean }>('SELECT fee_exempt FROM vendor_categories WHERE tenant_id=$1 AND code=$2', [actor.tenantId, code]))[0];
    await q.query(`INSERT INTO vendor_categories (tenant_id, code, name_en, name_ar, fee_exempt) VALUES ($1,$2,$3,$4,$5)
                   ON CONFLICT (tenant_id, code) DO UPDATE SET name_en=EXCLUDED.name_en, name_ar=EXCLUDED.name_ar, fee_exempt=EXCLUDED.fee_exempt`,
      [actor.tenantId, code, nameEn, nameAr, feeExempt]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'VENDOR_CATEGORY_SAVED', resourceType: 'VENDOR_CATEGORY', resourceId: code,
      prevState: prev ? String(prev.fee_exempt) : null, newState: String(feeExempt), details: { nameEn } });
  });
  return listVendorCategories(ctx, actor.tenantId);
}

/** Admin: per-vendor exemption flag (used when exemptionMode = PER_VENDOR) and/or the vendor's category (CATEGORY mode). */
export async function setVendorExemption(ctx: Ctx, actor: Actor, vendorId: string, b: any) {
  if (!isUuid(vendorId)) throw notFound('Vendor');
  const v = (await ctx.db.query<any>('SELECT * FROM vendors WHERE id=$1 AND tenant_id=$2', [vendorId, actor.tenantId]))[0];
  if (!v) throw notFound('Vendor');
  const sets: string[] = []; const vals: unknown[] = []; const details: Record<string, unknown> = {};
  if (b?.feeExempt !== undefined) {
    if (typeof b.feeExempt !== 'boolean') throw badRequest('feeExempt must be true or false');
    const reason = b.feeExempt ? reqStr(b?.reason, 'reason', 2000) : (str(b?.reason, 'reason', { max: 2000 }) ?? null);
    vals.push(b.feeExempt, b.feeExempt ? reason : null); sets.push(`fee_exempt=$${vals.length - 1}`, `fee_exempt_reason=$${vals.length}`);
    details.feeExempt = { from: v.fee_exempt, to: b.feeExempt, reason };
  }
  if (b?.vendorCategory !== undefined) {
    const cat = b.vendorCategory === null || b.vendorCategory === '' ? null : reqStr(b.vendorCategory, 'vendorCategory', 40).toUpperCase();
    if (cat && !(await ctx.db.query('SELECT 1 FROM vendor_categories WHERE tenant_id=$1 AND code=$2', [actor.tenantId, cat])).length)
      throw badRequest(`Unknown vendor category '${cat}'`);
    vals.push(cat); sets.push(`vendor_category=$${vals.length}`);
    details.vendorCategory = { from: v.vendor_category, to: cat };
  }
  if (!sets.length) throw badRequest('Nothing to change (feeExempt and/or vendorCategory)');
  vals.push(vendorId);
  await ctx.db.tx(async (q) => {
    await q.query(`UPDATE vendors SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'VENDOR_EXEMPTION_UPDATED', resourceType: 'VENDOR', resourceId: vendorId,
      reason: (details.feeExempt as any)?.reason ?? null, details });
  });
  return lifecycleView(ctx.db, actor.tenantId, vendorId);
}

// ---------------------------------------------------------------- blocking (FR-013/014, BR-006, NOT-005)

const parseDate = (v: unknown, field: string) => {
  const d = typeof v === 'string' && v ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) throw badRequest(`${field} must be an ISO date or date-time`);
  return d;
};

export async function blockVendor(ctx: Ctx, actor: Actor, vendorId: string, b: any) {
  const p = await policiesOf(ctx.db, actor.tenantId);
  if (!hasRole(actor, ...p.blockRoles)) throw forbidden(`Blocking is authorised for: ${p.blockRoles.join(', ')} (entity policy)`);
  if (!isUuid(vendorId)) throw notFound('Vendor');
  const mode = b?.mode === 'PERMANENT' ? 'PERMANENT' : b?.mode === 'DATE_RANGE' ? 'DATE_RANGE' : null;
  if (!mode) throw badRequest("mode must be 'DATE_RANGE' or 'PERMANENT'");
  const from = b?.from ? parseDate(b.from, 'from') : now();
  const to = mode === 'DATE_RANGE' ? parseDate(b?.to, 'to') : null;
  if (to && to <= from) throw badRequest('to must be after from');
  if (to && to <= now()) throw badRequest('to must be in the future');
  const reason = reqStr(b?.reason, 'reason', 2000);
  const ground = str(b?.ground, 'ground', { max: 40 }) ?? null;
  if (ground && !p.blockGrounds.some((g) => g.code === ground)) throw badRequest(`ground must be one of ${p.blockGrounds.map((g) => g.code).join(', ')}`);
  return ctx.db.tx(async (q) => {
    const v = (await q.query<any>('SELECT * FROM vendors WHERE id=$1 AND tenant_id=$2', [vendorId, actor.tenantId]))[0];
    if (!v) throw notFound('Vendor');
    const rows = await q.query<BlockRow>(
      `INSERT INTO vendor_blocks (id, tenant_id, vendor_id, mode, starts_at, ends_at, ground, reason, authorised_by, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ACTIVE',$10) RETURNING *`, [uuid(), actor.tenantId, vendorId, mode, from, to, ground, reason, actor.id, now()]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'VENDOR_BLOCKED', resourceType: 'VENDOR', resourceId: vendorId, newState: 'BLOCKED', reason,
      details: { blockId: rows[0].id, mode, from: from.toISOString(), to: to?.toISOString() ?? null, ground, effectOnSubscription: p.blockEffectOnSubscription } });
    const until = to ? to.toISOString().slice(0, 10) : null;
    await notify(q, { tenantId: actor.tenantId, vendorId, kind: 'VENDOR_BLOCKED',
      titleEn: until ? `Your account is suspended until ${until}` : 'Your account is suspended', titleAr: until ? `تم إيقاف حسابكم حتى ${until}` : 'تم إيقاف حسابكم',
      templateCode: 'NOT-005_VENDOR_BLOCKED', body: { brd: 'NOT-005', blockId: rows[0].id, reason, ground, outOfBand: 'Delivered in-app; e-mail / SMS delivery is a notification-channel feature (FR-024)' } });
    return camel(rows[0]);
  });
}

async function endBlock(ctx: Ctx, q: Queryable, blk: BlockRow, actor: { id: string; roles: string[] }, how: 'ENDED' | 'LIFTED', reason: string | null) {
  const p = await policiesOf(q, blk.tenant_id);
  const endAt = how === 'ENDED' && blk.ends_at ? new Date(blk.ends_at) : now();
  const rows = await q.query<BlockRow>(
    `UPDATE vendor_blocks SET status=$1, ended_at=$2, lifted_by=$3, lift_reason=$4 WHERE id=$5 AND status='ACTIVE' RETURNING *`,
    [how, endAt, how === 'LIFTED' ? actor.id : null, reason, blk.id]);
  if (!rows[0]) return null;
  // blockEffectOnSubscription = PAUSE: the blocked time is added back to the subscription period(s) it overlapped.
  let pausedDays = 0;
  if (p.blockEffectOnSubscription === 'PAUSE') {
    const start = new Date(blk.starts_at);
    const subs = await q.query<SubscriptionRow>(`SELECT * FROM vendor_subscriptions WHERE vendor_id=$1 AND status='ACTIVE' AND ends_at > $2 AND starts_at < $3`,
      [blk.vendor_id, start, endAt]);
    for (const s of subs) {
      const overlap = Math.min(endAt.getTime(), new Date(s.ends_at!).getTime()) - Math.max(start.getTime(), new Date(s.starts_at!).getTime());
      const days = Math.max(0, Math.ceil(overlap / DAY));
      if (!days) continue;
      await q.query('UPDATE vendor_subscriptions SET ends_at = ends_at + make_interval(days => $1::int), paused_days = paused_days + $1::int WHERE id=$2', [days, s.id]);
      pausedDays += days;
    }
  }
  await auditTx(ctx, q, { tenantId: blk.tenant_id, actor, action: 'VENDOR_REINSTATED', resourceType: 'VENDOR', resourceId: blk.vendor_id, prevState: 'BLOCKED',
    newState: 'ACTIVE', reason, details: { blockId: blk.id, how: how === 'ENDED' ? 'AUTOMATIC_AT_END_DATE' : 'LIFTED_BY_ADMIN', pausedDays,
      effectOnSubscription: p.blockEffectOnSubscription } });
  await notify(q, { tenantId: blk.tenant_id, vendorId: blk.vendor_id, kind: 'VENDOR_REINSTATED', titleEn: 'Your account has been reinstated',
    titleAr: 'تمت إعادة تفعيل حسابكم', body: { blockId: blk.id, pausedDays } });
  return rows[0];
}

export async function liftBlock(ctx: Ctx, actor: Actor, vendorId: string, blockId: string, b: any) {
  const p = await policiesOf(ctx.db, actor.tenantId);
  if (!hasRole(actor, ...p.blockRoles)) throw forbidden(`Blocking is authorised for: ${p.blockRoles.join(', ')} (entity policy)`);
  if (!isUuid(blockId) || !isUuid(vendorId)) throw notFound('Block');
  const reason = reqStr(b?.reason, 'reason', 2000);
  return ctx.db.tx(async (q) => {
    const blk = (await q.query<BlockRow>(`SELECT * FROM vendor_blocks WHERE id=$1 AND vendor_id=$2 AND tenant_id=$3`, [blockId, vendorId, actor.tenantId]))[0];
    if (!blk) throw notFound('Block');
    if (blk.status !== 'ACTIVE') throw conflict('INVALID_STATE', `Block is ${blk.status}`);
    return camel(await endBlock(ctx, q, blk, actor, 'LIFTED', reason));
  });
}

// ---------------------------------------------------------------- admin view of vendors

export async function adminVendorList(ctx: Ctx, actor: Actor) {
  const vs = await ctx.db.query<any>('SELECT id, legal_name_en, legal_name_ar, cr_number, status, company_grade, vendor_category, fee_exempt FROM vendors WHERE tenant_id=$1 ORDER BY legal_name_en', [actor.tenantId]);
  const out = [];
  for (const v of vs) {
    const l = await lifecycleView(ctx.db, actor.tenantId, v.id);
    out.push({ ...camel(v), subscription: { status: l.subscription.status, paidUntil: l.subscription.paidUntil, daysLeft: l.subscription.daysLeft },
      block: l.block, exemption: l.exemption, classifications: l.classifications });
  }
  return out;
}

// ---------------------------------------------------------------- jobs (expiry, NOT-001 reminders, reinstatement)

/**
 * Runs the lifecycle jobs for one entity (or all). Reminders: for each ACTIVE subscription that is the vendor's latest
 * period, the smallest crossed threshold of renewalReminderDays is sent once; every crossed threshold is recorded so
 * no threshold is ever sent twice.
 */
export async function runLifecycleJobs(ctx: Ctx, tenantId?: string) {
  const at = now();
  const tenants = tenantId ? [tenantId] : (await ctx.db.query<{ id: string }>(`SELECT id FROM tenants WHERE status='ACTIVE'`)).map((r) => r.id);
  const result = { reinstated: 0, expired: 0, reminders: 0 };
  for (const tid of tenants) {
    // 1. automatic reinstatement at the block end date (FR-014)
    const due = await ctx.db.query<BlockRow>(`SELECT * FROM vendor_blocks WHERE tenant_id=$1 AND status='ACTIVE' AND mode='DATE_RANGE' AND ends_at <= $2`, [tid, at]);
    for (const blk of due) {
      const r = await ctx.db.tx((q) => endBlock(ctx, q, blk, SYSTEM_ACTOR, 'ENDED', 'Block period ended (automatic reinstatement)'));
      if (r) result.reinstated++;
    }
    // 2. expiry
    const exp = await ctx.db.query<SubscriptionRow>(`SELECT * FROM vendor_subscriptions WHERE tenant_id=$1 AND status='ACTIVE' AND ends_at <= $2`, [tid, at]);
    for (const s of exp) {
      await ctx.db.tx(async (q) => {
        const rows = await q.query(`UPDATE vendor_subscriptions SET status='EXPIRED' WHERE id=$1 AND status='ACTIVE' RETURNING id`, [s.id]);
        if (!rows.length) return;
        await auditTx(ctx, q, { tenantId: tid, actor: SYSTEM_ACTOR, action: 'SUBSCRIPTION_EXPIRED', resourceType: 'VENDOR', resourceId: s.vendor_id,
          prevState: 'ACTIVE', newState: 'EXPIRED', details: { subscriptionId: s.id, endsAt: new Date(s.ends_at!).toISOString() } });
        const renewed = (await q.query(`SELECT 1 FROM vendor_subscriptions WHERE vendor_id=$1 AND status='ACTIVE' AND ends_at > $2`, [s.vendor_id, at])).length;
        if (!renewed) await notify(q, { tenantId: tid, vendorId: s.vendor_id, kind: 'SUBSCRIPTION_EXPIRED', titleEn: 'Your annual subscription has expired',
          titleAr: 'انتهى اشتراككم السنوي', body: { subscriptionId: s.id } });
        result.expired++;
      });
    }
    // 3. NOT-001 renewal reminders
    const p = await policiesOf(ctx.db, tid);
    if (!p.renewalReminderDays.length) continue;
    const active = await ctx.db.query<SubscriptionRow>(`SELECT * FROM vendor_subscriptions s WHERE tenant_id=$1 AND status='ACTIVE' AND ends_at > $2
        AND NOT EXISTS (SELECT 1 FROM vendor_subscriptions o WHERE o.vendor_id=s.vendor_id AND o.status='ACTIVE' AND o.ends_at > s.ends_at)`, [tid, at]);
    for (const s of active) {
      const daysLeft = (new Date(s.ends_at!).getTime() - at.getTime()) / DAY;
      const crossed = p.renewalReminderDays.filter((d) => daysLeft <= d);
      if (!crossed.length) continue;
      await ctx.db.tx(async (q) => {
        const sent = new Set((await q.query<{ threshold_days: number }>('SELECT threshold_days FROM subscription_reminders WHERE subscription_id=$1', [s.id])).map((r) => r.threshold_days));
        const fresh = crossed.filter((d) => !sent.has(d));
        if (!fresh.length) return;
        for (const d of fresh) await q.query('INSERT INTO subscription_reminders (subscription_id, threshold_days, sent_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [s.id, d, at]);
        const threshold = Math.min(...fresh);
        const left = Math.max(0, Math.ceil(daysLeft));
        const end = new Date(s.ends_at!).toISOString().slice(0, 10);
        await notify(q, { tenantId: tid, vendorId: s.vendor_id, kind: 'SUBSCRIPTION_RENEWAL_REMINDER',
          titleEn: `Renewal reminder: your subscription ends on ${end} (${left} day${left === 1 ? '' : 's'} left)`,
          titleAr: `تذكير بالتجديد: ينتهي اشتراككم في ${end} (متبقٍ ${left} يوم)`,
          templateCode: 'NOT-001_SUBSCRIPTION_RENEWAL', body: { brd: 'NOT-001', subscriptionId: s.id, threshold, endsAt: end } });
        await auditTx(ctx, q, { tenantId: tid, actor: SYSTEM_ACTOR, action: 'SUBSCRIPTION_REMINDER_SENT', resourceType: 'VENDOR', resourceId: s.vendor_id,
          details: { subscriptionId: s.id, threshold, thresholdsRecorded: fresh, daysLeft: left } });
        result.reminders++;
      });
    }
  }
  return result;
}

/** Interval job (unref'd). Errors are logged once per message; a closed database ends the job quietly. */
export function startLifecycleJob(ctx: Ctx, intervalMs: number): NodeJS.Timeout {
  let lastErr = '';
  const timer = setInterval(() => {
    runLifecycleJobs(ctx).catch((e) => {
      const m = (e as Error).message ?? String(e);
      if (/closed/i.test(m)) { clearInterval(timer); return; }
      if (m !== lastErr) console.error('[lifecycle-job] failed:', m);
      lastErr = m;
    });
  }, intervalMs);
  timer.unref();
  return timer;
}

/** NOT-002: a new vendor application notifies the grading function (roles from the entity policy). */
export async function notifyApplicationReceived(q: Queryable, tenantId: string, vendorId: string, nameEn: string, nameAr: string) {
  const p = await policiesOf(q, tenantId);
  for (const role of p.gradingRoles) await notifyRole(q, tenantId, role, { kind: 'VENDOR_APPLICATION_RECEIVED',
    titleEn: `New vendor application: ${nameEn}`, titleAr: `طلب تسجيل مورد جديد: ${nameAr}`, templateCode: 'NOT-002_NEW_VENDOR_APPLICATION', body: { brd: 'NOT-002', vendorId } });
}
