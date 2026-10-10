// Outbound integrations (webhooks). An entity registers endpoints (ERP, finance, document management, Power Automate,
// IBM App Connect …) that receive signed JSON events. Deliveries are queued in the same transaction as the event's
// automation run and sent by the `webhook-deliveries` job with retries (1 min, 5 min, 30 min, 2 h → DEAD).
// Security: https only (http only outside production when LOWCODE_WEBHOOK_ALLOW_HTTP=true); private, loopback and
// link-local addresses are refused at registration and again at send time (SSRF), redirects are not followed, the
// body is signed (HMAC-SHA256 over "<timestamp>.<body>"), and payloads never carry sealed-bid content.
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import type { Ctx } from '../ctx.js';
import { auditTx } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import type { Queryable } from '../db.js';
import { badRequest, conflict, isUuid, notFound, now, str, uuid } from '../util.js';
import { ipInList } from '../auth/cidr.js';
import { TRIGGERS } from './catalog.js';

const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16', '100.64.0.0/10', '0.0.0.0/8',
  '::1/128', 'fc00::/7', 'fe80::/10', '::/128', '::ffff:0:0/96'];
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000];
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
const CODE_RE = /^[a-z][a-z0-9_-]{1,40}$/;

export interface WebhookPolicy { allowHttp: boolean; allowPrivate: boolean; timeoutMs: number }
export function webhookPolicy(env: NodeJS.ProcessEnv = process.env): WebhookPolicy {
  const prod = (env.TF_ENV ?? '').toLowerCase() === 'production';
  const flag = (n: string) => ['true', '1', 'yes'].includes((env[n] ?? '').toLowerCase());
  return { allowHttp: !prod && flag('LOWCODE_WEBHOOK_ALLOW_HTTP'), allowPrivate: !prod && flag('LOWCODE_WEBHOOK_ALLOW_PRIVATE'),
    timeoutMs: Math.max(1000, Math.min(30_000, Number(env.LOWCODE_WEBHOOK_TIMEOUT_MS ?? 8000) || 8000)) };
}

const keyOf = (ctx: Ctx) => crypto.createHash('sha256').update(`tenderflow-webhook-secret:${ctx.config.auditSigningKey}`).digest();
function seal(ctx: Ctx, secret: string, id: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyOf(ctx), iv);
  c.setAAD(Buffer.from(`webhook:${id}`));
  const enc = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return { enc: enc.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') };
}
function unseal(ctx: Ctx, row: { id: string; secret_enc: string; secret_iv: string; secret_tag: string }): string {
  const d = crypto.createDecipheriv('aes-256-gcm', keyOf(ctx), Buffer.from(row.secret_iv, 'base64'));
  d.setAAD(Buffer.from(`webhook:${row.id}`));
  d.setAuthTag(Buffer.from(row.secret_tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(row.secret_enc, 'base64')), d.final()]).toString('utf8');
}
const newSecret = () => `whsec_${crypto.randomBytes(24).toString('base64url')}`;

