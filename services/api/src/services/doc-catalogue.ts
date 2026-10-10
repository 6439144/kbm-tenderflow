// Document-type catalogue per entity: what the document-intelligence agent may classify a document as, in which upload
// contexts, and which fields it may extract (EN/AR labels, type, required). Installed with defaults for every tenant;
// TENANT_ADMIN edits it. Personal identity numbers (civil ID, passport) are never catalogue fields.
import type { Ctx } from '../ctx.js';
import { auditTx } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import type { Queryable } from '../db.js';
import type { DocFieldType, DocTypeDef, DocTypeField } from '../ai/index.js';
import { badRequest, camel, conflict, isUuid, notFound, now, reqStr, uuid } from '../util.js';

export const DOC_CONTEXTS = ['VENDOR', 'BID_TECHNICAL', 'BID_FINANCIAL', 'TENDER_PACK', 'ADDENDUM', 'REQUEST_LETTER', 'ENTITY'] as const;
export type DocContext = (typeof DOC_CONTEXTS)[number];
export const FIELD_TYPES: DocFieldType[] = ['text', 'date', 'amount', 'number', 'list'];

/** Owner types of documents people upload (system-generated records are never classified). */
export const CLASSIFIABLE_OWNER_TYPES = ['VENDOR', 'TENDER_PACK', 'ADDENDUM', 'REQUEST_LETTER', 'BID_TECHNICAL', 'BID_FINANCIAL'];
export const contextOf = (ownerType: string): DocContext | null =>
  (CLASSIFIABLE_OWNER_TYPES.includes(ownerType) ? (ownerType as DocContext) : null);

export interface DocumentTypeRow {
  id: string; tenant_id: string; code: string; contexts: string[]; name_en: string; name_ar: string; fields: DocTypeField[];
  active: boolean; created_at: Date; updated_at: Date;
}

const F = (key: string, labelEn: string, labelAr: string, type: DocFieldType = 'text', required = false): DocTypeField => ({ key, labelEn, labelAr, type, required });
const VENDORISH: DocContext[] = ['VENDOR', 'BID_TECHNICAL'];

