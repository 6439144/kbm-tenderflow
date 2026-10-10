// Vendor self-registration, documents and approval.
import type { Ctx } from '../ctx.js';
import { auditTx } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import { badRequest, camel, conflict, forbidden, isUuid, notFound, now, reqStr, str, uuid } from '../util.js';
import { newObjectCustom, withCustom } from '../lowcode/objects.js';
import { insertUser, publicUser, validatePassword } from './identity.js';
import { insertDocument, publicDoc, putDocument, validateUpload, type DocumentRow, type UploadFile } from './documents.js';
import { emitDocumentEvent } from './document-events.js';
import { notifyApplicationReceived } from './vendor-lifecycle.js';
import { policiesOf } from './entity-policies.js';
import { publicEntity } from '../tenancy.js';

export interface VendorRow {
  id: string; tenant_id: string; legal_name_en: string; legal_name_ar: string; cr_number: string; email: string;
  phone: string | null; categories: string[]; status: string; decision_reason: string | null; decided_by: string | null;
  created_at: Date; decided_at: Date | null;
}

export async function registerVendor(ctx: Ctx, body: any) {
  // Dedicated installation: suppliers register with this entity only; another tenantId → 404 (tenancy.ts).
  const tenantId = publicEntity(ctx.config, body?.tenantId) ?? reqStr(body?.tenantId, 'tenantId', 40);
  const t = await ctx.db.query(`SELECT 1 FROM tenants WHERE id=$1 AND status='ACTIVE'`, [tenantId]);
  if (!t.length) throw notFound('Tenant');
  const categories = Array.isArray(body?.categories) ? body.categories.filter((c: unknown) => typeof c === 'string' && c.trim()).map((c: string) => c.trim()) : [];
  if (!categories.length) throw badRequest('categories must be a non-empty array');
  const email = reqStr(body?.email, 'email', 200);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('email is invalid');
  validatePassword(body?.password);
  const v = {
    id: uuid(), legalNameEn: reqStr(body?.legalNameEn, 'legalNameEn', 300), legalNameAr: reqStr(body?.legalNameAr, 'legalNameAr', 300),
    crNumber: reqStr(body?.crNumber, 'crNumber', 50), phone: str(body?.phone, 'phone', { max: 50 }) ?? null,
  };
  // Low-code: the public fields of the entity's vendor form (validated; the form version is pinned on the vendor).
  const custom = await newObjectCustom(ctx.db, tenantId, 'VENDOR', body?.customFields, { vendorSelf: true });
  return ctx.db.tx(async (q) => {
    const dup = await q.query('SELECT 1 FROM vendors WHERE tenant_id=$1 AND cr_number=$2', [tenantId, v.crNumber]);
    if (dup.length) throw conflict('VENDOR_EXISTS', 'A vendor with this CR number is already registered');
    const rows = await q.query<VendorRow>(
      `INSERT INTO vendors (id, tenant_id, legal_name_en, legal_name_ar, cr_number, email, phone, categories, status, created_at, custom_fields, custom_form)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],'PENDING_REVIEW',$9,$10::jsonb,$11::jsonb) RETURNING *`,
      [v.id, tenantId, v.legalNameEn, v.legalNameAr, v.crNumber, email, v.phone, categories, now(), JSON.stringify(custom.values), custom.pin ? JSON.stringify(custom.pin) : null]);
    const user = await insertUser(ctx, q, { id: 'SELF_REGISTRATION', roles: ['VENDOR'] }, {
      tenantId, username: body?.username, password: body.password, displayName: v.legalNameEn, roles: ['VENDOR'], vendorId: v.id,
    });
    await auditTx(ctx, q, { tenantId, actor: { id: user.id, roles: ['VENDOR'] }, action: 'VENDOR_REGISTERED', resourceType: 'VENDOR',
      resourceId: v.id, newState: 'PENDING_REVIEW', details: { crNumber: v.crNumber, categories } });
    await notifyApplicationReceived(q, tenantId, v.id, v.legalNameEn, v.legalNameAr); // NOT-002
    return { vendor: await withCustom(q, rows[0] as any, camel(rows[0]), true), user: publicUser(user) };
  });
}

export async function getVendorRow(ctx: Ctx, tenantId: string, id: string): Promise<VendorRow> {
  if (!isUuid(id)) throw notFound('Vendor');
  const rows = await ctx.db.query<VendorRow>('SELECT * FROM vendors WHERE id=$1 AND tenant_id=$2', [id, tenantId]);
  if (!rows[0]) throw notFound('Vendor');
  return rows[0];
}

