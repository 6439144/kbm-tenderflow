// Eval cases for the Phase 1 Orchestrate agents (agents/evals/agents/*.json): loading, running through the real
// AiService (so prompts, validation and the repair turn are the production ones) and scoring. Used by
// src/tools/run-evals.ts and by the unit tests (with the fake Orchestrate server).
import type {
  AdminBuilderInput, AiResult, AiService, ChatInput, ClassifyDocumentInput, ClassifyRequestInput, DraftNoticeInput, NarrateEvaluationInput, RankRelevanceInput, ReviewGradeInput,
} from '../types.js';
import { normalizeText } from '../text-utils.js';

export type AgentEvalKind = 'requestClassifier' | 'noticeDrafter' | 'relevanceMatcher' | 'evaluationNarrator' | 'gradeReviewer' | 'assistant' | 'documentIntelligence' | 'adminBuilder';
const KINDS: AgentEvalKind[] = ['requestClassifier', 'noticeDrafter', 'relevanceMatcher', 'evaluationNarrator', 'gradeReviewer', 'assistant', 'documentIntelligence', 'adminBuilder'];

/** Expected extracted field: the normalised value TenderFlow should produce, and where it is written (section + quote). */
export interface ExpectedField { value: string | number; section: string; quote: string; raw?: string }

export interface AgentEvalExpect {
  tenderType?: string[];                 // any of
  activityCodesInclude?: string[];
  urgency?: 'LOW' | 'MEDIUM' | 'HIGH';
  estimatedBudget?: number | null;
  arContains?: string[];                 // each entry may hold alternatives separated by "|"
  enContains?: string[];
  contains?: string[];
  topId?: string;
  status?: Record<string, 'PRESENT' | 'MISSING' | 'UNCLEAR'>;
  notFound?: boolean;
  docType?: string;                      // document intelligence
  fields?: Record<string, ExpectedField>;
  noFields?: boolean;
  opsInclude?: string[];                 // admin builder: each op type must be proposed
  noOperations?: boolean;                // admin builder: out-of-scope request → no operations
}
export interface AgentEvalCase { id: string; agent: AgentEvalKind; language: string; input: unknown; expect: AgentEvalExpect }
export interface AgentEvalFile { kind: 'agent-evals'; description?: string; cases: AgentEvalCase[] }
export interface AgentEvalScore { pass: boolean; checks: { name: string; ok: boolean; detail?: string }[] }

export function validateAgentEvalFile(x: unknown, name: string): AgentEvalFile {
  const f = x as Partial<AgentEvalFile>;
  if (!f || f.kind !== 'agent-evals' || !Array.isArray(f.cases)) throw new Error(`${name}: not an agent eval file (needs kind "agent-evals" and cases[])`);
  const ids = new Set<string>();
  for (const c of f.cases) {
    if (!c?.id || ids.has(c.id)) throw new Error(`${name}: missing or duplicate case id ${c?.id}`);
    ids.add(c.id);
    if (!KINDS.includes(c.agent)) throw new Error(`${name}: ${c.id} has unknown agent "${c.agent}"`);
    if (!c.input || typeof c.input !== 'object') throw new Error(`${name}: ${c.id} has no input`);
    if (!c.expect || !Object.keys(c.expect).length) throw new Error(`${name}: ${c.id} has no expectations`);
  }
  return f as AgentEvalFile;
}

/** Runs one case through the production AiService method of its agent. */
export function runAgentCase(ai: AiService, c: AgentEvalCase): Promise<AiResult<unknown>> {
  switch (c.agent) {
    case 'requestClassifier': return ai.classifyRequest(c.input as ClassifyRequestInput);
    case 'noticeDrafter': return ai.draftNotice(c.input as DraftNoticeInput);
    case 'relevanceMatcher': return ai.rankRelevance(c.input as RankRelevanceInput);
    case 'evaluationNarrator': return ai.narrateEvaluation(c.input as NarrateEvaluationInput);
    case 'gradeReviewer': return ai.reviewGrade(c.input as ReviewGradeInput);
    case 'assistant': return ai.chat(c.input as ChatInput);
    case 'documentIntelligence': return ai.classifyDocument(c.input as ClassifyDocumentInput);
    case 'adminBuilder': return ai.buildAdminProposal(c.input as AdminBuilderInput);
  }
}

const has = (text: string, entry: string) => entry.split('|').map(normalizeText).filter(Boolean).some((alt) => normalizeText(text).includes(alt));

/** Scores a validated output (the service already rejected invalid JSON, unknown codes/ids and invented numbers). */
export function scoreAgentCase(c: AgentEvalCase, output: any): AgentEvalScore {
  const e = c.expect;
  const checks: AgentEvalScore['checks'] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  if (e.tenderType) add('tenderType', e.tenderType.includes(output.tenderType), `got ${output.tenderType}`);
  if (e.activityCodesInclude) for (const k of e.activityCodesInclude) add(`activityCode ${k}`, (output.activityCodes ?? []).includes(k), `got ${(output.activityCodes ?? []).join(',')}`);
  if (e.urgency) add('urgency', output.urgency === e.urgency, `got ${output.urgency}`);
  if (e.estimatedBudget !== undefined) add('estimatedBudget', output.estimatedBudget === e.estimatedBudget, `got ${output.estimatedBudget}`);
  const ar = output.noticeAr ?? output.narrativeAr ?? output.summaryAr ?? output.reply?.ar ?? '';
  const en = output.noticeEn ?? output.narrativeEn ?? output.summaryEn ?? output.reply?.en ?? '';
  for (const k of e.arContains ?? []) add(`ar contains "${k}"`, has(ar, k));
  for (const k of e.enContains ?? []) add(`en contains "${k}"`, has(en, k));
  for (const k of e.contains ?? []) add(`answer contains "${k}"`, has(String(output.answer ?? ''), k));
  if (e.topId) add('top ranked', output.ranked?.[0]?.id === e.topId, `got ${output.ranked?.[0]?.id}`);
  if (e.status) {
    for (const [key, st] of Object.entries(e.status)) {
      const got = (output.items ?? []).find((i: any) => i.requirement === key)?.status;
      add(`${key}=${st}`, got === st, `got ${got}`);
    }
  }
  if (e.notFound !== undefined) add(`notFound=${e.notFound}`, output.notFound === e.notFound, `got ${output.notFound}`);
  if (e.docType) add(`docType=${e.docType}`, output.docType === e.docType, `got ${output.docType}`);
  for (const [key, exp] of Object.entries(e.fields ?? {})) {
    const got = (output.fields ?? []).find((f: any) => f.key === key)?.value;
    const v = got && typeof got === 'object' && !Array.isArray(got) ? got.amount : Array.isArray(got) ? got.join(', ') : got;
    const ok = typeof exp.value === 'number' ? Number(v) === exp.value : typeof v === 'string' && normalizeText(v).includes(normalizeText(String(exp.value)));
    add(`field ${key}=${exp.value}`, ok, `got ${JSON.stringify(got)}`);
  }
  if (e.noFields) add('no fields', (output.fields ?? []).length === 0, `got ${(output.fields ?? []).length}`);
  const ops = (output.operations ?? []).map((o: any) => o.op);
  for (const op of e.opsInclude ?? []) add(`proposes ${op}`, ops.includes(op), `got ${ops.join(',') || 'none'}`);
  if (e.noOperations) add('no operations', ops.length === 0, `got ${ops.join(',')}`);
  return { pass: checks.every((x) => x.ok), checks };
}
