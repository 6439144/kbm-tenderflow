// Specialist Orchestrate agents across the cycle. TenderFlow gathers the input (records + document text from the
// content store), calls the agent through ctx.ai, validates the answer and records an ai_run (+ audit). Every
// result is advisory: saving a notice, accepting a classification or storing a narrative is a separate human action.
import type { Ctx } from '../../ctx.js';
import { auditTx } from '../../ctx.js';
import type { Actor } from '../../auth/tokens.js';
import type { DocText, NarrateEvaluationInput, RelevanceCandidate } from '../../ai/index.js';
import { gradeCriteria } from '../../ai/index.js';
import { ApiError, badRequest, camel, conflict, escapeHtml, forbidden, isUuid, notFound, now, str } from '../../util.js';
import { extractText } from '../../content/extract.js';
import { insertDocument, publicDoc, putDocument, readPlain, type DocumentRow } from '../../services/documents.js';
import { configOf, getProfile } from '../../services/templates.js';
import { closeDueTenders, loadTender, type TenderRow } from '../../services/tenders.js';
import { checkEligibility, GRADE_NAMES, listActivityCodes, ruleOf, vendorClassifications } from '../../services/eligibility.js';
import { loadRequest, type RequestRow } from '../../services/requests.js';
import { getVendorRow } from '../../services/vendors.js';
import { docSummary, packDocTexts, recordRun } from '../../services/ai-runs.js';
import { defaultTemplateConfig, kuwaitTime } from './tasks.js';

const aiDisabled = (what: string) => conflict('AI_DISABLED', `The cycle template switches off the AI ${what} for this tender`);

// ---------------------------------------------------------------- 1. request classification

function requestRecordDoc(r: RequestRow): DocText {
  const sections: DocText['sections'] = [
    { section: 'Subject / الموضوع', text: r.subject },
    { section: 'Department / الإدارة', text: r.department },
  ];
  if (r.description) sections.push({ section: 'Description / الوصف', text: r.description });
  if (r.estimated_budget !== null) sections.push({ section: 'Registered estimated budget / الميزانية التقديرية المسجلة', text: `${Number(r.estimated_budget)} KWD` });
  return { documentId: r.id, title: `Request ${r.request_number} (TenderFlow record)`, sections };
}

export async function classifyRequest(ctx: Ctx, actor: Actor, id: string) {
  const r = await loadRequest(ctx, actor, id);
  if (!(await defaultTemplateConfig(ctx, actor.tenantId)).ai.requestClassify) throw conflict('AI_DISABLED', 'Request classification is switched off in the default cycle template');
  const documents: DocText[] = [requestRecordDoc(r)];
  if (r.letter_document_id) {
    const d = (await ctx.db.query<DocumentRow>('SELECT * FROM documents WHERE id=$1 AND tenant_id=$2', [r.letter_document_id, actor.tenantId]))[0];
    if (d && !d.encrypted) {
      const text = await extractText({ documentId: d.id, title: d.title, mimeType: d.mime_type }, await readPlain(ctx, d));
      if (text.sections.length) documents.push(text);
    }
  }
  const templates = camel<any[]>(await ctx.db.query(
    `SELECT DISTINCT ON (code) code, name_en, name_ar FROM cycle_templates WHERE tenant_id=$1 AND status='PUBLISHED' ORDER BY code, version DESC`, [actor.tenantId]));
  if (!templates.length) throw conflict('NO_TEMPLATES', 'Publish at least one cycle template before classifying requests');
  const activityCodes = camel<any[]>(await listActivityCodes(ctx, actor.tenantId));
  return recordRun(ctx, actor, null, 'REQUEST_CLASSIFY',
    { requestId: r.id, letterExtracted: documents.length > 1, documents: docSummary(documents) },
    () => ctx.ai.classifyRequest({
      request: { requestNumber: r.request_number, department: r.department, subject: r.subject, source: r.source, sourceReference: r.source_reference },
      documents, templates, activityCodes,
    }), { subjectId: r.id });
}

// ---------------------------------------------------------------- 2. gazette / CAPT notice

