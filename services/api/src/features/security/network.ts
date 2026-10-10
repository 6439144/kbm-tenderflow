// Staff network allowlist ("premises restriction", MOI SEC-003): staff tokens and staff sign-in are accepted only
// from configured IP ranges. Vendors are never affected. Refusals → 403 OUTSIDE_PREMISES, audited at most once per
// minute per user and address.
import type { Request } from 'express';
import type { Ctx } from '../../ctx.js';
import { auditTx, STAFF_ROLES } from '../../ctx.js';
import { ipInList, parseIp, formatIp } from '../../auth/cidr.js';
import { ApiError } from '../../util.js';
import { loadSettings, type StaffNetwork } from './settings.js';

export interface ReqLike { ip?: string; socket?: { remoteAddress?: string } }

/** Caller address: the TCP peer, or — only when the entity trusts its reverse proxy — the address it forwarded. */
export function clientIp(req: ReqLike, net: Pick<StaffNetwork, 'trustProxyHeader'>): string {
  // req.ip honours X-Forwarded-For only when the server sets TRUST_PROXY (app 'trust proxy', e.g. 1 hop behind the
  // OpenShift router: the right-most entry, the one our proxy appended). With TRUST_PROXY off (default) req.ip is the
  // TCP peer, so the header cannot be spoofed whatever the entity setting says.
  const raw = net.trustProxyHeader ? (req.ip ?? req.socket?.remoteAddress ?? '') : (req.socket?.remoteAddress ?? req.ip ?? '');
  const p = parseIp(raw);
  return p ? formatIp(p) : raw;
}

export const hasStaffRole = (roles: string[]) => roles.some((r) => STAFF_ROLES.includes(r));

const lastAudit = new Map<string, number>();
const AUDIT_EVERY_MS = 60_000;

export function outsidePremises(ip: string, net: StaffNetwork) {
  return new ApiError(403, 'OUTSIDE_PREMISES',
    'Staff access to this system is only allowed from the entity\'s approved network (premises / VPN).', { ip, basis: net.basis });
}

/** Throws OUTSIDE_PREMISES when the actor has a staff role and the entity allowlist does not contain the caller. */
export async function enforceStaffNetwork(ctx: Ctx, req: ReqLike, who: { id: string; tenantId: string; roles: string[] }, phase: 'REQUEST' | 'LOGIN' = 'REQUEST') {
  if (ctx.config.staffNetworkBreakGlass || !hasStaffRole(who.roles)) return;
  const s = await loadSettings(ctx, who.tenantId);
  const net = s.staffNetwork;
  if (net.mode !== 'ALLOWLIST') return;
  const ip = clientIp(req, net);
  if (ipInList(ip, net.cidrs)) return;
  const key = `${who.tenantId}|${who.id}|${ip}|${phase}`;
  const t = Date.now();
  if ((lastAudit.get(key) ?? 0) + AUDIT_EVERY_MS < t) {
    lastAudit.set(key, t);
    if (lastAudit.size > 5000) for (const [k, v] of lastAudit) if (v + AUDIT_EVERY_MS < t) lastAudit.delete(k);
    await ctx.db.tx((q) => auditTx(ctx, q, { tenantId: who.tenantId, actor: { id: who.id, roles: who.roles }, action: 'STAFF_ACCESS_OUTSIDE_PREMISES',
      resourceType: 'USER', resourceId: who.id, details: { ip, phase, basis: net.basis, rateLimited: 'one event per user, address and minute' } }));
  }
  throw outsidePremises(ip, net);
}

/** What the admin page shows: the caller's address as the server sees it, and whether the allowlist contains it. */
export async function networkStatus(ctx: Ctx, req: Request, tenantId: string, candidate?: StaffNetwork) {
  const s = await loadSettings(ctx, tenantId, { fresh: true });
  const net = candidate ?? s.staffNetwork;
  const ip = clientIp(req, net);
  return {
    ip,
    socketAddress: req.socket.remoteAddress ?? null,
    forwardedFor: typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'] : null,
    mode: net.mode,
    basis: net.basis,
    trustProxyHeader: net.trustProxyHeader,
    serverTrustProxy: ctx.config.trustProxy !== false, // HARDEN: TRUST_PROXY; without it the proxy header is never used
    inside: net.mode !== 'ALLOWLIST' || ipInList(ip, net.cidrs),
    insideList: ipInList(ip, net.cidrs),
    breakGlass: ctx.config.staffNetworkBreakGlass,
  };
}
