// SEC workstream: identity, access and content protection. Public routes (second sign-in step, SSO) are mounted
// before authentication; everything else needs a session. Policies live in security_settings (one row per entity).
import type express from 'express';
import type { Request } from 'express';
import rateLimit from 'express-rate-limit';
import type { Ctx } from '../ctx.js';
import { auditTx } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import { unauthorized } from '../auth/tokens.js';
import { actor, h, requireRoles, sendDoc } from '../routes.js';
import { conflict, reqStr } from '../util.js';
import * as identity from '../services/identity.js';
import type { UserRow } from '../services/identity.js';
import { ipInList } from '../auth/cidr.js';
import {
  clearSettingsCache, loadSettings, parseContentMode, parseMfaPolicy, parseOidc, parseStaffNetwork, publicSettings, saveSettingsRow,
} from './security/settings.js';
import { clientIp, enforceStaffNetwork, networkStatus } from './security/network.js';
import { adminResetMfa, confirmEnrolment, disableOwn, mfaStatus, startEnrolment } from './security/mfa.js';
import { amendUser, listAccounts, ROLE_CATALOGUE, setActive, setRoles } from './security/accounts.js';
import { documentAccess, openView, recordViewEvent, watermarkedDownload } from './security/content.js';
import { clearSsoCookie, redirectUri, ssoCallback, ssoExchange, ssoStart, SsoError, testDiscovery } from './security/sso.js';

const ADMIN = 'TENANT_ADMIN';

/**
 * Called by authenticate() for every request with a valid token: the account must still exist and be enabled,
 * the token's roles must still be the account's roles (role changes and disabling take effect at once), and
 * staff must be inside the entity's network allowlist.
 */
export async function securityGate(ctx: Ctx, req: Request, a: Actor): Promise<void> {
  if (a.issuer === 'local') {
    const u = (await ctx.db.query<{ active: boolean; roles: string[] }>('SELECT active, roles FROM users WHERE id=$1 AND tenant_id=$2', [a.id, a.tenantId]))[0];
    if (!u?.active) throw unauthorized('User is inactive or unknown');
    if ([...u.roles].sort().join() !== [...a.roles].sort().join()) throw unauthorized('Your roles have changed; sign in again');
  }
  await enforceStaffNetwork(ctx, req, a, 'REQUEST');
}

async function currentUser(ctx: Ctx, a: Actor) {
  const u = (await ctx.db.query<UserRow>('SELECT * FROM users WHERE id=$1 AND tenant_id=$2', [a.id, a.tenantId]))[0];
  if (!u) throw unauthorized('User no longer exists');
  return u;
}

export function registerSecurityPublicRoutes(r: express.Router, ctx: Ctx) {
  const limiter = rateLimit({ windowMs: 60_000, limit: ctx.config.loginRateLimit, standardHeaders: 'draft-7', legacyHeaders: false,
    handler: (_req, res) => { res.status(429).json({ code: 'RATE_LIMITED', message: 'Too many attempts, try again later' }); } });
  // Second sign-in step (TOTP or recovery code), and forced enrolment when the entity policy is REQUIRED.
  r.post('/auth/mfa/verify', limiter, h((req) => identity.mfaLoginVerify(ctx, req.body, req)));
  r.post('/auth/mfa/enrol/start', limiter, h((req) => identity.mfaLoginEnrolStart(ctx, req.body, req)));
  r.post('/auth/mfa/enrol/confirm', limiter, h((req) => identity.mfaLoginEnrolConfirm(ctx, req.body, req)));

  // Staff SSO (OIDC). Browser navigations: errors come back to the login page as ?ssoError=CODE.
  const toLogin = (res: express.Response, params: Record<string, string>) => res.redirect(302, `/login?${new URLSearchParams(params).toString()}`);
  r.get('/auth/oidc/:tenantId/start', limiter, (req, res) => {
    ssoStart(ctx, req.params.tenantId)
      .then(({ url, cookie }) => { res.setHeader('Set-Cookie', cookie); res.setHeader('Cache-Control', 'no-store'); res.redirect(302, url); })
      .catch((e) => toLogin(res, { ssoError: e instanceof SsoError || e?.code ? String(e.code) : 'SSO_FAILED', tenant: req.params.tenantId }));
  });
  r.get('/auth/oidc/callback', limiter, (req, res) => {
    res.setHeader('Set-Cookie', clearSsoCookie(ctx)); // single use, whatever the outcome
    res.setHeader('Cache-Control', 'no-store');
    ssoCallback(ctx, req.query as Record<string, unknown>, req, req.headers.cookie)
      .then(({ tenantId, handoff }) => toLogin(res, { tenant: tenantId, ssoHandoff: handoff }))
      .catch((e) => {
        if (!(e instanceof SsoError) && !e?.code) console.error('[sso] callback failed:', e);
        toLogin(res, { ssoError: e?.code ? String(e.code) : 'SSO_FAILED', ...(e?.message ? { ssoMessage: String(e.message).slice(0, 300) } : {}) });
      });
  });
  r.post('/auth/oidc/exchange', limiter, h((req) => ssoExchange(ctx, req.body, req)));
}