const NOTICE_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PUBLISHED'];

export async function draftNotice(ctx: Ctx, actor: Actor, tenderId: string, b: any) {
  const t = await loadTender(ctx, actor, tenderId);
  const channel = b?.channel;
  if (channel !== 'KUWAIT_ALYOUM' && channel !== 'CAPT') throw badRequest('channel must be KUWAIT_ALYOUM or CAPT');
  const cfg = configOf(t);
  if (!(channel === 'KUWAIT_ALYOUM' ? cfg.stages.gazette : cfg.stages.capt)) throw conflict('CHANNEL_DISABLED', `The cycle template of this tender does not use ${channel}`);
  if (!cfg.ai.gazette) throw aiDisabled('notice drafter');
  if (!NOTICE_STATUSES.includes(t.status)) throw conflict('INVALID_STATE', `Notices cannot be drafted for a ${t.status} tender`);
  const ex = (await ctx.db.query<{ status: string }>('SELECT status FROM publications WHERE tender_id=$1 AND channel=$2', [t.id, channel]))[0];
  if (ex?.status === 'PUBLISHED') throw conflict('INVALID_STATE', 'This notice is already published');
  const documents = await packDocTexts(ctx, t);
  if (!documents.some((d) => d.sections.length)) throw conflict('PACK_MISSING', 'The tender has no pack text to draft a notice from');
  const profile = await getProfile(ctx, actor.tenantId);
  const rule = ruleOf(t);
  const codes = rule.activityCodes.length ? camel<any[]>(await ctx.db.query(
    'SELECT code, name_en, name_ar FROM activity_codes WHERE tenant_id=$1 AND code = ANY($2::text[]) ORDER BY code', [actor.tenantId, rule.activityCodes])) : [];
  const facts = [
    { label: 'Entity (English)', value: profile.nameEn },
    { label: 'Entity (Arabic)', value: profile.nameAr },
    { label: 'Tender number', value: t.tender_number },
    { label: 'Title (English)', value: t.title_en },
    { label: 'Title (Arabic)', value: t.title_ar },
    { label: 'Category', value: t.category },
    { label: 'Submission deadline (Kuwait time)', value: kuwaitTime(t.submission_deadline) },
    { label: 'Envelopes', value: cfg.envelopes === 'TWO' ? `Two envelopes: technical then financial (technical pass mark ${cfg.evaluation.technicalPassMark})` : 'One sealed envelope' },
    { label: 'Tender documents', value: cfg.stages.documentPurchase ? `Sold through the TenderFlow portal at ${cfg.fees.documentPrice} ${cfg.fees.currency}` : 'Available free of charge through the TenderFlow portal' },
    { label: 'Eligible activity codes', value: codes.length ? codes.map((c) => `${c.code} ${c.nameEn} / ${c.nameAr}`).join('; ') : 'Not restricted by activity code' },
    { label: 'Minimum vendor grade', value: rule.minGrade ? `${GRADE_NAMES[rule.minGrade].en} / ${GRADE_NAMES[rule.minGrade].ar}` : 'None' },
    { label: 'Submission', value: 'Bids are submitted electronically through the TenderFlow portal before the deadline; clarification questions are submitted through the portal.' },
  ];
  if (t.description_en) facts.push({ label: 'Description (English)', value: t.description_en });
  if (t.description_ar) facts.push({ label: 'Description (Arabic)', value: t.description_ar });
  return recordRun(ctx, actor, t.id, 'GAZETTE_NOTICE', { channel, documents: docSummary(documents) },
    () => ctx.ai.draftNotice({ channel, facts, documents }));
}

// ---------------------------------------------------------------- 3. relevance (ranking only; eligibility is rule-based)

