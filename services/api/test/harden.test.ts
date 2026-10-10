// HARDEN: sign-in lockout (password + second factor, no user enumeration, admin unlock), TRUST_PROXY, CSP and
// security headers, /ready shape, OIDC state + nonce bound to a signed browser cookie.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { api, login, makeTenant, makeUser, startApp, PASSWORD, type Running } from './helpers.js';
import { startFakeOidc, type FakeOidc } from './fakes/fake-oidc.js';
import { base32Decode, totp } from '../src/auth/totp.js';
import { now, setClockOffset } from '../src/util.js';
import { verifyAudit } from '../src/services/audit.js';
import { ConfigError, loadConfig, parseTrustProxy, REPO_ROOT } from '../src/config.js';
import { BID_MASTER_KEY, AUDIT_SIGNING_KEY } from './helpers.js';

let run: Running;
let webDir: string;
let admin: string;
const MIN = 60_000;

before(async () => {
  webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-web-'));
  fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head><body><div id="root"></div></body></html>');
  run = await startApp(undefined, { LOGIN_LOCKOUT_ATTEMPTS: '3', LOGIN_LOCKOUT_WINDOW_MIN: '15', LOGIN_LOCKOUT_MINUTES: '15', WEB_DIST_DIR: webDir });
  await makeTenant(run, 'ha');
  await makeTenant(run, 'hb');
  await makeUser(run, 'ha', 'admin', ['TENANT_ADMIN']);
  await makeUser(run, 'ha', 'auditor', ['AUDITOR']);
  await makeUser(run, 'ha', 'officer', ['PROCUREMENT_OFFICER']);
  for (const u of ['alice', 'bob', 'carol', 'dave']) await makeUser(run, 'ha', u, ['EVALUATOR']);
  admin = await login(run, 'ha', 'admin');
});
after(async () => { setClockOffset(0); await run.stop(); fs.rmSync(webDir, { recursive: true, force: true }); });

const attempt = (username: string, password: string, tenantId = 'ha') =>
  api(run, 'POST', '/api/v1/auth/login', { json: { tenantId, username, password } });
const advance = (ms: number) => setClockOffset(now().getTime() - Date.now() + ms);

// ---------------------------------------------------------------- lockout

test('lockout: N wrong passwords within the window → 423 ACCOUNT_LOCKED with minutes remaining; correct password refused while locked; audited', async () => {
  assert.equal((await attempt('alice', 'wrong-1')).body.code, 'INVALID_CREDENTIALS');
  assert.equal((await attempt('alice', 'wrong-2')).status, 401);
  const third = await attempt('alice', 'wrong-3');
  assert.equal(third.status, 423, third.text);
  assert.equal(third.body.code, 'ACCOUNT_LOCKED');
  assert.equal(third.body.minutesRemaining, 15);
  assert.ok(third.body.retryAfterSeconds > 14 * 60 && third.body.retryAfterSeconds <= 15 * 60);
  const right = await attempt('alice', PASSWORD);
  assert.equal(right.status, 423, 'the right password does not help while locked');
  assert.equal(right.body.token, undefined);
  const ev = await run.handle.ctx.db.query<any>(`SELECT actor_id, resource_type, resource_id, details FROM audit_events WHERE tenant_id='ha' AND action='LOGIN_LOCKED'`);
  const alice = (await run.handle.ctx.db.query<any>(`SELECT id FROM users WHERE tenant_id='ha' AND username='alice'`))[0];
  const e = ev.find((x) => x.details.username === 'alice');
  assert.ok(e, 'LOGIN_LOCKED audited');
  assert.equal(e.resource_type, 'USER');
  assert.equal(e.resource_id, alice.id);
  assert.equal(e.details.failures, 3);
  assert.equal(e.details.lastAttempt, 'PASSWORD');
});

