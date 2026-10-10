// Dedicated edition (docs/DEPLOYMENT-MODEL.md): one installation = one government entity (TENANCY_MODE=dedicated,
// ENTITY_ID). The worst case is tested on purpose: the database ALSO holds two other entities (all three demo entities
// are seeded in shared mode first, then the same data directory is started dedicated to `kea`, like a restore of the
// wrong backup). Nothing of gcia or moi may reach any response, feed or AI prompt; another entity id is answered with
// 404 exactly like an entity that does not exist; tokens of another entity are refused; no entity can be created;
// background jobs touch only kea.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { api, AUDIT_SIGNING_KEY, BID_MASTER_KEY, login, sleep, startApp, type Running } from './helpers.js';
import { startFakeOrchestrate, type FakeCall, type FakeOrchestrate } from './fakes/orchestrate.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { evaluateConfig } from '../src/ops/checks.js';
import { resolveTenancy, TenancyStartupError } from '../src/tenancy.js';
import { provisionEntity } from '../src/ops/entity.js';
import { createTenant } from '../src/services/identity.js';
import { closeDueTenders } from '../src/services/tenders.js';
import { runJob } from '../src/services/scheduler.js';
import { readZip } from '../src/features/insight/zip.js';

const DEMO_PASSWORD = 'Demo-Passw0rd!';
const J = (o: unknown) => JSON.stringify(o);
/** Strings that exist only in the other two demo entities. */
const FOREIGN = ['gcia', 'GCIA', 'Gulf Coast', 'الساحلية', 'Breakwater', 'Jetty', 'Ministry of Interior', 'وزارة الداخلية', 'MOI-T-', 'MOI-RCPT', 'Border', 'tenderdept', 'grader'];
const leaks = (text: string) => FOREIGN.filter((m) => text.includes(m));
const assertClean = (what: string, text: string) => assert.deepEqual(leaks(text), [], `${what} leaks another entity: ${leaks(text).join(', ')}`);

let fake: FakeOrchestrate;
let run: Running;
let dataDir: string;
let gciaToken = '';
const tok: Record<string, string> = {};

function scripted(c: FakeCall): string {
  const markers = [...c.prompt.matchAll(/\[DOC ([^|\]]+?) \| [^|\]]*? \| ([^\]]+?)\]/g)].map((m) => ({ documentId: m[1].trim(), section: m[2].trim() }));
  if (c.agentName === 'tenderflow_assistant') return J({ answer: 'Answer from the TenderFlow context.', notFound: false, citations: markers.slice(0, 1) });
  if (c.agentName === 'tenderflow_relevance_matcher') {
    const ids = [...c.prompt.matchAll(/^- id (\S+) — /gm)].map((m) => m[1]);
    return J({ ranked: ids.map((id, i) => ({ id, score: 90 - i * 10, reasonsEn: 'Matching activity code.', reasonsAr: 'رمز نشاط مطابق.' })) });
  }
  return '{}';
}

before(async () => {
  fake = await startFakeOrchestrate();
  fake.reply = scripted;
  // 1) a database holding all three demo entities (shared mode), plus a session token of another entity
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ded-'));
  const shared = await startApp(dataDir, { SEED_DEMO: 'true', DEMO_PASSWORD, DOC_AI_AUTO: 'false' });
  try {
    gciaToken = await login(shared, 'gcia', 'officer', DEMO_PASSWORD);
  } finally {
    await shared.stop();
  }
  // 2) the same database started as a dedicated installation of kea, with (fake) Orchestrate configured
  Object.assign(process.env, fake.env);
  run = await startApp(dataDir, { TENANCY_MODE: 'dedicated', ENTITY_ID: 'kea', DOC_AI_AUTO: 'false' });
  for (const u of ['officer', 'director', 'chair', 'evaluator1', 'admin', 'auditor', 'vendor1']) {
    const r = await api(run, 'POST', '/api/v1/auth/login', { json: { username: u, password: DEMO_PASSWORD } }); // no tenantId
    assert.equal(r.status, 200, `${u}: ${r.text}`);
    tok[u] = r.body.token;
  }
});

