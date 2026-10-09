// Filesystem content store (dev/tests). Root = DATA_DIR/content.
import fs from 'node:fs';
import path from 'node:path';
import type { ContentStore, StoredObject } from './types.js';

const safeSegment = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || '_';

export class FilesystemStore implements ContentStore {
  type = 'filesystem' as const;
  constructor(public readonly root: string) {}

  private resolve(ref: string): string {
    const abs = path.resolve(this.root, ref);
    const rootAbs = path.resolve(this.root);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) throw new Error('Invalid store reference');
    return abs;
  }

  async ping() {
    try {
      await fs.promises.mkdir(this.root, { recursive: true });
      const probe = path.join(this.root, `.ping-${process.pid}-${Date.now()}`);
      await fs.promises.writeFile(probe, 'ok');
      await fs.promises.unlink(probe);
      return { ok: true, detail: `filesystem store writable at ${this.root}` };
    } catch (err) {
      return { ok: false, detail: `filesystem store not writable at ${this.root}: ${(err as Error).message}` };
    }
  }

  async put(input: { tenantId: string; folderPath: string; fileName: string; mimeType: string; bytes: Buffer; properties: Record<string, string> }): Promise<StoredObject> {
    const segments = input.folderPath.split('/').filter(Boolean).map(safeSegment);
    const rel = path.posix.join(...segments, safeSegment(input.fileName));
    const abs = this.resolve(rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, input.bytes, { flag: 'wx' });
    await fs.promises.writeFile(`${abs}.meta.json`, JSON.stringify({
      tenantId: input.tenantId, mimeType: input.mimeType, byteSize: input.bytes.length,
      properties: input.properties, storedAt: new Date().toISOString(),
    }, null, 2));
    return { storeRef: rel, storeType: 'filesystem', byteSize: input.bytes.length };
  }

  async get(storeRef: string): Promise<Buffer> {
    return fs.promises.readFile(this.resolve(storeRef));
  }
}
