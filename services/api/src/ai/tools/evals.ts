// Eval set loading and scoring for the clarification agent (used by src/tools/run-evals.ts and tests).
import type { ClarificationDraft } from '../types.js';
import { normalizeText } from '../text-utils.js';

export interface EvalQuestion {
  id: string;
  language: 'ar' | 'en';
  question: string;
  expectedKeywords?: string[];
  expectedSections?: string[];
  expectNotFound?: boolean;
}

export interface EvalFile {
  kind: 'clarification';
  description?: string;
  document: string;
  documentId: string;
  tender: { titleEn: string; titleAr: string };
  questions: EvalQuestion[];
}

export interface EvalScore {
  pass: boolean;
  factMatch: boolean | null;     // null for not-found questions
  citationMatch: boolean | null; // null for not-found questions
  notFoundCorrect: boolean;
  missingKeywords: string[];
}

export function validateEvalFile(x: unknown, name: string): EvalFile {
  const f = x as Partial<EvalFile>;
  if (!f || f.kind !== 'clarification' || typeof f.document !== 'string' || typeof f.documentId !== 'string' || !f.tender || !Array.isArray(f.questions)) {
    throw new Error(`${name}: not a clarification eval file (needs kind, document, documentId, tender, questions[])`);
  }
  for (const q of f.questions) {
    if (!q.id || !q.question || (q.language !== 'ar' && q.language !== 'en')) throw new Error(`${name}: invalid question ${JSON.stringify(q).slice(0, 120)}`);
    if (!q.expectNotFound && (!q.expectedKeywords?.length || !q.expectedSections?.length)) throw new Error(`${name}: ${q.id} needs expectedKeywords and expectedSections`);
  }
  return f as EvalFile;
}

/** Each expected keyword entry may hold alternatives separated by "|"; all entries must match. */
export function scoreAnswer(q: EvalQuestion, draft: ClarificationDraft): EvalScore {
  if (q.expectNotFound) {
    const ok = draft.notFound === true;
    return { pass: ok, factMatch: null, citationMatch: null, notFoundCorrect: ok, missingKeywords: [] };
  }
  const answer = normalizeText(draft.answer);
  const missingKeywords = (q.expectedKeywords ?? []).filter((entry) =>
    !entry.split('|').map((alt) => normalizeText(alt)).filter(Boolean).some((alt) => answer.includes(alt)));
  const factMatch = missingKeywords.length === 0;
  const expected = new Set((q.expectedSections ?? []).map((s) => normalizeText(s)));
  const citationMatch = draft.citations.some((c) => expected.has(normalizeText(c.section)));
  const notFoundCorrect = draft.notFound === false;
  return { pass: factMatch && citationMatch && notFoundCorrect, factMatch, citationMatch, notFoundCorrect, missingKeywords };
}
