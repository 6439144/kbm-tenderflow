// Builds the single user message sent to each Orchestrate agent: task, tender metadata, the extracted
// document text with explicit [DOC ...] markers (budgeted), and a strict JSON-only output contract.
// The same contracts are repeated in the agent instructions (agents/*.yaml) so both sides agree.

import type {
  ChatInput, ClassifyDocumentInput, ClassifyRequestInput, DocText, DraftNoticeInput, NarrateEvaluationInput, RankRelevanceInput, ReviewGradeInput,
} from './types.js';
import { detectLanguage, keyTerms, normalizeText } from './text-utils.js';

export const PACK_SCHEMA = `{
  "summary": "<2-4 sentence overview of pack completeness and clarity>",
  "findings": [
    {
      "severity": "HIGH" | "MEDIUM" | "LOW",
      "item": "<short name of the gap, ambiguity or inconsistency>",
      "detail": "<what is missing/unclear and why it matters, based only on the documents>",
      "citation": { "documentId": "<id from a DOC marker>", "section": "<section from the same DOC marker>", "quote": "<short exact quote>" } | null
    }
  ]
}`;

export const CLARIFICATION_SCHEMA = `{
  "answer": "<draft answer for the procurement officer to review; or a statement that the documents do not contain the answer>",
  "language": "ar" | "en",
  "notFound": true | false,
  "citations": [ { "documentId": "<id from a DOC marker>", "section": "<section from the same DOC marker>", "quote": "<short exact quote>" } ]
}`;

export const COMPLIANCE_SCHEMA = `{
  "items": [
    {
      "requirement": "<the requirement key exactly as listed>",
      "status": "PRESENT" | "MISSING" | "UNCLEAR",
      "evidence": "<one sentence explaining what was or was not found>",
      "citation": { "documentId": "<id from a DOC marker>", "section": "<section from the same DOC marker>", "quote": "<short exact quote>" } | null
    }
  ]
}`;

const COMMON_RULES = (lang: 'ar' | 'en' | 'question') => `RULES (mandatory):
1. Use ONLY the text between BEGIN DOCUMENTS and END DOCUMENTS. Do not use outside knowledge, assumptions or general practice.
2. Every citation must copy "documentId" and "section" exactly from one [DOC <documentId> | <title> | <section>] marker above the quoted text. Never invent documents or sections. "quote" must be a short exact excerpt from that section.
3. You are advisory only. Never approve, reject, award, rank, score or decide anything; never recommend a winner.
4. ${lang === 'question' ? 'Write all free text in the same language as the question (Arabic question → Arabic answer, English question → English answer).' : lang === 'ar' ? 'Write all free text in Arabic.' : 'Write all free text in English.'}
5. Return ONLY one JSON object that matches the schema below. No markdown, no code fences, no text before or after the JSON.`;

export interface DocBudgetResult { text: string; included: number; truncated: number; omitted: number }

/**
 * Renders documents with [DOC id | title | section] markers within a character budget.
 * When everything does not fit, sections that mention the key terms are preferred; output keeps document order.
 */
export function renderDocuments(documents: DocText[], terms: string[], maxChars: number): DocBudgetResult {
  type Sec = { idx: number; header: string; body: string; score: number };
  const secs: Sec[] = [];
  let idx = 0;
  const normTerms = terms.map((t) => normalizeText(t)).filter(Boolean);
  for (const d of documents) {
    for (const s of d.sections) {
      const body = (s.text ?? '').replace(/\r\n/g, '\n').trim();
      if (!body) continue;
      const header = `[DOC ${d.documentId} | ${oneLine(d.title)} | ${oneLine(s.section)}]`;
      const hay = normalizeText(`${s.section} ${body}`);
      let score = 0;
      for (const t of normTerms) if (hay.includes(t)) score += 1;
      secs.push({ idx: idx++, header, body, score });
    }
  }
  const total = secs.reduce((n, s) => n + s.header.length + s.body.length + 2, 0);
  const chosen = new Map<number, string>();
  let truncated = 0;
  if (total <= maxChars) {
    for (const s of secs) chosen.set(s.idx, s.body);
  } else {
    let left = maxChars;
    const byPriority = [...secs].sort((a, b) => b.score - a.score || a.idx - b.idx);
    for (const s of byPriority) {
      const need = s.header.length + s.body.length + 2;
      if (need <= left) { chosen.set(s.idx, s.body); left -= need; continue; }
      const room = left - s.header.length - 30;
      if (room >= 400) {
        chosen.set(s.idx, `${s.body.slice(0, room)} [...section truncated]`);
        truncated++;
        left -= s.header.length + room + 30;
      }
    }
  }
  const parts = secs.filter((s) => chosen.has(s.idx)).map((s) => `${s.header}\n${chosen.get(s.idx)}`);
  return { text: parts.join('\n\n'), included: chosen.size, truncated, omitted: secs.length - chosen.size };
}

