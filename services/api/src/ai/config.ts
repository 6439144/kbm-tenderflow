// Environment configuration for the Orchestrate AI layer (docs/BUILD-SPEC.md §4).
// Secrets (WXO_API_KEY) are never logged or included in error messages.

export const DEFAULT_IAM_URL = 'https://iam.cloud.ibm.com/identity/token';

export const DEFAULT_AGENT_NAMES = {
  packChecker: 'tenderflow_pack_checker',
  clarification: 'tenderflow_clarification_assistant',
  compliance: 'tenderflow_compliance_screener',
  requestClassifier: 'tenderflow_request_classifier',
  noticeDrafter: 'tenderflow_notice_drafter',
  relevanceMatcher: 'tenderflow_relevance_matcher',
  evaluationNarrator: 'tenderflow_evaluation_narrator',
  gradeReviewer: 'tenderflow_grade_reviewer',
  assistant: 'tenderflow_assistant',
} as const;

/** Environment variable that overrides each agent reference (name or id). */
export const AGENT_ENV: Record<keyof typeof DEFAULT_AGENT_NAMES, string> = {
  packChecker: 'WXO_AGENT_PACK_CHECKER',
  clarification: 'WXO_AGENT_CLARIFICATION',
  compliance: 'WXO_AGENT_COMPLIANCE',
  requestClassifier: 'WXO_AGENT_REQUEST_CLASSIFIER',
  noticeDrafter: 'WXO_AGENT_NOTICE_DRAFTER',
  relevanceMatcher: 'WXO_AGENT_RELEVANCE_MATCHER',
  evaluationNarrator: 'WXO_AGENT_EVALUATION_NARRATOR',
  gradeReviewer: 'WXO_AGENT_GRADE_REVIEWER',
  assistant: 'WXO_AGENT_ASSISTANT',
};

export type AgentRole = keyof typeof DEFAULT_AGENT_NAMES;

export interface AiConfig {
  instanceUrl: string;
  apiKey: string;
  iamUrl: string;
  agents: Record<AgentRole, string>;
  /** Per-call timeout for each HTTP request and the overall run wait (ms). */
  timeoutMs: number;
  /** Max characters of document text placed in one prompt. */
  maxDocChars: number;
}

function clean(v: string | undefined): string {
  return (v ?? '').trim();
}

/** Reads config from an env map (defaults to process.env). Missing values are left empty. */
export function readAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const timeout = Number(clean(env.WXO_TIMEOUT_MS) || '60000');
  const maxChars = Number(clean(env.WXO_MAX_DOC_CHARS) || '24000');
  return {
    instanceUrl: clean(env.WXO_INSTANCE_URL).replace(/\/+$/, ''),
    apiKey: clean(env.WXO_API_KEY),
    iamUrl: clean(env.WXO_IAM_URL) || DEFAULT_IAM_URL,
    agents: Object.fromEntries((Object.keys(DEFAULT_AGENT_NAMES) as AgentRole[])
      .map((r) => [r, clean(env[AGENT_ENV[r]]) || DEFAULT_AGENT_NAMES[r]])) as Record<AgentRole, string>,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 60000,
    maxDocChars: Number.isFinite(maxChars) && maxChars > 1000 ? maxChars : 24000,
  };
}

/** True only when the instance URL and API key are present (agent refs always have defaults). */
export function isConfigComplete(cfg: AiConfig): boolean {
  return Boolean(cfg.instanceUrl && cfg.apiKey && (Object.keys(DEFAULT_AGENT_NAMES) as AgentRole[]).every((r) => cfg.agents[r]));
}

/** Lists missing settings by name only (never values). */
export function missingSettings(cfg: AiConfig): string[] {
  const out: string[] = [];
  if (!cfg.instanceUrl) out.push('WXO_INSTANCE_URL');
  if (!cfg.apiKey) out.push('WXO_API_KEY');
  return out;
}
