// SEC staff single sign-on (OIDC, Entra ID / AD FS) against a local fake provider: PKCE + state + nonce, ID-token
// validation (nonce, audience, expiry, signature), group → role mapping, JIT vs ADMIN_CREATED provisioning.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, login, makeTenant, makeUser, startApp, PASSWORD, type Running } from './helpers.js';
import { startFakeOidc, type FakeOidc } from './fakes/fake-oidc.js';
import { registerVendor } from '../src/services/vendors.js';

let run: Running;
let idp: FakeOidc;
let admin: string;

before(async () => {
  run = await startApp();
  idp = await startFakeOidc();
  process.env.TF_OIDC_SECRET_TEST = idp.clientSecret;
  await makeTenant(run, 'so');
  await makeUser(run, 'so', 'admin', ['TENANT_ADMIN']);
  await registerVendor(run.handle.ctx, { tenantId: 'so', legalNameEn: 'V (fictitious)', legalNameAr: 'م (وهمية)', crNumber: 'CR-9',
    email: 'v@vendors.example', categories: ['IT'], username: 'vendor@moi.example', password: PASSWORD });
  admin = await login(run, 'so', 'admin');
});
after(async () => { delete process.env.TF_OIDC_SECRET_TEST; await idp.stop(); await run.stop(); });

const baseOidc = () => ({
  enabled: true, displayNameEn: 'MOI Active Directory', displayNameAr: 'الدليل النشط لوزارة الداخلية', issuer: idp.issuer, clientId: idp.clientId,
  clientSecretEnv: 'TF_OIDC_SECRET_TEST', scopes: 'openid profile email', groupsClaim: 'groups', usernameClaim: 'preferred_username',
  provisioning: 'JIT_FROM_GROUPS',
  mappings: [{ group: 'TF-Officers', roles: ['PROCUREMENT_OFFICER'] }, { group: 'TF-Directors', roles: ['DIRECTOR'] }, { group: 'TF-Audit', roles: ['AUDITOR'] }],
});

async function configure(oidc: unknown) {
  const r = await api(run, 'PUT', '/api/v1/security/settings', { token: admin, json: { oidc } });
  assert.equal(r.status, 200, r.text);
  return r.body;
}

/** The state cookie set by the last /start (HARDEN: state + nonce bound to the browser). */
let lastCookie = '';
const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0];

/** Drive the browser redirects: TenderFlow /start → IdP /authorize → TenderFlow /callback → /login?… */
async function ssoFlow(tenant = 'so', tamper?: (callbackUrl: URL) => void): Promise<URLSearchParams> {
  const s = await fetch(`${run.base}/api/v1/auth/oidc/${tenant}/start`, { redirect: 'manual' });
  lastCookie = cookieOf(s);
  assert.equal(s.status, 302);
  const loc = s.headers.get('location')!;
  if (loc.startsWith('/login')) return new URL(loc, run.base).searchParams;
  const a = await fetch(loc, { redirect: 'manual' });
  const back = new URL(a.headers.get('location')!);
  const cb = new URL(back.pathname + back.search, run.base); // PUBLIC_BASE_URL is http://tenderflow.test in tests
  tamper?.(cb);
  const c = await fetch(cb, { redirect: 'manual', headers: { cookie: lastCookie } });
  assert.equal(c.status, 302);
  const final = new URL(c.headers.get('location')!, run.base);
  assert.equal(final.pathname, '/login');
  return final.searchParams;
}

async function exchange(handoff: string | null) {
  return api(run, 'POST', '/api/v1/auth/oidc/exchange', { json: { handoff } });
}

test('SSO not configured: start returns to the login page with SSO_NOT_CONFIGURED; login page shows no button', async () => {
  const p = await ssoFlow();
  assert.equal(p.get('ssoError'), 'SSO_NOT_CONFIGURED');
  const t = await api(run, 'GET', '/api/v1/public/tenants');
  assert.equal(t.body.find((x: any) => x.id === 'so').sso, null);
});

