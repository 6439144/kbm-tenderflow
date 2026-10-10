// FileNet document security (FILENET_ACL_MODE=groups): sealed envelopes move from SEALED to COMMITTEE access in the
// repository when the chair opens them (BIDS_OPENED / FINANCIAL_OPENED on the document-events bus). Every change is
// requested, written, read back and audited; a failure is recorded on the document (store_meta.acl) and retried by the
// scheduler job `filenet-access-retry`. TenderFlow's own access rules still decide every read through the API — the
// repository ACL is defence in depth for people who open FileNet directly (Navigator / ACCE).
import type express from 'express';
import type { Ctx } from '../ctx.js';
import { auditTx, isStaff } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import type { DocumentRow } from '../services/documents.js';
import { onDocumentEvent } from '../services/document-events.js';
import { registerJob } from '../services/scheduler.js';
import { SYSTEM_ACTOR } from '../services/audit.js';
import { financialSealed, type BidRow } from '../services/bids.js';
import type { TenderRow } from '../services/tenders.js';
import type { ContentStore } from '../content/types.js';
import { FileNetStore } from '../content/filenet-store.js';
import { confidentialityFor, type Confidentiality } from '../content/filenet-model.js';

export const ACCESS_RETRY_JOB = 'filenet-access-retry';
export const ACCESS_MAX_ATTEMPTS = 10;
const RETRYABLE = ['PENDING', 'FAILED', 'UNVERIFIED'];

/** The FileNet store behind the telemetry wrapper, or null for another store. */
export function fileNetStoreOf(ctx: { store: ContentStore }): FileNetStore | null {
  const s = ctx.store.unwrap ? ctx.store.unwrap() : ctx.store;
  return s instanceof FileNetStore ? s : null;
}

export function registerFileNetAccess(_r: express.Router, ctx: Ctx): void {
  onDocumentEvent(ctx, async (c, e) => {
    if (e.type === 'BIDS_OPENED' || e.type === 'FINANCIAL_OPENED') await onEnvelopesOpened(c, e.actor, e.tenantId, e.tenderId, e.type);
  });
  const every = Number(process.env.FILENET_ACCESS_RETRY_MS ?? 5 * 60_000);
  registerJob(ACCESS_RETRY_JOB, Number.isFinite(every) && every >= 1000 ? every : 5 * 60_000, (c, o) => retryAccess(c, o.tenantId), {
    labelEn: 'FileNet security: re-apply document permission lists that failed (FILENET_ACL_MODE=groups)',
    labelAr: 'أمان FileNet: إعادة تطبيق قوائم صلاحيات المستندات التي فشلت (FILENET_ACL_MODE=groups)',
  });
}

type AclMeta = {
  mode?: string; level?: Confidentiality; appliedLevel?: Confidentiality | null; status?: string; attempts?: number; error?: string;
  grantees?: { name: string; access: string }[]; at?: string; reason?: string; readBack?: number;
};
const aclOf = (d: { store_meta?: any }): AclMeta | null => (d.store_meta?.acl && typeof d.store_meta.acl === 'object' ? d.store_meta.acl as AclMeta : null);

/** Opened envelopes of a tender whose repository access is still SEALED → COMMITTEE. */
export async function onEnvelopesOpened(ctx: Ctx, actor: Actor, tenantId: string, tenderId: string, trigger: 'BIDS_OPENED' | 'FINANCIAL_OPENED') {
  const fn = fileNetStoreOf(ctx);
  if (!fn || fn.config.acl.mode !== 'groups') return { changed: 0, failed: 0, skipped: 'FILENET_ACL_MODE=off' };
  const t = (await ctx.db.query<TenderRow>('SELECT * FROM tenders WHERE id=$1 AND tenant_id=$2', [tenderId, tenantId]))[0];
  if (!t) return { changed: 0, failed: 0 };
  const rows = await ctx.db.query<DocumentRow & { bid_status: string; bid_financial_opened_at: Date | null }>(
    `SELECT d.*, b.status AS bid_status, b.financial_opened_at AS bid_financial_opened_at FROM documents d JOIN bids b ON b.id = d.bid_id
      WHERE d.tenant_id=$1 AND d.tender_id=$2 AND d.store_type='filenet' AND d.owner_type IN ('BID_TECHNICAL','BID_FINANCIAL') AND b.status='OPENED'
      ORDER BY d.created_at`, [tenantId, tenderId]);
  let changed = 0; let failed = 0;
  for (const d of rows) {
    if (d.owner_type === 'BID_FINANCIAL' && financialSealed(t, { financial_opened_at: d.bid_financial_opened_at } as BidRow)) continue;
    const acl = aclOf(d);
    if (acl?.level === 'COMMITTEE' && acl.status !== 'INHERITED') continue; // already requested / applied
    const ok = await changeAccess(ctx, actor, d, 'COMMITTEE', trigger);
    if (ok) changed++; else failed++;
  }
  return { changed, failed };
}

