// Role dashboards (MOI BRD FR-031: every user sees a dashboard on the interface they sign in to). One endpoint,
// GET /insight/dashboard, returns one section per role the caller holds; each section is computed only for that
// role, from real tenant-scoped queries. Nothing is estimated: an empty list is an empty list.
import type { Ctx } from '../../ctx.js';
import { hasRole } from '../../ctx.js';
import type { Actor } from '../../auth/tokens.js';
import type { Queryable } from '../../db.js';
import { now } from '../../util.js';
import { configOf, DEFAULT_CONFIG, type CycleConfig } from '../../services/templates.js';
import { currentRound, type TenderRow } from '../../services/tenders.js';
import { checkEligibility } from '../../services/eligibility.js';
import { verifyAudit } from '../../services/audit.js';

const DAY = 86_400_000;
const KUWAIT_OFFSET_MS = 3 * 3600_000; // Asia/Kuwait is UTC+3 all year (no DST)
const num = (v: unknown) => Number(v ?? 0);
const days = (from: Date | string, to = now()) => Math.max(0, Math.round(((to.getTime() - new Date(from).getTime()) / DAY) * 10) / 10);
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

/** First instant of the current calendar month in Kuwait time. */
export function kuwaitMonthStart(at = now()): Date {
  const k = new Date(at.getTime() + KUWAIT_OFFSET_MS);
  return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), 1) - KUWAIT_OFFSET_MS);
}
/** Kuwait calendar day (YYYY-MM-DD) of an instant. */
export const kuwaitDay = (d: Date | string) => new Date(new Date(d).getTime() + KUWAIT_OFFSET_MS).toISOString().slice(0, 10);

async function count(db: Queryable, sql: string, params: unknown[]) {
  return num((await db.query<{ n: string }>(sql, params))[0]?.n);
}

// ------------------------------------------------------------------ officer
async function officerSection(ctx: Ctx, a: Actor) {
  const t = a.tenantId;
  const byStatus = await ctx.db.query<{ status: string; n: string }>(`SELECT status, count(*)::text AS n FROM tenders WHERE tenant_id=$1 GROUP BY status`, [t]);
  const drafts = await ctx.db.query<any>(
    `SELECT t.id, t.tender_number, t.title_en, t.title_ar, t.updated_at, t.submission_deadline,
            (SELECT count(*) FROM documents d WHERE d.tender_id=t.id AND d.owner_type='TENDER_PACK')::int AS pack_docs
       FROM tenders t WHERE t.tenant_id=$1 AND t.created_by=$2 AND t.status='DRAFT' ORDER BY t.updated_at DESC LIMIT 20`, [t, a.id]);
  const clar = await ctx.db.query<any>(
    `SELECT c.id, c.tender_id, c.created_at, c.language, t.tender_number, t.title_en, t.title_ar
       FROM clarifications c JOIN tenders t ON t.id=c.tender_id WHERE c.tenant_id=$1 AND c.status='OPEN' ORDER BY c.created_at LIMIT 20`, [t]);
  const clarTotal = await count(ctx.db, `SELECT count(*)::text AS n FROM clarifications WHERE tenant_id=$1 AND status='OPEN'`, [t]);
  const review = await count(ctx.db,
    `SELECT count(*)::text AS n FROM (SELECT DISTINCT ON (document_id) status FROM document_insights WHERE tenant_id=$1
       ORDER BY document_id, created_at DESC) x WHERE x.status='PENDING_REVIEW'`, [t]);
  const deadlines = await ctx.db.query<any>(
    `SELECT t.id, t.tender_number, t.title_en, t.title_ar, t.submission_deadline,
            (SELECT count(*) FROM tender_purchases p WHERE p.tender_id=t.id)::int AS purchases
       FROM tenders t WHERE t.tenant_id=$1 AND t.status='PUBLISHED' AND t.submission_deadline > $2 AND t.submission_deadline <= $3
      ORDER BY t.submission_deadline LIMIT 20`, [t, now(), new Date(now().getTime() + 14 * DAY)]);
  const reqReady = await count(ctx.db, `SELECT count(*)::text AS n FROM procurement_requests WHERE tenant_id=$1 AND status='APPROVED'`, [t]);
  return {
    tendersByStatus: Object.fromEntries(byStatus.map((r) => [r.status, num(r.n)])),
    myDrafts: drafts.map((d) => ({ id: d.id, tenderNumber: d.tender_number, titleEn: d.title_en, titleAr: d.title_ar, updatedAt: iso(d.updated_at), packDocuments: d.pack_docs })),
    clarificationsWaiting: { total: clarTotal, items: clar.map((c) => ({ id: c.id, tenderId: c.tender_id, tenderNumber: c.tender_number, titleEn: c.title_en, titleAr: c.title_ar, askedAt: iso(c.created_at), ageDays: days(c.created_at), language: c.language })) },
    documentsNeedingReview: review,
    upcomingDeadlines: deadlines.map((d) => ({ id: d.id, tenderNumber: d.tender_number, titleEn: d.title_en, titleAr: d.title_ar, deadline: iso(d.submission_deadline), daysLeft: Math.round(((new Date(d.submission_deadline).getTime() - now().getTime()) / DAY) * 10) / 10, purchases: d.purchases })),
    requestsReadyToConvert: reqReady,
  };
}

