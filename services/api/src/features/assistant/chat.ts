// TenderFlow Assistant (supervisor agent tenderflow_assistant). TenderFlow builds a ROLE-SCOPED context on the
// server for every turn — who the user is, their pending tasks, the entity's enforced rules and, when a tender id is
// given and the caller may see that tender, its summary, status and pack text. The context never contains bid
// documents (sealed or opened), evaluation scores, other vendors' data or AI runs. The agent only answers; it takes
// no action. Every turn is an ai_run (ASSISTANT_CHAT, tender_id NULL so chats never show in a tender's AI history).
import type { Ctx } from '../../ctx.js';
import { isStaff, isVendor } from '../../ctx.js';
import type { Actor } from '../../auth/tokens.js';
import type { DocText } from '../../ai/index.js';
import { ApiError, badRequest, camel, isUuid, reqStr, str } from '../../util.js';
import { configOf, getProfile, stageList, type CycleConfig } from '../../services/templates.js';
import { approvalChainView, loadTender, type TenderRow } from '../../services/tenders.js';
import { checkEligibility, GRADE_NAMES, ruleOf, vendorClassifications } from '../../services/eligibility.js';
import { docSummary, packDocTexts, recordRun } from '../../services/ai-runs.js';
import { computeTasks, defaultTemplateConfig, kuwaitTime, type Task } from './tasks.js';

const STATUS_AR: Record<string, string> = {
  DRAFT: 'مسودة', PENDING_APPROVAL: 'قيد الاعتماد', APPROVED: 'معتمدة', PUBLISHED: 'منشورة', CLOSED: 'مغلقة', OPENED: 'مفتوحة العطاءات',
  EVALUATION: 'قيد التقييم', AWARDED: 'تمت الترسية', CANCELLED: 'ملغاة',
};
const ROLE_AR: Record<string, string> = {
  VENDOR: 'مورد', PROCUREMENT_OFFICER: 'موظف مشتريات', DIRECTOR: 'مدير', UNDERSECRETARY: 'وكيل', COMMITTEE_CHAIR: 'رئيس اللجنة',
  EVALUATOR: 'مقيّم', TENANT_ADMIN: 'مسؤول النظام', AUDITOR: 'مدقق',
};

function chainText(levels: { role: string; labelEn: string; labelAr: string }[]) {
  return levels.map((l, i) => `level ${i + 1}: ${l.labelEn} / ${l.labelAr} (${l.role})`).join('; ');
}

/** Rules TenderFlow enforces in code, plus the entity's default template — facts, not AI output. */
function rulesText(cfg: CycleConfig): string {
  return [
    'TenderFlow enforces these rules on the server (they cannot be changed by configuration):',
    '- Sealed bids are encrypted when submitted and nobody can read them before the committee chair opens them after the submission deadline.',
    '- The person who created a tender cannot approve it; one person cannot approve two levels of the same approval chain.',
    '- The chair who recommends an award cannot approve that award.',
    '- Every state change is written to an append-only, HMAC-chained audit log.',
    '- AI results (including this assistant) are advisory: a person makes every decision.',
    'Default cycle template of this entity:',
    `- Request approval chain: ${chainText(cfg.approvals.request)}`,
    `- Publication approval chain: ${chainText(cfg.approvals.publish)}`,
    `- Award approval chain: ${chainText(cfg.approvals.award)}`,
    `- Envelopes: ${cfg.envelopes === 'TWO' ? `two (technical first; financial envelopes are opened only for bids that reach the technical pass mark of ${cfg.evaluation.technicalPassMark})` : 'one'}`,
    `- Paid tender documents: ${cfg.stages.documentPurchase ? `yes, ${cfg.fees.documentPrice} ${cfg.fees.currency}` : 'no'}`,
    `- Official gazette (Kuwait Al-Youm) notice: ${cfg.stages.gazette ? 'yes' : 'no'}; CAPT notice: ${cfg.stages.capt ? 'yes' : 'no'}`,
    `- Minimum vendor grade: ${cfg.eligibility.minGrade ? GRADE_NAMES[cfg.eligibility.minGrade].en : 'none'}`,
  ].join('\n');
}