async function vendorDocs(ctx: Ctx, tenantId: string, vendorId: string) {
  const docs = await ctx.db.query<DocumentRow>(`SELECT * FROM documents WHERE tenant_id=$1 AND vendor_id=$2 AND owner_type='VENDOR' ORDER BY created_at`, [tenantId, vendorId]);
  return docs.map(publicDoc);
}

export async function myVendor(ctx: Ctx, actor: Actor) {
  if (!actor.vendorId) throw forbidden('Not a vendor user');
  const v = await getVendorRow(ctx, actor.tenantId, actor.vendorId);
  return { ...(await withCustom(ctx.db, v as any, camel(v), true)), documents: await vendorDocs(ctx, actor.tenantId, v.id) };
}

export async function uploadVendorDocument(ctx: Ctx, actor: Actor, file: UploadFile | undefined, title: unknown) {
  if (!actor.vendorId) throw forbidden('Not a vendor user');
  const v = await getVendorRow(ctx, actor.tenantId, actor.vendorId);
  const f = validateUpload(file);
  const prepared = await putDocument(ctx, {
    tenantId: actor.tenantId, ownerType: 'VENDOR', ownerId: v.id, vendorId: v.id, title: str(title, 'title', { max: 300 }) ?? f.originalname,
    fileName: f.originalname, mimeType: f.detectedMime, bytes: f.buffer, uploadedBy: actor.id,
  });
  const doc = await ctx.db.tx(async (q) => {
    const d = await insertDocument(q, prepared);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'VENDOR_DOCUMENT_UPLOADED', resourceType: 'DOCUMENT', resourceId: d.id,
      details: { vendorId: v.id, sha256: d.sha256_plain, title: d.title } });
    return d;
  });
  emitDocumentEvent(ctx, { type: 'UPLOADED', tenantId: actor.tenantId, documentIds: [doc.id], actor });
  return publicDoc(doc);
}

export async function listVendors(ctx: Ctx, actor: Actor, status?: unknown) {
  const s = typeof status === 'string' && status ? status : null;
  const rows = await ctx.db.query<VendorRow>(
    `SELECT * FROM vendors WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC`, [actor.tenantId, s]);
  return camel(rows);
}

export async function getVendor(ctx: Ctx, actor: Actor, id: string) {
  const v = await getVendorRow(ctx, actor.tenantId, id);
  return { ...(await withCustom(ctx.db, v as any, camel(v), false)), documents: await vendorDocs(ctx, actor.tenantId, v.id) };
}

export async function decideVendor(ctx: Ctx, actor: Actor, id: string, body: any) {
  const decision = body?.decision;
  if (decision !== 'APPROVE' && decision !== 'REJECT') throw badRequest("decision must be 'APPROVE' or 'REJECT'");
  const reason = str(body?.reason, 'reason', { max: 2000 }) ?? null;
  if (decision === 'REJECT' && !reason) throw badRequest('reason is required when rejecting');
  const v = await getVendorRow(ctx, actor.tenantId, id);
  if (v.status !== 'PENDING_REVIEW') throw conflict('INVALID_STATE', `Vendor is ${v.status}, not PENDING_REVIEW`);
  // An entity with an annual subscription grades applications in the grading queue (grades + payment link, FR-016/017).
  if ((await policiesOf(ctx.db, actor.tenantId)).subscriptionRequired)
    throw conflict('GRADING_REQUIRED', 'This entity decides vendor applications in the grading queue (grades and subscription link): POST /grading/vendors/:id/decision');
  const newState = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  return ctx.db.tx(async (q) => {
    const rows = await q.query<VendorRow>(
      `UPDATE vendors SET status=$1, decision_reason=$2, decided_by=$3, decided_at=$4 WHERE id=$5 AND tenant_id=$6 AND status='PENDING_REVIEW' RETURNING *`,
      [newState, reason, actor.id, now(), id, actor.tenantId]);
    if (!rows[0]) throw conflict('INVALID_STATE', 'Vendor state changed concurrently');
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: decision === 'APPROVE' ? 'VENDOR_APPROVED' : 'VENDOR_REJECTED',
      resourceType: 'VENDOR', resourceId: id, prevState: 'PENDING_REVIEW', newState, reason });
    return camel(rows[0]);
  });
}
