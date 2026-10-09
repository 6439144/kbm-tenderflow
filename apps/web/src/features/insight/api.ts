// Typed client for the insight API: role dashboard, analytics, evidence packs, public tender board.
import { ApiError, downloadFile, http } from '../../api';

export interface WaitingItem {
  kind: 'TENDER' | 'AWARD' | 'REQUEST' | 'NOTICE'; id: string; tenderId: string | null; number: string; titleEn: string; titleAr: string;
  level: number; of: number; role: string; waitingSince: string; ageDays: number;
}
export interface TenderRef { id: string; tenderNumber: string; titleEn: string; titleAr: string }

export interface OfficerSection {
  tendersByStatus: Record<string, number>;
  myDrafts: (TenderRef & { updatedAt: string; packDocuments: number })[];
  clarificationsWaiting: { total: number; items: { id: string; tenderId: string; tenderNumber: string; titleEn: string; titleAr: string; askedAt: string; ageDays: number; language: string }[] };
  documentsNeedingReview: number;
  upcomingDeadlines: (TenderRef & { deadline: string; daysLeft: number; purchases: number })[];
  requestsReadyToConvert: number;
  vendorsPendingReview: number;
}
export interface ApproverSection {
  waiting: WaitingItem[]; waitingCount: number; oldestWaitingDays: number | null; medianWaitingDays: number | null;
  publishedThisMonth: { since: string; count: number; items: (TenderRef & { publishedAt: string })[] };
}
export interface CommitteeSection {
  openingsDue: (TenderRef & { deadline: string; sealedBids: number; overdueDays: number })[] | null;
  financialOpeningsDue: (TenderRef & { technicalEvaluated: number; openedBids: number })[] | null;
  awardsToRecommend: (TenderRef & { evaluationsSubmitted: number })[] | null;
  evaluations: (TenderRef & { status: string; phase: 'SINGLE' | 'TECHNICAL' | 'FINANCIAL'; openedBids: number; scorableBids: number; evaluationsSubmitted: number; evaluators: number; myScored: number | null; myRemaining: number | null })[];
  myScoring: { scored: number; remaining: number } | null;
}
export interface AuditorSection {
  auditChain: { valid: boolean; count: number; brokenAt: number | null; reason: string | null; verifiedAt: string };
  eventsPerDay: { day: string; count: number }[];
  topActions: { action: string; count: number }[];
  eventsThisMonth: number;
  aiRuns: { total: number; failed: number; accepted: number; edited: number; ignored: number; unreviewed: number };
  documentInsights: Record<string, number>;
  records: { documents: number; inRepository: number; tendersLocked: number };
  evidencePacks: { id: string; title: string; tenderNumber: string | null; createdAt: string; sha256: string }[];
}
export interface AdminSection {
  usersByRole: { role: string; active: number; inactive: number }[];
  vendorsByStatus: Record<string, number>;
  vendorsByGrade: { grade: number | null; vendors: number }[];
  fileNet: { storeType: string; ok: boolean; detail: string; documents: { total: number; inFileNet: number; records: number; encrypted: number } };
  orchestrate: { configured: boolean; agentsChecked: boolean; missingAgents: { role: string; name: string }[]; detail: string | null; lastSuccessfulRun: string | null; lastFailedRun: string | null };
  templates: { code: string; version: number; nameEn: string; nameAr: string; status: string; isDefault: boolean; publishedAt: string | null }[];
}
export interface VendorSection {
  vendorStatus: string;
  eligibleOpenTenders: (TenderRef & { deadline: string; eligible: boolean; reasons: { code: string; en: string; ar: string }[]; purchaseRequired: boolean; purchased: boolean; bidSubmitted: boolean; documentPrice: { amount: number; currency: string } | null })[];
  eligibleCount: number;
  purchases: { receiptNumber: string; amount: number; currency: string; gateway: string; testPayment: boolean; status: string; paidAt: string; tenderId: string; tenderNumber: string; titleEn: string; titleAr: string }[];
  bids: { id: string; tenderId: string; tenderNumber: string; titleEn: string; titleAr: string; tenderStatus: string; status: string; submittedAt: string; receiptSha256: string; outcome: string }[];
  expiring: { kind: 'DOCUMENT' | 'CLASSIFICATION'; id: string; titleEn: string; titleAr: string; date: string; expired: boolean }[];
}
export interface RoleDashboard {
  roles: string[]; generatedAt: string;
  officer?: OfficerSection; approver?: ApproverSection; committee?: CommitteeSection; auditor?: AuditorSection; admin?: AdminSection; vendor?: VendorSection;
}