function tasksText(tasks: Task[], lang: 'en' | 'ar' | 'both'): string {
  if (!tasks.length) return 'Number of pending tasks: 0. Nothing is waiting for this user.';
  const lines = tasks.map((t, i) => `${i + 1}. ${lang === 'ar' ? t.titleAr : t.titleEn}${lang === 'both' ? ` / ${t.titleAr}` : ''}`);
  return `Number of pending tasks: ${tasks.length}.\n${lines.join('\n')}`;
}

async function tenderContext(ctx: Ctx, actor: Actor, t: TenderRow): Promise<DocText[]> {
  const cfg = configOf(t);
  const rule = ruleOf(t);
  const sections: DocText['sections'] = [];
  sections.push({ section: 'Tender summary / ملخص المناقصة', text: [
    `Tender number: ${t.tender_number}`,
    `Title: ${t.title_en} / ${t.title_ar}`,
    `Category: ${t.category}`,
    `Status: ${t.status} / ${STATUS_AR[t.status] ?? t.status}`,
    `Submission deadline: ${kuwaitTime(t.submission_deadline)} Kuwait time`,
    t.estimated_budget !== null ? `Estimated budget: ${Number(t.estimated_budget)} ${t.currency}` : 'Estimated budget: not stated',
    `Cycle template: ${t.template_snapshot ? `${t.template_snapshot.nameEn} / ${t.template_snapshot.nameAr}` : 'TenderFlow default'}`,
    `Envelopes: ${cfg.envelopes === 'TWO' ? `two (technical pass mark ${cfg.evaluation.technicalPassMark})` : 'one'}`,
    `Eligibility rule: activity codes ${rule.activityCodes.length ? rule.activityCodes.join(', ') : 'any'}; minimum grade ${rule.minGrade ? GRADE_NAMES[rule.minGrade].en : 'none'}`,
    `Paid documents: ${cfg.stages.documentPurchase ? `${cfg.fees.documentPrice} ${cfg.fees.currency}` : 'no'}`,
  ].join('\n') });
  if (t.description_en || t.description_ar) sections.push({ section: 'Description / الوصف', text: `${t.description_en}\n${t.description_ar}`.trim() });
  sections.push({ section: 'Evaluation criteria / معايير التقييم', text: t.criteria.map((c) => `- ${c.name_en} / ${c.name_ar}: weight ${c.weight}%`).join('\n') || 'none' });
  sections.push({ section: 'Required bid documents / المستندات المطلوبة', text: t.required_documents.map((d) => `- ${d.name_en} / ${d.name_ar}`).join('\n') || 'none' });
  sections.push({ section: 'Cycle stages / مراحل الدورة', text: stageList(cfg).filter((s) => s.enabled).map((s) => `- ${s.key}${s.detail ? ` (${s.detail})` : ''}`).join('\n') });

  const answered = await ctx.db.query<{ question: string; answer: string }>(
    `SELECT question, answer FROM clarifications WHERE tender_id=$1 AND status='ANSWERED' ORDER BY answered_at`, [t.id]);
  if (answered.length) sections.push({ section: 'Published clarification answers / ردود الاستيضاح المنشورة',
    text: answered.map((c) => `Q: ${c.question}\nA: ${c.answer}`).join('\n\n') });

  if (isStaff(actor)) {
    const chain = await approvalChainView(ctx.db, t.id, 'PUBLISH', cfg.approvals.publish);
    const counts = (await ctx.db.query<{ bids: string; open_q: string; pack: string }>(
      `SELECT (SELECT count(*) FROM bids WHERE tender_id=$1)::text AS bids,
              (SELECT count(*) FROM clarifications WHERE tender_id=$1 AND status='OPEN')::text AS open_q,
              (SELECT count(*) FROM documents WHERE tender_id=$1 AND owner_type IN ('TENDER_PACK','ADDENDUM'))::text AS pack`, [t.id]))[0];
    const pubs = await ctx.db.query<{ channel: string; status: string; reference: string | null }>(
      'SELECT channel, status, reference FROM publications WHERE tender_id=$1 ORDER BY channel', [t.id]);
    sections.push({ section: 'Workflow status (staff view) / حالة سير العمل', text: [
      `Publication approval chain: ${chain.map((c) => `level ${c.level} ${c.labelEn} (${c.role}): ${c.decision}${c.approverName ? ` by ${c.approverName}` : ''}`).join('; ')}`,
      `Bids received: ${counts.bids} (bid contents are sealed or restricted and are not part of this context)`,
      `Open clarification questions: ${counts.open_q}`,
      `Pack documents and addenda: ${counts.pack}`,
      `Publications: ${pubs.length ? pubs.map((p) => `${p.channel} ${p.status}${p.reference ? ` (reference ${p.reference})` : ''}`).join('; ') : 'none'}`,
    ].join('\n') });
  } else if (actor.vendorId) {
    const e = await checkEligibility(ctx.db, t, actor.vendorId);
    const purchase = (await ctx.db.query<{ receipt_number: string; status: string }>(
      'SELECT receipt_number, status FROM tender_purchases WHERE tender_id=$1 AND vendor_id=$2', [t.id, actor.vendorId]))[0];
    const bid = (await ctx.db.query<{ status: string; submitted_at: Date }>(
      'SELECT status, submitted_at FROM bids WHERE tender_id=$1 AND vendor_id=$2', [t.id, actor.vendorId]))[0];
    const myQ = await ctx.db.query<{ question: string; status: string }>(
      'SELECT question, status FROM clarifications WHERE tender_id=$1 AND vendor_id=$2 ORDER BY created_at', [t.id, actor.vendorId]);
    sections.push({ section: 'Your position on this tender / موقفك من هذه المناقصة', text: [
      `Eligible: ${e.eligible ? 'yes' : 'no'}${e.reasons.length ? ` (${e.reasons.map((r) => r.en).join('; ')})` : ''}`,
      `Tender documents purchase: ${cfg.stages.documentPurchase ? (purchase ? `done (receipt ${purchase.receipt_number})` : 'required, not yet done') : 'not required'}`,
      `Your bid: ${bid ? `submitted ${kuwaitTime(bid.submitted_at)} Kuwait time, status ${bid.status}` : 'not submitted'}`,
      `Your clarification questions: ${myQ.length ? myQ.map((q) => `"${q.question}" (${q.status})`).join('; ') : 'none'}`,
    ].join('\n') });
  }
  // Paid tender documents: a vendor that has not bought them gets no pack text (only the public summary above).
  let packAllowed = true;
  if (!isStaff(actor) && actor.vendorId && cfg.stages.documentPurchase) {
    packAllowed = (await ctx.db.query('SELECT 1 FROM tender_purchases WHERE tender_id=$1 AND vendor_id=$2', [t.id, actor.vendorId])).length > 0;
    if (!packAllowed) sections.push({ section: 'Tender documents / وثائق المناقصة', text: 'The tender documents are sold through the portal; their text is not included until you buy them.' });
  }
  const tenderDoc: DocText = { documentId: t.id, title: `Tender ${t.tender_number} (TenderFlow record)`, sections };
  const pack = packAllowed ? await packDocTexts(ctx, t) : [];
  return [tenderDoc, ...pack];
}