// ------------------------------------------------------------------ approvers
export interface WaitingItem {
  kind: 'TENDER' | 'AWARD' | 'REQUEST' | 'NOTICE'; id: string; tenderId: string | null; number: string; titleEn: string; titleAr: string;
  level: number; of: number; role: string; waitingSince: string; ageDays: number;
}

async function requestChain(db: Queryable, tenantId: string): Promise<CycleConfig['approvals']['request']> {
  const r = await db.query<{ config: CycleConfig }>(`SELECT config FROM cycle_templates WHERE tenant_id=$1 AND status='PUBLISHED' AND is_default LIMIT 1`, [tenantId]);
  return r[0]?.config?.approvals?.request ?? DEFAULT_CONFIG.approvals.request;
}

const lastReturn = async (db: Queryable, subjectId: string, gate: string) =>
  (await db.query<{ at: Date | null }>(`SELECT max(decided_at) AS at FROM approvals WHERE subject_id=$1 AND gate=$2 AND decision='RETURNED'`, [subjectId, gate]))[0]?.at ?? null;
const maxDate = (...xs: (Date | string | null | undefined)[]) => new Date(Math.max(...xs.filter(Boolean).map((x) => new Date(x as string).getTime())));

/**
 * Items whose NEXT approval level the caller may decide (same rules as the approve endpoints: role of the level,
 * not the creator / recommender, not already approved by the caller in this round). "waitingSince" is the decision
 * of the previous level; for level 1 the later of creation, last pack upload and last return.
 */
