// Staff single sign-on against the entity's Active Directory through OpenID Connect (Microsoft Entra ID or AD FS
// 2016+). Authorization-code flow with PKCE (S256), state and nonce; the ID token is validated against the issuer's
// JWKS (jose): signature, iss, aud = client id, exp/nbf, nonce. Directory groups map to TenderFlow roles; provisioning
// is JIT_FROM_GROUPS (create/update the user from groups) or ADMIN_CREATED (the account must already exist — MOI open
// item "account provisioning"). Then the normal TenderFlow RS256 session is issued through a one-time hand-off.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { createRemoteJWKSet, jwtVerify, errors as joseErrors, type JWTPayload } from 'jose';
import type { Ctx } from '../../ctx.js';
import { auditTx } from '../../ctx.js';
import { SYSTEM_ACTOR } from '../../services/audit.js';
import { ApiError, now, uuid } from '../../util.js';
import { completeLogin, type UserRow } from '../../services/identity.js';
import { enforceStaffNetwork, type ReqLike } from './network.js';
import { loadSettings, type OidcConfig } from './settings.js';
import { foreignEntity } from '../../tenancy.js';

export class SsoError extends ApiError {
  constructor(code: string, message: string, status = 401) { super(status, code, message); }
}

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }
const discoCache = new Map<string, { at: number; doc: Discovery }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const DISCO_TTL_MS = 10 * 60_000;

export async function discover(issuer: string, fresh = false): Promise<Discovery> {
  const hit = discoCache.get(issuer);
  if (!fresh && hit && Date.now() - hit.at < DISCO_TTL_MS) return hit.doc;
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  let res: Response;
  try { res = await fetch(url, { signal: AbortSignal.timeout(10_000) }); }
  catch (e) { throw new SsoError('SSO_DISCOVERY_FAILED', `Cannot reach the identity provider at ${url}: ${(e as Error).message}`, 503); }
  if (!res.ok) throw new SsoError('SSO_DISCOVERY_FAILED', `Identity provider discovery failed (${res.status}) at ${url}`, 503);
  const doc = (await res.json()) as Partial<Discovery>;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri || !doc.issuer)
    throw new SsoError('SSO_DISCOVERY_FAILED', `Discovery document at ${url} lacks authorization_endpoint/token_endpoint/jwks_uri/issuer`, 503);
  discoCache.set(issuer, { at: Date.now(), doc: doc as Discovery });
  return doc as Discovery;
}

const b64url = (b: Buffer) => b.toString('base64url');
const rand = (n = 32) => b64url(crypto.randomBytes(n));
export const redirectUri = (ctx: Ctx) => `${ctx.config.publicBaseUrl}/api/v1/auth/oidc/callback`;

async function enabledConfig(ctx: Ctx, tenantId: string): Promise<OidcConfig> {
  const o = (await loadSettings(ctx, tenantId, { fresh: true })).oidc;
  if (!o || !o.enabled) throw new SsoError('SSO_NOT_CONFIGURED', 'Single sign-on is not configured for this entity', 404);
  return o;
}

// ---- HARDEN: browser binding of state + nonce ----
// /start also sets an httpOnly, SameSite=Lax, 10-minute cookie, HMAC-signed with a key derived from AUDIT_SIGNING_KEY,
// holding the state, the SHA-256 of the nonce, the entity and the expiry. /callback refuses (SSO_BROWSER_MISMATCH)
// unless the same browser presents that cookie for that state, so a callback URL cannot be replayed from another
// browser (login CSRF / code injection); the state row is single use, so it cannot be replayed in the same one either.
export const SSO_COOKIE = 'tf_oidc_state';
const SSO_COOKIE_PATH = '/api/v1/auth/oidc';
const STATE_TTL_MS = 10 * 60_000;
const cookieKey = (ctx: Ctx) => Buffer.from(crypto.hkdfSync('sha256', ctx.config.auditSigningKey, 'tenderflow', 'oidc-state-cookie', 32));
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('base64url');

