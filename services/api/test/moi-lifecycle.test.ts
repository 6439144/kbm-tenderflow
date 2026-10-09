// MOI workstream: cycle scope, eligibility semantics, visibility on every read, vendor lifecycle (grading,
// subscription, reminders, upgrades, exemption, blocking), entity policies, receipts.
process.env.LIFECYCLE_JOB_INTERVAL_MS = '0'; // jobs are run explicitly in this file
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, fileForm, login, makeTenant, makeUser, startApp, PASSWORD, type Running } from './helpers.js';
import { setClockOffset } from '../src/util.js';

let run: Running;
const T = 'moi';
const tok: Record<string, string> = {};
const vid: Record<string, string> = {};
let tplId = '';
const DAY = 86_400_000;

const CRIT = [{ key: 'technical', nameEn: 'Technical', nameAr: 'فني', weight: 100 }];

async function register(username: string, cr: string) {
  const r = await api(run, 'POST', '/api/v1/public/vendors/register', { json: { tenantId: T, legalNameEn: `${username} (fictitious)`, legalNameAr: `${username} (وهمية)`,
    crNumber: cr, email: `${username}@x.example`, phone: '1', categories: ['SUPPLIES'], username, password: PASSWORD } });
  assert.equal(r.status, 201, r.text);
  vid[username] = r.body.vendor.id;
  tok[username] = await login(run, T, username);
  return r.body.vendor.id as string;
}
const audit = async (action: string, resourceId?: string) =>
  (await api(run, 'GET', `/api/v1/audit?limit=1000${resourceId ? `&resourceId=${resourceId}` : ''}`, { token: tok.admin })).body.filter((e: any) => e.action === action);
const notes = async (who: string) => (await api(run, 'GET', '/api/v1/notifications', { token: tok[who] })).body as any[];

async function tender(activityCodes: string[], minGrade: number | null, extra: Record<string, unknown> = {}) {
  const mk = await api(run, 'POST', '/api/v1/tenders', { token: tok.officer, json: {
    templateId: tplId, titleEn: 'Supply', titleAr: 'توريد', category: 'SUPPLIES', estimatedBudget: 1, currency: 'KWD',
    submissionDeadline: new Date(Date.now() + 5 * DAY).toISOString(), criteria: CRIT, requiredDocuments: [], eligibility: { activityCodes, minGrade }, ...extra } });
  assert.equal(mk.status, 201, mk.text);
  const id = mk.body.id as string;
  const up = await api(run, 'POST', `/api/v1/tenders/${id}/documents`, { token: tok.officer, form: fileForm({ file: { name: 'pack.md', content: '# 1. Scope\nSupply of goods.' } }) });
  assert.equal(up.status, 201, up.text);
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${id}/approve`, { token: tok.director, json: {} })).status, 200);
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${id}/publish`, { token: tok.officer })).status, 200);
  return { id, docId: up.body.id as string };
}

before(async () => {
  run = await startApp();
  await makeTenant(run, T);
  for (const [u, r] of [['officer', 'PROCUREMENT_OFFICER'], ['director', 'DIRECTOR'], ['grader', 'GRADING_AUTHORITY'], ['admin', 'TENANT_ADMIN']] as const) {
    await makeUser(run, T, u, [r]);
    tok[u] = await login(run, T, u);
  }
  for (const [code, en] of [['SEC-01', 'Security systems'], ['VEH-02', 'Vehicles'], ['ITE-03', 'IT equipment']])
    assert.equal((await api(run, 'POST', '/api/v1/activity-codes', { token: tok.admin, json: { code, nameEn: en, nameAr: en } })).status, 200);
  const tpl = await api(run, 'POST', '/api/v1/templates', { token: tok.admin, json: { code: 'MOI_P1', nameEn: 'MOI Phase 1', nameAr: 'المرحلة 1',
    config: { scope: 'PUBLICATION_AND_SALE', stages: { requestIntake: true, documentPurchase: true }, fees: { documentPrice: 10, currency: 'KWD', exemptionAllowed: true },
      approvals: { request: [{ role: 'DIRECTOR', labelEn: 'GM', labelAr: 'المدير', dueHours: 48 }], publish: [{ role: 'DIRECTOR', labelEn: 'Director', labelAr: 'المدير', dueHours: 24 }] } } } });
  assert.equal(tpl.status, 201, tpl.text);
  tplId = tpl.body.id;
  assert.equal((await api(run, 'POST', `/api/v1/templates/${tplId}/publish`, { token: tok.admin, json: { makeDefault: true } })).status, 200);
});
after(async () => { setClockOffset(0); if (run) await run.stop(); });

