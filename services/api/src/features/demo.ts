// Demo Story (presenter mode): persona switching, deadline control, live IBM integration evidence.
// Owned by the demo workstream. Every route answers 404 unless DEMO_MODE=true.
//
// Why there is no in-app "reset": the audit log is append-only and HMAC-chained by design, so the
// application itself can never delete history. To start a demo from a clean seed, stop the server and
// run `npm run demo:reset -- --yes` (deletes DATA_DIR), then start again with SEED_DEMO=true.
import type express from 'express';
import type { RequestHandler } from 'express';
import type { Ctx } from '../ctx.js';
import { auditTx, STAFF_ROLES } from '../ctx.js';
import { actor, h, requireRoles } from '../routes.js';
import { publicUser, type UserRow } from '../services/identity.js';
import { autoClose, type TenderRow } from '../services/tenders.js';
import { ApiError, conflict, isUuid, notFound, now, reqStr } from '../util.js';

const PING_TTL_MS = 30_000;

type Ping = { ok: boolean; detail: string };
interface PingCache { at: number; store: Ping; ai: Ping; pending?: Promise<void> }
const pingCache = new WeakMap<Ctx, PingCache>();

async function integrations(ctx: Ctx) {
  let c = pingCache.get(ctx);
  if (!c || Date.now() - c.at > PING_TTL_MS) {
    if (!c?.pending) {
      const pending = (async () => {
        const [store, ai] = await Promise.all([
          ctx.store.ping().catch((e: Error) => ({ ok: false, detail: e.message })),
          ctx.ai.ping().catch((e: Error) => ({ ok: false, detail: e.message })),
        ]);
        pingCache.set(ctx, { at: Date.now(), store, ai });
      })();
      pingCache.set(ctx, { ...(c ?? { at: 0, store: { ok: false, detail: '' }, ai: { ok: false, detail: '' } }), pending });
    }
    await pingCache.get(ctx)!.pending;
    c = pingCache.get(ctx)!;
  }
  return {
    checkedAt: new Date(c.at).toISOString(),
    contentStore: { type: ctx.store.type, ok: c.store.ok, detail: c.store.detail },
    ai: { configured: ctx.ai.isConfigured(), ok: c.ai.ok, detail: c.ai.detail },
  };
}

/** Audit actions that prove the content store (FileNet) or watsonx Orchestrate did real work. */
const STORE_ACTIONS = ['TENDER_DOCUMENT_UPLOADED', 'ADDENDUM_ISSUED', 'REQUEST_SUBMITTED', 'NOTICE_PUBLISHED', 'BID_SUBMITTED',
  'BID_RESUBMITTED', 'TENDER_OPENED', 'FINANCIAL_ENVELOPES_OPENED', 'AWARD_APPROVED', 'RECORDS_DECLARED', 'VENDOR_DOCUMENT_UPLOADED'];
const AI_ACTIONS = ['AI_ADVISORY_GENERATED', 'AI_ADVISORY_FAILED', 'AI_ADVISORY_REVIEWED'];
const DOC_KEYS = ['documentId', 'recordDocumentId', 'letterDocumentId', 'reportDocumentId'];

interface EvidenceRow {
  seq: string; action: string; actor_id: string; actor_roles: string[]; resource_type: string; resource_id: string | null;
  details: Record<string, any>; at: Date;
}