export async function buildChatContext(ctx: Ctx, actor: Actor, opts: { page?: string | null; tender?: TenderRow | null }): Promise<{ docs: DocText[]; tasks: Task[] }> {
  const profile = await getProfile(ctx, actor.tenantId);
  const user = (await ctx.db.query<{ display_name: string }>('SELECT display_name FROM users WHERE id=$1 AND tenant_id=$2', [actor.id, actor.tenantId]))[0];
  const tasks = await computeTasks(ctx, actor);
  const sections: DocText['sections'] = [];
  sections.push({ section: 'Signed-in user / المستخدم', text: [
    `Name: ${user?.display_name ?? actor.username}`,
    `Role(s): ${actor.roles.map((r) => `${r} / ${ROLE_AR[r] ?? r}`).join(', ')}`,
    `Entity: ${profile.nameEn} / ${profile.nameAr}`,
    `Portal: ${isVendor(actor) ? 'vendor portal' : 'procurement / administration'}`,
    opts.page ? `Current page: ${opts.page}` : '',
  ].filter(Boolean).join('\n') });
  sections.push({ section: 'Pending tasks (computed by TenderFlow) / المهام المعلقة', text: tasksText(tasks, 'both') });
  if (isVendor(actor) && actor.vendorId) {
    const v = (await ctx.db.query<{ legal_name_en: string; legal_name_ar: string; status: string; categories: string[] }>(
      'SELECT legal_name_en, legal_name_ar, status, categories FROM vendors WHERE id=$1 AND tenant_id=$2', [actor.vendorId, actor.tenantId]))[0];
    const cls = await vendorClassifications(ctx.db, actor.tenantId, actor.vendorId);
    if (v) sections.push({ section: 'Your company / شركتك', text: [
      `Company: ${v.legal_name_en} / ${v.legal_name_ar}`,
      `Registration status: ${v.status}`,
      `Business categories: ${v.categories.join(', ')}`,
      `Activity codes and grades: ${cls.length ? cls.map((c: any) => `${c.activityCode} (${c.nameEn ?? ''}) ${GRADE_NAMES[Number(c.grade)]?.en ?? c.grade}`).join('; ') : 'none registered'}`,
    ].join('\n') });
  }
  sections.push({ section: 'Procurement rules / قواعد المشتريات', text: rulesText(await defaultTemplateConfig(ctx, actor.tenantId)) });
  const docs: DocText[] = [{ documentId: 'tenderflow-context', title: 'TenderFlow context for this user', sections }];
  if (opts.tender) docs.push(...(await tenderContext(ctx, actor, opts.tender)));
  return { docs, tasks };
}