test('admin config validation: secret only by env reference, https issuer, staff roles only; secret never returned', async () => {
  const bad = async (patch: Record<string, unknown>) => (await api(run, 'PUT', '/api/v1/security/settings', { token: admin, json: { oidc: { ...baseOidc(), ...patch } } })).status;
  assert.equal(await bad({ clientSecretEnv: 'BID_MASTER_KEY' }), 400, 'cannot point at another server secret');
  assert.equal(await bad({ issuer: 'http://idp.example.com' }), 400, 'plain http only for localhost');
  assert.equal(await bad({ mappings: [{ group: 'X', roles: ['VENDOR'] }] }), 400);
  assert.equal(await bad({ scopes: 'profile email' }), 400, 'openid required');
  const saved = await configure(baseOidc());
  assert.equal(saved.oidc.clientSecretConfigured, true);
  assert.ok(!JSON.stringify(saved).includes(idp.clientSecret));
  const t = await api(run, 'POST', '/api/v1/security/sso/test', { token: admin });
  assert.equal(t.status, 200, t.text);
  assert.equal(t.body.issuerMatches, true);
  assert.equal(t.body.redirectUri, 'http://tenderflow.test/api/v1/auth/oidc/callback');
  const pub = await api(run, 'GET', '/api/v1/public/tenants');
  assert.deepEqual(pub.body.find((x: any) => x.id === 'so').sso, { labelEn: 'MOI Active Directory', labelAr: 'الدليل النشط لوزارة الداخلية' });
});

test('JIT_FROM_GROUPS: PKCE+state+nonce, ID token validated, user created from groups, normal session issued; hand-off single use', async () => {
  idp.nextUser = { sub: 'ad-111', username: 'Ahmed@MOI.example', name: 'Ahmed Al-Ali', groups: ['TF-Officers', 'Domain Users'] };
  const p = await ssoFlow();
  assert.equal(p.get('ssoError'), null, p.toString());
  const az = idp.lastAuthorize!;
  assert.equal(az.get('code_challenge_method'), 'S256');
  assert.ok(az.get('code_challenge') && az.get('state') && az.get('nonce'));
  assert.equal(az.get('client_id'), idp.clientId);
  assert.equal(idp.lastToken!.get('client_secret'), idp.clientSecret);
  assert.ok(idp.lastToken!.get('code_verifier'));
  const ex = await exchange(p.get('ssoHandoff'));
  assert.equal(ex.status, 200, ex.text);
  assert.deepEqual(ex.body.user.roles, ['PROCUREMENT_OFFICER']);
  assert.equal(ex.body.user.username, 'ahmed@moi.example');
  assert.equal(ex.body.user.authSource, 'OIDC');
  assert.equal((await api(run, 'GET', '/api/v1/tenders', { token: ex.body.token })).status, 200, 'normal TenderFlow session');
  assert.equal((await exchange(p.get('ssoHandoff'))).body.code, 'SSO_HANDOFF_INVALID', 'single use');
  // Directory group change → roles re-synced on next sign-in (audited).
  idp.nextUser = { ...idp.nextUser, groups: ['TF-Directors'] };
  const p2 = await ssoFlow();
  const ex2 = await exchange(p2.get('ssoHandoff'));
  assert.deepEqual(ex2.body.user.roles, ['DIRECTOR']);
  const acts = (await run.handle.ctx.db.query<any>(`SELECT action, details FROM audit_events WHERE tenant_id='so' ORDER BY seq`)).map((r) => r.action);
  for (const a of ['USER_PROVISIONED_FROM_DIRECTORY', 'USER_ROLES_SYNCED_FROM_DIRECTORY', 'LOGIN']) assert.ok(acts.includes(a), a);
  const login1 = await run.handle.ctx.db.query<any>(`SELECT details FROM audit_events WHERE tenant_id='so' AND action='LOGIN' ORDER BY seq DESC LIMIT 1`);
  assert.equal(login1[0].details.method, 'OIDC');
});

