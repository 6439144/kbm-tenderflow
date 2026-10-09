# TenderFlow v1.0 — Hardening Master Task Board (H-01 to H-17)

**Board Owners**: Agent A0 (Tech Lead & Orchestrator) & Agent A6 (Quality, Security & Platform Lead)  
**Governance Document**: [`docs/agents/V1-HARDENING-PROMPT.md`](file:///c:/Users/kabed/Downloads/KBM_Tender_Product/docs/agents/V1-HARDENING-PROMPT.md)  
**Rules in Effect**: Rules 1–8 (Core Governance) and Rules 9–13 (Honesty Rules in [`AGENTS.md`](file:///c:/Users/kabed/Downloads/KBM_Tender_Product/AGENTS.md))  
**Target**: Definition of v1.0 Done — all 10 demo steps passing against live PostgreSQL, Keycloak, IBM FileNet (TechZone), and IBM watsonx Orchestrate (TechZone), with evidence in `docs/evidence/<task-id>/`.  
**Status Key**: `Todo` | `In Progress` | `In Review` | `Done` | `Blocked`

---

## Agent Ownership Directory

* **A0 (Tech Lead & Orchestrator)**: Governance, ADRs (ADR-007, ADR-008, ADR-009), board coordination, PR reviews, release tagging.
* **A1 (Product, Domain & Documentation)**: Domain rules, seed data updates, user/admin guides (AR/EN), release notes v1.0.0-rc1, ESA pack documentation.
* **A2 (Backend Agent)**: Real JWKS token auth & RBAC, PostgreSQL persistence layer, sealed-bid envelope encryption vault, grounded AI tools endpoints, PDF generator, SMTP notifications, durable HMAC audit log.
* **A3 (Frontend Agent)**: Three Next.js apps (`vendor-portal`, `procurement-app`, `control-panel`) wired to live Keycloak and REST API, Playwright 10-step browser E2E.
* **A4 (Content Agent)**: IBM FileNet Content Services GraphQL store, ACCE provisioning runbook & schema verification, live FileNet mode activation.
* **A5 (AI Agent)**: watsonx Orchestrate native ADK agents, tool bindings, SaaS connection & chat runs invocation, 40-question document-grounded evaluations.
* **A6 (Quality, Security & Platform Agent)**: Security test suite with real Keycloak tokens, negative penetration sweeps, blocking high-audit CI, fail-fast `install.sh`, backup/restore verification, Trivy/SBOM.

---

## Master Task Board: v1.0 Hardening (H-01 – H-17)

### Phase A: Truth & Security Foundation (First Priority)

| Task ID | Owner | Phase | Depends On | Title & Scope | Acceptance Criteria & Evidence | Status |
|---|---|---|---|---|---|---|
| **H-01** | A2 | Phase A | None | Real Authentication & Authorization | Verify Keycloak access tokens with JWKS via `jose` (issuer, audience, expiry, signature). Tenant & roles extracted only from token claims; delete `X-Actor-Role`, `X-Actor-Id`, and `mock:` tokens. Auth runs before tenant middleware. Segregation of duties enforced (tender creator cannot approve; opening quorum enforced). Keycloak realm configured with roles & demo users. Evidence in `docs/evidence/H-01/`. | `Todo` |
| **H-02** | A2 | Phase A | None | Persistence (PostgreSQL Repository Layer & Migrations) | Repository interfaces for all entities (tenants, vendors, tenders, clarifications, bids, openings, evaluations, awards, audit). PostgreSQL implementation via `pg` with versioned migrations (`npm run migrate`). Every query filters by `tenant_id` with row-level security (RLS). In-memory implementations moved strictly under `test/fakes/`. Real `/ready` probe checking PostgreSQL, Keycloak JWKS, FileNet ping, and Orchestrate token. Evidence in `docs/evidence/H-02/`. | `Todo` |
| **H-03** | A2 | Phase A | H-01, H-02 | Sealed-Bid Vault for Real | AES-256-GCM envelope encryption per bid; file encrypted before leaving API; data key wrapped with `BID_MASTER_KEY` (32 bytes base64) and stored with IV/auth tag in PostgreSQL; unsealing strictly locked until recorded opening ceremony. Server-side deadline scheduler (`node-cron`) auto-closes tenders at deadline. `/api/v1/documents/:id` protects bid docs from pre-opening access. Evidence in `docs/evidence/H-03/`. | `Todo` |
| **H-04** | A6 | Phase A | H-01, H-02, H-03 | Real Security Tests & Pipeline Hardening | Tests obtain real tokens from Keycloak test realm. Mandatory negative test suite: anonymous 401, vendor calling procurement 403, cross-tenant 404/403, competitor bid access 403, pre-opening bid reading 403, opening before deadline 409, self-approval 403, AI tool pre-opening access 403. Blocking `npm audit --audit-level=high` in CI. `helmet`, `express-rate-limit`, body limits, magic byte mime checks. Remove hard-coded compose passwords. Evidence in `docs/evidence/H-04/`. | `Todo` |

### Phase B: IBM FileNet Integration (Real)

| Task ID | Owner | Phase | Depends On | Title & Scope | Acceptance Criteria & Evidence | Status |
|---|---|---|---|---|---|---|
| **H-05** | A4 | Phase B | H-01, H-02 | FileNetGraphQLContentStore Implementation | Real Content Services GraphQL calls (`${FILENET_GRAPHQL_URL}`) with Basic/Bearer auth and `ECM-CS-XSRF-Token`. Multipart POST upload with `graphql` and file part; streaming download; search by `TF_TenantId`, `TF_TenderId`, `TF_DocType`; version checkout/checkin; real ping query. Verified GraphQL queries saved in `services/content-adapter/graphql/*.graphql`. Evidence in `docs/evidence/H-05/`. | `Todo` |
| **H-06** | A4 | Phase B | H-05 | Provisioning & ACCE Verification Runbook | `provision/ACCE-RUNBOOK.md` detailing exact ACCE configuration steps + `provision/verify.js` schema checker querying classes, properties, folders, and groups, exiting non-zero if anything is missing. Document ACL switching at opening ceremony tested. Evidence in `docs/evidence/H-06/`. | `Todo` |
| **H-07** | A4 | Phase B | H-05, H-06 | FileNet Live Activation & Verification | Enable `CONTENT_STORE_TYPE=filenet` in hosted compose; contract tests pass against FileNet; verified FileNet Navigator captures showing uploaded files and metadata across demo steps. Evidence in `docs/evidence/H-07/`. | `Todo` |

### Phase C: IBM watsonx Orchestrate Integration (Real)

| Task ID | Owner | Phase | Depends On | Title & Scope | Acceptance Criteria & Evidence | Status |
|---|---|---|---|---|---|---|
| **H-08** | A2 | Phase C | H-01, H-02, H-05 | Grounded AI Tool Endpoints in API | Document text extraction (PDF / DOCX) chunked with section numbers and cached in PostgreSQL per document version. OpenAPI 3.0 spec in `agents/tools/tenderflow-ai-tools.openapi.yaml`. Ment-to-end identity propagation via signed `ai_session` token parameter (10 min lifetime). Remove canned logic; bid screener returns strict compliance checklist without scores. Evidence in `docs/evidence/H-08/`. | `Todo` |
| **H-09** | A5 | Phase C | None (Day 1 Setup) | Native ADK Agent Definitions & Rebuild Script | Agents rewritten in native ADK YAML (`spec_version: v1`, `kind: native`, `llm`, tools). Connected via ADK CLI to TechZone Orchestrate instance. Idempotent `agents/import.sh` script importing connections, tools, and agents with zero mock mode. Save `orchestrate agents list` output. Evidence in `docs/evidence/H-09/`. | `Todo` |
| **H-10** | A2 + A5 | Phase C | H-08, H-09 | Calling Agents from TenderFlow Service | `orchestrate-client.ts` in API obtaining IAM token, invoking Orchestrate chat/runs API with user prompt and `ai_session` token. Every generation stored and audited (`AI_ADVISORY_GENERATED` and `AI_ADVISORY_REVIEWED`). Grounded answers with document citations. Evidence in `docs/evidence/H-10/`. | `Todo` |
| **H-11** | A5 | Phase C | H-08, H-10 | Real Bilingual Evaluation Benchmark | `agents/evals/run-evals.js` executing 20 Arabic and 20 English benchmark questions against live tender documents stored in FileNet via live Orchestrate agents. Fact and citation verification. True pass rates recorded in `agents/evals/results.md` with raw logs. Evidence in `docs/evidence/H-11/`. | `Todo` |

### Phase D: Product Completeness & Release Readiness

| Task ID | Owner | Phase | Depends On | Title & Scope | Acceptance Criteria & Evidence | Status |
|---|---|---|---|---|---|---|
| **H-12** | A3 | Phase D | H-01, H-03, H-08 | Frontend Applications Wired to API | Keycloak login in `vendor-portal`, `procurement-app`, and `control-panel`. Real token transmission, tenant selection, role-based navigation. All 10 demo steps interactive in browser. Full Arabic/English RTL/LTR support. WCAG 2.1 AA accessibility checks. Playwright E2E driving full 10 steps. Evidence in `docs/evidence/H-12/`. | `Todo` |
| **H-13** | A2 | Phase D | H-02, H-05 | Authoritative PDF Generation | Opening record and committee report generated as PDF with correct Arabic shaping and RTL layout via headless Chromium (Playwright `page.pdf`). Stored in FileNet as `TF_OpeningRecord` and `TF_CommitteeReport`. Evidence in `docs/evidence/H-13/`. | `Todo` |
| **H-14** | A2 | Phase D | H-01, H-02 | Notification Service | Bilingual email notifications via SMTP (Mailpit in dev) for vendor registration, tender publication, clarifications, addenda, deadline reminders, opening, and awards. Evidence in `docs/evidence/H-14/`. | `Todo` |
| **H-15** | A2 | Phase D | H-01, H-02 | Durable PostgreSQL Audit Ledger | PostgreSQL append-only audit table with database permissions revoking UPDATE/DELETE. Cryptographic HMAC hash-chaining signed with `AUDIT_SIGNING_KEY` from env (no default). `GET /audit-logs/verify` endpoint. Evidence in `docs/evidence/H-15/`. | `Todo` |
| **H-16** | A6 | Phase D | H-01..H-04 | Platform Operations & Hardening | Fail-fast `install.sh` validating prerequisites; verified database backup & restore (`backup-db.sh` & `restore-db.sh`); structured JSON logging with request IDs; `/metrics` Prometheus endpoint; Trivy container vulnerability scan; CycloneDX SBOM. Evidence in `docs/evidence/H-16/`. | `Todo` |
| **H-17** | A1 + A0 | Phase D | H-01..H-16 | Documentation & ESA Solution Pack | Release notes v1.0.0-rc1 listing only verified features; updated Install, Admin, User (AR/EN), and API guides; evidenced ESA questionnaire with real architectural diagrams, Navigator screenshots, and repeatability timings. Evidence in `docs/evidence/H-17/`. | `Todo` |

---

## Execution Sequence & Gates

1. **Gate 1 (Phase A Complete)**: H-01, H-02, H-03, H-04 merged into `integration`. Core authentication, persistence, sealed-bid vault, and security tests pass.
2. **Gate 2 (Phase B Complete)**: H-05, H-06, H-07 merged. FileNet Content Services GraphQL store verified with live Navigator screenshots.
3. **Gate 3 (Phase C Complete)**: H-08, H-09, H-10, H-11 merged. Orchestrate native agents executing tool calls grounded on FileNet documents with verified eval pass rates.
4. **Gate 4 (Phase D Complete)**: H-12, H-13, H-14, H-15, H-16, H-17 merged. 10-step Playwright browser E2E green, PDFs rendered, audit chain proven, operational tooling clean, release notes & ESA pack signed off.
