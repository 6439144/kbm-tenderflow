// Vendor eligibility (BRD): Ministry of Commerce activity codes + grades (1 = First … 3 = Third), enforced on the
// server at document purchase and at bid submission. Plus tender document purchase (TEST gateway until a KNET
// merchant is available; every TEST receipt says so) and fee exemption.
import type { Ctx } from '../ctx.js';
import { auditTx, isStaff } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import type { Queryable } from '../db.js';
import { ApiError, badRequest, camel, conflict, forbidden, isUuid, notFound, now, reqStr, str, uuid } from '../util.js';
import { applyPattern, configOf, getProfile } from './templates.js';
import type { TenderRow } from './tenders.js';

export const GRADE_NAMES: Record<number, { en: string; ar: string }> = {
  1: { en: 'First grade', ar: 'الدرجة الأولى' },
  2: { en: 'Second grade', ar: 'الدرجة الثانية' },
  3: { en: 'Third grade', ar: 'الدرجة الثالثة' },
};

// ---------------- Activity codes ----------------
export async function listActivityCodes(ctx: Ctx, tenantId: string) {
  return camel(await ctx.db.query('SELECT code, name_en, name_ar FROM activity_codes WHERE tenant_id=$1 ORDER BY code', [tenantId]));
}

export async function upsertActivityCode(ctx: Ctx, actor: Actor, b: any) {
  const code = reqStr(b?.code, 'code', 40);
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(code)) throw badRequest('code may contain letters, digits, . _ -');
  const nameEn = reqStr(b?.nameEn, 'nameEn', 200);
  const nameAr = reqStr(b?.nameAr, 'nameAr', 200);
  await ctx.db.tx(async (q) => {
    await q.query(`INSERT INTO activity_codes (tenant_id, code, name_en, name_ar) VALUES ($1,$2,$3,$4)
                   ON CONFLICT (tenant_id, code) DO UPDATE SET name_en=EXCLUDED.name_en, name_ar=EXCLUDED.name_ar`, [actor.tenantId, code, nameEn, nameAr]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'ACTIVITY_CODE_SAVED', resourceType: 'ACTIVITY_CODE', resourceId: code });
  });
  return { code, nameEn, nameAr };
}

// ---------------- Vendor classifications ----------------
export async function vendorClassifications(db: Queryable, tenantId: string, vendorId: string) {
  return camel<any[]>(await db.query(
    `SELECT c.activity_code, c.grade, c.valid_until, a.name_en, a.name_ar FROM vendor_classifications c
       LEFT JOIN activity_codes a ON a.tenant_id=c.tenant_id AND a.code=c.activity_code
      WHERE c.tenant_id=$1 AND c.vendor_id=$2 ORDER BY c.activity_code`, [tenantId, vendorId]));
}