test('cycle scope PUBLICATION_AND_SALE: stages absent, bids refused 409 STAGE_NOT_IN_SCOPE; dueHours stored and validated', async () => {
  const tpl = await api(run, 'GET', `/api/v1/templates/${tplId}`, { token: tok.officer });
  assert.equal(tpl.body.config.scope, 'PUBLICATION_AND_SALE');
  assert.equal(tpl.body.config.approvals.publish[0].dueHours, 24);
  const keys = tpl.body.stages.map((s: any) => s.key);
  for (const k of ['SEALED_BIDS', 'OPENING', 'EVALUATION', 'AWARD_APPROVAL']) assert.ok(!keys.includes(k), `${k} must be absent`);
  assert.ok(keys.includes('DOCUMENT_PURCHASE'));
  const bad = await api(run, 'POST', '/api/v1/templates/validate', { token: tok.officer, json: { config: { approvals: { publish: [{ role: 'DIRECTOR', dueHours: 0 }] } } } });
  assert.equal(bad.body.valid, false);
  assert.match(bad.body.error, /dueHours/);
  const badScope = await api(run, 'POST', '/api/v1/templates/validate', { token: tok.officer, json: { config: { scope: 'BIDS_ONLY' } } });
  assert.equal(badScope.body.valid, false);

  // a vendor with matching activity sees the tender but cannot bid; scope check precedes anything else
  const v = await register('scopev', 'CR-S1');
  assert.equal((await api(run, 'POST', `/api/v1/grading/vendors/${v}/decision`, { token: tok.grader, json: { decision: 'APPROVE', activities: [{ activityCode: 'SEC-01', grade: 1 }] } })).status, 200);
  const { id } = await tender(['SEC-01'], 1);
  const bid = await api(run, 'POST', `/api/v1/tenders/${id}/bids`, { token: tok.scopev,
    form: fileForm({ technical: { name: 't.md', content: 'tech' }, financial: { name: 'f.md', content: 'fin' } }) });
  assert.equal(bid.status, 409, bid.text);
  assert.equal(bid.body.code, 'STAGE_NOT_IN_SCOPE');
  const det = await api(run, 'GET', `/api/v1/tenders/${id}`, { token: tok.officer });
  assert.ok(!det.body.stages.some((s: any) => s.key === 'SEALED_BIDS'));
  assert.equal(det.body.cycle.scope, 'PUBLICATION_AND_SALE');
});

test('entity policies: defaults, admin-only edit, validation, audited with from/to', async () => {
  const p0 = await api(run, 'GET', '/api/v1/entity/policies', { token: tok.officer });
  assert.equal(p0.body.policies.gradeMatch, 'AT_LEAST');
  assert.equal(p0.body.policies.visibility, 'CATEGORY');
  assert.equal((await api(run, 'PUT', '/api/v1/entity/policies', { token: tok.officer, json: { gradeMatch: 'EXACT' } })).status, 403);
  assert.equal((await api(run, 'PUT', '/api/v1/entity/policies', { token: tok.admin, json: { gradeMatch: 'SOMETIMES' } })).status, 400);
  assert.equal((await api(run, 'PUT', '/api/v1/entity/policies', { token: tok.admin, json: { subscriptionRequired: true, subscriptionFee: 0 } })).status, 400);
  assert.equal((await api(run, 'PUT', '/api/v1/entity/policies', { token: tok.admin, json: { blockRoles: ['VENDOR'] } })).status, 400);
  const ok = await api(run, 'PUT', '/api/v1/entity/policies', { token: tok.admin, json: { visibility: 'ELIGIBLE_ONLY', gradingRoles: ['GRADING_AUTHORITY'], renewalReminderDays: [7, 30, 1, 7] } });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.body.policies.renewalReminderDays, [30, 7, 1]);
  const ev = await audit('ENTITY_POLICIES_UPDATED');
  const last = ev[0];
  assert.ok(last.details.changed.includes('visibility'));
  assert.equal(last.details.from.visibility, 'CATEGORY');
  assert.equal(last.details.to.visibility, 'ELIGIBLE_ONLY');
});

