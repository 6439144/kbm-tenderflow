// Typed client for the AI admin builder (/api/v1/admin-agent/*). Every call is a real request; the agent's output is
// only ever shown after TenderFlow validated it.
import { http } from '../../api';

export interface Bilingual { en: string; ar: string }
export type OpType = 'CREATE_TEMPLATE' | 'NEW_TEMPLATE_VERSION' | 'ADD_RULE' | 'UPDATE_RULE' | 'SET_RULE_ENABLED'
  | 'ADD_FORM_FIELD' | 'UPDATE_FORM_FIELD' | 'ADD_FORM_SECTION' | 'ADD_DOCUMENT_TYPE';
export type TargetType = 'TEMPLATE' | 'FORM' | 'RULESET' | 'DOCUMENT_TYPE';
export interface OpTarget { type: TargetType; code: string; action: 'CREATE_DRAFT' | 'UPDATE_DRAFT' | 'CREATE_INACTIVE'; draftVersion: number | null; label: Bilingual }
export interface OpResult {
  index: number; op: OpType; status: 'ok' | 'error'; summary: Bilingual; errors: Bilingual[]; warnings: Bilingual[];
  target: OpTarget | null; diff: { path: string; before: unknown; after: unknown }[];
}
export interface Validation { valid: boolean; results: OpResult[]; errors: Bilingual[]; notes: Bilingual[] }
export interface AppliedRef {
  type: TargetType; id: string; code: string; version: number | null; status: 'DRAFT' | 'INACTIVE'; action: 'CREATED' | 'UPDATED'; label: Bilingual; link: string;
}
export type ProposalStatus = 'PROPOSED' | 'APPLIED' | 'DISCARDED' | 'FAILED';
export type Message =
  | { role: 'admin'; text: string; at: string }
  | { role: 'agent'; reply: Bilingual; questions: Bilingual[]; operations: number; aiRunId: string | null; at: string };
export interface Proposal {
  id: string; status: ProposalStatus; source: 'CHAT' | 'TOOL'; requestText: string; threadId: string | null; aiRunId: string | null; revision: number;
  createdBy: string; createdByName: string | null; createdAt: string; updatedAt: string;
  reply: Bilingual | null; questions: Bilingual[]; operations: { op: OpType; [k: string]: unknown }[];
  validation: Validation; messages: Message[];
  appliedRefs: AppliedRef[] | null; appliedBy: string | null; appliedByName: string | null; appliedAt: string | null; reviewPath: string;
}
export interface ProposalSummary {
  id: string; status: ProposalStatus; source: 'CHAT' | 'TOOL'; requestText: string; revision: number; operations: number; valid: boolean;
  createdByName: string | null; createdAt: string; updatedAt: string; reply: Bilingual | null; appliedAt: string | null;
}
export interface AgentStatus { configured: boolean; agent: { name: string; checked: boolean; imported: boolean | null; detail?: string }; canApply: boolean }

export const adminAgent = {
  status: () => http.get<AgentStatus>('/admin-agent/status'),
  chat: (b: { message: string; proposalId?: string | null; threadId?: string | null }) => http.post<Proposal>('/admin-agent/chat', b),
  list: (status?: ProposalStatus) => http.get<ProposalSummary[]>(`/admin-agent/proposals${status ? `?status=${status}` : ''}`),
  get: (id: string) => http.get<Proposal>(`/admin-agent/proposals/${encodeURIComponent(id)}`),
  apply: (id: string) => http.post<Proposal>(`/admin-agent/proposals/${encodeURIComponent(id)}/apply`),
  discard: (id: string, reason?: string) => http.post<Proposal>(`/admin-agent/proposals/${encodeURIComponent(id)}/discard`, reason ? { reason } : {}),
};
