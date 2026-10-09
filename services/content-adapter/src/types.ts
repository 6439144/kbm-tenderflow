import { Readable } from 'stream';

/**
 * Shared Contract: ContentStore Interface
 * Governs document storage abstraction between IBM FileNet Content Manager
 * and File-system store (for local development and CI testing).
 * 
 * Non-negotiable: Document bodies are NEVER stored in PostgreSQL.
 */

export type DocumentType = 
  | 'TENDER_DOSSIER'
  | 'VENDOR_LICENSE'
  | 'TECHNICAL_PROPOSAL'
  | 'FINANCIAL_PROPOSAL'
  | 'ADDENDUM'
  | 'AWARD_NOTICE'
  | 'CLARIFICATION_ATTACHMENT';

export interface DocumentMetadata {
  title: string;
  docType: DocumentType;
  mimeType: string;
  byteSize: number;
  uploadedBy: string;
  tenderId?: string;
  vendorId?: string;
  customProperties?: Record<string, string | number | boolean>;
}

export interface DocumentRecord extends DocumentMetadata {
  id: string;
  tenantId: string;
  storageUri: string;
  storageBackend: 'filenet' | 'filesystem';
  checksumSha256: string;
  createdAt: string;
}

export interface DocumentStream {
  record: DocumentRecord;
  stream: Readable;
}

export interface ContentStore {
  /**
   * Uploads document stream and associates metadata.
   */
  uploadDocument(
    tenantId: string,
    metadata: DocumentMetadata,
    contentStream: Readable
  ): Promise<DocumentRecord>;

  /**
   * Retrieves document metadata and content stream.
   */
  getDocument(tenantId: string, documentId: string): Promise<DocumentStream>;

  /**
   * Retrieves document metadata only without streaming the body.
   */
  getDocumentMetadata(tenantId: string, documentId: string): Promise<DocumentRecord>;

  /**
   * Deletes a document if permitted by policy.
   */
  deleteDocument(tenantId: string, documentId: string): Promise<boolean>;

  /**
   * Health check verifying connectivity to backing repository.
   */
  ping(): Promise<{ ok: boolean; backend: 'filenet' | 'filesystem'; details?: string }>;
}