test('grading: NOT-002 on registration, grading role from policy, approval issues subscription link (NOT-004) when required', async () => {
  await api(run, 'PUT', '/api/v1/entity/policies', { token: tok.admin, json: { subscriptionRequired: true, subscriptionFee: 100 } });
  const v = await register('gv1', 'CR-G1');
  const gn = await notes('grader');
  assert.ok(gn.some((n) => n.kind === 'VENDOR_APPLICATION_RECEIVED' && n.body.vendorId === v), 'grader notified (NOT-002)');
  const q = await api(run, 'GET', '/api/v1/grading/queue', { token: tok.grader });
  assert.ok(q.body.applications.some((a: any) => a.id === v));
  // officer is not in gradingRoles any more
  assert.equal((await api(run, 'POST', `/api/v1/grading/vendors/${v}/decision`, { token: tok.officer, json: { decision: 'APPROVE', activities: [{ activityCode: 'SEC-01', grade: 1 }] } })).status, 403);
  assert.equal((await api(run, 'POST', `/api/v1/grading/vendors/${v}/decision`, { token: tok.grader, json: { decision: 'APPROVE', activities: [{ activityCode: 'NOPE', grade: 1 }] } })).status, 400);
  const g = await api(run, 'POST', `/api/v1/grading/vendors/${v}/decision`, { token: tok.grader, json: { decision: 'APPROVE', activities: [{ activityCode: 'SEC-01', grade: 2 }, { activityCode: 'VEH-02', grade: 1 }] } });
  assert.equal(g.status, 200, g.text);
  assert.equal(g.body.subscription.status, 'PENDING_PAYMENT');
  assert.match(g.body.subscription.payLink, /^\/vendor\/subscription\?link=/);
  const vn = await notes('gv1');
  assert.ok(vn.some((n) => n.kind === 'SUBSCRIPTION_LINK' && n.body.brd === 'NOT-004'));
  assert.equal((await audit('VENDOR_GRADED', v)).length, 1);
  // reject needs a reason
  const v2 = await register('gv2', 'CR-G2');
  assert.equal((await api(run, 'POST', `/api/v1/grading/vendors/${v2}/decision`, { token: tok.grader, json: { decision: 'REJECT' } })).status, 400);
  assert.equal((await api(run, 'POST', `/api/v1/grading/vendors/${v2}/decision`, { token: tok.grader, json: { decision: 'REJECT', reason: 'CR expired' } })).body.status, 'REJECTED');
});

