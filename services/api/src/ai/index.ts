// AI service contract (see docs/BUILD-SPEC.md §8). Implementation: watsonx Orchestrate agents invoked
// outbound over REST (see ./orchestrate-client.ts and agents/README.md for the verified endpoints).
// Exported names/types are unchanged; they now live in ./types.ts and are re-exported here.
export type { DocText, Citation, AiResult, PackFinding, ClarificationDraft, ComplianceItem, AiService } from './types.js';
export { AiNotConfiguredError } from './types.js';
export { createAiService } from './service.js';
