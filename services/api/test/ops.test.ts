// OPS workstream: production safety, config:check (never prints secrets), entity:create, version / health / ready,
// migrations under the advisory lock, signing-key creation race, graceful shutdown.
// PostgreSQL-only cases run only when TEST_DATABASE_URL is set (they create and drop their own schema).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { api, login, makeTenant, startApp, BID_MASTER_KEY, AUDIT_SIGNING_KEY } from './helpers.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { openDb, migrate, pendingMigrations, MIGRATIONS_DIR, type Db } from '../src/db.js';
import { TokenService } from '../src/auth/tokens.js';
import { evaluateConfig, productionProblems } from '../src/ops/checks.js';
import { buildConfigReport, formatReport } from '../src/ops/config-report.js';
import { provisionEntity } from '../src/ops/entity.js';
import { versionInfo } from '../src/ops/version.js';
import { gracefulShutdown } from '../src/ops/shutdown.js';
import { verifyAudit } from '../src/services/audit.js';

const API_DIR = path.resolve(import.meta.dirname, '..');
const tmp = (p = 'tf-ops-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const JWT_PEM = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const WEAK_PEM = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const MIGRATION_COUNT = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).length;

/** A production configuration that passes every safety rule (DATABASE_URL is not contacted by loadConfig). */
const goodProd = (): Record<string, string> => ({
  TF_ENV: 'production', BID_MASTER_KEY, AUDIT_SIGNING_KEY, JWT_PRIVATE_KEY_PEM: JWT_PEM,
  DATABASE_URL: 'postgresql://tf_app:pg-pass-marker-77@db.tenderflow.svc:5432/tenderflow', PUBLIC_BASE_URL: 'https://tenders.example.gov.kw',
  CONTENT_STORE_TYPE: 'filenet', FILENET_GRAPHQL_URL: 'https://filenet.example.local/content-services-graphql/graphql', FILENET_OBJECT_STORE: 'OS1',
  FILENET_SERVICE_USER: 'svc_tenderflow', FILENET_SERVICE_PASSWORD: 'fn-pass-marker-31', TRUST_PROXY: '1', DATA_DIR: tmp(),
});

function run(args: string[], env: Record<string, string>, timeoutMs = 60_000): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const base: Record<string, string> = {};
    for (const k of ['PATH', 'HOME', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[k]) base[k] = process.env[k]!;
    const child = spawn(process.execPath, ['--import', 'tsx', ...args], { cwd: API_DIR, env: { ...base, TF_ENV_FILE: path.join(tmp(), 'none.env'), ...env } });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timeout: ${args.join(' ')}`)); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

// ---------------------------------------------------------------- production safety
test('production: a safe configuration starts; TF_ENV must be a known value', () => {
  const c = loadConfig(goodProd());
  assert.equal(c.tfEnv, 'production');
  assert.equal(c.trustProxy, 1);
  assert.deepEqual(productionProblems(goodProd()), []);
  assert.throws(() => loadConfig({ ...goodProd(), TF_ENV: 'prod' }), (e: unknown) => e instanceof ConfigError && /TF_ENV must be one of/.test(e.message));
  assert.equal(loadConfig({ BID_MASTER_KEY, AUDIT_SIGNING_KEY }).tfEnv, 'development');
  assert.deepEqual(loadConfig({ BID_MASTER_KEY, AUDIT_SIGNING_KEY, TRUST_PROXY: 'loopback, 10.128.0.0/14' }).trustProxy, ['loopback', '10.128.0.0/14']);
  assert.equal(loadConfig({ BID_MASTER_KEY, AUDIT_SIGNING_KEY, TRUST_PROXY: 'false' }).trustProxy, false);
});

test('production: refuses to start and lists every unsafe setting at once', () => {
  const env = {
    ...goodProd(), DEMO_MODE: 'true', SEED_DEMO: 'true', DEMO_PASSWORD: 'demo-pass-marker-12', DATABASE_URL: '', PUBLIC_BASE_URL: 'http://tenders.example.gov.kw',
    FILENET_GRAPHQL_URL: 'http://filenet.example.local:9080/content-services-graphql/graphql',
  };
  let msg = '';
  assert.throws(() => loadConfig(env), (e: unknown) => { msg = (e as Error).message; return e instanceof ConfigError; });
  assert.match(msg, /refuses to start with TF_ENV=production/);
  for (const re of [/DEMO_MODE=true/, /SEED_DEMO=true/, /DEMO_PASSWORD is set/, /PGlite/, /PUBLIC_BASE_URL must be https/, /FileNet over plain http/, /config:check/])
    assert.match(msg, re);
  assert.ok(!msg.includes('demo-pass-marker-12') && !msg.includes('fn-pass-marker-31'), 'no secret value in the refusal');
  // the same settings outside production only warn
  const dev = { ...env, TF_ENV: 'development' };
  assert.equal(loadConfig(dev).tfEnv, 'development');
  assert.ok(evaluateConfig(dev).some((c) => c.level === 'WARN' && /would refuse to start/.test(c.message)));
  // explicit opt-in for plain-http FileNet (e.g. an internal TechZone endpoint)
  assert.doesNotThrow(() => loadConfig({ ...goodProd(), FILENET_GRAPHQL_URL: 'http://filenet.example.local:9080/graphql', ALLOW_INSECURE_FILENET: 'true' }));
});

test('production: missing, weak, default or reused keys are refused', () => {
  const refuses = (extra: Record<string, string>, re: RegExp) =>
    assert.throws(() => loadConfig({ ...goodProd(), ...extra }), (e: unknown) => e instanceof ConfigError && re.test(e.message), `expected ${re}`);
  refuses({ BID_MASTER_KEY: Buffer.alloc(32).toString('base64') }, /BID_MASTER_KEY is a weak or placeholder/);
  refuses({ AUDIT_SIGNING_KEY: 'changeme-changeme-changeme-changeme' }, /AUDIT_SIGNING_KEY is weak or a placeholder/);
  refuses({ AUDIT_SIGNING_KEY: 'a1b2c3d4e5f6a7b8c9d0' }, /AUDIT_SIGNING_KEY is weak/); // only 20 characters
  refuses({ AUDIT_SIGNING_KEY: BID_MASTER_KEY }, /same value/);
  refuses({ JWT_PRIVATE_KEY_PEM: '' }, /JWT_PRIVATE_KEY_PEM is not set/);
  refuses({ JWT_PRIVATE_KEY_PEM: WEAK_PEM }, /1024-bit RSA key/);
  refuses({ MFA_ENC_KEY: Buffer.alloc(32, 7).toString('base64') }, /MFA_ENC_KEY is a weak/);
  refuses({ OIDC_ALLOW_HTTP: 'true' }, /OIDC_ALLOW_HTTP/);
  refuses({ BID_MASTER_KEY: '' }, /missing required environment variable: BID_MASTER_KEY/);
});

test('production: the server process exits 1 with the reasons and without secret values', async () => {
  const r = await run(['src/server.ts'], { ...goodProd(), DEMO_MODE: 'true', PUBLIC_BASE_URL: 'http://x.example' });
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, /refuses to start/);
  assert.match(r.err, /DEMO_MODE/);
  for (const secret of ['pg-pass-marker-77', 'fn-pass-marker-31', BID_MASTER_KEY, AUDIT_SIGNING_KEY]) assert.ok(!(r.out + r.err).includes(secret));
});

// ---------------------------------------------------------------- config:check
const SECRETS = {
  DEMO_PASSWORD: 'demo-pass-marker-12', FILENET_SERVICE_PASSWORD: 'fn-pass-marker-31', WXO_API_KEY: 'wxo-key-marker-55', SMTP_PASS: 'smtp-pass-marker-90',
  SMS_HTTP_AUTH_HEADER: 'Authorization: Bearer sms-token-marker-44', MFA_ENC_KEY: crypto.randomBytes(32).toString('base64'),
  TF_OIDC_SECRET_KEA: 'oidc-secret-marker-63', TF_ENTITY_ADMIN_PASSWORD: 'entity-admin-marker-21',
};
function assertNoSecrets(text: string, env: Record<string, string>) {
  const values = [BID_MASTER_KEY, AUDIT_SIGNING_KEY, 'pg-pass-marker-77', ...Object.values(SECRETS), ...Object.values(env).filter((v) => v.includes('PRIVATE KEY'))];
  for (const v of values) assert.ok(!text.includes(v), `secret value leaked: ${v.slice(0, 12)}…`);
  for (const line of JWT_PEM.split('\n').filter((l) => l.length > 20 && !l.startsWith('-----'))) assert.ok(!text.includes(line), 'PEM body leaked');
  assert.ok(!text.includes('sms-token-marker-44'));
}

test('config:check reports OK/WARN/FAIL for every check and never prints a secret value', async () => {
  const env = {
    ...goodProd(), ...SECRETS, DEMO_MODE: 'true', SEED_DEMO: 'true', WXO_INSTANCE_URL: 'https://api.example.watson-orchestrate.ibm.com/instances/x',
    SMTP_HOST: 'smtp.example.local', SMTP_FROM: 'tenders@example.gov.kw', SMS_HTTP_URL: 'https://sms.example.local/send',
  };
  const report = await buildConfigReport(env);
  const text = formatReport(report) + JSON.stringify(report);
  assertNoSecrets(text, env);
  assert.equal(report.exitCode, 1);
  const byId = Object.fromEntries(report.checks.map((c) => [c.id, c.level]));
  assert.equal(byId.DEMO_MODE, 'FAIL');
  assert.equal(byId.DEMO_PASSWORD, 'FAIL');
  assert.equal(byId.BID_MASTER_KEY, 'OK');
  assert.equal(byId.JWT_PRIVATE_KEY_PEM, 'OK');
  assert.equal(byId.STARTUP, 'FAIL');
  assert.match(text, /db\.tenderflow\.svc:5432\/tenderflow \(credentials hidden\)/);
  assert.match(text, /\[FAIL\] DEMO_MODE/);

  const clean = await buildConfigReport(goodProd());
  assert.equal(clean.exitCode, 0, formatReport(clean));
  assert.equal(clean.fails, 0);
});

test('config:check CLI: exit 1 on FAIL, 0 when clean; --connect never echoes the database password', async () => {
  const bad = await run(['src/tools/config-check.ts'], { ...goodProd(), ...SECRETS, DEMO_MODE: 'true' });
  assert.equal(bad.code, 1, bad.err);
  assert.match(bad.out, /\[FAIL\] DEMO_MODE/);
  assertNoSecrets(bad.out + bad.err, SECRETS);

  const good = await run(['src/tools/config-check.ts', '--json'], goodProd());
  assert.equal(good.code, 0, good.out + good.err);
  assert.equal(JSON.parse(good.out).fails, 0);

  // unreachable PostgreSQL (nothing listens on port 1): FAIL, and the password in DATABASE_URL never appears
  const unreachable = await run(['src/tools/config-check.ts', '--connect'], { ...goodProd(), DATABASE_URL: 'postgresql://tf_app:pg-pass-marker-77@127.0.0.1:1/tenderflow' });
  assert.equal(unreachable.code, 1);
  assert.match(unreachable.out, /\[FAIL\] DB_CONNECT/);
  assertNoSecrets(unreachable.out + unreachable.err, {});

  const missing = await run(['src/tools/config-check.ts'], { DATA_DIR: tmp() });
  assert.equal(missing.code, 1);
  assert.match(missing.out, /BID_MASTER_KEY is missing/);
});

// ---------------------------------------------------------------- entity:create
test('entity:create provisions an entity, its administrator, templates and catalogues; audited, no password in the audit', async () => {
  const app = await startApp();
  try {
    const ctx = app.handle.ctx;
    const r = await provisionEntity(ctx, {
      code: 'PAW', nameEn: 'Public Authority for Imaginary Works (fictitious)', nameAr: 'الهيئة العامة للأعمال الخيالية (وهمية)',
      colour: '#225588', sector: 'Works', defaultTemplate: 'RFP_TWO_ENVELOPE',
    });
    assert.equal(r.tenantId, 'paw');
    assert.ok(r.oneTimePassword && r.oneTimePassword.length >= 20);
    assert.deepEqual({ ...r.created, documentTypes: r.created.documentTypes > 0, notificationTemplates: r.created.notificationTemplates > 0 },
      { tenant: true, profile: true, admin: true, templates: 3, documentTypes: true, notificationTemplates: true, approvalSla: true });

    const t = (await ctx.db.query<any>('SELECT * FROM tenants WHERE id=$1', ['paw']))[0];
    assert.equal(t.primary_color, '#225588');
    assert.equal(t.profile.numberingPattern, 'PAW-{YYYY}-{SEQ3}');
    const tpl = await ctx.db.query<any>('SELECT code, is_default, status FROM cycle_templates WHERE tenant_id=$1 ORDER BY code', ['paw']);
    assert.equal(tpl.length, 3);
    assert.equal(tpl.find((x) => x.is_default).code, 'RFP_TWO_ENVELOPE');
    assert.ok(tpl.every((x) => x.status === 'PUBLISHED'));

    // the administrator signs in with the one-time password and sees the entity's templates
    const token = await login(app, 'paw', 'admin', r.oneTimePassword);
    const me = await api(app, 'GET', '/api/v1/templates', { token });
    assert.equal(me.status, 200, me.text);

    // audited: summary event, chain valid, the password nowhere in the audit log
    const events = await ctx.db.query<any>('SELECT action, details::text AS d FROM audit_events WHERE tenant_id=$1 ORDER BY seq', ['paw']);
    const actions = events.map((e) => e.action);
    for (const a of ['TENANT_CREATED', 'USER_CREATED', 'TEMPLATE_PUBLISHED', 'ENTITY_PROVISIONED']) assert.ok(actions.includes(a), a);
    assert.ok(events.every((e) => !e.d.includes(r.oneTimePassword!)));
    assert.equal(JSON.parse(events.find((e) => e.action === 'ENTITY_PROVISIONED').d).adminPasswordSource, 'GENERATED_ONE_TIME');
    assert.equal((await verifyAudit(ctx.db, AUDIT_SIGNING_KEY, 'paw')).valid, true);

    // idempotent: a second run changes nothing, writes no audit event and keeps the password
    const again = await provisionEntity(ctx, { code: 'paw', nameEn: 'Other name', nameAr: 'اسم آخر' });
    assert.deepEqual(again.created, { tenant: false, profile: false, admin: false, templates: 0, documentTypes: 0, notificationTemplates: 0, approvalSla: false });
    assert.equal(again.oneTimePassword, undefined);
    assert.ok(again.warnings.some((w) => /already exists/.test(w)) && again.warnings.some((w) => /NOT changed/.test(w)));
    assert.equal((await ctx.db.query<any>('SELECT count(*)::int AS n FROM audit_events WHERE tenant_id=$1', ['paw']))[0].n, events.length);
    assert.equal((await ctx.db.query<any>('SELECT name_en FROM tenants WHERE id=$1', ['paw']))[0].name_en, 'Public Authority for Imaginary Works (fictitious)');
    await login(app, 'paw', 'admin', r.oneTimePassword);

    // resume: an entity created by other means is completed (admin, templates, notifications), never duplicated
    await makeTenant(app, 'half');
    const fixed = 'Fixed-Admin-Passw0rd!';
    const done = await provisionEntity(ctx, { code: 'half', nameEn: 'Half Done (fictitious)', nameAr: 'نصف منجز (وهمية)', adminUsername: 'bootstrap', adminPassword: fixed });
    assert.equal(done.created.tenant, false);
    assert.equal(done.created.admin, true);
    assert.equal(done.created.templates, 3);
    assert.equal(done.oneTimePassword, undefined, 'a provided password is never echoed');
    await login(app, 'half', 'bootstrap', fixed);
    const ev = await ctx.db.query<any>(`SELECT details FROM audit_events WHERE tenant_id='half' AND action='ENTITY_PROVISIONED'`);
    assert.equal(ev[0].details.resumed, true);
    assert.equal(ev[0].details.adminPasswordSource, 'PROVIDED');

    // validation
    const bad = async (input: any, re: RegExp) => assert.rejects(provisionEntity(ctx, input), re);
    await bad({ code: 'x', nameEn: 'A', nameAr: 'أ' }, /code must be/);
    await bad({ code: 'okcode', nameEn: 'A', nameAr: 'Latin only' }, /Arabic script/);
    await bad({ code: 'okcode', nameEn: 'A', nameAr: 'أ', colour: 'red' }, /#RRGGBB/);
    await bad({ code: 'okcode', nameEn: 'A', nameAr: 'أ', defaultTemplate: 'NOPE' }, /default template/);
    await bad({ code: 'okcode', nameEn: 'A', nameAr: 'أ', adminPassword: 'short' }, /at least 12/);
    assert.equal((await ctx.db.query('SELECT 1 FROM tenants WHERE id=$1', ['okcode'])).length, 0);

    // dry run writes nothing
    const dry = await provisionEntity(ctx, { code: 'drycode', nameEn: 'Dry (fictitious)', nameAr: 'تجربة (وهمية)' }, { dryRun: true });
    assert.equal(dry.created.tenant, true);
    assert.equal((await ctx.db.query('SELECT 1 FROM tenants WHERE id=$1', ['drycode'])).length, 0);
  } finally {
    await app.stop();
  }
});

test('entity:create CLI prints the one-time password once; a re-run changes nothing', async () => {
  const env = { BID_MASTER_KEY, AUDIT_SIGNING_KEY, DATA_DIR: tmp() };
  const args = ['src/tools/entity-create.ts', '--code', 'cli', '--name-en', 'CLI Authority (fictitious)', '--name-ar', 'هيئة سطر الأوامر (وهمية)'];
  const first = await run(args, env);
  assert.equal(first.code, 0, first.out + first.err);
  assert.match(first.out, /administrator \.+ admin created/);
  assert.match(first.out, /One-time password/);
  const second = await run(args, env);
  assert.equal(second.code, 0, second.err);
  assert.match(second.out, /already fully provisioned/);
  assert.doesNotMatch(second.out, /One-time password/);

  const fromEnv = await run(['src/tools/entity-create.ts', '--code', 'cli2', '--name-en', 'Second (fictitious)', '--name-ar', 'الثانية (وهمية)'],
    { ...env, TF_ENTITY_ADMIN_PASSWORD: 'entity-admin-marker-21' });
  assert.equal(fromEnv.code, 0, fromEnv.err);
  assert.ok(!fromEnv.out.includes('entity-admin-marker-21'));
  assert.match(fromEnv.out, /taken from TF_ENTITY_ADMIN_PASSWORD/);

  const usage = await run(['src/tools/entity-create.ts', '--code', 'x'], env);
  assert.equal(usage.code, 2);
  assert.match(usage.err, /usage: npm run entity:create/);
});

// ---------------------------------------------------------------- endpoints
test('GET /api/v1/version (no login), /health without the database, /ready with migrations and draining', async () => {
  const app = await startApp();
  try {
    const v = await api(app, 'GET', '/api/v1/version');
    assert.equal(v.status, 200);
    const pkg = JSON.parse(fs.readFileSync(path.join(API_DIR, 'package.json'), 'utf8'));
    assert.equal(v.body.name, 'TenderFlow');
    assert.equal(v.body.version, process.env.TF_VERSION || pkg.version);
    assert.ok('commit' in v.body && 'buildTime' in v.body);
    assert.equal(v.headers.get('cache-control'), 'no-store');

    assert.deepEqual(versionInfo({ TF_VERSION: '1.2.3', TF_COMMIT: '0123abcd', TF_BUILD_TIME: '2026-10-10T08:00:00Z' }),
      { name: 'TenderFlow', version: '1.2.3', commit: '0123abcd', buildTime: '2026-10-10T08:00:00.000Z' });
    const junk = versionInfo({ TF_COMMIT: '<script>', TF_BUILD_TIME: 'yesterday', TF_VERSION: 'a b' });
    assert.equal(junk.commit, null);
    assert.equal(junk.buildTime, null);
    assert.equal(junk.version, pkg.version);

    const ready = await api(app, 'GET', '/ready');
    assert.equal(ready.status, 200);
    assert.equal(ready.body.status, 'ready');
    assert.deepEqual(await pendingMigrations(app.handle.ctx.db), []);

    app.handle.startDraining();
    const draining = await api(app, 'GET', '/ready');
    assert.equal(draining.status, 503);
    assert.deepEqual(draining.body, { status: 'not_ready' });
    assert.equal((await api(app, 'GET', '/health')).status, 200, 'liveness stays up while draining');
  } finally {
    await app.stop();
  }
});

test('/ready is not ready while a migration is pending; /health never touches the database', async () => {
  const dir = tmp();
  const app = await startApp(dir);
  try {
    await app.handle.ctx.db.query(`DELETE FROM schema_migrations WHERE version=(SELECT max(version) FROM schema_migrations)`);
    const r = await api(app, 'GET', '/ready');
    assert.equal(r.status, 503);
    assert.equal(r.body.status, 'not_ready');
    // /health answers even when every query fails
    const real = app.handle.ctx.db.query;
    app.handle.ctx.db.query = async () => { throw new Error('database down'); };
    try {
      assert.equal((await api(app, 'GET', '/health')).status, 200);
      assert.equal((await api(app, 'GET', '/ready')).status, 503);
    } finally {
      app.handle.ctx.db.query = real;
    }
  } finally {
    await app.stop();
  }
});

// ---------------------------------------------------------------- multi-replica safety
test('concurrent migrate on one database applies each migration exactly once (lock)', async () => {
  const db = await openDb({ dataDir: tmp() });
  try {
    const [a, b, c] = await Promise.all([migrate(db), migrate(db), migrate(db)]);
    const all = [...a, ...b, ...c];
    assert.equal(all.length, MIGRATION_COUNT);
    assert.equal(new Set(all).size, MIGRATION_COUNT);
    assert.equal((await db.query<any>('SELECT count(*)::int AS n FROM schema_migrations'))[0].n, MIGRATION_COUNT);
    // the lock serialises critical sections and survives a failing holder
    const order: string[] = [];
    const slow = db.withLock('t', async () => { order.push('a1'); await new Promise((r) => setTimeout(r, 30)); order.push('a2'); });
    const failing = db.withLock('t', async () => { order.push('b'); throw new Error('boom'); });
    const after = db.withLock('t', async () => { order.push('c'); });
    await slow; await assert.rejects(failing, /boom/); await after;
    assert.deepEqual(order, ['a1', 'a2', 'b', 'c']);
  } finally {
    await db.close();
  }
});

test('two processes starting together on an empty database end up with ONE token signing key', async () => {
  const db = await openDb({ dataDir: tmp() });
  try {
    await migrate(db);
    const cfg = loadConfig({ BID_MASTER_KEY, AUDIT_SIGNING_KEY, DATA_DIR: tmp() });
    const [s1, s2, s3] = await Promise.all([TokenService.init(db, cfg), TokenService.init(db, cfg), TokenService.init(db, cfg)]);
    assert.equal(s1.publicJwk.kid, s2.publicJwk.kid);
    assert.equal(s2.publicJwk.kid, s3.publicJwk.kid);
    assert.equal((await db.query<any>('SELECT count(*)::int AS n FROM signing_keys'))[0].n, 1);
    // a token issued by one instance verifies on the other
    const tok = await s1.issue({ id: crypto.randomUUID(), tenant_id: 'kea', roles: ['AUDITOR'], vendor_id: null, username: 'auditor' });
    assert.equal((await s2.verify(tok)).tenantId, 'kea');
  } finally {
    await db.close();
  }
});

test('scheduler jobs take a database lease (one run at a time across processes)', () => {
  const src = fs.readFileSync(path.join(API_DIR, 'src', 'services', 'scheduler.ts'), 'utf8');
  assert.match(src, /UPDATE scheduled_jobs SET locked_until=\$2, locked_by=\$3[\s\S]*WHERE name=\$1 AND \(locked_until IS NULL OR locked_until < \$4\)/);
});

// ---------------------------------------------------------------- graceful shutdown
async function listen(extra: Record<string, string> = {}) {
  const dataDir = tmp();
  const config = loadConfig({ BID_MASTER_KEY, AUDIT_SIGNING_KEY, DATA_DIR: dataDir, PUBLIC_BASE_URL: 'http://tenderflow.test', WEB_DIST_DIR: path.join(dataDir, 'no-web'), ...extra });
  const handle = await createApp(config);
  handle.app.get('/__slow', (req, res) => { setTimeout(() => res.json({ done: true }), Number(req.query.ms ?? 300)); });
  const server = handle.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { handle, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test('SIGTERM handling: drain (/ready 503), finish in-flight requests, refuse new ones, close the database', async () => {
  const { handle, server, base } = await listen();
  const inflight = fetch(`${base}/__slow?ms=400`).then(async (r) => ({ status: r.status, body: await r.json() }));
  await new Promise((r) => setTimeout(r, 50));
  const logs: string[] = [];
  const stopping = gracefulShutdown(server, handle, { delayMs: 150, timeoutMs: 5_000, log: (m) => logs.push(m) });
  const during = await fetch(`${base}/ready`);
  assert.equal(during.status, 503, 'the router stops sending traffic while draining');
  const res = await inflight;
  assert.deepEqual(res, { status: 200, body: { done: true } });
  const result = await stopping;
  assert.equal(result.forcedConnections, false);
  assert.ok(result.ms < 3_000, `shutdown took ${result.ms} ms`);
  await assert.rejects(fetch(`${base}/health`), 'listener closed');
  await assert.rejects(handle.ctx.db.query('SELECT 1'), 'database closed');
  assert.ok(logs.some((l) => /listener closed/.test(l)));
});

test('SIGTERM handling: connections still open after the timeout are closed', async () => {
  const { handle, server, base } = await listen();
  const hung = fetch(`${base}/__slow?ms=10000`).then(() => 'answered', () => 'closed');
  await new Promise((r) => setTimeout(r, 50));
  const result = await gracefulShutdown(server, handle, { delayMs: 0, timeoutMs: 200 });
  assert.equal(result.forcedConnections, true);
  assert.equal(await hung, 'closed');
  assert.ok(result.ms < 5_000);
});

// ---------------------------------------------------------------- PostgreSQL only
const PG = process.env.TEST_DATABASE_URL;
test('PostgreSQL: two pools migrating at once apply each migration once; one signing key', { skip: !PG && 'TEST_DATABASE_URL not set' }, async () => {
  const schema = `tf_ops_${crypto.randomBytes(4).toString('hex')}`;
  const admin = await openDb({ databaseUrl: PG!, dataDir: tmp() });
  await admin.exec(`CREATE SCHEMA ${schema}`);
  const url = new URL(PG!);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const dbs: Db[] = [await openDb({ databaseUrl: url.href, dataDir: tmp() }), await openDb({ databaseUrl: url.href, dataDir: tmp() })];
  try {
    const [a, b] = await Promise.all(dbs.map((d) => migrate(d)));
    assert.equal(a.length + b.length, MIGRATION_COUNT);
    assert.equal(new Set([...a, ...b]).size, MIGRATION_COUNT);
    const cfg = loadConfig({ BID_MASTER_KEY, AUDIT_SIGNING_KEY, DATA_DIR: tmp() });
    const [s1, s2] = await Promise.all(dbs.map((d) => TokenService.init(d, cfg)));
    assert.equal(s1.publicJwk.kid, s2.publicJwk.kid);
  } finally {
    for (const d of dbs) await d.close();
    await admin.exec(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  }
});

// ---------------------------------------------------------------- packaging (checked by reading; the image itself is built outside the test suite)
const REPO = path.resolve(API_DIR, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');

test('Containerfile: UBI multi-stage, non-root, production deps only, port, healthcheck, labels; ignore files keep secrets out', () => {
  const cf = read('Containerfile');
  assert.match(cf, /FROM \$\{BUILDER_IMAGE\} AS build/);
  assert.match(cf, /ubi9\/nodejs-22:latest/);
  assert.match(cf, /ubi9\/nodejs-22-minimal:latest/);
  assert.match(cf, /npm ci --omit=dev/);
  assert.match(cf, /chown -R 1001:0 \/data && chmod -R g=u \/data/);
  assert.match(cf, /\nUSER 1001\n/);
  assert.match(cf, /\nEXPOSE 4000\n/);
  assert.match(cf, /HEALTHCHECK [\s\S]*\/health/);
  assert.match(cf, /CMD \["node", "services\/api\/dist\/server\.js"\]/);
  for (const l of ['name=', 'version=', 'vendor="KBM"']) assert.ok(cf.includes(l), l);
  for (const f of ['.containerignore', '.dockerignore']) {
    const lines = read(f).split('\n').map((l) => l.trim());
    for (const must of ['.env', '.env.*', '!.env.example', 'data', '**/node_modules', '.git']) assert.ok(lines.includes(must), `${f}: ${must}`);
  }
});

test('OpenShift manifests: probes, security context, demo = 1 pod Recreate PGlite, production = 2 pods PostgreSQL; secret template has placeholders only', () => {
  const dep = read('deploy/openshift/base/deployment.yaml');
  for (const re of [/readinessProbe:\s+httpGet:\s+path: \/ready/, /livenessProbe:\s+httpGet:\s+path: \/health/, /runAsNonRoot: true/,
    /allowPrivilegeEscalation: false/, /readOnlyRootFilesystem: true/, /mountPath: \/data/, /claimName: tenderflow-data/, /secretRef:\s+name: tenderflow-secrets/])
    assert.match(dep, re);
  assert.doesNotMatch(dep, /^\s+runAsUser:/m, 'OpenShift assigns the UID');
  assert.match(read('deploy/openshift/base/route.yaml'), /termination: edge\s+insecureEdgeTerminationPolicy: Redirect/);
  const base = read('deploy/openshift/base/kustomization.yaml');
  assert.doesNotMatch(base, /^\s*-\s*secret\.template\.yaml/m, 'the template is never applied');
  const demo = read('deploy/openshift/overlays/demo/kustomization.yaml') + read('deploy/openshift/overlays/demo/deployment-patch.yaml');
  for (const re of [/TF_ENV=demo/, /DEMO_MODE=true/, /replicas: 1/, /type: Recreate/]) assert.match(demo, re);
  const prod = read('deploy/openshift/overlays/production/kustomization.yaml') + read('deploy/openshift/overlays/production/deployment-patch.yaml');
  for (const re of [/TF_ENV=production/, /TRUST_PROXY=1/, /DEMO_MODE=false/, /SEED_DEMO=false/, /replicas: 2/]) assert.match(prod, re);
  assert.doesNotMatch(prod, /DATABASE_URL=|PASSWORD=|_KEY=/, 'no secret values in the production overlay');

  // every value in the Secret template is a <placeholder>, and production refuses to start with the template as-is
  const tpl = read('deploy/openshift/base/secret.template.yaml');
  const values = [...tpl.matchAll(/^ {2}([A-Z0-9_]+): "(.*)"$/gm)].map((m) => [m[1], m[2]] as const);
  assert.ok(values.length >= 10);
  for (const [k, v] of values) assert.match(v, /<[^>]+>/, `${k} must be a placeholder`);
  const env = { ...Object.fromEntries(values), TF_ENV: 'production', PUBLIC_BASE_URL: 'https://x.example.gov.kw', DATA_DIR: tmp() } as Record<string, string>;
  delete env.DEMO_PASSWORD;
  assert.throws(() => loadConfig(env), ConfigError);
});

test('config:check does not mangle messages for a short database password', async () => {
  const r = await buildConfigReport({ ...goodProd(), DATABASE_URL: 'postgresql://a:b@db.example.local/tf' });
  assert.ok(r.checks.some((c) => c.id === 'BID_MASTER_KEY' && /32 bytes/.test(c.message)));
});
