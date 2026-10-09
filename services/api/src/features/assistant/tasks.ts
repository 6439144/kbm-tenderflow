// "What is waiting for me?" — the caller's pending tasks computed from TenderFlow state (no AI). Used by
// GET /assistant/my-tasks, by the assistant dock, and as part of the chat context sent to the supervisor agent.
import type { Ctx } from '../../ctx.js';
import { hasRole, isStaff } from '../../ctx.js';
import type { Actor } from '../../auth/tokens.js';
import { now } from '../../util.js';
import { configOf, DEFAULT_CONFIG, type ApprovalLevel, type CycleConfig } from '../../services/templates.js';
import { closeDueTenders, currentRound, type TenderRow } from '../../services/tenders.js';
import { checkEligibility } from '../../services/eligibility.js';

export interface Task {
  kind: string;
  titleEn: string;
  titleAr: string;
  /** Web route that performs the step. */
  link: string;
  tenderId?: string;
  tenderNumber?: string;
  requestId?: string;
  dueAt?: string | null;
  count?: number;
}

const DAY = 24 * 3600 * 1000;
const CHANNEL = { KUWAIT_ALYOUM: { en: 'Kuwait Al-Youm', ar: 'الكويت اليوم' }, CAPT: { en: 'CAPT', ar: 'الجهاز المركزي للمناقصات العامة' } } as const;