async function evidence(ctx: Ctx, tenantId: string, integration: unknown, limitRaw: unknown) {
  const limit = Math.min(Math.max(Number(limitRaw) || 20, 1), 100);
  const which = integration === 'filenet' || integration === 'orchestrate' ? integration : null;
  const actions = which === 'filenet' ? STORE_ACTIONS : which === 'orchestrate' ? AI_ACTIONS : [...STORE_ACTIONS, ...AI_ACTIONS];
  // Events of other workstreams that reference a stored document are evidence too (generic match on details keys).
  const rows = await ctx.db.query<EvidenceRow>(
    `SELECT seq::text AS seq, action, actor_id, actor_roles, resource_type, resource_id, details, at FROM audit_events
      WHERE tenant_id=$1 AND (action = ANY($2::text[]) OR ($3::boolean AND (details ? 'storeRef' OR details ?| $4::text[])))
      ORDER BY seq DESC LIMIT $5`,
    [tenantId, actions, which !== 'orchestrate', DOC_KEYS, limit]);

  const docIds = new Set<string>(); const refs = new Set<string>(); const bidIds = new Set<string>(); const runIds = new Set<string>();
  const tenderIds = new Set<string>(); const userIds = new Set<string>();
  for (const r of rows) {
    const d = r.details ?? {};
    for (const k of DOC_KEYS) if (isUuid(d[k])) docIds.add(d[k]);
    if (typeof d.storeRef === 'string') refs.add(d.storeRef);
    if (r.resource_type === 'BID' && isUuid(r.resource_id)) bidIds.add(r.resource_id!);
    if (r.resource_type === 'AI_RUN' && isUuid(r.resource_id)) runIds.add(r.resource_id!);
    if (r.resource_type === 'TENDER' && isUuid(r.resource_id)) tenderIds.add(r.resource_id!);
    if (isUuid(d.tenderId)) tenderIds.add(d.tenderId);
    if (isUuid(r.actor_id)) userIds.add(r.actor_id);
  }
  const docs = docIds.size || refs.size || bidIds.size ? await ctx.db.query<any>(
    `SELECT id, bid_id, owner_type, title, store_type, store_ref, encrypted, version_no, is_record, store_meta FROM documents
      WHERE tenant_id=$1 AND (id = ANY($2::uuid[]) OR store_ref = ANY($3::text[]) OR bid_id = ANY($4::uuid[]))`,
    [tenantId, [...docIds], [...refs], [...bidIds]]) : [];
  const runs = runIds.size ? await ctx.db.query<any>(
    'SELECT id, kind, agent, model, status, error, citations, tender_id FROM ai_runs WHERE tenant_id=$1 AND id = ANY($2::uuid[])', [tenantId, [...runIds]]) : [];
  for (const run of runs) if (run.tender_id) tenderIds.add(run.tender_id);
  const tenders = tenderIds.size ? await ctx.db.query<{ id: string; tender_number: string }>(
    'SELECT id, tender_number FROM tenders WHERE tenant_id=$1 AND id = ANY($2::uuid[])', [tenantId, [...tenderIds]]) : [];
  const users = userIds.size ? await ctx.db.query<{ id: string; username: string }>(
    'SELECT id, username FROM users WHERE tenant_id=$1 AND id = ANY($2::uuid[])', [tenantId, [...userIds]]) : [];
  const tenderNo = new Map(tenders.map((t) => [t.id, t.tender_number]));
  const userName = new Map(users.map((u) => [u.id, u.username]));

  const storeView = (doc: any) => doc && {
    type: doc.store_type as string, ref: doc.store_ref as string, encrypted: Boolean(doc.encrypted), versionNo: doc.version_no ?? 1,
    isRecord: Boolean(doc.is_record), ownerType: doc.owner_type as string,
    // Sealed bid documents: never reveal file titles here.
    title: doc.bid_id ? null : (doc.title as string),
  };

  return rows.map((r) => {
    const d = r.details ?? {};
    const isAi = AI_ACTIONS.includes(r.action);
    const run = isAi ? runs.find((x) => x.id === r.resource_id) : undefined;
    const tenderId: string | null = isUuid(d.tenderId) ? d.tenderId : r.resource_type === 'TENDER' ? r.resource_id : run?.tender_id ?? null;
    const base = {
      seq: Number(r.seq), at: r.at, action: r.action, integration: isAi ? 'orchestrate' : 'filenet', resourceType: r.resource_type,
      resourceId: r.resource_id, actor: userName.get(r.actor_id) ?? r.actor_id, tenderId, tenderNumber: tenderId ? tenderNo.get(tenderId) ?? null : null,
    };
    if (isAi) {
      return { ...base, ai: run ? { kind: run.kind, agent: run.agent ?? null, model: run.model ?? null, status: run.status,
        citations: Array.isArray(run.citations) ? run.citations.length : 0, error: run.error ? String(run.error).slice(0, 300) : null } : null };
    }
    const ids = DOC_KEYS.map((k) => d[k]).filter(isUuid);
    let docRows = docs.filter((x) => ids.includes(x.id) || (d.storeRef && x.store_ref === d.storeRef));
    if (r.resource_type === 'BID') docRows = docs.filter((x) => x.bid_id === r.resource_id);
    const stored = docRows.map(storeView);
    return {
      ...base,
      store: r.action === 'RECORDS_DECLARED'
        ? { type: ctx.store.type, declared: d.documents ?? null, repositoryDeclared: d.repositoryDeclared ?? null, repositoryFailed: d.repositoryFailed ?? null }
        : stored[0] ?? (d.storeRef ? { type: null, ref: d.storeRef } : null),
      documents: stored.length > 1 ? stored : undefined,
    };
  });
}

