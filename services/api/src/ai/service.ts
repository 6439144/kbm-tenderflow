// AiService implementation backed by watsonx Orchestrate agents (outbound REST only).
// Never returns canned output: if not configured → AiNotConfiguredError; if the call or the output
// fails → OrchestrateError / AiOutputError (after one JSON-repair turn).

import { AiNotConfiguredError, type AiResult, type AiService, type Citation, type DocText } from './types.js';
import { type AgentRole, type AiConfig, isConfigComplete, missingSettings, readAiConfig } from './config.js';
import { OrchestrateClient, type InvokeResult } from './orchestrate-client.js';
import {
  buildChatPrompt, buildClarificationPrompt, buildClassifyPrompt, buildCompliancePrompt, buildGradePrompt, buildNarrativePrompt,
  buildDocumentIntelligencePrompt, buildNoticePrompt, buildPackCheckPrompt, buildRankingPrompt, buildRepairPrompt, chatInputText, documentsText, narrativeInputText,
  noticeInputText, CHAT_SCHEMA, DOCINTEL_SCHEMA, CLARIFICATION_SCHEMA, CLASSIFY_SCHEMA, COMPLIANCE_SCHEMA, NARRATIVE_SCHEMA, NOTICE_SCHEMA, PACK_SCHEMA,
  RANKING_SCHEMA,
} from './prompts.js';
import {
  AiOutputError, extractJsonObject, validateChat, validateClarification, validateDocumentInsight, validateClassification, validateCompliance, validateNarrative,
  validateNotice, validatePackCheck, validateRanking, type Validated,
} from './parse.js';
import { detectLanguage } from './text-utils.js';

export { OrchestrateError } from './orchestrate-client.js';
export { AiOutputError } from './parse.js';

export interface CreateAiServiceOptions {
  env?: NodeJS.ProcessEnv;
  /** Test hooks only. */
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  retryDelayMs?: number;
}

/** Orchestrate metadata of a call, returned as AiResult.raw (recorded with the ai_run). */
export interface RunMeta { runId: string; threadId: string; text: string; repaired: boolean; droppedCitations: number; durationMs: number }

type TextValidator<T> = (text: string) => Validated<T>;