export async function approvalsWaiting(ctx: Ctx, a: Actor): Promise<WaitingItem[]> {
  const t = a.tenantId;
  const out: WaitingItem[] = [];
  const tenders = await ctx.db.query<TenderRow>(`SELECT * FROM tenders WHERE tenant_id=$1 AND status IN ('DRAFT','PENDING_APPROVAL','EVALUATION')`, [t]);
  for (const x of tenders) {
    const cfg = configOf(x);
    if (x.status === 'EVALUATION') {
      const aw = (await ctx.db.query<any>(`SELECT * FROM awards WHERE tender_id=$1 AND status='RECOMMENDED'`, [x.id]))[0];
      if (!aw || aw.recommended_by === a.id) continue;
      const done = await currentRound(ctx.db, x.id, 'AWARD', new Date(aw.created_at));
      const lvl = cfg.approvals.award[done.length];
      if (!lvl || !hasRole(a, lvl.role) || done.some((d) => d.approver_id === a.id)) continue;
      const since = done.length ? done[done.length - 1].decided_at : aw.created_at;
      out.push({ kind: 'AWARD', id: x.id, tenderId: x.id, number: x.tender_number, titleEn: x.title_en, titleAr: x.title_ar, level: done.length + 1, of: cfg.approvals.award.length, role: lvl.role, waitingSince: iso(since)!, ageDays: days(since) });
      continue;
    }
    if (x.created_by === a.id) continue;
    const pack = (await ctx.db.query<{ at: Date | null }>(`SELECT max(created_at) AS at FROM documents WHERE tender_id=$1 AND owner_type='TENDER_PACK'`, [x.id]))[0]?.at ?? null;
    if (x.status === 'DRAFT' && !pack) continue; // not approvable yet (pack missing)
    const done = await currentRound(ctx.db, x.id, 'PUBLISH');
    const lvl = cfg.approvals.publish[done.length];
    if (!lvl || !hasRole(a, lvl.role) || done.some((d) => d.approver_id === a.id)) continue;
    const since = done.length ? new Date(done[done.length - 1].decided_at) : maxDate(x.created_at, pack, await lastReturn(ctx.db, x.id, 'PUBLISH'));
    out.push({ kind: 'TENDER', id: x.id, tenderId: x.id, number: x.tender_number, titleEn: x.title_en, titleAr: x.title_ar, level: done.length + 1, of: cfg.approvals.publish.length, role: lvl.role, waitingSince: since.toISOString(), ageDays: days(since) });
  }
  const reqs = await ctx.db.query<any>(`SELECT * FROM procurement_requests WHERE tenant_id=$1 AND status IN ('SUBMITTED','IN_APPROVAL')`, [t]);
  if (reqs.length) {
    const chain = await requestChain(ctx.db, t);
    for (const r of reqs) {
      if (r.created_by === a.id) continue;
      const done = await currentRound(ctx.db, r.id, 'REQUEST');
      const lvl = chain[done.length];
      if (!lvl || !hasRole(a, lvl.role) || done.some((d) => d.approver_id === a.id)) continue;
      const since = done.length ? new Date(done[done.length - 1].decided_at) : maxDate(r.created_at, await lastReturn(ctx.db, r.id, 'REQUEST'));
      out.push({ kind: 'REQUEST', id: r.id, tenderId: null, number: r.request_number, titleEn: r.subject, titleAr: r.subject, level: done.length + 1, of: chain.length, role: lvl.role, waitingSince: since.toISOString(), ageDays: days(since) });
    }
  }
  if (hasRole(a, 'DIRECTOR', 'UNDERSECRETARY')) {
    const notices = await ctx.db.query<any>(
      `SELECT p.id, p.channel, p.created_at, p.created_by, t.id AS tender_id, t.tender_number, t.title_en, t.title_ar FROM publications p JOIN tenders t ON t.id=p.tender_id
        WHERE p.tenant_id=$1 AND p.status='DRAFT' AND p.channel <> 'PORTAL'`, [t]);
    for (const n of notices) {
      if (n.created_by === a.id) continue;
      out.push({ kind: 'NOTICE', id: n.id, tenderId: n.tender_id, number: `${n.tender_number} · ${n.channel}`, titleEn: n.title_en, titleAr: n.title_ar, level: 1, of: 1, role: 'DIRECTOR', waitingSince: iso(n.created_at)!, ageDays: days(n.created_at) });
    }
  }
  return out.sort((x, y) => y.ageDays - x.ageDays);
}

