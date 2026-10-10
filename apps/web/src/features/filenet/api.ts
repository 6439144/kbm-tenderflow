// FileNet workstream: client for the evidence panel, health page, class model, Navigator probe and FileNet search
// (services/api/src/features/filenet-showcase.ts, filenet-search.ts, filenet-access.ts).
import { http } from '../../api';

export interface RepositoryVersion {
  id: string;
  majorVersionNumber: number | null;
  minorVersionNumber: number | null;
  isCurrentVersion: boolean | null;
  dateCheckedIn: string | null;
}

export interface RepositoryDescription {
  type: 'filesystem' | 'filenet';
  byteSize?: number | null;
  storedSha256?: string | null;
  objectStore?: string;
  objectStoreId?: string | null;
  id?: string;
  name?: string | null;
  className?: string;
  majorVersionNumber?: number | null;
  minorVersionNumber?: number | null;
  isCurrentVersion?: boolean | null;
  versionStatus?: string | null;
  versionSeriesId?: string | null;
  isReserved?: boolean | null;
  dateCreated?: string | null;
  dateCheckedIn?: string | null;
  creator?: string | null;
  mimeType?: string | null;
  cmRetentionDate?: string | null;
  folders?: string[];
  contentElements?: { contentType: string | null; elementSequenceNumber: number | null; contentSize?: number | null; retrievalName?: string | null }[];
  properties?: Record<string, unknown>;
  versions?: RepositoryVersion[];
}

export interface ChainEntry {
  id: string;
  title: string;
  versionNo: number;
  createdAt: string;
  sha256: string | null;
  objectId: string | null;
  repositoryVersion: string | null;
  isRecord: boolean;
  isThis: boolean;
  isLatest: boolean;
  repositoryVersioning?: boolean;
}

export interface EvidenceLinks {
  navigator?: { url: string; reachable: boolean; source: 'configured' | 'derived'; checkedAt: string };
  acce?: { url: string };
  objectId: string | null;
  versionSeriesId: string | null;
  path: string | null;
}

export type Confidentiality = 'PUBLIC' | 'INTERNAL' | 'SEALED' | 'COMMITTEE' | 'AUDIT';

export interface DocumentAccess {
  mode: 'off' | 'groups';
  level: Confidentiality;
  appliedLevel?: Confidentiality | null;
  status: 'NOT_ENFORCED' | 'APPLIED' | 'PENDING' | 'FAILED' | 'UNVERIFIED' | 'INHERITED' | 'UNKNOWN';
  at?: string | null;
  note?: string;
  // staff only
  attempts?: number;
  error?: string | null;
  reason?: string | null;
  grantees?: { name: string; access: 'FULL_CONTROL' | 'VIEW_CONTENT' }[];
}

export interface DocumentEvidenceData {
  documentId: string;
  title: string;
  ownerType: string;
  mimeType: string | null;
  byteSize: number | null;
  createdAt: string;
  storeType: 'filesystem' | 'filenet' | string;
  storeRef: string | null;
  objectStore: string | null;
  classModel?: { mode: string; requested: string; used: string; fallback?: string; refused?: string[] } | null;
  objectId: string | null;
  className: string | null;
  folderPath: string | null;
  repositoryVersioning: boolean;
  versionNo: number;
  supersedesId: string | null;
  versions: ChainEntry[];
  isRecord: boolean;
  recordDeclaredAt: string | null;
  record: { repository: boolean; detail: string } | null;
  encrypted: boolean;
  encryptionNote: string | null;
  sha256: string | null;
  repository: RepositoryDescription | { error: string } | null;
  access?: DocumentAccess;
  aiClassification?: { status: 'WRITTEN' | 'SKIPPED' | 'FAILED'; docType: string; confidence: number | null; detail?: string; at: string } | null;
  links?: EvidenceLinks;
  navigatorUrl: string | null;
}

export interface FolderNode {
  name: string;
  path: string;
  documentCount: number | null;
  more?: boolean;
  deeper?: boolean;
  children: FolderNode[];
}

export interface TelemetryEntry {
  op: 'put' | 'get' | 'describe' | 'declareRecord' | 'setProperties';
  ok: boolean;
  ms: number;
  at: string;
  ref: string | null;
  folder?: string | null;
  error?: string;
}

export interface VerifyReportSummary {
  file: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  ok?: boolean;
  config?: Record<string, unknown>;
  steps?: { step: number; name: string; ok: boolean; status?: 'PASS' | 'FAIL' | 'SKIP'; ms: number | null; error?: string; reason?: string }[];
  summary?: { PASS: number; FAIL: number; SKIP: number } | null;
  documents?: { label: string; id: string; className: string; version: string; byteSize: number; sha256: string }[];
  error?: string;
}

