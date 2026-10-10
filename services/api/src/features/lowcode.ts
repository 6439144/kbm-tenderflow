// LOW-CODE feature: Process Studio API (forms, rules, simulator, process map, integrations, packages), tasks, and the
// background jobs for event automation and webhook delivery. docs/LOW-CODE-STUDIO.md
import type express from 'express';
import type { Ctx } from '../ctx.js';
import { STAFF_ROLES } from '../ctx.js';
import { actor, h, requireRoles } from '../routes.js';
import { badRequest, notFound } from '../util.js';
import { registerJob, runJob } from '../services/scheduler.js';
import * as defs from '../lowcode/definitions.js';
import * as studio from '../lowcode/studio.js';
import * as hooks from '../lowcode/webhooks.js';
import { completeTask, listRuns, listTasks, runAutomation } from '../lowcode/automation.js';
import { liveForm, tenderProcessView } from '../lowcode/gates.js';
import { publicDefinition } from '../lowcode/forms.js';
import { loadTender } from '../services/tenders.js';
import { isStaff } from '../ctx.js';
import { updateVendorCustom } from '../lowcode/objects.js';

export const AUTOMATION_JOB = 'lowcode-automation';
export const WEBHOOK_JOB = 'webhook-deliveries';

const ms = (name: string, def: number) => Math.max(1000, Number(process.env[name] ?? def) || def);

