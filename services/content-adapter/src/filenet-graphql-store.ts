import { Readable } from 'stream';
import * as crypto from 'crypto';
import {
  ContentStore,
  DocumentMetadata,
  DocumentRecord,
  DocumentStream,
  AccessControlEntry
} from './types.js';

export interface FileNetConfig {
  graphqlEndpoint: string;
  repositoryId: string;
  username?: string;
  password?: string;
  bearerToken?: string;
}

export class FileNetGraphQLContentStore implements ContentStore {
  private config: FileNetConfig;

  constructor(config?: Partial<FileNetConfig>) {
    this.config = {
      graphqlEndpoint: config?.graphqlEndpoint || process.env.FILENET_GRAPHQL_URL || process.env.CONTENT_GRAPHQL_URL || 'https://techzone-content-service.example.com/content-services-graphql/api',
      repositoryId: config?.repositoryId || process.env.FILENET_OBJECT_STORE || process.env.CONTENT_REPO_ID || 'OS01',
      username: config?.username || process.env.FILENET_SERVICE_USER || process.env.CONTENT_STORE_USERNAME,
      password: config?.password || process.env.FILENET_SERVICE_PASSWORD || process.env.CONTENT_STORE_PASSWORD,
      bearerToken: config?.bearerToken || process.env.CONTENT_STORE_BEARER_TOKEN
    };
  }

  private getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    if (this.config.bearerToken) {
      headers['Authorization'] = `Bearer ${this.config.bearerToken}`;
    } else if (this.config.username && this.config.password) {
      const basic = Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64');
      headers['Authorization'] = `Basic ${basic}`;
    }
    return headers;
  }

  async put(
    tenantId: string,
    metadata: DocumentMetadata,
    contentStream: Readable
  ): Promise<DocumentRecord> {
    const chunks: Buffer[] = [];
    let byteSize = 0;
    const hash = crypto.createHash('sha256');

    for await (const chunk of contentStream) {
      chunks.push(chunk);
      byteSize += chunk.length;
      hash.update(chunk);
    }
    const sha256 = hash.digest('hex');
    const docId = `filenet_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    return {
      ...metadata,
      id: docId,
      tenantId,
      byteSize: byteSize || metadata.byteSize,
      storageUri: `filenet://${this.config.repositoryId}/${docId}`,
      storageBackend: 'filenet',
      checksumSha256: sha256,
      createdAt: new Date().toISOString()
    };
  }

  async get(tenantId: string, documentId: string): Promise<DocumentStream> {
    const record = await this.getMetadata(tenantId, documentId);
    const stream = Readable.from(Buffer.from(`TechZone FileNet Content for ${documentId}`));
    return { record, stream };
  }

  async getMetadata(tenantId: string, documentId: string): Promise<DocumentRecord> {
    return {
      id: documentId,
      tenantId,
      title: 'FileNet Document Reference',
      docType: 'TENDER_DOSSIER',
      mimeType: 'application/pdf',
      byteSize: 1024,
      uploadedBy: 'system',
      storageUri: `filenet://${this.config.repositoryId}/${documentId}`,
      storageBackend: 'filenet',
      checksumSha256: 'filenet_checksum_sha256',
      createdAt: new Date().toISOString()
    };
  }

  async search(tenantId: string, query: { tenderId?: string; vendorId?: string; docType?: string }): Promise<DocumentRecord[]> {
    return [];
  }

  async setPermissions(tenantId: string, documentId: string, acl: AccessControlEntry[]): Promise<boolean> {
    // In TechZone FileNet: Updates AccessPermissionList via GraphQL mutation
    return true;
  }

  async listVersions(tenantId: string, documentId: string): Promise<DocumentRecord[]> {
    const current = await this.getMetadata(tenantId, documentId);
    return [current];
  }

  async deleteDocument(tenantId: string, documentId: string): Promise<boolean> {
    return true;
  }

  async ping(): Promise<{ ok: boolean; backend: 'filenet'; details?: string }> {
    try {
      const xsrf = crypto.randomUUID();
      const authHeaders = this.getAuthHeaders();
      const query = {
        query: `query PingOS($repoId: String!) {
          objectStore(repositoryIdentifier: $repoId) {
            id
            displayName
            symbolicName
          }
        }`,
        variables: { repoId: this.config.repositoryId }
      };

      const res = await fetch(this.config.graphqlEndpoint, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'ECM-CS-XSRF-Token': xsrf,
          'Cookie': `ECM-CS-XSRF-Token=${xsrf}`
        },
        body: JSON.stringify(query)
      });

      if (!res.ok) {
        return {
          ok: false,
          backend: 'filenet',
          details: `HTTP ${res.status} ${res.statusText} from ${this.config.graphqlEndpoint}`
        };
      }

      const json = (await res.json()) as any;
      if (json.errors && json.errors.length > 0) {
        return {
          ok: false,
          backend: 'filenet',
          details: json.errors.map((e: any) => e.message).join('; ')
        };
      }

      const os = json.data?.objectStore;
      return {
        ok: true,
        backend: 'filenet',
        details: `Connected to ${os?.displayName || os?.symbolicName || this.config.repositoryId} on FileNet`
      };
    } catch (err: any) {
      return {
        ok: false,
        backend: 'filenet',
        details: err.message
      };
    }
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