export function registerDemoRoutes(r: express.Router, ctx: Ctx): void {
  const demoOnly: RequestHandler = (_req, _res, next) =>
    ctx.config.demoMode ? next() : next(new ApiError(404, 'NOT_FOUND', 'No such API route'));
  if (ctx.config.demoMode) console.warn('[demo] DEMO_MODE=true: presenter controls (persona switch, deadline advance) are ENABLED. Never use in production.');

  r.get('/demo/status', demoOnly, h(async (req) => {
    const a = actor(req);
    const rows = await ctx.db.query<{ username: string; display_name: string; roles: string[]; vendor_status: string | null }>(
      `SELECT u.username, u.display_name, u.roles, v.status AS vendor_status FROM users u LEFT JOIN vendors v ON v.id = u.vendor_id
        WHERE u.tenant_id=$1 AND u.active ORDER BY u.username`, [a.tenantId]);
    return {
      enabled: true, tenantId: a.tenantId, me: a.username,
      personas: rows.map((u) => ({ username: u.username, displayName: u.display_name, roles: u.roles, vendorStatus: u.vendor_status })),
      integrations: await integrations(ctx),
      resetCommand: 'npm run demo:reset -- --yes',
    };
  }));

  r.post('/demo/persona', demoOnly, h(async (req) => {
    const a = actor(req);
    const username = reqStr(req.body?.username, 'username', 80).toLowerCase();
    const rows = await ctx.db.query<UserRow>('SELECT * FROM users WHERE tenant_id=$1 AND username=$2 AND active', [a.tenantId, username]);
    const u = rows[0];
    if (!u) throw notFound('Active user in this entity');
    const token = await ctx.tokens.issue(u);
    await ctx.db.tx((q) => auditTx(ctx, q, { tenantId: a.tenantId, actor: { id: a.id, roles: a.roles }, action: 'DEMO_PERSONA_SWITCH',
      resourceType: 'USER', resourceId: u.id, details: { from: a.username, to: u.username, demoMode: true } }));
    return { token, user: publicUser(u) };
  }));

  r.post('/demo/tenders/:id/expire-deadline', demoOnly, requireRoles(...STAFF_ROLES), h(async (req) => {
    const a = actor(req);
    const id = req.params.id;
    if (!isUuid(id)) throw notFound('Tender');
    const updated = await ctx.db.tx(async (q) => {
      const t = (await q.query<TenderRow>('SELECT * FROM tenders WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [id, a.tenantId]))[0];
      if (!t) throw notFound('Tender');
      if (t.status !== 'PUBLISHED') throw conflict('INVALID_STATE', `Only a PUBLISHED tender can have its deadline advanced (status is ${t.status})`);
      const original = new Date(t.submission_deadline).toISOString();
      const deadline = new Date(now().getTime() - 1000);
      const rows = await q.query<TenderRow>('UPDATE tenders SET submission_deadline=$1, updated_at=$2 WHERE id=$3 RETURNING *', [deadline, now(), id]);
      await auditTx(ctx, q, { tenantId: a.tenantId, actor: { id: a.id, roles: a.roles }, action: 'DEMO_DEADLINE_ADVANCED', resourceType: 'TENDER',
        resourceId: id, reason: 'Demo control: submission deadline advanced to now',
        details: { tenderNumber: t.tender_number, originalDeadline: original, newDeadline: deadline.toISOString(), demoMode: true } });
      return { row: rows[0], original };
    });
    // The real close path (same as the interval job): PUBLISHED → CLOSED by SYSTEM, audited TENDER_CLOSED.
    const closed = await autoClose(ctx, updated.row);
    return { tenderId: id, tenderNumber: closed.tender_number, status: closed.status, originalDeadline: updated.original,
      submissionDeadline: closed.submission_deadline, closedAt: closed.closed_at };
  }));

  r.get('/demo/evidence', demoOnly, requireRoles(...STAFF_ROLES),
    h((req) => evidence(ctx, actor(req).tenantId, req.query.integration, req.query.limit)));
}
