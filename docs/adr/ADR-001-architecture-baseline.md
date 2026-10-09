# ADR-001: Architectural Baseline for TenderFlow v0.9.0

## Status
Accepted (Human Approved Baseline)

## Context
KBM is building TenderFlow v0.9.0, a reusable digital tendering product to present to IBM for an Embedded Solution Agreement (ESA). It covers the full tender-to-award lifecycle:
- Vendor registration & vetting
- Tender preparation & publishing
- Clarifications and addenda
- Sealed bids
- Bid opening ceremony
- Evaluation & awarding
- Multi-tenancy, bilingualism (Arabic/English) with full RTL, audit logging, and advisory AI integration.

The system must run on modern infrastructure and deploy cleanly to TechZone reservations and standalone environments via Docker Compose.

## Decisions

### 1. Applications & User Interface
- Three web applications built with **Next.js 14+ (TypeScript)** using the App Router:
  - `apps/vendor-portal`: Public vendor self-service.
  - `apps/procurement-app`: Internal procurement operations & committee workflows.
  - `apps/control-panel`: Tenant administration, branding, audit explorer.
- Shared design system in `packages/ui` built on standard web tokens, Tailwind CSS, Lucide icons, with native bilingual Arabic/English support (`dir="rtl"` and `dir="ltr"`).

### 2. Services & Core API
- Single authoritative backend in `services/api`: Node.js (TypeScript) REST API using Express/Fastify.
- OpenAPI 3.0 specification (`services/api/openapi.yaml`) is the single source of truth (API-first design).
- PostgreSQL 16 is used for relational state, tenant configuration, workflow, and cryptographic audit records.
- **Rule**: Document binary payloads must never be stored in PostgreSQL.

### 3. Document Content Store Adapter
- All document content operations pass through `services/content-adapter`.
- Exposes a unified `ContentStore` interface:
  ```typescript
  interface ContentStore {
    uploadDocument(tenantId: string, metadata: DocumentMetadata, stream: Readable): Promise<DocumentRecord>;
    getDocument(tenantId: string, documentId: string): Promise<DocumentStream>;
    deleteDocument(tenantId: string, documentId: string): Promise<boolean>;
  }
  ```
- Dual implementations:
  1. `FileSystemContentStore`: Used for automated testing and local developer environments.
  2. `FileNetGraphQLContentStore`: Integrates with IBM FileNet Content Manager via Content Services GraphQL API on TechZone.

### 4. Sealed Bids Cryptographic Security (Rule 1)
- Sealed bids are strictly protected by server-side policy and encryption:
  - Before the formal "Bid Opening Event", the API blocks any retrieval of bid contents (HTTP 403 `BIDS_SEALED_UNTIL_OPENING_EVENT`).
  - Bid files are encrypted with tender-specific keys. The decryption key is locked until the opening ceremony timestamp and authorization are recorded in the audit ledger.
  - Automated tests must prove that neither administrators, procurement officers, nor AI agents can inspect bid payloads before opening.

### 5. Multi-Tenancy & Server-Side Isolation (Rule 3)
- Multi-tenant architecture using column-level tenant scoping (`tenant_id`) enforced at the repository and middleware layer.
- Each tenant is configured via a Tenant Configuration Package (JSON/YAML) defining branding, currency, tender categories, roles, and approval rules.

### 6. Audit Trail (Rule 2)
- Immutable, tamper-evident audit ledger in PostgreSQL:
  - Every state change and privileged action records: `id`, `tenant_id`, `actor_id`, `actor_role`, `action`, `resource_type`, `resource_id`, `prev_state`, `new_state`, `timestamp`, `reason`, `ip_address`, and HMAC hash chaining.

### 7. AI Advisory Agent Architecture (Rule 7)
- watsonx Orchestrate AI agents built using the Agent Development Kit (ADK) in `agents/`.
- Agents invoke TenderFlow tools defined via OpenAPI.
- Tools enforce the authenticated caller's identity and permissions.
- **Rule 7**: AI agents are strictly advisory. No AI agent may approve tenders, reject vendors, score for award, or publish without recorded human sign-off.

### 8. Terminology & Neutral Branding (Rule 8)
- Customer-facing UI, documentation, and product strings must not mention third-party proprietary vendor product names. Document storage is referred to as "Enterprise Content Store" and AI is referred to as "Procurement AI Advisor".

## Consequences
- Guaranteed compliance with IBM ESA technical review requirements.
- Zero data corruption or leaked bids.
- Portable between TechZone and local developer containers.