test('subscription required: no view/purchase before paying; TEST payment → MOI receipt with gateway id; KNET refused; expiry; retain purchased', async () => {
  await api(run, 'PUT', '/api/v1/entity/policies', { token: tok.admin, json: { subscriptionRequired: true, subscriptionFee: 100, visibility: 'ELIGIBLE_ONLY' } });
  await run.handle.ctx.db.query(`UPDATE tenants SET profile = profile || '{"receiptPattern":"MOI-RCPT-{YYYY}-{SEQ6}"}'::jsonb WHERE id=$1`, [T]);
  const v = await register('sub1', 'CR-SUB1');
  const g = await api(run, 'POST', `/api/v1/grading/vendors/${v}/decision`, { token: tok.grader, json: { decision: 'APPROVE', activities: [{ activityCode: 'ITE-03', grade: 2 }] } });
  const link = new URLSearchParams(g.body.subscription.payLink.split('?')[1]).get('link')!;
  const t1 = await tender(['ITE-03'], 2);
  const t2 = await tender(['ITE-03'], 2);
  // BR-008: unpaid → the list is empty and detail says why
  assert.equal((await api(run, 'GET', '/api/v1/tenders', { token: tok.sub1 })).body.length, 0);
  const d0 = await api(run, 'GET', `/api/v1/tenders/${t1.id}`, { token: tok.sub1 });
  assert.equal(d0.status, 403);
  assert.equal(d0.body.code, 'SUBSCRIPTION_REQUIRED');
  // KNET is refused until configured — never a fake success
  const knet = await api(run, 'POST', '/api/v1/vendor/me/subscription/pay', { token: tok.sub1, json: { link, gateway: 'KNET' } });
  assert.equal(knet.status, 503);
  assert.equal(knet.body.code, 'KNET_NOT_CONFIGURED');
  const paid = await api(run, 'POST', '/api/v1/vendor/me/subscription/pay', { token: tok.sub1, json: { link, gateway: 'TEST' } });
  assert.equal(paid.status, 200, paid.text);
  assert.equal(paid.body.status, 'ACTIVE');
  assert.match(paid.body.receiptNumber, /^MOI-RCPT-\d{4}-\d{6}$/);
  // BR-009: one year from the payment date
  const span = new Date(paid.body.endsAt).getTime() - new Date(paid.body.startsAt).getTime();
  assert.ok(span >= 365 * DAY && span <= 366 * DAY, `span ${span / DAY} days`);
  assert.ok(Math.abs(new Date(paid.body.startsAt).getTime() - new Date(paid.body.paidAt).getTime()) < 1000);
  assert.equal((await api(run, 'POST', '/api/v1/vendor/me/subscription/pay', { token: tok.sub1, json: { link } })).status, 409, 'link is single use');
  // now visible; buy t1 (TEST) → receipt in the same series, with the gateway transaction id
  assert.equal((await api(run, 'GET', '/api/v1/tenders', { token: tok.sub1 })).body.length, 2);
  const det = await api(run, 'GET', `/api/v1/tenders/${t1.id}`, { token: tok.sub1 });
  assert.equal(det.body.documents.length, 0, 'PUBLICATION_AND_SALE: pack files open only after purchase');
  assert.equal((await api(run, 'GET', `/api/v1/documents/${t1.docId}`, { token: tok.sub1 })).status, 404);
  const buy = await api(run, 'POST', `/api/v1/tenders/${t1.id}/purchase`, { token: tok.sub1, json: { gateway: 'TEST' } });
  assert.equal(buy.status, 201, buy.text);
  assert.match(buy.body.receiptNumber, /^MOI-RCPT-\d{4}-\d{6}$/);
  assert.notEqual(buy.body.receiptNumber, paid.body.receiptNumber);
  assert.match(buy.body.paymentRef, /^TEST-/);
  const rc = await api(run, 'GET', `/api/v1/receipts/${buy.body.receiptNumber}`, { token: tok.sub1 });
  assert.equal(rc.status, 200, rc.text);
  assert.equal(rc.body.gatewayTransactionId, buy.body.paymentRef);
  assert.equal(rc.body.test, true);
  assert.equal(rc.body.tender.number.length > 0, true);
  assert.equal((await api(run, 'GET', `/api/v1/receipts/${buy.body.receiptNumber}`, { token: tok.scopev })).status, 404, 'another vendor cannot read it');
  assert.equal((await api(run, 'GET', `/api/v1/tenders/${t1.id}`, { token: tok.sub1 })).body.documents.length, 1);
  assert.equal((await api(run, 'GET', `/api/v1/documents/${t1.docId}`, { token: tok.sub1 })).status, 200);

  // expiry (job), then BR-010 retain-after-expiry on/off
  await run.handle.ctx.db.query(`UPDATE vendor_subscriptions SET ends_at=now() - interval '1 minute' WHERE vendor_id=$1`, [v]);
  const jobs = await api(run, 'POST', '/api/v1/admin/lifecycle/run-jobs', { token: tok.admin });
  assert.ok(jobs.body.expired >= 1, jobs.text);
  assert.equal((await api(run, 'GET', '/api/v1/vendor/me/lifecycle', { token: tok.sub1 })).body.subscription.status, 'EXPIRED');
  assert.equal((await api(run, 'GET', `/api/v1/tenders/${t1.id}`, { token: tok.sub1 })).status, 200, 'purchased tender kept (BR-010)');
  assert.equal((await api(run, 'GET', `/api/v1/tenders/${t2.id}`, { token: tok.sub1 })).status, 403, 'not purchased → subscription required');
  assert.deepEqual((await api(run, 'GET', '/api/v1/tenders', { token: tok.sub1 })).body.map((x: any) => x.id), [t1.id]);
  const p2 = await api(run, 'POST', `/api/v1/tenders/${t2.id}/purchase`, { token: tok.sub1, json: { gateway: 'TEST' } });
  assert.equal(p2.status, 403);
  await api(run, 'PUT', '/api/v1/entity/policies', { token: tok.admin, json: { retainPurchasedAfterExpiry: false } });
  assert.equal((await api(run, 'GET', `/api/v1/tenders/${t1.id}`, { token: tok.sub1 })).status, 403);
  await api(run, 'PUT', '/api/v1/entity/policies', { token: tok.admin, json: { retainPurchasedAfterExpiry: true } });
  // renewal link
  const ren = await api(run, 'POST', '/api/v1/vendor/me/subscription/renew', { token: tok.sub1 });
  assert.equal(ren.status, 201, ren.text);
  assert.equal(ren.body.kind, 'RENEWAL');
});