/** True when this user received this Orchestrate thread id from an earlier chat turn (threads are never shared). */
async function ownsThread(ctx: Ctx, actor: Actor, threadId: string): Promise<boolean> {
  const r = await ctx.db.query(
    `SELECT 1 FROM ai_runs WHERE tenant_id=$1 AND requested_by=$2 AND kind='ASSISTANT_CHAT' AND status='OK'
        AND request->'orchestrate'->>'threadId' = $3 LIMIT 1`, [actor.tenantId, actor.id, threadId]);
  return r.length > 0;
}

export async function chat(ctx: Ctx, actor: Actor, b: any) {
  const message = reqStr(b?.message, 'message', 2000);
  const page = str(b?.page, 'page', { max: 200 }) ?? null;
  const threadId = str(b?.threadId, 'threadId', { max: 200 }) ?? undefined;
  if (threadId && !/^[A-Za-z0-9_.:-]+$/.test(threadId)) throw badRequest('threadId is invalid');
  if (threadId && !(await ownsThread(ctx, actor, threadId))) throw new ApiError(404, 'THREAD_NOT_FOUND', 'Conversation not found for this user; start a new one');
  let tender: TenderRow | null = null;
  if (b?.tenderId !== undefined && b?.tenderId !== null && b?.tenderId !== '') {
    if (!isUuid(b.tenderId)) throw badRequest('tenderId is invalid');
    tender = await loadTender(ctx, actor, b.tenderId); // 404 unless the caller may see this tender
  }
  const { docs } = await buildChatContext(ctx, actor, { page, tender });
  const run = await recordRun(ctx, actor, null, 'ASSISTANT_CHAT',
    { message, page, tenderId: tender?.id ?? null, threadIn: threadId ?? null, context: docSummary(docs) },
    () => ctx.ai.chat({ message, threadId, context: docs }));
  const out = run.response ?? {};
  return {
    answer: out.answer, notFound: out.notFound === true, structured: out.structured !== false,
    citations: run.citations ?? [], threadId: run.request?.orchestrate?.threadId ?? null,
    runId: run.id, orchestrateRunId: run.request?.orchestrate?.runId ?? null, agent: run.agent, model: run.model, createdAt: run.createdAt,
  };
}

export async function myTasks(ctx: Ctx, actor: Actor) {
  return camel(await computeTasks(ctx, actor));
}