test('no user enumeration: an unknown username gets the same answers (status, code, body keys, minutes) as a real one', async () => {
  const shape = (r: { status: number; body: any }) => ({ status: r.status, code: r.body.code, keys: Object.keys(r.body).sort(), minutes: r.body.minutesRemaining });
  const real: any[] = [], ghost: any[] = [];
  for (let i = 0; i < 4; i++) {
    real.push(shape(await attempt('carol', `nope-${i}`)));
    ghost.push(shape(await attempt('no-such-user', `nope-${i}`)));
  }
  assert.deepEqual(ghost, real);
  assert.deepEqual(real.map((r) => r.status), [401, 401, 423, 423]);
  // Message texts are identical too (no "user not found").
  const a = await attempt('carol', 'x');
  const b = await attempt('no-such-user', 'x');
  assert.equal(a.body.message, b.body.message);
  // The unknown name's lock is audited without inventing a user.
  const ev = await run.handle.ctx.db.query<any>(`SELECT resource_type, resource_id, details FROM audit_events WHERE tenant_id='ha' AND action='LOGIN_LOCKED'`);
  const g = ev.find((x) => x.details.username === 'no-such-user');
  assert.equal(g.resource_type, 'SIGN_IN_NAME');
  assert.equal(g.resource_id, null);
  assert.equal(g.details.knownUser, false);
  // Same for an unknown entity: refused like any wrong password, no audit chain created for it.
  assert.equal((await attempt('carol', 'x', 'no-such-entity')).body.code, 'INVALID_CREDENTIALS');
  assert.equal((await run.handle.ctx.db.query(`SELECT 1 FROM audit_events WHERE tenant_id='no-such-entity'`)).length, 0);
});

test('lockout: failures outside the window do not add up; the lock expires after M minutes and the right password then works', async () => {
  try {
    assert.equal((await attempt('dave', 'w1')).status, 401);
    assert.equal((await attempt('dave', 'w2')).status, 401);
    advance(16 * MIN); // window (15 min) passed → counter restarts
    assert.equal((await attempt('dave', 'w3')).status, 401);
    assert.equal((await attempt('dave', 'w4')).status, 401);
    assert.equal((await attempt('dave', 'w5')).status, 423);
    advance(10 * MIN);
    const still = await attempt('dave', PASSWORD);
    assert.equal(still.status, 423);
    assert.equal(still.body.minutesRemaining, 5);
    advance(6 * MIN);
    const ok = await attempt('dave', PASSWORD);
    assert.equal(ok.status, 200, ok.text);
    // A completed sign-in clears the counter: two more failures do not lock.
    assert.equal((await attempt('dave', 'w6')).status, 401);
    assert.equal((await attempt('dave', 'w7')).status, 401);
    assert.equal((await attempt('dave', PASSWORD)).status, 200);
  } finally { setClockOffset(0); }
});

test('lockout: wrong second-factor codes count too (password failure + MFA failures → locked, MFA step refused)', async () => {
  const set = await api(run, 'PUT', '/api/v1/security/settings', { token: admin, json: { mfaStaff: 'OPTIONAL' } });
  assert.equal(set.status, 200, set.text);
  const bobToken = await login(run, 'ha', 'bob');
  const st = await api(run, 'POST', '/api/v1/security/mfa/enrol/start', { token: bobToken });
  assert.equal(st.status, 200, st.text);
  const key = base32Decode(st.body.manualKey);
  const conf = await api(run, 'POST', '/api/v1/security/mfa/enrol/confirm', { token: bobToken, json: { code: totp(key, now().getTime() / 1000) } });
  assert.equal(conf.status, 200, conf.text);

  assert.equal((await attempt('bob', 'wrong')).status, 401); // 1 (password)
  const r = await attempt('bob', PASSWORD);
  assert.equal(r.body.mfaRequired, true);
  const v1 = await api(run, 'POST', '/api/v1/auth/mfa/verify', { json: { mfaToken: r.body.mfaToken, code: '000000' } });
  assert.equal(v1.body.code, 'MFA_CODE_INVALID'); // 2
  const v2 = await api(run, 'POST', '/api/v1/auth/mfa/verify', { json: { mfaToken: r.body.mfaToken, code: '000001' } });
  assert.equal(v2.status, 423, v2.text); // 3 → locked
  assert.equal(v2.body.code, 'ACCOUNT_LOCKED');
  // Even the right code is refused now, and so is a new password step.
  const v3 = await api(run, 'POST', '/api/v1/auth/mfa/verify', { json: { mfaToken: r.body.mfaToken, code: totp(key, now().getTime() / 1000 + 30) } });
  assert.equal(v3.status, 423);
  assert.equal((await attempt('bob', PASSWORD)).status, 423);
  const ev = await run.handle.ctx.db.query<any>(`SELECT details FROM audit_events WHERE tenant_id='ha' AND action='LOGIN_LOCKED'`);
  assert.ok(ev.some((x) => x.details.username === 'bob' && x.details.lastAttempt === 'MFA'));
  await api(run, 'PUT', '/api/v1/security/settings', { token: admin, json: { mfaStaff: 'OFF' } });
});