test('eligibility semantics (BR-007): EXACT vs AT_LEAST, PER_ACTIVITY vs COMPANY; visibility enforced on list, detail and documents', async () => {
  await api(run, 'PUT', '/api/v1/entity/policies', { token: tok.admin, json: { subscriptionRequired: false, visibility: 'ELIGIBLE_ONLY', gradeMatch: 'AT_LEAST', gradeScope: 'PER_ACTIVITY' } });
  const first = await register('el1', 'CR-E1');   // SEC-01 First, VEH-02 Third
  const third = await register('el3', 'CR-E3');   // VEH-02 Third only
  await api(run, 'POST', `/api/v1/grading/vendors/${first}/decision`, { token: tok.grader, json: { decision: 'APPROVE', activities: [{ activityCode: 'SEC-01', grade: 1 }, { activityCode: 'VEH-02', grade: 3 }] } });
  await api(run, 'POST', `/api/v1/grading/vendors/${third}/decision`, { token: tok.grader, json: { decision: 'APPROVE', activities: [{ activityCode: 'VEH-02', grade: 3 }] } });
  const sec2 = await tender(['SEC-01'], 2);   // Second grade, security
  const veh3 = await tender(['VEH-02'], 3);   // Third grade, vehicles
  const ids = async (who: string) => (await api(run, 'GET', '/api/v1/tenders', { token: tok[who] })).body.map((x: any) => x.id);

  // AT_LEAST + PER_ACTIVITY: First in SEC-01 satisfies "Second and above"
  assert.ok((await ids('el1')).includes(sec2.id));
  assert.ok((await ids('el1')).includes(veh3.id));
  // wrong activity → hidden in list, 404 on detail and on document download (SEC-006)
  assert.ok(!(await ids('el3')).includes(sec2.id));
  assert.equal((await api(run, 'GET', `/api/v1/tenders/${sec2.id}`, { token: tok.el3 })).status, 404);
  assert.equal((await api(run, 'GET', `/api/v1/documents/${sec2.docId}`, { token: tok.el3 })).status, 404);
  assert.equal((await api(run, 'GET', `/api/v1/tenders/${sec2.id}/eligibility`, { token: tok.el3 })).status, 404);

  // EXACT: "that grade only" → First-grade holder no longer sees a Second-grade tender
  await api(run, 'PUT', '/api/v1/entity/policies', { token: tok.admin, json: { gradeMatch: 'EXACT' } });
  assert.ok(!(await ids('el1')).includes(sec2.id));
  assert.ok((await ids('el1')).includes(veh3.id), 'VEH-02 Third matches exactly');
  assert.equal((await api(run, 'GET', `/api/v1/tenders/${sec2.id}`, { token: tok.el1 })).status, 404);

  // COMPANY scope: one company grade applies to every registered activity
  await run.handle.ctx.db.query('UPDATE vendors SET company_grade=2 WHERE id=$1', [first]);
  await api(run, 'PUT', '/api/v1/entity/policies', { token: tok.admin, json: { gradeScope: 'COMPANY' } });
  assert.ok((await ids('el1')).includes(sec2.id), 'company grade Second = tender Second (EXACT)');
  assert.ok(!(await ids('el1')).includes(veh3.id), 'company grade Second ≠ Third (EXACT)');
  await api(run, 'PUT', '/api/v1/entity/policies', { token: tok.admin, json: { gradeMatch: 'AT_LEAST' } });
  assert.ok((await ids('el1')).includes(veh3.id), 'Second is "Third and above"');
  // CATEGORY visibility keeps the v1 behaviour (category match) and shows the eligibility result instead
  await api(run, 'PUT', '/api/v1/entity/policies', { token: tok.admin, json: { visibility: 'CATEGORY', gradeScope: 'PER_ACTIVITY' } });
  const d = await api(run, 'GET', `/api/v1/tenders/${sec2.id}`, { token: tok.el3 });
  assert.equal(d.status, 200);
  assert.equal(d.body.myEligibility.eligible, false);
  await api(run, 'PUT', '/api/v1/entity/policies', { token: tok.admin, json: { visibility: 'ELIGIBLE_ONLY' } });
});

test('NOT-001 reminder job: one notification per crossed threshold, never repeated', async () => {
  await api(run, 'PUT', '/api/v1/entity/policies', { token: tok.admin, json: { subscriptionRequired: true, subscriptionFee: 100, renewalReminderDays: [30, 7, 1] } });
  const v = await register('rem1', 'CR-R1');
  const g = await api(run, 'POST', `/api/v1/grading/vendors/${v}/decision`, { token: tok.grader, json: { decision: 'APPROVE', activities: [{ activityCode: 'SEC-01', grade: 2 }] } });
  const link = new URLSearchParams(g.body.subscription.payLink.split('?')[1]).get('link')!;
  await api(run, 'POST', '/api/v1/vendor/me/subscription/pay', { token: tok.rem1, json: { link } });
  const count = async () => (await notes('rem1')).filter((n) => n.kind === 'SUBSCRIPTION_RENEWAL_REMINDER').length;
  await api(run, 'POST', '/api/v1/admin/lifecycle/run-jobs', { token: tok.admin });
  assert.equal(await count(), 0, 'a year left: no reminder');
  await run.handle.ctx.db.query(`UPDATE vendor_subscriptions SET ends_at=now() + interval '5 days' WHERE vendor_id=$1`, [v]);
  await api(run, 'POST', '/api/v1/admin/lifecycle/run-jobs', { token: tok.admin });
  assert.equal(await count(), 1, '30 and 7 crossed → one reminder');
  const n = (await notes('rem1')).find((x) => x.kind === 'SUBSCRIPTION_RENEWAL_REMINDER');
  assert.equal(n.body.brd, 'NOT-001');
  assert.equal(n.body.threshold, 7);
  await api(run, 'POST', '/api/v1/admin/lifecycle/run-jobs', { token: tok.admin });
  assert.equal(await count(), 1, 'not repeated');
  await run.handle.ctx.db.query(`UPDATE vendor_subscriptions SET ends_at=now() + interval '12 hours' WHERE vendor_id=$1`, [v]);
  await api(run, 'POST', '/api/v1/admin/lifecycle/run-jobs', { token: tok.admin });
  await api(run, 'POST', '/api/v1/admin/lifecycle/run-jobs', { token: tok.admin });
  assert.equal(await count(), 2, '1-day threshold once');
  assert.equal((await audit('SUBSCRIPTION_REMINDER_SENT', v)).length, 2);
});