export interface StageSummary { n: number; medianDays: number | null; p90Days: number | null; meanDays: number | null; minDays: number | null; maxDays: number | null }
export interface Analytics {
  range: { from: string; to: string }; generatedAt: string;
  cycleTimes: ({ stage: string; fromEvent: string; toEvent: string } & StageSummary)[];
  tendersByStatus: { status: string; count: number }[];
  tendersByCategory: { category: string; count: number }[];
  participation: {
    tenders: { tenderId: string; tenderNumber: string; titleEn: string; titleAr: string; status: string; category: string; publishedAt: string; eligibleVendors: number; purchased: number | null; bids: number }[];
    summary: { tenders: number; bids: number; meanBidsPerTender: number | null; medianBidsPerTender: number | null; uniqueBidders: number };
    funnel: { eligible: number; purchased: number | null; purchaseTenders: number; bid: number };
  };
  approvalTurnaround: ({ gate: string; level: number; role: string } & StageSummary)[];
  revenue: { gateway: string; testPayment: boolean; currency: string; status: string; purchases: number; amount: number }[];
  aiUsage: { kind: string; total: number; ok: number; error: number; accepted: number; edited: number; ignored: number; unreviewed: number }[];
  documentInsights: { status: string; count: number }[];
  documents: { ownerType: string; storeType: string; count: number; records: number; bytes: number }[];
}

export interface EvidencePack {
  documentId: string; title: string; tenderId: string | null; tenderNumber: string | null; sha256: string; byteSize: number; storeType: string;
  objectId: string | null; folderPath: string | null; createdAt: string; generatedBy: string | null; downloadUrl: string;
  summary?: { documents: number; included: number; excluded: number; sealedBidDocumentsExcluded: number; hashMismatches: number; auditEvents: number; approvals: number };
  auditChain?: { valid: boolean; count: number; brokenAt: number | null };
}

export interface PublicTender {
  entity: { id: string; nameEn: string; nameAr: string }; tenderNumber: string; titleEn: string; titleAr: string; category: string;
  activityCodes: { code: string; nameEn: string | null; nameAr: string | null }[]; submissionDeadline: string; publishedAt: string | null;
  documentPrice: { amount: number; currency: string } | null;
  publications: { channel: 'KUWAIT_ALYOUM' | 'CAPT'; reference: string | null; publishedOn: string | null }[]; url: string;
}
export interface PublicBoard {
  generatedAt: string; count: number; entities: { id: string; nameEn: string; nameAr: string }[];
  activities: { code: string; nameEn: string | null; nameAr: string | null }[]; tenders: PublicTender[];
}

const qs = (p: Record<string, string | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : '';
};

/** Calls an endpoint another workstream may or may not ship; 404 → null (feature absent), other errors propagate. */
export async function optional<T>(path: string): Promise<T | null> {
  try {
    return await http.get<T>(path);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return null;
    throw e;
  }
}

export const insight = {
  dashboard: () => http.get<RoleDashboard>('/insight/dashboard'),
  analytics: (from?: string, to?: string) => http.get<Analytics>(`/insight/analytics${qs({ from, to })}`),
  generatePack: (body: { tenderId: string } | { from: string; to: string }) => http.post<EvidencePack>('/audit/evidence-pack', body),
  packs: (tenderId?: string) => http.get<EvidencePack[]>(`/audit/evidence-packs${qs({ tenderId })}`),
  downloadPack: (p: EvidencePack) => downloadFile(p.downloadUrl, `${p.title}.zip`),
  board: (f: { entity?: string; activity?: string; q?: string }) => http.get<PublicBoard>(`/public/tenders${qs(f)}`),
  /** NOTIFY workstream's escalation list, when present. */
  overdueApprovals: () => optional<unknown[]>('/approvals/overdue'),
  /** MOI workstream's vendor subscription, when present. */
  // Vendor lifecycle (MOI workstream): the subscription part of GET /vendor/me/lifecycle; only shown when the entity requires one.
  mySubscription: async () => {
    const l = await optional<{ subscription?: Record<string, unknown> & { required?: boolean } }>('/vendor/me/lifecycle');
    return l?.subscription && l.subscription.required ? l.subscription : null;
  },
};
