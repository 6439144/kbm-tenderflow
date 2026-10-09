// Per-entity security policy (table security_settings): MFA policy, staff network allowlist, content protection
// and the staff single-sign-on (OIDC) configuration. Read through a short cache because the network check runs on
// every staff request; every save is audited and clears the cache.
import type { Ctx } from '../../ctx.js';
import type { Queryable } from '../../db.js';
import { STAFF_ROLES } from '../../ctx.js';
import { parseCidr } from '../../auth/cidr.js';
import { badRequest, str } from '../../util.js';

export type MfaPolicy = 'OFF' | 'OPTIONAL' | 'REQUIRED';
export type ContentMode = 'OFF' | 'VIEW_ONLY' | 'WATERMARKED_DOWNLOAD';
export const MFA_POLICIES: MfaPolicy[] = ['OFF', 'OPTIONAL', 'REQUIRED'];
export const CONTENT_MODES: ContentMode[] = ['OFF', 'VIEW_ONLY', 'WATERMARKED_DOWNLOAD'];

/**
 * SEC-003 "reachable only from premises" is still open at MOI. The allowlist enforces source IP ranges; `basis`
 * records which reading the entity configured them for (premises egress ranges, the VPN address pool, or both).
 * Managed-device checks need device certificates / MDM and are NOT implemented by an IP allowlist.
 */
export type NetworkBasis = 'PREMISES_NETWORK' | 'VPN_ADDRESS_POOL' | 'PREMISES_AND_VPN';
export interface StaffNetwork { mode: 'OFF' | 'ALLOWLIST'; cidrs: string[]; trustProxyHeader: boolean; basis: NetworkBasis }

export interface OidcMapping { group: string; roles: string[] }
export interface OidcConfig {
  enabled: boolean;
  displayNameEn: string;
  displayNameAr: string;
  issuer: string;
  clientId: string;
  /** Name of the environment variable holding the client secret (must start with TF_OIDC_SECRET_). Never the secret. */
  clientSecretEnv: string;
  scopes: string;
  groupsClaim: string;
  usernameClaim: string;
  mappings: OidcMapping[];
  provisioning: 'JIT_FROM_GROUPS' | 'ADMIN_CREATED';
}

export interface SecuritySettings {
  mfaVendors: MfaPolicy;
  mfaStaff: MfaPolicy;
  staffNetwork: StaffNetwork;
  /** null = not set here (the entity profile / template may set it; default OFF). */
  contentProtection: ContentMode | null;
  oidc: OidcConfig | null;
  updatedAt: Date | null;
  updatedBy: string | null;
}

export const DEFAULT_NETWORK: StaffNetwork = { mode: 'OFF', cidrs: [], trustProxyHeader: false, basis: 'PREMISES_NETWORK' };
const DEFAULTS: SecuritySettings = { mfaVendors: 'OFF', mfaStaff: 'OFF', staffNetwork: DEFAULT_NETWORK, contentProtection: null, oidc: null, updatedAt: null, updatedBy: null };

const CACHE_MS = 5_000;
const cache = new WeakMap<object, Map<string, { at: number; s: SecuritySettings }>>();

export function clearSettingsCache(ctx: Ctx) { cache.delete(ctx.db); }

function rowToSettings(r: any): SecuritySettings {
  if (!r) return { ...DEFAULTS };
  const net = r.staff_network ?? {};
  return {
    mfaVendors: MFA_POLICIES.includes(r.mfa_vendors) ? r.mfa_vendors : 'OFF',
    mfaStaff: MFA_POLICIES.includes(r.mfa_staff) ? r.mfa_staff : 'OFF',
    staffNetwork: {
      mode: net.mode === 'ALLOWLIST' ? 'ALLOWLIST' : 'OFF',
      cidrs: Array.isArray(net.cidrs) ? net.cidrs.filter((x: unknown) => typeof x === 'string') : [],
      trustProxyHeader: net.trustProxyHeader === true,
      basis: ['PREMISES_NETWORK', 'VPN_ADDRESS_POOL', 'PREMISES_AND_VPN'].includes(net.basis) ? net.basis : 'PREMISES_NETWORK',
    },
    contentProtection: CONTENT_MODES.includes(r.content_protection) ? r.content_protection : null,
    oidc: r.oidc ?? null,
    updatedAt: r.updated_at ?? null,
    updatedBy: r.updated_by ?? null,
  };
}

