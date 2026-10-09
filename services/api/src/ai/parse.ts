// Robust parsing and validation of agent output. Nothing here invents content: invalid output is
// reported as problems (which trigger one repair turn, then an error), and citations that do not
// point at a provided document section are dropped.

import type {
  ChatAnswer, Citation, ClarificationDraft, ComplianceItem, DocText, EvaluationNarrative, NoticeDraft, PackFinding, RankedItem, RequestClassification,
} from './types.js';
import { normalizeText } from './text-utils.js';

export class AiOutputError extends Error {
  code = 'AI_INVALID_OUTPUT';
  constructor(message: string, public readonly rawText?: string) { super(message); this.name = 'AiOutputError'; }
}

/** Extracts the first JSON object from model text (handles code fences and leading/trailing prose). */
export function extractJsonObject(text: string): unknown {
  const candidates: string[] = [];
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  for (let m = fence.exec(text); m; m = fence.exec(text)) candidates.push(m[1].trim());
  candidates.push(text.trim());
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch { /* try balanced scan */ }
    for (let start = c.indexOf('{'); start !== -1; start = c.indexOf('{', start + 1)) {
      const end = matchBrace(c, start);
      if (end === -1) continue;
      try {
        const v = JSON.parse(c.slice(start, end + 1));
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
      } catch { /* next */ }
    }
  }
  throw new AiOutputError('Agent reply did not contain a valid JSON object', text.slice(0, 2000));
}