after(async () => {
  if (run) await run.stop();
  await fake.close();
  for (const k of Object.keys(fake.env)) delete process.env[k];
});

// ------------------------------------------------------------------ configuration

test('config: dedicated is the default; values are validated with clear errors', () => {
  const base = { BID_MASTER_KEY, AUDIT_SIGNING_KEY };
  const c = loadConfig(base);
  assert.equal(c.tenancyMode, 'dedicated');
  assert.equal(c.entityId, undefined);
  assert.equal(c.demoEntity, 'kea');
  assert.equal(loadConfig({ ...base, ENTITY_ID: 'GCIA' }).entityId, 'gcia');
  assert.equal(loadConfig({ ...base, ENTITY_ID: 'moi' }).demoEntity, 'moi', 'DEMO_ENTITY follows a demo ENTITY_ID');
  assert.equal(loadConfig({ ...base, TENANCY_MODE: 'shared' }).tenancyMode, 'shared');
  const refuses = (env: Record<string, string>, re: RegExp) => assert.throws(() => loadConfig({ ...base, ...env }), (e: unknown) => e instanceof ConfigError && re.test(e.message), `expected ${re}`);
  refuses({ TENANCY_MODE: 'multi' }, /TENANCY_MODE must be one of dedicated, shared/);
  refuses({ ENTITY_ID: 'no spaces!' }, /ENTITY_ID must be an entity code/);
  refuses({ TENANCY_MODE: 'shared', ENTITY_ID: 'kea' }, /ENTITY_ID is only used with TENANCY_MODE=dedicated/);
  refuses({ DEMO_ENTITY: 'xyz' }, /DEMO_ENTITY must be one of kea, gcia, moi/);
  refuses({ SEED_DEMO: 'true', DEMO_PASSWORD, ENTITY_ID: 'kea', DEMO_ENTITY: 'gcia' }, /seeds DEMO_ENTITY \(gcia\), but ENTITY_ID is 'kea'/);
});

test('config: production refuses to start without ENTITY_ID (dedicated); config:check names it', () => {
  const prod = {
    TF_ENV: 'production', BID_MASTER_KEY, AUDIT_SIGNING_KEY, JWT_PRIVATE_KEY_PEM: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    DATABASE_URL: 'postgresql://tf:pw@db.example.local:5432/tf', PUBLIC_BASE_URL: 'https://tenders.example.gov.kw', TRUST_PROXY: '1',
  };
  assert.throws(() => loadConfig(prod), (e: unknown) => e instanceof ConfigError && /refuses to start with TF_ENV=production/.test(e.message) && /ENTITY_ID is not set/.test(e.message));
  assert.equal(loadConfig({ ...prod, ENTITY_ID: 'moh' }).entityId, 'moh');
  assert.equal(loadConfig({ ...prod, TENANCY_MODE: 'shared' }).tenancyMode, 'shared', 'shared stays possible as an explicit choice');
  assert.ok(evaluateConfig({ ...prod, TENANCY_MODE: 'shared' }).some((c) => c.id === 'TENANCY_MODE' && c.level === 'WARN'));
  assert.ok(evaluateConfig({ BID_MASTER_KEY, AUDIT_SIGNING_KEY }).some((c) => c.id === 'ENTITY_ID' && c.level === 'WARN' && /would refuse/.test(c.message)));
});

