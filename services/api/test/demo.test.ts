// Demo workstream: presenter routes exist only with DEMO_MODE=true, stay inside the tenant and are audited.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, fileForm, login, makeTenant, makeUser, startApp, tenderBody, type Running } from './helpers.js';

const runs: Running[] = [];
after(async () => { for (const r of runs) await r.stop(); });

test('demo controls answer 404 when DEMO_MODE is off; status says disabled', async () => {
  const run = await startApp();
  runs.push(run);
  await makeTenant(run, 'off');
  await makeUser(run, 'off', 'officer', ['PROCUREMENT_OFFICER']);
  await makeUser(run, 'off', 'admin', ['TENANT_ADMIN']);
  const officer = await login(run, 'off', 'officer');
  // The status probe answers plainly (no failed request on every page); every control stays 404.
  const st = await api(run, 'GET', '/api/v1/demo/status', { token: officer });
  assert.equal(st.status, 200);
  assert.deepEqual(st.body, { enabled: false });
  assert.equal((await api(run, 'POST', '/api/v1/demo/persona', { token: officer, json: { username: 'admin' } })).status, 404);
  assert.equal((await api(run, 'GET', '/api/v1/demo/evidence', { token: officer })).status, 404);
  assert.equal((await api(run, 'POST', '/api/v1/demo/tenders/00000000-0000-4000-8000-000000000000/expire-deadline', { token: officer })).status, 404);
});

test('demo mode: status, persona switch within the tenant, expire deadline, evidence, audit chain', async () => {
  const run = await startApp(undefined, { DEMO_MODE: 'true' });
  runs.push(run);
  await makeTenant(run, 'dma');
  await makeTenant(run, 'dmb');
  const officerRow = await makeUser(run, 'dma', 'officer', ['PROCUREMENT_OFFICER']);
  await makeUser(run, 'dma', 'director', ['DIRECTOR']);
  await makeUser(run, 'dma', 'auditor', ['AUDITOR']);
  await makeUser(run, 'dmb', 'stranger', ['TENANT_ADMIN']);
  const officer = await login(run, 'dma', 'officer');

  // status: personas of the caller's tenant only + live integration status (filesystem store, AI not configured here)
  const st = await api(run, 'GET', '/api/v1/demo/status', { token: officer });
  assert.equal(st.status, 200, st.text);
  assert.equal(st.body.enabled, true);
  assert.equal(st.body.tenantId, 'dma');
  assert.deepEqual(st.body.personas.map((p: any) => p.username), ['auditor', 'director', 'officer']);
  assert.equal(st.body.integrations.contentStore.type, 'filesystem');
  assert.equal(st.body.integrations.contentStore.ok, true);
  assert.equal(typeof st.body.integrations.ai.configured, 'boolean');
  if (!st.body.integrations.ai.configured) assert.equal(st.body.integrations.ai.ok, false);

  // persona switch: other tenant's user is not reachable; same-tenant switch issues a real token
  const cross = await api(run, 'POST', '/api/v1/demo/persona', { token: officer, json: { username: 'stranger' } });
  assert.equal(cross.status, 404, cross.text);
  const sw = await api(run, 'POST', '/api/v1/demo/persona', { token: officer, json: { username: 'director' } });
  assert.equal(sw.status, 200, sw.text);
  assert.equal(sw.body.user.username, 'director');
  assert.equal(sw.body.user.tenantId, 'dma');
  const me = await api(run, 'GET', '/api/v1/auth/me', { token: sw.body.token });
  assert.equal(me.body.username, 'director');
  assert.deepEqual(me.body.roles, ['DIRECTOR']);

  // a published tender, closed on demand through the real close path
  const mk = await api(run, 'POST', '/api/v1/tenders', { token: officer, json: tenderBody(3 * 24 * 3600_000) });
  assert.equal(mk.status, 201, mk.text);
  const tid = mk.body.id;
  const up = await api(run, 'POST', `/api/v1/tenders/${tid}/documents`, { token: officer, form: fileForm({ file: { name: 'pack.md', content: '# 1. Scope\nTest.' } }) });
  assert.equal(up.status, 201, up.text);
  // expire-deadline refuses a tender that is not PUBLISHED
  const early = await api(run, 'POST', `/api/v1/demo/tenders/${tid}/expire-deadline`, { token: officer });
  assert.equal(early.status, 409, early.text);
  const ap = await api(run, 'POST', `/api/v1/tenders/${tid}/approve`, { token: sw.body.token, json: { reason: 'ok' } });
  assert.equal(ap.status, 200, ap.text);
  const pub = await api(run, 'POST', `/api/v1/tenders/${tid}/publish`, { token: officer });
  assert.equal(pub.status, 200, pub.text);
  const vendorTry = await api(run, 'POST', `/api/v1/demo/tenders/${tid}/expire-deadline`, { token: (await api(run, 'POST', '/api/v1/demo/persona', { token: officer, json: { username: 'auditor' } })).body.token });
  assert.equal(vendorTry.status, 200, 'auditor is staff');
  assert.equal(vendorTry.body.status, 'CLOSED');
  const detail = await api(run, 'GET', `/api/v1/tenders/${tid}`, { token: officer });
  assert.equal(detail.body.status, 'CLOSED');
  assert.ok(new Date(detail.body.submissionDeadline).getTime() <= Date.now());
  const again = await api(run, 'POST', `/api/v1/demo/tenders/${tid}/expire-deadline`, { token: officer });
  assert.equal(again.status, 409);

  // audit: persona switch + deadline advance + real TENDER_CLOSED by SYSTEM
  const auditor = await login(run, 'dma', 'auditor');
  const ev = await api(run, 'GET', '/api/v1/audit?limit=200', { token: auditor });
  const switches = ev.body.filter((e: any) => e.action === 'DEMO_PERSONA_SWITCH');
  assert.equal(switches.length, 2);
  const s1 = switches.find((e: any) => e.details.to === 'director');
  assert.equal(s1.actorId, officerRow.id);
  assert.equal(s1.details.from, 'officer');
  const adv = ev.body.find((e: any) => e.action === 'DEMO_DEADLINE_ADVANCED');
  assert.ok(adv.details.originalDeadline);
  assert.equal(adv.resourceId, tid);
  const closed = ev.body.find((e: any) => e.action === 'TENDER_CLOSED' && e.resourceId === tid);
  assert.equal(closed.actorId, 'SYSTEM');
  assert.ok(Number(closed.seq) > Number(adv.seq));
  assert.equal(ev.body.filter((e: any) => e.action === 'DEMO_PERSONA_SWITCH' && e.details.to === 'stranger').length, 0);

  // evidence: the stored pack is listed with its store reference; no cross-tenant leakage
  const evid = await api(run, 'GET', '/api/v1/demo/evidence?integration=filenet', { token: officer });
  assert.equal(evid.status, 200, evid.text);
  const stored = evid.body.find((e: any) => e.action === 'TENDER_DOCUMENT_UPLOADED');
  assert.ok(stored, JSON.stringify(evid.body));
  assert.equal(stored.store.type, 'filesystem');
  assert.ok(stored.store.ref);
  assert.equal(stored.integration, 'filenet');
  const stranger = await login(run, 'dmb', 'stranger');
  const evB = await api(run, 'GET', '/api/v1/demo/evidence', { token: stranger });
  assert.equal(evB.status, 200);
  assert.equal(evB.body.length, 0);

  // integrity: the audit chain still verifies after the demo controls
  const ver = await api(run, 'GET', '/api/v1/audit/verify', { token: auditor });
  assert.equal(ver.status, 200, ver.text);
  assert.equal(ver.body.valid, true, ver.text);
});

