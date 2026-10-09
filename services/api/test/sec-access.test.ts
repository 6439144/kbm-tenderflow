// SEC API tests: TOTP MFA sign-in (policy OFF/OPTIONAL/REQUIRED, enrolment, recovery codes, lockout, admin reset),
// account administration (disable/enable, roles, amend, guards) and the staff network allowlist.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, login, makeTenant, makeUser, startApp, PASSWORD, type Running } from './helpers.js';
import { registerVendor } from '../src/services/vendors.js';
import { base32Decode, totp } from '../src/auth/totp.js';
import { setClockOffset, now } from '../src/util.js';
import { verifyAudit } from '../src/services/audit.js';

let run: Running;
let adminA: string;
let vendorUserId: string;

const codeAt = (manualKey: string, offsetSteps = 0) => totp(base32Decode(manualKey), now().getTime() / 1000 + offsetSteps * 30);
const nextStep = () => setClockOffset((now().getTime() - Date.now()) + 30_000);

before(async () => {
  run = await startApp();
  await makeTenant(run, 'sa');
  await makeTenant(run, 'sb');
  await makeUser(run, 'sa', 'admin', ['TENANT_ADMIN']);
  await makeUser(run, 'sa', 'officer', ['PROCUREMENT_OFFICER']);
  await makeUser(run, 'sa', 'director', ['DIRECTOR']);
  await makeUser(run, 'sb', 'admin', ['TENANT_ADMIN']);
  const v = await registerVendor(run.handle.ctx, { tenantId: 'sa', legalNameEn: 'MFA Vendor (fictitious)', legalNameAr: 'مورد (وهمي)', crNumber: 'CR-1',
    email: 'v@vendors.example', categories: ['IT'], username: 'vend', password: PASSWORD });
  vendorUserId = (v as any).user?.id ?? (v as any).userId;
  adminA = await login(run, 'sa', 'admin');
});
after(async () => { setClockOffset(0); await run.stop(); });

async function setSettings(token: string, body: unknown) {
  const r = await api(run, 'PUT', '/api/v1/security/settings', { token, json: body });
  assert.equal(r.status, 200, r.text);
  return r.body;
}

test('MFA policy OFF (default): password alone signs in; enrolment refused', async () => {
  const s = await api(run, 'GET', '/api/v1/security/settings', { token: adminA });
  assert.equal(s.status, 200);
  assert.equal(s.body.mfaVendors, 'OFF');
  assert.equal(s.body.staffNetwork.mode, 'OFF');
  const vt = await login(run, 'sa', 'vend');
  const e = await api(run, 'POST', '/api/v1/security/mfa/enrol/start', { token: vt });
  assert.equal(e.status, 409);
  assert.equal(e.body.code, 'MFA_NOT_ENABLED');
});

test('non-admin cannot read or change security settings; tenant comes from the token', async () => {
  const off = await login(run, 'sa', 'officer');
  assert.equal((await api(run, 'GET', '/api/v1/security/settings', { token: off })).status, 403);
  assert.equal((await api(run, 'PUT', '/api/v1/security/settings', { token: off, json: { mfaVendors: 'OFF' } })).status, 403);
  const adminB = await login(run, 'sb', 'admin');
  await setSettings(adminB, { mfaVendors: 'REQUIRED' });
  const a = await api(run, 'GET', '/api/v1/security/settings', { token: adminA });
  assert.equal(a.body.mfaVendors, 'OFF', 'tenant B change does not affect tenant A');
  await setSettings(adminB, { mfaVendors: 'OFF' });
  const bad = await api(run, 'PUT', '/api/v1/security/settings', { token: adminA, json: { mfaVendors: 'SOMETIMES' } });
  assert.equal(bad.status, 400);
});

let manualKey = '';
let recoveryCodes: string[] = [];