test('startup: unknown ENTITY_ID is refused; the entity is taken from the database only when unambiguous', async () => {
  const cfg = (extra: Partial<Parameters<typeof resolveTenancy>[0]>) => ({ tenancyMode: 'dedicated' as const, entityId: undefined, tfEnv: 'development' as const, seedDemo: false, demoEntity: 'kea' as const, ...extra });
  assert.throws(() => resolveTenancy(cfg({ entityId: 'moh', tfEnv: 'production' }), ['gcia', 'kea']), (e: unknown) => e instanceof TenancyStartupError && /ENTITY_ID 'moh' is not an entity in this database/.test((e as Error).message));
  assert.throws(() => resolveTenancy(cfg({ tfEnv: 'production' }), ['kea']), /ENTITY_ID is required/);
  // a fresh production database: the installation starts and waits for `npm run entity:create`
  const fresh = resolveTenancy(cfg({ entityId: 'moh', tfEnv: 'production' }), []);
  assert.deepEqual([fresh.mode, fresh.entityId], ['dedicated', 'moh']);
  assert.match(fresh.warnings.join(), /not provisioned yet/);
  assert.equal(resolveTenancy(cfg({}), ['kea']).entityId, 'kea', 'exactly one entity');
  assert.equal(resolveTenancy(cfg({ seedDemo: true, demoEntity: 'gcia' }), []).entityId, 'gcia', 'empty database + demo seed');
  const several = resolveTenancy(cfg({}), ['gcia', 'kea']);
  assert.equal(several.mode, 'shared', 'development: warn and keep a multi-entity database usable');
  assert.match(several.warnings.join(), /production refuses/);
  assert.deepEqual(resolveTenancy({ ...cfg({}), tenancyMode: 'shared' }, ['a', 'b']), { mode: 'shared', entityId: null, warnings: [] });
});

test('startup: ENTITY_ID that is not in a database holding other entities → refused', async () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ded-o-'));
  const h = await createApp(loadConfig({ BID_MASTER_KEY, AUDIT_SIGNING_KEY, DATA_DIR: other, TENANCY_MODE: 'shared', WEB_DIST_DIR: path.join(other, 'none') }));
  await createTenant(h.ctx, { id: 'kea', nameEn: 'K (fictitious)', nameAr: 'ك (وهمية)' });
  await sleep(500); // let the scheduler finish starting before the embedded database closes
  await h.close();
  await assert.rejects(createApp(loadConfig({ BID_MASTER_KEY, AUDIT_SIGNING_KEY, DATA_DIR: other, ENTITY_ID: 'moh', WEB_DIST_DIR: path.join(other, 'none') })),
    (e: unknown) => e instanceof TenancyStartupError && /ENTITY_ID 'moh' is not an entity in this database \(it holds: kea\)/.test((e as Error).message));
  const ok = await createApp(loadConfig({ BID_MASTER_KEY, AUDIT_SIGNING_KEY, DATA_DIR: other, WEB_DIST_DIR: path.join(other, 'none') }));
  try {
    assert.equal(ok.ctx.config.entityId, 'kea', 'the only entity in the database');
    assert.equal(ok.ctx.config.tenancyMode, 'dedicated');
  } finally { await ok.close(); }
});

// ------------------------------------------------------------------ deployment endpoint, login, registration

test('GET /public/deployment describes the dedicated installation (public fields only)', async () => {
  const r = await api(run, 'GET', '/api/v1/public/deployment');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { mode: 'dedicated', entity: { id: 'kea', nameEn: 'Kuwait Energy Authority (fictitious)', nameAr: 'هيئة الطاقة الكويتية (وهمية)', primaryColor: '#0B4F6C', logoText: 'KEA' } });
  const tenants = await api(run, 'GET', '/api/v1/public/tenants');
  assert.deepEqual(tenants.body.map((t: any) => t.id), ['kea'], 'the entity list has only this entity');
});

test('login: no tenant id needed; the own id is accepted; any other id is 404 whether or not it exists', async () => {
  const me = await api(run, 'GET', '/api/v1/auth/me', { token: tok.officer });
  assert.equal(me.body.tenantId, 'kea');
  assert.equal((await api(run, 'POST', '/api/v1/auth/login', { json: { tenantId: 'kea', username: 'officer', password: DEMO_PASSWORD } })).status, 200);
  const existing = await api(run, 'POST', '/api/v1/auth/login', { json: { tenantId: 'gcia', username: 'officer', password: DEMO_PASSWORD } });
  const missing = await api(run, 'POST', '/api/v1/auth/login', { json: { tenantId: 'nowhere', username: 'officer', password: DEMO_PASSWORD } });
  assert.equal(existing.status, 404);
  assert.deepEqual(existing.body, missing.body, 'same answer for an existing and a non-existing entity');
  // wrong password stays a 401 (no change for the own entity)
  assert.equal((await api(run, 'POST', '/api/v1/auth/login', { json: { username: 'officer', password: 'wrong-password' } })).status, 401);
  // moi users exist in this database but are never reachable
  assert.equal((await api(run, 'POST', '/api/v1/auth/login', { json: { tenantId: 'moi', username: 'tenderdept', password: DEMO_PASSWORD } })).status, 404);
  assert.equal((await api(run, 'POST', '/api/v1/auth/login', { json: { username: 'tenderdept', password: DEMO_PASSWORD } })).status, 401);
  // staff single sign-on start for another entity
  assert.equal((await fetch(`${run.base}/api/v1/auth/oidc/gcia/start`, { redirect: 'manual' })).status, 404);
});