export async function setClassification(ctx: Ctx, actor: Actor, vendorId: string, b: any) {
  if (!isUuid(vendorId)) throw notFound('Vendor');
  const v = await ctx.db.query('SELECT 1 FROM vendors WHERE id=$1 AND tenant_id=$2', [vendorId, actor.tenantId]);
  if (!v.length) throw notFound('Vendor');
  const code = reqStr(b?.activityCode, 'activityCode', 40);
  const known = await ctx.db.query('SELECT 1 FROM activity_codes WHERE tenant_id=$1 AND code=$2', [actor.tenantId, code]);
  if (!known.length) throw badRequest(`Unknown activity code '${code}'`);
  const remove = b?.remove === true;
  const grade = Number(b?.grade);
  if (!remove && ![1, 2, 3].includes(grade)) throw badRequest('grade must be 1 (First), 2 (Second) or 3 (Third)');
  const validUntil = str(b?.validUntil, 'validUntil', { max: 10 }) ?? null;
  if (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) throw badRequest('validUntil must be YYYY-MM-DD');
  await ctx.db.tx(async (q) => {
    const prev = (await q.query<{ grade: number }>('SELECT grade FROM vendor_classifications WHERE vendor_id=$1 AND activity_code=$2', [vendorId, code]))[0];
    if (remove) await q.query('DELETE FROM vendor_classifications WHERE vendor_id=$1 AND activity_code=$2', [vendorId, code]);
    else await q.query(
      `INSERT INTO vendor_classifications (tenant_id, vendor_id, activity_code, grade, valid_until, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (vendor_id, activity_code) DO UPDATE SET grade=EXCLUDED.grade,
         valid_until=EXCLUDED.valid_until, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
      [actor.tenantId, vendorId, code, grade, validUntil, actor.id, now()]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: remove ? 'VENDOR_CLASSIFICATION_REMOVED' : 'VENDOR_CLASSIFICATION_SET',
      resourceType: 'VENDOR', resourceId: vendorId, prevState: prev ? String(prev.grade) : null, newState: remove ? null : String(grade),
      details: { activityCode: code, validUntil } });
  });
  return vendorClassifications(ctx.db, actor.tenantId, vendorId);
}

// ---------------- Eligibility ----------------
export interface EligibilityRule { activityCodes: string[]; minGrade: number | null }
export interface EligibilityResult { eligible: boolean; rule: EligibilityRule; reasons: { code: string; en: string; ar: string }[] }

/** The rule of a tender: per-tender override if set, else the template's. */
export function ruleOf(t: TenderRow): EligibilityRule {
  const own = (t as any).eligibility ?? {};
  const tpl = configOf(t as any).eligibility;
  return {
    activityCodes: Array.isArray(own.activityCodes) && own.activityCodes.length ? own.activityCodes : tpl.activityCodes,
    minGrade: own.minGrade ?? tpl.minGrade ?? null,
  };
}

export async function checkEligibility(db: Queryable, t: TenderRow, vendorId: string): Promise<EligibilityResult> {
  const rule = ruleOf(t);
  const reasons: EligibilityResult['reasons'] = [];
  if (!rule.activityCodes.length && rule.minGrade === null) return { eligible: true, rule, reasons };
  const cls = await db.query<{ activity_code: string; grade: number; valid_until: string | Date | null }>(
    'SELECT activity_code, grade, valid_until FROM vendor_classifications WHERE vendor_id=$1 AND tenant_id=$2', [vendorId, t.tenant_id]);
  const today = now().toISOString().slice(0, 10);
  const valid = cls.filter((c) => !c.valid_until || new Date(c.valid_until).toISOString().slice(0, 10) >= today);
  const relevant = rule.activityCodes.length ? valid.filter((c) => rule.activityCodes.includes(c.activity_code)) : valid;
  if (rule.activityCodes.length && !relevant.length)
    reasons.push({ code: 'ACTIVITY_CODE', en: `Requires one of the activity codes ${rule.activityCodes.join(', ')}`, ar: `يتطلب أحد رموز النشاط ${rule.activityCodes.join('، ')}` });
  if (rule.minGrade !== null) {
    const best = relevant.length ? Math.min(...relevant.map((c) => Number(c.grade))) : null;
    if (best === null || best > rule.minGrade) {
      const g = GRADE_NAMES[rule.minGrade];
      reasons.push({ code: 'GRADE', en: `Requires ${g.en} or better${best ? ` (vendor holds ${GRADE_NAMES[best].en})` : ''}`,
        ar: `يتطلب ${g.ar} أو أعلى${best ? ` (تصنيف المورد ${GRADE_NAMES[best].ar})` : ''}` });
    }
  }
  return { eligible: reasons.length === 0, rule, reasons };
}

/** Throws 403 NOT_ELIGIBLE with the reasons. */
export async function assertEligible(db: Queryable, t: TenderRow, vendorId: string) {
  const r = await checkEligibility(db, t, vendorId);
  if (!r.eligible) throw new ApiError(403, 'NOT_ELIGIBLE', `Vendor is not eligible for this tender: ${r.reasons.map((x) => x.en).join('; ')}`, { reasons: r.reasons });
}

// ---------------- Document purchase ----------------
export async function purchaseOf(db: Queryable, tenderId: string, vendorId: string) {
  return (await db.query<any>('SELECT * FROM tender_purchases WHERE tender_id=$1 AND vendor_id=$2', [tenderId, vendorId]))[0] ?? null;
}

/** Throws 402 PURCHASE_REQUIRED when the template requires paid documents and the vendor has no purchase. */
export async function assertPurchased(db: Queryable, t: TenderRow, vendorId: string) {
  if (!configOf(t as any).stages.documentPurchase) return;
  if (!(await purchaseOf(db, t.id, vendorId)))
    throw new ApiError(402, 'PURCHASE_REQUIRED', 'Tender documents must be purchased before bidding');
}

async function nextReceipt(q: Queryable, tenantId: string, pattern: string | undefined): Promise<string> {
  const n = Number((await q.query<{ n: string }>('SELECT count(*)::text AS n FROM tender_purchases WHERE tenant_id=$1', [tenantId]))[0].n) + 1;
  return applyPattern(pattern || `${tenantId.toUpperCase()}-R-{YYYY}-{SEQ5}`, n);
}

/**
 * Vendor buys the tender documents. gateway 'TEST' simulates a payment and is labelled TEST everywhere;
 * 'KNET' is refused until a merchant is configured (KNET_MERCHANT_ID) — no fake success.
 */
export async function purchaseDocuments(ctx: Ctx, actor: Actor, t: TenderRow, b: any) {
  if (!actor.vendorId) throw forbidden('Only vendor users can purchase tender documents');
  const cfg = configOf(t as any);
  if (!cfg.stages.documentPurchase) throw conflict('NOT_REQUIRED', 'This tender does not require a document purchase');
  if (t.status !== 'PUBLISHED' || now() >= new Date(t.submission_deadline)) throw conflict('INVALID_STATE', 'Documents can be purchased only while the tender is open');
  await assertEligible(ctx.db, t, actor.vendorId);
  const gateway = b?.gateway === 'KNET' ? 'KNET' : 'TEST';
  if (gateway === 'KNET' && !process.env.KNET_MERCHANT_ID)
    throw new ApiError(503, 'KNET_NOT_CONFIGURED', 'KNET is not configured for this entity (KNET_MERCHANT_ID). Use the TEST gateway in the demo.');
  if (await purchaseOf(ctx.db, t.id, actor.vendorId)) throw conflict('ALREADY_PURCHASED', 'Documents already purchased');
  const pattern = (await getProfile(ctx, actor.tenantId)).receiptPattern;
  return ctx.db.tx(async (q) => {
    const receipt = await nextReceipt(q, actor.tenantId, pattern);
    const rows = await q.query(
      `INSERT INTO tender_purchases (id, tenant_id, tender_id, vendor_id, amount, currency, gateway, payment_ref, receipt_number, status, paid_by, paid_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PAID',$10,$11) RETURNING *`,
      [uuid(), actor.tenantId, t.id, actor.vendorId, cfg.fees.documentPrice, cfg.fees.currency, gateway, `${gateway}-${uuid().slice(0, 8).toUpperCase()}`,
        receipt, actor.id, now()]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'TENDER_DOCUMENTS_PURCHASED', resourceType: 'TENDER', resourceId: t.id,
      details: { vendorId: actor.vendorId, amount: cfg.fees.documentPrice, currency: cfg.fees.currency, gateway, receipt } });
    return camel(rows[0]);
  });
}