test('admin unlock: users page shows the lock; only TENANT_ADMIN may unlock; audited; the user signs in again', async () => {
  const list = await api(run, 'GET', '/api/v1/admin/users', { token: admin });
  assert.equal(list.status, 200);
  const alice = list.body.find((u: any) => u.username === 'alice');
  assert.ok(alice.lockedUntil && new Date(alice.lockedUntil) > new Date(), 'lockedUntil shown');
  assert.equal(list.body.find((u: any) => u.username === 'officer').lockedUntil, null);
  const officer = await login(run, 'ha', 'officer');
  assert.equal((await api(run, 'POST', `/api/v1/admin/users/${alice.id}/unlock`, { token: officer, json: {} })).status, 403);
  // Another entity's administrator cannot see or unlock this user.
  await makeUser(run, 'hb', 'admin', ['TENANT_ADMIN']);
  const adminB = await login(run, 'hb', 'admin');
  assert.equal((await api(run, 'POST', `/api/v1/admin/users/${alice.id}/unlock`, { token: adminB, json: {} })).status, 404);
  const un = await api(run, 'POST', `/api/v1/admin/users/${alice.id}/unlock`, { token: admin, json: { reason: 'Identity confirmed by phone' } });
  assert.equal(un.status, 200, un.text);
  assert.equal(un.body.wasLocked, true);
  assert.equal(un.body.locked, false);
  assert.equal((await attempt('alice', PASSWORD)).status, 200);
  const ev = await run.handle.ctx.db.query<any>(`SELECT actor_id, reason, prev_state, new_state FROM audit_events WHERE tenant_id='ha' AND action='LOGIN_UNLOCKED_BY_ADMIN' AND resource_id=$1`, [alice.id]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].prev_state, 'LOCKED');
  assert.equal(ev[0].reason, 'Identity confirmed by phone');
  // Unlock also clears a second-factor lock (bob).
  const bob = list.body.find((u: any) => u.username === 'bob');
  assert.equal((await api(run, 'POST', `/api/v1/admin/users/${bob.id}/unlock`, { token: admin, json: {} })).status, 200);
  assert.equal((await attempt('bob', PASSWORD)).status, 200);
  assert.equal((await verifyAudit(run.handle.ctx.db, run.handle.ctx.config.auditSigningKey, 'ha')).valid, true);
});

test('lockout config: defaults 5/15/15, 0 attempts = off, bad values refused', () => {
  const base = { BID_MASTER_KEY, AUDIT_SIGNING_KEY };
  assert.deepEqual(loadConfig(base).loginLockout, { attempts: 5, windowMinutes: 15, lockMinutes: 15 });
  assert.equal(loadConfig({ ...base, LOGIN_LOCKOUT_ATTEMPTS: '0' }).loginLockout.attempts, 0);
  assert.throws(() => loadConfig({ ...base, LOGIN_LOCKOUT_MINUTES: 'ten' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, LOGIN_LOCKOUT_WINDOW_MIN: '0' }), ConfigError);
});

// ---------------------------------------------------------------- TRUST_PROXY

