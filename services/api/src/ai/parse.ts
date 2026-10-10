// Robust parsing and validation of agent output. Nothing here invents content: invalid output is
// reported as problems (which trigger one repair turn, then an error), and citations that do not
// point at a provided document section are dropped.

import { ADMIN_OP_TYPES } from './types.js';
import type {
  AdminOperation, AdminOpType, AdminPlan, Bilingual, AmountValue, ChatAnswer, Citation, ClarificationDraft, ComplianceItem, DocFieldValue, DocText, DocTypeDef, DocumentInsight, ExtractedField, EvaluationNarrative, NoticeDraft, PackFinding, RankedItem, RequestClassification,
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
  const raw = String(text ?? '').trim();
  const sources = /(?:^|\n)\s*(?:\*\*)?(?:Sources|Source|المصادر|المصدر)(?:\*\*)?\s*:\s*([^\n]*)\s*$/i.exec(raw);
  if (isObj(obj) && typeof obj.answer === 'string') {
    structured = true;
    answer = str(obj.answer);
    notFound = obj.notFound === true;
    cites = citationsOf(obj.citations, docs);
  } else if (sources) {
    // Text contract (the supervisor agent has collaborators bound as tools, so it answers in plain text, not JSON).
    structured = true;
    answer = raw.slice(0, sources.index).trim();
    const refs = [...sources[1].matchAll(/\[\s*(?:DOC\s+)?([^|\]]+?)\s*\|\s*([^|\]]+?)\s*(?:\|\s*([^\]]+?)\s*)?\]/gi)]
      .map((m) => ({ documentId: m[1], section: (m[3] ?? m[2]).trim() }));
    cites = citationsOf(refs, docs);
  } else {
    answer = raw;
    if (/^\s*[{[]/.test(answer) && !/^\s*\[NOT_FOUND\]/i.test(answer)) problems.push('the reply looks like JSON but is not a valid {"answer": ...} object');
  }
  if (/^\s*\[NOT_FOUND\]/i.test(answer)) { notFound = true; answer = answer.replace(/^\s*\[NOT_FOUND\]\s*[-—:]?\s*/i, ''); }
  if (!answer) problems.push('"answer" must be a non-empty string');
  const bad = numbersNotInInput(answer, inputText);
  if (bad.length) problems.push(numberProblem('"answer"', bad));
  const value: ChatAnswer = { answer, notFound, structured, citations: notFound ? [] : cites.citations };
  return { value: problems.length ? undefined : value, problems, citations: value.citations, dropped: cites.dropped };
}

// ---------------------------------------------------------------- document intelligence

const EN_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const AR_MONTHS: Record<string, number> = {
  يناير: 1, فبراير: 2, مارس: 3, ابريل: 4, مايو: 5, يونيو: 6, يوليو: 7, اغسطس: 8, سبتمبر: 9, اكتوبر: 10, نوفمبر: 11, ديسمبر: 12,
  'كانون الثاني': 1, شباط: 2, اذار: 3, نيسان: 4, ايار: 5, حزيران: 6, تموز: 7, اب: 8, ايلول: 9, 'تشرين الاول': 10, 'تشرين الثاني': 11, 'كانون الاول': 12,
};

function isoOf(y: number, m: number, d: number): string | null {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Gregorian date as written in a document → ISO YYYY-MM-DD, or null. Accepts YYYY-MM-DD / YYYY/MM/DD, day-first
 * DD/MM/YYYY (Kuwait convention), "15 March 2027", "March 15, 2027", Arabic month names and Arabic-Indic digits.
 * Hijri dates and ambiguous text return null (never guessed).
 */
export function normaliseDate(raw: string): string | null {
  const t = normalizeText(String(raw ?? '')).replace(/[٫]/g, '.');
  let m = t.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (m) return isoOf(+m[1], +m[2], +m[3]);
  m = t.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
  if (m) return isoOf(+m[3], +m[2], +m[1]);
  for (let i = 0; i < EN_MONTHS.length; i++) {
    const name = EN_MONTHS[i]; const short = name.slice(0, 3);
    const re1 = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:${name}|${short})\\.?,?\\s+(\\d{4})\\b`);
    const re2 = new RegExp(`\\b(?:${name}|${short})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`);
    const a = t.match(re1); if (a) return isoOf(+a[2], i + 1, +a[1]);
    const b = t.match(re2); if (b) return isoOf(+b[2], i + 1, +b[1]);
  }
  for (const [name, mon] of Object.entries(AR_MONTHS)) {
    const n = normalizeText(name);
    const re = new RegExp(`(\\d{1,2})\\s+${n}\\s+(\\d{4})`);
    const a = t.match(re); if (a) return isoOf(+a[2], mon, +a[1]);
  }
  return null;
}

const CURRENCIES: [RegExp, string][] = [
  [/\bkwd\b|\bk\.?d\.?\b|د\.?\s?ك|دينار/, 'KWD'],
  [/\busd\b|us\$|\$|دولار/, 'USD'],
  [/\bsar\b|ريال سعودي|ر\.?\s?س/, 'SAR'],
  [/\beur\b|€|يورو/, 'EUR'],
  [/\baed\b|درهم/, 'AED'],
  [/\bbhd\b|دينار بحريني/, 'BHD'],
  [/\bqar\b|ريال قطري/, 'QAR'],
  [/\bomr\b|ريال عماني/, 'OMR'],
  [/\bgbp\b|£|جنيه استرليني/, 'GBP'],
];
/** ISO currency named in a text (most specific first: Bahraini dinar before generic dinar), or null. */
export function currencyIn(text: string): string | null {
  const t = normalizeText(String(text ?? ''));
  for (const code of ['BHD', 'QAR', 'OMR', 'SAR']) {
    const re = CURRENCIES.find(([, c]) => c === code)![0];
    if (re.test(t)) return code;
  }
  for (const [re, code] of CURRENCIES) if (re.test(t)) return code;
  return null;
}

const rawString = (v: unknown): string => {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (Array.isArray(v)) return v.map((x) => rawString(x)).filter(Boolean).join(', ');
  if (isObj(v)) {
    const amount = v.amount ?? v.value;
    const cur = v.currency;
    return [rawString(amount), typeof cur === 'string' ? cur : ''].filter(Boolean).join(' ');
  }
  return '';
};

/** Normalises one field value by its catalogue type and checks it is grounded in the quote / section. */
export function normaliseFieldValue(type: string, rawValue: unknown, quote: string, sectionText: string): { value?: DocFieldValue; raw: string; problem?: string } {
  const raw = rawString(rawValue);
  if (!raw) return { raw, problem: 'is empty (leave a field out when it is not in the document)' };
  const inQuote = new Set(numbersIn(quote));
  switch (type) {
    case 'date': {
      const iso = normaliseDate(raw) ?? normaliseDate(quote);
      if (!iso) return { raw, problem: `date "${raw.slice(0, 40)}" is not a recognisable Gregorian date` };
      const [y, , d] = iso.split('-').map(Number);
      if (!inQuote.has(String(y)) || !inQuote.has(String(d))) return { raw, problem: `date ${iso} does not appear in the quoted text` };
      return { value: iso, raw };
    }
    case 'amount': {
      const nums = numbersIn(raw);
      const n = nums.length ? Number(nums[0]) : NaN;
      if (!Number.isFinite(n)) return { raw, problem: `amount "${raw.slice(0, 40)}" has no number` };
      if (!inQuote.has(String(n))) return { raw, problem: `amount ${n} does not appear in the quoted text` };
      const currency = currencyIn(raw) ?? currencyIn(quote);
      return { value: { amount: n, currency } as AmountValue, raw };
    }
    case 'number': {
      const nums = numbersIn(raw);
      const n = nums.length ? Number(nums[0]) : NaN;
      if (!Number.isFinite(n)) return { raw, problem: `"${raw.slice(0, 40)}" is not a number` };
      if (!inQuote.has(String(n))) return { raw, problem: `number ${n} does not appear in the quoted text` };
      return { value: n, raw };
    }
    case 'list': {
      const items = (Array.isArray(rawValue) ? rawValue.map((x) => rawString(x)) : raw.split(/[,;،؛\n]+/)).map((x) => x.trim()).filter(Boolean);
      if (!items.length) return { raw, problem: 'list is empty' };
      const sec = normalizeText(sectionText);
      const missing = items.filter((x) => !sec.includes(normalizeText(x)));
      if (missing.length) return { raw, problem: `list item(s) not found in the cited section: ${missing.slice(0, 3).join(' | ')}` };
      return { value: items.slice(0, 50), raw };
    }
    default: {
      const sec = normalizeText(sectionText);
      if (!sec.includes(normalizeText(raw))) return { raw, problem: `value "${raw.slice(0, 60)}" does not appear in the cited section (copy it as written)` };
      return { value: raw.slice(0, 1000), raw };
    }
  }
}

/**
 * Validates the document-intelligence agent output against the document that was sent and the entity catalogue:
 * docType ∈ catalogue (or OTHER); every field key defined for that type; every field cites a section of this
 * document with a quote that appears in it; dates → ISO, amounts → number + currency; numbers in the summaries
 * must appear in the document. Anything else is a problem (one repair turn, then the run fails).
 */
export function validateDocumentInsight(obj: unknown, doc: DocText, catalogue: DocTypeDef[]): Validated<DocumentInsight> {
  const problems: string[] = [];
  if (!isObj(obj)) return { problems: ['top-level value is not a JSON object'], citations: [], dropped: 0 };
  const codes = new Map(catalogue.map((t) => [t.code.toUpperCase(), t]));
  const rawType = str(obj.docType).toUpperCase();
  const type = codes.get(rawType);
  let docType = type?.code ?? (rawType === 'OTHER' ? 'OTHER' : '');
  if (!docType) problems.push(`"docType" must be one of: ${[...catalogue.map((t) => t.code), 'OTHER'].filter((v, i, a) => a.indexOf(v) === i).join(', ')}`);
  const lang = str(obj.language).toLowerCase();
  const language: DocumentInsight['language'] = lang === 'ar' || lang === 'en' || lang === 'mixed' ? lang
    : (() => { const all = doc.sections.map((s) => s.text).join('\n'); const ar = (all.match(/[؀-ۿ]/g) ?? []).length; const en = (all.match(/[A-Za-z]/g) ?? []).length; return ar && en && Math.min(ar, en) / Math.max(ar, en) > 0.25 ? 'mixed' : ar > en ? 'ar' : 'en'; })();
  const defs = new Map((type?.fields ?? []).map((f) => [f.key.toLowerCase(), f]));
  const fields: ExtractedField[] = [];
  const citations: Citation[] = [];
  if (obj.fields != null && !Array.isArray(obj.fields)) problems.push('"fields" must be an array');
  (Array.isArray(obj.fields) ? obj.fields : []).forEach((f, i) => {
    if (!isObj(f)) { problems.push(`fields[${i}] is not an object`); return; }
    const key = str(f.key);
    const def = defs.get(key.toLowerCase());
    if (!def) { problems.push(`fields[${i}].key "${key}" is not defined for docType ${docType || '(invalid)'}${docType === 'OTHER' ? ' (OTHER has no fields)' : ''}`); return; }
    if (fields.some((x) => x.key === def.key)) return; // first value wins
    const c = isObj(f.citation) ? f.citation : null;
    if (!c) { problems.push(`fields[${i}] (${def.key}) has no citation`); return; }
    const resolved = resolveCitation({ documentId: doc.documentId, title: doc.title, section: c.section, quote: c.quote }, [doc]);
    if (!resolved) { problems.push(`fields[${i}] (${def.key}) cites section "${str(c.section).slice(0, 60)}" which is not a section of the document`); return; }
    if (!resolved.quote) { problems.push(`fields[${i}] (${def.key}) quote does not appear in section "${resolved.section}" (copy an exact excerpt)`); return; }
    const sectionText = doc.sections.find((s) => s.section === resolved.section)?.text ?? '';
    const nv = normaliseFieldValue(def.type, f.value, resolved.quote, sectionText);
    if (nv.problem || nv.value === undefined) { problems.push(`fields[${i}] (${def.key}) ${nv.problem ?? 'has no value'}`); return; }
    fields.push({ key: def.key, value: nv.value, raw: nv.raw.slice(0, 500), citation: { ...resolved, quote: resolved.quote } });
    citations.push(resolved);
  });
  const summaryEn = str(obj.summaryEn); const summaryAr = str(obj.summaryAr);
  if (!summaryEn) problems.push('"summaryEn" must be a non-empty English string');
  if (!summaryAr) problems.push('"summaryAr" must be a non-empty Arabic string');
  else if (!hasArabic(summaryAr)) problems.push('"summaryAr" must be written in Arabic');
  const inputText = `${doc.title}\n${doc.sections.map((s) => `${s.section}\n${s.text}`).join('\n')}`;
  for (const [f, v] of [['summaryEn', summaryEn], ['summaryAr', summaryAr]] as const) {
    const bad = numbersNotInInput(v, inputText); if (bad.length) problems.push(numberProblem(`"${f}"`, bad));
  }
  const top = citationsOf(obj.citations, [doc]);
  for (const c of top.citations) if (!citations.some((x) => x.section === c.section)) citations.push(c);
  if (!docType) docType = '';
  const value: DocumentInsight = { docType, language, fields, summaryEn, summaryAr, citations };
  return { value: problems.length ? undefined : value, problems, citations, dropped: top.dropped };
}

// ================================================================ Admin builder

type Kind = 'string' | 'object' | 'boolean' | 'array';
/** Top-level keys of each admin operation. Anything else is rejected (the content of objects is validated by TenderFlow's services). */
export const ADMIN_OP_SPEC: Record<AdminOpType, { required: Record<string, Kind>; optional: Record<string, Kind> }> = {
  CREATE_TEMPLATE: { required: { code: 'string', nameEn: 'string', nameAr: 'string' }, optional: { description: 'string', baseCode: 'string', changes: 'object' } },
  NEW_TEMPLATE_VERSION: { required: { code: 'string' }, optional: { nameEn: 'string', nameAr: 'string', description: 'string', changes: 'object' } },
  ADD_RULE: { required: { rule: 'object' }, optional: {} },
  UPDATE_RULE: { required: { ruleId: 'string', changes: 'object' }, optional: {} },
  SET_RULE_ENABLED: { required: { ruleId: 'string', enabled: 'boolean' }, optional: {} },
  ADD_FORM_FIELD: { required: { form: 'string', field: 'object' }, optional: {} },
  UPDATE_FORM_FIELD: { required: { form: 'string', key: 'string', changes: 'object' }, optional: {} },
  ADD_FORM_SECTION: { required: { form: 'string', section: 'object' }, optional: {} },
  ADD_DOCUMENT_TYPE: { required: { code: 'string', nameEn: 'string', nameAr: 'string', contexts: 'array' }, optional: { fields: 'array' } },
};
export const MAX_ADMIN_OPERATIONS = 20;

const kindOf = (v: unknown): Kind | 'other' =>
  typeof v === 'string' ? 'string' : typeof v === 'boolean' ? 'boolean' : Array.isArray(v) ? 'array' : v && typeof v === 'object' ? 'object' : 'other';

/**
 * Strict shape check of a list of admin operations (shared by the agent reply and the Orchestrate tool path):
 * known "op" values only, required keys present with the right type, no unknown keys (null optional keys are dropped).
 */
export function parseAdminOperations(raw: unknown): { operations?: AdminOperation[]; problems: string[] } {
  const problems: string[] = [];
  if (!Array.isArray(raw)) return { problems: ['"operations" must be an array'] };
  if (raw.length > MAX_ADMIN_OPERATIONS) return { problems: [`at most ${MAX_ADMIN_OPERATIONS} operations per proposal`] };
  const out: AdminOperation[] = [];
  raw.forEach((o: any, i) => {
    const p = `operations[${i}]`;
    if (!o || typeof o !== 'object' || Array.isArray(o)) { problems.push(`${p} must be an object`); return; }
    const spec = ADMIN_OP_SPEC[o.op as AdminOpType];
    if (!spec) { problems.push(`${p}.op "${String(o.op)}" is not one of ${ADMIN_OP_TYPES.join(', ')}`); return; }
    const clean: AdminOperation = { op: o.op };
    for (const [k, v] of Object.entries(o)) {
      if (k === 'op') continue;
      const want = spec.required[k] ?? spec.optional[k];
      if (!want) { problems.push(`${p} (${o.op}) has an unknown key "${k}"`); continue; }
      if (v === null && !spec.required[k]) continue;
      if (kindOf(v) !== want) { problems.push(`${p}.${k} must be ${want === 'array' ? 'an array' : `a${want === 'object' ? 'n' : ''} ${want}`}`); continue; }
      if (typeof v === 'string' && v.length > 4000) { problems.push(`${p}.${k} is too long`); continue; }
      clean[k] = v;
    }
    for (const k of Object.keys(spec.required)) if (!(k in clean) && !problems.some((x) => x.startsWith(`${p}.${k} `))) problems.push(`${p} (${o.op}) needs "${k}"`);
    out.push(clean);
  });
  return problems.length ? { problems } : { operations: out, problems: [] };
}

function bilingual(v: unknown, path: string, problems: string[]): Bilingual | undefined {
  const o = v as { en?: unknown; ar?: unknown } | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) { problems.push(`${path} must be an object {"en","ar"}`); return undefined; }
  const extra = Object.keys(o).filter((k) => k !== 'en' && k !== 'ar');
  if (extra.length) problems.push(`${path} has unknown key(s) ${extra.join(', ')}`);
  const en = typeof o.en === 'string' ? o.en.trim() : '';
  const ar = typeof o.ar === 'string' ? o.ar.trim() : '';
  if (!en) problems.push(`${path}.en must be a non-empty English text`);
  if (!ar) problems.push(`${path}.ar must be a non-empty Arabic text`);
  if (en.length > 2000 || ar.length > 2000) problems.push(`${path} is too long (max 2000 characters per language)`);
  return en && ar ? { en, ar } : undefined;
}

/** Validates the admin builder reply: {"reply":{"en","ar"}, "operations":[...], "questions":[{"en","ar"}]} — nothing else. */
export function validateAdminPlan(obj: unknown): Validated<AdminPlan> {
  const problems: string[] = [];
  const o = obj as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { problems: ['the reply must be a JSON object'], citations: [], dropped: 0 };
  const extra = Object.keys(o).filter((k) => !['reply', 'operations', 'questions'].includes(k));
  if (extra.length) problems.push(`unknown top-level key(s): ${extra.join(', ')} (allowed: reply, operations, questions)`);
  const reply = bilingual(o.reply, 'reply', problems);
  const ops = parseAdminOperations(o.operations ?? []);
  problems.push(...ops.problems);
  const questions: Bilingual[] = [];
  if (o.questions !== undefined && o.questions !== null) {
    if (!Array.isArray(o.questions)) problems.push('"questions" must be an array');
    else if (o.questions.length > 5) problems.push('at most 5 questions');
    else o.questions.forEach((q, i) => { const b = bilingual(q, `questions[${i}]`, problems); if (b) questions.push(b); });
  }
  if (problems.length || !reply || !ops.operations) return { problems, citations: [], dropped: 0 };
  return { value: { reply, operations: ops.operations, questions }, problems: [], citations: [], dropped: 0 };
}