test('a session token of another entity (same signing key) is refused; no token is ever issued for it', async () => {
  assert.ok(gciaToken);
  const r = await api(run, 'GET', '/api/v1/tenders', { token: gciaToken });
  assert.equal(r.status, 401);
  assert.match(r.body.message, /entity this installation does not serve/);
  const u = (await run.handle.ctx.db.query<any>(`SELECT * FROM users WHERE tenant_id='gcia' AND username='admin'`))[0];
  await assert.rejects(run.handle.ctx.tokens.issue(u), /does not serve/);
});

test('vendor registration: with this entity only; suppliers register separately with each entity', async () => {
  const body = { legalNameEn: 'Separate Registration Co. (fictitious)', legalNameAr: 'شركة التسجيل المنفصل (وهمية)', crNumber: 'CR-DED-1',
    email: 'sep@vendors.example', phone: '+965 0000 0001', categories: ['IT'], username: 'sepvendor', password: 'Vendor-Passw0rd!' };
  const ok = await api(run, 'POST', '/api/v1/public/vendors/register', { json: body });
  assert.equal(ok.status, 201, ok.text);
  assert.equal((await run.handle.ctx.db.query<any>(`SELECT tenant_id FROM vendors WHERE cr_number='CR-DED-1'`))[0].tenant_id, 'kea');
  for (const tenantId of ['gcia', 'moi', 'nowhere']) {
    const r = await api(run, 'POST', '/api/v1/public/vendors/register', { json: { ...body, tenantId, crNumber: `CR-DED-${tenantId}`, username: `v${tenantId}` } });
    assert.equal(r.status, 404, `${tenantId}: ${r.text}`);
    assert.equal(r.body.message, 'Entity not found');
  }
  assert.equal((await run.handle.ctx.db.query<any>(`SELECT count(*)::int AS n FROM vendors WHERE cr_number LIKE 'CR-DED-%'`))[0].n, 1);
  // the public vendor form: this entity's, never another's
  assert.equal((await api(run, 'GET', '/api/v1/public/forms/vendor')).status, 200);
  assert.equal((await api(run, 'GET', '/api/v1/public/forms/vendor?tenant=kea')).status, 200);
  assert.equal((await api(run, 'GET', '/api/v1/public/forms/vendor?tenant=moi')).status, 404);
});

// ------------------------------------------------------------------ public board and feeds

test('public board, RSS and JSON feed: only this entity; another entity filter is 404', async () => {
  const b = await api(run, 'GET', '/api/v1/public/tenders');
  assert.equal(b.status, 200);
  assert.ok(b.body.tenders.length >= 1);
  assert.ok(b.body.tenders.every((t: any) => t.entity.id === 'kea'));
  assert.deepEqual(b.body.entities.map((e: any) => e.id), ['kea']);
  assert.ok(b.body.tenders.every((t: any) => !t.url.includes('entity=')));
  assertClean('board', b.text);
  assert.equal((await api(run, 'GET', '/api/v1/public/tenders?entity=kea')).status, 200);
  for (const p of ['/api/v1/public/tenders?entity=gcia', '/api/v1/public/tenders.rss?entity=gcia', '/api/v1/public/tenders.json?entity=moi', '/api/v1/public/tenders?entity=nowhere'])
    assert.equal((await api(run, 'GET', p)).status, 404, p);
  const rss = await api(run, 'GET', '/api/v1/public/tenders.rss');
  assert.match(rss.text, /<title>Public tenders of Kuwait Energy Authority \(fictitious\) \/ المناقصات العامة — هيئة الطاقة الكويتية \(وهمية\)<\/title>/);
  assert.doesNotMatch(rss.text, /participating|المشاركة/);
  assertClean('rss', rss.text);
  const json = await api(run, 'GET', '/api/v1/public/tenders.json');
  assert.match(json.body.title, /^Public tenders of Kuwait Energy Authority/);
  assert.ok(json.body.items.every((i: any) => i._tenderflow.entity.id === 'kea'));
  assertClean('json feed', json.text);
});

