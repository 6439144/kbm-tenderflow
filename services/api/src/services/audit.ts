// Append-only, HMAC-SHA256 chained audit log (one chain per tenant).
import crypto from 'node:crypto';
import type { Db, Queryable } from '../db.js';
import { canonicalJson, now, uuid } from '../util.js';

export interface AuditActor { id: string; roles: string[] }
export const SYSTEM_ACTOR: AuditActor = { id: 'SYSTEM', roles: ['SYSTEM'] };

export interface AuditInput {
  tenantId: string;
  actor: AuditActor;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  prevState?: string | null;
  newState?: string | null;
  reason?: string | null;
  details?: Record<string, unknown>;
}

interface AuditRow {
  seq: string | number; id: string; tenant_id: string; actor_id: string; actor_roles: string[]; action: string;
  resource_type: string; resource_id: string | null; prev_state: string | null; new_state: string | null;
  reason: string | null; details: Record<string, unknown>; at: Date; prev_hmac: string | null; hmac: string;
}

function payloadOf(r: {
  id: string; tenantId: string; actorId: string; actorRoles: string[]; action: string; resourceType: string;
  resourceId: string | null; prevState: string | null; newState: string | null; reason: string | null;
  details: Record<string, unknown>; at: Date;
}) {
  return canonicalJson(r);
}
const mac = (key: string, prev: string | null, payload: string) =>
  crypto.createHmac('sha256', key).update(`${prev ?? ''}|${payload}`).digest('hex');

/** Append an event. Must be called inside a transaction (`db.tx`) so the chain read+write is atomic. */
export async function appendAudit(q: Queryable, key: string, e: AuditInput): Promise<void> {
  await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`audit:${e.tenantId}`]);
  const last = await q.query<{ hmac: string }>(
    'SELECT hmac FROM audit_events WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1', [e.tenantId]);
  const prev = last[0]?.hmac ?? null;
  const rec = {
    id: uuid(), tenantId: e.tenantId, actorId: e.actor.id, actorRoles: e.actor.roles ?? [], action: e.action,
    resourceType: e.resourceType, resourceId: e.resourceId ?? null, prevState: e.prevState ?? null,
    newState: e.newState ?? null, reason: e.reason ?? null,
    // round-trip through JSON so what we MAC is exactly what jsonb will give back
    details: JSON.parse(JSON.stringify(e.details ?? {})), at: now(),
  };
  const hmac = mac(key, prev, payloadOf(rec));
  await q.query(
    `INSERT INTO audit_events (id, tenant_id, actor_id, actor_roles, action, resource_type, resource_id, prev_state,
       new_state, reason, details, at, prev_hmac, hmac)
     VALUES ($1,$2,$3,$4::text[],$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)`,
    [rec.id, rec.tenantId, rec.actorId, rec.actorRoles, rec.action, rec.resourceType, rec.resourceId, rec.prevState,
      rec.newState, rec.reason, JSON.stringify(rec.details), rec.at, prev, hmac]);
}

export async function audit(db: Db, key: string, e: AuditInput): Promise<void> {
  await db.tx((q) => appendAudit(q, key, e));
}

export async function verifyAudit(db: Db, key: string, tenantId: string):
  Promise<{ valid: boolean; count: number; brokenAt?: number; reason?: string }> {
  const rows = await db.query<AuditRow>(
    `SELECT seq::text AS seq, id, tenant_id, actor_id, actor_roles, action, resource_type, resource_id, prev_state,
            new_state, reason, details, at, prev_hmac, hmac
       FROM audit_events WHERE tenant_id = $1 ORDER BY audit_events.seq ASC`, [tenantId]);
  let prev: string | null = null;
  for (const r of rows) {
    const seq = Number(r.seq);
    if ((r.prev_hmac ?? null) !== prev) return { valid: false, count: rows.length, brokenAt: seq, reason: 'prev_hmac does not link to previous event' };
    const expected = mac(key, prev, payloadOf({
      id: r.id, tenantId: r.tenant_id, actorId: r.actor_id, actorRoles: r.actor_roles ?? [], action: r.action,
      resourceType: r.resource_type, resourceId: r.resource_id, prevState: r.prev_state, newState: r.new_state,
      reason: r.reason, details: r.details ?? {}, at: new Date(r.at),
    }));
    if (expected !== r.hmac) return { valid: false, count: rows.length, brokenAt: seq, reason: 'hmac mismatch (event content altered)' };
    prev = r.hmac;
  }
  return { valid: true, count: rows.length };
}
