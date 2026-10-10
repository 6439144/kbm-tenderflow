import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { SignJWT } from 'jose';
import { api, fileForm, login, makeTenant, makeUser, startApp, tenderBody, type Running } from './helpers.js';
import { registerVendor } from '../src/services/vendors.js';
import { verifyAudit } from '../src/services/audit.js';

let run: Running;
let officerA: string; let officerB: string; let directorA: string; let vendorA: string; let auditorA: string;
let tenderA: string;

before(async () => {
  run = await startApp();
  await makeTenant(run, 'ta');
  await makeTenant(run, 'tb');
  await makeUser(run, 'ta', 'officer', ['PROCUREMENT_OFFICER']);
  await makeUser(run, 'ta', 'director', ['DIRECTOR']);
  await makeUser(run, 'ta', 'auditor', ['AUDITOR']);
  await makeUser(run, 'ta', 'both', ['PROCUREMENT_OFFICER', 'DIRECTOR']);
  await makeUser(run, 'tb', 'officer', ['PROCUREMENT_OFFICER']);
  await registerVendor(run.handle.ctx, { tenantId: 'ta', legalNameEn: 'V (fictitious)', legalNameAr: 'م (وهمية)', crNumber: 'CR-9',
    email: 'v@vendors.example', categories: ['IT'], username: 'vend', password: 'Test-Passw0rd!' });
  officerA = await login(run, 'ta', 'officer');
  directorA = await login(run, 'ta', 'director');
  auditorA = await login(run, 'ta', 'auditor');
  officerB = await login(run, 'tb', 'officer');
  vendorA = await login(run, 'ta', 'vend');
  const t = await api(run, 'POST', '/api/v1/tenders', { token: officerA, json: tenderBody(3600_000) });
  assert.equal(t.status, 201, t.text);
  tenderA = t.body.id;
});
after(async () => { await run.stop(); });

test('anonymous request to a protected route → 401', async () => {
  const r = await api(run, 'GET', '/api/v1/tenders');
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'UNAUTHORIZED');
});

test('vendor calling an officer route → 403', async () => {
  const r = await api(run, 'POST', '/api/v1/tenders', { token: vendorA, json: tenderBody(3600_000) });
  assert.equal(r.status, 403);
  assert.equal((await api(run, 'GET', '/api/v1/vendors', { token: vendorA })).status, 403);
});