// ------------------------------------------------------------------ platform-level operations

test('creating another entity is disabled (entity:create, services); the own entity can still be completed', async () => {
  const ctx = run.handle.ctx;
  await assert.rejects(provisionEntity(ctx, { code: 'moh', nameEn: 'Ministry of Health (fictitious)', nameAr: 'وزارة الصحة (وهمية)' }),
    (e: any) => e.status === 403 && e.code === 'ENTITY_CREATION_DISABLED');
  await assert.rejects(provisionEntity(ctx, { code: 'moh', nameEn: 'Ministry of Health (fictitious)', nameAr: 'وزارة الصحة (وهمية)' }, { dryRun: true }),
    (e: any) => e.code === 'ENTITY_CREATION_DISABLED', 'a dry run is refused too');
  await assert.rejects(createTenant(ctx, { id: 'moh', nameEn: 'x', nameAr: 'س' }), (e: any) => e.code === 'ENTITY_CREATION_DISABLED');
  assert.equal((await ctx.db.query<any>(`SELECT count(*)::int AS n FROM tenants WHERE id='moh'`))[0].n, 0);
  const own = await provisionEntity(ctx, { code: 'kea', nameEn: 'Kuwait Energy Authority (fictitious)', nameAr: 'هيئة الطاقة الكويتية (وهمية)' });
  assert.equal(own.created.tenant, false);
});

test('background jobs and tender closing touch only this entity', async () => {
  const ctx = run.handle.ctx;
  const gciaOpen = (await ctx.db.query<any>(`SELECT id FROM tenders WHERE tenant_id='gcia' AND status='PUBLISHED' LIMIT 1`))[0];
  await ctx.db.query(`UPDATE tenders SET submission_deadline=now() - interval '1 minute' WHERE id=$1`, [gciaOpen.id]);
  await closeDueTenders(ctx);
  assert.equal((await ctx.db.query<any>('SELECT status FROM tenders WHERE id=$1', [gciaOpen.id]))[0].status, 'PUBLISHED', 'another entity\'s tender is not touched');
  const r = await runJob(ctx, 'approval-escalation', { trigger: 'SCHEDULE' });
  assert.equal(r.status, 'OK', r.error);
  const row = (await ctx.db.query<any>(`SELECT last_result FROM scheduled_jobs WHERE name='approval-escalation'`))[0];
  assert.equal(row.last_result.scope, 'ENTITY');
  assert.equal(row.last_result.tenantId, 'kea');
});

// ------------------------------------------------------------------ analytics, dashboards, evidence, AI context