async function vendorProfile(ctx: Ctx, tenantId: string, v: { id: string; legal_name_en: string; legal_name_ar: string; categories: string[]; created_at: Date }) {
  const cls = await vendorClassifications(ctx.db, tenantId, v.id);
  const stats = (await ctx.db.query<{ bids: string; awards: string }>(
    `SELECT (SELECT count(*) FROM bids WHERE vendor_id=$1)::text AS bids,
            (SELECT count(*) FROM awards a JOIN bids b ON b.id=a.bid_id WHERE b.vendor_id=$1 AND a.status='APPROVED')::text AS awards`, [v.id]))[0];
  const docs = await ctx.db.query<{ title: string }>(`SELECT title FROM documents WHERE vendor_id=$1 AND owner_type='VENDOR' ORDER BY created_at`, [v.id]);
  return {
    nameEn: v.legal_name_en, nameAr: v.legal_name_ar, categories: v.categories,
    activityCodes: cls.map((c: any) => ({ code: c.activityCode, name: c.nameEn, grade: GRADE_NAMES[Number(c.grade)]?.en ?? String(c.grade) })),
    pastBidsCount: Number(stats.bids), awardsWonCount: Number(stats.awards), companyDocuments: docs.map((d) => d.title),
    registeredSince: new Date(v.created_at).toISOString().slice(0, 10),
  };
}

function tenderProfile(t: TenderRow) {
  const rule = ruleOf(t);
  return {
    tenderNumber: t.tender_number, titleEn: t.title_en, titleAr: t.title_ar, category: t.category,
    descriptionEn: t.description_en, descriptionAr: t.description_ar,
    activityCodes: rule.activityCodes, minimumGrade: rule.minGrade ? GRADE_NAMES[rule.minGrade].en : null,
    estimatedBudget: t.estimated_budget === null ? null : Number(t.estimated_budget), currency: t.currency,
    criteria: t.criteria.map((c) => `${c.name_en} ${c.weight}%`), submissionDeadlineKuwait: kuwaitTime(t.submission_deadline),
  };
}

export async function rankVendorsForTender(ctx: Ctx, actor: Actor, tenderId: string) {
  const t = await loadTender(ctx, actor, tenderId);
  if (t.status !== 'PUBLISHED') throw conflict('INVALID_STATE', 'Vendor relevance ranking is available while the tender is PUBLISHED');
  if (!configOf(t).ai.relevance) throw aiDisabled('relevance matcher');
  const vendors = await ctx.db.query<{ id: string; legal_name_en: string; legal_name_ar: string; categories: string[]; created_at: Date }>(
    `SELECT id, legal_name_en, legal_name_ar, categories, created_at FROM vendors WHERE tenant_id=$1 AND status='APPROVED' AND $2 = ANY(categories) ORDER BY legal_name_en`,
    [actor.tenantId, t.category]);
  const candidates: (RelevanceCandidate & { nameAr: string })[] = [];
  for (const v of vendors) {
    if (!(await checkEligibility(ctx.db, t, v.id)).eligible) continue; // rules decide eligibility; AI only ranks
    candidates.push({ id: v.id, label: v.legal_name_en, nameAr: v.legal_name_ar, profile: await vendorProfile(ctx, actor.tenantId, v) });
  }
  if (!candidates.length) throw conflict('NO_ELIGIBLE_VENDORS', 'No approved vendor meets the eligibility rule of this tender');
  const label = new Map(candidates.map((c) => [c.id, c]));
  return recordRun(ctx, actor, t.id, 'RELEVANCE_MATCH',
    { mode: 'VENDORS_FOR_TENDER', eligibleCandidates: candidates.length, candidates: candidates.map((c) => ({ id: c.id, nameEn: c.label })) },
    async () => {
      const res = await ctx.ai.rankRelevance({ mode: 'VENDORS_FOR_TENDER', subject: { id: t.id, label: `${t.tender_number} ${t.title_en}`, profile: tenderProfile(t) },
        candidates: candidates.map(({ nameAr: _n, ...c }) => c) });
      // Display names are added by TenderFlow from its own records (not by the model).
      return { ...res, output: { ranked: res.output.ranked.map((x) => ({ ...x, nameEn: label.get(x.id)!.label, nameAr: label.get(x.id)!.nameAr })) } };
    });
}