function oneLine(s: string): string {
  return String(s ?? '').replace(/[\r\n|\]\[]+/g, ' ').replace(/\s+/g, ' ').trim() || '-';
}

function docsBlock(r: DocBudgetResult): string {
  const note = r.omitted > 0 || r.truncated > 0
    ? `\n(Note: ${r.omitted} lower-relevance section(s) were omitted and ${r.truncated} truncated to fit the size limit. If the answer is not in the text shown, say so.)`
    : '';
  return `BEGIN DOCUMENTS${note}\n${r.text || '(no document text was provided)'}\nEND DOCUMENTS`;
}

export function buildPackCheckPrompt(input: {
  tender: { titleEn: string; titleAr: string; category: string; deadline: string; criteria: unknown; requiredDocuments: unknown };
  documents: DocText[]; language: 'ar' | 'en';
}, maxChars: number): string {
  const t = input.tender;
  const terms = keyTerms(t.titleEn, t.titleAr, t.category, JSON.stringify(t.criteria ?? ''), JSON.stringify(t.requiredDocuments ?? ''),
    'scope specification deadline evaluation criteria bid security guarantee submission required documents payment penalty',
    'نطاق مواصفات موعد معايير تقييم ضمان تقديم مستندات دفع غرامة');
  const docs = renderDocuments(input.documents, terms, maxChars);
  return `TASK: TENDER PACK CHECK (advisory).
Review the tender pack below for completeness, clarity and internal consistency before publication. Report gaps (e.g. missing scope,
deliverables, evaluation method, submission instructions, bid security, deadlines, required bid documents), ambiguities and
contradictions between documents or with the tender metadata. Severity: HIGH = could invalidate or block bidding; MEDIUM = likely
to cause clarification requests or disputes; LOW = editorial. If you find nothing, return an empty "findings" array.

TENDER METADATA (from the system, not a document; do not cite it):
- Title (EN): ${t.titleEn}
- Title (AR): ${t.titleAr}
- Category: ${t.category}
- Submission deadline: ${t.deadline}
- Evaluation criteria: ${JSON.stringify(t.criteria ?? null)}
- Required bid documents: ${JSON.stringify(t.requiredDocuments ?? null)}

${docsBlock(docs)}

${COMMON_RULES(input.language)}
6. Each finding about document content should carry a citation; a finding about something absent from all documents uses "citation": null.

OUTPUT SCHEMA:
${PACK_SCHEMA}`;
}

export function buildClarificationPrompt(input: {
  tender: { titleEn: string; titleAr: string };
  question: string; documents: DocText[]; priorAnswers: { question: string; answer: string }[];
}, language: 'ar' | 'en', maxChars: number): string {
  const terms = keyTerms(input.question);
  const docs = renderDocuments(input.documents, terms, maxChars);
  const prior = input.priorAnswers.length
    ? input.priorAnswers.slice(-10).map((p, i) => `${i + 1}. Q: ${p.question}\n   A: ${p.answer}`).join('\n')
    : '(none)';
  return `TASK: CLARIFICATION DRAFT (advisory).
A bidder asked the clarification question below. Draft an answer for the procurement officer, who will review and edit it before
anything is published. Answer strictly from the documents. If the documents do not contain the information needed, set
"notFound": true, give an "answer" that says the tender documents do not address this (in the question's language), and return
"citations": []. Never guess, never fill gaps with general practice.

TENDER: ${input.tender.titleEn} / ${input.tender.titleAr}

PREVIOUSLY PUBLISHED ANSWERS (for consistency only; not a citable source):
${prior}

QUESTION (language: ${language === 'ar' ? 'Arabic' : 'English'}):
${input.question}

${docsBlock(docs)}

${COMMON_RULES('question')}
6. "language" must be "${language}". When "notFound" is false, include at least one citation supporting the answer.

OUTPUT SCHEMA:
${CLARIFICATION_SCHEMA}`;
}