test('TRUST_PROXY: parsing; true is refused; off → X-Forwarded-For cannot choose the address', async () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('1'), 1);
  assert.deepEqual(parseTrustProxy('loopback, 10.128.0.0/14'), ['loopback', '10.128.0.0/14']);
  const p: string[] = [];
  assert.equal(parseTrustProxy('true', p), false);
  assert.equal(p.length, 1);
  assert.throws(() => loadConfig({ BID_MASTER_KEY, AUDIT_SIGNING_KEY, TRUST_PROXY: 'true' }), /TRUST_PROXY/);
  assert.throws(() => loadConfig({ BID_MASTER_KEY, AUDIT_SIGNING_KEY, TRUST_PROXY: 'everyone' }), /TRUST_PROXY/);
  assert.equal(loadConfig({ BID_MASTER_KEY, AUDIT_SIGNING_KEY }).trustProxy, false, 'default off');

  // Default (off): even when the entity says "trust the proxy header", the TCP peer is used.
  const set = await api(run, 'PUT', '/api/v1/security/settings', { token: admin, json: { staffNetwork: { mode: 'OFF', cidrs: [], trustProxyHeader: true } } });
  assert.equal(set.status, 200, set.text);
  const who = await fetch(`${run.base}/api/v1/security/network/whoami`, { headers: { authorization: `Bearer ${admin}`, 'x-forwarded-for': '10.9.9.9' } });
  const w = await who.json();
  assert.equal(w.ip, '127.0.0.1');
  assert.equal(w.serverTrustProxy, false);
  assert.equal(run.handle.app.get('trust proxy'), false);

  // TRUST_PROXY=1 (one router hop): the address the proxy appended is used.
  const other = await startApp(undefined, { TRUST_PROXY: '1' });
  try {
    await makeTenant(other, 'hp');
    await makeUser(other, 'hp', 'admin', ['TENANT_ADMIN']);
    const t = await login(other, 'hp', 'admin');
    await api(other, 'PUT', '/api/v1/security/settings', { token: t, json: { staffNetwork: { mode: 'OFF', cidrs: [], trustProxyHeader: true } } });
    const r = await fetch(`${other.base}/api/v1/security/network/whoami`, { headers: { authorization: `Bearer ${t}`, 'x-forwarded-for': '198.51.100.7, 10.9.9.9' } });
    const b = await r.json();
    assert.equal(b.ip, '10.9.9.9', 'right-most entry = the one our router appended; the client-supplied left part is ignored');
    assert.equal(b.serverTrustProxy, true);
  } finally { await other.stop(); }
});

// ---------------------------------------------------------------- headers

test('CSP and security headers on the web app and the API', async () => {
  const want = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "worker-src 'self' blob:",
    "connect-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"];
  for (const p of ['/login', '/api/v1/public/tenants', '/health']) {
    const r = await fetch(run.base + p);
    assert.equal(r.status, 200, p);
    const csp = r.headers.get('content-security-policy') ?? '';
    for (const d of want) assert.ok(csp.split(';').map((x) => x.trim()).includes(d), `${p}: CSP has ${d} (got ${csp})`);
    assert.ok(!/unsafe-eval/.test(csp));
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(r.headers.get('strict-transport-security'));
    assert.equal(r.headers.get('x-powered-by'), null);
  }
  const page = await (await fetch(`${run.base}/login`)).text();
  assert.match(page, /id="root"/);
});

