// The `moi` demo entity (reference configuration from the MOI BRD) seeds through the real services and behaves as
// the demo story says.
process.env.LIFECYCLE_JOB_INTERVAL_MS = '0';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, fileForm, login, startApp } from './helpers.js';

const PW = 'Demo-Passw0rd!';

test('moi seed: policies + catalogue, eligibility-filtered viewing, MOI receipts, exemption, blocked login, grading queue, reminder', async () => {
  const run = await startApp(undefined, { SEED_DEMO: 'true', DEMO_PASSWORD: PW });
  try {
    const ten = await api(run, 'GET', '/api/v1/public/tenants');
    const moi = ten.body.find((t: any) => t.id === 'moi');
    assert.match(moi.nameEn, /reference configuration · demo data/);
    const admin = await login(run, 'moi', 'admin', PW);
    const pol = await api(run, 'GET', '/api/v1/entity/policies', { token: admin });
    assert.equal(pol.body.reference, 'MOI-BRD-v0.1');
    assert.equal(pol.body.policies.visibility, 'ELIGIBLE_ONLY');
    assert.equal(pol.body.catalogue.annotations.gradeMatch.status, 'OPEN');
    assert.equal(pol.body.catalogue.openItems.length, 25);

    const officer = await login(run, 'moi', 'officer', PW);
    const list = await api(run, 'GET', '/api/v1/tenders', { token: officer });
    const pub = list.body.find((t: any) => t.status === 'PUBLISHED');
    const draft = list.body.find((t: any) => t.status === 'DRAFT');
    assert.match(pub.tenderNumber, /^MOI-T-\d{4}-\d{3}$/);
    assert.ok(draft);
    assert.equal(pub.cycle.scope, 'PUBLICATION_AND_SALE');
    const reqs = await api(run, 'GET', '/api/v1/requests', { token: officer });
    assert.deepEqual(reqs.body.map((r: any) => r.source).sort(), ['LETTER', 'RASLNI']);
    const letter = reqs.body.find((r: any) => r.source === 'LETTER');
    assert.equal(letter.status, 'SUBMITTED');
    const det = await api(run, 'GET', `/api/v1/requests/${letter.id}`, { token: officer });
    assert.equal(det.body.approvalChain.length, 2);
    assert.match(det.body.approvalChain[0].labelEn, /illustrative/);
    assert.equal(det.body.letter.title, 'GM letter — patrol vehicles (sample scan)');

    // vendor1 (security, First) sees the CCTV tender; vendor2 (vehicles) does not
    const v1 = await login(run, 'moi', 'vendor1', PW);
    const v2 = await login(run, 'moi', 'vendor2', PW);
    assert.deepEqual((await api(run, 'GET', '/api/v1/tenders', { token: v1 })).body.map((t: any) => t.id), [pub.id]);
    assert.equal((await api(run, 'GET', '/api/v1/tenders', { token: v2 })).body.length, 0);
    assert.equal((await api(run, 'GET', `/api/v1/tenders/${pub.id}`, { token: v2 })).status, 404);
    // bidding is outside Phase 1
    const bid = await api(run, 'POST', `/api/v1/tenders/${pub.id}/bids`, { token: v1, form: fileForm({ technical: { name: 't.md', content: 't' }, financial: { name: 'f.md', content: 'f' } }) });
    assert.equal(bid.body.code, 'STAGE_NOT_IN_SCOPE');
    // purchase (TEST) → MOI receipt; exempt vendor5 → EXEMPT
    const buy = await api(run, 'POST', `/api/v1/tenders/${pub.id}/purchase`, { token: v1, json: { gateway: 'TEST' } });
    assert.equal(buy.status, 201, buy.text);
    assert.match(buy.body.receiptNumber, /^MOI-RCPT-\d{4}-\d{6}$/);
    const rc = await api(run, 'GET', `/api/v1/receipts/${buy.body.receiptNumber}`, { token: v1 });
    assert.equal(rc.body.gatewayTransactionId, buy.body.paymentRef);
    const v5 = await login(run, 'moi', 'vendor5', PW);
    assert.equal((await api(run, 'POST', `/api/v1/tenders/${pub.id}/purchase`, { token: v5, json: {} })).body.gateway, 'EXEMPT');

    // blocked vendor4: login refused with the date
    const l4 = await api(run, 'POST', '/api/v1/auth/login', { json: { tenantId: 'moi', username: 'vendor4', password: PW } });
    assert.equal(l4.body.code, 'ACCOUNT_SUSPENDED');
    assert.ok(new Date(l4.body.suspendedUntil).getTime() > Date.now() + 6 * 86_400_000);

    // grading queue: vendor3 application + vendor2 upgrade request
    const grader = await login(run, 'moi', 'grader', PW);
    const q = await api(run, 'GET', '/api/v1/grading/queue', { token: grader });
    assert.equal(q.body.applications.length, 1);
    assert.equal(q.body.upgradeRequests.filter((g: any) => g.status === 'SUBMITTED').length, 1);

    // vendor2's subscription ends in 5 days → the reminder job sends NOT-001 once
    const life2 = await api(run, 'GET', '/api/v1/vendor/me/lifecycle', { token: v2 });
    assert.equal(life2.body.subscription.daysLeft, 5);
    await api(run, 'POST', '/api/v1/admin/lifecycle/run-jobs', { token: admin });
    await api(run, 'POST', '/api/v1/admin/lifecycle/run-jobs', { token: admin });
    const n2 = (await api(run, 'GET', '/api/v1/notifications', { token: v2 })).body.filter((n: any) => n.kind === 'SUBSCRIPTION_RENEWAL_REMINDER');
    assert.equal(n2.length, 1);

    const auditor = await login(run, 'moi', 'auditor', PW);
    assert.equal((await api(run, 'GET', '/api/v1/audit/verify', { token: auditor })).body.valid, true);
  } finally {
    await run.stop();
  }
});