export function buildCompliancePrompt(input: {
  requiredDocuments: { key: string; nameEn: string; nameAr: string }[];
  bid: { bidId: string; vendorName: string; documents: DocText[] };
}, maxChars: number): string {
  const req = input.requiredDocuments;
  const terms = keyTerms(...req.flatMap((r) => [r.key.replace(/[_-]+/g, ' '), r.nameEn, r.nameAr]));
  const docs = renderDocuments(input.bid.documents, terms, maxChars);
  return `TASK: BID COMPLIANCE SCREENING (advisory, no scoring).
Check whether each required document/item below is present in the opened bid's documents. For each requirement return exactly one
item with status PRESENT (clearly present, cite it), MISSING (no trace of it in the text) or UNCLEAR (partial, expired, ambiguous or
cannot be confirmed from the text). Return one item per requirement key, in the listed order, and no other items. Do NOT score,
rank, compare bidders, or recommend acceptance or rejection.

BID: ${input.bid.bidId} — vendor: ${input.bid.vendorName}

REQUIRED DOCUMENTS (key — English name — Arabic name):
${req.map((r) => `- ${r.key} — ${r.nameEn} — ${r.nameAr}`).join('\n') || '(none)'}

${docsBlock(docs)}

${COMMON_RULES('en')}
6. "requirement" must be the key exactly as listed. PRESENT requires a citation; MISSING uses "citation": null.

OUTPUT SCHEMA:
${COMPLIANCE_SCHEMA}`;
}

// ================================================================ Phase 1 agents

export const CLASSIFY_SCHEMA = `{
  "tenderType": "<one cycle template code from the list>",
  "activityCodes": ["<activity code from the list>", "..."],
  "urgency": "LOW" | "MEDIUM" | "HIGH",
  "estimatedBudget": <number copied exactly from the input> | null,
  "summaryEn": "<2-3 sentence English summary of what is requested>",
  "summaryAr": "<the same summary in Arabic>",
  "citations": [ { "documentId": "<id from a DOC marker>", "section": "<section from the same DOC marker>", "quote": "<short exact quote>" } ]
}`;

export const NOTICE_SCHEMA = `{
  "noticeAr": "<formal Arabic notice text>",
  "noticeEn": "<formal English notice text>",
  "citations": [ { "documentId": "<id from a DOC marker>", "section": "<section from the same DOC marker>", "quote": "<short exact quote>" } ]
}`;

export const RANKING_SCHEMA = `{
  "ranked": [ { "id": "<candidate id exactly as given>", "score": <integer 0-100>, "reasonsEn": "<one or two sentences>", "reasonsAr": "<the same reasons in Arabic>" } ]
}`;

export const NARRATIVE_SCHEMA = `{
  "narrativeEn": "<committee narrative in English>",
  "narrativeAr": "<the same narrative in Arabic>"
}`;

export const CHAT_SCHEMA = `Plain text, NOT JSON:
<the answer, in the language of the question>
Sources: [DOC <documentId> | <section>]; [DOC <documentId> | <section>]
(Write "Sources: none" when no section was used. Start the answer with [NOT_FOUND] when the context does not contain it.)`;

/** All section text of the documents (no markers): the "input" against which numbers in the output are checked. */
export function documentsText(docs: DocText[]): string {
  return docs.flatMap((d) => [d.title, ...d.sections.map((s) => `${s.section}\n${s.text}`)]).join('\n');
}

const NUMBERS_RULE = 'Every number, date, time, amount, percentage, score and count you write must appear in the input exactly as given (you may omit it). Do not compute, round, convert (e.g. to Hijri dates) or invent numbers.';

