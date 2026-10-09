// Typed client for the platform layer (cycle templates, entity profile, eligibility, purchases, two envelopes,
// requests, publication channels, notifications). Every call is a real request to /api/v1.
import { http } from './api';

export interface ApprovalLevel { role: string; labelEn: string; labelAr: string }
export interface CycleConfig {
  stages: { requestIntake: boolean; documentPurchase: boolean; gazette: boolean; capt: boolean; complianceScreening: boolean; recordsLock: boolean };
  approvals: { request: ApprovalLevel[]; publish: ApprovalLevel[]; award: ApprovalLevel[] };
  envelopes: 'ONE' | 'TWO';
  evaluation: { technicalPassMark: number | null; financialCriteria: string[] };
  eligibility: { activityCodes: string[]; minGrade: number | null };
  fees: { documentPrice: number; currency: string; exemptionAllowed: boolean };
  ai: { packCheck: boolean; clarification: boolean; compliance: boolean; gazette: boolean; relevance: boolean; narrative: boolean; requestClassify: boolean };
}
export interface StageInfo { key: string; kind: 'FIXED' | 'CONFIGURED' | 'OPTIONAL'; enabled: boolean; detail?: string }
export interface CycleTemplate {
  id: string; code: string; version: number; nameEn: string; nameAr: string; description: string; config: CycleConfig;
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED'; isDefault: boolean; createdAt: string; publishedAt: string | null; stages: StageInfo[];
}
export interface EntityProfile {
  nameEn: string; nameAr: string; primaryColor: string; numberingPattern?: string; receiptPattern?: string;
  identityProvider?: 'LOCAL' | 'OIDC'; channels?: { knet?: boolean; gazette?: boolean; capt?: boolean }; fiscalYearStartMonth?: number; logoText?: string; sector?: string;
}
export interface ActivityCode { code: string; nameEn: string; nameAr: string }
export interface Classification { activityCode: string; grade: number; validUntil: string | null; nameEn?: string; nameAr?: string }
export interface Eligibility { eligible: boolean; rule: { activityCodes: string[]; minGrade: number | null }; reasons: { code: string; en: string; ar: string }[] }
export interface Purchase {
  id: string; tenderId: string; vendorId: string; amount: string | number; currency: string; gateway: 'TEST' | 'KNET' | 'EXEMPT'; paymentRef: string | null;
  receiptNumber: string; status: 'PAID' | 'EXEMPTED'; paidAt: string; legalNameEn?: string; legalNameAr?: string;
}
export interface ChainStep { level: number; role: string; labelEn: string; labelAr: string; decision: 'APPROVED' | 'WAITING' | 'PENDING'; approverName: string | null; decidedAt: string | null; reason: string | null }
export interface Publication {
  id: string; channel: 'PORTAL' | 'KUWAIT_ALYOUM' | 'CAPT'; status: 'DRAFT' | 'APPROVED' | 'PUBLISHED'; reference: string | null; publishedOn: string | null;
  noticeEn: string; noticeAr: string; aiRunId: string | null; documentId: string | null;
}
export interface ProcurementRequest {
  id: string; requestNumber: string; department: string; subject: string; description: string; source: 'RASLNI' | 'LETTER';
  sourceReference: string | null; estimatedBudget: number | null; letterDocumentId: string | null; suggestedTemplate: string | null;
  status: 'SUBMITTED' | 'IN_APPROVAL' | 'APPROVED' | 'REJECTED' | 'CONVERTED'; tenderId: string | null; createdAt: string;
  approvalChain?: ChainStep[]; letter?: { id: string; title: string; storeType: string; storeMeta?: Record<string, unknown> } | null; aiRuns?: unknown[];
}
export interface Notification { id: string; kind: string; titleEn: string; titleAr: string; body: Record<string, unknown>; readAt: string | null; createdAt: string }
export interface FinancialOpening { recordDocumentId: string; passMark: number; results: { bidId: string; vendorNameEn: string; vendorNameAr: string; technicalScore: number; result: 'PASSED' | 'FAILED' }[] }

