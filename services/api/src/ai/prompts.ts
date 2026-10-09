// Builds the single user message sent to each Orchestrate agent: task, tender metadata, the extracted
// document text with explicit [DOC ...] markers (budgeted), and a strict JSON-only output contract.
// The same contracts are repeated in the agent instructions (agents/*.yaml) so both sides agree.

import type { DocText } from './types.js';
import { keyTerms, normalizeText } from './text-utils.js';

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

export function buildRepairPrompt(problems: string[], schema: string): string {
  return `Your previous reply could not be accepted: ${problems.slice(0, 8).join('; ')}.
Reply again with ONLY one valid JSON object matching this schema (no markdown, no code fences, no other text). Keep using only the
provided documents and copy documentId/section exactly from the [DOC ...] markers.

${schema}`;
}
