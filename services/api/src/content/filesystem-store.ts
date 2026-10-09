// Filesystem content store (dev/tests). Root = DATA_DIR/content.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ContentStore, FolderNode, RepositoryDescription, StoredObject } from './types.js';

const safeSegment = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || '_';
const META_SUFFIX = '.meta.json';

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
    await fs.promises.writeFile(`${abs}${META_SUFFIX}`, JSON.stringify({
      tenantId: input.tenantId, mimeType: input.mimeType, byteSize: input.bytes.length,
      properties: input.properties, storedAt: new Date().toISOString(),
    }, null, 2));
    return { storeRef: rel, storeType: 'filesystem', byteSize: input.bytes.length };
  }

  async get(storeRef: string): Promise<Buffer> {
    return fs.promises.readFile(this.resolve(storeRef));
  }

  /** Honest minimal description: the bytes are read back and hashed. No absolute paths are returned. */
  async describe(storeRef: string): Promise<RepositoryDescription> {
    const abs = this.resolve(storeRef);
    const bytes = await fs.promises.readFile(abs);
    let storedAt: string | null = null;
    let mimeType: string | null = null;
    try {
      const meta = JSON.parse(await fs.promises.readFile(`${abs}${META_SUFFIX}`, 'utf8'));
      storedAt = typeof meta.storedAt === 'string' ? meta.storedAt : null;
      mimeType = typeof meta.mimeType === 'string' ? meta.mimeType : null;
    } catch { /* sidecar is optional */ }
    return { type: 'filesystem', byteSize: bytes.length, storedSha256: createHash('sha256').update(bytes).digest('hex'), dateCreated: storedAt, mimeType };
  }

  /** Folder tree below a relative folder, `depth` levels deep, counting stored files (not sidecars). */
  async folderTree(folderPath: string, depth: number): Promise<FolderNode | null> {
    const segments = folderPath.split('/').filter(Boolean).map(safeSegment);
    const abs = this.resolve(path.posix.join('.', ...segments));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return null;
    const walk = async (dir: string, rel: string, left: number): Promise<FolderNode> => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const files = entries.filter((e) => e.isFile() && !e.name.endsWith(META_SUFFIX) && !e.name.startsWith('.ping-'));
      const dirs = entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
      const children = left > 0 ? await Promise.all(dirs.slice(0, 200).map((d) => walk(path.join(dir, d.name), `${rel}/${d.name}`, left - 1))) : [];
      return { name: rel.split('/').pop() || '/', path: rel || '/', documentCount: files.length, deeper: left === 0 && dirs.length > 0 ? true : undefined, children };
    };
    return walk(abs, '/' + segments.join('/'), Math.max(0, Math.min(depth, 3)));
  }
}