/**
 * Requests (PENDING, audited), writes and reads back the permission list for `level`, then records the outcome on the
 * document and in the audit log. Never throws for repository errors: they are recorded for the retry job.
 */
export async function changeAccess(ctx: Ctx, actor: { id: string; roles: string[] }, d: DocumentRow, level: Confidentiality, reason: string): Promise<boolean> {
  const fn = fileNetStoreOf(ctx);
  if (!fn || fn.config.acl.mode !== 'groups') return false;
  const prev = aclOf(d);
  const from = prev?.appliedLevel ?? (prev?.status === 'APPLIED' || prev?.status === 'INHERITED' ? prev.level : null) ?? confidentialityFor(d.owner_type);
  const objectId = d.store_meta?.objectId ?? /^filenet:[^:]+:(.+)$/.exec(d.store_ref)?.[1] ?? null;
  const fresh = prev?.level !== level || !RETRYABLE.includes(prev?.status ?? '');
  const attempts = fresh ? 1 : (prev?.attempts ?? 0) + 1;
  if (fresh) {
    await ctx.db.tx(async (q) => {
      await q.query(`UPDATE documents SET store_meta = store_meta || jsonb_build_object('acl', $1::jsonb) WHERE id=$2 AND tenant_id=$3`,
        [JSON.stringify({ ...(prev ?? {}), mode: 'groups', level, appliedLevel: from, status: 'PENDING', attempts: 0, reason, at: new Date().toISOString() }), d.id, d.tenant_id]);
      await auditTx(ctx, q, { tenantId: d.tenant_id, actor, action: 'FILENET_ACCESS_CHANGE_REQUESTED', resourceType: 'DOCUMENT', resourceId: d.id,
        prevState: from, newState: level, details: { objectId, ownerType: d.owner_type, reason } });
    });
  }
  let outcome: AclMeta;
  let ok = false;
  try {
    const res = await fn.setAccess(d.store_ref, level);
    ok = res.ok;
    outcome = { mode: 'groups', level, appliedLevel: ok ? level : from, status: ok ? 'APPLIED' : 'FAILED', attempts, reason, at: new Date().toISOString(),
      grantees: (res.entries ?? []).map((e) => ({ name: e.granteeName, access: e.access })), readBack: res.readBack?.length, ...(ok ? {} : { error: res.detail }) };
  } catch (err) {
    outcome = { mode: 'groups', level, appliedLevel: from, status: 'FAILED', attempts, reason, at: new Date().toISOString(),
      grantees: (fn.aclFor(level) ?? []).map((e) => ({ name: e.granteeName, access: e.access })), error: String((err as Error)?.message ?? err).slice(0, 800) };
  }
  await ctx.db.tx(async (q) => {
    await q.query(`UPDATE documents SET store_meta = store_meta || jsonb_build_object('acl', $1::jsonb) WHERE id=$2 AND tenant_id=$3`, [JSON.stringify(outcome), d.id, d.tenant_id]);
    await auditTx(ctx, q, { tenantId: d.tenant_id, actor, action: ok ? 'FILENET_ACCESS_CHANGED' : 'FILENET_ACCESS_CHANGE_FAILED', resourceType: 'DOCUMENT', resourceId: d.id,
      prevState: from, newState: ok ? level : from, details: { objectId, ownerType: d.owner_type, reason, attempts, target: level,
        grantees: outcome.grantees?.map((g) => g.name) ?? [], ...(outcome.error ? { error: outcome.error.slice(0, 500) } : {}) } });
  });
  return ok;
}