export function buildClassifyPrompt(input: ClassifyRequestInput, maxChars: number): string {
  const r = input.request;
  const terms = keyTerms(r.subject, r.department, ...input.activityCodes.flatMap((c) => [c.nameEn, c.nameAr]),
    'budget scope urgent deadline required', 'ميزانية نطاق عاجل موعد مطلوب');
  const docs = renderDocuments(input.documents, terms, maxChars);
  return `TASK: PROCUREMENT REQUEST CLASSIFICATION (advisory).
A department submitted the procurement request below (registered in TenderFlow; the GM letter text was extracted from the content store).
Propose, for the procurement officer to accept or ignore:
- "tenderType": the most suitable cycle template code from CYCLE TEMPLATES;
- "activityCodes": the activity codes from ACTIVITY CODES that the requested goods/works/services fall under (may be empty);
- "urgency": HIGH only when the text states an urgent need or a near date, LOW when it states no time pressure, otherwise MEDIUM;
- "estimatedBudget": the budget figure stated in the input as a plain number, or null when none is stated;
- "summaryEn" / "summaryAr": a short neutral summary of what is requested.

REQUEST (from the system):
- Number: ${r.requestNumber}
- Department: ${r.department}
- Subject: ${r.subject}
- Source: ${r.source}${r.sourceReference ? ` (${r.sourceReference})` : ''}

CYCLE TEMPLATES (code — English — Arabic):
${input.templates.map((t) => `- ${t.code} — ${t.nameEn} — ${t.nameAr}`).join('\n') || '(none)'}

ACTIVITY CODES (code — English — Arabic):
${input.activityCodes.map((c) => `- ${c.code} — ${c.nameEn} — ${c.nameAr}`).join('\n') || '(none)'}

${docsBlock(docs)}

${COMMON_RULES('en')}
6. Write "summaryEn" in English and "summaryAr" in Arabic. Use only codes from the lists. ${NUMBERS_RULE}
7. Include at least one citation of the request text you relied on.

OUTPUT SCHEMA:
${CLASSIFY_SCHEMA}`;
}

export function noticeInputText(input: DraftNoticeInput): string {
  return `${input.facts.map((f) => `${f.label}: ${f.value}`).join('\n')}\n${documentsText(input.documents)}`;
}

export function buildNoticePrompt(input: DraftNoticeInput, maxChars: number): string {
  const channel = input.channel === 'KUWAIT_ALYOUM'
    ? 'the official gazette Kuwait Al-Youm (الكويت اليوم)'
    : 'the Central Agency for Public Tenders (CAPT, الجهاز المركزي للمناقصات العامة)';
  const terms = keyTerms(...input.facts.map((f) => f.value), 'scope submission deadline documents eligibility bid security',
    'نطاق تقديم موعد مستندات تأهيل ضمان');
  const docs = renderDocuments(input.documents, terms, maxChars);
  return `TASK: PUBLICATION NOTICE DRAFT for ${channel} (advisory).
Draft the tender announcement for this channel in formal gazette style: one Arabic text (Modern Standard Arabic) and one English text with
the same content. Use only the FACTS and the pack text. Copy the tender number, dates, times, amounts and fees exactly as written.
If an element that notices usually contain is not in the input (for example a fee, an address or a phone number), leave it out.
A procurement officer edits the draft and a different approver approves it before anything is published.

FACTS (from the TenderFlow record; authoritative):
${input.facts.map((f) => `- ${f.label}: ${f.value}`).join('\n')}

${docsBlock(docs)}

${COMMON_RULES('en')}
6. "noticeAr" is Arabic and "noticeEn" is English; this rule replaces rule 4 for those two fields. ${NUMBERS_RULE}
7. Cite the pack sections you used.

OUTPUT SCHEMA:
${NOTICE_SCHEMA}`;
}

export function buildRankingPrompt(input: RankRelevanceInput): string {
  const what = input.mode === 'VENDORS_FOR_TENDER'
    ? { subject: 'TENDER', cand: 'VENDORS', goal: 'how well each vendor\'s activities, grades and track record match this tender' }
    : { subject: 'VENDOR', cand: 'OPEN TENDERS', goal: 'how well each open tender matches this vendor\'s activities, grades and track record' };
  return `TASK: RELEVANCE RANKING (advisory).
Every candidate below has ALREADY passed TenderFlow's rule-based eligibility check (activity codes and grade). You do not decide
eligibility and you never exclude anyone: you only order the candidates by ${what.goal}, give each a relevance score from 0 to 100
and short reasons in English and Arabic based ONLY on the profile data shown. Rank every candidate exactly once and never add ids.

${what.subject}: ${input.subject.label}
${JSON.stringify(input.subject.profile, null, 1)}

CANDIDATE ${what.cand} (id: profile):
${input.candidates.map((c) => `- id ${c.id} — ${c.label}: ${JSON.stringify(c.profile)}`).join('\n') || '(none)'}

RULES (mandatory):
1. Use ONLY the data above. No outside knowledge about companies or projects.
2. "id" must be copied exactly. One entry per candidate.
3. You are advisory only: never say a candidate is eligible, ineligible, approved, rejected or should win.
4. "reasonsEn" in English, "reasonsAr" in Arabic.
5. Return ONLY one JSON object that matches the schema below. No markdown, no code fences, no text before or after the JSON.

OUTPUT SCHEMA:
${RANKING_SCHEMA}`;
}

