// NOTIFY: templates (render, both languages, admin edit audited, tenant isolation), channels not configured → SKIPPED
// (never SENT), scheduler single-run guard, approval SLA reminders / escalation, tender reject path.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, fileForm, login, makeTenant, makeUser, startApp, tenderBody, PASSWORD, type Running } from './helpers.js';
import { setClockOffset } from '../src/util.js';
import { notify } from '../src/services/notifications.js';
import { render } from '../src/features/notify/engine.js';
import { registerJob, runJob } from '../src/services/scheduler.js';

let run: Running;
after(async () => { setClockOffset(0); if (run) await run.stop(); });
const HOUR = 3_600_000;

test('render: placeholders in EN and AR, language-specific values, missing values never invented, Kuwait time', () => {
  const vars = { vendorNameEn: 'Acme', vendorNameAr: 'أكمي', grade: 2, dueAt: '2026-10-10T06:00:00.000Z' };
  assert.equal(render('Dear {vendorName}, grade {grade}', vars, 'en'), 'Dear Acme, grade 2');
  assert.equal(render('السادة {vendorName}، الدرجة {grade}', vars, 'ar'), 'السادة أكمي، الدرجة 2');
  assert.equal(render('Link: {knetLink}', vars, 'en'), 'Link: —');
  assert.equal(render('Due {dueAt}', vars, 'en'), 'Due 2026-10-10 09:00'); // UTC+3
});