export const DEFAULT_DOCUMENT_TYPES: { code: string; contexts: DocContext[]; nameEn: string; nameAr: string; fields: DocTypeField[] }[] = [
  { code: 'COMMERCIAL_REGISTRATION', contexts: VENDORISH, nameEn: 'Commercial registration', nameAr: 'السجل التجاري', fields: [
    F('crNumber', 'CR number', 'رقم السجل التجاري', 'text', true), F('companyName', 'Company name', 'اسم الشركة', 'text', true),
    F('issueDate', 'Issue date', 'تاريخ الإصدار', 'date'), F('expiryDate', 'Expiry date', 'تاريخ الانتهاء', 'date', true),
    F('activities', 'Activities', 'الأنشطة', 'list')] },
  { code: 'MOCI_CLASSIFICATION_CERT', contexts: VENDORISH, nameEn: 'MOCI classification certificate', nameAr: 'شهادة تصنيف وزارة التجارة', fields: [
    F('activityCodes', 'Activity codes', 'رموز الأنشطة', 'list', true), F('grade', 'Grade', 'الدرجة', 'text', true),
    F('expiryDate', 'Expiry date', 'تاريخ الانتهاء', 'date', true)] },
  { code: 'CHAMBER_OF_COMMERCE_CERT', contexts: VENDORISH, nameEn: 'Chamber of Commerce certificate', nameAr: 'شهادة غرفة التجارة', fields: [
    F('membershipNumber', 'Membership number', 'رقم العضوية', 'text', true), F('expiryDate', 'Expiry date', 'تاريخ الانتهاء', 'date', true)] },
  { code: 'BANK_GUARANTEE', contexts: ['VENDOR', 'BID_TECHNICAL', 'BID_FINANCIAL'], nameEn: 'Bank guarantee', nameAr: 'كفالة بنكية', fields: [
    F('bank', 'Issuing bank', 'البنك المصدر', 'text', true), F('amount', 'Amount', 'المبلغ', 'amount', true), F('currency', 'Currency', 'العملة'),
    F('validUntil', 'Valid until', 'سارية حتى', 'date', true), F('beneficiary', 'Beneficiary', 'المستفيد')] },
  { code: 'ISO_CERTIFICATE', contexts: VENDORISH, nameEn: 'ISO certificate', nameAr: 'شهادة آيزو', fields: [
    F('standard', 'Standard', 'المعيار', 'text', true), F('certificationBody', 'Certification body', 'جهة الإصدار'),
    F('expiryDate', 'Expiry date', 'تاريخ الانتهاء', 'date', true)] },
  { code: 'COMPANY_PROFILE', contexts: VENDORISH, nameEn: 'Company profile', nameAr: 'نبذة عن الشركة', fields: [
    F('yearsInBusiness', 'Years in business', 'سنوات الخبرة', 'number'), F('keyClients', 'Key clients', 'أبرز العملاء', 'list')] },
  { code: 'TECHNICAL_PROPOSAL', contexts: ['BID_TECHNICAL'], nameEn: 'Technical proposal', nameAr: 'العرض الفني', fields: [
    F('deliveryPeriod', 'Delivery period', 'مدة التنفيذ'), F('warrantyPeriod', 'Warranty period', 'مدة الضمان'),
    F('keyPersonnel', 'Key personnel', 'الكوادر الرئيسية', 'list')] },
  { code: 'FINANCIAL_PROPOSAL', contexts: ['BID_FINANCIAL'], nameEn: 'Financial proposal', nameAr: 'العرض المالي', fields: [
    F('totalAmount', 'Total amount', 'المبلغ الإجمالي', 'amount', true), F('currency', 'Currency', 'العملة'),
    F('validityDays', 'Validity (days)', 'مدة السريان (أيام)', 'number'), F('paymentTerms', 'Payment terms', 'شروط الدفع')] },
  { code: 'TENDER_PACK', contexts: ['TENDER_PACK', 'ADDENDUM'], nameEn: 'Tender pack', nameAr: 'كراسة الشروط', fields: [
    F('submissionDeadline', 'Submission deadline', 'آخر موعد للتقديم', 'date'), F('bidBondAmount', 'Bid bond amount', 'قيمة الكفالة الأولية', 'amount'),
    F('bidValidityDays', 'Bid validity (days)', 'مدة سريان العطاء (أيام)', 'number'), F('evaluationCriteria', 'Evaluation criteria', 'معايير التقييم', 'list')] },
  { code: 'ADDENDUM', contexts: ['ADDENDUM', 'TENDER_PACK'], nameEn: 'Addendum', nameAr: 'ملحق', fields: [
    F('changesSummary', 'Changes', 'التعديلات'), F('newDeadline', 'New deadline', 'الموعد الجديد', 'date')] },
  { code: 'GM_LETTER', contexts: ['REQUEST_LETTER', 'ENTITY'], nameEn: 'GM letter', nameAr: 'كتاب المدير العام', fields: [
    F('department', 'Department', 'الإدارة', 'text', true), F('subject', 'Subject', 'الموضوع', 'text', true),
    F('estimatedBudget', 'Estimated budget', 'الميزانية التقديرية', 'amount'), F('letterDate', 'Letter date', 'تاريخ الكتاب', 'date'),
    F('referenceNumber', 'Reference number', 'الرقم المرجعي')] },
  { code: 'OTHER', contexts: [...DOC_CONTEXTS], nameEn: 'Other document', nameAr: 'مستند آخر', fields: [] },
];

/** Personal identity numbers must never become extraction targets. */
const PERSONAL_ID = /civil\s*_?id|civilid|passport|national\s*_?id|nationalid|personal\s*_?id|البطاقه المدنيه|البطاقة المدنية|الرقم المدني|جواز/i;

export async function installDefaultDocumentTypes(q: Queryable, tenantId: string): Promise<number> {
  let n = 0;
  for (const t of DEFAULT_DOCUMENT_TYPES) {
    const r = await q.query(
      `INSERT INTO document_types (id, tenant_id, code, contexts, name_en, name_ar, fields, active, created_at, updated_at)
       VALUES ($1,$2,$3,$4::text[],$5,$6,$7::jsonb,true,$8,$8) ON CONFLICT (tenant_id, code) DO NOTHING RETURNING id`,
      [uuid(), tenantId, t.code, t.contexts, t.nameEn, t.nameAr, JSON.stringify(t.fields), now()]);
    n += r.length;
  }
  return n;
}