export function signature(secret: string, ts: number, body: string) {
  return `t=${ts},v1=${crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
}

/** Static URL checks (scheme, no credentials, literal private IPs). DNS checks happen in assertSafeTarget. */
export function checkUrl(raw: unknown, pol: WebhookPolicy): URL {
  const s = str(raw, 'url', { required: true, max: 500 })!;
  let u: URL;
  try { u = new URL(s); } catch { throw badRequest('url must be a full address such as https://erp.example.gov.kw/hooks/tenderflow'); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && pol.allowHttp)) throw badRequest('url must use https');
  if (u.username || u.password) throw badRequest('url must not contain credentials; the request is signed instead');
  if (u.hash) throw badRequest('url must not contain a #fragment');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!pol.allowPrivate && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || (net.isIP(host) && ipInList(host, PRIVATE))))
    throw badRequest('url points to a private or local address');
  return u;
}

async function assertSafeTarget(u: URL, pol: WebhookPolicy) {
  if (pol.allowPrivate) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => ipInList(a.address, PRIVATE))) throw new Error('target resolves to a private or local address');
}

const pubEndpoint = (r: any) => ({ id: r.id, code: r.code, name: r.name, url: r.url, events: r.events, enabled: r.enabled, createdAt: r.created_at, updatedAt: r.updated_at,
  ...(r.stats ? { stats: r.stats } : {}) });

function parseEvents(v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw badRequest('events must be a list of trigger keys');
  const ok = TRIGGERS.filter((t) => t.kind !== 'GATE').map((t) => t.key);
  for (const e of v) if (!ok.includes(e)) throw badRequest(`events: '${String(e)}' is not an event (use ${ok.join(', ')})`);
  return [...new Set(v as string[])];
}

export async function listEndpoints(ctx: Ctx, actor: Actor) {
  const rows = await ctx.db.query<any>(`SELECT e.*, (SELECT json_build_object('sent', count(*) FILTER (WHERE d.status='SENT'), 'failed', count(*) FILTER (WHERE d.status IN ('FAILED','DEAD')),
       'queued', count(*) FILTER (WHERE d.status='QUEUED')) FROM webhook_deliveries d WHERE d.endpoint_id=e.id) AS stats
       FROM webhook_endpoints e WHERE e.tenant_id=$1 ORDER BY e.code`, [actor.tenantId]);
  return rows.map(pubEndpoint);
}

async function loadEndpoint(q: Queryable, tenantId: string, id: string) {
  if (!isUuid(id)) throw notFound('Integration');
  const r = (await q.query<any>('SELECT * FROM webhook_endpoints WHERE id=$1 AND tenant_id=$2', [id, tenantId]))[0];
  if (!r) throw notFound('Integration');
  return r;
}

export async function createEndpoint(ctx: Ctx, actor: Actor, b: any) {
  const pol = webhookPolicy();
  const code = String(b?.code ?? '').trim().toLowerCase();
  if (!CODE_RE.test(code)) throw badRequest('code must be 2-41 lower-case letters, digits, _ or - (starting with a letter)');
  const u = checkUrl(b?.url, pol);
  const id = uuid();
  const secret = newSecret();
  const s = seal(ctx, secret, id);
  return ctx.db.tx(async (q) => {
    if ((await q.query('SELECT 1 FROM webhook_endpoints WHERE tenant_id=$1 AND code=$2', [actor.tenantId, code])).length) throw conflict('CODE_TAKEN', 'An integration with this code exists');
    const rows = await q.query<any>(
      `INSERT INTO webhook_endpoints (id, tenant_id, code, name, url, events, enabled, secret_enc, secret_iv, secret_tag, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::text[],$7,$8,$9,$10,$11,$12,$12) RETURNING *`,
      [id, actor.tenantId, code, str(b?.name, 'name', { required: true, max: 120 }), u.toString(), parseEvents(b?.events), b?.enabled !== false, s.enc, s.iv, s.tag, actor.id, now()]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'WEBHOOK_CREATED', resourceType: 'WEBHOOK', resourceId: id,
      details: { code, host: u.host, events: rows[0].events } });
    return { ...pubEndpoint(rows[0]), secret, secretNote: 'Shown once. Store it in the receiving system to verify X-TenderFlow-Signature.' };
  });
}

export async function updateEndpoint(ctx: Ctx, actor: Actor, id: string, b: any) {
  const pol = webhookPolicy();
  const cur = await loadEndpoint(ctx.db, actor.tenantId, id);
  const url = b?.url !== undefined ? checkUrl(b.url, pol).toString() : cur.url;
  return ctx.db.tx(async (q) => {
    const rows = await q.query<any>(`UPDATE webhook_endpoints SET name=$1, url=$2, events=$3::text[], enabled=$4, updated_at=$5 WHERE id=$6 RETURNING *`,
      [str(b?.name, 'name', { max: 120 }) ?? cur.name, url, b?.events !== undefined ? parseEvents(b.events) : cur.events,
        typeof b?.enabled === 'boolean' ? b.enabled : cur.enabled, now(), id]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'WEBHOOK_UPDATED', resourceType: 'WEBHOOK', resourceId: id,
      details: { code: cur.code, host: new URL(url).host, events: rows[0].events, enabled: rows[0].enabled } });
    return pubEndpoint(rows[0]);
  });
}

export async function rotateSecret(ctx: Ctx, actor: Actor, id: string) {
  const cur = await loadEndpoint(ctx.db, actor.tenantId, id);
  const secret = newSecret();
  const s = seal(ctx, secret, id);
  await ctx.db.tx(async (q) => {
    await q.query('UPDATE webhook_endpoints SET secret_enc=$1, secret_iv=$2, secret_tag=$3, updated_at=$4 WHERE id=$5', [s.enc, s.iv, s.tag, now(), id]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'WEBHOOK_SECRET_ROTATED', resourceType: 'WEBHOOK', resourceId: id, details: { code: cur.code } });
  });
  return { id, code: cur.code, secret, secretNote: 'Shown once. The previous secret no longer verifies.' };
}

/** Queue an event for one endpoint (inside the caller's transaction). */
export async function enqueue(q: Queryable, tenantId: string, endpointId: string, event: string, payload: Record<string, unknown>) {
  const id = uuid();
  await q.query(`INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event, payload, status, next_attempt_at, created_at)
                 VALUES ($1,$2,$3,$4,$5::jsonb,'QUEUED',$6,$6)`, [id, tenantId, endpointId, event, JSON.stringify({ ...payload, deliveryId: id }), now()]);
  return id;
}

export async function sendTest(ctx: Ctx, actor: Actor, id: string) {
  const ep = await loadEndpoint(ctx.db, actor.tenantId, id);
  const did = await ctx.db.tx(async (q) => {
    const did = await enqueue(q, actor.tenantId, id, 'PING', { event: 'PING', entity: actor.tenantId, occurredAt: now().toISOString(), data: { message: 'TenderFlow integration test' } });
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'WEBHOOK_TEST_SENT', resourceType: 'WEBHOOK', resourceId: id, details: { code: ep.code } });
    return did;
  });
  await deliverDue(ctx, { only: did });
  return delivery(ctx, actor, did);
}

export async function delivery(ctx: Ctx, actor: Actor, id: string) {
  const r = (await ctx.db.query<any>('SELECT * FROM webhook_deliveries WHERE id=$1 AND tenant_id=$2', [id, actor.tenantId]))[0];
  if (!r) throw notFound('Delivery');
  return pubDelivery(r);
}
const pubDelivery = (r: any) => ({ id: r.id, endpointId: r.endpoint_id, event: r.event, status: r.status, attempts: r.attempts, nextAttemptAt: r.next_attempt_at,
  lastStatus: r.last_status, lastError: r.last_error, sentAt: r.sent_at, createdAt: r.created_at, payload: r.payload, code: r.code });

export async function listDeliveries(ctx: Ctx, actor: Actor, query: Record<string, unknown>) {
  const ep = typeof query.endpointId === 'string' && isUuid(query.endpointId) ? query.endpointId : null;
  const rows = await ctx.db.query<any>(`SELECT d.*, e.code FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id
     WHERE d.tenant_id=$1 AND ($2::uuid IS NULL OR d.endpoint_id=$2::uuid) ORDER BY d.created_at DESC LIMIT 100`, [actor.tenantId, ep]);
  return rows.map(pubDelivery);
}

export async function retryDelivery(ctx: Ctx, actor: Actor, id: string) {
  const r = (await ctx.db.query<any>('SELECT * FROM webhook_deliveries WHERE id=$1 AND tenant_id=$2', [id, actor.tenantId]))[0];
  if (!r) throw notFound('Delivery');
  if (r.status === 'SENT') throw conflict('INVALID_STATE', 'This delivery was already sent');
  await ctx.db.tx(async (q) => {
    await q.query(`UPDATE webhook_deliveries SET status='QUEUED', next_attempt_at=$1, attempts=0 WHERE id=$2`, [now(), id]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'WEBHOOK_DELIVERY_REQUEUED', resourceType: 'WEBHOOK', resourceId: r.endpoint_id, details: { deliveryId: id } });
  });
  await deliverDue(ctx, { only: id });
  return delivery(ctx, actor, id);
}

/** Send due deliveries (job `webhook-deliveries`). Never throws; each failure is recorded on its row. */
export async function deliverDue(ctx: Ctx, opts: { tenantId?: string; only?: string; limit?: number } = {}) {
  const pol = webhookPolicy();
  const due = await ctx.db.query<any>(
    `SELECT d.*, e.url, e.enabled, e.secret_enc, e.secret_iv, e.secret_tag, e.id AS eid FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id
      WHERE d.status IN ('QUEUED','FAILED') AND d.next_attempt_at <= $1 AND ($2::text IS NULL OR d.tenant_id=$2) AND ($3::uuid IS NULL OR d.id=$3::uuid)
      ORDER BY d.next_attempt_at LIMIT $4`, [now(), opts.tenantId ?? null, opts.only ?? null, opts.limit ?? 50]);
  let sent = 0, failed = 0;
  for (const d of due) {
    if (!d.enabled) {
      await ctx.db.query(`UPDATE webhook_deliveries SET status='DEAD', last_error='integration is switched off' WHERE id=$1`, [d.id]); failed++; continue;
    }
    const body = JSON.stringify(d.payload);
    const ts = Math.floor(Date.now() / 1000);
    let status: number | null = null; let error: string | null = null;
    try {
      const u = new URL(d.url);
      checkUrl(d.url, pol);
      await assertSafeTarget(u, pol);
      const secret = unseal(ctx, { id: d.eid, secret_enc: d.secret_enc, secret_iv: d.secret_iv, secret_tag: d.secret_tag });
      const res = await fetch(u, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(pol.timeoutMs), body,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'TenderFlow-Webhooks/1', 'X-TenderFlow-Event': d.event,
          'X-TenderFlow-Delivery': d.id, 'X-TenderFlow-Signature': signature(secret, ts, body) },
      });
      status = res.status;
      await res.body?.cancel().catch(() => undefined);
      if (status < 200 || status >= 300) error = status >= 300 && status < 400 ? `redirect (${status}) not followed` : `HTTP ${status}`;
    } catch (e) {
      error = ((e as Error).name === 'TimeoutError' ? `no answer within ${pol.timeoutMs} ms` : (e as Error).message).slice(0, 300);
    }
    const attempts = d.attempts + 1;
    if (!error) {
      await ctx.db.query(`UPDATE webhook_deliveries SET status='SENT', attempts=$1, last_status=$2, last_error=NULL, sent_at=$3 WHERE id=$4`, [attempts, status, now(), d.id]);
      sent++;
    } else {
      const dead = attempts >= MAX_ATTEMPTS;
      await ctx.db.query(`UPDATE webhook_deliveries SET status=$1, attempts=$2, last_status=$3, last_error=$4, next_attempt_at=$5 WHERE id=$6`,
        [dead ? 'DEAD' : 'FAILED', attempts, status, error, new Date(now().getTime() + (BACKOFF_MS[attempts - 1] ?? 0)), d.id]);
      failed++;
    }
  }
  return { sent, failed };
}