test('notifications through templates and channels; admin templates; tenant isolation; scheduler; SLA escalation; reject', async () => {
  run = await startApp();
  const ctx = run.handle.ctx;
  for (const tn of ['ent', 'other']) {
    await makeTenant(run, tn);
    for (const [u, r] of [['officer', 'PROCUREMENT_OFFICER'], ['director', 'DIRECTOR'], ['under', 'UNDERSECRETARY'], ['admin', 'TENANT_ADMIN'], ['auditor', 'AUDITOR']] as const)
      await makeUser(run, tn, u, [r]);
  }
  const [officer, director, under, admin, auditor] = await Promise.all(['officer', 'director', 'under', 'admin', 'auditor'].map((u) => login(run, 'ent', u)));
  const otherAdmin = await login(run, 'other', 'admin');

  // ---- templates are installed lazily per entity with the BRD set and the system events
  const list = await api(run, 'GET', '/api/v1/admin/notification-templates', { token: admin });
  assert.equal(list.status, 200, list.text);
  const codes = list.body.templates.map((t: any) => t.code);
  for (const c of ['NOT-001_SUBSCRIPTION_RENEWAL', 'NOT-002_NEW_VENDOR_APPLICATION', 'NOT-003_GRADE_UPGRADE_APPROVED', 'NOT-004_REGISTRATION_APPROVED',
    'NOT-005_VENDOR_BLOCKED', 'APPROVAL_WAITING', 'TENDER_PUBLISHED', 'CLARIFICATION_ANSWERED', 'BIDS_OPENED', 'AWARD_APPROVED', 'DOCUMENT_EXPIRING',
    'DOCUMENT_EXPIRED', 'DOCUMENT_INSIGHT_READY', 'APPROVAL_ESCALATED', 'APPROVAL_REMINDER']) assert.ok(codes.includes(c), c);
  assert.equal(list.body.channels.EMAIL.configured, false);
  assert.equal(list.body.channels.SMS.configured, false);
  assert.equal((await api(run, 'GET', '/api/v1/admin/notification-templates', { token: officer })).status, 403);
  assert.equal((await api(run, 'GET', '/api/v1/admin/notification-templates', { token: auditor })).status, 200, 'auditor may read');

  // ---- admin edit: preview with sample values (both languages), unknown placeholder refused, edit audited
  const prev = await api(run, 'POST', '/api/v1/admin/notification-templates/NOT-001_SUBSCRIPTION_RENEWAL/preview', { token: admin,
    json: { subjectEn: 'Renew by {expiryDate}: {vendorName}', subjectAr: 'جددوا قبل {expiryDate}: {vendorName}' } });
  assert.equal(prev.status, 200, prev.text);
  assert.match(prev.body.en.subject, /^Renew by 2026-11-30: Al-Sample Trading Co\./);
  assert.match(prev.body.ar.subject, /^جددوا قبل 2026-11-30: شركة النموذج/);
  assert.match(prev.body.en.body, /Tenant ent/, 'entity name is the real entity');
  const bad = await api(run, 'PATCH', '/api/v1/admin/notification-templates/NOT-001_SUBSCRIPTION_RENEWAL', { token: admin, json: { subjectEn: 'Hi {vendr}' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'UNKNOWN_PLACEHOLDER');
  assert.equal((await api(run, 'PATCH', '/api/v1/admin/notification-templates/NOT-001_SUBSCRIPTION_RENEWAL', { token: officer, json: { subjectEn: 'x' } })).status, 403);
  const ed = await api(run, 'PATCH', '/api/v1/admin/notification-templates/NOT-001_SUBSCRIPTION_RENEWAL', { token: admin,
    json: { subjectEn: 'Renew by {expiryDate}: {vendorName}', subjectAr: 'جددوا قبل {expiryDate}: {vendorName}', channels: ['IN_APP', 'EMAIL', 'SMS'] } });
  assert.equal(ed.status, 200, ed.text);
  assert.equal(ed.body.subjectEn, 'Renew by {expiryDate}: {vendorName}');
  const aud = await api(run, 'GET', '/api/v1/audit?limit=20', { token: auditor });
  const ev = aud.body.find((e: any) => e.action === 'NOTIFICATION_TEMPLATE_UPDATED');
  assert.ok(ev, 'template edit audited');
  assert.deepEqual(ev.details.changed.sort(), ['subjectAr', 'subjectEn']);
  assert.equal(ev.details.before.subjectEn, 'Subscription renewal due: {vendorName}');

  // other entity: own (default) text, cannot see this entity's edit
  const ol = await api(run, 'GET', '/api/v1/admin/notification-templates/NOT-001_SUBSCRIPTION_RENEWAL', { token: otherAdmin });
  assert.equal(ol.body.subjectEn, 'Subscription renewal due: {vendorName}');

  // ---- a vendor; NOT-001 through the existing notify() with a template code (as the MOI workstream calls it)
  const reg = await api(run, 'POST', '/api/v1/public/vendors/register', { json: { tenantId: 'ent', legalNameEn: 'Acme Trading (fictitious)', legalNameAr: 'أكمي للتجارة (وهمية)',
    crNumber: 'CR-1', email: 'acme@vendor.test', phone: '+96550000000', categories: ['IT'], username: 'acme', password: PASSWORD } });
  assert.equal(reg.status, 201, reg.text);
  const vendorId = reg.body.vendor.id;
  await api(run, 'POST', `/api/v1/vendors/${vendorId}/decision`, { token: officer, json: { decision: 'APPROVE', reason: 'ok' } });
  const acme = await login(run, 'ent', 'acme');
  const res = await ctx.db.tx((q) => notify(q, { tenantId: 'ent', vendorId, kind: 'SUBSCRIPTION_RENEWAL', templateCode: 'NOT-001',
    titleEn: 'Subscription renewal', titleAr: 'تجديد الاشتراك', body: { expiryDate: '2026-12-01', daysLeft: 52, renewalLink: 'https://pay.example/renew' } }));
  assert.equal(res.templateCode, 'NOT-001_SUBSCRIPTION_RENEWAL');
  assert.deepEqual(res.deliveries.map((d) => [d.channel, d.status]), [['IN_APP', 'SENT'], ['EMAIL', 'SKIPPED_NOT_CONFIGURED'], ['SMS', 'SKIPPED_NOT_CONFIGURED']]);
  const vn = await api(run, 'GET', '/api/v1/notifications', { token: acme });
  const n1 = vn.body.find((n: any) => n.kind === 'SUBSCRIPTION_RENEWAL');
  assert.equal(n1.titleEn, 'Renew by 2026-12-01: Acme Trading (fictitious)');
  assert.equal(n1.titleAr, 'جددوا قبل 2026-12-01: أكمي للتجارة (وهمية)');
  assert.match(n1.body.messageEn, /expires on 2026-12-01 \(52 days left\).*https:\/\/pay\.example\/renew/);

  // delivery log: filters, never SENT for an unconfigured channel, tenant isolation
  const log = await api(run, 'GET', '/api/v1/admin/notification-deliveries?templateCode=NOT-001', { token: admin });
  assert.equal(log.status, 200, log.text);
  assert.deepEqual(log.body.items.map((d: any) => d.channel).sort(), ['EMAIL', 'IN_APP', 'SMS']);
  assert.ok(log.body.items.every((d: any) => d.channel === 'IN_APP' ? d.status === 'SENT' : d.status === 'SKIPPED_NOT_CONFIGURED'));
  assert.equal(log.body.items.find((d: any) => d.channel === 'EMAIL').address, 'acme@vendor.test');
  const skipped = await api(run, 'GET', '/api/v1/admin/notification-deliveries?status=SKIPPED_NOT_CONFIGURED', { token: admin });
  assert.equal(skipped.body.items.length, 2);
  const otherLog = await api(run, 'GET', '/api/v1/admin/notification-deliveries', { token: otherAdmin });
  assert.equal(otherLog.body.items.length, 0, 'delivery log is per entity');
  assert.equal((await api(run, 'GET', '/api/v1/admin/notification-deliveries', { token: officer })).status, 403);

  // test send to me: in-app SENT; e-mail skipped (not configured) — never reported as sent
  const ts = await api(run, 'POST', '/api/v1/admin/notification-templates/NOT-001_SUBSCRIPTION_RENEWAL/test', { token: admin });
  assert.equal(ts.status, 200, ts.text);
  assert.deepEqual(ts.body.deliveries.map((d: any) => [d.channel, d.status]), [['EMAIL', 'SKIPPED_NOT_CONFIGURED'], ['IN_APP', 'SENT'], ['SMS', 'SKIPPED_NOT_CONFIGURED']]);
  const mine = await api(run, 'GET', '/api/v1/notifications', { token: admin });
  assert.ok(mine.body.some((n: any) => n.titleEn.startsWith('[TEST] Renew by 2026-11-30')));

  // disabled template → nothing is delivered
  await api(run, 'PATCH', '/api/v1/admin/notification-templates/NOT-005_VENDOR_BLOCKED', { token: admin, json: { enabled: false } });
  const off = await ctx.db.tx((q) => notify(q, { tenantId: 'ent', vendorId, kind: 'NOT-005', titleEn: 'x', titleAr: 'x' }));
  assert.equal(off.skipped, 'TEMPLATE_DISABLED');

  // ---- existing events go through templates (approval waiting) + clarification answered (new event)
  const rfp = (await api(run, 'POST', '/api/v1/templates/install-starters', { token: admin })).body.find((t: any) => t.code === 'RFP_TWO_ENVELOPE');
  const CRIT = [{ key: 'technical', nameEn: 'Technical', nameAr: 'فني', weight: 70 }, { key: 'price', nameEn: 'Price', nameAr: 'السعر', weight: 30 }];
  const mkTender = async (templateId?: string) => {
    const r = await api(run, 'POST', '/api/v1/tenders', { token: officer, json: { ...tenderBody(30 * 24 * HOUR), ...(templateId ? { templateId, criteria: CRIT, eligibility: { activityCodes: [], minGrade: null } } : {}) } });
    assert.equal(r.status, 201, r.text);
    const up = await api(run, 'POST', `/api/v1/tenders/${r.body.id}/documents`, { token: officer, form: fileForm({ file: { name: 'pack.md', content: '# 1. Scope\nTest.' } }) });
    assert.equal(up.status, 201, up.text);
    return r.body as { id: string; tenderNumber: string };
  };

  // ---- approval SLA: settings (admin), reminder before due, one escalation per level + notification + audit
  assert.equal((await api(run, 'PUT', '/api/v1/admin/approval-sla', { token: officer, json: { defaultDueHours: 2 } })).status, 403);
  assert.equal((await api(run, 'PUT', '/api/v1/admin/approval-sla', { token: admin, json: { defaultDueHours: -1 } })).status, 400);
  const sla = await api(run, 'PUT', '/api/v1/admin/approval-sla', { token: admin, json: { defaultDueHours: 2, remindBeforeHours: 1, escalateTo: 'NEXT_LEVEL_ROLE' } });
  assert.equal(sla.status, 200, sla.text);
  assert.equal(sla.body.defaultDueHours, 2);

  const t2 = await mkTender(rfp.id); // two levels: director → undersecretary
  const runEsc = async () => {
    const r = await api(run, 'POST', '/api/v1/admin/jobs/approval-escalation/run', { token: admin });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.status, 'OK', r.text);
    return r.body.result;
  };
  let r0 = await runEsc();
  assert.equal(r0.reminders, 0);
  assert.equal(r0.escalations, 0);
  const s0 = await api(run, 'GET', `/api/v1/approvals/sla?subjectId=${t2.id}`, { token: director });
  assert.equal(s0.body.items.length, 1);
  assert.equal(s0.body.items[0].state, 'ON_TIME');
  assert.equal(s0.body.items[0].role, 'DIRECTOR');

  setClockOffset(1.5 * HOUR);
  r0 = await runEsc();
  assert.equal(r0.reminders, 1, JSON.stringify(r0));
  assert.equal((await runEsc()).reminders, 0, 'one reminder per waiting level');
  const dn = await api(run, 'GET', '/api/v1/notifications', { token: director });
  assert.ok(dn.body.some((n: any) => n.kind === 'APPROVAL_REMINDER' && n.body.tenderId === t2.id), 'director reminded');

  setClockOffset(3 * HOUR);
  r0 = await runEsc();
  assert.equal(r0.escalations, 1, JSON.stringify(r0));
  assert.equal((await runEsc()).escalations, 0, 'one escalation per waiting level');
  const un = await api(run, 'GET', '/api/v1/notifications', { token: under });
  const esc = un.body.find((n: any) => n.kind === 'APPROVAL_ESCALATED' && n.body.tenderId === t2.id);
  assert.ok(esc, 'escalated to the next level role (undersecretary)');
  assert.equal(esc.titleEn, `Escalation: approval of ${t2.tenderNumber} is overdue`);
  assert.equal(esc.titleAr, `تصعيد: تأخر اعتماد ${t2.tenderNumber}`);
  assert.match(esc.body.messageEn, /Level 1 \(Procurement Director\) of the publication approval of .* is overdue by 1 h\./);
  assert.match(esc.body.messageAr, /متأخر بمقدار 1 ساعة/);
  const od = await api(run, 'GET', '/api/v1/approvals/overdue', { token: officer });
  assert.equal(od.status, 200, od.text);
  const item = od.body.items.find((x: any) => x.subjectId === t2.id);
  assert.ok(item);
  assert.equal(item.state, 'OVERDUE');
  assert.equal(item.escalation.escalatedTo, 'UNDERSECRETARY');
  assert.ok(item.overdueMs >= HOUR - 60_000);
  const audit = await api(run, 'GET', `/api/v1/audit?resourceId=${t2.id}`, { token: auditor });
  assert.equal(audit.body.filter((e: any) => e.action === 'APPROVAL_ESCALATED').length, 1);
  assert.equal(audit.body.filter((e: any) => e.action === 'APPROVAL_REMINDER_SENT').length, 1);
  assert.equal((await api(run, 'GET', '/api/v1/approvals/overdue', { token: acme })).status, 403, 'vendors cannot read approvals');
  assert.equal((await api(run, 'GET', '/api/v1/approvals/overdue', { token: otherAdmin })).body.items.length, 0, 'tenant isolation');
  // the approval itself was not changed by the escalation
  assert.equal((await api(run, 'GET', `/api/v1/tenders/${t2.id}`, { token: officer })).body.status, 'DRAFT');

  // level 1 approved → level 2 gets a fresh clock (not overdue yet); the new level escalates to TENANT_ADMIN (no next level)
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${t2.id}/approve`, { token: director, json: { reason: 'ok' } })).status, 200);
  const s1 = await api(run, 'GET', `/api/v1/approvals/sla?subjectId=${t2.id}`, { token: director });
  assert.equal(s1.body.items[0].level, 2);
  assert.equal(s1.body.items[0].state, 'ON_TIME');
  setClockOffset(6 * HOUR);
  assert.equal((await runEsc()).escalations, 1);
  const an = await api(run, 'GET', '/api/v1/notifications', { token: admin });
  assert.ok(an.body.some((n: any) => n.kind === 'APPROVAL_ESCALATED' && n.body.tenderId === t2.id && n.body.level === 2));
  setClockOffset(0);

  // ---- reject path (publication approval): reason required, waiting level's role only, not by creator; audited; creator notified
  const t3 = await mkTender();
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${t3.id}/reject`, { token: director, json: {} })).status, 400, 'reason required');
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${t3.id}/reject`, { token: under, json: { reason: 'no' } })).status, 403, 'level 1 is the director');
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${t3.id}/reject`, { token: officer, json: { reason: 'no' } })).status, 403);
  const rj = await api(run, 'POST', `/api/v1/tenders/${t3.id}/reject`, { token: director, json: { reason: 'Scope duplicates an existing contract' } });
  assert.equal(rj.status, 200, rj.text);
  assert.equal(rj.body.status, 'CANCELLED');
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${t3.id}/reject`, { token: director, json: { reason: 'again' } })).status, 409);
  const ra = await api(run, 'GET', `/api/v1/audit?resourceId=${t3.id}`, { token: auditor });
  const rev = ra.body.find((e: any) => e.action === 'TENDER_REJECTED');
  assert.equal(rev.reason, 'Scope duplicates an existing contract');
  assert.equal(rev.newState, 'CANCELLED');
  const on = await api(run, 'GET', '/api/v1/notifications', { token: officer });
  const rn = on.body.find((n: any) => n.kind === 'TENDER_REJECTED');
  assert.match(rn.body.messageEn, /Scope duplicates an existing contract/);
  assert.ok(!(await api(run, 'GET', `/api/v1/approvals/sla?subjectId=${t3.id}`, { token: director })).body.items.length, 'a rejected tender no longer waits');

  // ---- approval waiting (existing event) is rendered from its template; clarification answered reaches the vendor
  const t4 = await mkTender(rfp.id);
  await api(run, 'POST', `/api/v1/tenders/${t4.id}/approve`, { token: director, json: {} });
  const uw = await api(run, 'GET', '/api/v1/notifications', { token: under });
  const w = uw.body.find((n: any) => n.kind === 'APPROVAL_WAITING' && n.body.tenderId === t4.id);
  assert.equal(w.titleEn, `Approval level 2 waiting: ${t4.tenderNumber}`, 'the {title} of the existing event is kept');
  assert.match(w.body.messageEn, new RegExp(`${t4.tenderNumber} — Test Tender is waiting for your approval decision: http://tenderflow.test/procurement/tenders/${t4.id}`));
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${t4.id}/approve`, { token: under, json: {} })).body.status, 'APPROVED');
  // two-envelope eligibility: give the vendor nothing special — clarifications only need PUBLISHED
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${t4.id}/publish`, { token: officer })).status, 200);
  const cq = await api(run, 'POST', `/api/v1/tenders/${t4.id}/clarifications`, { token: acme, json: { question: 'Is delivery included?' } });
  assert.equal(cq.status, 201, cq.text);
  await api(run, 'POST', `/api/v1/clarifications/${cq.body.id}/answer`, { token: officer, json: { answer: 'Yes.' } });
  const vn2 = await api(run, 'GET', '/api/v1/notifications', { token: acme });
  const ca = vn2.body.find((n: any) => n.kind === 'CLARIFICATION_ANSWERED');
  assert.equal(ca.titleEn, `Your clarification on ${t4.tenderNumber} was answered`);
  assert.equal(ca.titleAr, `تمت الإجابة على استفساركم بشأن ${t4.tenderNumber}`);
  assert.match(ca.body.messageEn, new RegExp(`/vendor/tenders/${t4.id}`), 'vendor link goes to the vendor portal');

  // ---- staff contact for e-mail / SMS
  assert.equal((await api(run, 'PUT', '/api/v1/notifications/contact', { token: director, json: { email: 'not-an-email' } })).status, 400);
  const ct = await api(run, 'PUT', '/api/v1/notifications/contact', { token: director, json: { email: 'director@entity.test', phone: '+965 5555 0000' } });
  assert.equal(ct.status, 200, ct.text);
  assert.equal((await api(run, 'GET', '/api/v1/notifications/contact', { token: director })).body.email, 'director@entity.test');
  assert.equal((await api(run, 'PUT', '/api/v1/notifications/contact', { token: acme, json: { email: 'a@b.test' } })).status, 403);
});

