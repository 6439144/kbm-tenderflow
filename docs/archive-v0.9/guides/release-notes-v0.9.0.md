# TenderFlow v0.9.0 — Release Notes (Status & v1.0 Hardening Scope)

**Release Baseline**: v0.9.0 (Architecture Baseline & Mock Skeleton)  
**Next Release Target**: v1.0.0-rc1 (Real Integration & Hardening Milestone)  
**Product**: Enterprise Digital Tendering Platform  
**Vendor**: Khorafi Business Machines (KBM)  

---

## 1. Executive Summary & Review Status

TenderFlow v0.9.0 establishes the monorepo scaffold, OpenAPI contracts, domain state machines, shared bilingual design system, and multi-tenant packaging architecture for KBM's tender-to-award platform.

Following an independent architectural review (9 Oct 2026), TenderFlow is undergoing the **v1.0 Hardening Program** (governed by `docs/agents/V1-HARDENING-PROMPT.md` and Rules 9–13). In strict compliance with **Rule 13 (Docs never claim more than the code does)**, this document accurately reflects which components are verified versus those currently in active integration for v1.0.

---

## 2. Capabilities Status & Integration Matrix

| Subsystem / Capability | v0.9.0 Current State | v1.0 Target State | Hardening Task |
|---|---|---|---|
| **Authentication & RBAC** | Development headers (`X-Actor-Role`); Keycloak in compose | Real Keycloak JWT verification with JWKS (`jose`), strict realm claims, segregation of duties | **H-01** (In Progress) |
| **Data Persistence** | In-memory Maps for fast contract verification | Full PostgreSQL 16 repository layer, versioned SQL migrations, Row-Level Security (RLS) | **H-02** (In Progress) |
| **Sealed Bid Vault** | Hash receipts & route locks; in-memory keys | AES-256-GCM per-bid data encryption, `BID_MASTER_KEY` wrapping, deadline scheduler, strictly locked document endpoints | **H-03** (In Progress) |
| **IBM FileNet Integration** | `ContentStore` interface with local `FileSystemStore` fallback | Live Content Services GraphQL integration, multipart upload, streaming, ACCE provisioning verification | **H-05, H-06, H-07** (In Progress) |
| **IBM watsonx Orchestrate** | ADK YAML drafts & advisory tool definitions | Real SaaS connection, native ADK YAML format, live document grounding, identity propagation via `ai_session` | **H-08, H-09, H-10** (In Progress) |
| **AI Evaluation Benchmark** | Initial synthetic benchmark question suites | Live model execution through Orchestrate against FileNet documents; verified pass rates recorded in `docs/evidence/` | **H-11** (In Progress) |
| **Web Applications** | Next.js interactive views with `@tenderflow/ui` tokens | Live API integration, Keycloak OIDC session management, real form submissions across all 10 demo steps | **H-12** (In Progress) |
| **Audit Ledger** | HMAC-SHA256 hash chain verification endpoint | PostgreSQL append-only audit table (revoked UPDATE/DELETE), HMAC key strictly from environment | **H-15** (In Progress) |

---

## 3. Verified Architecture Baseline (v0.9.0 Delivered)

- **Monorepo Structure**: Complete npm workspaces scaffold (`apps/vendor-portal`, `apps/procurement-app`, `apps/control-panel`, `packages/ui`, `packages/tenant-config`, `services/api`, `services/content-adapter`).
- **OpenAPI 3.0 Contract**: Authoritative specification in `services/api/openapi.yaml` defining all endpoints for the 10 demo steps.
- **Shared Bilingual UI System**: `@tenderflow/ui` with full Arabic (RTL) and English (LTR) dictionaries, design tokens, and layout primitives.
- **Tenant Configuration Packages**: `@tenderflow/tenant-config` JSON schema and seed packages for "Kuwait Energy Authority", "Ministry A", and "Ministry B".
- **Container Infrastructure**: Production Docker Compose topology (`deploy/docker-compose.yml`), NGINX TLS 1.2/1.3 reverse proxy configuration, and `install.sh` v0.
- **Secret Scanning & SBOM**: Pre-commit secret scanning (`scripts/secret-scan.js`) and CycloneDX 1.5 SBOM generator (`scripts/generate-sbom.js`).

---

## 4. Test & Quality Status

- **Unit & Contract Tests**: 11/11 in-memory API tests pass in development mode (`npm test`).
- **Security Scenarios**: 4/4 security simulation suites pass (`npm run test:security`).
- **v1.0 Security Hardening**: Task **H-04** will replace header-based tests with real Keycloak token flows, negative authorization sweeps, blocking high-severity dependency audits, and container hardening (`helmet`, rate limiting).

---

## 5. Scope Cleanly Deferred to Roadmap (v1.0 Post-Release)

As detailed in [`docs/roadmap.md`](file:///c:/Users/kabed/Downloads/KBM_Tender_Product/docs/roadmap.md):
1. Multi-Signatory Shamir Secret Sharing Quorum for Bid Opening.
2. Dynamic Real-Time Reverse Auction Clock.
3. Native ERP Financial Connectors (SAP / Oracle).
4. Direct Online Payment Gateway (KNET switch).
5. Advanced Post-Award Contract Lifecycle Management (CLM).