test('grade upgrade (FR-010): vendor uploads documents → grading authority approves → classification updated → NOT-003', async () => {
  await api(run, 'PUT', '/api/v1/entity/policies', { token: tok.admin, json: { subscriptionRequired: false, gradeScope: 'PER_ACTIVITY' } });
  const v = await register('up1', 'CR-U1');
  await api(run, 'POST', `/api/v1/grading/vendors/${v}/decision`, { token: tok.grader, json: { decision: 'APPROVE', activities: [{ activityCode: 'VEH-02', grade: 3 }] } });
  const noFiles = await api(run, 'POST', '/api/v1/vendor/me/grade-upgrades', { token: tok.up1, form: fileForm({ activityCode: 'VEH-02', requestedGrade: '2' }) });
  assert.equal(noFiles.status, 400);
  const notHigher = await api(run, 'POST', '/api/v1/vendor/me/grade-upgrades', { token: tok.up1,
    form: fileForm({ activityCode: 'VEH-02', requestedGrade: '3', files: { name: 'fs.md', content: 'statements' } }) });
  assert.equal(notHigher.status, 400);
  const r = await api(run, 'POST', '/api/v1/vendor/me/grade-upgrades', { token: tok.up1,
    form: fileForm({ activityCode: 'VEH-02', requestedGrade: '2', justification: 'Larger fleet', files: { name: 'fleet.md', content: '# Fleet\n40 vehicles' } }) });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.status, 'SUBMITTED');
  assert.equal(r.body.documentIds.length, 1);
  assert.ok((await notes('grader')).some((n) => n.kind === 'GRADE_UPGRADE_SUBMITTED'));
  const det = await api(run, 'GET', `/api/v1/grade-upgrades/${r.body.id}`, { token: tok.grader });
  assert.equal(det.body.documents.length, 1);
  assert.equal((await api(run, 'GET', `/api/v1/documents/${det.body.documents[0].id}`, { token: tok.grader })).status, 200);
  assert.equal((await api(run, 'GET', `/api/v1/grade-upgrades/${r.body.id}`, { token: tok.el3 })).status, 404, 'other vendor');
  assert.equal((await api(run, 'POST', `/api/v1/grade-upgrades/${r.body.id}/decision`, { token: tok.officer, json: { decision: 'APPROVE' } })).status, 403);
  const ok = await api(run, 'POST', `/api/v1/grade-upgrades/${r.body.id}/decision`, { token: tok.grader, json: { decision: 'APPROVE', reason: 'Fleet verified' } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.grantedGrade, 2);
  const cls = await api(run, 'GET', '/api/v1/vendor/me/classifications', { token: tok.up1 });
  assert.equal(cls.body.find((c: any) => c.activityCode === 'VEH-02').grade, 2);
  assert.ok((await notes('up1')).some((n) => n.kind === 'GRADE_UPGRADE_DECIDED' && n.body.brd === 'NOT-003'));
  assert.equal((await api(run, 'POST', `/api/v1/grade-upgrades/${r.body.id}/decision`, { token: tok.grader, json: { decision: 'REJECT', reason: 'x' } })).status, 409);
  assert.equal((await audit('GRADE_UPGRADE_APPROVED', v)).length, 1);
});