/** Tenants created before migration 003 get the defaults on first use. */
export async function ensureCatalogue(ctx: Ctx, tenantId: string): Promise<void> {
  const any = await ctx.db.query('SELECT 1 FROM document_types WHERE tenant_id=$1 LIMIT 1', [tenantId]);
  if (any.length) return;
  await ctx.db.tx(async (q) => {
    const n = await installDefaultDocumentTypes(q, tenantId);
    if (n) await auditTx(ctx, q, { tenantId, actor: { id: 'SYSTEM', roles: ['SYSTEM'] }, action: 'DOCUMENT_TYPES_INSTALLED', resourceType: 'TENANT', resourceId: tenantId, details: { count: n } });
  });
}

export async function catalogueRows(ctx: Ctx, tenantId: string, opts: { includeInactive?: boolean } = {}): Promise<DocumentTypeRow[]> {
  await ensureCatalogue(ctx, tenantId);
  return ctx.db.query<DocumentTypeRow>(
    `SELECT * FROM document_types WHERE tenant_id=$1 AND ($2::boolean OR active) ORDER BY (code='OTHER'), name_en`, [tenantId, !!opts.includeInactive]);
}

export const toDef = (r: DocumentTypeRow): DocTypeDef => ({ code: r.code, nameEn: r.name_en, nameAr: r.name_ar, fields: r.fields ?? [] });

/** Active types allowed for an upload context (OTHER is always offered). */
export async function catalogueFor(ctx: Ctx, tenantId: string, context: DocContext): Promise<DocTypeDef[]> {
  const rows = await catalogueRows(ctx, tenantId);
  const out = rows.filter((r) => r.contexts.includes(context)).map(toDef);
  if (!out.some((t) => t.code === 'OTHER')) out.push({ code: 'OTHER', nameEn: 'Other document', nameAr: 'مستند آخر', fields: [] });
  return out;
}

export async function typeByCode(ctx: Ctx, tenantId: string, code: string | null | undefined): Promise<DocTypeDef | null> {
  if (!code) return null;
  const rows = await catalogueRows(ctx, tenantId, { includeInactive: true });
  const r = rows.find((x) => x.code === code);
  return r ? toDef(r) : code === 'OTHER' ? { code: 'OTHER', nameEn: 'Other document', nameAr: 'مستند آخر', fields: [] } : null;
}

export const publicType = (r: DocumentTypeRow) => camel<any>({
  id: r.id, code: r.code, contexts: r.contexts, name_en: r.name_en, name_ar: r.name_ar, active: r.active, updated_at: r.updated_at,
  fields: (r.fields ?? []).map((f) => ({ key: f.key, labelEn: f.labelEn, labelAr: f.labelAr, type: f.type, required: !!f.required })),
});

export function parseFields(raw: unknown): DocTypeField[] {
  if (!Array.isArray(raw)) throw badRequest('fields must be an array');
  if (raw.length > 30) throw badRequest('at most 30 fields per document type');
  const seen = new Set<string>();
  return raw.map((f: any, i: number) => {
    const key = reqStr(f?.key, `fields[${i}].key`, 60);
    if (!/^[a-z][A-Za-z0-9]{0,59}$/.test(key)) throw badRequest(`fields[${i}].key must be camelCase letters/digits (e.g. expiryDate)`);
    if (seen.has(key)) throw badRequest(`duplicate field key ${key}`);
    seen.add(key);
    const labelEn = reqStr(f?.labelEn, `fields[${i}].labelEn`, 120);
    const labelAr = reqStr(f?.labelAr, `fields[${i}].labelAr`, 120);
    if (PERSONAL_ID.test(key) || PERSONAL_ID.test(labelEn) || PERSONAL_ID.test(labelAr))
      throw badRequest('Personal identity numbers (civil ID, passport, national ID) must not be extracted', 'PERSONAL_DATA_FIELD');
    const type = (FIELD_TYPES as string[]).includes(f?.type) ? (f.type as DocFieldType) : null;
    if (!type) throw badRequest(`fields[${i}].type must be one of ${FIELD_TYPES.join(', ')}`);
    return { key, labelEn, labelAr, type, required: f?.required === true };
  });
}

export function parseContexts(raw: unknown): string[] {
  if (!Array.isArray(raw) || !raw.length) throw badRequest('contexts must be a non-empty array');
  const bad = raw.filter((c) => !(DOC_CONTEXTS as readonly string[]).includes(c));
  if (bad.length) throw badRequest(`unknown context(s): ${bad.join(', ')}; allowed: ${DOC_CONTEXTS.join(', ')}`);
  return [...new Set(raw as string[])];
}