async function approverSection(ctx: Ctx, a: Actor) {
  const waiting = await approvalsWaiting(ctx, a);
  const monthStart = kuwaitMonthStart();
  const published = await ctx.db.query<any>(
    `SELECT id, tender_number, title_en, title_ar, published_at FROM tenders WHERE tenant_id=$1 AND published_at >= $2 ORDER BY published_at DESC`, [a.tenantId, monthStart]);
  const ages = waiting.map((w) => w.ageDays).sort((x, y) => x - y);
  return {
    waiting,
    waitingCount: waiting.length,
    oldestWaitingDays: ages.length ? ages[ages.length - 1] : null,
    medianWaitingDays: ages.length ? (ages.length % 2 ? ages[(ages.length - 1) / 2] : (ages[ages.length / 2 - 1] + ages[ages.length / 2]) / 2) : null,
    publishedThisMonth: { since: monthStart.toISOString(), count: published.length, items: published.slice(0, 10).map((p) => ({ id: p.id, tenderNumber: p.tender_number, titleEn: p.title_en, titleAr: p.title_ar, publishedAt: iso(p.published_at) })) },
  };
}

// ------------------------------------------------------------------ committee
async function committeeSection(ctx: Ctx, a: Actor) {
  const t = a.tenantId;
  const chair = hasRole(a, 'COMMITTEE_CHAIR');
  const evaluator = hasRole(a, 'EVALUATOR');
  const closed = await ctx.db.query<any>(
    `SELECT t.id, t.tender_number, t.title_en, t.title_ar, t.submission_deadline, t.closed_at,
            (SELECT count(*) FROM bids b WHERE b.tender_id=t.id AND b.status='SEALED')::int AS sealed
       FROM tenders t WHERE t.tenant_id=$1 AND (t.status='CLOSED' OR (t.status='PUBLISHED' AND t.submission_deadline <= $2)) ORDER BY t.submission_deadline`, [t, now()]);
  const active = await ctx.db.query<TenderRow>(`SELECT * FROM tenders WHERE tenant_id=$1 AND status IN ('OPENED','EVALUATION') ORDER BY opened_at`, [t]);
  const evals = [];
  const financialDue = [];
  const toRecommend = [];
  for (const x of active) {
    const cfg = configOf(x);
    const opened = await ctx.db.query<any>(`SELECT id, technical_result FROM bids WHERE tender_id=$1 AND status='OPENED'`, [x.id]);
    const scorable = cfg.envelopes === 'TWO' && x.financial_opened_at ? opened.filter((b) => b.technical_result !== 'FAILED') : opened;
    const ev = await ctx.db.query<any>(`SELECT evaluator_id, bid_id FROM evaluations WHERE tender_id=$1`, [x.id]);
    const evaluators = new Set(ev.map((e) => e.evaluator_id));
    const mine = ev.filter((e) => e.evaluator_id === a.id && scorable.some((b) => b.id === e.bid_id)).length;
    const phase = cfg.envelopes === 'TWO' ? (x.financial_opened_at ? 'FINANCIAL' : 'TECHNICAL') : 'SINGLE';
    evals.push({ id: x.id, tenderNumber: x.tender_number, titleEn: x.title_en, titleAr: x.title_ar, status: x.status, phase,
      openedBids: opened.length, scorableBids: scorable.length, evaluationsSubmitted: ev.length, evaluators: evaluators.size,
      myScored: evaluator ? mine : null, myRemaining: evaluator ? Math.max(0, scorable.length - mine) : null });
    if (chair && cfg.envelopes === 'TWO' && !x.financial_opened_at)
      financialDue.push({ id: x.id, tenderNumber: x.tender_number, titleEn: x.title_en, titleAr: x.title_ar, technicalEvaluated: new Set(ev.map((e) => e.bid_id)).size, openedBids: opened.length });
    const aw = (await ctx.db.query<any>(`SELECT status FROM awards WHERE tender_id=$1`, [x.id]))[0];
    if (chair && !aw && ev.length > 0 && (cfg.envelopes === 'ONE' || x.financial_opened_at))
      toRecommend.push({ id: x.id, tenderNumber: x.tender_number, titleEn: x.title_en, titleAr: x.title_ar, evaluationsSubmitted: ev.length });
  }
  return {
    openingsDue: chair ? closed.map((c) => ({ id: c.id, tenderNumber: c.tender_number, titleEn: c.title_en, titleAr: c.title_ar, deadline: iso(c.submission_deadline), sealedBids: c.sealed, overdueDays: days(c.submission_deadline) })) : null,
    financialOpeningsDue: chair ? financialDue : null,
    awardsToRecommend: chair ? toRecommend : null,
    evaluations: evals,
    myScoring: evaluator ? { scored: evals.reduce((s, e) => s + (e.myScored ?? 0), 0), remaining: evals.reduce((s, e) => s + (e.myRemaining ?? 0), 0) } : null,
  };
}

