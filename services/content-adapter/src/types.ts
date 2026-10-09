import { Readable } from 'stream';

/**
 * Shared Contract: ContentStore Interface (Owned by Agent A4)
 * Governs document storage abstraction between IBM FileNet Content Manager
 * and FileSystem store (for local development and CI testing).
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
  | 'OPENING_RECORD'
  | 'COMMITTEE_REPORT'
  | 'CLARIFICATION_ATTACHMENT';

export interface DocumentMetadata {
  title: string;
  docType: DocumentType;
  mimeType: string;
  byteSize: number;
  uploadedBy: string;
  tenderId?: string;
  vendorId?: string;
  versionNumber?: number;
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

export interface AccessControlEntry {
  grantee: string; // User ID, Role, or FileNet Group name (e.g. 'TenderFlow_Committee')
  accessLevel: 'READ' | 'WRITE' | 'FULL_CONTROL';
}

export interface ContentStore {
  /**
   * Uploads/Puts document stream and associates metadata.
   */
  put(tenantId: string, metadata: DocumentMetadata, contentStream: Readable): Promise<DocumentRecord>;

  /**
   * Retrieves document metadata and content stream.
   */
  get(tenantId: string, documentId: string): Promise<DocumentStream>;

  /**
   * Retrieves document metadata only without streaming the body.
   */
  getMetadata(tenantId: string, documentId: string): Promise<DocumentRecord>;

  /**
   * Searches documents within tenant matching criteria.
   */
  search(tenantId: string, query: { tenderId?: string; vendorId?: string; docType?: string }): Promise<DocumentRecord[]>;

  /**
   * Updates document Access Control List (ACL) permissions.
   * Used during Bid Opening Ceremony to switch bid ACL from service-only to committee group.
   */
  setPermissions(tenantId: string, documentId: string, acl: AccessControlEntry[]): Promise<boolean>;

  /**
   * Lists all historical versions of a document.
   */
  listVersions(tenantId: string, documentId: string): Promise<DocumentRecord[]>;

  /**
   * Deletes a document if permitted by policy.
   */
  deleteDocument(tenantId: string, documentId: string): Promise<boolean>;

  /**
   * Health check verifying connectivity to backing repository.
   */
  ping(): Promise<{ ok: boolean; backend: 'filenet' | 'filesystem'; details?: string }>;

  // Backwards-compatibility aliases
  uploadDocument(tenantId: string, metadata: DocumentMetadata, contentStream: Readable): Promise<DocumentRecord>;
  getDocument(tenantId: string, documentId: string): Promise<DocumentStream>;
  getDocumentMetadata(tenantId: string, documentId: string): Promise<DocumentRecord>;
}
