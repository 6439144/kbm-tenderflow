// AI service contract (see docs/BUILD-SPEC.md §8). Re-exported unchanged from ./index.ts.
export interface DocText { documentId: string; title: string; sections: { section: string; text: string }[] }
export interface Citation { documentId: string; title: string; section: string; quote?: string }
export interface AiResult<T> { ok: true; agent: string; model?: string; output: T; citations: Citation[]; raw?: unknown }
export interface PackFinding { severity: 'HIGH' | 'MEDIUM' | 'LOW'; item: string; detail: string; citation?: Citation }
export interface ClarificationDraft { answer: string; language: 'ar' | 'en'; citations: Citation[]; notFound: boolean }
export interface ComplianceItem { requirement: string; status: 'PRESENT' | 'MISSING' | 'UNCLEAR'; evidence?: string; citation?: Citation }

// ---- Phase 1 agents (request intake → publication → matching → evaluation → vendor grading → copilot) ----
export interface CodeName { code: string; nameEn: string; nameAr: string }

export interface RequestClassification {
  tenderType: string;              // one of the template codes supplied
  activityCodes: string[];         // subset of the activity codes supplied
  urgency: 'LOW' | 'MEDIUM' | 'HIGH';
  estimatedBudget: number | null;  // only a figure that appears in the input
  summaryEn: string;
  summaryAr: string;
  citations: Citation[];
}
export interface ClassifyRequestInput {
  request: { requestNumber: string; department: string; subject: string; source: string; sourceReference: string | null };
  documents: DocText[];            // the request record + the extracted GM letter (content store)
  activityCodes: CodeName[];
  templates: CodeName[];
}

export type NoticeChannel = 'KUWAIT_ALYOUM' | 'CAPT';
export interface NoticeDraft { noticeAr: string; noticeEn: string; citations: Citation[] }
export interface DraftNoticeInput {
  channel: NoticeChannel;
  /** Facts from the TenderFlow record, rendered as "label: value" lines. Every date/amount in the notice must come from here or the documents. */
  facts: { label: string; value: string }[];
  documents: DocText[];
}

export interface RelevanceCandidate { id: string; label: string; profile: Record<string, unknown> }
export interface RankedItem { id: string; score: number; reasonsEn: string; reasonsAr: string }
export interface RankRelevanceInput {
  mode: 'VENDORS_FOR_TENDER' | 'TENDERS_FOR_VENDOR';
  subject: { id: string; label: string; profile: Record<string, unknown> };
  /** Already eligible under the rule-based check: the agent only ranks, it never decides eligibility. */
  candidates: RelevanceCandidate[];
}

export interface EvaluationNarrative { narrativeEn: string; narrativeAr: string }
export interface NarrateEvaluationInput {
  tender: { tenderNumber: string; titleEn: string; titleAr: string; envelopes: 'ONE' | 'TWO'; technicalPassMark: number | null };
  criteria: { key: string; nameEn: string; nameAr: string; weight: number }[];
  bids: {
    bidRef: string; vendorNameEn: string; vendorNameAr: string; technicalResult: string | null;
    evaluations: { evaluator: string; weightedTotal: number; scores: { criterion: string; score: number; comment: string }[] }[];
    averageWeightedTotal: number | null;
    compliance: { requirement: string; status: string }[] | null;
  }[];
  recommendedBidRef: string | null;
  recommendationJustification: string | null;
}

export interface GradeCriterion { key: string; nameEn: string; nameAr: string }
export interface ReviewGradeInput {
  vendor: { nameEn: string; nameAr: string; crNumber: string };
  grade: 1 | 2 | 3;
  criteria: GradeCriterion[];
  documents: DocText[];
}

export interface ChatAnswer { answer: string; citations: Citation[]; notFound: boolean; structured: boolean }
export interface ChatInput {
  message: string;
  /** Continue an Orchestrate thread previously returned to the SAME user (checked by the caller). */
  threadId?: string;
  /** Role-scoped context built by TenderFlow (never sealed bid contents, never other vendors' data). */
  context: DocText[];
}

