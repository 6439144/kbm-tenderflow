// TenderFlow token service: RS256 JWTs signed with a key from JWT_PRIVATE_KEY_PEM or generated once
// and persisted in `signing_keys`. Verifies own tokens and (optionally) an external OIDC issuer.
import crypto from 'node:crypto';
import { SignJWT, jwtVerify, decodeJwt, createRemoteJWKSet, calculateJwkThumbprint, type JWK, type JWTPayload } from 'jose';
import type { Db } from '../db.js';
import type { Config } from '../config.js';
import { ApiError } from '../util.js';

export const AUDIENCE = 'tenderflow';
export const ROLES = ['VENDOR', 'PROCUREMENT_OFFICER', 'DIRECTOR', 'COMMITTEE_CHAIR', 'EVALUATOR', 'TENANT_ADMIN', 'AUDITOR'] as const;
export type Role = (typeof ROLES)[number];

export interface Actor {
  id: string;
  tenantId: string;
  roles: string[];
  vendorId: string | null;
  username: string;
  issuer: 'local' | 'external';
}

export const unauthorized = (msg = 'Authentication required') => new ApiError(401, 'UNAUTHORIZED', msg);

export class TokenService {
  private externalJwks?: ReturnType<typeof createRemoteJWKSet>;
  private constructor(
    private config: Config,
    private privateKey: crypto.KeyObject,
    private publicKey: crypto.KeyObject,
    public readonly publicJwk: JWK,
  ) {}

  static async init(db: Db, config: Config): Promise<TokenService> {
    let privateKey: crypto.KeyObject;
    if (config.jwtPrivateKeyPem) {
      privateKey = crypto.createPrivateKey(config.jwtPrivateKeyPem);
    } else {
      const rows = await db.query<{ private_pem: string }>('SELECT private_pem FROM signing_keys ORDER BY created_at DESC LIMIT 1');
      if (rows[0]) privateKey = crypto.createPrivateKey(rows[0].private_pem);
      else {
        privateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
        const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
        const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' }) as JWK;
        const kid = await calculateJwkThumbprint(jwk);
        await db.query('INSERT INTO signing_keys (kid, private_pem, public_jwk) VALUES ($1,$2,$3::jsonb)',
          [kid, pem, JSON.stringify({ ...jwk, kid, alg: 'RS256', use: 'sig' })]);
      }
    }
    if (privateKey.asymmetricKeyType !== 'rsa') throw new Error('JWT signing key must be an RSA private key');
    const publicKey = crypto.createPublicKey(privateKey);
    const jwk = publicKey.export({ format: 'jwk' }) as JWK;
    const kid = await calculateJwkThumbprint(jwk);
    const svc = new TokenService(config, privateKey, publicKey, { ...jwk, kid, alg: 'RS256', use: 'sig' });
    if (config.externalOidcIssuer) svc.externalJwks = createRemoteJWKSet(new URL(await discoverJwksUri(config.externalOidcIssuer)));
    return svc;
  }

  jwks() { return { keys: [this.publicJwk] }; }

  async issue(u: { id: string; tenant_id: string; roles: string[]; vendor_id: string | null; username: string }): Promise<string> {
    return new SignJWT({ tenant_id: u.tenant_id, roles: u.roles, vendor_id: u.vendor_id, preferred_username: u.username })
      .setProtectedHeader({ alg: 'RS256', kid: this.publicJwk.kid!, typ: 'JWT' })
      .setSubject(u.id)
      .setIssuer(this.config.publicBaseUrl)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('8h')
      .sign(this.privateKey);
  }

  async verify(token: string): Promise<Actor> {
    let iss: string | undefined;
    try { iss = decodeJwt(token).iss; } catch { throw unauthorized('Malformed token'); }
    let payload: JWTPayload;
    let issuer: Actor['issuer'];
    try {
      if (iss === this.config.publicBaseUrl) {
        ({ payload } = await jwtVerify(token, this.publicKey, { algorithms: ['RS256'], issuer: iss, audience: AUDIENCE }));
        issuer = 'local';
      } else if (this.externalJwks && iss === this.config.externalOidcIssuer) {
        ({ payload } = await jwtVerify(token, this.externalJwks, {
          algorithms: ['RS256'], issuer: iss, audience: this.config.externalOidcAudience,
        }));
        issuer = 'external';
      } else throw unauthorized('Untrusted token issuer');
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw unauthorized('Invalid token');
    }
    const tenantId = payload.tenant_id;
    if (typeof tenantId !== 'string' || !tenantId) throw unauthorized('Token has no tenant_id claim');
    if (typeof payload.sub !== 'string' || !payload.sub) throw unauthorized('Token has no subject');
    const rawRoles = Array.isArray(payload.roles) ? payload.roles
      : Array.isArray((payload as any).realm_access?.roles) ? (payload as any).realm_access.roles : [];
    const roles = rawRoles.filter((r: unknown): r is string => typeof r === 'string' && (ROLES as readonly string[]).includes(r));
    return {
      id: payload.sub,
      tenantId,
      roles,
      vendorId: typeof payload.vendor_id === 'string' ? payload.vendor_id : null,
      username: typeof payload.preferred_username === 'string' ? payload.preferred_username : payload.sub,
      issuer,
    };
  }
}

async function discoverJwksUri(issuer: string): Promise<string> {
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`External OIDC discovery failed (${res.status}) at ${url}`);
  const doc = (await res.json()) as { jwks_uri?: string };
  if (!doc.jwks_uri) throw new Error(`External OIDC discovery at ${url} has no jwks_uri`);
  return doc.jwks_uri;
}