/** Staff grants a fee exemption (template must allow it). */
export async function exemptVendor(ctx: Ctx, actor: Actor, t: TenderRow, b: any) {
  const cfg = configOf(t as any);
  if (!cfg.stages.documentPurchase) throw conflict('NOT_REQUIRED', 'This tender does not require a document purchase');
  if (!cfg.fees.exemptionAllowed) throw conflict('EXEMPTION_NOT_ALLOWED', 'The cycle template of this tender does not allow fee exemptions');
  const vendorId = reqStr(b?.vendorId, 'vendorId', 60);
  if (!isUuid(vendorId)) throw notFound('Vendor');
  const reason = reqStr(b?.reason, 'reason', 2000);
  if (await purchaseOf(ctx.db, t.id, vendorId)) throw conflict('ALREADY_PURCHASED', 'Vendor already has the documents');
  const pattern = (await getProfile(ctx, actor.tenantId)).receiptPattern;
  return ctx.db.tx(async (q) => {
    const receipt = await nextReceipt(q, actor.tenantId, pattern);
    const rows = await q.query(
      `INSERT INTO tender_purchases (id, tenant_id, tender_id, vendor_id, amount, currency, gateway, receipt_number, status, paid_by, paid_at)
       VALUES ($1,$2,$3,$4,0,$5,'EXEMPT',$6,'EXEMPTED',$7,$8) RETURNING *`, [uuid(), actor.tenantId, t.id, vendorId, cfg.fees.currency, receipt, actor.id, now()]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'TENDER_FEE_EXEMPTED', resourceType: 'TENDER', resourceId: t.id, reason,
      details: { vendorId, receipt } });
    return camel(rows[0]);
  });
}

export async function listPurchases(ctx: Ctx, actor: Actor, t: TenderRow) {
  if (!isStaff(actor)) {
    return actor.vendorId ? camel(await purchaseOf(ctx.db, t.id, actor.vendorId)) : null;
  }
  return camel(await ctx.db.query(
    `SELECT p.*, v.legal_name_en, v.legal_name_ar FROM tender_purchases p JOIN vendors v ON v.id=p.vendor_id WHERE p.tender_id=$1 ORDER BY p.paid_at`, [t.id]));
}