// ---- Document intelligence (classification + cited field extraction of any uploaded document) ----
export type DocFieldType = 'text' | 'date' | 'amount' | 'number' | 'list';
export interface DocTypeField { key: string; labelEn: string; labelAr: string; type: DocFieldType; required: boolean }
/** One entry of the entity's document-type catalogue (only the types allowed for the upload context are sent). */
export interface DocTypeDef { code: string; nameEn: string; nameAr: string; fields: DocTypeField[] }
export interface AmountValue { amount: number; currency: string | null }
export type DocFieldValue = string | number | string[] | AmountValue;
/** An extracted field: value normalised by TenderFlow (ISO date, numeric amount) + the cited section and exact quote. */
export interface ExtractedField { key: string; value: DocFieldValue; raw: string; citation: Citation & { quote: string } }
export interface DocumentInsight {
  docType: string;                 // a catalogue code, or "OTHER"
  language: 'ar' | 'en' | 'mixed';
  fields: ExtractedField[];
  summaryEn: string;
  summaryAr: string;
  citations: Citation[];
}
export interface ClassifyDocumentInput {
  document: DocText;
  /** Upload context from TenderFlow (never personal data beyond what the document itself contains). */
  context: { ownerType: string; uploaderRole: string; slotTitle: string; fileName?: string | null };
  catalogue: DocTypeDef[];
}

// ---- Admin builder (plain-language admin request → structured, validated change proposal; drafts only) ----
/** Operations the admin builder may propose. Each is validated and applied by TenderFlow's own services, as DRAFTS. */
export const ADMIN_OP_TYPES = [
  'CREATE_TEMPLATE', 'NEW_TEMPLATE_VERSION', 'ADD_RULE', 'UPDATE_RULE', 'SET_RULE_ENABLED',
  'ADD_FORM_FIELD', 'UPDATE_FORM_FIELD', 'ADD_FORM_SECTION', 'ADD_DOCUMENT_TYPE',
] as const;
export type AdminOpType = (typeof ADMIN_OP_TYPES)[number];
/** One proposed operation as the agent (or the Orchestrate tool) sent it; the shape per op is checked by parse.ts. */
export interface AdminOperation { op: AdminOpType; [key: string]: unknown }
export interface Bilingual { en: string; ar: string }
export interface AdminPlan { reply: Bilingual; operations: AdminOperation[]; questions: Bilingual[] }
export interface AdminBuilderInput {
  /** The administrator's latest message. */
  message: string;
  /** Continue the Orchestrate thread of this proposal (owned by the same administrator; checked by the caller). */
  threadId?: string;
  /** The entity's current configuration as plain text sections, built by TenderFlow for THIS entity only (no secrets, no bid data). */
  state: { section: string; text: string }[];
  /** Custom-field facts of this entity's published or draft forms, rendered as catalogue lines. */
  customFacts: string[];
  /** The operations of the proposal being refined (null for a new request). */
  currentOperations: AdminOperation[] | null;
  /** Earlier turns of this proposal's conversation. */
  history: { role: 'admin' | 'agent'; text: string }[];
}

export interface AiService {
  isConfigured(): boolean;
  ping(): Promise<{ ok: boolean; detail: string }>;
  /** Which configured agents exist on the instance (cached ~60 s). `checked:false` when the check itself failed. */
  agentStatus(): Promise<{ checked: boolean; missing: { role: string; name: string }[]; detail?: string }>;
  checkTenderPack(input: { tender: { titleEn: string; titleAr: string; category: string; deadline: string; criteria: unknown; requiredDocuments: unknown }; documents: DocText[]; language: 'ar' | 'en' }): Promise<AiResult<{ findings: PackFinding[]; summary: string }>>;
  draftClarification(input: { tender: { titleEn: string; titleAr: string }; question: string; documents: DocText[]; priorAnswers: { question: string; answer: string }[] }): Promise<AiResult<ClarificationDraft>>;
  screenCompliance(input: { requiredDocuments: { key: string; nameEn: string; nameAr: string }[]; bid: { bidId: string; vendorName: string; documents: DocText[] } }): Promise<AiResult<{ items: ComplianceItem[] }>>;
  classifyRequest(input: ClassifyRequestInput): Promise<AiResult<RequestClassification>>;
  draftNotice(input: DraftNoticeInput): Promise<AiResult<NoticeDraft>>;
  rankRelevance(input: RankRelevanceInput): Promise<AiResult<{ ranked: RankedItem[] }>>;
  narrateEvaluation(input: NarrateEvaluationInput): Promise<AiResult<EvaluationNarrative>>;
  reviewGrade(input: ReviewGradeInput): Promise<AiResult<{ items: ComplianceItem[] }>>;
  chat(input: ChatInput): Promise<AiResult<ChatAnswer>>;
  classifyDocument(input: ClassifyDocumentInput): Promise<AiResult<DocumentInsight>>;
  buildAdminProposal(input: AdminBuilderInput): Promise<AiResult<AdminPlan>>;
}
export class AiNotConfiguredError extends Error { code = 'AI_NOT_CONFIGURED'; constructor(msg = 'watsonx Orchestrate is not configured (WXO_INSTANCE_URL / WXO_API_KEY).') { super(msg); } }