export async function loadSettings(ctx: Ctx | { db: Queryable }, tenantId: string, opts: { fresh?: boolean } = {}): Promise<SecuritySettings> {
  const key = (ctx as Ctx).db as object;
  let m = cache.get(key);
  if (!m) { m = new Map(); cache.set(key, m); }
  const hit = m.get(tenantId);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.s;
  const rows = await (ctx as { db: Queryable }).db.query<any>('SELECT * FROM security_settings WHERE tenant_id=$1', [tenantId]);
  const s = rowToSettings(rows[0]);
  m.set(tenantId, { at: Date.now(), s });
  return s;
}

export async function saveSettingsRow(q: Queryable, tenantId: string, s: Omit<SecuritySettings, 'updatedAt' | 'updatedBy'>, by: string) {
  await q.query(
    `INSERT INTO security_settings (tenant_id, mfa_vendors, mfa_staff, staff_network, content_protection, oidc, updated_by, updated_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,now())
     ON CONFLICT (tenant_id) DO UPDATE SET mfa_vendors=EXCLUDED.mfa_vendors, mfa_staff=EXCLUDED.mfa_staff,
       staff_network=EXCLUDED.staff_network, content_protection=EXCLUDED.content_protection, oidc=EXCLUDED.oidc,
       updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [tenantId, s.mfaVendors, s.mfaStaff, JSON.stringify(s.staffNetwork), s.contentProtection, s.oidc ? JSON.stringify(s.oidc) : null, by]);
}

// ---------------- validation ----------------
export function parseMfaPolicy(v: unknown, field: string): MfaPolicy {
  if (!MFA_POLICIES.includes(v as MfaPolicy)) throw badRequest(`${field} must be one of ${MFA_POLICIES.join(', ')}`);
  return v as MfaPolicy;
}

export function parseStaffNetwork(v: any): StaffNetwork {
  if (!v || typeof v !== 'object') throw badRequest('staffNetwork must be an object');
  const mode = v.mode === 'ALLOWLIST' ? 'ALLOWLIST' : v.mode === 'OFF' || v.mode === undefined ? 'OFF' : null;
  if (!mode) throw badRequest("staffNetwork.mode must be 'OFF' or 'ALLOWLIST'");
  const raw: unknown[] = Array.isArray(v.cidrs) ? v.cidrs : typeof v.cidrs === 'string' ? v.cidrs.split(/[\s,;]+/) : [];
  const cidrs: string[] = [];
  for (const c of raw) {
    if (typeof c !== 'string' || !c.trim()) continue;
    try { cidrs.push(parseCidr(c).text); } catch (e) { throw badRequest(`staffNetwork.cidrs: ${(e as Error).message}`); }
  }
  if (cidrs.length > 200) throw badRequest('staffNetwork.cidrs allows at most 200 entries');
  if (mode === 'ALLOWLIST' && cidrs.length === 0) throw badRequest('An allowlist needs at least one IP range (CIDR)');
  const basis = v.basis ?? 'PREMISES_NETWORK';
  if (!['PREMISES_NETWORK', 'VPN_ADDRESS_POOL', 'PREMISES_AND_VPN'].includes(basis)) throw badRequest('staffNetwork.basis must be PREMISES_NETWORK, VPN_ADDRESS_POOL or PREMISES_AND_VPN');
  return { mode, cidrs: [...new Set(cidrs)], trustProxyHeader: v.trustProxyHeader === true, basis };
}

export function parseContentMode(v: unknown): ContentMode | null {
  if (v === null || v === undefined || v === '') return null;
  if (!CONTENT_MODES.includes(v as ContentMode)) throw badRequest(`contentProtection must be one of ${CONTENT_MODES.join(', ')} or null`);
  return v as ContentMode;
}

const SSO_ROLES = STAFF_ROLES;

export function parseOidc(v: any, opts: { allowHttp: boolean }): OidcConfig | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') throw badRequest('oidc must be an object or null');
  const issuer = str(v.issuer, 'oidc.issuer', { required: true, max: 500 })!.replace(/\/+$/, '');
  let u: URL;
  try { u = new URL(issuer); } catch { throw badRequest('oidc.issuer must be a URL'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (local || opts.allowHttp)))
    throw badRequest('oidc.issuer must use https (plain http only for localhost test providers)');
  const clientSecretEnv = str(v.clientSecretEnv, 'oidc.clientSecretEnv', { max: 80 }) ?? '';
  if (clientSecretEnv && !/^TF_OIDC_SECRET_[A-Z0-9_]{1,60}$/.test(clientSecretEnv))
    throw badRequest('oidc.clientSecretEnv must be the NAME of an environment variable starting with TF_OIDC_SECRET_ (the secret itself is never stored)');
  const provisioning = v.provisioning ?? 'ADMIN_CREATED';
  if (provisioning !== 'JIT_FROM_GROUPS' && provisioning !== 'ADMIN_CREATED') throw badRequest("oidc.provisioning must be 'JIT_FROM_GROUPS' or 'ADMIN_CREATED'");
  const mappings: OidcMapping[] = (Array.isArray(v.mappings) ? v.mappings : []).map((m: any, i: number) => {
    const group = str(m?.group, `oidc.mappings[${i}].group`, { required: true, max: 300 })!;
    const roles = Array.isArray(m?.roles) ? m.roles : [];
    if (!roles.length || roles.some((r: unknown) => typeof r !== 'string' || !SSO_ROLES.includes(r)))
      throw badRequest(`oidc.mappings[${i}].roles must be a non-empty subset of ${SSO_ROLES.join(', ')} (vendors never sign in through staff SSO)`);
    return { group, roles: [...new Set(roles as string[])] };
  });
  if (mappings.length > 100) throw badRequest('oidc.mappings allows at most 100 rows');
  const scopes = str(v.scopes, 'oidc.scopes', { max: 300 }) ?? 'openid profile email';
  if (!/^[\w.:/-]+( [\w.:/-]+)*$/.test(scopes) || !scopes.split(' ').includes('openid')) throw badRequest("oidc.scopes must be space-separated and include 'openid'");
  const claim = (x: unknown, f: string, d: string) => {
    const s = str(x, f, { max: 100 }) ?? d;
    if (!/^[\w:./-]+$/.test(s)) throw badRequest(`${f} must be a claim name`);
    return s;
  };
  return {
    enabled: v.enabled === true,
    displayNameEn: str(v.displayNameEn, 'oidc.displayNameEn', { max: 120 }) ?? 'Active Directory',
    displayNameAr: str(v.displayNameAr, 'oidc.displayNameAr', { max: 120 }) ?? 'الدليل النشط',
    issuer,
    clientId: str(v.clientId, 'oidc.clientId', { required: true, max: 300 })!,
    clientSecretEnv,
    scopes,
    groupsClaim: claim(v.groupsClaim, 'oidc.groupsClaim', 'groups'),
    usernameClaim: claim(v.usernameClaim, 'oidc.usernameClaim', 'preferred_username'),
    mappings,
    provisioning,
  };
}

/** Admin view: never includes a secret (only the env variable name and whether it is set). */
export function publicSettings(s: SecuritySettings) {
  return {
    ...s,
    oidc: s.oidc ? { ...s.oidc, clientSecretConfigured: !!(s.oidc.clientSecretEnv && process.env[s.oidc.clientSecretEnv]) } : null,
  };
}
