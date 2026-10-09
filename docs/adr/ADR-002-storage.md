# ADR-002: Document Storage & Content Adapter Architecture (T07)

## Status
Accepted

## Context
TenderFlow processes sensitive procurement documentation, tender dossiers, addenda, and bidder proposals.
Non-negotiable rule: Document bodies must NEVER be stored in PostgreSQL. Relational PostgreSQL is reserved for metadata, state transitions, config, and audit events.
TechZone reservations provide IBM FileNet Content Manager, but reservations are ephemeral and rebuildable from scratch. Fast offline developer and CI environments require an abstracted file-system backend.

## Decision
1. All document interactions must route exclusively through the `ContentStore` interface in `services/content-adapter`:
   ```typescript
   interface ContentStore {
     uploadDocument(tenantId: string, metadata: DocumentMetadata, stream: Readable): Promise<DocumentRecord>;
     getDocument(tenantId: string, documentId: string): Promise<DocumentStream>;
     getDocumentMetadata(tenantId: string, documentId: string): Promise<DocumentRecord>;
     deleteDocument(tenantId: string, documentId: string): Promise<boolean>;
   }
   ```
2. Implement dual storage adapters:
   - `FileNetGraphQLContentStore`: Communicates via Content Services GraphQL API for production TechZone reservations.
   - `FileSystemContentStore`: Used for local developer environments and CI test runners.
3. Automated provisioning scripts in `services/content-adapter/provision/` rebuild classes, property definitions, and folder taxonomies on any empty TechZone reservation.

## Consequences
- Guaranteed compliance with TechZone ephemeral lifecycle.
- Relational database remains lean, fast, and secure.
- Offline tests run without external dependencies.