export function registerSecurityRoutes(r: express.Router, ctx: Ctx) {
  const admin = requireRoles(ADMIN);

  // ---- my second factor ----
  r.get('/security/mfa/me', h(async (req) => mfaStatus(ctx, await currentUser(ctx, actor(req)))));
  r.post('/security/mfa/enrol/start', h(async (req) => startEnrolment(ctx, await currentUser(ctx, actor(req)))));
  r.post('/security/mfa/enrol/confirm', h(async (req) => confirmEnrolment(ctx, await currentUser(ctx, actor(req)), req.body?.code)));
  r.post('/security/mfa/disable', h(async (req) => disableOwn(ctx, await currentUser(ctx, actor(req)), req.body?.code)));

  // ---- entity security settings (admin) ----
  r.get('/security/settings', admin, h(async (req) => ({
    ...publicSettings(await loadSettings(ctx, actor(req).tenantId, { fresh: true })),
    sso: { redirectUri: redirectUri(ctx) },
    breakGlass: ctx.config.staffNetworkBreakGlass,
  })));
  r.put('/security/settings', admin, h(async (req) => {
    const a = actor(req);
    const b = req.body ?? {};
    const cur = await loadSettings(ctx, a.tenantId, { fresh: true });
    const next = {
      mfaVendors: b.mfaVendors === undefined ? cur.mfaVendors : parseMfaPolicy(b.mfaVendors, 'mfaVendors'),
      mfaStaff: b.mfaStaff === undefined ? cur.mfaStaff : parseMfaPolicy(b.mfaStaff, 'mfaStaff'),
      staffNetwork: b.staffNetwork === undefined ? cur.staffNetwork : parseStaffNetwork(b.staffNetwork),
      contentProtection: b.contentProtection === undefined ? cur.contentProtection : parseContentMode(b.contentProtection),
      oidc: b.oidc === undefined ? cur.oidc : parseOidc(b.oidc, { allowHttp: ctx.config.oidcAllowHttp }),
    };
    // Never lock the administrator out silently.
    if (next.staffNetwork.mode === 'ALLOWLIST' && !ipInList(clientIp(req, next.staffNetwork), next.staffNetwork.cidrs) && b.confirmSelfLockout !== true)
      throw conflict('SELF_LOCKOUT', `Your current address ${clientIp(req, next.staffNetwork)} is not in the allowlist: saving would lock you out. Add it, or confirm explicitly.`);
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(cur[k]));
    if (!changed.length) return { ...publicSettings(cur), changed: [] };
    await ctx.db.tx(async (q) => {
      await saveSettingsRow(q, a.tenantId, next, a.id);
      await auditTx(ctx, q, { tenantId: a.tenantId, actor: a, action: 'SECURITY_SETTINGS_UPDATED', resourceType: 'TENANT', resourceId: a.tenantId,
        reason: typeof b.reason === 'string' ? b.reason.slice(0, 500) : null,
        details: {
          changed,
          mfaVendors: next.mfaVendors, mfaStaff: next.mfaStaff, contentProtection: next.contentProtection,
          staffNetwork: next.staffNetwork,
          oidc: next.oidc ? { enabled: next.oidc.enabled, issuer: next.oidc.issuer, clientId: next.oidc.clientId, provisioning: next.oidc.provisioning, mappings: next.oidc.mappings.length } : null,
          selfLockoutConfirmed: b.confirmSelfLockout === true || undefined,
        } });
    });
    clearSettingsCache(ctx);
    return { ...publicSettings(await loadSettings(ctx, a.tenantId, { fresh: true })), changed };
  }));
  r.get('/security/network/whoami', h(async (req) => networkStatus(ctx, req, actor(req).tenantId)));
  r.post('/security/network/check', admin, h(async (req) => networkStatus(ctx, req, actor(req).tenantId, parseStaffNetwork(req.body ?? {}))));
  r.post('/security/sso/test', admin, h((req) => testDiscovery(ctx, actor(req).tenantId)));

  // ---- account administration (FR-035/036) ----
  r.get('/security/roles', admin, h(async () => ROLE_CATALOGUE));
  r.get('/security/users', admin, h((req) => listAccounts(ctx, actor(req), req.query)));
  r.post('/security/users/:id/disable', admin, h((req) => setActive(ctx, actor(req), req.params.id, false, req.body)));
  r.post('/security/users/:id/enable', admin, h((req) => setActive(ctx, actor(req), req.params.id, true, req.body)));
  r.put('/security/users/:id/roles', admin, h((req) => setRoles(ctx, actor(req), req.params.id, req.body)));
  r.patch('/security/users/:id', admin, h((req) => amendUser(ctx, actor(req), req.params.id, req.body)));
  r.post('/security/users/:id/mfa-reset', admin, h((req) => adminResetMfa(ctx, actor(req), req.params.id, reqStr(req.body?.reason, 'reason', 500))));

  // ---- content protection ----
  r.get('/security/content/documents', h((req) => documentAccess(ctx, actor(req), req.query.ids)));
  r.post('/security/content/documents/:id/view', h(async (req, res) => { res.setHeader('Cache-Control', 'no-store'); return openView(ctx, actor(req), req.params.id); }));
  r.post('/security/content/views/:id/events', h((req) => recordViewEvent(ctx, actor(req), req.params.id, req.body)));
  r.get('/security/content/documents/:id/download', h(async (req, res) => {
    const { doc, bytes } = await watermarkedDownload(ctx, actor(req), req.params.id);
    res.setHeader('Cache-Control', 'no-store');
    sendDoc(res, doc, bytes);
  }));
}