async function eligibleOpenTenders(ctx: Ctx, actor: Actor): Promise<TenderRow[]> {
  await closeDueTenders(ctx);
  const v = (await ctx.db.query<{ status: string; categories: string[] }>('SELECT status, categories FROM vendors WHERE id=$1 AND tenant_id=$2', [actor.vendorId, actor.tenantId]))[0];
  if (!v) throw notFound('Vendor');
  if (v.status !== 'APPROVED') throw conflict('VENDOR_NOT_APPROVED', 'Your company registration must be approved first');
  const tenders = await ctx.db.query<TenderRow>(
    `SELECT * FROM tenders WHERE tenant_id=$1 AND status='PUBLISHED' AND submission_deadline > $2 AND category = ANY($3::text[]) ORDER BY submission_deadline`,
    [actor.tenantId, now(), v.categories]);
  const out: TenderRow[] = [];
  for (const t of tenders) if (configOf(t).ai.relevance && (await checkEligibility(ctx.db, t, actor.vendorId!)).eligible) out.push(t);
  return out;
}

function forVendorView(run: any, open: TenderRow[]) {
  const byId = new Map(open.map((t) => [t.id, t]));
  const ranked = run && run.status === 'OK' ? (run.response?.ranked ?? []) : [];
  return {
    run: run ? { id: run.id, status: run.status, error: run.error ?? null, agent: run.agent, model: run.model, createdAt: run.createdAt ?? run.created_at, reviewDecision: run.reviewDecision ?? null } : null,
    // Only tenders that are STILL open and eligible are shown (a stored ranking never widens access).
    ranked: ranked.filter((x: any) => byId.has(x.id)).map((x: any) => {
      const t = byId.get(x.id)!;
      return { tenderId: t.id, tenderNumber: t.tender_number, titleEn: t.title_en, titleAr: t.title_ar, category: t.category,
        submissionDeadline: new Date(t.submission_deadline).toISOString(), score: x.score, reasonsEn: x.reasonsEn, reasonsAr: x.reasonsAr };
    }),
    eligibleOpenCount: open.length,
  };
}

export async function tendersForMe(ctx: Ctx, actor: Actor) {
  if (!actor.vendorId) throw forbidden('Only vendor users have a tender ranking');
  // A company whose registration is not approved yet simply has no eligible tenders to show (the dashboard asks on
  // every visit); ranking (POST) still refuses with VENDOR_NOT_APPROVED.
  const st = (await ctx.db.query<{ status: string }>('SELECT status FROM vendors WHERE id=$1 AND tenant_id=$2', [actor.vendorId, actor.tenantId]))[0];
  if (st && st.status !== 'APPROVED') return { configured: ctx.ai.isConfigured(), vendorApproved: false, ...forVendorView(null, []) };
  const open = await eligibleOpenTenders(ctx, actor);
  const last = (await ctx.db.query<any>(
    `SELECT * FROM ai_runs WHERE tenant_id=$1 AND kind='RELEVANCE_MATCH' AND subject_id=$2 ORDER BY created_at DESC LIMIT 1`, [actor.tenantId, actor.vendorId]))[0];
  return { configured: ctx.ai.isConfigured(), ...forVendorView(last ? camel(last) : null, open) };
}

export async function rankTendersForMe(ctx: Ctx, actor: Actor) {
  if (!actor.vendorId) throw forbidden('Only vendor users have a tender ranking');
  const open = await eligibleOpenTenders(ctx, actor);
  if (!open.length) return { configured: ctx.ai.isConfigured(), run: null, ranked: [], eligibleOpenCount: 0 };
  const v = (await ctx.db.query<{ id: string; legal_name_en: string; legal_name_ar: string; categories: string[]; created_at: Date }>(
    'SELECT id, legal_name_en, legal_name_ar, categories, created_at FROM vendors WHERE id=$1 AND tenant_id=$2', [actor.vendorId, actor.tenantId]))[0];
  const subject = { id: v.id, label: v.legal_name_en, profile: await vendorProfile(ctx, actor.tenantId, v) };
  const run = await recordRun(ctx, actor, null, 'RELEVANCE_MATCH',
    { mode: 'TENDERS_FOR_VENDOR', eligibleCandidates: open.length, candidates: open.map((t) => ({ id: t.id, tenderNumber: t.tender_number })) },
    () => ctx.ai.rankRelevance({ mode: 'TENDERS_FOR_VENDOR', subject,
      candidates: open.map((t) => ({ id: t.id, label: `${t.tender_number} ${t.title_en}`, profile: tenderProfile(t) })) }),
    { subjectId: actor.vendorId });
  return { configured: true, ...forVendorView(run, open) };
}