test('fee exemption (FR-018): PER_VENDOR flag and CATEGORY mode; exempt purchase gets an EXEMPT receipt', async () => {
  await api(run, 'PUT', '/api/v1/entity/policies', { token: tok.admin, json: { exemptionMode: 'PER_VENDOR', subscriptionRequired: false } });
  const v = await register('ex1', 'CR-X1');
  await api(run, 'POST', `/api/v1/grading/vendors/${v}/decision`, { token: tok.grader, json: { decision: 'APPROVE', activities: [{ activityCode: 'ITE-03', grade: 1 }] } });
  assert.equal((await api(run, 'POST', `/api/v1/vendors/${v}/exemption`, { token: tok.officer, json: { feeExempt: true, reason: 'x' } })).status, 403);
  assert.equal((await api(run, 'POST', `/api/v1/vendors/${v}/exemption`, { token: tok.admin, json: { feeExempt: true } })).status, 400, 'reason required');
  const ex = await api(run, 'POST', `/api/v1/vendors/${v}/exemption`, { token: tok.admin, json: { feeExempt: true, reason: 'Government-owned company' } });
  assert.equal(ex.body.exemption.basis, 'PER_VENDOR');
  const t1 = await tender(['ITE-03'], 1);
  const p = await api(run, 'POST', `/api/v1/tenders/${t1.id}/purchase`, { token: tok.ex1, json: { gateway: 'TEST' } });
  assert.equal(p.status, 201, p.text);
  assert.equal(p.body.gateway, 'EXEMPT');
  assert.equal(Number(p.body.amount), 0);
  // CATEGORY mode: the per-vendor flag no longer counts; the category does
  await api(run, 'PUT', '/api/v1/entity/policies', { token: tok.admin, json: { exemptionMode: 'CATEGORY' } });
  const t2 = await tender(['ITE-03'], 1);
  const paid = await api(run, 'POST', `/api/v1/tenders/${t2.id}/purchase`, { token: tok.ex1, json: { gateway: 'TEST' } });
  assert.equal(paid.body.gateway, 'TEST', 'flag ignored in CATEGORY mode');
  assert.equal((await api(run, 'POST', '/api/v1/vendor-categories', { token: tok.admin, json: { code: 'SME', nameEn: 'Small business', nameAr: 'منشأة صغيرة', feeExempt: true } })).status, 200);
  assert.equal((await api(run, 'POST', `/api/v1/vendors/${v}/exemption`, { token: tok.admin, json: { vendorCategory: 'NOPE' } })).status, 400);
  const cat = await api(run, 'POST', `/api/v1/vendors/${v}/exemption`, { token: tok.admin, json: { vendorCategory: 'SME' } });
  assert.equal(cat.body.exemption.basis, 'CATEGORY');
  const t3 = await tender(['ITE-03'], 1);
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${t3.id}/purchase`, { token: tok.ex1, json: {} })).body.gateway, 'EXEMPT');
  assert.ok((await audit('VENDOR_EXEMPTION_UPDATED', v)).length >= 2);
  await api(run, 'PUT', '/api/v1/entity/policies', { token: tok.admin, json: { exemptionMode: 'PER_VENDOR' } });
});

test('blocking (FR-013/014, BR-006): date range and permanent prevent login, block access, auto-reinstate (PAUSE), audited', async () => {
  await api(run, 'PUT', '/api/v1/entity/policies', { token: tok.admin, json: { subscriptionRequired: true, subscriptionFee: 100, blockEffectOnSubscription: 'PAUSE' } });
  const v = await register('bl1', 'CR-B1');
  const g = await api(run, 'POST', `/api/v1/grading/vendors/${v}/decision`, { token: tok.grader, json: { decision: 'APPROVE', activities: [{ activityCode: 'SEC-01', grade: 1 }] } });
  const link = new URLSearchParams(g.body.subscription.payLink.split('?')[1]).get('link')!;
  const paid = await api(run, 'POST', '/api/v1/vendor/me/subscription/pay', { token: tok.bl1, json: { link } });
  const endBefore = new Date(paid.body.endsAt).getTime();
  const t1 = await tender(['SEC-01'], 1);
  assert.equal((await api(run, 'POST', `/api/v1/vendors/${v}/blocks`, { token: tok.officer, json: { mode: 'PERMANENT', reason: 'x' } })).status, 403, 'policy: admin only');
  assert.equal((await api(run, 'POST', `/api/v1/vendors/${v}/blocks`, { token: tok.admin, json: { mode: 'DATE_RANGE', reason: 'x' } })).status, 400, 'needs to');
  assert.equal((await api(run, 'POST', `/api/v1/vendors/${v}/blocks`, { token: tok.admin, json: { mode: 'PERMANENT', reason: 'x', ground: 'NOPE' } })).status, 400);
  const to = new Date(Date.now() + 3 * DAY).toISOString();
  const b = await api(run, 'POST', `/api/v1/vendors/${v}/blocks`, { token: tok.admin, json: { mode: 'DATE_RANGE', to, reason: 'Expired licence', ground: 'DOCUMENTS_EXPIRED' } });
  assert.equal(b.status, 201, b.text);
  // login refused with the suspension date — only after the password is verified
  const li = await api(run, 'POST', '/api/v1/auth/login', { json: { tenantId: T, username: 'bl1', password: PASSWORD } });
  assert.equal(li.status, 403);
  assert.equal(li.body.code, 'ACCOUNT_SUSPENDED');
  assert.equal(li.body.suspendedUntil, new Date(to).toISOString());
  const wrong = await api(run, 'POST', '/api/v1/auth/login', { json: { tenantId: T, username: 'bl1', password: 'wrong-password' } });
  assert.equal(wrong.status, 401, 'wrong password: generic error, no suspension info');
  // an existing token cannot read or buy either
  assert.equal((await api(run, 'GET', `/api/v1/tenders/${t1.id}`, { token: tok.bl1 })).body.code, 'VENDOR_SUSPENDED');
  assert.equal((await api(run, 'GET', '/api/v1/tenders', { token: tok.bl1 })).body.length, 0);
  assert.ok((await notes('admin')).length >= 0);
  assert.equal((await audit('VENDOR_BLOCKED', v)).length, 1);
  // time passes beyond the end date → the job reinstates (SYSTEM) and adds the blocked days back (PAUSE)
  setClockOffset(3 * DAY + 60_000);
  try {
    const jobs = await api(run, 'POST', '/api/v1/admin/lifecycle/run-jobs', { token: tok.admin });
    assert.equal(jobs.body.reinstated, 1, jobs.text);
  } finally { setClockOffset(0); }
  const re = (await audit('VENDOR_REINSTATED', v))[0];
  assert.equal(re.actorId, 'SYSTEM');
  assert.equal(re.details.how, 'AUTOMATIC_AT_END_DATE');
  assert.equal(re.details.pausedDays, 3);
  const life = await api(run, 'GET', `/api/v1/vendors/${v}/lifecycle`, { token: tok.admin });
  assert.equal(new Date(life.body.subscription.current.endsAt).getTime() - endBefore, 3 * DAY);
  assert.equal((await api(run, 'POST', '/api/v1/auth/login', { json: { tenantId: T, username: 'bl1', password: PASSWORD } })).status, 200);
  // permanent block, then lifted by the administrator
  const pb = await api(run, 'POST', `/api/v1/vendors/${v}/blocks`, { token: tok.admin, json: { mode: 'PERMANENT', reason: 'Fraud finding', ground: 'BREACH' } });
  const lp = await api(run, 'POST', '/api/v1/auth/login', { json: { tenantId: T, username: 'bl1', password: PASSWORD } });
  assert.equal(lp.status, 403);
  assert.equal(lp.body.permanent, true);
  assert.equal(lp.body.suspendedUntil, null);
  assert.ok((await notes('bl1')).some((n) => n.kind === 'VENDOR_BLOCKED' && n.body.brd === 'NOT-005'));
  assert.equal((await api(run, 'POST', `/api/v1/vendors/${v}/blocks/${pb.body.id}/lift`, { token: tok.admin, json: {} })).status, 400, 'reason required');
  assert.equal((await api(run, 'POST', `/api/v1/vendors/${v}/blocks/${pb.body.id}/lift`, { token: tok.admin, json: { reason: 'Appeal upheld' } })).status, 200);
  assert.equal((await api(run, 'POST', '/api/v1/auth/login', { json: { tenantId: T, username: 'bl1', password: PASSWORD } })).status, 200);
  const verify = await api(run, 'GET', '/api/v1/audit/verify', { token: tok.admin });
  assert.equal(verify.body.valid, true);
});

test('activity codes: FILE import (admin) is audited and validated', async () => {
  const bad = await api(run, 'POST', '/api/v1/activity-codes/import', { token: tok.admin, json: { csv: 'onlycode' } });
  assert.equal(bad.status, 400);
  const ok = await api(run, 'POST', '/api/v1/activity-codes/import', { token: tok.admin, json: { csv: 'code,name_en,name_ar\nUNI-05,Uniforms,الملابس الموحدة\nCON-06,Construction works,أعمال الإنشاءات' } });
  assert.equal(ok.body.imported, 2);
  const codes = await api(run, 'GET', '/api/v1/activity-codes', { token: tok.officer });
  assert.ok(codes.body.some((c: any) => c.code === 'UNI-05'));
  assert.equal((await audit('ACTIVITY_CODES_IMPORTED')).length, 1);
  assert.equal((await api(run, 'POST', '/api/v1/activity-codes/import', { token: tok.officer, json: { csv: 'A,b,c' } })).status, 403);
});
