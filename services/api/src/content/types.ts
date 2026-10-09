// Content store contract (see docs/BUILD-SPEC.md §8).
export interface StoredObject { storeRef: string; storeType: 'filesystem' | 'filenet'; byteSize: number }
export interface ContentStore {
  type: 'filesystem' | 'filenet';
  ping(): Promise<{ ok: boolean; detail: string }>;
  put(input: { tenantId: string; folderPath: string; fileName: string; mimeType: string; bytes: Buffer; properties: Record<string, string> }): Promise<StoredObject>;
  get(storeRef: string): Promise<Buffer>;
}
export class ContentStoreUnavailableError extends Error { code = 'CONTENT_STORE_UNAVAILABLE'; }
