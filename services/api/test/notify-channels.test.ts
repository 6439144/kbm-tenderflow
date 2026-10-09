// NOTIFY channels against local fakes: SMTP (fake server receives the e-mail), SMS generic HTTP adapter, delivery job,
// exponential retries (max 3) and re-queue of a FAILED delivery.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, login, makeTenant, makeUser, sleep, startApp, PASSWORD, type Running } from './helpers.js';
import { startFakeSmtp, mailText, type FakeSmtp } from './fakes/fake-smtp.js';
import { startFakeSms, type FakeSms } from './fakes/fake-sms.js';
import { notify } from '../src/services/notifications.js';

let run: Running; let smtp: FakeSmtp; let sms: FakeSms;
after(async () => { if (run) await run.stop(); await smtp?.close(); await sms?.close(); });

test('e-mail via SMTP and SMS via HTTP: sent to the fakes, retried with back-off, FAILED after 3 attempts, re-queue', async () => {
  smtp = await startFakeSmtp({ user: 'mailer', pass: 'mail-secret' });
  sms = await startFakeSms();
  run = await startApp(undefined, { ...smtp.env, ...sms.env, NOTIFY_RETRY_BASE_MS: '20', NOTIFY_SEND_IMMEDIATELY: 'false' });
  const ctx = run.handle.ctx;
  await makeTenant(run, 'ent');
  await makeUser(run, 'ent', 'admin', ['TENANT_ADMIN']);
  await makeUser(run, 'ent', 'officer', ['PROCUREMENT_OFFICER']);
  const admin = await login(run, 'ent', 'admin');
  const officer = await login(run, 'ent', 'officer');
  const runDeliveries = async () => {
    const r = await api(run, 'POST', '/api/v1/admin/jobs/notification-deliveries/run', { token: admin });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.status, 'OK', r.text);
    return r.body.result;
  };

  const ch = await api(run, 'GET', '/api/v1/admin/notification-templates', { token: admin });
  assert.equal(ch.body.channels.EMAIL.configured, true);
  assert.equal(ch.body.channels.SMS.configured, true);
  assert.ok(!JSON.stringify(ch.body.channels).includes('mail-secret') && !JSON.stringify(ch.body.channels).includes('sms-test-token'), 'no secrets');

  // no contact yet → e-mail / SMS skipped for lack of an address (never "sent")
  const t0 = await api(run, 'POST', '/api/v1/admin/notification-templates/NOT-001_SUBSCRIPTION_RENEWAL/test', { token: admin });
  assert.deepEqual(t0.body.deliveries.map((d: any) => [d.channel, d.status]), [['EMAIL', 'SKIPPED_NO_ADDRESS'], ['IN_APP', 'SENT'], ['SMS', 'SKIPPED_NO_ADDRESS']]);

  // "send test to me" → the fake SMTP server receives the bilingual e-mail; the fake provider receives the SMS
  await api(run, 'PUT', '/api/v1/notifications/contact', { token: admin, json: { email: 'admin@entity.test', phone: '+96599990000' } });
  const t1 = await api(run, 'POST', '/api/v1/admin/notification-templates/NOT-001_SUBSCRIPTION_RENEWAL/test', { token: admin });
  assert.equal(t1.status, 200, t1.text);
  const byCh = Object.fromEntries(t1.body.deliveries.map((d: any) => [d.channel, d]));
  assert.equal(byCh.EMAIL.status, 'SENT', JSON.stringify(byCh.EMAIL));
  assert.match(byCh.EMAIL.providerMessageId, /@/);
  assert.equal(byCh.SMS.status, 'SENT', JSON.stringify(byCh.SMS));
  assert.equal(byCh.SMS.providerMessageId, 'sms-1');
  assert.equal(smtp.messages.length, 1);
  const m = smtp.messages[0];
  assert.deepEqual(m.to, ['admin@entity.test']);
  assert.equal(m.auth, 'mailer', 'SMTP AUTH used');
  const text = mailText(m);
  assert.match(text, /\[تجربة\] تذكير بتجديد الاشتراك/);
  assert.match(text, /\[TEST\] Subscription renewal due: Al-Sample Trading Co\. \(fictitious\)/);
  assert.match(text, /expires on 2026-11-30 \(30 days left\)/);
  assert.equal(sms.calls.length, 1);
  assert.equal(sms.calls[0].headers.authorization, 'Bearer sms-test-token');
  const smsBody = JSON.parse(sms.calls[0].body);
  assert.equal(smsBody.recipient, '+96599990000');
  assert.equal(smsBody.sender, 'TENDERFLOW');
  assert.match(smsBody.message, /^السادة شركة النموذج للتجارة \(وهمية\)، ينتهي اشتراككم/);

  // a vendor event is queued in the transaction and sent by the delivery job
  const reg = await api(run, 'POST', '/api/v1/public/vendors/register', { json: { tenantId: 'ent', legalNameEn: 'Gulf Supplies (fictitious)', legalNameAr: 'إمدادات الخليج (وهمية)',
    crNumber: 'CR-9', email: 'sales@gulf.test', phone: '+96551112222', categories: ['IT'], username: 'gulf', password: PASSWORD } });
  const vendorId = reg.body.vendor.id;
  const q1 = await ctx.db.tx((q) => notify(q, { tenantId: 'ent', vendorId, kind: 'REGISTRATION_APPROVED', templateCode: 'NOT-004_REGISTRATION_APPROVED',
    titleEn: 'Registration approved', titleAr: 'تمت الموافقة', body: { knetLink: 'https://knet.example/pay/123' } }));
  assert.deepEqual(q1.deliveries.map((d) => [d.channel, d.status]), [['IN_APP', 'SENT'], ['EMAIL', 'QUEUED'], ['SMS', 'QUEUED']]);
  const r1 = await runDeliveries();
  assert.equal(r1.sent, 2, JSON.stringify(r1));
  const vm = smtp.messages.at(-1)!;
  assert.deepEqual(vm.to, ['sales@gulf.test']);
  assert.match(mailText(vm), /https:\/\/knet\.example\/pay\/123/);
  assert.equal(JSON.parse(sms.calls.at(-1)!.body).recipient, '+96551112222');

  // SMTP temporary failure → QUEUED with attempts=1 and back-off; next run after the delay → SENT (attempt 2)
  smtp.failNext = 1;
  const q2 = await ctx.db.tx((q) => notify(q, { tenantId: 'ent', vendorId, kind: 'DOCUMENT_EXPIRING', titleEn: 'Expiring', titleAr: 'تنتهي', body: { date: '2026-11-01' } }));
  const emailId = q2.deliveries.find((d) => d.channel === 'EMAIL')!.id;
  let r = await runDeliveries();
  assert.equal(r.retrying, 1, JSON.stringify(r));
  let row = (await ctx.db.query<any>('SELECT * FROM notification_deliveries WHERE id=$1', [emailId]))[0];
  assert.equal(row.status, 'QUEUED');
  assert.equal(row.attempts, 1);
  assert.match(row.error, /451/);
  assert.ok(new Date(row.next_attempt_at).getTime() > Date.now() - 1000);
  await sleep(60);
  r = await runDeliveries();
  row = (await ctx.db.query<any>('SELECT * FROM notification_deliveries WHERE id=$1', [emailId]))[0];
  assert.equal(row.status, 'SENT', JSON.stringify(row));
  assert.equal(row.attempts, 2);

  // SMS provider down 3 times → FAILED after the 3rd attempt (20 ms, 40 ms back-off); admin re-queues → SENT
  await api(run, 'PATCH', '/api/v1/admin/notification-templates/DOCUMENT_EXPIRED', { token: admin, json: { channels: ['IN_APP', 'SMS'] } });
  sms.statuses.push(503, 503, 503);
  const q3 = await ctx.db.tx((q) => notify(q, { tenantId: 'ent', vendorId, kind: 'DOCUMENT_EXPIRED', titleEn: 'Expired', titleAr: 'انتهت', body: { date: '2026-10-01' } }));
  const smsId = q3.deliveries.find((d) => d.channel === 'SMS')!.id;
  for (let i = 0; i < 3; i++) { await runDeliveries(); await sleep(100); }
  row = (await ctx.db.query<any>('SELECT * FROM notification_deliveries WHERE id=$1', [smsId]))[0];
  assert.equal(row.status, 'FAILED', JSON.stringify(row));
  assert.equal(row.attempts, 3);
  assert.match(row.error, /HTTP 503/);
  assert.equal((await runDeliveries()).claimed, 0, 'FAILED is final');
  const failed = await api(run, 'GET', '/api/v1/admin/notification-deliveries?status=FAILED', { token: admin });
  assert.deepEqual(failed.body.items.map((d: any) => d.id), [smsId]);
  assert.equal((await api(run, 'POST', `/api/v1/admin/notification-deliveries/${smsId}/retry`, { token: officer })).status, 403);
  assert.equal((await api(run, 'POST', `/api/v1/admin/notification-deliveries/${smsId}/retry`, { token: admin })).status, 200);
  await runDeliveries();
  row = (await ctx.db.query<any>('SELECT * FROM notification_deliveries WHERE id=$1', [smsId]))[0];
  assert.equal(row.status, 'SENT');
  assert.equal((await api(run, 'POST', `/api/v1/admin/notification-deliveries/${smsId}/retry`, { token: admin })).status, 409, 'only FAILED can be re-queued');
});
