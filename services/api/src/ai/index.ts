// AI service contract (see docs/BUILD-SPEC.md §8). Implementation: watsonx Orchestrate agents invoked
// outbound over REST (see ./orchestrate-client.ts and agents/README.md for the verified endpoints).
// Exported names/types are unchanged; they now live in ./types.ts and are re-exported here.
export type {
  DocText, Citation, AiResult, PackFinding, ClarificationDraft, ComplianceItem, AiService, CodeName, RequestClassification, ClassifyRequestInput,
  NoticeChannel, NoticeDraft, DraftNoticeInput, RelevanceCandidate, RankedItem, RankRelevanceInput, EvaluationNarrative, NarrateEvaluationInput,
  GradeCriterion, ReviewGradeInput, ChatAnswer, ChatInput,
} from './types.js';
export { gradeCriteria, DEFAULT_GRADE_CRITERIA } from './grade-criteria.js';
export { AiNotConfiguredError } from './types.js';
export { createAiService } from './service.js';