test('demo mode: vendors may switch persona but not use staff controls', async () => {
  const run = await startApp(undefined, { DEMO_MODE: 'true' });
  runs.push(run);
  await makeTenant(run, 'dmc');
  await makeUser(run, 'dmc', 'officer', ['PROCUREMENT_OFFICER']);
  const reg = await api(run, 'POST', '/api/v1/public/vendors/register', { json: { tenantId: 'dmc', legalNameEn: 'V (fictitious)', legalNameAr: 'ف (وهمية)',
    crNumber: 'CR-9', email: 'v@x.example', phone: '1', categories: ['IT'], username: 'vendor1', password: 'Test-Passw0rd!' } });
  assert.equal(reg.status, 201, reg.text);
  const vendor = await login(run, 'dmc', 'vendor1');
  assert.equal((await api(run, 'GET', '/api/v1/demo/evidence', { token: vendor })).status, 403);
  assert.equal((await api(run, 'POST', '/api/v1/demo/tenders/00000000-0000-4000-8000-000000000000/expire-deadline', { token: vendor })).status, 403);
  const st = await api(run, 'GET', '/api/v1/demo/status', { token: vendor });
  assert.equal(st.status, 200);
  const sw = await api(run, 'POST', '/api/v1/demo/persona', { token: vendor, json: { username: 'officer' } });
  assert.equal(sw.status, 200, sw.text);
  assert.deepEqual(sw.body.user.roles, ['PROCUREMENT_OFFICER']);
});
