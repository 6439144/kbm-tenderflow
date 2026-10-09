import path from 'node:path';
import type { ContentStore } from './types.js';
import { FilesystemStore } from './filesystem-store.js';
import { FileNetStore } from './filenet-store.js';

export type { ContentStore } from './types.js';

export function createContentStore(opts: { type?: string; dataDir: string }): ContentStore {
  const type = (opts.type ?? process.env.CONTENT_STORE_TYPE ?? 'filesystem').toLowerCase();
  if (type === 'filenet') return new FileNetStore();
  if (type === 'filesystem') return new FilesystemStore(path.join(opts.dataDir, 'content'));
  throw new Error(`Unknown CONTENT_STORE_TYPE '${type}' (expected 'filesystem' or 'filenet')`);
}
