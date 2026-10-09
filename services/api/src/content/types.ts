// Content store contract (see docs/BUILD-SPEC.md §8).
export interface StoredObject { storeRef: string; storeType: 'filesystem' | 'filenet'; byteSize: number; meta?: Record<string, unknown> }
export interface ContentStore {
  type: 'filesystem' | 'filenet';
  ping(): Promise<{ ok: boolean; detail: string }>;
  put(input: { tenantId: string; folderPath: string; fileName: string; mimeType: string; bytes: Buffer; properties: Record<string, string>;
    /** storeRef of the document this one supersedes (repositories with versioning may check in a new version). */
    supersedesRef?: string }): Promise<StoredObject>;
  get(storeRef: string): Promise<Buffer>;
  /** Optional: repository-side description of a stored object (class, id, version, folder, properties). */
  describe?(storeRef: string): Promise<Record<string, unknown>>;
  /** Optional: declare the object a record / lock it against change. Must not fake success. */
  declareRecord?(storeRef: string, info: { reason: string }): Promise<{ ok: boolean; detail: string }>;
}
export class ContentStoreUnavailableError extends Error { code = 'CONTENT_STORE_UNAVAILABLE'; }