/** Kuwait local time (UTC+3, no DST) as "YYYY-MM-DD HH:mm". */
export function kuwaitTime(d: Date | string): string {
  return new Date(new Date(d).getTime() + 3 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/** The level that waits for a decision, or null when the actor cannot decide it. */
function waitingLevel(chain: ApprovalLevel[], done: { approver_id: string }[], actor: Actor, excludedId: string | null) {
  const level = chain[done.length];
  if (!level || !hasRole(actor, level.role)) return null;
  if (excludedId && excludedId === actor.id) return null;
  if (done.some((d) => d.approver_id === actor.id)) return null;
  return { levelNo: done.length + 1, of: chain.length, level };
}

/** Config of the entity's default published template (request chain, request-classify toggle); v1 default otherwise. */
export async function defaultTemplateConfig(ctx: Ctx, tenantId: string): Promise<CycleConfig> {
  const r = await ctx.db.query<{ config: CycleConfig }>(
    `SELECT config FROM cycle_templates WHERE tenant_id=$1 AND status='PUBLISHED' AND is_default ORDER BY version DESC LIMIT 1`, [tenantId]);
  return r[0]?.config ?? DEFAULT_CONFIG;
}

async function staffTasks(ctx: Ctx, actor: Actor): Promise<Task[]> {
  const out: Task[] = [];
  const tid = actor.tenantId;
  const link = (id: string) => `/procurement/tenders/${id}`;
  const isOfficer = hasRole(actor, 'PROCUREMENT_OFFICER');
  const tenders = await ctx.db.query<TenderRow>(`SELECT * FROM tenders WHERE tenant_id=$1 AND status <> 'CANCELLED' ORDER BY created_at`, [tid]);
  const packCounts = new Map((await ctx.db.query<{ tender_id: string; n: string }>(
    `SELECT tender_id, count(*)::text AS n FROM documents WHERE tenant_id=$1 AND owner_type='TENDER_PACK' GROUP BY tender_id`, [tid])).map((r) => [r.tender_id, Number(r.n)]));
  const pubs = await ctx.db.query<{ id: string; tender_id: string; channel: 'KUWAIT_ALYOUM' | 'CAPT' | 'PORTAL'; status: string; created_by: string }>(
    `SELECT id, tender_id, channel, status, created_by FROM publications WHERE tenant_id=$1`, [tid]);

  for (const t of tenders) {
    const cfg = configOf(t);
    const n = t.tender_number;
    // Publication approval chain (N levels; the creator never approves).
    if (t.status === 'DRAFT' || t.status === 'PENDING_APPROVAL') {
      const done = await currentRound(ctx.db, t.id, 'PUBLISH');
      const hasPack = (packCounts.get(t.id) ?? 0) > 0;
      const w = waitingLevel(cfg.approvals.publish, done, actor, t.created_by);
      if (w && (t.status === 'PENDING_APPROVAL' || hasPack)) {
        out.push({ kind: 'APPROVE_TENDER', tenderId: t.id, tenderNumber: n, link: link(t.id),
          titleEn: `Approve tender ${n} — ${t.title_en} (approval level ${w.levelNo} of ${w.of}: ${w.level.labelEn})`,
          titleAr: `اعتماد المناقصة ${n} — ${t.title_ar} (مستوى الاعتماد ${w.levelNo} من ${w.of}: ${w.level.labelAr})` });
      }
      if (isOfficer && t.status === 'DRAFT' && !hasPack) {
        out.push({ kind: 'UPLOAD_PACK', tenderId: t.id, tenderNumber: n, link: link(t.id),
          titleEn: `Upload the tender pack of draft ${n} — ${t.title_en}`, titleAr: `رفع كراسة الشروط للمسودة ${n} — ${t.title_ar}` });
      }
    }
    if (isOfficer && t.status === 'APPROVED') {
      out.push({ kind: 'PUBLISH_TENDER', tenderId: t.id, tenderNumber: n, link: link(t.id), dueAt: new Date(t.submission_deadline).toISOString(),
        titleEn: `Publish approved tender ${n} — ${t.title_en}`, titleAr: `نشر المناقصة المعتمدة ${n} — ${t.title_ar}` });
    }
    // Gazette / CAPT notices.
    for (const ch of ['KUWAIT_ALYOUM', 'CAPT'] as const) {
      const enabled = ch === 'KUWAIT_ALYOUM' ? cfg.stages.gazette : cfg.stages.capt;
      if (!enabled) continue;
      const p = pubs.find((x) => x.tender_id === t.id && x.channel === ch);
      if (isOfficer && !p && ['APPROVED', 'PUBLISHED'].includes(t.status)) {
        out.push({ kind: 'DRAFT_NOTICE', tenderId: t.id, tenderNumber: n, link: link(t.id),
          titleEn: `Draft the ${CHANNEL[ch].en} notice for ${n}`, titleAr: `إعداد إعلان ${CHANNEL[ch].ar} للمناقصة ${n}` });
      }
      if (p?.status === 'DRAFT' && hasRole(actor, 'DIRECTOR', 'UNDERSECRETARY') && p.created_by !== actor.id) {
        out.push({ kind: 'APPROVE_NOTICE', tenderId: t.id, tenderNumber: n, link: link(t.id),
          titleEn: `Approve the ${CHANNEL[ch].en} notice text for ${n}`, titleAr: `اعتماد نص إعلان ${CHANNEL[ch].ar} للمناقصة ${n}` });
      }
      if (isOfficer && p?.status === 'APPROVED') {
        out.push({ kind: 'RECORD_NOTICE', tenderId: t.id, tenderNumber: n, link: link(t.id),
          titleEn: `Record the ${CHANNEL[ch].en} publication reference for ${n}`, titleAr: `تسجيل مرجع نشر ${CHANNEL[ch].ar} للمناقصة ${n}` });
      }
    }
    if (isOfficer && t.status === 'PUBLISHED') {
      const open = Number((await ctx.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM clarifications WHERE tender_id=$1 AND status='OPEN'`, [t.id]))[0].n);
      if (open > 0) out.push({ kind: 'ANSWER_CLARIFICATIONS', tenderId: t.id, tenderNumber: n, link: link(t.id), count: open,
        titleEn: `Answer ${open} open clarification question(s) on ${n}`, titleAr: `الرد على ${open} من أسئلة الاستيضاح المفتوحة في ${n}` });
    }
    if (hasRole(actor, 'COMMITTEE_CHAIR')) {
      if (t.status === 'CLOSED') {
        out.push({ kind: 'OPEN_BIDS', tenderId: t.id, tenderNumber: n, link: link(t.id),
          titleEn: `Hold the bid opening of ${n} (deadline passed)`, titleAr: `عقد جلسة فتح العطاءات للمناقصة ${n} (انتهى الموعد)` });
      }
      if (cfg.envelopes === 'TWO' && !t.financial_opened_at && ['OPENED', 'EVALUATION'].includes(t.status)) {
        out.push({ kind: 'OPEN_FINANCIAL', tenderId: t.id, tenderNumber: n, link: link(t.id),
          titleEn: `Open the financial envelopes of ${n} once technical scoring is complete`, titleAr: `فتح المظاريف المالية للمناقصة ${n} بعد اكتمال التقييم الفني` });
      }
      if (t.status === 'EVALUATION') {
        const aw = await ctx.db.query('SELECT 1 FROM awards WHERE tender_id=$1', [t.id]);
        if (!aw.length) out.push({ kind: 'RECOMMEND_AWARD', tenderId: t.id, tenderNumber: n, link: link(t.id),
          titleEn: `Recommend the award for ${n} when evaluation is complete`, titleAr: `التوصية بالترسية للمناقصة ${n} عند اكتمال التقييم` });
      }
    }
    if (hasRole(actor, 'EVALUATOR') && ['OPENED', 'EVALUATION'].includes(t.status)) {
      const rows = await ctx.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM bids b LEFT JOIN evaluations e ON e.bid_id=b.id AND e.evaluator_id=$2
          WHERE b.tender_id=$1 AND b.status='OPENED'
            AND (e.id IS NULL OR ($3::timestamptz IS NOT NULL AND b.technical_result='PASSED' AND e.submitted_at < $3::timestamptz))`,
        [t.id, actor.id, cfg.envelopes === 'TWO' ? t.financial_opened_at ?? null : null]);
      const k = Number(rows[0].n);
      if (k > 0) out.push({ kind: 'SCORE_BIDS', tenderId: t.id, tenderNumber: n, link: link(t.id), count: k,
        titleEn: `Score ${k} opened bid(s) on ${n}`, titleAr: `تقييم ${k} من العطاءات المفتوحة في ${n}` });
    }
  }

  // Award approval chain (N levels; the recommending chair never approves).
  const awards = await ctx.db.query<{ tender_id: string; recommended_by: string; created_at: Date; tender_number: string; title_en: string; title_ar: string }>(
    `SELECT a.tender_id, a.recommended_by, a.created_at, t.tender_number, t.title_en, t.title_ar FROM awards a JOIN tenders t ON t.id=a.tender_id
      WHERE a.tenant_id=$1 AND a.status='RECOMMENDED' AND t.status='EVALUATION'`, [tid]);
  for (const a of awards) {
    const t = tenders.find((x) => x.id === a.tender_id);
    if (!t) continue;
    const done = await currentRound(ctx.db, a.tender_id, 'AWARD', new Date(a.created_at));
    const w = waitingLevel(configOf(t).approvals.award, done, actor, a.recommended_by);
    if (w) out.push({ kind: 'APPROVE_AWARD', tenderId: a.tender_id, tenderNumber: a.tender_number, link: link(a.tender_id),
      titleEn: `Approve the award recommendation for ${a.tender_number} (level ${w.levelNo} of ${w.of}: ${w.level.labelEn})`,
      titleAr: `اعتماد توصية الترسية للمناقصة ${a.tender_number} (المستوى ${w.levelNo} من ${w.of}: ${w.level.labelAr})` });
  }

  // Departmental requests: approval chain of the entity's default template; officers convert approved requests.
  const reqs = await ctx.db.query<{ id: string; request_number: string; subject: string; status: string; created_by: string }>(
    `SELECT id, request_number, subject, status, created_by FROM procurement_requests WHERE tenant_id=$1 AND status IN ('SUBMITTED','IN_APPROVAL','APPROVED') ORDER BY created_at`, [tid]);
  if (reqs.length) {
    const chain = (await defaultTemplateConfig(ctx, tid)).approvals.request;
    for (const r of reqs) {
      const rl = `/procurement/requests/${r.id}`;
      if (r.status === 'APPROVED') {
        if (isOfficer) out.push({ kind: 'CONVERT_REQUEST', requestId: r.id, link: rl,
          titleEn: `Convert approved request ${r.request_number} (${r.subject}) into a tender`, titleAr: `تحويل الطلب المعتمد ${r.request_number} (${r.subject}) إلى مناقصة` });
        continue;
      }
      const done = await currentRound(ctx.db, r.id, 'REQUEST');
      const w = waitingLevel(chain, done, actor, r.created_by);
      if (w) out.push({ kind: 'APPROVE_REQUEST', requestId: r.id, link: rl,
        titleEn: `Decide on request ${r.request_number} — ${r.subject} (level ${w.levelNo} of ${w.of})`,
        titleAr: `البت في الطلب ${r.request_number} — ${r.subject} (المستوى ${w.levelNo} من ${w.of})` });
    }
  }

  if (hasRole(actor, 'PROCUREMENT_OFFICER')) {
    const pending = Number((await ctx.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM vendors WHERE tenant_id=$1 AND status='PENDING_REVIEW'`, [tid]))[0].n);
    if (pending > 0) out.push({ kind: 'REVIEW_VENDORS', link: '/procurement/vendors', count: pending,
      titleEn: `Review ${pending} vendor registration(s)`, titleAr: `مراجعة ${pending} من طلبات تسجيل الموردين` });
  }
  return out;
}

async function vendorTasks(ctx: Ctx, actor: Actor): Promise<Task[]> {
  const out: Task[] = [];
  if (!actor.vendorId) return out;
  const v = (await ctx.db.query<{ status: string; categories: string[] }>('SELECT status, categories FROM vendors WHERE id=$1 AND tenant_id=$2', [actor.vendorId, actor.tenantId]))[0];
  if (!v) return out;
  if (v.status === 'PENDING_REVIEW') {
    out.push({ kind: 'REGISTRATION_PENDING', link: '/vendor', titleEn: 'Your registration is under review: keep your company documents up to date',
      titleAr: 'تسجيلك قيد المراجعة: يرجى تحديث مستندات شركتك' });
    return out;
  }
  if (v.status !== 'APPROVED') return out;
  const tenders = await ctx.db.query<TenderRow>(
    `SELECT * FROM tenders WHERE tenant_id=$1 AND status='PUBLISHED' AND submission_deadline > $2 AND category = ANY($3::text[]) ORDER BY submission_deadline`,
    [actor.tenantId, now(), v.categories]);
  for (const t of tenders) {
    const e = await checkEligibility(ctx.db, t, actor.vendorId);
    if (!e.eligible) continue;
    const link = `/vendor/tenders/${t.id}`;
    const bid = await ctx.db.query('SELECT 1 FROM bids WHERE tender_id=$1 AND vendor_id=$2', [t.id, actor.vendorId]);
    const cfg = configOf(t);
    const due = new Date(t.submission_deadline);
    const days = Math.max(0, Math.ceil((due.getTime() - now().getTime()) / DAY));
    if (cfg.stages.documentPurchase) {
      const p = await ctx.db.query('SELECT 1 FROM tender_purchases WHERE tender_id=$1 AND vendor_id=$2', [t.id, actor.vendorId]);
      if (!p.length) out.push({ kind: 'PURCHASE_DOCUMENTS', tenderId: t.id, tenderNumber: t.tender_number, link, dueAt: due.toISOString(),
        titleEn: `Buy the tender documents of ${t.tender_number} (${cfg.fees.documentPrice} ${cfg.fees.currency}) before bidding`,
        titleAr: `شراء وثائق المناقصة ${t.tender_number} (${cfg.fees.documentPrice} ${cfg.fees.currency}) قبل تقديم العطاء` });
    }
    if (!bid.length && days <= 7) {
      out.push({ kind: 'BID_CLOSING_SOON', tenderId: t.id, tenderNumber: t.tender_number, link, dueAt: due.toISOString(),
        titleEn: `Submit your bid for ${t.tender_number} — ${t.title_en}: closes ${kuwaitTime(due)} Kuwait time (in ${days} day(s))`,
        titleAr: `قدّم عطاءك للمناقصة ${t.tender_number} — ${t.title_ar}: يغلق ${kuwaitTime(due)} بتوقيت الكويت (خلال ${days} يوم)` });
    }
  }
  const myQ = await ctx.db.query<{ tender_id: string; tender_number: string }>(
    `SELECT c.tender_id, t.tender_number FROM clarifications c JOIN tenders t ON t.id=c.tender_id
      WHERE c.tenant_id=$1 AND c.vendor_id=$2 AND c.status='OPEN' AND t.status='PUBLISHED'`, [actor.tenantId, actor.vendorId]);
  for (const q of myQ) out.push({ kind: 'CLARIFICATION_PENDING', tenderId: q.tender_id, tenderNumber: q.tender_number, link: `/vendor/tenders/${q.tender_id}`,
    titleEn: `Your clarification question on ${q.tender_number} is waiting for the procurement answer`,
    titleAr: `سؤال الاستيضاح الخاص بك في ${q.tender_number} بانتظار رد إدارة المشتريات` });
  return out;
}

/** Tasks for the caller's role(s), from the database only. */
export async function computeTasks(ctx: Ctx, actor: Actor): Promise<Task[]> {
  await closeDueTenders(ctx);
  if (isStaff(actor)) return staffTasks(ctx, actor);
  return vendorTasks(ctx, actor);
}