export function createAiService(options: CreateAiServiceOptions = {}): AiService {
  const cfg: AiConfig = readAiConfig(options.env ?? process.env);
  let client: OrchestrateClient | undefined;

  const getClient = (): OrchestrateClient => {
    if (!isConfigComplete(cfg)) throw new AiNotConfiguredError(`watsonx Orchestrate is not configured (missing: ${missingSettings(cfg).join(', ')}).`);
    client ??= new OrchestrateClient({
      instanceUrl: cfg.instanceUrl, apiKey: cfg.apiKey, iamUrl: cfg.iamUrl, timeoutMs: cfg.timeoutMs,
      fetchImpl: options.fetchImpl, pollIntervalMs: options.pollIntervalMs, retryDelayMs: options.retryDelayMs,
    });
    return client;
  };

  /** One agent turn + at most one repair turn on the same thread; the validator sees the raw reply text. */
  async function runText<T>(role: AgentRole, prompt: string, schema: string, validate: TextValidator<T>, threadId?: string): Promise<AiResult<T>> {
    const c = getClient();
    const agentRef = cfg.agents[role];
    const t0 = Date.now();
    const first: InvokeResult = await c.invokeAgent(agentRef, prompt, { timeoutMs: cfg.timeoutMs, threadId });
    let result = validate(first.text);
    let last = first; let repaired = false;
    if (result.value === undefined) {
      repaired = true;
      last = await c.invokeAgent(agentRef, buildRepairPrompt(result.problems, schema), { timeoutMs: cfg.timeoutMs, threadId: first.threadId });
      result = validate(last.text);
      if (result.value === undefined) {
        throw new AiOutputError(`Agent "${first.agentName}" returned output that is not valid for this task after one repair attempt: ${result.problems.slice(0, 5).join('; ')}`, last.text.slice(0, 2000));
      }
    }
    const meta: RunMeta = { runId: last.runId, threadId: last.threadId, text: last.text, repaired, droppedCitations: result.dropped, durationMs: Date.now() - t0 };
    return { ok: true, agent: first.agentName, model: first.model, output: result.value as T, citations: dedupe(result.citations), raw: meta };
  }

  let statusCache: { at: number; value: { checked: boolean; missing: { role: string; name: string }[]; detail?: string } } | null = null;

  const run = <T>(role: AgentRole, prompt: string, schema: string, validate: (obj: unknown) => Validated<T>) =>
    runText(role, prompt, schema, (text) => jsonThen(text, validate));

  return {
    isConfigured: () => isConfigComplete(cfg),

    async ping() {
      if (!isConfigComplete(cfg)) return { ok: false, detail: `not configured (missing: ${missingSettings(cfg).join(', ')})` };
      try {
        const c = getClient();
        await c.getToken();
        const agents = await c.listAgents();
        const names = new Set(agents.flatMap((a) => [a.name, a.id]));
        const roles = Object.keys(cfg.agents) as AgentRole[];
        const status = roles.map((r) => `${cfg.agents[r]}=${names.has(cfg.agents[r]) ? 'found' : 'MISSING'}`);
        const allFound = roles.every((r) => names.has(cfg.agents[r]));
        return { ok: allFound, detail: `IAM token OK; ${agents.length} agent(s) on instance; ${status.join(', ')}` };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },

    async agentStatus() {
      if (!isConfigComplete(cfg)) return { checked: false, missing: [], detail: 'not configured' };
      if (statusCache && Date.now() - statusCache.at < 60_000) return statusCache.value;
      let value: { checked: boolean; missing: { role: string; name: string }[]; detail?: string };
      try {
        const agents = await getClient().listAgents();
        const names = new Set(agents.flatMap((a) => [a.name, a.id]));
        const roles = Object.keys(cfg.agents) as AgentRole[];
        value = { checked: true, missing: roles.filter((r) => !names.has(cfg.agents[r])).map((r) => ({ role: r, name: cfg.agents[r] })) };
      } catch (e) {
        value = { checked: false, missing: [], detail: (e as Error).message };
      }
      statusCache = { at: Date.now(), value };
      return value;
    },

    async checkTenderPack(input) {
      const prompt = buildPackCheckPrompt(input, cfg.maxDocChars);
      return run('packChecker', prompt, PACK_SCHEMA, (o) => validatePackCheck(o, input.documents));
    },

    async draftClarification(input) {
      const language = detectLanguage(input.question);
      const prompt = buildClarificationPrompt(input, language, cfg.maxDocChars);
      return run('clarification', prompt, CLARIFICATION_SCHEMA, (o) => validateClarification(o, input.documents, language));
    },

    async screenCompliance(input) {
      const keys = input.requiredDocuments.map((r) => r.key);
      const prompt = buildCompliancePrompt(input, cfg.maxDocChars);
      return run('compliance', prompt, COMPLIANCE_SCHEMA, (o) => validateCompliance(o, input.bid.documents, keys));
    },

    async classifyRequest(input) {
      const prompt = buildClassifyPrompt(input, cfg.maxDocChars);
      const r = input.request;
      const inputText = `${r.requestNumber}\n${r.department}\n${r.subject}\n${r.sourceReference ?? ''}\n${documentsText(input.documents)}`;
      return run('requestClassifier', prompt, CLASSIFY_SCHEMA, (o) => validateClassification(o, input.documents,
        input.templates.map((t) => t.code), input.activityCodes.map((c) => c.code), inputText));
    },

    async draftNotice(input) {
      const prompt = buildNoticePrompt(input, cfg.maxDocChars);
      const inputText = noticeInputText(input);
      return run('noticeDrafter', prompt, NOTICE_SCHEMA, (o) => validateNotice(o, input.documents, inputText));
    },

    async rankRelevance(input) {
      const prompt = buildRankingPrompt(input);
      return run('relevanceMatcher', prompt, RANKING_SCHEMA, (o) => validateRanking(o, input.candidates.map((c) => c.id)));
    },

    async narrateEvaluation(input) {
      const prompt = buildNarrativePrompt(input);
      const inputText = narrativeInputText(input);
      return run('evaluationNarrator', prompt, NARRATIVE_SCHEMA, (o) => validateNarrative(o, inputText));
    },

    async reviewGrade(input) {
      const keys = input.criteria.map((c) => c.key);
      const prompt = buildGradePrompt(input, cfg.maxDocChars);
      return run('gradeReviewer', prompt, COMPLIANCE_SCHEMA, (o) => validateCompliance(o, input.documents, keys));
    },

    async classifyDocument(input) {
      const prompt = buildDocumentIntelligencePrompt(input, cfg.maxDocChars);
      return run('documentIntelligence', prompt, DOCINTEL_SCHEMA, (o) => validateDocumentInsight(o, input.document, input.catalogue));
    },

    async chat(input) {
      const prompt = buildChatPrompt(input, Math.min(cfg.maxDocChars, 16000));
      const inputText = chatInputText(input);
      return runText('assistant', prompt, CHAT_SCHEMA, (text) => validateChat(text, input.context, inputText), input.threadId);
    },
  };
}

function jsonThen<T>(text: string, validate: (obj: unknown) => Validated<T>): Validated<T> {
  let obj: unknown;
  try { obj = extractJsonObject(text); } catch { return { problems: ['the reply was not a valid JSON object'], citations: [], dropped: 0 }; }
  return validate(obj);
}

function dedupe(cs: Citation[]): Citation[] {
  const seen = new Set<string>();
  return cs.filter((c) => { const k = `${c.documentId}\u0000${c.section}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export type { DocText };
export { OrchestrateClient };