export async function listDocumentTypes(ctx: Ctx, actor: Actor, includeInactive: boolean) {
  return (await catalogueRows(ctx, actor.tenantId, { includeInactive })).map(publicType);
}

export async function createDocumentType(ctx: Ctx, actor: Actor, b: any) {
  await ensureCatalogue(ctx, actor.tenantId);
  const code = reqStr(b?.code, 'code', 60).toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,59}$/.test(code)) throw badRequest('code must be UPPER_SNAKE_CASE');
  const contexts = parseContexts(b?.contexts);
  const fields = parseFields(b?.fields ?? []);
  const nameEn = reqStr(b?.nameEn, 'nameEn', 200); const nameAr = reqStr(b?.nameAr, 'nameAr', 200);
  return ctx.db.tx(async (q) => publicType(await insertDocumentType(ctx, q, actor, { code, contexts, fields, nameEn, nameAr, active: b?.active !== false })));
}

/** Insert a document type inside the caller's transaction (inputs already parsed). 409 if the code exists. Audited. */
export async function insertDocumentType(ctx: Ctx, q: Queryable, actor: Actor,
  d: { code: string; contexts: string[]; fields: DocTypeField[]; nameEn: string; nameAr: string; active: boolean }, auditDetails: Record<string, unknown> = {}): Promise<DocumentTypeRow> {
  const dup = await q.query('SELECT 1 FROM document_types WHERE tenant_id=$1 AND code=$2', [actor.tenantId, d.code]);
  if (dup.length) throw conflict('DOCUMENT_TYPE_EXISTS', `Document type ${d.code} already exists`);
  const rows = await q.query<DocumentTypeRow>(
    `INSERT INTO document_types (id, tenant_id, code, contexts, name_en, name_ar, fields, active, created_at, updated_at)
     VALUES ($1,$2,$3,$4::text[],$5,$6,$7::jsonb,$8,$9,$9) RETURNING *`,
    [uuid(), actor.tenantId, d.code, d.contexts, d.nameEn, d.nameAr, JSON.stringify(d.fields), d.active, now()]);
  await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'DOCUMENT_TYPE_CREATED', resourceType: 'DOCUMENT_TYPE', resourceId: rows[0].id,
    details: { code: d.code, contexts: d.contexts, fields: d.fields.map((f) => f.key), ...(d.active ? {} : { active: false }), ...auditDetails } });
  return rows[0];
}

export async function patchDocumentType(ctx: Ctx, actor: Actor, id: string, b: any) {
  if (!isUuid(id)) throw notFound('Document type');
  const cur = (await ctx.db.query<DocumentTypeRow>('SELECT * FROM document_types WHERE id=$1 AND tenant_id=$2', [id, actor.tenantId]))[0];
  if (!cur) throw notFound('Document type');
  const contexts = b?.contexts !== undefined ? parseContexts(b.contexts) : cur.contexts;
  const fields = b?.fields !== undefined ? parseFields(b.fields) : cur.fields;
  if (cur.code === 'OTHER' && fields.length) throw badRequest('OTHER has no fields');
  const nameEn = b?.nameEn !== undefined ? reqStr(b.nameEn, 'nameEn', 200) : cur.name_en;
  const nameAr = b?.nameAr !== undefined ? reqStr(b.nameAr, 'nameAr', 200) : cur.name_ar;
  const active = typeof b?.active === 'boolean' ? b.active : cur.active;
  if (cur.code === 'OTHER' && !active) throw badRequest('OTHER cannot be deactivated (it is the fallback type)');
  return ctx.db.tx(async (q) => {
    const rows = await q.query<DocumentTypeRow>(
      `UPDATE document_types SET contexts=$1::text[], fields=$2::jsonb, name_en=$3, name_ar=$4, active=$5, updated_at=$6 WHERE id=$7 RETURNING *`,
      [contexts, JSON.stringify(fields), nameEn, nameAr, active, now(), id]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'DOCUMENT_TYPE_UPDATED', resourceType: 'DOCUMENT_TYPE', resourceId: id,
      prevState: cur.active ? 'ACTIVE' : 'INACTIVE', newState: active ? 'ACTIVE' : 'INACTIVE', details: { code: cur.code, contexts, fields: fields.map((f) => f.key) } });
    return publicType(rows[0]);
  });
}
