// Typed client for the entity-policies + vendor-lifecycle routes (services/api/src/features/moi.ts).
// Every call is a real request to /api/v1; nothing here fabricates data.
import { http, type DocumentMeta } from '../../api';
import type { Classification } from '../../api-platform';

export type DecisionStatus = 'CONFIRMED' | 'PROPOSED' | 'OPEN';
export type OpenItemStatus = 'CONFIGURABLE' | 'AVAILABLE' | 'IMPLEMENTED' | 'NEEDS_MOI_INPUT';
export interface LabelledCode { code: string; en: string; ar: string }

export interface EntityPolicies {
  visibility: 'CATEGORY' | 'ELIGIBLE_ONLY';
  gradeMatch: 'EXACT' | 'AT_LEAST';
  gradeScope: 'COMPANY' | 'PER_ACTIVITY';
  subscriptionRequired: boolean;
  subscriptionFee: number;
  subscriptionCurrency: string;
  subscriptionTermMonths: number;
  subscriptionStart: 'PAYMENT_DATE' | 'APPROVAL_DATE';
  retainPurchasedAfterExpiry: boolean;
  renewalReminderDays: number[];
  exemptionMode: 'PER_VENDOR' | 'CATEGORY';
  exemptionWaives: 'TENDER_DOCUMENTS' | 'TENDER_DOCUMENTS_AND_SUBSCRIPTION';
  blockRoles: string[];
  blockEffectOnSubscription: 'PAUSE' | 'CONTINUE';
  blockGrounds: LabelledCode[];
  gradingRoles: string[];
  contentProtection: 'NONE' | 'VIEW_ONLY' | 'WATERMARKED_DOWNLOAD';
  registrationDocuments: LabelledCode[];
  activityCodeSource: 'MANUAL' | 'FILE' | 'MOC_API';
  accountProvisioning: 'ADMIN_CREATED' | 'AD_GROUPS';
}
export type PolicyKey = keyof EntityPolicies;

export interface Annotation { ref: string; status: DecisionStatus; en: string; ar: string }
export interface OpenItem { key: string; en: string; ar: string; status: OpenItemStatus; absorbedBy: string[]; noteEn: string; noteAr: string }
export interface Catalogue { reference: string; titleEn: string; titleAr: string; annotations: Record<string, Annotation>; openItems: OpenItem[] }
export interface PoliciesResponse {
  policies: EntityPolicies;
  reference: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  catalogue: Catalogue | null;
}

export interface Subscription {
  id: string; vendorId: string; kind: 'NEW' | 'RENEWAL'; status: 'PENDING_PAYMENT' | 'ACTIVE' | 'EXPIRED' | 'CANCELLED';
  amount: number; currency: string; gateway: 'TEST' | 'KNET' | 'EXEMPT' | null; paymentRef: string | null; receiptNumber: string | null;
  approvedAt: string | null; startsAt: string | null; endsAt: string | null; pausedDays: number; paidAt: string | null; createdAt: string;
  payLink?: string;
}
export interface Block {
  id: string; vendorId: string; mode: 'DATE_RANGE' | 'PERMANENT'; startsAt: string; endsAt: string | null; ground: string | null; reason: string;
  authorisedBy: string; status: 'ACTIVE' | 'ENDED' | 'LIFTED'; endedAt: string | null; liftedBy: string | null; liftReason: string | null; createdAt: string;
}
export interface UpgradeRequest {
  id: string; vendorId: string; requestNumber: string; activityCode: string | null; currentGrade: number | null; requestedGrade: number;
  justification: string; documentIds: string[]; status: 'SUBMITTED' | 'APPROVED' | 'REJECTED'; requestedBy: string; decidedBy: string | null;
  decisionReason: string | null; grantedGrade: number | null; createdAt: string; decidedAt: string | null;
  legalNameEn?: string; legalNameAr?: string; crNumber?: string;
  documents?: DocumentMeta[]; classifications?: Classification[];
}
export type SubscriptionStatus = 'ACTIVE' | 'EXEMPT' | 'PENDING_PAYMENT' | 'EXPIRED' | 'NONE';
export interface Exemption { basis: 'PER_VENDOR' | 'CATEGORY'; reason: string; category: string | null; waives: EntityPolicies['exemptionWaives'] }
export interface Lifecycle {
  vendorId: string; vendorStatus: string; companyGrade: number | null; vendorCategory: string | null;
  subscription: {
    required: boolean; status: SubscriptionStatus; fee: number; currency: string; termMonths: number; startRule: EntityPolicies['subscriptionStart'];
    current: Subscription | null; pending: Subscription | null; paidUntil: string | null; daysLeft: number | null; history: Subscription[];
  };
  exemption: Exemption | null;
  block: Block | null;
  blocks: Block[];
  classifications: Classification[];
  upgradeRequests: UpgradeRequest[];
  registrationDocuments: LabelledCode[];
}
export interface QueueVendor {
  id: string; legalNameEn: string; legalNameAr: string; crNumber: string; email: string; categories: string[]; status: string; createdAt: string;
  documentCount?: number; companyGrade?: number | null; gradedAt?: string | null;
}
export interface GradingQueue {
  gradeScope: EntityPolicies['gradeScope'];
  applications: QueueVendor[];
  upgradeRequests: UpgradeRequest[];
  recentlyGraded: QueueVendor[];
}
export interface GradingVendor {
  vendor: QueueVendor & { phone?: string; decisionReason?: string | null };
  documents: DocumentMeta[];
  lifecycle: Lifecycle;
  gradeScope: EntityPolicies['gradeScope'];
  registrationDocuments: LabelledCode[];
}
export interface AdminVendorRow {
  id: string; legalNameEn: string; legalNameAr: string; crNumber: string; status: string; companyGrade: number | null; vendorCategory: string | null;
  feeExempt: boolean;
  subscription: { status: SubscriptionStatus; paidUntil: string | null; daysLeft: number | null };
  block: Block | null; exemption: Exemption | null; classifications: Classification[];
}
export interface VendorCategory { code: string; nameEn: string; nameAr: string; feeExempt: boolean }
export interface ReceiptView {
  entity: { nameEn: string; nameAr: string; logoText: string | null };
  kind: 'TENDER_DOCUMENTS' | 'SUBSCRIPTION';
  receiptNumber: string; gateway: 'TEST' | 'KNET' | 'EXEMPT' | null; gatewayTransactionId: string | null;
  amount: number; currency: string; paidAt: string | null;
  vendor: { nameEn: string; nameAr: string; crNumber: string };
  tender: { number: string; titleEn: string; titleAr: string } | null;
  period: { startsAt: string; endsAt: string } | null;
  status: string;
  test: boolean;
}
export interface JobsResult { reinstated: number; expired: number; reminders: number }