function signCookie(ctx: Ctx, payload: { s: string; n: string; t: string; e: number }): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${crypto.createHmac('sha256', cookieKey(ctx)).update(body).digest('base64url')}`;
}

export function readSsoCookie(ctx: Ctx, cookieHeader: string | undefined): { s: string; n: string; t: string; e: number } | null {
  const raw = (cookieHeader ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${SSO_COOKIE}=`))?.slice(SSO_COOKIE.length + 1);
  if (!raw) return null;
  const [body, mac] = raw.split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', cookieKey(ctx)).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof p?.s !== 'string' || typeof p?.n !== 'string' || typeof p?.t !== 'string' || typeof p?.e !== 'number') return null;
    return p;
  } catch { return null; }
}

const cookieAttrs = (ctx: Ctx, maxAgeSec: number) =>
  `Path=${SSO_COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${ctx.config.publicBaseUrl.startsWith('https:') ? '; Secure' : ''}`;
export const clearSsoCookie = (ctx: Ctx) => `${SSO_COOKIE}=; ${cookieAttrs(ctx, 0)}`;

/** Build the authorization request and remember state, nonce and the PKCE verifier (10 minutes, single use). */
export async function ssoStart(ctx: Ctx, tenantId: string): Promise<{ url: string; cookie: string }> {
  if (!/^[a-z0-9_-]{2,40}$/.test(tenantId)) throw new SsoError('SSO_NOT_CONFIGURED', 'Unknown entity', 404);
  const o = await enabledConfig(ctx, tenantId);
  const doc = await discover(o.issuer);
  const state = rand(), nonce = rand(), verifier = rand(48);
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  await ctx.db.query('DELETE FROM oidc_login_states WHERE expires_at < now()');
  const expires = Date.now() + STATE_TTL_MS;
  await ctx.db.query('INSERT INTO oidc_login_states (state, tenant_id, nonce, code_verifier, expires_at) VALUES ($1,$2,$3,$4,$5)',
    [state, tenantId, nonce, verifier, new Date(expires)]);
  const u = new URL(doc.authorization_endpoint);
  const p = { response_type: 'code', client_id: o.clientId, redirect_uri: redirectUri(ctx), scope: o.scopes, state, nonce,
    code_challenge: challenge, code_challenge_method: 'S256', response_mode: 'query' };
  for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
  const cookie = `${SSO_COOKIE}=${signCookie(ctx, { s: state, n: sha(nonce), t: tenantId, e: expires })}; ${cookieAttrs(ctx, STATE_TTL_MS / 1000)}`;
  return { url: u.toString(), cookie };
}

function claimList(payload: JWTPayload, claim: string): string[] {
  const v = (payload as Record<string, unknown>)[claim];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') return [v];
  return [];
}

async function refuse(ctx: Ctx, tenantId: string, code: string, message: string, details: Record<string, unknown> = {}, status = 401): Promise<never> {
  await ctx.db.tx((q) => auditTx(ctx, q, { tenantId, actor: SYSTEM_ACTOR, action: 'SSO_LOGIN_REFUSED', resourceType: 'TENANT', resourceId: tenantId,
    reason: code, details }));
  throw new SsoError(code, message, status);
}

