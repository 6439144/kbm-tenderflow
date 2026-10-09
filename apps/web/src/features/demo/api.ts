// Typed client for the demo routes (/api/v1/demo/*, available only when the server runs with DEMO_MODE=true).
import { http, type User } from '../../api';

export interface DemoPersona { username: string; displayName: string; roles: User['roles']; vendorStatus: string | null }
export interface DemoIntegrations {
  checkedAt: string;
  contentStore: { type: 'filesystem' | 'filenet'; ok: boolean; detail: string };
  ai: { configured: boolean; ok: boolean; detail: string };
}
export interface DemoStatus { enabled: boolean; tenantId: string; me: string; personas: DemoPersona[]; integrations: DemoIntegrations; resetCommand: string }
export interface StoreEvidence {
  type: string | null; ref?: string; encrypted?: boolean; versionNo?: number; isRecord?: boolean; ownerType?: string; title?: string | null;
  declared?: number | null; repositoryDeclared?: number | null; repositoryFailed?: number | null;
}
export interface EvidenceEvent {
  seq: number; at: string; action: string; integration: 'filenet' | 'orchestrate'; resourceType: string; resourceId: string | null;
  actor: string; tenderId: string | null; tenderNumber: string | null;
  store?: StoreEvidence | null; documents?: StoreEvidence[];
  ai?: { kind: string; agent: string | null; model: string | null; status: string; citations: number; error: string | null } | null;
}
export interface ExpireResult { tenderId: string; tenderNumber: string; status: string; originalDeadline: string; submissionDeadline: string; closedAt: string | null }

export const demoApi = {
  status: () => http.get<DemoStatus>('/demo/status'),
  persona: (username: string) => http.post<{ token: string; user: User }>('/demo/persona', { username }),
  expireDeadline: (tenderId: string) => http.post<ExpireResult>(`/demo/tenders/${tenderId}/expire-deadline`),
  evidence: (limit = 60) => http.get<EvidenceEvent[]>(`/demo/evidence?limit=${limit}`),
};