// ------------------------------------------------------------------ auditor
async function auditorSection(ctx: Ctx, a: Actor) {
  const t = a.tenantId;
  const chain = await verifyAudit(ctx.db, ctx.config.auditSigningKey, t);
  const since = kuwaitMonthStart();
  const from = new Date(now().getTime() - 29 * DAY);
  const rows = await ctx.db.query<{ at: Date; action: string }>(`SELECT at, action FROM audit_events WHERE tenant_id=$1 AND at >= $2`, [t, new Date(from.getTime() - DAY)]);
  const perDay = new Map<string, number>();
  for (let i = 0; i < 30; i++) perDay.set(kuwaitDay(new Date(from.getTime() + i * DAY)), 0);
  const actions = new Map<string, number>();
  for (const r of rows) {
    const k = kuwaitDay(r.at);
    if (perDay.has(k)) { perDay.set(k, (perDay.get(k) ?? 0) + 1); actions.set(r.action, (actions.get(r.action) ?? 0) + 1); }
  }
  const ai = await ctx.db.query<any>(`SELECT status, review_decision, count(*)::text AS n FROM ai_runs WHERE tenant_id=$1 GROUP BY status, review_decision`, [t]);
  const aiSum = { total: 0, failed: 0, accepted: 0, edited: 0, ignored: 0, unreviewed: 0 };
  for (const r of ai) {
    const n = num(r.n);
    aiSum.total += n;
    if (r.status === 'ERROR') aiSum.failed += n;
    else if (r.review_decision === 'ACCEPTED') aiSum.accepted += n;
    else if (r.review_decision === 'EDITED') aiSum.edited += n;
    else if (r.review_decision === 'IGNORED') aiSum.ignored += n;
    else aiSum.unreviewed += n;
  }
  const insights = await ctx.db.query<any>(`SELECT status, count(*)::text AS n FROM document_insights WHERE tenant_id=$1 GROUP BY status`, [t]);
  const packs = await ctx.db.query<any>(
    `SELECT d.id, d.title, d.created_at, d.sha256_plain, t.tender_number FROM documents d LEFT JOIN tenders t ON t.id=d.tender_id
      WHERE d.tenant_id=$1 AND d.owner_type='EVIDENCE_PACK' ORDER BY d.created_at DESC LIMIT 5`, [t]);
  return {
    auditChain: { valid: chain.valid, count: chain.count, brokenAt: chain.brokenAt ?? null, reason: chain.reason ?? null, verifiedAt: now().toISOString() },
    eventsPerDay: [...perDay.entries()].map(([day, n]) => ({ day, count: n })),
    topActions: [...actions.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([action, n]) => ({ action, count: n })),
    eventsThisMonth: await count(ctx.db, `SELECT count(*)::text AS n FROM audit_events WHERE tenant_id=$1 AND at >= $2`, [t, since]),
    aiRuns: aiSum,
    documentInsights: Object.fromEntries(insights.map((r) => [r.status, num(r.n)])),
    records: {
      documents: await count(ctx.db, `SELECT count(*)::text AS n FROM documents WHERE tenant_id=$1 AND is_record`, [t]),
      inRepository: await count(ctx.db, `SELECT count(*)::text AS n FROM documents WHERE tenant_id=$1 AND is_record AND (store_meta->'record'->>'repository') = 'true'`, [t]),
      tendersLocked: await count(ctx.db, `SELECT count(*)::text AS n FROM tenders WHERE tenant_id=$1 AND records_locked_at IS NOT NULL`, [t]),
    },
    evidencePacks: packs.map((p) => ({ id: p.id, title: p.title, tenderNumber: p.tender_number, createdAt: iso(p.created_at), sha256: p.sha256_plain })),
  };
}