test('every staff and vendor screen of the entity is free of other entities\' data', async () => {
  const reads: [string, string][] = [
    ['officer', '/api/v1/dashboard'], ['officer', '/api/v1/insight/dashboard'], ['officer', '/api/v1/tenders'], ['officer', '/api/v1/vendors'],
    ['officer', '/api/v1/requests'], ['officer', '/api/v1/document-insights'], ['officer', '/api/v1/notifications'],
    ['officer', '/api/v1/lowcode/tasks'], ['officer', '/api/v1/assistant/my-tasks'], ['officer', '/api/v1/activity-codes'], ['officer', '/api/v1/templates'],
    ['director', '/api/v1/insight/dashboard'], ['director', '/api/v1/insight/analytics'], ['director', '/api/v1/insight/approvals-waiting'], ['director', '/api/v1/approvals/overdue'],
    ['chair', '/api/v1/insight/dashboard'], ['evaluator1', '/api/v1/insight/dashboard'],
    ['admin', '/api/v1/insight/analytics'], ['admin', '/api/v1/admin/users'], ['admin', '/api/v1/security/users'], ['admin', '/api/v1/admin/jobs'],
    ['admin', '/api/v1/admin/notification-deliveries'], ['admin', '/api/v1/admin/notification-templates'], ['admin', '/api/v1/lowcode/definitions'],
    ['admin', '/api/v1/lowcode/process-map'], ['admin', '/api/v1/lowcode/package'], ['admin', '/api/v1/admin/vendor-lifecycle'], ['admin', '/api/v1/entity/profile'],
    ['admin', '/api/v1/entity/policies'], ['admin', '/api/v1/document-types'], ['admin', '/api/v1/assistant/insights'], ['admin', '/api/v1/insight/dashboard'],
    ['auditor', '/api/v1/audit?limit=1000'], ['auditor', '/api/v1/audit/verify'], ['auditor', '/api/v1/insight/analytics'], ['auditor', '/api/v1/audit/evidence-packs'],
    ['auditor', '/api/v1/insight/dashboard'],
    ['vendor1', '/api/v1/tenders'], ['vendor1', '/api/v1/vendors/me'], ['vendor1', '/api/v1/insight/dashboard'], ['vendor1', '/api/v1/vendor/ai/tenders-for-me'],
    ['vendor1', '/api/v1/notifications'], ['vendor1', '/api/v1/vendor/me/lifecycle'],
  ];
  for (const [u, p] of reads) {
    const r = await api(run, 'GET', p, { token: tok[u] });
    assert.equal(r.status, 200, `${u} ${p}: ${r.status} ${r.text.slice(0, 200)}`);
    assertClean(`${u} ${p}`, r.text);
  }
  const audit = await api(run, 'GET', '/api/v1/audit?limit=1000', { token: tok.auditor });
  assert.ok(audit.body.length > 10);
  assert.equal((await api(run, 'GET', '/api/v1/audit/verify', { token: tok.auditor })).body.valid, true);
});

test('auditor evidence pack (date range) contains only this entity', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const r = await api(run, 'POST', '/api/v1/audit/evidence-pack', { token: tok.auditor, json: { from: today, to: today } });
  assert.equal(r.status, 201, r.text);
  const dl = await fetch(run.base + r.body.downloadUrl, { headers: { authorization: `Bearer ${tok.auditor}` } });
  assert.equal(dl.status, 200);
  const files = readZip(Buffer.from(await dl.arrayBuffer()));
  assert.equal(JSON.parse(files.get('manifest.json')!.toString()).entity.id, 'kea');
  for (const [name, data] of files) assertClean(`evidence ${name}`, data.toString('utf8'));
});

test('Orchestrate prompts (assistant chat, vendor ranking) carry only this entity\'s data', async () => {
  fake.calls.length = 0;
  for (const u of ['officer', 'director', 'admin', 'auditor', 'chair', 'vendor1']) {
    const r = await api(run, 'POST', '/api/v1/assistant/chat', { token: tok[u], json: { message: 'Which tenders and vendors need attention across all entities?' } });
    assert.equal(r.status, 201, `${u}: ${r.text}`);
  }
  const rank = await api(run, 'POST', '/api/v1/vendor/ai/tenders-for-me', { token: tok.vendor1 });
  assert.equal(rank.status, 201, rank.text);
  const pub = (await api(run, 'GET', '/api/v1/tenders', { token: tok.officer })).body.find((t: any) => t.tenderNumber === 'KEA-2026-102');
  const rel = await api(run, 'POST', `/api/v1/tenders/${pub.id}/ai/relevance`, { token: tok.director });
  assert.equal(rel.status, 201, rel.text);
  assert.ok(fake.calls.length >= 8);
  for (const c of fake.calls) assertClean(`prompt to ${c.agentName}`, c.prompt);
});