export const platform = {
  profile: () => http.get<EntityProfile>('/entity/profile'),
  saveProfile: (p: Partial<EntityProfile>) => http.put<EntityProfile>('/entity/profile', p),

  templates: (all = false) => http.get<CycleTemplate[]>(`/templates${all ? '?all=true' : ''}`),
  template: (id: string) => http.get<CycleTemplate>(`/templates/${id}`),
  validateTemplate: (config: CycleConfig) => http.post<{ valid: boolean; error?: string; stages?: StageInfo[] }>('/templates/validate', { config }),
  createTemplate: (b: { code: string; nameEn: string; nameAr: string; description?: string; config: CycleConfig }) => http.post<CycleTemplate>('/templates', b),
  updateTemplate: (id: string, b: Partial<{ nameEn: string; nameAr: string; description: string; config: CycleConfig }>) => http.patch<CycleTemplate>(`/templates/${id}`, b),
  publishTemplate: (id: string, makeDefault = false) => http.post<CycleTemplate>(`/templates/${id}/publish`, { makeDefault }),
  setDefaultTemplate: (id: string) => http.post<CycleTemplate>(`/templates/${id}/default`),
  installStarters: () => http.post<CycleTemplate[]>('/templates/install-starters'),

  activityCodes: () => http.get<ActivityCode[]>('/activity-codes'),
  saveActivityCode: (c: ActivityCode) => http.post<ActivityCode>('/activity-codes', c),
  classifications: (vendorId: string) => http.get<Classification[]>(`/vendors/${vendorId}/classifications`),
  myClassifications: () => http.get<Classification[]>('/vendor/me/classifications'),
  setClassification: (vendorId: string, b: { activityCode: string; grade?: number; validUntil?: string; remove?: boolean }) =>
    http.post<Classification[]>(`/vendors/${vendorId}/classifications`, b),

  eligibility: (tenderId: string) => http.get<Eligibility>(`/tenders/${tenderId}/eligibility`),
  purchase: (tenderId: string, gateway: 'TEST' | 'KNET' = 'TEST') => http.post<Purchase>(`/tenders/${tenderId}/purchase`, { gateway }),
  purchases: (tenderId: string) => http.get<Purchase[] | Purchase | null>(`/tenders/${tenderId}/purchases`),
  exempt: (tenderId: string, vendorId: string, reason: string) => http.post<Purchase>(`/tenders/${tenderId}/fee-exemptions`, { vendorId, reason }),

  openFinancial: (tenderId: string, notes?: string) => http.post<FinancialOpening>(`/tenders/${tenderId}/open-financial`, { notes }),

  requests: () => http.get<ProcurementRequest[]>('/requests'),
  request: (id: string) => http.get<ProcurementRequest>(`/requests/${id}`),
  createRequest: (form: FormData) => http.postForm<ProcurementRequest>('/requests', form),
  decideRequest: (id: string, decision: 'APPROVE' | 'RETURN' | 'REJECT', reason?: string) => http.post<ProcurementRequest>(`/requests/${id}/decision`, { decision, reason }),
  convertRequest: (id: string, b: Record<string, unknown>) => http.post<{ id: string; tenderNumber: string }>(`/requests/${id}/convert`, b),

  saveNotice: (tenderId: string, b: { channel: 'KUWAIT_ALYOUM' | 'CAPT'; noticeEn: string; noticeAr: string; aiRunId?: string }) => http.post<Publication>(`/tenders/${tenderId}/notices`, b),
  approveNotice: (id: string) => http.post<Publication>(`/publications/${id}/approve`),
  recordNotice: (id: string, reference: string, publishedOn: string) => http.post<Publication>(`/publications/${id}/record`, { reference, publishedOn }),

  notifications: () => http.get<Notification[]>('/notifications'),
  markRead: (id: string) => http.post<{ ok: boolean }>(`/notifications/${id}/read`),
};
