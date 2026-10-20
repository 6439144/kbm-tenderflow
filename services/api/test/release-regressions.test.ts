// Regressions found by the release QA crawl of the dedicated MOI demo (every role × EN/AR), kept fixed here.
process.env.LIFECYCLE_JOB_INTERVAL_MS = '0';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, login, startApp, type Running } from './helpers.js';

const PW = 'Demo-Passw0rd!';
let run: Running;

before(async () => {
  run = await startApp(undefined, { TENANCY_MODE: 'dedicated', ENTITY_ID: 'moi', DEMO_ENTITY: 'moi', SEED_DEMO: 'true', DEMO_PASSWORD: PW, DOC_AI_AUTO: 'false' });
});
after(async () => { if (run) await run.stop(); });

test('sign-in hint: a demo installation lists the entity\'s own demo users (staff first, then vendors)', async () => {
  const r = await api(run, 'GET', '/api/v1/public/deployment');
  assert.equal(r.status, 200);
  assert.equal(r.body.entity.id, 'moi');
  assert.deepEqual(r.body.demoUsers.slice(0, 7), ['admin', 'auditor', 'director', 'grader', 'officer', 'tenderdept', 'undersecretary']);
  assert.ok(r.body.demoUsers.includes('vendor1') && !r.body.demoUsers.includes('chair'), 'MOI users only, not another entity\'s');
  for (const u of r.body.demoUsers) {
    const res = await api(run, 'POST', '/api/v1/auth/login', { json: { username: u, password: PW } });
    // vendor4 is blocked on purpose in the MOI demo story (blocking + automatic reinstatement)
    if (u === 'vendor4') assert.equal(res.status, 403, res.text); else assert.equal(res.status, 200, `${u}: ${res.text}`);
  }
});

test('presenter mode off: the status probe answers 200 { enabled:false }; the controls stay 404', async () => {
  const officer = await login(run, 'moi', 'officer', PW);
  const st = await api(run, 'GET', '/api/v1/demo/status', { token: officer });
  assert.equal(st.status, 200);
  assert.deepEqual(st.body, { enabled: false });
  assert.equal((await api(run, 'POST', '/api/v1/demo/persona', { token: officer, json: { username: 'admin' } })).status, 404);
});

test('a vendor not yet approved opens the portal without a failed request; ranking stays refused', async () => {
  // vendor3: application waiting in the grading queue
  const v3 = (await run.handle.ctx.db.query<{ status: string }>(
    `SELECT v.status FROM users u JOIN vendors v ON v.id = u.vendor_id WHERE u.tenant_id='moi' AND u.username='vendor3'`))[0];
  assert.notEqual(v3.status, 'APPROVED');
  const tok = await login(run, 'moi', 'vendor3', PW);
  const r = await api(run, 'GET', '/api/v1/vendor/ai/tenders-for-me', { token: tok });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.vendorApproved, false);
  assert.equal((await api(run, 'POST', '/api/v1/vendor/ai/tenders-for-me', { token: tok })).status, 409);
});
