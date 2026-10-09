// Procurement analytics (/procurement/analytics): cycle time per stage from the audit log, tenders by status and
// category, vendor participation funnel, approval turnaround per level, document-sales revenue (TEST gateway
// labelled), AI usage and stored-document counts. Every figure is a query over this entity's own data in the
// requested date range; nothing is extrapolated. Empty data comes back as empty arrays / n = 0.
import type { Ctx } from '../../ctx.js';
import type { Actor } from '../../auth/tokens.js';
import { badRequest, now } from '../../util.js';
import { configOf } from '../../services/templates.js';
import { checkEligibility } from '../../services/eligibility.js';
import type { TenderRow } from '../../services/tenders.js';

const DAY = 86_400_000;

/** Quantile with linear interpolation between closest ranks (type 7, as in R / numpy default). */
export function quantile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}
const r3 = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);
export function summarise(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, medianDays: r3(quantile(s, 0.5)), p90Days: r3(quantile(s, 0.9)), meanDays: s.length ? r3(s.reduce((a, b) => a + b, 0) / s.length) : null,
    minDays: s.length ? r3(s[0]) : null, maxDays: s.length ? r3(s[s.length - 1]) : null };
}

export function parseRange(q: Record<string, unknown>) {
  const parse = (v: unknown, end: boolean) => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw badRequest('from/to must be dates (YYYY-MM-DD)');
    const d = new Date(`${v}T${end ? '23:59:59.999' : '00:00:00.000'}+03:00`);
    if (Number.isNaN(d.getTime())) throw badRequest('from/to must be valid dates');
    return d;
  };
  const to = parse(q.to, true) ?? now();
  const from = parse(q.from, false) ?? new Date(to.getTime() - 365 * DAY);
  if (to < from) throw badRequest('to must not be before from');
  return { from, to };
}

export const STAGES = [
  { key: 'CREATED_TO_APPROVED', from: 'TENDER_CREATED', to: 'TENDER_APPROVED' },
  { key: 'APPROVED_TO_PUBLISHED', from: 'TENDER_APPROVED', to: 'TENDER_PUBLISHED' },
  { key: 'PUBLISHED_TO_CLOSED', from: 'TENDER_PUBLISHED', to: 'TENDER_CLOSED' },
  { key: 'CLOSED_TO_OPENED', from: 'TENDER_CLOSED', to: 'TENDER_OPENED' },
  { key: 'OPENED_TO_AWARDED', from: 'TENDER_OPENED', to: 'AWARD_APPROVED' },
] as const;

async function cycleTimes(ctx: Ctx, tenantId: string, from: Date, to: Date) {
  // First occurrence per tender of each milestone; for approval the LAST final approval (after returns) is the one
  // that let the tender go out.
  const rows = await ctx.db.query<{ resource_id: string; action: string; first_at: Date; last_at: Date }>(
    `SELECT resource_id, action, min(at) AS first_at, max(at) AS last_at FROM audit_events
      WHERE tenant_id=$1 AND resource_type='TENDER' AND action = ANY($2::text[]) GROUP BY resource_id, action`,
    [tenantId, ['TENDER_CREATED', 'TENDER_APPROVED', 'TENDER_PUBLISHED', 'TENDER_CLOSED', 'TENDER_OPENED', 'AWARD_APPROVED']]);
  const by = new Map<string, Record<string, Date>>();
  for (const r of rows) {
    const m = by.get(r.resource_id) ?? {};
    m[r.action] = new Date(r.action === 'TENDER_APPROVED' ? r.last_at : r.first_at);
    by.set(r.resource_id, m);
  }
  return STAGES.map((s) => {
    const vals: number[] = [];
    for (const m of by.values()) {
      const a = m[s.from]; const b = m[s.to];
      if (a && b && b >= a && b >= from && b <= to) vals.push((b.getTime() - a.getTime()) / DAY);
    }
    return { stage: s.key, fromEvent: s.from, toEvent: s.to, ...summarise(vals) };
  });
}

/**
 * Turnaround of each approval level: level 1 from the subject's creation (tender / request), from the award
 * recommendation (award gate), or from the last return in the same gate; level n from the decision of level n−1.
 */