export function registerLowcodeRoutes(r: express.Router, ctx: Ctx) {
  registerJob(AUTOMATION_JOB, ms('LOWCODE_AUTOMATION_MS', 5000), (c, o) => runAutomation(c, { tenantId: o.tenantId }),
    { labelEn: 'Process rules: run event and schedule automations', labelAr: 'قواعد الإجراءات: تنفيذ الأتمتة للأحداث والجداول' });
  registerJob(WEBHOOK_JOB, ms('LOWCODE_WEBHOOK_MS', 10000), (c, o) => hooks.deliverDue(c, { tenantId: o.tenantId }),
    { labelEn: 'Integrations: send queued webhook events and retry failures', labelAr: 'التكاملات: إرسال الأحداث المنتظرة وإعادة المحاولة' });

  const admin = requireRoles('TENANT_ADMIN');
  const readers = requireRoles('TENANT_ADMIN', 'AUDITOR');
  const staff = requireRoles(...STAFF_ROLES);

  // Studio: catalogue, definitions (forms + rule set), versions, simulator, process map
  r.get('/lowcode/catalog', staff, h((req) => studio.catalog(ctx, actor(req))));
  r.get('/lowcode/definitions', readers, h((req) => defs.listDefinitions(ctx, actor(req), req.query.kind)));
  r.get('/lowcode/definitions/:id', readers, h((req) => defs.getDefinition(ctx, actor(req), req.params.id)));
  r.get('/lowcode/history/:kind/:code', readers, h((req) => defs.definitionHistory(ctx, actor(req), req.params.kind, req.params.code)));
  r.post('/lowcode/definitions', admin, h(async (req, res) => { res.status(201); return defs.createDraft(ctx, actor(req), req.body); }));
  r.patch('/lowcode/definitions/:id', admin, h((req) => defs.updateDraft(ctx, actor(req), req.params.id, req.body)));
  r.delete('/lowcode/definitions/:id', admin, h((req) => defs.discardDraft(ctx, actor(req), req.params.id)));
  r.post('/lowcode/definitions/:id/publish', admin, h((req) => defs.publishDefinition(ctx, actor(req), req.params.id)));
  r.post('/lowcode/check', admin, h((req) => defs.checkDefinition(ctx, actor(req), req.body)));
  r.post('/lowcode/simulate', readers, h((req) => studio.simulate(ctx, actor(req), req.body)));
  r.get('/lowcode/process-map', staff, h((req) => studio.processMap(ctx, actor(req), req.query as Record<string, unknown>)));
  r.get('/lowcode/runs', readers, h((req) => listRuns(ctx, actor(req), req.query as Record<string, unknown>)));
  r.post('/lowcode/run-now', admin, h(async (req) => ({ automation: await runJob(ctx, AUTOMATION_JOB, { trigger: 'MANUAL', tenantId: actor(req).tenantId }) })));

  // Live forms for the screens that render custom fields (staff); vendors get the public part of the tender form.
  r.get('/lowcode/forms/:code', h(async (req) => {
    const code = String(req.params.code).toUpperCase();
    if (!['TENDER', 'REQUEST', 'VENDOR'].includes(code)) throw notFound('Form');
    const a = actor(req);
    if (!isStaff(a) && code === 'REQUEST') throw notFound('Form');
    const f = await liveForm(ctx.db, a.tenantId, code as any);
    if (!f) return { form: null };
    return { form: { id: f.pin.id, version: f.pin.version, definition: isStaff(a) ? f.def : publicDefinition(f.def) } };
  }));

  // Tender process panel (custom values, gate previews, tasks, automation log)
  r.get('/tenders/:id/process', h(async (req) => {
    const a = actor(req);
    const t = await loadTender(ctx, a, req.params.id);
    return tenderProcessView(ctx, a, t as any, isStaff(a));
  }));

  // Staff edit of a vendor's custom fields (incl. internal ones)
  r.patch('/vendors/:id/custom-fields', requireRoles('TENANT_ADMIN', 'PROCUREMENT_OFFICER', 'GRADING_AUTHORITY'),
    h((req) => updateVendorCustom(ctx, actor(req), req.params.id, req.body)));

  // Tasks created by rules
  r.get('/lowcode/tasks', staff, h((req) => listTasks(ctx, actor(req), req.query as Record<string, unknown>)));
  r.post('/lowcode/tasks/:id/complete', staff, h((req) => completeTask(ctx, actor(req), req.params.id, req.body)));
  r.post('/lowcode/tasks/:id/cancel', admin, h((req) => completeTask(ctx, actor(req), req.params.id, req.body, true)));

  // Integrations (webhooks)
  r.get('/lowcode/webhooks', readers, h((req) => hooks.listEndpoints(ctx, actor(req))));
  r.post('/lowcode/webhooks', admin, h(async (req, res) => { res.status(201); return hooks.createEndpoint(ctx, actor(req), req.body); }));
  r.patch('/lowcode/webhooks/:id', admin, h((req) => hooks.updateEndpoint(ctx, actor(req), req.params.id, req.body)));
  r.post('/lowcode/webhooks/:id/rotate-secret', admin, h((req) => hooks.rotateSecret(ctx, actor(req), req.params.id)));
  r.post('/lowcode/webhooks/:id/test', admin, h((req) => hooks.sendTest(ctx, actor(req), req.params.id)));
  r.get('/lowcode/webhook-deliveries', readers, h((req) => hooks.listDeliveries(ctx, actor(req), req.query as Record<string, unknown>)));
  r.post('/lowcode/webhook-deliveries/:id/retry', admin, h((req) => hooks.retryDelivery(ctx, actor(req), req.params.id)));

  // Configuration packages
  r.get('/lowcode/package', admin, h((req) => studio.exportPackage(ctx, actor(req))));
  r.post('/lowcode/package/preview', admin, h((req) => studio.previewImport(ctx, actor(req), req.body?.package ?? req.body)));
  r.post('/lowcode/package/import', admin, h((req) => {
    if (req.body?.confirm !== true) throw badRequest('Send { package, confirm: true } after reviewing the preview');
    return studio.importPackage(ctx, actor(req), req.body.package);
  }));
}

/** Vendor self-registration renders the public fields of the entity's vendor form before login. */
export function registerLowcodePublicRoutes(r: express.Router, ctx: Ctx) {
  r.get('/public/forms/vendor', h(async (req) => {
    const tenant = typeof req.query.tenant === 'string' && /^[a-z0-9_-]{2,40}$/.test(req.query.tenant) ? req.query.tenant : null;
    if (!tenant) throw badRequest('tenant is required');
    const f = await liveForm(ctx.db, tenant, 'VENDOR');
    return { form: f ? { id: f.pin.id, version: f.pin.version, definition: publicDefinition(f.def) } : null };
  }));
}