test('scheduler: single-run guard, durable last run / result / error, unknown job 404', async () => {
  const ctx = run.handle.ctx;
  let release!: () => void;
  let calls = 0;
  registerJob('test-slow-job', 60_000, async () => { calls++; await new Promise<void>((r) => { release = r; }); return { done: true }; });
  registerJob('test-failing-job', 60_000, async () => { throw new Error('boom'); });
  const first = runJob(ctx, 'test-slow-job', { trigger: 'MANUAL' });
  await new Promise((r) => setTimeout(r, 50));
  const second = await runJob(ctx, 'test-slow-job', { trigger: 'MANUAL' });
  assert.equal(second.status, 'SKIPPED_RUNNING');
  // a second process (other owner) is refused by the database lease too
  const lease = await ctx.db.query<any>(`SELECT locked_until, locked_by FROM scheduled_jobs WHERE name='test-slow-job'`);
  assert.ok(lease[0].locked_until && new Date(lease[0].locked_until) > new Date());
  release();
  const r1 = await first;
  assert.equal(r1.status, 'OK');
  assert.equal(calls, 1);
  const fail = await runJob(ctx, 'test-failing-job', { trigger: 'MANUAL' });
  assert.equal(fail.status, 'ERROR');
  const admin = await login(run, 'ent', 'admin');
  const jobs = await api(run, 'GET', '/api/v1/admin/jobs', { token: admin });
  const slow = jobs.body.find((j: any) => j.name === 'test-slow-job');
  assert.equal(slow.lastStatus, 'OK');
  assert.equal(slow.runCount, 1);
  assert.equal(slow.scheduled, false, 'timers are off under node --test');
  const f = jobs.body.find((j: any) => j.name === 'test-failing-job');
  assert.equal(f.lastStatus, 'ERROR');
  assert.equal(f.lastError, 'boom');
  assert.ok(jobs.body.some((j: any) => j.name === 'notification-deliveries'));
  // an entity admin's "run now" only covers that entity; its result is not shown to another entity's admin
  const own = await api(run, 'POST', '/api/v1/admin/jobs/approval-escalation/run', { token: admin });
  assert.equal(own.body.status, 'OK', own.text);
  assert.equal(own.body.result.entities, 1);
  const mine = (await api(run, 'GET', '/api/v1/admin/jobs', { token: admin })).body.find((j: any) => j.name === 'approval-escalation');
  assert.equal(mine.lastResult.scope, 'ENTITY');
  assert.equal(mine.lastResult.tenantId, undefined);
  const theirs = (await api(run, 'GET', '/api/v1/admin/jobs', { token: await login(run, 'other', 'admin') })).body.find((j: any) => j.name === 'approval-escalation');
  assert.deepEqual(theirs.lastResult, { trigger: 'MANUAL', scope: 'OTHER_ENTITY' });
  assert.equal((await api(run, 'POST', '/api/v1/admin/jobs/nope/run', { token: admin })).status, 404);
  assert.equal((await api(run, 'POST', '/api/v1/admin/jobs/approval-escalation/run', { token: await login(run, 'ent', 'officer') })).status, 403);
});