async function approvalTurnaround(ctx: Ctx, tenantId: string, from: Date, to: Date) {
  const decisions = await ctx.db.query<{ subject_type: string; subject_id: string; gate: string; level: number; role: string; decision: string; decided_at: Date }>(
    `SELECT subject_type, subject_id, gate, level, role, decision, decided_at FROM approvals WHERE tenant_id=$1 ORDER BY subject_id, gate, decided_at, level`, [tenantId]);
  const starts = new Map<string, Date>();
  for (const t of await ctx.db.query<any>('SELECT id, created_at FROM tenders WHERE tenant_id=$1', [tenantId])) starts.set(`${t.id}|PUBLISH`, new Date(t.created_at));
  for (const r of await ctx.db.query<any>('SELECT id, created_at FROM procurement_requests WHERE tenant_id=$1', [tenantId])) starts.set(`${r.id}|REQUEST`, new Date(r.created_at));
  for (const a of await ctx.db.query<any>('SELECT tender_id, created_at FROM awards WHERE tenant_id=$1', [tenantId])) starts.set(`${a.tender_id}|AWARD`, new Date(a.created_at));
  const buckets = new Map<string, { gate: string; level: number; role: string; values: number[] }>();
  let prevKey = '';
  let start: Date | undefined;
  for (const d of decisions) {
    const key = `${d.subject_id}|${d.gate}`;
    if (key !== prevKey) { prevKey = key; start = starts.get(key); }
    const at = new Date(d.decided_at);
    if (d.decision === 'APPROVED' && start && at >= start && at >= from && at <= to) {
      const bk = `${d.gate}|${d.level}`;
      const b = buckets.get(bk) ?? { gate: d.gate, level: d.level, role: d.role, values: [] };
      b.values.push((at.getTime() - start.getTime()) / DAY);
      buckets.set(bk, b);
    }
    start = at; // next level (or the next round after a return) starts at this decision
  }
  return [...buckets.values()]
    .sort((a, b) => a.gate.localeCompare(b.gate) || a.level - b.level)
    .map((b) => ({ gate: b.gate, level: b.level, role: b.role, ...summarise(b.values) }));
}

async function participation(ctx: Ctx, tenantId: string, from: Date, to: Date) {
  const tenders = await ctx.db.query<TenderRow>(
    `SELECT * FROM tenders WHERE tenant_id=$1 AND published_at IS NOT NULL AND published_at >= $2 AND published_at <= $3 ORDER BY published_at`, [tenantId, from, to]);
  const vendors = await ctx.db.query<{ id: string; categories: string[] }>(`SELECT id, categories FROM vendors WHERE tenant_id=$1 AND status='APPROVED'`, [tenantId]);
  const rows = [];
  for (const t of tenders) {
    let eligible = 0;
    for (const v of vendors) if ((v.categories ?? []).includes(t.category) && (await checkEligibility(ctx.db, t, v.id)).eligible) eligible++;
    const cfg = configOf(t);
    const purchased = cfg.stages.documentPurchase
      ? Number((await ctx.db.query<{ n: string }>('SELECT count(*)::text AS n FROM tender_purchases WHERE tender_id=$1', [t.id]))[0].n) : null;
    const bids = Number((await ctx.db.query<{ n: string }>('SELECT count(*)::text AS n FROM bids WHERE tender_id=$1', [t.id]))[0].n);
    rows.push({ tenderId: t.id, tenderNumber: t.tender_number, titleEn: t.title_en, titleAr: t.title_ar, status: t.status, category: t.category,
      publishedAt: new Date(t.published_at!).toISOString(), eligibleVendors: eligible, purchased, bids });
  }
  const unique = tenders.length ? Number((await ctx.db.query<{ n: string }>(
    'SELECT count(DISTINCT vendor_id)::text AS n FROM bids WHERE tender_id = ANY($1::uuid[])', [tenders.map((t) => t.id)]))[0].n) : 0;
  const bidCounts = rows.map((r) => r.bids).sort((a, b) => a - b);
  const withPurchase = rows.filter((r) => r.purchased !== null);
  return {
    tenders: rows,
    summary: {
      tenders: rows.length,
      bids: rows.reduce((a, r) => a + r.bids, 0),
      meanBidsPerTender: rows.length ? r3(rows.reduce((a, r) => a + r.bids, 0) / rows.length) : null,
      medianBidsPerTender: r3(quantile(bidCounts, 0.5)),
      uniqueBidders: unique,
    },
    funnel: {
      eligible: rows.reduce((a, r) => a + r.eligibleVendors, 0),
      /** Only tenders whose cycle requires a document purchase; null when none in range does. */
      purchased: withPurchase.length ? withPurchase.reduce((a, r) => a + (r.purchased ?? 0), 0) : null,
      purchaseTenders: withPurchase.length,
      bid: rows.reduce((a, r) => a + r.bids, 0),
    },
  };
}