// ---------------------------------------------------------------- 4. evaluation narrative (chair)

export async function narrativeInput(ctx: Ctx, t: TenderRow): Promise<{ input: NarrateEvaluationInput; refs: Record<string, string> }> {
  const cfg = configOf(t);
  const bids = await ctx.db.query<{ id: string; legal_name_en: string; legal_name_ar: string; technical_result: string | null }>(
    `SELECT b.id, v.legal_name_en, v.legal_name_ar, b.technical_result FROM bids b JOIN vendors v ON v.id=b.vendor_id
      WHERE b.tender_id=$1 AND b.status='OPENED' ORDER BY b.submitted_at`, [t.id]);
  const evals = await ctx.db.query<{ bid_id: string; scores: { criterion: string; score: number; comment: string }[]; weighted_total: string; display_name: string }>(
    `SELECT e.bid_id, e.scores, e.weighted_total, u.display_name FROM evaluations e JOIN users u ON u.id=e.evaluator_id WHERE e.tender_id=$1 ORDER BY e.submitted_at`, [t.id]);
  if (!evals.length) throw conflict('NO_EVALUATIONS', 'No evaluator has scored a bid yet');
  const screens = await ctx.db.query<{ request: any; response: any }>(
    `SELECT request, response FROM ai_runs WHERE tender_id=$1 AND kind='COMPLIANCE_SCREEN' AND status='OK' ORDER BY created_at DESC`, [t.id]);
  const award = (await ctx.db.query<{ bid_id: string; justification: string }>('SELECT bid_id, justification FROM awards WHERE tender_id=$1', [t.id]))[0];
  const refs: Record<string, string> = {};
  const rows = bids.map((b, i) => {
    const ref = `BID-${i + 1}`; refs[ref] = b.id;
    const ev = evals.filter((e) => e.bid_id === b.id).map((e) => ({
      evaluator: e.display_name, weightedTotal: Number(e.weighted_total),
      scores: (e.scores ?? []).map((s) => ({ criterion: s.criterion, score: Number(s.score), comment: s.comment ?? '' })),
    }));
    const avg = ev.length ? Math.round((ev.reduce((a, x) => a + x.weightedTotal, 0) / ev.length) * 100) / 100 : null;
    const scr = screens.find((s) => s.request?.bidId === b.id);
    return { bidRef: ref, vendorNameEn: b.legal_name_en, vendorNameAr: b.legal_name_ar, technicalResult: b.technical_result,
      evaluations: ev, averageWeightedTotal: avg, compliance: scr?.response?.items?.map((x: any) => ({ requirement: x.requirement, status: x.status })) ?? null };
  });
  const ranked = [...rows].filter((r) => r.averageWeightedTotal !== null).sort((a, b) => b.averageWeightedTotal! - a.averageWeightedTotal!);
  const withRank = rows.map((r) => ({ ...r, rankByAverage: r.averageWeightedTotal === null ? null : ranked.indexOf(r) + 1 }));
  const recRef = award ? Object.keys(refs).find((k) => refs[k] === award.bid_id) ?? null : null;
  return {
    refs,
    input: {
      tender: { tenderNumber: t.tender_number, titleEn: t.title_en, titleAr: t.title_ar, envelopes: cfg.envelopes, technicalPassMark: cfg.evaluation.technicalPassMark },
      criteria: t.criteria.map((c) => ({ key: c.key, nameEn: c.name_en, nameAr: c.name_ar, weight: Number(c.weight) })),
      bids: withRank as NarrateEvaluationInput['bids'],
      recommendedBidRef: recRef, recommendationJustification: award?.justification ?? null,
    },
  };
}

