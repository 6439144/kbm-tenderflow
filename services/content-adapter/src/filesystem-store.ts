import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import * as crypto from 'crypto';
import {
  ContentStore,
  DocumentMetadata,
  DocumentRecord,
  DocumentStream
} from './types.js';

export class FileSystemContentStore implements ContentStore {
  private baseDir: string;

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

  async uploadDocument(
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

    return record;
  }

  async getDocument(tenantId: string, documentId: string): Promise<DocumentStream> {
    const record = await this.getDocumentMetadata(tenantId, documentId);
    const tenantDir = this.getTenantDir(tenantId);
    const filePath = path.join(tenantDir, `${documentId}.bin`);

    if (!fs.existsSync(filePath)) {
      throw new Error(`Document payload not found: ${documentId}`);
    }

    const stream = fs.createReadStream(filePath);
    return { record, stream };
  }

  async getDocumentMetadata(tenantId: string, documentId: string): Promise<DocumentRecord> {
    const tenantDir = this.getTenantDir(tenantId);
    const metaPath = path.join(tenantDir, `${documentId}.json`);

    if (!fs.existsSync(metaPath)) {
      throw new Error(`Document metadata not found: ${documentId} for tenant ${tenantId}`);
    }

    const raw = await fs.promises.readFile(metaPath, 'utf-8');
    return JSON.parse(raw) as DocumentRecord;
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
}