export async function analytics(ctx: Ctx, a: Actor, q: Record<string, unknown>) {
  const { from, to } = parseRange(q);
  const t = a.tenantId;
  const byStatus = await ctx.db.query<any>(`SELECT status, count(*)::text AS n FROM tenders WHERE tenant_id=$1 AND created_at >= $2 AND created_at <= $3 GROUP BY status ORDER BY status`, [t, from, to]);
  const byCategory = await ctx.db.query<any>(`SELECT category, count(*)::text AS n FROM tenders WHERE tenant_id=$1 AND created_at >= $2 AND created_at <= $3 GROUP BY category ORDER BY category`, [t, from, to]);
  const revenue = await ctx.db.query<any>(
    `SELECT gateway, currency, status, count(*)::text AS n, coalesce(sum(amount),0)::text AS amount FROM tender_purchases
      WHERE tenant_id=$1 AND paid_at >= $2 AND paid_at <= $3 GROUP BY gateway, currency, status ORDER BY gateway, currency`, [t, from, to]);
  const ai = await ctx.db.query<any>(
    `SELECT kind, count(*)::text AS total, count(*) FILTER (WHERE status='OK')::text AS ok, count(*) FILTER (WHERE status='ERROR')::text AS error,
            count(*) FILTER (WHERE review_decision='ACCEPTED')::text AS accepted, count(*) FILTER (WHERE review_decision='EDITED')::text AS edited,
            count(*) FILTER (WHERE review_decision='IGNORED')::text AS ignored,
            count(*) FILTER (WHERE status='OK' AND review_decision IS NULL)::text AS unreviewed
       FROM ai_runs WHERE tenant_id=$1 AND created_at >= $2 AND created_at <= $3 GROUP BY kind ORDER BY kind`, [t, from, to]);
  const insights = await ctx.db.query<any>(`SELECT status, count(*)::text AS n FROM document_insights WHERE tenant_id=$1 AND created_at >= $2 AND created_at <= $3 GROUP BY status ORDER BY status`, [t, from, to]);
  const docs = await ctx.db.query<any>(
    `SELECT owner_type, store_type, count(*)::text AS n, count(*) FILTER (WHERE is_record)::text AS records, coalesce(sum(byte_size),0)::text AS bytes
       FROM documents WHERE tenant_id=$1 AND created_at >= $2 AND created_at <= $3 GROUP BY owner_type, store_type ORDER BY owner_type, store_type`, [t, from, to]);
  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    generatedAt: now().toISOString(),
    cycleTimes: await cycleTimes(ctx, t, from, to),
    tendersByStatus: byStatus.map((r) => ({ status: r.status, count: Number(r.n) })),
    tendersByCategory: byCategory.map((r) => ({ category: r.category, count: Number(r.n) })),
    participation: await participation(ctx, t, from, to),
    approvalTurnaround: await approvalTurnaround(ctx, t, from, to),
    revenue: revenue.map((r) => ({ gateway: r.gateway, testPayment: r.gateway === 'TEST', currency: r.currency, status: r.status, purchases: Number(r.n), amount: Number(r.amount) })),
    aiUsage: ai.map((r) => ({ kind: r.kind, total: Number(r.total), ok: Number(r.ok), error: Number(r.error), accepted: Number(r.accepted), edited: Number(r.edited), ignored: Number(r.ignored), unreviewed: Number(r.unreviewed) })),
    documentInsights: insights.map((r) => ({ status: r.status, count: Number(r.n) })),
    documents: docs.map((r) => ({ ownerType: r.owner_type, storeType: r.store_type, count: Number(r.n), records: Number(r.records), bytes: Number(r.bytes) })),
  };
}