export async function draftNarrative(ctx: Ctx, actor: Actor, tenderId: string) {
  const t = await loadTender(ctx, actor, tenderId);
  if (!['EVALUATION', 'AWARDED'].includes(t.status)) throw conflict('INVALID_STATE', 'The evaluation narrative is available during EVALUATION or after AWARD');
  if (!configOf(t).ai.narrative) throw aiDisabled('evaluation narrator');
  const { input, refs } = await narrativeInput(ctx, t);
  return recordRun(ctx, actor, t.id, 'EVALUATION_NARRATIVE', { bidRefs: refs, bids: input.bids.length, evaluations: input.bids.reduce((a, b) => a + b.evaluations.length, 0) },
    () => ctx.ai.narrateEvaluation(input));
}

export async function saveNarrative(ctx: Ctx, actor: Actor, runId: string, b: any) {
  if (!isUuid(runId)) throw notFound('AI run');
  const run = (await ctx.db.query<any>('SELECT * FROM ai_runs WHERE id=$1 AND tenant_id=$2', [runId, actor.tenantId]))[0];
  if (!run || run.kind !== 'EVALUATION_NARRATIVE') throw notFound('Evaluation narrative run');
  if (run.status !== 'OK') throw conflict('INVALID_STATE', 'Only a successful narrative run can be saved');
  if (run.review_decision) throw conflict('ALREADY_REVIEWED', `This narrative was already ${String(run.review_decision).toLowerCase()}`);
  const t = await loadTender(ctx, actor, run.tender_id);
  if (t.records_locked_at) throw conflict('RECORDS_LOCKED', 'The records of this tender are locked; no new documents can be added');
  const ai = run.response ?? {};
  const narrativeEn = str(b?.narrativeEn, 'narrativeEn', { max: 20000 }) ?? ai.narrativeEn;
  const narrativeAr = str(b?.narrativeAr, 'narrativeAr', { max: 20000 }) ?? ai.narrativeAr;
  if (!narrativeEn || !narrativeAr) throw badRequest('narrativeEn and narrativeAr are required');
  const edited = narrativeEn !== ai.narrativeEn || narrativeAr !== ai.narrativeAr;
  const decision = edited ? 'EDITED' : 'ACCEPTED';
  const chair = (await ctx.db.query<{ display_name: string }>('SELECT display_name FROM users WHERE id=$1', [actor.id]))[0]?.display_name ?? actor.username;
  const at = now();
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Evaluation narrative ${escapeHtml(t.tender_number)}</title>
<style>body{font-family:system-ui,Segoe UI,Tahoma,sans-serif;margin:32px;max-width:820px;line-height:1.55}.ar{direction:rtl;text-align:right}.meta{color:#555;font-size:13px}</style></head><body>
<h1>Committee evaluation narrative — ${escapeHtml(t.tender_number)}</h1>
<p>${escapeHtml(t.title_en)} / <span class="ar">${escapeHtml(t.title_ar)}</span></p>
<p class="meta">Drafted by the TenderFlow evaluation narrator (watsonx Orchestrate agent ${escapeHtml(run.agent ?? '')}${run.model ? `, model ${escapeHtml(run.model)}` : ''}; TenderFlow AI run ${escapeHtml(run.id)}).
${edited ? 'Edited' : 'Accepted without changes'} by ${escapeHtml(chair)} (committee chair) on ${escapeHtml(kuwaitTime(at))} Kuwait time.
The evaluators' scores recorded in TenderFlow are authoritative; this narrative is advisory text.</p>
<h2>English</h2><div>${escapeHtml(narrativeEn).replace(/\n/g, '<br>')}</div>
<h2 class="ar">العربية</h2><div class="ar">${escapeHtml(narrativeAr).replace(/\n/g, '<br>')}</div></body></html>`;
  const prepared = await putDocument(ctx, {
    tenantId: actor.tenantId, ownerType: 'EVALUATION_NARRATIVE', ownerId: run.id, tenderId: t.id, tenderNumber: t.tender_number,
    title: `Evaluation narrative ${t.tender_number}`, fileName: `evaluation-narrative-${t.tender_number}.html`, mimeType: 'text/html',
    bytes: Buffer.from(html, 'utf8'), uploadedBy: actor.id,
  });
  return ctx.db.tx(async (q) => {
    const upd = await q.query(`UPDATE ai_runs SET reviewed_by=$1, review_decision=$2 WHERE id=$3 AND review_decision IS NULL RETURNING id`, [actor.id, decision, run.id]);
    if (!upd.length) throw conflict('ALREADY_REVIEWED', 'This narrative was already saved');
    const doc = await insertDocument(q, prepared);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'AI_ADVISORY_REVIEWED', resourceType: 'AI_RUN', resourceId: run.id,
      newState: decision, details: { kind: run.kind, tenderId: t.id } });
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'EVALUATION_NARRATIVE_SAVED', resourceType: 'TENDER', resourceId: t.id,
      details: { documentId: doc.id, sha256: doc.sha256_plain, storeType: doc.store_type, storeRef: doc.store_ref, aiRunId: run.id, edited } });
    return { reviewDecision: decision, document: publicDoc(doc) };
  });
}

export async function listNarratives(ctx: Ctx, actor: Actor, tenderId: string) {
  const t = await loadTender(ctx, actor, tenderId);
  const docs = await ctx.db.query<DocumentRow>(
    `SELECT * FROM documents WHERE tender_id=$1 AND tenant_id=$2 AND owner_type='EVALUATION_NARRATIVE' ORDER BY created_at DESC`, [t.id, actor.tenantId]);
  return docs.map(publicDoc);
}

// ---------------------------------------------------------------- 5. vendor grade document review

export async function gradeReview(ctx: Ctx, actor: Actor, vendorId: string, b: any) {
  const grade = Number(b?.grade);
  if (![1, 2, 3].includes(grade)) throw badRequest('grade must be 1 (First), 2 (Second) or 3 (Third)');
  const v = await getVendorRow(ctx, actor.tenantId, vendorId);
  let criteria;
  try { criteria = gradeCriteria(grade as 1 | 2 | 3); } catch (e) { throw new ApiError(500, 'GRADE_CRITERIA_INVALID', (e as Error).message); }
  const rows = await ctx.db.query<DocumentRow>(`SELECT * FROM documents WHERE tenant_id=$1 AND vendor_id=$2 AND owner_type='VENDOR' ORDER BY created_at`, [actor.tenantId, v.id]);
  const documents: DocText[] = [];
  for (const d of rows) {
    if (d.encrypted) continue;
    const text = await extractText({ documentId: d.id, title: d.title, mimeType: d.mime_type }, await readPlain(ctx, d));
    if (text.sections.length) documents.push(text);
  }
  if (!documents.length) throw conflict('NO_VENDOR_DOCUMENT_TEXT', 'The vendor has no uploaded document with extractable text (PDF, DOCX, TXT or MD)');
  return recordRun(ctx, actor, null, 'GRADE_REVIEW',
    { vendorId: v.id, grade, criteria: criteria.map((c) => c.key), documents: docSummary(documents) },
    () => ctx.ai.reviewGrade({ vendor: { nameEn: v.legal_name_en, nameAr: v.legal_name_ar, crNumber: v.cr_number }, grade: grade as 1 | 2 | 3, criteria, documents }),
    { subjectId: v.id });
}

export async function gradeReviews(ctx: Ctx, actor: Actor, vendorId: string) {
  const v = await getVendorRow(ctx, actor.tenantId, vendorId);
  const runs = await ctx.db.query(
    `SELECT id, kind, agent, model, status, error, request, response, citations, review_decision, created_at FROM ai_runs
      WHERE tenant_id=$1 AND subject_id=$2 AND kind='GRADE_REVIEW' ORDER BY created_at DESC LIMIT 10`, [actor.tenantId, v.id]);
  return { criteria: { 1: gradeCriteriaSafe(1), 2: gradeCriteriaSafe(2), 3: gradeCriteriaSafe(3) }, runs: camel(runs) };
}

function gradeCriteriaSafe(g: 1 | 2 | 3) {
  try { return gradeCriteria(g); } catch { return []; }
}