export interface FileNetHealth {
  storeType: 'filesystem' | 'filenet' | string;
  checkedAt: string;
  config: {
    type: string;
    endpointHost?: string;
    endpointTls?: boolean;
    objectStore?: string;
    rootFolder?: string;
    docClass?: string;
    setCustomProperties?: boolean;
    versioning?: boolean;
    recordsMode?: 'none' | 'property' | 'retention';
    retentionDays?: number | null;
    classModel?: 'single' | 'subclasses';
    aclMode?: 'off' | 'groups';
    navigator: { configured: boolean; mode?: 'configured' | 'derived' | 'off'; host?: string; candidates?: string[]; desktop?: string; repositoryId?: string };
    acceUrl?: string | null;
  };
  ping: { ok: boolean; detail: string };
  tfClass: { name: string; exists: boolean | null; error?: string; applicable: boolean };
  folders: { root: string; tree: FolderNode | null; error?: string };
  counts: {
    total: number;
    records: number;
    recordsInRepository: number;
    newerVersions: number;
    encrypted: number;
    byStoreType: { storeType: string; count: number }[];
    byOwnerType: { ownerType: string; storeType: string; count: number }[];
  };
  operations: TelemetryEntry[];
  verifyReport: VerifyReportSummary | null;
}

export interface PropertySpec { name: string; dataType: 'STRING' | 'INTEGER' | 'FLOAT' | 'BOOLEAN'; maxLength?: number; description: string }
export interface ClassStatus { name: string; parent: string; ownerTypes: string[]; exists: boolean | null; present: string[] | null; missing: string[]; error?: string }
export interface FileNetModel {
  storeType: string;
  applicable: boolean;
  mode?: 'single' | 'subclasses';
  fallbackClass?: string;
  status?: { mode: string; checkedAt: string; fallbackClass: string; classes: ClassStatus[]; ready: boolean } | null;
  error?: string | null;
  spec: { classes: { name: string; parent: string; ownerTypes: string[]; properties: PropertySpec[] }[]; levels: { level: Confidentiality; groups: Confidentiality[] }[]; accessMasks: Record<string, number> };
  acl?: { mode: 'off' | 'groups'; serviceGrantee: string; groups: Record<Confidentiality, string | null> };
}
export interface NavigatorProbe {
  storeType: string;
  applicable: boolean;
  mode?: 'configured' | 'derived' | 'off';
  candidates?: string[];
  navigator: { url: string; source: string; reachable: boolean; checkedAt: string; status: number | null; desktop: string; repositoryId: string; tried: { url: string; status: number | null; error?: string; ms: number }[] } | null;
  acce: { url: string } | null;
}
export interface SearchResult {
  documentId: string;
  title: string;
  ownerType: string;
  tenderId: string | null;
  tenderNumber: string | null;
  versionNo: number;
  createdAt: string;
  encrypted: boolean;
  storeType: string;
  isRecord: boolean;
  recordDeclaredAt: string | null;
  supersedesId: string | null;
  objectId: string;
  className: string;
  name: string | null;
  repositoryVersion: string | null;
  properties: Record<string, unknown>;
}
export interface SearchResponse {
  from: string;
  vocabulary: 'model' | 'legacy';
  where: string | null;
  results: SearchResult[];
  repositoryHits: number;
  hidden: number;
  more: boolean;
  note?: string;
}

const qs = (p: Record<string, string>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v.trim()) u.set(k, v.trim());
  const s = u.toString();
  return s ? `?${s}` : '';
};

export const filenetApi = {
  evidence: (documentId: string) => http.get<DocumentEvidenceData>(`/documents/${encodeURIComponent(documentId)}/evidence`),
  health: () => http.get<FileNetHealth>('/filenet/health'),
  model: (refresh = false) => http.get<FileNetModel>(`/filenet/model${refresh ? '?refresh=true' : ''}`),
  navigator: (refresh = false) => http.get<NavigatorProbe>(`/filenet/navigator${refresh ? '?refresh=true' : ''}`),
  search: (p: { q: string; tenderNumber: string; documentType: string }) => http.get<SearchResponse>(`/filenet/search${qs(p)}`),
  /** Audits that the user opened the object in FileNet (Navigator / ACCE) or copied its id. Fire and forget. */
  opened: (documentId: string, target: 'navigator' | 'acce' | 'copy') =>
    http.post<{ recorded: boolean }>(`/documents/${encodeURIComponent(documentId)}/filenet-opened`, { target }).catch(() => undefined),
};

export const SEARCH_DOCUMENT_TYPES = [
  'TENDER_PACK', 'ADDENDUM', 'NOTICE', 'REQUEST_LETTER', 'VENDOR', 'BID_TECHNICAL', 'BID_FINANCIAL',
  'OPENING_RECORD', 'COMMITTEE_REPORT', 'EVALUATION_NARRATIVE', 'EVIDENCE_PACK',
] as const;

export const isRepoError = (r: DocumentEvidenceData['repository']): r is { error: string } => !!r && 'error' in r;

/** Document type label: core doc.* keys first, then this feature's filenet.doc.* keys, else the raw value. */
export function docTypeLabel(te: (prefix: string, v: string | null | undefined) => string, ownerType: string | null | undefined): string {
  const core = te('doc.', ownerType);
  return core !== ownerType ? core : te('filenet.doc.', ownerType);
}