/** The narrator's input as stable, number-checkable text (no UUIDs, so only real figures count as "in the input"). */
export function narrativeInputText(input: NarrateEvaluationInput): string {
  return JSON.stringify(input, null, 1);
}

export function buildNarrativePrompt(input: NarrateEvaluationInput): string {
  return `TASK: EVALUATION NARRATIVE for the committee report (advisory).
Write the narrative section of the evaluation committee report, in English and in Arabic, from the EVALUATION DATA only: the
criteria and weights, the evaluators' scores and comments, each bid's average weighted total and rank, the technical pass/fail
result (two-envelope tenders), the compliance screening results and the chair's recommended bid with its justification.
The committee's numbers are final: quote them exactly as given or leave them out. Never recompute, round, change or invent a score,
weight, total or count. Do not decide or announce the award: the recommendation is the chair's and approval stays with the approvers.
Write in a formal, neutral report style; refer to bids by vendor name and bid reference.

EVALUATION DATA (JSON, from TenderFlow):
${narrativeInputText(input)}

RULES (mandatory):
1. Use ONLY the evaluation data. No outside knowledge.
2. ${NUMBERS_RULE}
3. "narrativeEn" in English, "narrativeAr" in Arabic (Modern Standard Arabic), same content.
4. Return ONLY one JSON object that matches the schema below. No markdown, no code fences, no text before or after the JSON.

OUTPUT SCHEMA:
${NARRATIVE_SCHEMA}`;
}

export function buildGradePrompt(input: ReviewGradeInput, maxChars: number): string {
  const terms = keyTerms(...input.criteria.flatMap((c) => [c.key.replace(/[_-]+/g, ' '), c.nameEn, c.nameAr]));
  const docs = renderDocuments(input.documents, terms, maxChars);
  const grade = ({ 1: 'First grade / الدرجة الأولى', 2: 'Second grade / الدرجة الثانية', 3: 'Third grade / الدرجة الثالثة' } as const)[input.grade];
  return `TASK: VENDOR GRADE DOCUMENT REVIEW (advisory, no decision).
A procurement officer is reviewing whether the vendor's uploaded documents support the requested classification grade. For each
checklist item below return exactly one item with status PRESENT (clearly evidenced in the text; cite it), MISSING (no trace of it in
the text) or UNCLEAR (partial, expired, ambiguous or cannot be confirmed). Return one item per key, in the listed order, and no other
items. Do NOT grant, refuse or recommend a grade; the officer decides.

VENDOR: ${input.vendor.nameEn} / ${input.vendor.nameAr} (CR ${input.vendor.crNumber})
REQUESTED GRADE: ${grade}

CHECKLIST (key — English — Arabic; configured by the entity):
${input.criteria.map((c) => `- ${c.key} — ${c.nameEn} — ${c.nameAr}`).join('\n') || '(none)'}

${docsBlock(docs)}

${COMMON_RULES('en')}
6. "requirement" must be the key exactly as listed. PRESENT requires a citation; MISSING uses "citation": null.

OUTPUT SCHEMA:
${COMPLIANCE_SCHEMA}`;
}

export function chatInputText(input: ChatInput): string {
  return `${input.message}\n${documentsText(input.context)}`;
}

export function buildChatPrompt(input: ChatInput, maxChars: number): string {
  const docs = renderDocuments(input.context, keyTerms(input.message), maxChars);
  const lang = detectLanguage(input.message);
  return `TASK: TENDERFLOW ASSISTANT TURN (advisory, read-only).
TenderFlow sent the context below for the signed-in user; it is already limited to what this user's role may see. Answer the user's
question from this context only. If the context does not contain the answer, start your reply with [NOT_FOUND] and say so plainly. You never take
actions (approve, return, publish, open bids, score, recommend, award, submit, pay): when asked, explain which TenderFlow step does it
and who performs it, if the context says so. Never reveal or guess bid contents, other bidders' data or anything outside the context.

${docsBlock(docs).replace('BEGIN DOCUMENTS', 'BEGIN DOCUMENTS (TenderFlow context)')}

USER QUESTION (language: ${lang === 'ar' ? 'Arabic' : 'English'}):
${input.message}

RULES (mandatory):
1. Use ONLY the context between BEGIN DOCUMENTS and END DOCUMENTS (and earlier turns of this conversation).
2. Answer in ${lang === 'ar' ? 'Arabic (Modern Standard Arabic)' : 'English'}, concisely. ${NUMBERS_RULE}
3. Reply in plain text, NOT JSON (no braces, no code fences). Answer yourself; do not delegate this turn to another agent.
4. End with ONE last line that starts with "Sources:" listing the context sections you used, copied exactly from the
   [DOC ...] markers as [DOC <documentId> | <section>], separated by "; " — or "Sources: none".

OUTPUT FORMAT:
${CHAT_SCHEMA}`;
}

