import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import * as crypto from 'crypto';
import {
  ContentStore,
  DocumentMetadata,
  DocumentRecord,
  DocumentStream,
  AccessControlEntry
} from './types.js';

export class FileSystemContentStore implements ContentStore {
  private baseDir: string;
  private permissions: Map<string, AccessControlEntry[]> = new Map();

  constructor(baseDir?: string) {
    this.baseDir = baseDir || process.env.CONTENT_STORE_FS_PATH || path.resolve(process.cwd(), 'data/content-store');
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  private getTenantDir(tenantId: string): string {
    const dir = path.join(this.baseDir, tenantId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  async put(
    tenantId: string,
    metadata: DocumentMetadata,
    contentStream: Readable
  ): Promise<DocumentRecord> {
    const docId = `doc_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const tenantDir = this.getTenantDir(tenantId);
    const filePath = path.join(tenantDir, `${docId}.bin`);
    const metaPath = path.join(tenantDir, `${docId}.json`);

    const hash = crypto.createHash('sha256');
    const writeStream = fs.createWriteStream(filePath);

    let byteCount = 0;

    await new Promise<void>((resolve, reject) => {
      contentStream.on('data', (chunk) => {
        hash.update(chunk);
        byteCount += chunk.length;
      });
      contentStream.pipe(writeStream);
      writeStream.on('finish', () => resolve());
      writeStream.on('error', reject);
      contentStream.on('error', reject);
    });

    const sha256 = hash.digest('hex');

    const record: DocumentRecord = {
      ...metadata,
      id: docId,
      tenantId,
      byteSize: byteCount || metadata.byteSize,
      storageUri: `file://${filePath}`,
      storageBackend: 'filesystem',
      checksumSha256: sha256,
      createdAt: new Date().toISOString()
    };

    await fs.promises.writeFile(metaPath, JSON.stringify(record, null, 2), 'utf-8');

    // Default ACL: service-only
    this.permissions.set(docId, [{ grantee: 'TenderFlow_Service', accessLevel: 'FULL_CONTROL' }]);

    return record;
  }

  async get(tenantId: string, documentId: string): Promise<DocumentStream> {
    const record = await this.getMetadata(tenantId, documentId);
    const tenantDir = this.getTenantDir(tenantId);
    const filePath = path.join(tenantDir, `${documentId}.bin`);

    if (!fs.existsSync(filePath)) {
      throw new Error(`Document payload not found: ${documentId}`);
    }

    const stream = fs.createReadStream(filePath);
    return { record, stream };
  }

  async getMetadata(tenantId: string, documentId: string): Promise<DocumentRecord> {
    const tenantDir = this.getTenantDir(tenantId);
    const metaPath = path.join(tenantDir, `${documentId}.json`);

    if (!fs.existsSync(metaPath)) {
      throw new Error(`Document metadata not found: ${documentId} for tenant ${tenantId}`);
    }

    const raw = await fs.promises.readFile(metaPath, 'utf-8');
    return JSON.parse(raw) as DocumentRecord;
  }

  async search(tenantId: string, query: { tenderId?: string; vendorId?: string; docType?: string }): Promise<DocumentRecord[]> {
    const tenantDir = this.getTenantDir(tenantId);
    const files = await fs.promises.readdir(tenantDir);
    const results: DocumentRecord[] = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        const raw = await fs.promises.readFile(path.join(tenantDir, file), 'utf-8');
        const doc = JSON.parse(raw) as DocumentRecord;
        if (query.tenderId && doc.tenderId !== query.tenderId) continue;
        if (query.vendorId && doc.vendorId !== query.vendorId) continue;
        if (query.docType && doc.docType !== query.docType) continue;
        results.push(doc);
      }
    }
    return results;
  }

  async setPermissions(tenantId: string, documentId: string, acl: AccessControlEntry[]): Promise<boolean> {
    this.permissions.set(documentId, acl);
    return true;
  }

  async listVersions(tenantId: string, documentId: string): Promise<DocumentRecord[]> {
    const current = await this.getMetadata(tenantId, documentId);
    return [current];
  }

  async deleteDocument(tenantId: string, documentId: string): Promise<boolean> {
    const tenantDir = this.getTenantDir(tenantId);
    const filePath = path.join(tenantDir, `${documentId}.bin`);
    const metaPath = path.join(tenantDir, `${documentId}.json`);

    let deleted = false;
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
      deleted = true;
    }
    if (fs.existsSync(metaPath)) {
      await fs.promises.unlink(metaPath);
      deleted = true;
    }
    return deleted;
  }

  async ping(): Promise<{ ok: boolean; backend: 'filesystem'; details?: string }> {
    const writable = fs.existsSync(this.baseDir);
    return {
      ok: writable,
      backend: 'filesystem',
      details: `Directory ready: ${this.baseDir}`
    };
  }

  // Aliases for compatibility
  uploadDocument(tenantId: string, metadata: DocumentMetadata, stream: Readable) {
    return this.put(tenantId, metadata, stream);
  }
  getDocument(tenantId: string, documentId: string) {
    return this.get(tenantId, documentId);
  }
  getDocumentMetadata(tenantId: string, documentId: string) {
    return this.getMetadata(tenantId, documentId);
  }
}
