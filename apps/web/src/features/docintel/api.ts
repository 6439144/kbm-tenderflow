// Document intelligence client (services/api/src/features/document-intelligence.ts).
import { http } from '../../api';

export type InsightStatus = 'PENDING_REVIEW' | 'ACCEPTED' | 'CORRECTED' | 'REJECTED' | 'NOT_EXTRACTABLE' | 'FAILED';
export type FieldType = 'text' | 'date' | 'amount' | 'number' | 'list';
export interface AmountValue { amount: number; currency: string | null }
export type FieldValue = string | number | string[] | AmountValue;
export interface FieldCitation { documentId?: string; title?: string; section: string; quote?: string }
export interface InsightField {
  key: string; value: FieldValue; raw: string | null; labelEn: string; labelAr: string; type: FieldType;
  citation: FieldCitation | null; corrected: boolean; aiValue?: FieldValue | null;
}
export type FlagCode = 'EXPIRED' | 'EXPIRING_SOON' | 'NAME_MISMATCH' | 'TYPE_MISMATCH' | 'REQUIRED_MISSING' | 'CURRENCY_MISMATCH';
export interface Flag { code: FlagCode; severity: 'HIGH' | 'MEDIUM' | 'LOW'; field?: string; data: Record<string, string | number | string[]> }
export interface Insight {
  id: string; documentId: string; status: InsightStatus; trigger: 'MANUAL' | 'UPLOAD' | 'OPENING' | 'FINANCIAL_OPENING';
  docType: string | null; docTypeNameEn: string | null; docTypeNameAr: string | null;
  aiDocType: string | null; aiDocTypeNameEn: string | null; aiDocTypeNameAr: string | null;
  language: string | null; fields: InsightField[];
  missingFields: { key: string; labelEn: string; labelAr: string; type: FieldType; required: boolean }[];
  summaryEn: string | null; summaryAr: string | null; flags: Flag[]; error: string | null;
  notExtractable: { en: string; ar: string } | null;
  aiRunId: string | null; agent: string | null; model: string | null; orchestrateRunId: string | null; repaired: boolean;
  reviewedBy: string | null; reviewedAt: string | null; reviewReason: string | null;
  filenet: { status: 'WRITTEN' | 'SKIPPED' | 'FAILED'; detail: string; store?: string; at?: string } | null;
  applied: { kind: string; activityCode?: string; grade?: number; at: string }[];
  createdAt: string; canReview: boolean;
  classificationSuggestion: { activityCodes: string[]; unmatched: string[]; grade: number | null; validUntil: string | null } | null;
}
export interface DocInsightState {
  documentId: string; configured: boolean; classifiable: boolean; queued: boolean; canClassify: boolean; insight: Insight | null;
}
export interface QueueItem {
  id: string; documentId: string; title: string; ownerType: string; status: InsightStatus; trigger: string;
  docType: string | null; docTypeNameEn: string | null; docTypeNameAr: string | null; fieldCount: number; flags: Flag[];
  owner: { kind: 'VENDOR' | 'TENDER' | 'REQUEST'; id: string | null; labelEn: string | null; labelAr: string | null; vendorEn?: string | null; vendorAr?: string | null };
  createdAt: string; reviewedAt: string | null; canReview: boolean; agent: string | null;
}
export interface DocTypeDef {
  id: string; code: string; contexts: string[]; nameEn: string; nameAr: string; active: boolean; updatedAt?: string;
  fields: { key: string; labelEn: string; labelAr: string; type: FieldType; required: boolean }[];
}
export interface VerifiedItem { documentId: string; title: string; createdAt: string; latestStatus: InsightStatus | null; verified: Insight | null }
export interface ExtractedTotal {
  bidId: string; sealed: boolean; documentId: string | null; title?: string; queued?: boolean;
  insight: { id: string; status: InsightStatus; docType: string | null; totalAmount: FieldValue | null; citation: FieldCitation | null; flags: Flag[] } | null;
}

const enc = encodeURIComponent;
export const docintelApi = {
  insight: (documentId: string) => http.get<DocInsightState>(`/documents/${enc(documentId)}/insight`),
  latest: (ids: string[]) => http.get<{ configured: boolean; items: Record<string, DocInsightState> }>(`/document-insights/latest?documentIds=${ids.map(enc).join(',')}`),
  classify: (documentId: string) => http.post<Insight>(`/documents/${enc(documentId)}/ai/classify`, {}),
  review: (id: string, body: { decision: 'ACCEPT' | 'CORRECT' | 'REJECT'; fields?: { key: string; value: unknown }[]; docType?: string; reason?: string }) =>
    http.post<Insight>(`/document-insights/${enc(id)}/review`, body),
  applyClassification: (id: string, body: { activityCode: string; grade: number; validUntil?: string | null; confirm: true }) =>
    http.post<unknown>(`/document-insights/${enc(id)}/apply-classification`, body),
  queue: (f: { status?: string; ownerType?: string; docType?: string }) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    const s = p.toString();
    return http.get<{ configured: boolean; counts: Record<string, number>; docTypes: string[]; items: QueueItem[] }>(`/document-insights${s ? `?${s}` : ''}`);
  },
  types: (all = false) => http.get<DocTypeDef[]>(`/document-types${all ? '?all=true' : ''}`),
  createType: (b: Omit<DocTypeDef, 'id' | 'updatedAt'>) => http.post<DocTypeDef>('/document-types', b),
  patchType: (id: string, b: Partial<Omit<DocTypeDef, 'id' | 'code'>>) => http.patch<DocTypeDef>(`/document-types/${enc(id)}`, b),
  myVerified: () => http.get<{ configured: boolean; items: VerifiedItem[] }>('/vendor/me/verified-documents'),
  vendorVerified: (vendorId: string) => http.get<{ configured: boolean; items: VerifiedItem[] }>(`/vendors/${enc(vendorId)}/verified-documents`),
  extractedTotals: (tenderId: string) => http.get<{ configured: boolean; tenderCurrency: string; items: ExtractedTotal[] }>(`/tenders/${enc(tenderId)}/extracted-totals`),
};

export const DONE: InsightStatus[] = ['PENDING_REVIEW', 'ACCEPTED', 'CORRECTED', 'REJECTED', 'NOT_EXTRACTABLE', 'FAILED'];
export const CONTEXTS = ['VENDOR', 'BID_TECHNICAL', 'BID_FINANCIAL', 'TENDER_PACK', 'ADDENDUM', 'REQUEST_LETTER', 'ENTITY'] as const;
export const FIELD_TYPES: FieldType[] = ['text', 'date', 'amount', 'number', 'list'];