// ================================================================ Document intelligence

export const DOCINTEL_SCHEMA = `{
  "docType": "<one CODE from DOCUMENT TYPES, or \"OTHER\">",
  "language": "ar" | "en" | "mixed",
  "fields": [
    { "key": "<a field key defined for the chosen docType>", "value": "<the value exactly as written in the document>",
      "citation": { "section": "<section from the DOC marker>", "quote": "<short exact quote from that section that contains the value>" } }
  ],
  "summaryEn": "<1-2 sentence English description of the document>",
  "summaryAr": "<the same description in Arabic>",
  "citations": [ { "documentId": "<id from the DOC marker>", "section": "<section from the DOC marker>", "quote": "<short exact quote>" } ]
}`;

const FIELD_TYPE_HELP: Record<string, string> = {
  text: 'text', date: 'date (copy it as written; TenderFlow normalises it)', amount: 'amount with currency (copy figure and currency as written)',
  number: 'number', list: 'list (comma-separated as written)',
};

export function buildDocumentIntelligencePrompt(input: ClassifyDocumentInput, maxChars: number): string {
  const c = input.context;
  const terms = keyTerms(c.slotTitle, ...input.catalogue.flatMap((t) => [t.nameEn, t.nameAr, ...t.fields.flatMap((f) => [f.labelEn, f.labelAr])]),
    'expiry valid until issued amount total currency registration certificate guarantee', 'انتهاء صالح حتى تاريخ الإصدار مبلغ إجمالي عملة سجل شهادة ضمان');
  const docs = renderDocuments([input.document], terms, maxChars);
  const types = input.catalogue.map((t) => {
    const fields = t.fields.length
      ? t.fields.map((f) => `    - ${f.key} (${FIELD_TYPE_HELP[f.type] ?? f.type}${f.required ? ', required' : ''}) — ${f.labelEn} — ${f.labelAr}`).join('\n')
      : '    (no fields)';
    return `- ${t.code} — ${t.nameEn} — ${t.nameAr}\n${fields}`;
  }).join('\n');
  return `TASK: DOCUMENT CLASSIFICATION AND DATA EXTRACTION (advisory; a person reviews every result).
A user uploaded the document below to TenderFlow. Decide which DOCUMENT TYPE it is and extract the fields defined for that type.
- "docType": exactly one CODE from DOCUMENT TYPES. Use "OTHER" when none fits or the text is too unclear to decide.
- "fields": only keys defined for the chosen docType; include a field ONLY when its value is written in the document, and give the
  section and an exact quote that contains it. If a field is not in the text, leave it out (never guess, never compute, never translate
  numbers). For "OTHER" return an empty fields array.
- Never extract personal identity numbers (civil ID, passport, national ID) even if they appear in the text.
- "language": the language of the document text ("mixed" when it has substantial Arabic and English).

UPLOAD CONTEXT (from the system, not the document; do not cite it):
- Uploaded as: ${c.ownerType}
- Uploader role: ${c.uploaderRole}
- Title / slot given by the uploader: ${oneLine(c.slotTitle)}${c.fileName ? `\n- File name: ${oneLine(c.fileName)}` : ''}
(The title may be wrong: classify by the document text, not by the title.)

DOCUMENT TYPES (CODE — English — Arabic, then its fields: key (type) — English — Arabic):
${types || '(none)'}

${docsBlock(docs)}

${COMMON_RULES('en')}
6. "summaryEn" in English and "summaryAr" in Arabic. ${NUMBERS_RULE}
7. Each field "citation.section" must be copied exactly from the [DOC ...] marker of the section that contains the value, and
   "citation.quote" must be an exact excerpt of that section (same digits and spelling) that contains the value.

OUTPUT SCHEMA:
${DOCINTEL_SCHEMA}`;
}

export function buildRepairPrompt(problems: string[], schema: string): string {
  return `Your previous reply could not be accepted: ${problems.slice(0, 8).join('; ')}.
Reply again with ONLY one valid JSON object matching this schema (no markdown, no code fences, no other text). Keep using only the
provided documents and copy documentId/section exactly from the [DOC ...] markers.

${schema}`;
}
