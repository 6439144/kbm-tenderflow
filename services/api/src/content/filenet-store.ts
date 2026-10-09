// FileNet Content Services GraphQL store. Implementation owned by the FileNet agent (placeholder fails loudly).
import { ContentStore, ContentStoreUnavailableError, StoredObject } from './types.js';
export class FileNetStore implements ContentStore {
  type = 'filenet' as const;
  async ping() { return { ok: false, detail: 'FileNet store not implemented yet' }; }
  async put(): Promise<StoredObject> { throw new ContentStoreUnavailableError('FileNet store not implemented yet'); }
  async get(): Promise<Buffer> { throw new ContentStoreUnavailableError('FileNet store not implemented yet'); }
}
