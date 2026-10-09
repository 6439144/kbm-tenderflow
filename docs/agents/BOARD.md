# TenderFlow v0.9.0 — Master Task Board

**Board Owner**: Agent A0 (Architecture & Integration Lead)  
**Timeline**: Code Freeze Wed 14 Oct 2026, 18:00 Kuwait Time | Release Tag v0.9.0: Thu 15 Oct 2026  
**Status Key**: `Todo` | `In Progress` | `In Review` | `Done` | `Blocked` | `Cut to Roadmap`

---

## Agent Ownership Directory
* **A0 (Platform Architect & Integration Lead)**: Monorepo setup, shared contracts, ADRs, BOARD governance, demo orchestration.
* **A1 (Backend Services & Security Lead)**: `services/api` — REST API, PostgreSQL 16 schema, tenant isolation, sealed bid security, audit trail.
* **A2 (Content Adapter Lead)**: `services/content-adapter` — `ContentStore` interface, FileNet GraphQL client, File-system mock store, provisioning scripts.
* **A3 (Procurement App Lead)**: `apps/procurement-app` — Procurement workflow, tender drafting, clarification response, bid opening ceremony, evaluation, award.
* **A4 (Vendor Portal Lead)**: `apps/vendor-portal` — Vendor self-service, registration, tender discovery, Q&A, sealed bid submission envelope.
* **A5 (Control Panel & Shared UI Lead)**: `apps/control-panel` & `packages/ui` — Tenant configuration packages, multi-tenant branding, RTL bilingual design system, audit logs UI.
* **A6 (AI Agent & DevOps/E2E Lead)**: `agents/` & `deploy/` & `seed/` — watsonx Orchestrate ADK YAML, OpenAPI tools, Docker Compose, `install.sh`, E2E test runner.

---

## Task Board

| Task ID | Owner | Target Day | Depends On | Title & Scope | Acceptance Criteria | Status |
|---|---|---|---|---|---|---|
| **A0-01** | A0 | Day 1 (09 Oct) | None | Repository foundation & monorepo structure | Monorepo package.json, tsconfig, folder hierarchy matching brief. | **Done** |
| **A0-02** | A0 | Day 1 (09 Oct) | A0-01 | Shared Contracts: OpenAPI 3.0 specification | Complete `services/api/openapi.yaml` for all 10 demo steps. | **Done** |
| **A0-03** | A0 | Day 1 (09 Oct) | A0-01 | Architecture Baseline & ADRs | `docs/architecture/overview.md` and `docs/adr/ADR-001`. | **Done** |
| **A0-04** | A0 | Day 1 (09 Oct) | A0-01 | Acceptance Demo Script | `docs/review-demo.md` verified and aligned with team. | **Done** |
| **A1-01** | A1 | Day 1 (09 Oct) | A0-02 | PostgreSQL 16 schema & migrations | Tables for tenants, users, vendors, tenders, clarifications, bids, evaluation, audit. No document bodies in PG. | **In Progress** |
| **A1-02** | A1 | Day 2 (10 Oct) | A1-01 | Authentication & Tenant Isolation Middleware | Server-enforced tenant filter on every query; RBAC roles enforced. | `Todo` |
| **A1-03** | A1 | Day 2 (10 Oct) | A1-01 | Non-Negotiable Rule 1: Sealed Bids Cryptographic Vault | Bid payload access blocked before opening event (HTTP 403 test proven). | `Todo` |
| **A1-04** | A1 | Day 2 (10 Oct) | A1-01 | Non-Negotiable Rule 2: Immutable Audit Logger | Every state change & privileged action logs actor, tenant, timestamp, diff, reason. | `Todo` |
| **A2-01** | A2 | Day 1 (09 Oct) | A0-02 | ContentStore interface & File-System Store | Pluggable interface for document storage and retrieval with metadata separation. | **In Progress** |
| **A2-02** | A2 | Day 2 (10 Oct) | A2-01 | FileNet Content Services GraphQL Adapter | GraphQL queries/mutations to store/fetch docs on TechZone reservation. | `Todo` |
| **A2-03** | A2 | Day 3 (11 Oct) | A2-02 | Provisioning scripts (`provision/`) | Scripts to recreate classes/object stores on clean TechZone instance. | `Todo` |
| **A5-01** | A5 | Day 2 (10 Oct) | A0-01 | Shared UI Design System (`packages/ui`) | Bilingual EN/AR, full RTL support, accessible components, tokens. | `Todo` |
| **A5-02** | A5 | Day 2 (10 Oct) | A5-01 | Tenant Config Package Schema & Loader | JSON schema for branding, tender types, roles, labels; <1 hr provisioning. | `Todo` |
| **A5-03** | A5 | Day 3 (11 Oct) | A5-02, A1-02 | Control Panel Application (`apps/control-panel`) | Multi-tenant admin dashboard, audit log explorer, tenant provisioning UI. | `Todo` |
| **A4-01** | A4 | Day 3 (11 Oct) | A5-01, A1-02 | Vendor Portal: Registration & Profile | Bilingual self-registration, license upload, status check. | `Todo` |
| **A4-02** | A4 | Day 3 (11 Oct) | A4-01, A1-02 | Vendor Portal: Tender Discovery & Q&A | Public tender listings, document downloads, clarification inquiries. | `Todo` |
| **A4-03** | A4 | Day 4 (12 Oct) | A4-02, A1-03 | Vendor Portal: Sealed Bid Submission | Multi-envelope bid submission with client-side digest and sealed lock. | `Todo` |
| **A3-01** | A3 | Day 3 (11 Oct) | A5-01, A1-02 | Procurement App: Tender Drafting & Workflow | Create tender, upload dossier, approval matrix, publishing to portal. | `Todo` |
| **A3-02** | A3 | Day 4 (12 Oct) | A3-01, A1-03 | Procurement App: Bid Opening Ceremony | Committee session recording, opening event ledger, unsealing technical bids. | `Todo` |
| **A3-03** | A3 | Day 4 (12 Oct) | A3-02, A1-01 | Procurement App: Evaluation & Awarding | Evaluator scoring matrix, consensus scoring, award approval workflow. | `Todo` |
| **A6-01** | A6 | Day 2 (10 Oct) | A0-02 | Synthetic Seed Data Generator (`seed/`) | Tenants (KEA + synthetic secondary), vendors, tenders, bids. | `Todo` |
| **A6-02** | A6 | Day 3 (11 Oct) | A0-02 | watsonx Orchestrate ADK YAML & Tools | OpenAPI tools for AI advisor; Rule 7 compliance (strictly advisory). | `Todo` |
| **A6-03** | A6 | Day 4 (12 Oct) | A1-01, A2-01 | Docker Compose & `deploy/install.sh` | One-command deployment from clean VM; Mailpit, Keycloak, Postgres, API, Apps. | `Todo` |
| **A6-04** | A6 | Day 5 (13 Oct) | All apps | End-to-End Demo Script Automation (`tests/e2e`) | Automated execution of all 10 steps of `docs/review-demo.md`. | `Todo` |
| **A0-05** | A0 | Day 6 (14 Oct) | All | Code Freeze & Security/Vulnerability Scan | Secret scan, linting, typecheck, zero critical/high CVEs. | `Todo` |
| **A0-06** | A0 | Day 7 (15 Oct) | A0-05 | Release Tag v0.9.0 & Demo Fallback Video | Tagging repository, user/admin guides verification, demo package. | `Todo` |