test('MFA OPTIONAL: vendor enrols (scan → confirm) and gets 8 recovery codes once; then sign-in needs a code', async () => {
  await setSettings(adminA, { mfaVendors: 'OPTIONAL' });
  const vt = await login(run, 'sa', 'vend'); // not enrolled yet → no second step
  const st = await api(run, 'POST', '/api/v1/security/mfa/enrol/start', { token: vt });
  assert.equal(st.status, 200, st.text);
  assert.match(st.body.otpauthUri, /^otpauth:\/\/totp\//);
  assert.match(st.body.qrDataUrl, /^data:image\/png;base64,/);
  manualKey = st.body.manualKey;
  const wrong = await api(run, 'POST', '/api/v1/security/mfa/enrol/confirm', { token: vt, json: { code: '000000' } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, 'MFA_CODE_INVALID');
  const ok = await api(run, 'POST', '/api/v1/security/mfa/enrol/confirm', { token: vt, json: { code: codeAt(manualKey) } });
  assert.equal(ok.status, 200, ok.text);
  recoveryCodes = ok.body.recoveryCodes;
  assert.equal(recoveryCodes.length, 8);
  const me = await api(run, 'GET', '/api/v1/security/mfa/me', { token: vt });
  assert.equal(me.body.status, 'ACTIVE');
  assert.equal(me.body.recoveryCodesLeft, 8);
  // DB holds only an encrypted secret and hashes.
  const row = (await run.handle.ctx.db.query<any>('SELECT secret_enc, recovery_hashes FROM user_mfa WHERE user_id=$1', [vendorUserId]))[0];
  assert.ok(!row.secret_enc.includes(manualKey.replace(/ /g, '')));
  assert.ok(row.recovery_hashes.every((h: string) => h.startsWith('scrypt$') && !recoveryCodes.some((c) => h.includes(c))));

  const r = await api(run, 'POST', '/api/v1/auth/login', { json: { tenantId: 'sa', username: 'vend', password: PASSWORD } });
  assert.equal(r.status, 200);
  assert.equal(r.body.mfaRequired, true);
  assert.equal(r.body.token, undefined, 'no session before the second step');
  // The pending token is not a session.
  assert.equal((await api(run, 'GET', '/api/v1/tenders', { token: r.body.mfaToken })).status, 401);
  // The code used for enrolment cannot be replayed in the same step.
  const replay = await api(run, 'POST', '/api/v1/auth/mfa/verify', { json: { mfaToken: r.body.mfaToken, code: codeAt(manualKey) } });
  assert.equal(replay.status, 401);
  nextStep();
  const v = await api(run, 'POST', '/api/v1/auth/mfa/verify', { json: { mfaToken: r.body.mfaToken, code: codeAt(manualKey) } });
  assert.equal(v.status, 200, v.text);
  assert.ok(v.body.token);
  assert.equal((await api(run, 'GET', '/api/v1/vendors/me', { token: v.body.token })).status, 200);
});

test('MFA: a recovery code works exactly once', async () => {
  const r1 = await api(run, 'POST', '/api/v1/auth/login', { json: { tenantId: 'sa', username: 'vend', password: PASSWORD } });
  const v1 = await api(run, 'POST', '/api/v1/auth/mfa/verify', { json: { mfaToken: r1.body.mfaToken, recoveryCode: recoveryCodes[0] } });
  assert.equal(v1.status, 200, v1.text);
  assert.equal(v1.body.recoveryCodesLeft, 7);
  const r2 = await api(run, 'POST', '/api/v1/auth/login', { json: { tenantId: 'sa', username: 'vend', password: PASSWORD } });
  const v2 = await api(run, 'POST', '/api/v1/auth/mfa/verify', { json: { mfaToken: r2.body.mfaToken, recoveryCode: recoveryCodes[0] } });
  assert.equal(v2.status, 401);
  assert.equal(v2.body.code, 'MFA_CODE_INVALID');
});

test('MFA: 5 wrong codes lock the second factor (429 MFA_LOCKED); failures audited; admin reset clears it (audited)', async () => {
  const r = await api(run, 'POST', '/api/v1/auth/login', { json: { tenantId: 'sa', username: 'vend', password: PASSWORD } });
  // One failure is already counted (the reused recovery code); the counter resets only on success.
  for (let i = 0; i < 4; i++) {
    const v = await api(run, 'POST', '/api/v1/auth/mfa/verify', { json: { mfaToken: r.body.mfaToken, code: '111111' } });
    assert.equal(v.status, 401);
  }
  nextStep();
  const locked = await api(run, 'POST', '/api/v1/auth/mfa/verify', { json: { mfaToken: r.body.mfaToken, code: codeAt(manualKey) } });
  assert.equal(locked.status, 429);
  assert.equal(locked.body.code, 'MFA_LOCKED');
  const users = await api(run, 'GET', '/api/v1/security/users', { token: adminA });
  const vend = users.body.find((u: any) => u.username === 'vend');
  assert.equal(vend.mfa, 'ACTIVE');
  assert.equal(vend.mfaLocked, true);
  assert.equal(vend.kind, 'VENDOR');
  const noReason = await api(run, 'POST', `/api/v1/security/users/${vend.id}/mfa-reset`, { token: adminA, json: {} });
  assert.equal(noReason.status, 400);
  const reset = await api(run, 'POST', `/api/v1/security/users/${vend.id}/mfa-reset`, { token: adminA, json: { reason: 'Lost phone, identity checked by phone call' } });
  assert.equal(reset.status, 200, reset.text);
  const audit = await api(run, 'GET', `/api/v1/audit?resourceId=${vend.id}&limit=200`, { token: adminA });
  const actions = audit.body.map((e: any) => e.action);
  for (const a of ['MFA_ENROLMENT_STARTED', 'MFA_ENROLLED', 'MFA_VERIFICATION_FAILED', 'MFA_RECOVERY_CODE_USED', 'MFA_RESET_BY_ADMIN', 'LOGIN_PASSWORD_ACCEPTED_MFA_PENDING'])
    assert.ok(actions.includes(a), `audit has ${a}`);
  // After reset with policy OPTIONAL, password alone works again.
  assert.ok(await login(run, 'sa', 'vend'));
});

test('MFA REQUIRED: not-enrolled user must enrol during sign-in before any session; staff unaffected by vendor policy', async () => {
  await setSettings(adminA, { mfaVendors: 'REQUIRED' });
  assert.ok(await login(run, 'sa', 'officer'), 'staff policy is still OFF');
  const r = await api(run, 'POST', '/api/v1/auth/login', { json: { tenantId: 'sa', username: 'vend', password: PASSWORD } });
  assert.equal(r.body.mfaRequired, true);
  assert.equal(r.body.enrolRequired, true);
  const wrongStep = await api(run, 'POST', '/api/v1/auth/mfa/verify', { json: { mfaToken: r.body.mfaToken, code: '123456' } });
  assert.equal(wrongStep.status, 409);
  const st = await api(run, 'POST', '/api/v1/auth/mfa/enrol/start', { json: { mfaToken: r.body.mfaToken } });
  assert.equal(st.status, 200, st.text);
  manualKey = st.body.manualKey;
  nextStep();
  const ok = await api(run, 'POST', '/api/v1/auth/mfa/enrol/confirm', { json: { mfaToken: r.body.mfaToken, code: codeAt(manualKey) } });
  assert.equal(ok.status, 200, ok.text);
  assert.ok(ok.body.token);
  assert.equal(ok.body.recoveryCodes.length, 8);
  // REQUIRED: the user cannot switch it off.
  nextStep();
  const off = await api(run, 'POST', '/api/v1/security/mfa/disable', { token: ok.body.token, json: { code: codeAt(manualKey) } });
  assert.equal(off.status, 409);
  assert.equal(off.body.code, 'MFA_REQUIRED_BY_POLICY');
  const bad = await api(run, 'POST', '/api/v1/auth/mfa/enrol/start', { json: { mfaToken: 'garbage' } });
  assert.equal(bad.status, 401);
  await setSettings(adminA, { mfaVendors: 'OFF' });
});

test('accounts: disable blocks sign-in and existing tokens at once (audited); enable restores; guards for self/last admin', async () => {
  const off = await login(run, 'sa', 'officer');
  const users = (await api(run, 'GET', '/api/v1/security/users', { token: adminA })).body;
  const officer = users.find((u: any) => u.username === 'officer');
  const admin = users.find((u: any) => u.username === 'admin');
  assert.ok('lastLoginAt' in officer && officer.lastLoginAt, 'last login shown');
  const d = await api(run, 'POST', `/api/v1/security/users/${officer.id}/disable`, { token: adminA, json: { reason: 'Left the department' } });
  assert.equal(d.status, 200, d.text);
  assert.equal(d.body.active, false);
  assert.equal((await api(run, 'GET', '/api/v1/tenders', { token: off })).status, 401, 'existing token stops working');
  const l = await api(run, 'POST', '/api/v1/auth/login', { json: { tenantId: 'sa', username: 'officer', password: PASSWORD } });
  assert.equal(l.status, 403);
  assert.equal(l.body.code, 'ACCOUNT_DISABLED');
  const wrongPw = await api(run, 'POST', '/api/v1/auth/login', { json: { tenantId: 'sa', username: 'officer', password: 'wrong-password' } });
  assert.equal(wrongPw.status, 401, 'disabled state is not revealed without the right password');
  const e = await api(run, 'POST', `/api/v1/security/users/${officer.id}/enable`, { token: adminA, json: { reason: 'Returned' } });
  assert.equal(e.status, 200);
  assert.ok(await login(run, 'sa', 'officer'));
  const self = await api(run, 'POST', `/api/v1/security/users/${admin.id}/disable`, { token: adminA, json: { reason: 'x' } });
  assert.equal(self.body.code, 'CANNOT_DISABLE_SELF');
  const vend = users.find((u: any) => u.username === 'vend');
  const dv = await api(run, 'POST', `/api/v1/security/users/${vend.id}/disable`, { token: adminA, json: { reason: 'Vendor suspended' } });
  assert.equal(dv.status, 200, 'vendor users can be disabled too');
  assert.equal((await api(run, 'POST', '/api/v1/auth/login', { json: { tenantId: 'sa', username: 'vend', password: PASSWORD } })).body.code, 'ACCOUNT_DISABLED');
  await api(run, 'POST', `/api/v1/security/users/${vend.id}/enable`, { token: adminA, json: { reason: 'Reinstated' } });
  const audit = (await api(run, 'GET', `/api/v1/audit?resourceId=${officer.id}`, { token: adminA })).body.map((x: any) => x.action);
  for (const a of ['USER_DISABLED', 'USER_ENABLED', 'LOGIN_REFUSED_ACCOUNT_DISABLED']) assert.ok(audit.includes(a), a);
  // Other tenant's user → 404
  const adminB = await login(run, 'sb', 'admin');
  assert.equal((await api(run, 'POST', `/api/v1/security/users/${officer.id}/disable`, { token: adminB, json: { reason: 'x' } })).status, 404);
});

test('roles: assign (FR-036) takes effect immediately; vendor role rules; cannot drop own admin; amend display name/password', async () => {
  const users = (await api(run, 'GET', '/api/v1/security/users', { token: adminA })).body;
  const director = users.find((u: any) => u.username === 'director');
  const vend = users.find((u: any) => u.username === 'vend');
  const admin = users.find((u: any) => u.username === 'admin');
  const dirToken = await login(run, 'sa', 'director');
  const r = await api(run, 'PUT', `/api/v1/security/users/${director.id}/roles`, { token: adminA, json: { roles: ['DIRECTOR', 'UNDERSECRETARY'], reason: 'Acting undersecretary' } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.roles.sort(), ['DIRECTOR', 'UNDERSECRETARY']);
  assert.equal((await api(run, 'GET', '/api/v1/tenders', { token: dirToken })).status, 401, 'old token with old roles refused');
  const dirToken2 = await login(run, 'sa', 'director');
  assert.equal((await api(run, 'GET', '/api/v1/tenders', { token: dirToken2 })).status, 200);
  assert.equal((await api(run, 'PUT', `/api/v1/security/users/${vend.id}/roles`, { token: adminA, json: { roles: ['PROCUREMENT_OFFICER'] } })).body.code, 'VENDOR_ROLES_FIXED');
  assert.equal((await api(run, 'PUT', `/api/v1/security/users/${director.id}/roles`, { token: adminA, json: { roles: ['VENDOR'] } })).body.code, 'VENDOR_ROLE_STAFF');
  assert.equal((await api(run, 'PUT', `/api/v1/security/users/${admin.id}/roles`, { token: adminA, json: { roles: ['AUDITOR'] } })).body.code, 'CANNOT_REMOVE_OWN_ADMIN');
  assert.equal((await api(run, 'PUT', `/api/v1/security/users/${director.id}/roles`, { token: adminA, json: { roles: ['KING'] } })).status, 400);
  const am = await api(run, 'PATCH', `/api/v1/security/users/${director.id}`, { token: adminA, json: { displayName: 'Director (renamed)', password: 'New-Passw0rd!' } });
  assert.equal(am.status, 200, am.text);
  assert.equal(am.body.displayName, 'Director (renamed)');
  assert.ok(await login(run, 'sa', 'director', 'New-Passw0rd!'));
  const roles = await api(run, 'GET', '/api/v1/security/roles', { token: adminA });
  assert.equal(roles.body.length, 8);
});

test('staff network allowlist: refuses staff outside (403 OUTSIDE_PREMISES, audited, rate-limited), vendors unaffected, self-lockout needs confirmation', async () => {
  const offToken = await login(run, 'sa', 'officer');
  // Saving an allowlist that excludes the saver's own address is refused without explicit confirmation.
  const lock = await api(run, 'PUT', '/api/v1/security/settings', { token: adminA, json: { staffNetwork: { mode: 'ALLOWLIST', cidrs: ['10.0.0.0/8'], trustProxyHeader: true } } });
  assert.equal(lock.status, 409);
  assert.equal(lock.body.code, 'SELF_LOCKOUT');
  const bad = await api(run, 'PUT', '/api/v1/security/settings', { token: adminA, json: { staffNetwork: { mode: 'ALLOWLIST', cidrs: ['10.0.0.0/33'] } } });
  assert.equal(bad.status, 400);
  // Include the test runner's own address (127.0.0.1 — it sends no proxy header) plus the premises range.
  const saved = await setSettings(adminA, { staffNetwork: { mode: 'ALLOWLIST', cidrs: ['10.0.0.0/8', '127.0.0.1/32', '2001:db8:10::/48'], trustProxyHeader: true, basis: 'PREMISES_AND_VPN' } });
  assert.deepEqual(saved.changed, ['staffNetwork']);
  const xff = (ip: string) => ({ authorization: `Bearer ${offToken}`, 'x-forwarded-for': ip });
  const out = await fetch(`${run.base}/api/v1/tenders`, { headers: xff('203.0.113.50') });
  assert.equal(out.status, 403);
  const body = await out.json();
  assert.equal(body.code, 'OUTSIDE_PREMISES');
  assert.equal(body.ip, '203.0.113.50');
  assert.equal(body.basis, 'PREMISES_AND_VPN');
  assert.equal((await fetch(`${run.base}/api/v1/tenders`, { headers: xff('203.0.113.50') })).status, 403);
  assert.equal((await fetch(`${run.base}/api/v1/tenders`, { headers: xff('10.20.30.40') })).status, 200);
  assert.equal((await fetch(`${run.base}/api/v1/tenders`, { headers: xff('2001:db8:10::7') })).status, 200, 'IPv6 range');
  // Staff sign-in from outside is refused too.
  const lo = await fetch(`${run.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.1' },
    body: JSON.stringify({ tenantId: 'sa', username: 'officer', password: PASSWORD }) });
  assert.equal(lo.status, 403);
  // Vendors are never affected.
  const vt = await login(run, 'sa', 'vend');
  assert.equal((await fetch(`${run.base}/api/v1/tenders`, { headers: { authorization: `Bearer ${vt}`, 'x-forwarded-for': '203.0.113.50' } })).status, 200);
  // whoami for the admin page
  const who = await fetch(`${run.base}/api/v1/security/network/whoami`, { headers: { authorization: `Bearer ${adminA}`, 'x-forwarded-for': '10.1.1.1' } });
  const w = await who.json();
  assert.equal(w.ip, '10.1.1.1');
  assert.equal(w.inside, true);
  // Refusal audited once per user/address/minute (two refused requests above → one event for REQUEST).
  const ev = await run.handle.ctx.db.query<any>(`SELECT details FROM audit_events WHERE tenant_id='sa' AND action='STAFF_ACCESS_OUTSIDE_PREMISES'`);
  assert.equal(ev.filter((e) => e.details.ip === '203.0.113.50' && e.details.phase === 'REQUEST').length, 1);
  assert.equal(ev.filter((e) => e.details.phase === 'LOGIN').length, 1);
  // With trustProxyHeader=false the header is ignored (the TCP peer 127.0.0.1 is used).
  await setSettings(adminA, { staffNetwork: { mode: 'ALLOWLIST', cidrs: ['127.0.0.1/32'], trustProxyHeader: false } });
  assert.equal((await fetch(`${run.base}/api/v1/tenders`, { headers: xff('203.0.113.50') })).status, 200);
  // Confirmed self-lockout is possible but explicit and audited.
  const conf = await api(run, 'PUT', '/api/v1/security/settings', { token: adminA, json: { staffNetwork: { mode: 'ALLOWLIST', cidrs: ['10.0.0.0/8'] }, confirmSelfLockout: true } });
  assert.equal(conf.status, 200);
  assert.equal((await api(run, 'GET', '/api/v1/security/settings', { token: adminA })).body.code, 'OUTSIDE_PREMISES');
  // Clean up directly in the DB (the admin is now outside) and verify the audit chain.
  await run.handle.ctx.db.query(`UPDATE security_settings SET staff_network='{"mode":"OFF","cidrs":[],"trustProxyHeader":false}' WHERE tenant_id='sa'`);
  const { clearSettingsCache } = await import('../src/features/security/settings.js');
  clearSettingsCache(run.handle.ctx);
  assert.equal((await api(run, 'GET', '/api/v1/security/settings', { token: adminA })).status, 200);
  const v = await verifyAudit(run.handle.ctx.db, run.handle.ctx.config.auditSigningKey, 'sa');
  assert.equal(v.valid, true);
});
