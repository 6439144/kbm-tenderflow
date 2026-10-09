// Routes of the MOI workstream (generic product features configured for MOI): entity policies, vendor categories,
// grading queue + application decisions, subscription payment/renewal, grade upgrades, fee exemption, blocking,
// printable receipts, lifecycle jobs (expiry, NOT-001 reminders, automatic reinstatement), activity-code file import.
import type express from 'express';
import { registerJob } from '../services/scheduler.js';
import multer from 'multer';
import type { Ctx } from '../ctx.js';
import { auditTx, isStaff, STAFF_ROLES } from '../ctx.js';
import { actor, h, requireRoles } from '../routes.js';
import { MAX_UPLOAD_BYTES, type UploadFile } from '../services/documents.js';
import { policiesRow, updatePolicies } from '../services/entity-policies.js';
import * as life from '../services/vendor-lifecycle.js';
import { badRequest, reqStr } from '../util.js';
import { catalogueFor } from './moi-brd.js';

const ADMIN = 'TENANT_ADMIN';
const files = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 5, fields: 20 } });

/** FILE source for activity codes: one "code,name EN,name AR" per line (header line optional). */
async function importActivityCodes(ctx: Ctx, a: ReturnType<typeof actor>, body: any) {
  const text = reqStr(body?.csv, 'csv', 200_000);
  const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => l.split(/[,;\t]/).map((x) => x.trim().replace(/^"|"$/g, '')))
    .filter((r, i) => !(i === 0 && /^code$/i.test(r[0] ?? '')));
  if (!rows.length) throw badRequest('No rows found (expected: code, English name, Arabic name)');
  if (rows.length > 2000) throw badRequest('At most 2000 rows per import');
  for (const [i, r] of rows.entries()) {
    if (r.length < 3 || !/^[A-Za-z0-9_.-]{1,40}$/.test(r[0]) || !r[1] || !r[2]) throw badRequest(`Line ${i + 1}: expected "code, English name, Arabic name"`);
  }
  await ctx.db.tx(async (q) => {
    for (const r of rows) await q.query(`INSERT INTO activity_codes (tenant_id, code, name_en, name_ar) VALUES ($1,$2,$3,$4)
      ON CONFLICT (tenant_id, code) DO UPDATE SET name_en=EXCLUDED.name_en, name_ar=EXCLUDED.name_ar`, [a.tenantId, r[0], r[1].slice(0, 200), r[2].slice(0, 200)]);
    await auditTx(ctx, q, { tenantId: a.tenantId, actor: a, action: 'ACTIVITY_CODES_IMPORTED', resourceType: 'ACTIVITY_CODE', resourceId: null,
      details: { rows: rows.length, codes: rows.slice(0, 50).map((r) => r[0]) } });
  });
  return { imported: rows.length };
}

