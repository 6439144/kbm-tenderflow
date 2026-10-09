// FileNet workstream: client for GET /documents/:id/evidence and GET /filenet/health (services/api/src/features/filenet-showcase.ts).
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

export interface DocumentEvidenceData {
  documentId: string;
  title: string;
  ownerType: string;
  mimeType: string | null;
  byteSize: number | null;
  createdAt: string;
  storeType: 'filesystem' | 'filenet' | string;
  storeRef: string;
  objectStore: string | null;
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
  op: 'put' | 'get' | 'describe' | 'declareRecord';
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
  steps?: { step: number; name: string; ok: boolean; ms: number | null; error?: string }[];
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
    navigator: { configured: boolean; host?: string; desktop?: string; repositoryId?: string };
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

export const filenetApi = {
  evidence: (documentId: string) => http.get<DocumentEvidenceData>(`/documents/${encodeURIComponent(documentId)}/evidence`),
  health: () => http.get<FileNetHealth>('/filenet/health'),
};

export const isRepoError = (r: DocumentEvidenceData['repository']): r is { error: string } => !!r && 'error' in r;

/** Document type label: core doc.* keys first, then this feature's filenet.doc.* keys, else the raw value. */
export function docTypeLabel(te: (prefix: string, v: string | null | undefined) => string, ownerType: string | null | undefined): string {
  const core = te('doc.', ownerType);
  return core !== ownerType ? core : te('filenet.doc.', ownerType);
}
