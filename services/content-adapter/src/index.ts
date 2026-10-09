import { ContentStore } from './types.js';
import { FileSystemContentStore } from './filesystem-store.js';
import { FileNetGraphQLContentStore } from './filenet-graphql-store.js';

export * from './types.js';
export * from './filesystem-store.js';
export * from './filenet-graphql-store.js';

export function createContentStore(storeType?: string): ContentStore {
  const type = storeType || process.env.CONTENT_STORE_TYPE || 'filesystem';
  if (type === 'filenet') {
    return new FileNetGraphQLContentStore();
  }
  return new FileSystemContentStore();
}