/** Validate the IdP response and prepare a one-time hand-off for the single-page app. Returns the tenant + hand-off id. */
export async function ssoCallback(ctx: Ctx, query: Record<string, unknown>, req: ReqLike, cookieHeader?: string): Promise<{ tenantId: string; handoff: string }> {
  const state = typeof query.state === 'string' ? query.state : '';
  // HARDEN: the browser that started the sign-in must present the signed state cookie for exactly this state.
  const bound = readSsoCookie(ctx, cookieHeader);
  if (!state || !bound || bound.e < Date.now() || bound.s.length !== state.length || !crypto.timingSafeEqual(Buffer.from(bound.s), Buffer.from(state)))
    throw new SsoError('SSO_BROWSER_MISMATCH', 'This sign-in was not started in this browser (or its cookie expired or was blocked); start again');
  const row = (await ctx.db.query<{ tenant_id: string; nonce: string; code_verifier: string; expires_at: Date }>(
    'DELETE FROM oidc_login_states WHERE state=$1 RETURNING tenant_id, nonce, code_verifier, expires_at', [state]))[0];
  if (!row || new Date(row.expires_at) < new Date()) throw new SsoError('SSO_STATE_INVALID', 'The sign-in request expired or was already used; start again');
  if (row.tenant_id !== bound.t || sha(row.nonce) !== bound.n)
    throw new SsoError('SSO_BROWSER_MISMATCH', 'This sign-in was not started in this browser; start again');
  const tenantId = row.tenant_id;
  if (foreignEntity(ctx.config, tenantId)) throw new SsoError('SSO_NOT_CONFIGURED', 'Unknown entity', 404); // dedicated installation
  if (typeof query.error === 'string')
    return refuse(ctx, tenantId, 'SSO_IDP_ERROR', `The identity provider refused the sign-in: ${query.error}${typeof query.error_description === 'string' ? ` — ${query.error_description.slice(0, 300)}` : ''}`, { idpError: query.error });
  const code = typeof query.code === 'string' ? query.code : '';
  if (!code) return refuse(ctx, tenantId, 'SSO_NO_CODE', 'The identity provider did not return an authorization code');
  const o = await enabledConfig(ctx, tenantId);
  const doc = await discover(o.issuer);
  let secret: string | undefined;
  if (o.clientSecretEnv) {
    secret = process.env[o.clientSecretEnv];
    if (!secret) throw new SsoError('SSO_SECRET_MISSING', `The client secret environment variable ${o.clientSecretEnv} is not set on the server`, 503);
  }
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(ctx), client_id: o.clientId, code_verifier: row.code_verifier });
  if (secret) form.set('client_secret', secret);
  let tokenRes: Response;
  try {
    tokenRes = await fetch(doc.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form, signal: AbortSignal.timeout(15_000) });
  } catch (e) { return refuse(ctx, tenantId, 'SSO_TOKEN_EXCHANGE_FAILED', `Token endpoint unreachable: ${(e as Error).message}`, {}, 503); }
  const tokenJson = (await tokenRes.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
  if (!tokenRes.ok) return refuse(ctx, tenantId, 'SSO_TOKEN_EXCHANGE_FAILED', `Token exchange failed (${tokenRes.status}): ${tokenJson.error ?? ''} ${tokenJson.error_description ?? ''}`.trim(), { status: tokenRes.status, error: tokenJson.error });
  if (!tokenJson.id_token) return refuse(ctx, tenantId, 'SSO_NO_ID_TOKEN', 'The identity provider returned no ID token (is the "openid" scope allowed?)');

  let jwks = jwksCache.get(doc.jwks_uri);
  if (!jwks) { jwks = createRemoteJWKSet(new URL(doc.jwks_uri)); jwksCache.set(doc.jwks_uri, jwks); }
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(tokenJson.id_token, jwks, { issuer: doc.issuer, audience: o.clientId, algorithms: ['RS256', 'RS384', 'RS512', 'PS256', 'ES256'], clockTolerance: 60 }));
  } catch (e) {
    if (e instanceof joseErrors.JWTExpired) return refuse(ctx, tenantId, 'SSO_TOKEN_EXPIRED', 'The ID token has expired (check the server clock)');
    if (e instanceof joseErrors.JWTClaimValidationFailed && e.claim === 'aud') return refuse(ctx, tenantId, 'SSO_TOKEN_AUDIENCE', 'The ID token was issued for a different application (audience ≠ client id)');
    if (e instanceof joseErrors.JWTClaimValidationFailed && e.claim === 'iss') return refuse(ctx, tenantId, 'SSO_TOKEN_ISSUER', 'The ID token issuer does not match the configured issuer');
    return refuse(ctx, tenantId, 'SSO_TOKEN_INVALID', `The ID token could not be validated: ${(e as Error).message}`);
  }
  if (payload.nonce !== row.nonce) return refuse(ctx, tenantId, 'SSO_NONCE_MISMATCH', 'The ID token nonce does not match this sign-in (possible replay)');
  if (typeof payload.sub !== 'string' || !payload.sub) return refuse(ctx, tenantId, 'SSO_TOKEN_INVALID', 'The ID token has no subject');

  const claims = payload as Record<string, unknown>;
  if (claims._claim_names && typeof claims._claim_names === 'object' && (claims._claim_names as Record<string, unknown>)[o.groupsClaim])
    return refuse(ctx, tenantId, 'SSO_GROUPS_OVERAGE', 'The user is in too many groups to be listed in the token. In Entra ID emit "Groups assigned to the application" or use app roles (groups claim "roles").');
  const rawUser = claims[o.usernameClaim];
  const username = typeof rawUser === 'string' ? rawUser.trim().toLowerCase() : '';
  if (!/^[a-z0-9._@-]{3,80}$/.test(username)) return refuse(ctx, tenantId, 'SSO_USERNAME_INVALID', `The token claim "${o.usernameClaim}" is missing or not a valid TenderFlow username`);
  const groups = claimList(payload, o.groupsClaim);
  const mapped = [...new Set(o.mappings.filter((m) => groups.some((g) => g.toLowerCase() === m.group.toLowerCase())).flatMap((m) => m.roles))];
  const subject = `${payload.iss}|${payload.sub}`;
  const displayName = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 200) : username;

  const bySubject = (await ctx.db.query<UserRow>('SELECT * FROM users WHERE tenant_id=$1 AND external_subject=$2', [tenantId, subject]))[0];
  const byName = bySubject ? undefined : (await ctx.db.query<UserRow>('SELECT * FROM users WHERE tenant_id=$1 AND username=$2', [tenantId, username]))[0];
  let user = bySubject ?? byName;
  if (user?.vendor_id) return refuse(ctx, tenantId, 'SSO_VENDOR_ACCOUNT', 'Vendor accounts cannot sign in through staff single sign-on', { username });
  if (byName?.external_subject && byName.external_subject !== subject) return refuse(ctx, tenantId, 'SSO_SUBJECT_MISMATCH', 'This username is linked to a different directory identity', { username });

  if (o.provisioning === 'ADMIN_CREATED') {
    if (!user) return refuse(ctx, tenantId, 'SSO_NOT_PROVISIONED', `No TenderFlow account exists for "${username}". An administrator must create it before the first sign-in.`, { username });
    if (!user.external_subject) {
      const u = user;
      user = await ctx.db.tx(async (q) => {
        const r = await q.query<UserRow>(`UPDATE users SET external_subject=$2, auth_source='OIDC' WHERE id=$1 RETURNING *`, [u.id, subject]);
        await auditTx(ctx, q, { tenantId, actor: { id: u.id, roles: u.roles }, action: 'USER_LINKED_TO_DIRECTORY', resourceType: 'USER', resourceId: u.id, details: { username, issuer: payload.iss } });
        return r[0];
      });
    }
  } else {
    if (!mapped.length) return refuse(ctx, tenantId, 'SSO_NO_MAPPED_GROUP', 'Your directory groups are not mapped to any TenderFlow role. Ask the administrator to add your group to the mapping.', { username, groupCount: groups.length });
    if (user) {
      const u = user;
      const changed = [...u.roles].sort().join() !== [...mapped].sort().join();
      user = await ctx.db.tx(async (q) => {
        const r = await q.query<UserRow>(`UPDATE users SET roles=$2::text[], external_subject=$3, auth_source='OIDC' WHERE id=$1 RETURNING *`, [u.id, mapped, subject]);
        if (changed) await auditTx(ctx, q, { tenantId, actor: SYSTEM_ACTOR, action: 'USER_ROLES_SYNCED_FROM_DIRECTORY', resourceType: 'USER', resourceId: u.id,
          prevState: [...u.roles].sort().join(','), newState: [...mapped].sort().join(','), details: { username } });
        return r[0];
      });
    } else {
      const hash = await bcrypt.hash(rand(32), 10); // unusable random password: this account signs in through the directory
      user = await ctx.db.tx(async (q) => {
        const id = uuid();
        const r = await q.query<UserRow>(
          `INSERT INTO users (id, tenant_id, username, password_hash, display_name, roles, vendor_id, created_at, auth_source, external_subject)
           VALUES ($1,$2,$3,$4,$5,$6::text[],NULL,$7,'OIDC',$8) RETURNING *`, [id, tenantId, username, hash, displayName, mapped, now(), subject]);
        await auditTx(ctx, q, { tenantId, actor: SYSTEM_ACTOR, action: 'USER_PROVISIONED_FROM_DIRECTORY', resourceType: 'USER', resourceId: id,
          details: { username, roles: mapped, issuer: payload.iss } });
        return r[0];
      });
    }
  }
  const u = user!;
  if (!u.active) {
    await ctx.db.tx((q) => auditTx(ctx, q, { tenantId, actor: { id: u.id, roles: u.roles }, action: 'LOGIN_REFUSED_ACCOUNT_DISABLED', resourceType: 'USER', resourceId: u.id, details: { method: 'OIDC' } }));
    throw new SsoError('ACCOUNT_DISABLED', 'This account is disabled. Contact your entity administrator.', 403);
  }
  await enforceStaffNetwork(ctx, req, { id: u.id, tenantId, roles: u.roles }, 'LOGIN');
  const handoff = rand(32);
  await ctx.db.query('DELETE FROM oidc_handoffs WHERE expires_at < now()');
  await ctx.db.query('INSERT INTO oidc_handoffs (id_hash, tenant_id, user_id, expires_at) VALUES ($1,$2,$3,$4)',
    [crypto.createHash('sha256').update(handoff).digest('hex'), tenantId, u.id, new Date(Date.now() + 60_000)]);
  return { tenantId, handoff };
}