function matchBrace(s: string, start: number): number {
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// ---------------------------------------------------------------- citations

function normSection(s: string): string {
  return normalizeText(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Maps a model citation onto the provided documents. Returns undefined (drop) when the document or the
 * section does not exist. Accepts {documentId, section, quote} objects or a "DOC id | title | section" string.
 */
export function resolveCitation(raw: unknown, docs: DocText[]): Citation | undefined {
  let documentId = ''; let section = ''; let title = ''; let quote: string | undefined;
  if (typeof raw === 'string') {
    const m = raw.replace(/^\[|\]$/g, '').match(/^\s*DOC\s+([^|]+)\|([^|]*)\|(.+)$/i);
    if (!m) return undefined;
    [documentId, title, section] = [m[1].trim(), m[2].trim(), m[3].trim()];
  } else if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    documentId = String(r.documentId ?? r.document_id ?? r.docId ?? '').trim();
    section = String(r.section ?? '').trim();
    title = String(r.title ?? '').trim();
    if (typeof r.quote === 'string' && r.quote.trim()) quote = r.quote.trim();
  } else return undefined;
  if (!section) return undefined;
  documentId = documentId.replace(/^DOC\s+/i, '');

  let doc = docs.find((d) => d.documentId === documentId);
  if (!doc && title) doc = docs.find((d) => normSection(d.title) === normSection(title));
  if (!doc) return undefined;

  const target = normSection(section);
  if (!target) return undefined;
  let sec = doc.sections.find((s) => normSection(s.section) === target);
  if (!sec) {
    const partial = doc.sections.filter((s) => {
      const n = normSection(s.section);
      return n.length > 0 && (n.includes(target) || target.includes(n));
    });
    if (partial.length === 1) sec = partial[0];
  }
  if (!sec) return undefined;

  const out: Citation = { documentId: doc.documentId, title: doc.title, section: sec.section };
  // Keep the quote only if it really appears in that section (otherwise it is not evidence).
  if (quote && normalizeText(sec.text).includes(normalizeText(quote))) out.quote = quote;
  return out;
}

// ---------------------------------------------------------------- validators

export interface Validated<T> { value?: T; problems: string[]; citations: Citation[]; dropped: number }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function validatePackCheck(obj: unknown, docs: DocText[]): Validated<{ findings: PackFinding[]; summary: string }> {
  const problems: string[] = []; const citations: Citation[] = []; let dropped = 0;
  if (!isObj(obj)) return { problems: ['top-level value is not a JSON object'], citations, dropped };
  const summary = str(obj.summary);
  if (!summary) problems.push('"summary" must be a non-empty string');
  if (!Array.isArray(obj.findings)) problems.push('"findings" must be an array');
  const findings: PackFinding[] = [];
  (Array.isArray(obj.findings) ? obj.findings : []).forEach((f, i) => {
    if (!isObj(f)) { problems.push(`findings[${i}] is not an object`); return; }
    const severity = str(f.severity).toUpperCase();
    if (!['HIGH', 'MEDIUM', 'LOW'].includes(severity)) problems.push(`findings[${i}].severity must be HIGH, MEDIUM or LOW`);
    const item = str(f.item); const detail = str(f.detail);
    if (!item) problems.push(`findings[${i}].item must be a non-empty string`);
    if (!detail) problems.push(`findings[${i}].detail must be a non-empty string`);
    const out: PackFinding = { severity: severity as PackFinding['severity'], item, detail };
    if (f.citation != null) {
      const c = resolveCitation(f.citation, docs);
      if (c) { out.citation = c; citations.push(c); } else dropped++;
    }
    findings.push(out);
  });
  return { value: problems.length ? undefined : { findings, summary }, problems, citations, dropped };
}

export function validateClarification(obj: unknown, docs: DocText[], language: 'ar' | 'en'): Validated<ClarificationDraft> {
  const problems: string[] = []; const citations: Citation[] = []; let dropped = 0;
  if (!isObj(obj)) return { problems: ['top-level value is not a JSON object'], citations, dropped };
  const answer = str(obj.answer);
  if (!answer) problems.push('"answer" must be a non-empty string');
  if (typeof obj.notFound !== 'boolean') problems.push('"notFound" must be true or false');
  const notFound = obj.notFound === true;
  if (obj.citations != null && !Array.isArray(obj.citations)) problems.push('"citations" must be an array');
  for (const c of Array.isArray(obj.citations) ? obj.citations : []) {
    const r = resolveCitation(c, docs);
    if (r) { if (!citations.some((x) => x.documentId === r.documentId && x.section === r.section)) citations.push(r); } else dropped++;
  }
  if (!notFound && citations.length === 0) {
    problems.push(dropped > 0
      ? 'none of the citations matched a [DOC documentId | title | section] marker; copy documentId and section exactly'
      : 'an answer with "notFound": false must include at least one citation');
  }
  const value: ClarificationDraft = { answer, language, notFound, citations: notFound ? [] : citations };
  return { value: problems.length ? undefined : value, problems, citations: value.citations, dropped };
}

export function validateCompliance(obj: unknown, docs: DocText[], requiredKeys: string[]): Validated<{ items: ComplianceItem[] }> {
  const problems: string[] = []; const citations: Citation[] = []; let dropped = 0;
  if (!isObj(obj)) return { problems: ['top-level value is not a JSON object'], citations, dropped };
  if (!Array.isArray(obj.items)) return { problems: ['"items" must be an array'], citations, dropped };
  const byKey = new Map<string, ComplianceItem>();
  const keyLookup = new Map(requiredKeys.map((k) => [normalizeText(k), k]));
  obj.items.forEach((it, i) => {
    if (!isObj(it)) { problems.push(`items[${i}] is not an object`); return; }
    const key = keyLookup.get(normalizeText(str(it.requirement)));
    if (!key) return; // not a requested requirement → ignore (never invent requirements)
    const status = str(it.status).toUpperCase();
    if (!['PRESENT', 'MISSING', 'UNCLEAR'].includes(status)) { problems.push(`items[${i}].status must be PRESENT, MISSING or UNCLEAR`); return; }
    const out: ComplianceItem = { requirement: key, status: status as ComplianceItem['status'] };
    const evidence = str(it.evidence); if (evidence) out.evidence = evidence;
    if (it.citation != null) {
      const c = resolveCitation(it.citation, docs);
      if (c) { out.citation = c; citations.push(c); } else dropped++;
    }
    // PRESENT without a verifiable citation cannot be shown as present.
    if (out.status === 'PRESENT' && !out.citation) problems.push(`items[${i}] (${key}) is PRESENT but has no citation matching a [DOC ...] marker`);
    if (!byKey.has(key)) byKey.set(key, out);
  });
  const missing = requiredKeys.filter((k) => !byKey.has(k));
  if (missing.length) problems.push(`no item returned for requirement key(s): ${missing.join(', ')}`);
  const items = requiredKeys.filter((k) => byKey.has(k)).map((k) => byKey.get(k)!);
  return { value: problems.length ? undefined : { items }, problems, citations, dropped };
}

// ---------------------------------------------------------------- numbers that must come from the input

/** Canonical numeric tokens of a text (Arabic-Indic digits, thousands separators and trailing zeros normalised). */
export function numbersIn(text: string): string[] {
  const t = String(text ?? '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/٬/g, ',');
  const out: string[] = [];
  for (const m of t.match(/\d+(?:[.,]\d+)*/g) ?? []) {
    let tok = m;
    // 1,200,000 → 1200000 (comma followed by exactly three digits); otherwise a comma is a list separator.
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(tok)) tok = tok.replace(/,/g, '');
    for (const part of tok.split(',')) {
      const n = Number(part);
      if (part && Number.isFinite(n)) out.push(String(n));
    }
  }
  return out;
}

/** Numbers that appear in `output` but nowhere in `input` (distinct, in order of appearance). */
export function numbersNotInInput(output: string, input: string): string[] {
  const known = new Set(numbersIn(input));
  return [...new Set(numbersIn(output).filter((n) => !known.has(n)))];
}

const numberProblem = (field: string, bad: string[]) =>
  `${field} contains number(s) that do not appear in the input: ${bad.slice(0, 10).join(', ')}. Copy every number, date and amount exactly from the input or leave it out`;

function citationsOf(raw: unknown, docs: DocText[]): { citations: Citation[]; dropped: number } {
  const citations: Citation[] = []; let dropped = 0;
  for (const c of Array.isArray(raw) ? raw : []) {
    const r = resolveCitation(c, docs);
    if (r) { if (!citations.some((x) => x.documentId === r.documentId && x.section === r.section)) citations.push(r); } else dropped++;
  }
  return { citations, dropped };
}

const hasArabic = (s: string) => /[؀-ۿ]/.test(s);

export function validateClassification(obj: unknown, docs: DocText[], templateCodes: string[], activityCodes: string[], inputText: string): Validated<RequestClassification> {
  const problems: string[] = [];
  if (!isObj(obj)) return { problems: ['top-level value is not a JSON object'], citations: [], dropped: 0 };
  const tpl = new Map(templateCodes.map((c) => [c.toUpperCase(), c]));
  const tenderType = tpl.get(str(obj.tenderType).toUpperCase());
  if (!tenderType) problems.push(`"tenderType" must be one of: ${templateCodes.join(', ') || '(none supplied)'}`);
  const known = new Map(activityCodes.map((c) => [c.toUpperCase(), c]));
  const codes: string[] = [];
  if (!Array.isArray(obj.activityCodes)) problems.push('"activityCodes" must be an array');
  for (const c of Array.isArray(obj.activityCodes) ? obj.activityCodes : []) {
    const k = known.get(str(c).toUpperCase());
    if (!k) problems.push(`activity code "${str(c)}" is not one of the supplied codes`);
    else if (!codes.includes(k)) codes.push(k);
  }
  const urgency = str(obj.urgency).toUpperCase();
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(urgency)) problems.push('"urgency" must be LOW, MEDIUM or HIGH');
  let estimatedBudget: number | null = null;
  if (obj.estimatedBudget !== null && obj.estimatedBudget !== undefined && obj.estimatedBudget !== '') {
    const n = typeof obj.estimatedBudget === 'number' ? obj.estimatedBudget : Number(String(obj.estimatedBudget).replace(/,/g, ''));
    if (!Number.isFinite(n) || n < 0) problems.push('"estimatedBudget" must be a number or null');
    else if (!numbersIn(inputText).includes(String(n))) problems.push(`"estimatedBudget" ${n} does not appear in the input; use null when the input states no budget`);
    else estimatedBudget = n;
  }
  const summaryEn = str(obj.summaryEn); const summaryAr = str(obj.summaryAr);
  if (!summaryEn) problems.push('"summaryEn" must be a non-empty English string');
  if (!summaryAr) problems.push('"summaryAr" must be a non-empty Arabic string');
  else if (!hasArabic(summaryAr)) problems.push('"summaryAr" must be written in Arabic');
  for (const [f, v] of [['summaryEn', summaryEn], ['summaryAr', summaryAr]] as const) {
    const bad = numbersNotInInput(v, inputText); if (bad.length) problems.push(numberProblem(`"${f}"`, bad));
  }
  const { citations, dropped } = citationsOf(obj.citations, docs);
  if (!citations.length) problems.push(dropped ? 'none of the citations matched a [DOC documentId | title | section] marker' : 'include at least one citation of the request text you used');
  const value: RequestClassification = { tenderType: tenderType ?? '', activityCodes: codes, urgency: urgency as RequestClassification['urgency'], estimatedBudget, summaryEn, summaryAr, citations };
  return { value: problems.length ? undefined : value, problems, citations, dropped };
}

export function validateNotice(obj: unknown, docs: DocText[], inputText: string): Validated<NoticeDraft> {
  const problems: string[] = [];
  if (!isObj(obj)) return { problems: ['top-level value is not a JSON object'], citations: [], dropped: 0 };
  const noticeAr = str(obj.noticeAr); const noticeEn = str(obj.noticeEn);
  if (!noticeAr) problems.push('"noticeAr" must be a non-empty string');
  else if (!hasArabic(noticeAr)) problems.push('"noticeAr" must be written in Arabic');
  if (!noticeEn) problems.push('"noticeEn" must be a non-empty string');
  for (const [f, v] of [['noticeAr', noticeAr], ['noticeEn', noticeEn]] as const) {
    const bad = numbersNotInInput(v, inputText); if (bad.length) problems.push(numberProblem(`"${f}"`, bad));
  }
  const { citations, dropped } = citationsOf(obj.citations, docs);
  if (docs.some((d) => d.sections.length) && !citations.length)
    problems.push(dropped ? 'none of the citations matched a [DOC documentId | title | section] marker' : 'cite the pack sections you used (at least one citation)');
  return { value: problems.length ? undefined : { noticeAr, noticeEn, citations }, problems, citations, dropped };
}

export function validateRanking(obj: unknown, candidateIds: string[]): Validated<{ ranked: RankedItem[] }> {
  const problems: string[] = [];
  if (!isObj(obj)) return { problems: ['top-level value is not a JSON object'], citations: [], dropped: 0 };
  if (!Array.isArray(obj.ranked)) return { problems: ['"ranked" must be an array'], citations: [], dropped: 0 };
  const ids = new Set(candidateIds);
  const seen = new Map<string, RankedItem>();
  obj.ranked.forEach((r, i) => {
    if (!isObj(r)) { problems.push(`ranked[${i}] is not an object`); return; }
    const id = str(r.id);
    if (!ids.has(id)) { problems.push(`ranked[${i}].id "${id}" is not one of the candidate ids (never add candidates)`); return; }
    if (seen.has(id)) { problems.push(`candidate ${id} is ranked more than once`); return; }
    const score = typeof r.score === 'number' ? r.score : Number(r.score);
    if (!Number.isFinite(score) || score < 0 || score > 100) problems.push(`ranked[${i}].score must be a number 0-100`);
    const reasonsEn = str(r.reasonsEn); const reasonsAr = str(r.reasonsAr);
    if (!reasonsEn) problems.push(`ranked[${i}].reasonsEn must be a non-empty string`);
    if (!reasonsAr) problems.push(`ranked[${i}].reasonsAr must be a non-empty string`);
    seen.set(id, { id, score: Math.round(score), reasonsEn, reasonsAr });
  });
  const missing = candidateIds.filter((id) => !seen.has(id));
  if (missing.length) problems.push(`rank every candidate exactly once; missing: ${missing.join(', ')}`);
  const ranked = [...seen.values()].sort((a, b) => b.score - a.score);
  return { value: problems.length ? undefined : { ranked }, problems, citations: [], dropped: 0 };
}

export function validateNarrative(obj: unknown, inputText: string): Validated<EvaluationNarrative> {
  const problems: string[] = [];
  if (!isObj(obj)) return { problems: ['top-level value is not a JSON object'], citations: [], dropped: 0 };
  const narrativeEn = str(obj.narrativeEn); const narrativeAr = str(obj.narrativeAr);
  if (!narrativeEn) problems.push('"narrativeEn" must be a non-empty string');
  if (!narrativeAr) problems.push('"narrativeAr" must be a non-empty string');
  else if (!hasArabic(narrativeAr)) problems.push('"narrativeAr" must be written in Arabic');
  // The committee's numbers are fixed: any score, weight, total or count not in the input is rejected.
  for (const [f, v] of [['narrativeEn', narrativeEn], ['narrativeAr', narrativeAr]] as const) {
    const bad = numbersNotInInput(v, inputText); if (bad.length) problems.push(numberProblem(`"${f}"`, bad));
  }
  return { value: problems.length ? undefined : { narrativeEn, narrativeAr }, problems, citations: [], dropped: 0 };
}

/**
 * Chat replies: the JSON contract {answer, notFound, citations} is preferred; a plain-text reply is accepted as the
 * answer (structured=false, no citations). In both cases numbers must appear in the context or the user's message.
 */
export function validateChat(text: string, docs: DocText[], inputText: string): Validated<ChatAnswer> {
  const problems: string[] = [];
  let obj: unknown;
  try { obj = extractJsonObject(text); } catch { obj = undefined; }
  let answer = ''; let notFound = false; let structured = false;
  let cites: { citations: Citation[]; dropped: number } = { citations: [], dropped: 0 };
  if (isObj(obj) && typeof obj.answer === 'string') {
    structured = true;
    answer = str(obj.answer);
    notFound = obj.notFound === true;
    cites = citationsOf(obj.citations, docs);
  } else {
    answer = String(text ?? '').trim();
    if (/^\s*[{[]/.test(answer)) problems.push('the reply looks like JSON but is not a valid {"answer": ...} object');
  }
  if (!answer) problems.push('"answer" must be a non-empty string');
  const bad = numbersNotInInput(answer, inputText);
  if (bad.length) problems.push(numberProblem('"answer"', bad));
  const value: ChatAnswer = { answer, notFound, structured, citations: notFound ? [] : cites.citations };
  return { value: problems.length ? undefined : value, problems, citations: value.citations, dropped: cites.dropped };
}
