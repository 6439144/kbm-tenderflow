// AiService implementation backed by watsonx Orchestrate agents (outbound REST only).
// Never returns canned output: if not configured → AiNotConfiguredError; if the call or the output
// fails → OrchestrateError / AiOutputError (after one JSON-repair turn).

import { AiNotConfiguredError, type AiResult, type AiService, type Citation, type DocText } from './types.js';
import { type AgentRole, type AiConfig, isConfigComplete, missingSettings, readAiConfig } from './config.js';
import { OrchestrateClient, OrchestrateError, type InvokeResult } from './orchestrate-client.js';
import {
  buildClarificationPrompt, buildCompliancePrompt, buildPackCheckPrompt, buildRepairPrompt,
  CLARIFICATION_SCHEMA, COMPLIANCE_SCHEMA, PACK_SCHEMA,
} from './prompts.js';
import { AiOutputError, extractJsonObject, validateClarification, validateCompliance, validatePackCheck, type Validated } from './parse.js';
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

interface RunMeta { runId: string; threadId: string; text: string; repaired: boolean; droppedCitations: number }

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

  async function run<T>(role: AgentRole, prompt: string, schema: string, validate: (obj: unknown) => Validated<T>): Promise<AiResult<T>> {
    const c = getClient();
    const agentRef = cfg.agents[role];
    const first: InvokeResult = await c.invokeAgent(agentRef, prompt, { timeoutMs: cfg.timeoutMs });
    let problems: string[];
    let result = tryValidate(first.text, validate);
    let last = first; let repaired = false;
    if (result.value === undefined) {
      problems = result.problems;
      repaired = true;
      last = await c.invokeAgent(agentRef, buildRepairPrompt(problems, schema), { timeoutMs: cfg.timeoutMs, threadId: first.threadId });
      result = tryValidate(last.text, validate);
      if (result.value === undefined) {
        throw new AiOutputError(`Agent "${first.agentName}" returned output that is not valid for this task after one repair attempt: ${result.problems.slice(0, 5).join('; ')}`, last.text.slice(0, 2000));
      }
    }
    const meta: RunMeta = { runId: last.runId, threadId: last.threadId, text: last.text, repaired, droppedCitations: result.dropped };
    return { ok: true, agent: first.agentName, model: first.model, output: result.value as T, citations: dedupe(result.citations), raw: meta };
  }

  return {
    isConfigured: () => isConfigComplete(cfg),

    async ping() {
      if (!isConfigComplete(cfg)) return { ok: false, detail: `not configured (missing: ${missingSettings(cfg).join(', ')})` };
      try {
        const c = getClient();
        await c.getToken();
        const agents = await c.listAgents();
        const names = new Set(agents.flatMap((a) => [a.name, a.id]));
        const status = (Object.keys(cfg.agents) as AgentRole[]).map((r) => `${cfg.agents[r]}=${names.has(cfg.agents[r]) ? 'found' : 'MISSING'}`);
        const allFound = (Object.keys(cfg.agents) as AgentRole[]).every((r) => names.has(cfg.agents[r]));
        return { ok: allFound, detail: `IAM token OK; ${agents.length} agent(s) on instance; ${status.join(', ')}` };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
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
  };
}

function tryValidate<T>(text: string, validate: (obj: unknown) => Validated<T>): Validated<T> {
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