/** POST /auth/oidc/exchange — trade the one-time hand-off (60 s, single use) for the TenderFlow session. */
export async function ssoExchange(ctx: Ctx, body: any, req: ReqLike) {
  const h = typeof body?.handoff === 'string' ? body.handoff : '';
  const hash = crypto.createHash('sha256').update(h).digest('hex');
  const row = h ? (await ctx.db.query<{ tenant_id: string; user_id: string; expires_at: Date }>(
    'UPDATE oidc_handoffs SET used_at=now() WHERE id_hash=$1 AND used_at IS NULL RETURNING tenant_id, user_id, expires_at', [hash]))[0] : undefined;
  if (!row || new Date(row.expires_at) < new Date()) throw new SsoError('SSO_HANDOFF_INVALID', 'The sign-in hand-off expired or was already used; start again');
  const u = (await ctx.db.query<UserRow>('SELECT * FROM users WHERE id=$1 AND tenant_id=$2', [row.user_id, row.tenant_id]))[0];
  if (!u || !u.active) throw new SsoError('ACCOUNT_DISABLED', 'This account is disabled. Contact your entity administrator.', 403);
  await enforceStaffNetwork(ctx, req, { id: u.id, tenantId: u.tenant_id, roles: u.roles }, 'LOGIN');
  return completeLogin(ctx, u, 'OIDC');
}

/** Admin "test connection": discovery only (no secret is sent). */
export async function testDiscovery(ctx: Ctx, tenantId: string) {
  const o = (await loadSettings(ctx, tenantId, { fresh: true })).oidc;
  if (!o) throw new SsoError('SSO_NOT_CONFIGURED', 'Single sign-on is not configured for this entity', 404);
  const doc = await discover(o.issuer, true);
  return {
    ok: true, issuer: doc.issuer, authorizationEndpoint: doc.authorization_endpoint, tokenEndpoint: doc.token_endpoint, jwksUri: doc.jwks_uri,
    redirectUri: redirectUri(ctx), clientSecretConfigured: !!(o.clientSecretEnv && process.env[o.clientSecretEnv]),
    issuerMatches: doc.issuer.replace(/\/+$/, '') === o.issuer.replace(/\/+$/, ''),
  };
}
