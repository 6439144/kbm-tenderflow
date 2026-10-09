// NOTIFY feature: notification templates + channels + delivery log, background jobs (scheduler), approval service
// levels with reminders / escalation, and the tender "reject" approval path. docs/NOTIFICATIONS-AND-ESCALATION.md
import type express from 'express';
import type { Ctx } from '../ctx.js';
import { STAFF_ROLES } from '../ctx.js';
import { actor, h, requireRoles } from '../routes.js';
import { notFound } from '../util.js';
import { onDocumentEvent } from '../services/document-events.js';
import { notify } from '../services/notifications.js';
import { listJobs, registerJob, registeredJobs, requestRun, runJob, startScheduler } from '../services/scheduler.js';
import * as admin from './notify/admin.js';
import { dispatchDue } from './notify/dispatcher.js';
import { installDefaultTemplates, notifyRuntime } from './notify/engine.js';
import { getSla, overdueApprovals, runEscalation, slaForSubject, updateSla } from './notify/escalation.js';
import { rejectTender } from './notify/approval-paths.js';

const ADMIN = 'TENANT_ADMIN';
export const DELIVERY_JOB = 'notification-deliveries';
export const ESCALATION_JOB = 'approval-escalation';

function startRuntime(ctx: Ctx) {
  const cfg = ctx.config.notify;
  notifyRuntime.config = cfg;
  notifyRuntime.publicBaseUrl = ctx.config.publicBaseUrl;
  notifyRuntime.kick = cfg.sendImmediately ? () => requestRun(ctx, DELIVERY_JOB, 300) : null;
  registerJob(DELIVERY_JOB, cfg.deliveryJobMs, (c, o) => dispatchDue(c, { tenantId: o.tenantId }),
    { labelEn: 'Send queued e-mail / SMS and retry failures', labelAr: 'إرسال البريد والرسائل النصية المنتظرة وإعادة المحاولة' });
  registerJob(ESCALATION_JOB, cfg.escalationJobMs, (c, o) => runEscalation(c, { tenantId: o.tenantId }),
    { labelEn: 'Approval service levels: reminders and escalation', labelAr: 'مستويات خدمة الاعتماد: التذكير والتصعيد' });
  startScheduler(ctx, { enabled: cfg.schedulerEnabled }).catch((err) => console.error('[scheduler] start failed:', (err as Error).message));

  // Vendors whose bids were opened are told so (rule-based; after the opening transaction committed).
  onDocumentEvent(ctx, async (c, e) => {
    if (e.type !== 'BIDS_OPENED') return;
    const t = (await c.db.query<any>('SELECT id, tender_number, tenant_id FROM tenders WHERE id=$1 AND tenant_id=$2', [e.tenderId, e.tenantId]))[0];
    if (!t) return;
    await c.db.tx(async (q) => {
      const vendors = await q.query<{ vendor_id: string }>('SELECT DISTINCT vendor_id FROM bids WHERE tender_id=$1', [t.id]);
      for (const v of vendors) await notify(q, { tenantId: t.tenant_id, vendorId: v.vendor_id, kind: 'BIDS_OPENED', body: { tenderId: t.id },
        titleEn: `Bids opened: ${t.tender_number}`, titleAr: `تم فتح العطاءات: ${t.tender_number}` });
    });
  });
}

export function registerNotifyRoutes(r: express.Router, ctx: Ctx) {
  startRuntime(ctx);
  const staff = requireRoles(...STAFF_ROLES);
  const readers = requireRoles(ADMIN, 'AUDITOR');

  // Templates
  r.get('/admin/notification-templates', readers, h((req) => admin.listTemplates(ctx, actor(req))));
  r.get('/admin/notification-templates/:code', readers, h((req) => admin.getTemplate(ctx, actor(req), req.params.code)));
  r.post('/admin/notification-templates/:code/preview', requireRoles(ADMIN), h((req) => admin.previewTemplate(ctx, actor(req), req.params.code, req.body)));
  r.patch('/admin/notification-templates/:code', requireRoles(ADMIN), h((req) => admin.updateTemplate(ctx, actor(req), req.params.code, req.body)));
  r.post('/admin/notification-templates/:code/test', requireRoles(ADMIN), h((req) => admin.sendTest(ctx, actor(req), req.params.code)));

  // Delivery log + channel status
  r.get('/admin/notification-deliveries', readers, h((req) => admin.deliveries(ctx, actor(req), req.query as Record<string, unknown>)));
  r.post('/admin/notification-deliveries/:id/retry', requireRoles(ADMIN), h((req) => admin.retryDelivery(ctx, actor(req), req.params.id)));

  // Contacts used for e-mail / SMS of staff users
  r.get('/notifications/contact', staff, h((req) => admin.myContact(ctx, actor(req))));
  r.put('/notifications/contact', staff, h((req) => admin.setContact(ctx, actor(req), actor(req).id, req.body)));
  r.put('/admin/notification-contacts/:userId', requireRoles(ADMIN), h((req) => admin.setContact(ctx, actor(req), req.params.userId, req.body)));

  // Background jobs
  r.get('/admin/jobs', readers, h(() => listJobs(ctx)));
  r.post('/admin/jobs/:name/run', requireRoles(ADMIN), h(async (req) => {
    if (!registeredJobs().some((j) => j.name === req.params.name)) throw notFound('Job');
    return runJob(ctx, req.params.name, { tenantId: actor(req).tenantId, trigger: 'MANUAL' });
  }));

  // Approval service levels
  r.get('/admin/approval-sla', staff, h((req) => getSla(ctx.db, actor(req).tenantId)));
  r.put('/admin/approval-sla', requireRoles(ADMIN), h((req) => updateSla(ctx, actor(req), req.body)));
  r.get('/approvals/overdue', staff, h((req) => overdueApprovals(ctx, actor(req))));
  r.get('/approvals/sla', staff, h((req) => slaForSubject(ctx, actor(req), String(req.query.subjectId ?? ''))));

  // Approval paths: reject a tender's publication approval
  r.post('/tenders/:id/reject', requireRoles('DIRECTOR', 'UNDERSECRETARY', 'COMMITTEE_CHAIR', ADMIN), h((req) => rejectTender(ctx, actor(req), req.params.id, req.body)));
}

/** Demo seed hook (one call at the end of seed.ts): templates for every entity and a sample approval service level. */
export async function seedNotifications(ctx: Ctx) {
  const tenants = await ctx.db.query<{ id: string }>('SELECT id FROM tenants');
  await ctx.db.tx(async (q) => {
    for (const t of tenants) {
      await installDefaultTemplates(q, t.id);
      await q.query(`INSERT INTO approval_sla_settings (tenant_id, default_due_hours, escalate_to, remind_before_hours, updated_by)
                     VALUES ($1, 48, 'NEXT_LEVEL_ROLE', 8, 'SYSTEM') ON CONFLICT (tenant_id) DO NOTHING`, [t.id]);
    }
  });
}