export function registerMoiRoutes(r: express.Router, ctx: Ctx) {
  const staff = requireRoles(...STAFF_ROLES);

  // ---- entity policies (any signed-in user may read the effective rules; only the administrator edits)
  r.get('/entity/policies', h(async (req) => {
    const row = await policiesRow(ctx.db, actor(req).tenantId);
    return { ...row, catalogue: isStaff(actor(req)) ? catalogueFor(row.reference) : null };
  }));
  r.put('/entity/policies', requireRoles(ADMIN), h(async (req) => {
    const row = await updatePolicies(ctx, actor(req), req.body);
    return { ...row, catalogue: catalogueFor(row.reference) };
  }));

  // ---- vendor categories (fee exemption by category)
  r.get('/vendor-categories', staff, h((req) => life.listVendorCategories(ctx, actor(req).tenantId)));
  r.post('/vendor-categories', requireRoles(ADMIN), h((req) => life.upsertVendorCategory(ctx, actor(req), req.body)));

  // ---- grading authority (roles from the entity policy; checked in the service)
  r.get('/grading/queue', staff, h((req) => life.gradingQueue(ctx, actor(req))));
  r.get('/grading/vendors/:id', staff, h((req) => life.gradingVendor(ctx, actor(req), req.params.id)));
  r.post('/grading/vendors/:id/decision', staff, h((req) => life.gradeVendor(ctx, actor(req), req.params.id, req.body)));

  // ---- grade upgrades
  r.post('/vendor/me/grade-upgrades', requireRoles('VENDOR'), files.array('files', 5), h(async (req, res) => {
    res.status(201);
    return life.createUpgradeRequest(ctx, actor(req), req.body, (req.files ?? []) as UploadFile[]);
  }));
  r.get('/grade-upgrades', h((req) => life.listUpgradeRequests(ctx, actor(req))));
  r.get('/grade-upgrades/:id', h((req) => life.getUpgradeRequest(ctx, actor(req), req.params.id)));
  r.post('/grade-upgrades/:id/decision', staff, h((req) => life.decideUpgrade(ctx, actor(req), req.params.id, req.body)));

  // ---- subscription (vendor)
  r.get('/vendor/me/lifecycle', requireRoles('VENDOR'), h((req) => life.lifecycleView(ctx.db, actor(req).tenantId, actor(req).vendorId!)));
  r.post('/vendor/me/subscription/pay', requireRoles('VENDOR'), h((req) => life.paySubscription(ctx, actor(req), req.body)));
  r.post('/vendor/me/subscription/renew', requireRoles('VENDOR'), h(async (req, res) => { res.status(201); return life.requestRenewal(ctx, actor(req)); }));

  // ---- administrator: lifecycle overview, exemption, blocking
  r.get('/vendors/:id/lifecycle', staff, h((req) => life.lifecycleView(ctx.db, actor(req).tenantId, req.params.id)));
  r.get('/admin/vendor-lifecycle', requireRoles(ADMIN, 'AUDITOR'), h((req) => life.adminVendorList(ctx, actor(req))));
  r.post('/vendors/:id/exemption', requireRoles(ADMIN), h((req) => life.setVendorExemption(ctx, actor(req), req.params.id, req.body)));
  r.post('/vendors/:id/blocks', staff, h(async (req, res) => { res.status(201); return life.blockVendor(ctx, actor(req), req.params.id, req.body); }));
  r.post('/vendors/:id/blocks/:blockId/lift', staff, h((req) => life.liftBlock(ctx, actor(req), req.params.id, req.params.blockId, req.body)));

  // ---- receipts (vendor own; staff any) — FR-007 printable, FR-022 MOI number series + gateway transaction id
  r.get('/receipts/:number', h((req) => life.receiptView(ctx, actor(req), req.params.number)));

  // ---- jobs: run now (administrator; used by tests and the demo), plus the interval job
  r.post('/admin/lifecycle/run-jobs', requireRoles(ADMIN), h((req) => life.runLifecycleJobs(ctx, actor(req).tenantId)));
  r.post('/activity-codes/import', requireRoles(ADMIN), h((req) => importActivityCodes(ctx, actor(req), req.body)));

  const interval = Number(process.env.LIFECYCLE_JOB_INTERVAL_MS ?? 15 * 60_000);
  if (Number.isFinite(interval) && interval >= 1000) {
    // Runs on the shared durable scheduler (Admin → Background jobs, with "Run now", last result and errors).
    registerJob('vendor-lifecycle', interval, async (c, o) => ({ ...(await life.runLifecycleJobs(c, o.tenantId)) }), {
      labelEn: 'Vendor lifecycle: block reinstatement, subscription expiry, renewal reminders (NOT-001)',
      labelAr: 'دورة حياة المورد: إعادة التفعيل بعد الإيقاف، انتهاء الاشتراك، تذكيرات التجديد (NOT-001)' });
    // catch up once shortly after start (blocks that ended / subscriptions that expired while the server was down)
    const first = setTimeout(() => { life.runLifecycleJobs(ctx).catch(() => { /* reported by the interval job */ }); }, 5_000);
    first.unref();
  }
}