test('refusals: wrong nonce, wrong audience, expired, foreign signature, IdP token error, replayed state, unmapped groups', async () => {
  idp.nextUser = { sub: 'ad-222', username: 'mona@moi.example', groups: ['TF-Officers'] };
  const cases: [Partial<typeof idp.knobs>, string][] = [
    [{ nonce: 'not-the-nonce' }, 'SSO_NONCE_MISMATCH'],
    [{ audience: 'some-other-app' }, 'SSO_TOKEN_AUDIENCE'],
    [{ expired: true }, 'SSO_TOKEN_EXPIRED'],
    [{ signWithOtherKey: true }, 'SSO_TOKEN_INVALID'],
    [{ issuer: 'https://evil.example/v2.0' }, 'SSO_TOKEN_ISSUER'],
    [{ tokenError: 'invalid_grant' }, 'SSO_TOKEN_EXCHANGE_FAILED'],
    [{ omitIdToken: true }, 'SSO_NO_ID_TOKEN'],
  ];
  for (const [knobs, code] of cases) {
    idp.knobs = knobs;
    const p = await ssoFlow();
    assert.equal(p.get('ssoError'), code, `${JSON.stringify(knobs)} → ${p.toString()}`);
    assert.equal(p.get('ssoHandoff'), null);
  }
  idp.knobs = {};
  // Replay: the same callback (state) twice.
  let saved: URL | null = null;
  await ssoFlow('so', (u) => { saved = new URL(u); });
  const again = await fetch(saved!, { redirect: 'manual', headers: { cookie: lastCookie } });
  assert.equal(new URL(again.headers.get('location')!, run.base).searchParams.get('ssoError'), 'SSO_STATE_INVALID');
  // Unmapped groups → clear refusal, no account created.
  idp.nextUser = { sub: 'ad-333', username: 'khalid@moi.example', groups: ['Domain Users'] };
  const p = await ssoFlow();
  assert.equal(p.get('ssoError'), 'SSO_NO_MAPPED_GROUP');
  assert.match(p.get('ssoMessage') ?? '', /not mapped/);
  assert.equal((await run.handle.ctx.db.query(`SELECT 1 FROM users WHERE username='khalid@moi.example'`)).length, 0);
  const refused = await run.handle.ctx.db.query<any>(`SELECT reason FROM audit_events WHERE tenant_id='so' AND action='SSO_LOGIN_REFUSED'`);
  assert.ok(refused.length >= cases.length);
});

test('ADMIN_CREATED: no local account → refused; admin-created account links on first sign-in and keeps its TenderFlow roles', async () => {
  await configure({ ...baseOidc(), provisioning: 'ADMIN_CREATED' });
  idp.nextUser = { sub: 'ad-444', username: 'sara@moi.example', groups: ['TF-Officers'] };
  const p = await ssoFlow();
  assert.equal(p.get('ssoError'), 'SSO_NOT_PROVISIONED');
  const c = await api(run, 'POST', '/api/v1/admin/users', { token: admin, json: { username: 'sara@moi.example', displayName: 'Sara', password: 'Initial-Passw0rd!', roles: ['EVALUATOR'] } });
  assert.equal(c.status, 201, c.text);
  const p2 = await ssoFlow();
  const ex = await exchange(p2.get('ssoHandoff'));
  assert.equal(ex.status, 200, ex.text);
  assert.deepEqual(ex.body.user.roles, ['EVALUATOR'], 'roles managed in TenderFlow in this mode');
  // Same username from a different directory subject → refused.
  idp.nextUser = { sub: 'ad-999', username: 'sara@moi.example', groups: [] };
  assert.equal((await ssoFlow()).get('ssoError'), 'SSO_SUBJECT_MISMATCH');
  // Disabled account → refused.
  idp.nextUser = { sub: 'ad-444', username: 'sara@moi.example', groups: [] };
  await api(run, 'POST', `/api/v1/security/users/${c.body.id}/disable`, { token: admin, json: { reason: 'test' } });
  assert.equal((await ssoFlow()).get('ssoError'), 'ACCOUNT_DISABLED');
  // Vendor accounts never sign in through staff SSO.
  idp.nextUser = { sub: 'ad-555', username: 'vendor@moi.example', groups: ['TF-Officers'] };
  assert.equal((await ssoFlow()).get('ssoError'), 'SSO_VENDOR_ACCOUNT');
});

test('SSO respects the staff network allowlist', async () => {
  await configure({ ...baseOidc(), provisioning: 'JIT_FROM_GROUPS' });
  const r = await api(run, 'PUT', '/api/v1/security/settings', { token: admin, json: { staffNetwork: { mode: 'ALLOWLIST', cidrs: ['10.0.0.0/8'], trustProxyHeader: true }, confirmSelfLockout: true } });
  assert.equal(r.status, 200, r.text);
  idp.nextUser = { sub: 'ad-111', username: 'ahmed@moi.example', groups: ['TF-Officers'] };
  const p = await ssoFlow();
  assert.equal(p.get('ssoError'), 'OUTSIDE_PREMISES');
  await run.handle.ctx.db.query(`UPDATE security_settings SET staff_network='{"mode":"OFF","cidrs":[],"trustProxyHeader":false}' WHERE tenant_id='so'`);
  (await import('../src/features/security/settings.js')).clearSettingsCache(run.handle.ctx);
});