/** Scheduler job: re-applies permission lists that are PENDING / FAILED / UNVERIFIED (at most ACCESS_MAX_ATTEMPTS each). */
export async function retryAccess(ctx: Ctx, tenantId?: string) {
  const fn = fileNetStoreOf(ctx);
  if (!fn) return { skipped: 'content store is not FileNet' };
  if (fn.config.acl.mode !== 'groups') return { skipped: 'FILENET_ACL_MODE=off' };
  const rows = await ctx.db.query<DocumentRow>(
    `SELECT * FROM documents WHERE store_type='filenet' AND store_meta->'acl'->>'status' = ANY($1::text[])
        AND COALESCE((store_meta->'acl'->>'attempts')::int, 0) < $2 AND ($3::text IS NULL OR tenant_id=$3)
      ORDER BY created_at LIMIT 100`, [RETRYABLE, ACCESS_MAX_ATTEMPTS, tenantId ?? null]);
  let applied = 0; let failed = 0;
  for (const d of rows) {
    const level = aclOf(d)?.level ?? confidentialityFor(d.owner_type);
    if (await changeAccess(ctx, SYSTEM_ACTOR, d, level, 'RETRY')) applied++; else failed++;
  }
  const gaveUp = Number((await ctx.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM documents WHERE store_type='filenet' AND store_meta->'acl'->>'status' = ANY($1::text[])
        AND COALESCE((store_meta->'acl'->>'attempts')::int, 0) >= $2 AND ($3::text IS NULL OR tenant_id=$3)`, [RETRYABLE, ACCESS_MAX_ATTEMPTS, tenantId ?? null]))[0]?.n ?? 0);
  return { checked: rows.length, applied, failed, gaveUp };
}

/** Effective confidentiality of a document now (a sealed envelope is COMMITTEE once it is opened). */
export async function effectiveLevel(ctx: Ctx, d: DocumentRow): Promise<Confidentiality> {
  const base = confidentialityFor(d.owner_type);
  if (base !== 'SEALED' || !d.bid_id) return base;
  const b = (await ctx.db.query<BidRow>('SELECT * FROM bids WHERE id=$1 AND tenant_id=$2', [d.bid_id, d.tenant_id]))[0];
  if (!b || b.status !== 'OPENED') return 'SEALED';
  if (d.owner_type === 'BID_FINANCIAL') {
    const t = (await ctx.db.query<TenderRow>('SELECT * FROM tenders WHERE id=$1', [b.tender_id]))[0];
    if (t && financialSealed(t, b)) return 'SEALED';
  }
  return 'COMMITTEE';
}

/**
 * Access section of the evidence panel. Vendors get the level and status only — never group names, errors or the
 * service account (repository internals).
 */
export async function describeAccess(ctx: Ctx, a: Actor, d: DocumentRow) {
  const fn = fileNetStoreOf(ctx);
  const acl = aclOf(d);
  const effective = await effectiveLevel(ctx, d);
  const mode = fn && d.store_type === 'filenet' ? fn.config.acl.mode : 'off';
  const staff = isStaff(a);
  if (mode === 'off' || !acl) {
    return { mode, level: effective, appliedLevel: null, status: 'NOT_ENFORCED' as const,
      note: mode === 'off' ? 'FILENET_ACL_MODE=off: the document has its class default security; TenderFlow enforces access' : 'stored before FILENET_ACL_MODE=groups was enabled: class default security' };
  }
  return {
    mode, level: acl.level ?? effective, appliedLevel: acl.appliedLevel ?? (acl.status === 'APPLIED' ? acl.level : null) ?? null, status: acl.status ?? 'UNKNOWN',
    at: acl.at ?? null,
    ...(staff ? {
      attempts: acl.attempts ?? 0, error: acl.error ?? null, reason: acl.reason ?? null,
      grantees: acl.grantees ?? (fn?.aclFor(acl.level ?? effective) ?? []).map((e) => ({ name: e.granteeName, access: e.access })),
    } : {}),
  };
}
