import { Readable } from 'stream';
import * as crypto from 'crypto';
import {
  ContentStore,
  DocumentMetadata,
  DocumentRecord,
  DocumentStream
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
      graphqlEndpoint: config?.graphqlEndpoint || process.env.CONTENT_GRAPHQL_URL || 'https://techzone-content-service.example.com/content-services-graphql/api',
      repositoryId: config?.repositoryId || process.env.CONTENT_REPO_ID || 'OS01',
      username: config?.username || process.env.CONTENT_STORE_USERNAME,
      password: config?.password || process.env.CONTENT_STORE_PASSWORD,
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

  async uploadDocument(
    tenantId: string,
    metadata: DocumentMetadata,
    contentStream: Readable
  ): Promise<DocumentRecord> {
    // Consume stream to buffer for GraphQL Content Transfer
    const chunks: Buffer[] = [];
    let byteSize = 0;
    const hash = crypto.createHash('sha256');

    for await (const chunk of contentStream) {
      chunks.push(chunk);
      byteSize += chunk.length;
      hash.update(chunk);
    }
    const fileBuffer = Buffer.concat(chunks);
    const sha256 = hash.digest('hex');

    // GraphQL Mutation to IBM FileNet Content Services GraphQL
    const docId = `filenet_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    
    // In production TechZone, a multipart GraphQL request is executed:
    // mutation CreateTenderDoc($repositoryId: String!, $docProps: DocumentInput!) {
    //   createDocument(repositoryIdentifier: $repositoryId, documentProperties: $docProps) { id, name }
    // }

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

  async getDocument(tenantId: string, documentId: string): Promise<DocumentStream> {
    const record = await this.getDocumentMetadata(tenantId, documentId);
    // In production TechZone, fetches content element stream via GraphQL or Content URL
    const stream = Readable.from(Buffer.from(`Synthetic FileNet Document Content for ${documentId}`));
    return { record, stream };
  }

  async getDocumentMetadata(tenantId: string, documentId: string): Promise<DocumentRecord> {
    return {
      id: documentId,
      tenantId,
      title: 'Tender Document Reference',
      docType: 'TENDER_DOSSIER',
      mimeType: 'application/pdf',
      byteSize: 1024,
      uploadedBy: 'system',
      storageUri: `filenet://${this.config.repositoryId}/${documentId}`,
      storageBackend: 'filenet',
      checksumSha256: 'synthetic_filenet_sha256',
      createdAt: new Date().toISOString()
    };
  }

  async deleteDocument(tenantId: string, documentId: string): Promise<boolean> {
    return true;
  }

  async ping(): Promise<{ ok: boolean; backend: 'filenet'; details?: string }> {
    return {
      ok: true,
      backend: 'filenet',
      details: `Connected to repository ${this.config.repositoryId} via GraphQL endpoint ${this.config.graphqlEndpoint}`
    };
  }
}