test('user of tenant B cannot see tenant A tender → 404', async () => {
  assert.equal((await api(run, 'GET', `/api/v1/tenders/${tenderA}`, { token: officerB })).status, 404);
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${tenderA}/publish`, { token: officerB })).status, 404);
  const list = await api(run, 'GET', '/api/v1/tenders', { token: officerB });
  assert.equal(list.body.length, 0);
});

test('forged RS256 token (different key) → 401; HS256 token → 401; token without tenant_id → 401', async () => {
  const claims = { tenant_id: 'ta', roles: ['PROCUREMENT_OFFICER'], preferred_username: 'officer' };
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const forged = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256' }).setSubject(crypto.randomUUID())
    .setIssuer('http://tenderflow.test').setAudience('tenderflow').setExpirationTime('1h').sign(privateKey);
  assert.equal((await api(run, 'GET', '/api/v1/tenders', { token: forged })).status, 401);

  const hs = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setSubject(crypto.randomUUID())
    .setIssuer('http://tenderflow.test').setAudience('tenderflow').setExpirationTime('1h').sign(new TextEncoder().encode('x'.repeat(32)));
  assert.equal((await api(run, 'GET', '/api/v1/tenders', { token: hs })).status, 401);

  // Correctly signed with the real key, but no tenant_id → rejected
  const key = (await run.handle.ctx.db.query<{ private_pem: string }>('SELECT private_pem FROM signing_keys'))[0].private_pem;
  const officerId = (await run.handle.ctx.db.query<{ id: string }>(`SELECT id FROM users WHERE tenant_id='ta' AND username='officer'`))[0].id;
  const good = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256' }).setSubject(officerId)
    .setIssuer('http://tenderflow.test').setAudience('tenderflow').setExpirationTime('1h').sign(crypto.createPrivateKey(key));
  assert.equal((await api(run, 'GET', '/api/v1/tenders', { token: good })).status, 200, 'control: real key + tenant_id accepted');
  const noTenant = await new SignJWT({ roles: ['PROCUREMENT_OFFICER'] }).setProtectedHeader({ alg: 'RS256' }).setSubject(officerId)
    .setIssuer('http://tenderflow.test').setAudience('tenderflow').setExpirationTime('1h').sign(crypto.createPrivateKey(key));
  const r = await api(run, 'GET', '/api/v1/tenders', { token: noTenant });
  assert.equal(r.status, 401);
  // JWKS published
  const jwks = await api(run, 'GET', '/.well-known/jwks.json');
  assert.equal(jwks.body.keys[0].alg, 'RS256');
  assert.equal(jwks.body.keys[0].d, undefined, 'no private material in JWKS');
});

test('creator cannot approve own tender', async () => {
  const both = await login(run, 'ta', 'both');
  const t = await api(run, 'POST', '/api/v1/tenders', { token: both, json: tenderBody(3600_000) });
  assert.equal(t.status, 201);
  await api(run, 'POST', `/api/v1/tenders/${t.body.id}/documents`, { token: both, form: fileForm({ file: { name: 'p.txt', content: 'pack' } }) });
  const r = await api(run, 'POST', `/api/v1/tenders/${t.body.id}/approve`, { token: both, json: {} });
  assert.equal(r.status, 403, r.text);
  const ok = await api(run, 'POST', `/api/v1/tenders/${t.body.id}/approve`, { token: directorA, json: {} });
  assert.equal(ok.status, 200, ok.text);
});

test('upload type validation rejects disguised files', async () => {
  const r = await api(run, 'POST', `/api/v1/tenders/${tenderA}/documents`, { token: officerA,
    form: fileForm({ file: { name: 'evil.pdf', content: Buffer.from('MZ\x90\x00binary\x00\x01'), type: 'application/pdf' } }) });
  assert.equal(r.status, 415, r.text);
});

test('AI routes return 503 AI_NOT_CONFIGURED with the placeholder AI service (no canned text)', async () => {
  const up = await api(run, 'POST', `/api/v1/tenders/${tenderA}/documents`, { token: officerA,
    form: fileForm({ title: 'Pack', file: { name: 'pack.md', content: '# 1. Scope\nThings.\n\n# 2. Timeline\nSoon.' } }) });
  assert.equal(up.status, 201, up.text);
  const r = await api(run, 'POST', `/api/v1/tenders/${tenderA}/ai/pack-check`, { token: officerA, json: {} });
  assert.equal(r.status, 503, r.text);
  assert.equal(r.body.code, 'AI_NOT_CONFIGURED');
  assert.deepEqual(Object.keys(r.body).sort(), ['aiRunId', 'code', 'message']);
  const runs = await run.handle.ctx.db.query<any>('SELECT * FROM ai_runs WHERE id=$1', [r.body.aiRunId]);
  assert.equal(runs[0].status, 'ERROR');
  assert.equal(runs[0].response, null);
  // review of a failed run is refused
  assert.equal((await api(run, 'POST', `/api/v1/ai-runs/${r.body.aiRunId}/review`, { token: officerA, json: { decision: 'ACCEPTED' } })).status, 409);
  const ready = await api(run, 'GET', '/ready', { token: auditorA }); // details only for TENANT_ADMIN / AUDITOR (HARDEN)
  assert.equal(ready.status, 200);
  assert.equal(ready.body.checks.ai.ok, false);
  assert.equal(ready.body.checks.database.ok, true);
});

test('audit trail is append-only and tampering is detected', async () => {
  const db = run.handle.ctx.db;
  const v1 = await api(run, 'GET', '/api/v1/audit/verify', { token: auditorA });
  assert.equal(v1.body.valid, true);
  assert.ok(v1.body.count > 3);
  await assert.rejects(db.query(`UPDATE audit_events SET reason='x' WHERE tenant_id='ta'`), /append-only/);
  await assert.rejects(db.query(`DELETE FROM audit_events WHERE tenant_id='ta'`), /append-only/);
  const target = (await db.query<{ seq: string }>(`SELECT seq::text AS seq FROM audit_events WHERE tenant_id='ta' ORDER BY seq LIMIT 1 OFFSET 2`))[0].seq;
  await db.exec('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete');
  await db.query(`UPDATE audit_events SET reason='tampered' WHERE seq=$1`, [target]);
  await db.exec('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update_delete');
  const v2 = await api(run, 'GET', '/api/v1/audit/verify', { token: auditorA });
  assert.equal(v2.body.valid, false);
  assert.equal(v2.body.brokenAt, Number(target));
  // the other tenant's chain is unaffected
  assert.equal((await verifyAudit(db, run.handle.ctx.config.auditSigningKey, 'tb')).valid, true);
});