const enc = encodeURIComponent;

export const moiApi = {
  policies: () => http.get<PoliciesResponse>('/entity/policies'),
  savePolicies: (patch: Partial<EntityPolicies>) => http.put<PoliciesResponse>('/entity/policies', { policies: patch }),

  categories: () => http.get<VendorCategory[]>('/vendor-categories'),
  saveCategory: (c: VendorCategory) => http.post<VendorCategory[]>('/vendor-categories', c),

  gradingQueue: () => http.get<GradingQueue>('/grading/queue'),
  gradingVendor: (id: string) => http.get<GradingVendor>(`/grading/vendors/${enc(id)}`),
  gradeVendor: (id: string, b: { decision: 'APPROVE' | 'REJECT'; reason?: string; activities?: { activityCode: string; grade?: number }[]; companyGrade?: number }) =>
    http.post<{ vendorId: string; status: string; subscription: Subscription | null }>(`/grading/vendors/${enc(id)}/decision`, b),

  upgrades: () => http.get<UpgradeRequest[]>('/grade-upgrades'),
  upgrade: (id: string) => http.get<UpgradeRequest>(`/grade-upgrades/${enc(id)}`),
  decideUpgrade: (id: string, b: { decision: 'APPROVE' | 'REJECT'; reason?: string; grade?: number }) => http.post<UpgradeRequest>(`/grade-upgrades/${enc(id)}/decision`, b),
  requestUpgrade: (form: FormData) => http.postForm<UpgradeRequest>('/vendor/me/grade-upgrades', form),

  myLifecycle: () => http.get<Lifecycle>('/vendor/me/lifecycle'),
  paySubscription: (link: string, gateway: 'TEST' | 'KNET' = 'TEST') => http.post<Subscription>('/vendor/me/subscription/pay', { link, gateway }),
  renew: () => http.post<Subscription>('/vendor/me/subscription/renew'),

  vendorLifecycle: (id: string) => http.get<Lifecycle>(`/vendors/${enc(id)}/lifecycle`),
  adminVendors: () => http.get<AdminVendorRow[]>('/admin/vendor-lifecycle'),
  setExemption: (id: string, b: { feeExempt?: boolean; reason?: string; vendorCategory?: string | null }) => http.post<Lifecycle>(`/vendors/${enc(id)}/exemption`, b),
  block: (id: string, b: { mode: 'DATE_RANGE' | 'PERMANENT'; from?: string; to?: string; ground?: string; reason: string }) => http.post<Block>(`/vendors/${enc(id)}/blocks`, b),
  lift: (id: string, blockId: string, reason: string) => http.post<Block>(`/vendors/${enc(id)}/blocks/${enc(blockId)}/lift`, { reason }),

  receipt: (n: string) => http.get<ReceiptView>(`/receipts/${enc(n)}`),
  runJobs: () => http.post<JobsResult>('/admin/lifecycle/run-jobs'),
  importActivityCodes: (csv: string) => http.post<{ imported: number }>('/activity-codes/import', { csv }),
};

/** The pay-link token from a `/vendor/subscription?link=…` URL. */
export const linkToken = (payLink: string | undefined | null): string | null => {
  if (!payLink) return null;
  const q = payLink.split('?')[1] ?? '';
  return new URLSearchParams(q).get('link');
};
