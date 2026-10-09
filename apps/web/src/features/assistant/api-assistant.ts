// Typed client for the Orchestrate assistant routes (services/api/src/features/assistant.ts). Real HTTP calls only.
import { http, type AiRun, type Citation, type DocumentMeta } from '../../api';

export interface AssistantStatus {
  configured: boolean;
  /** Which configured agents are missing on the Orchestrate instance (checked:false when the check could not run). */
  agents?: { checked: boolean; missing: { role: string; name: string }[]; detail?: string };
}

export interface ChatReply {
  answer: string;
  notFound: boolean;
  structured: boolean;
  citations: Citation[];
  threadId: string | null;
  runId: string;
  orchestrateRunId: string | null;
  agent: string | null;
  model: string | null;
  createdAt: string;
}

export interface Task {
  kind: string;
  titleEn: string;
  titleAr: string;
  link: string;
  tenderId?: string;
  tenderNumber?: string;
  requestId?: string;
  dueAt?: string | null;
  count?: number;
}

export interface KindStats {
  kind: string;
  total: number;
  ok: number;
  error: number;
  accepted: number;
  edited: number;
  ignored: number;
  unreviewed: number;
  medianDurationMs: number | null;
  timedRuns: number;
  agents: string[];
}

export interface Insights {
  generatedAt: string;
  configured: boolean;
  totals: { runs: number; ok: number; error: number; accepted: number; edited: number; ignored: number; medianDurationMs: number | null; timedRuns: number };
  adoption: { clarificationsAnsweredFromDraft: number; noticesSavedFromDraft: number; narrativesSaved: number };
  byKind: KindStats[];
  firstRunAt: string | null;
  lastRunAt: string | null;
}

/** An ai_run row returned by the new agent routes (kinds beyond the core AiKind union). */
export type AgentRun = Omit<AiRun, 'kind'> & { kind: string; subjectId?: string | null; request?: Record<string, unknown> };

export interface RankedTender {
  tenderId: string;
  tenderNumber: string;
  titleEn: string;
  titleAr: string;
  category: string;
  submissionDeadline: string;
  score: number;
  reasonsEn: string;
  reasonsAr: string;
}
export interface TendersForMe {
  configured: boolean;
  run: { id: string; status: 'OK' | 'ERROR'; error: string | null; agent: string | null; model: string | null; createdAt: string; reviewDecision: string | null } | null;
  ranked: RankedTender[];
  eligibleOpenCount: number;
}

export interface GradeCriterion { key: string; nameEn: string; nameAr: string }

const enc = encodeURIComponent;

export const assistantApi = {
  status: () => http.get<AssistantStatus>('/assistant/status'),
  myTasks: () => http.get<Task[]>('/assistant/my-tasks'),
  chat: (b: { message: string; threadId?: string | null; page?: string; tenderId?: string | null }) =>
    http.post<ChatReply>('/assistant/chat', { message: b.message, threadId: b.threadId || undefined, page: b.page, tenderId: b.tenderId || undefined }),
  insights: () => http.get<Insights>('/assistant/insights'),

  classifyRequest: (requestId: string) => http.post<AgentRun>(`/requests/${enc(requestId)}/ai/classify`),
  draftNotice: (tenderId: string, channel: 'KUWAIT_ALYOUM' | 'CAPT') => http.post<AgentRun>(`/tenders/${enc(tenderId)}/ai/notice`, { channel }),
  rankVendors: (tenderId: string) => http.post<AgentRun>(`/tenders/${enc(tenderId)}/ai/relevance`),
  tendersForMe: () => http.get<TendersForMe>('/vendor/ai/tenders-for-me'),
  rankTendersForMe: () => http.post<TendersForMe>('/vendor/ai/tenders-for-me'),
  draftNarrative: (tenderId: string) => http.post<AgentRun>(`/tenders/${enc(tenderId)}/ai/narrative`),
  saveNarrative: (runId: string, b: { narrativeEn: string; narrativeAr: string }) =>
    http.post<{ reviewDecision: string; document: DocumentMeta }>(`/ai-runs/${enc(runId)}/save-narrative`, b),
  narratives: (tenderId: string) => http.get<DocumentMeta[]>(`/tenders/${enc(tenderId)}/narratives`),
  gradeReview: (vendorId: string, grade: 1 | 2 | 3) => http.post<AgentRun>(`/vendors/${enc(vendorId)}/ai/grade-review`, { grade }),
  gradeReviews: (vendorId: string) =>
    http.get<{ criteria: Record<string, GradeCriterion[]>; runs: AgentRun[] }>(`/vendors/${enc(vendorId)}/ai/grade-review`),
};