// ------------------------------------------------------------------ tenant admin
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => { timer = setTimeout(() => rej(new Error(`no answer within ${ms} ms`)), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function adminSection(ctx: Ctx, a: Actor) {
  const t = a.tenantId;
  const roles = await ctx.db.query<any>(`SELECT r AS role, count(*) FILTER (WHERE active)::text AS active, count(*) FILTER (WHERE NOT active)::text AS inactive
                                            FROM users, unnest(roles) r WHERE tenant_id=$1 GROUP BY r ORDER BY r`, [t]);
  const vendors = await ctx.db.query<any>(`SELECT status, count(*)::text AS n FROM vendors WHERE tenant_id=$1 GROUP BY status`, [t]);
  const grades = await ctx.db.query<any>(
    `SELECT best AS grade, count(*)::text AS n FROM (SELECT vendor_id, min(grade) AS best FROM vendor_classifications WHERE tenant_id=$1 GROUP BY vendor_id) x GROUP BY best ORDER BY best`, [t]);
  const unclassified = await count(ctx.db,
    `SELECT count(*)::text AS n FROM vendors v WHERE v.tenant_id=$1 AND v.status='APPROVED' AND NOT EXISTS (SELECT 1 FROM vendor_classifications c WHERE c.vendor_id=v.id)`, [t]);
  let ping: { ok: boolean; detail: string };
  try { ping = await withTimeout(ctx.store.ping(), 8000); } catch (e) { ping = { ok: false, detail: (e as Error).message }; }
  const docs = {
    total: await count(ctx.db, `SELECT count(*)::text AS n FROM documents WHERE tenant_id=$1`, [t]),
    inFileNet: await count(ctx.db, `SELECT count(*)::text AS n FROM documents WHERE tenant_id=$1 AND store_type='filenet'`, [t]),
    records: await count(ctx.db, `SELECT count(*)::text AS n FROM documents WHERE tenant_id=$1 AND is_record`, [t]),
    encrypted: await count(ctx.db, `SELECT count(*)::text AS n FROM documents WHERE tenant_id=$1 AND encrypted`, [t]),
  };
  const configured = ctx.ai.isConfigured();
  let agents: { checked: boolean; missing: { role: string; name: string }[]; detail?: string; error?: string } = { checked: false, missing: [] };
  if (configured) {
    try { agents = await withTimeout(ctx.ai.agentStatus(), 8000); } catch (e) { agents = { checked: false, missing: [], error: (e as Error).message }; }
  }
  const runs = await ctx.db.query<any>(`SELECT max(created_at) FILTER (WHERE status='OK') AS last_ok, max(created_at) FILTER (WHERE status='ERROR') AS last_error FROM ai_runs WHERE tenant_id=$1`, [t]);
  const tpl = await ctx.db.query<any>(`SELECT code, version, name_en, name_ar, status, is_default, published_at FROM cycle_templates WHERE tenant_id=$1 ORDER BY code, version DESC`, [t]);
  return {
    usersByRole: roles.map((r) => ({ role: r.role, active: num(r.active), inactive: num(r.inactive) })),
    vendorsByStatus: Object.fromEntries(vendors.map((r) => [r.status, num(r.n)])),
    vendorsByGrade: [...grades.map((g) => ({ grade: num(g.grade) as number | null, vendors: num(g.n) })), ...(unclassified ? [{ grade: null, vendors: unclassified }] : [])],
    fileNet: { storeType: ctx.store.type, ok: ping.ok, detail: ping.detail, documents: docs },
    orchestrate: { configured, agentsChecked: agents.checked, missingAgents: agents.missing, detail: agents.detail ?? agents.error ?? null,
      lastSuccessfulRun: iso(runs[0]?.last_ok), lastFailedRun: iso(runs[0]?.last_error) },
    templates: tpl.map((x) => ({ code: x.code, version: x.version, nameEn: x.name_en, nameAr: x.name_ar, status: x.status, isDefault: x.is_default, publishedAt: iso(x.published_at) })),
  };
}

// ------------------------------------------------------------------ vendor
async function vendorSection(ctx: Ctx, a: Actor) {
  const t = a.tenantId;
  const vid = a.vendorId;
  if (!vid) return null;
  const v = (await ctx.db.query<any>(`SELECT id, status, categories, legal_name_en, legal_name_ar FROM vendors WHERE id=$1 AND tenant_id=$2`, [vid, t]))[0];
  if (!v) return null;
  const open = v.status === 'APPROVED' ? await ctx.db.query<TenderRow>(
    `SELECT * FROM tenders WHERE tenant_id=$1 AND status='PUBLISHED' AND submission_deadline > $2 AND category = ANY($3::text[]) ORDER BY submission_deadline`,
    [t, now(), v.categories ?? []]) : [];
  const eligible = [];
  for (const x of open) {
    const e = await checkEligibility(ctx.db, x, vid);
    const cfg = configOf(x);
    const bought = (await ctx.db.query<any>(`SELECT receipt_number FROM tender_purchases WHERE tender_id=$1 AND vendor_id=$2`, [x.id, vid]))[0];
    const bid = (await ctx.db.query<any>(`SELECT id FROM bids WHERE tender_id=$1 AND vendor_id=$2`, [x.id, vid]))[0];
    eligible.push({ id: x.id, tenderNumber: x.tender_number, titleEn: x.title_en, titleAr: x.title_ar, deadline: iso(x.submission_deadline),
      eligible: e.eligible, reasons: e.reasons, purchaseRequired: cfg.stages.documentPurchase, purchased: !!bought, bidSubmitted: !!bid,
      documentPrice: cfg.stages.documentPurchase ? { amount: Number(cfg.fees.documentPrice), currency: cfg.fees.currency } : null });
  }
  const purchases = await ctx.db.query<any>(
    `SELECT p.receipt_number, p.amount, p.currency, p.gateway, p.status, p.paid_at, t.id AS tender_id, t.tender_number, t.title_en, t.title_ar
       FROM tender_purchases p JOIN tenders t ON t.id=p.tender_id WHERE p.tenant_id=$1 AND p.vendor_id=$2 ORDER BY p.paid_at DESC`, [t, vid]);
  const bids = await ctx.db.query<any>(
    `SELECT b.id, b.status, b.submitted_at, b.receipt_sha256, b.technical_result, t.id AS tender_id, t.tender_number, t.title_en, t.title_ar,
            t.status AS tender_status, a.bid_id AS award_bid, a.status AS award_status
       FROM bids b JOIN tenders t ON t.id=b.tender_id LEFT JOIN awards a ON a.tender_id=t.id
      WHERE b.tenant_id=$1 AND b.vendor_id=$2 ORDER BY b.submitted_at DESC`, [t, vid]);
  const horizon = new Date(now().getTime() + 60 * DAY).toISOString().slice(0, 10);
  const today = kuwaitDay(now());
  const cls = await ctx.db.query<any>(
    `SELECT c.activity_code, c.grade, c.valid_until, a.name_en, a.name_ar FROM vendor_classifications c
       LEFT JOIN activity_codes a ON a.tenant_id=c.tenant_id AND a.code=c.activity_code
      WHERE c.tenant_id=$1 AND c.vendor_id=$2 AND c.valid_until IS NOT NULL AND c.valid_until <= $3::date ORDER BY c.valid_until`, [t, vid, horizon]);
  const docRows = await ctx.db.query<any>(
    `SELECT DISTINCT ON (i.document_id) i.document_id, d.title, i.status, i.fields, i.corrected_fields
       FROM document_insights i JOIN documents d ON d.id=i.document_id
      WHERE i.tenant_id=$1 AND d.vendor_id=$2 AND d.owner_type='VENDOR' AND i.status IN ('ACCEPTED','CORRECTED')
      ORDER BY i.document_id, i.reviewed_at DESC NULLS LAST`, [t, vid]);
  const expiring: { kind: 'DOCUMENT' | 'CLASSIFICATION'; id: string; titleEn: string; titleAr: string; date: string; expired: boolean }[] = [];
  for (const r of docRows) {
    const fields: any[] = Array.isArray(r.corrected_fields) ? r.corrected_fields : Array.isArray(r.fields) ? r.fields : [];
    const f = fields.find((x) => (x?.key === 'expiryDate' || x?.key === 'validUntil') && typeof x?.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.value));
    if (f && f.value <= horizon) expiring.push({ kind: 'DOCUMENT', id: r.document_id, titleEn: r.title, titleAr: r.title, date: f.value, expired: f.value < today });
  }
  for (const c of cls) {
    const d = c.valid_until instanceof Date ? c.valid_until.toISOString().slice(0, 10) : String(c.valid_until).slice(0, 10);
    expiring.push({ kind: 'CLASSIFICATION', id: c.activity_code, titleEn: `${c.activity_code} ${c.name_en ?? ''}`.trim(), titleAr: `${c.activity_code} ${c.name_ar ?? ''}`.trim(), date: d, expired: d < today });
  }
  expiring.sort((x, y) => x.date.localeCompare(y.date));
  const outcome = (b: any) => {
    if (b.award_status === 'APPROVED') return b.award_bid === b.id ? 'AWARDED' : 'NOT_AWARDED';
    if (b.technical_result === 'FAILED') return 'TECHNICAL_FAILED';
    if (b.tender_status === 'CANCELLED') return 'TENDER_CANCELLED';
    return b.status === 'SEALED' ? 'SEALED' : 'UNDER_EVALUATION';
  };
  return {
    vendorStatus: v.status,
    eligibleOpenTenders: eligible,
    eligibleCount: eligible.filter((e) => e.eligible).length,
    purchases: purchases.map((p) => ({ receiptNumber: p.receipt_number, amount: Number(p.amount), currency: p.currency, gateway: p.gateway, testPayment: p.gateway === 'TEST',
      status: p.status, paidAt: iso(p.paid_at), tenderId: p.tender_id, tenderNumber: p.tender_number, titleEn: p.title_en, titleAr: p.title_ar })),
    bids: bids.map((b) => ({ id: b.id, tenderId: b.tender_id, tenderNumber: b.tender_number, titleEn: b.title_en, titleAr: b.title_ar, tenderStatus: b.tender_status,
      status: b.status, submittedAt: iso(b.submitted_at), receiptSha256: b.receipt_sha256, outcome: outcome(b) })),
    expiring,
  };
}

export async function roleDashboard(ctx: Ctx, a: Actor) {
  const out: Record<string, unknown> = { roles: a.roles, generatedAt: now().toISOString() };
  if (hasRole(a, 'PROCUREMENT_OFFICER')) out.officer = await officerSection(ctx, a);
  if (hasRole(a, 'DIRECTOR', 'UNDERSECRETARY')) out.approver = await approverSection(ctx, a);
  if (hasRole(a, 'COMMITTEE_CHAIR', 'EVALUATOR')) out.committee = await committeeSection(ctx, a);
  if (hasRole(a, 'AUDITOR')) out.auditor = await auditorSection(ctx, a);
  if (hasRole(a, 'TENANT_ADMIN')) out.admin = await adminSection(ctx, a);
  if (hasRole(a, 'VENDOR') && a.vendorId) out.vendor = await vendorSection(ctx, a);
  return out;
}
