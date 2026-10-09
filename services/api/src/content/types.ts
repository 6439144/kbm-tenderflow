// Content store contract (see docs/BUILD-SPEC.md §8).
export interface StoredObject { storeRef: string; storeType: 'filesystem' | 'filenet'; byteSize: number; meta?: Record<string, unknown> }

/** Repository-side description of one stored object, as reported by the repository itself (never invented). */
export interface RepositoryDescription {
  type: 'filesystem' | 'filenet';
  /** Size of the stored bytes (ciphertext for sealed bids). */
  byteSize?: number | null;
  /** SHA-256 of the stored bytes, computed by reading them back (filesystem store only). */
  storedSha256?: string | null;
  // FileNet fields (absent for the filesystem store)
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
  versions?: { id: string; majorVersionNumber: number | null; minorVersionNumber: number | null; isCurrentVersion: boolean | null; dateCheckedIn: string | null }[];
}

export interface FolderNode {
  name: string; path: string;
  /** Documents filed directly in this folder (first page only when `more` is true); null when not reported. */
  documentCount: number | null;
  /** True when the repository reported more documents than the first page counted. */
  more?: boolean;
  /** True when sub-folders exist below the requested depth (not listed). */
  deeper?: boolean;
  children: FolderNode[];
}

export interface TelemetryEntry {
  op: 'put' | 'get' | 'describe' | 'declareRecord';
  ok: boolean;
  ms: number;
  at: string;
  /** storeRef (get/describe/declareRecord, or the created object on put) or the target folder (put). */
  ref: string | null;
  folder?: string | null;
  error?: string;
}

export interface ContentStore {
  type: 'filesystem' | 'filenet';
  ping(): Promise<{ ok: boolean; detail: string }>;
  put(input: { tenantId: string; folderPath: string; fileName: string; mimeType: string; bytes: Buffer; properties: Record<string, string>;
    /** storeRef of the document this one supersedes (repositories with versioning may check in a new version). */
    supersedesRef?: string }): Promise<StoredObject>;
  get(storeRef: string): Promise<Buffer>;
  /** Optional: repository-side description of a stored object (class, id, version, folder, properties). */
  describe?(storeRef: string): Promise<RepositoryDescription>;
  /** Optional: declare the object a record / lock it against change. Must not fake success. */
  declareRecord?(storeRef: string, info: { reason: string }): Promise<{ ok: boolean; detail: string }>;
  /** Optional: folder tree (bounded depth) under a TenderFlow-relative folder, with document counts. */
  folderTree?(folderPath: string, depth: number): Promise<FolderNode | null>;
  /** Optional: last operations recorded by the telemetry wrapper (newest first). */
  telemetry?(limit?: number): TelemetryEntry[];
  /** Optional: the wrapped store (telemetry wrapper only). */
  unwrap?(): ContentStore;
}
export class ContentStoreUnavailableError extends Error { code = 'CONTENT_STORE_UNAVAILABLE'; }