test('built web app (when present) has no inline scripts and ships the pdf.js worker as a same-origin asset', async (t) => {
  const dist = path.join(REPO_ROOT, 'apps', 'web', 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) { t.skip('apps/web/dist not built'); return; }
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0);
  for (const [, attrs, body] of scripts) {
    assert.match(attrs, /\bsrc="\/[^"]+"/, 'every script is a same-origin file');
    assert.equal(body.trim(), '', 'no inline script');
  }
  assert.ok(!/\son[a-z]+="/i.test(html), 'no inline event handlers');
  const worker = fs.readdirSync(path.join(dist, 'pdfjs'), { recursive: true }).map(String).find((f) => /pdf\.worker.*\.mjs$/.test(f));
  assert.ok(worker, 'pdf.js worker present under dist/pdfjs');
  // Served by the API with a JavaScript MIME type (module workers require it).
  const app = await startApp(undefined, { WEB_DIST_DIR: dist });
  try {
    const r = await fetch(`${app.base}/pdfjs/${worker!.replace(/\\/g, '/')}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /javascript/);
  } finally { await app.stop(); }
});

// ---------------------------------------------------------------- /ready

test('/ready: public answer is { status } only; details only for TENANT_ADMIN / AUDITOR', async () => {
  const anon = await api(run, 'GET', '/ready');
  assert.equal(anon.status, 200);
  assert.deepEqual(anon.body, { status: 'ready' });
  assert.equal(anon.headers.get('cache-control'), 'no-store');
  const officer = await login(run, 'ha', 'officer');
  assert.deepEqual((await api(run, 'GET', '/ready', { token: officer })).body, { status: 'ready' });
  assert.deepEqual((await api(run, 'GET', '/ready', { token: 'not-a-token' })).body, { status: 'ready' });
  for (const u of ['admin', 'auditor']) {
    const r = await api(run, 'GET', '/ready', { token: await login(run, 'ha', u) });
    assert.equal(r.body.status, 'ready');
    assert.equal(r.body.checks.database.ok, true, u);
    assert.ok(r.body.checks.contentStore && r.body.checks.ai, u);
  }
});

// ---------------------------------------------------------------- SSO state cookie

test('SSO: state + nonce bound to an httpOnly SameSite=Lax signed cookie; callback refused without it, with another one, or tampered; no replay', async () => {
  const idp: FakeOidc = await startFakeOidc();
  process.env.TF_OIDC_SECRET_HARDEN = idp.clientSecret;
  try {
    const cfg = await api(run, 'PUT', '/api/v1/security/settings', { token: admin, json: { oidc: {
      enabled: true, displayNameEn: 'Directory', displayNameAr: 'الدليل', issuer: idp.issuer, clientId: idp.clientId, clientSecretEnv: 'TF_OIDC_SECRET_HARDEN',
      scopes: 'openid profile', groupsClaim: 'groups', usernameClaim: 'preferred_username', provisioning: 'JIT_FROM_GROUPS',
      mappings: [{ group: 'TF-Officers', roles: ['PROCUREMENT_OFFICER'] }] } } });
    assert.equal(cfg.status, 200, cfg.text);
    idp.nextUser = { sub: 'h-1', username: 'sso.user@moi.example', groups: ['TF-Officers'] };

    const start = async () => {
      const s = await fetch(`${run.base}/api/v1/auth/oidc/ha/start`, { redirect: 'manual' });
      assert.equal(s.status, 302);
      const setCookie = s.headers.get('set-cookie') ?? '';
      const a = await fetch(s.headers.get('location')!, { redirect: 'manual' });
      const back = new URL(a.headers.get('location')!);
      return { setCookie, cookie: setCookie.split(';')[0], callback: new URL(back.pathname + back.search, run.base) };
    };
    const callback = async (url: URL, cookie?: string) => {
      const c = await fetch(url, { redirect: 'manual', headers: cookie ? { cookie } : {} });
      assert.equal(c.status, 302);
      return { params: new URL(c.headers.get('location')!, run.base).searchParams, setCookie: c.headers.get('set-cookie') ?? '' };
    };

    const f1 = await start();
    assert.match(f1.setCookie, /^tf_oidc_state=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+;/);
    for (const attr of ['HttpOnly', 'SameSite=Lax', 'Path=/api/v1/auth/oidc', 'Max-Age=600']) assert.ok(f1.setCookie.includes(attr), attr);
    assert.ok(!f1.setCookie.includes('Secure'), 'Secure only when PUBLIC_BASE_URL is https');

    // 1. No cookie (another browser / login CSRF) → refused; the state stays usable for the real browser.
    const noCookie = await callback(f1.callback);
    assert.equal(noCookie.params.get('ssoError'), 'SSO_BROWSER_MISMATCH');
    assert.match(noCookie.setCookie, /tf_oidc_state=;.*Max-Age=0/, 'callback always clears the cookie');
    // 2. A valid cookie of a different sign-in → refused.
    const f2 = await start();
    assert.equal((await callback(f1.callback, f2.cookie)).params.get('ssoError'), 'SSO_BROWSER_MISMATCH');
    // 3. Tampered signature → refused.
    const [body] = f1.cookie.split('.');
    assert.equal((await callback(f1.callback, `${body}.AAAA${f1.cookie.split('.')[1].slice(4)}`)).params.get('ssoError'), 'SSO_BROWSER_MISMATCH');
    // 4. The right browser → hand-off.
    const ok = await callback(f1.callback, f1.cookie);
    assert.equal(ok.params.get('ssoError'), null, ok.params.toString());
    assert.ok(ok.params.get('ssoHandoff'));
    // 5. Replay of the same callback with the same cookie → state already used.
    assert.equal((await callback(f1.callback, f1.cookie)).params.get('ssoError'), 'SSO_STATE_INVALID');
    // 6. Expired cookie (10 minutes) → refused even with the right state.
    const f3 = await start();
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * MIN;
    try { assert.equal((await callback(f3.callback, f3.cookie)).params.get('ssoError'), 'SSO_BROWSER_MISMATCH'); }
    finally { Date.now = realNow; }
    const ex = await api(run, 'POST', '/api/v1/auth/oidc/exchange', { json: { handoff: ok.params.get('ssoHandoff') } });
    assert.equal(ex.status, 200, ex.text);
  } finally {
    delete process.env.TF_OIDC_SECRET_HARDEN;
    await api(run, 'PUT', '/api/v1/security/settings', { token: admin, json: { oidc: null } });
    await idp.stop();
  }
});
