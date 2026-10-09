# TONIGHT — Master Task Board (v1.0.0-rc1 by 23:59 Kuwait Time)

**Governing Directives**: [`docs/agents/TONIGHT.md`](file:///c:/Users/kabed/Downloads/KBM_Tender_Product/docs/agents/TONIGHT.md) & [`docs/agents/REVIEWER-NOTES.md`](file:///c:/Users/kabed/Downloads/KBM_Tender_Product/docs/agents/REVIEWER-NOTES.md)  
**Board Owners**: Agent A0 (Tech Lead & Orchestrator) & Agent A6 (Quality, Security & Platform Lead)  
**Target Milestone**: v1.0.0-rc1 by 23:59 Fri 9 Oct 2026  
**Status Key**: `Todo` | `In Progress` | `In Review` | `Done` | `Cut to Roadmap`

---

## Agent Start Lines & Assignments Tonight

* **A0 (Tech Lead)**: Coordinate, G1-a (Done), G3-g, G3-h, merge order, REVIEWER-NOTES replies at start of every loop.
* **A1 (Product & Docs)**: G1-a support (Done), seed data fixtures for FileNet (G2-a fixtures), G3-g docs and release notes.
* **A2 (Backend Agent)**: Sequence: **G1-b** → **G1-c** → **G1-d** → **G2-c** → **G2-e** → **G3-d**. (Cut items: scheduler, notifications, PDF if > 23:00).
* **A3 (Frontend Agent)**: Parallel start on **G3-a**, **G3-b**, **G3-c** against OpenAPI contracts; switch to live tokens when G1-b lands.
* **A4 (Content Agent)**: Start immediately on **G2-a** (FileNet Content Services GraphQL store) & **G2-b** (`ACCE-RUNBOOK.md` + `verify.js`).
* **A5 (AI Agent)**: Start immediately on **G2-d** setup (ADK v1 native YAML, connection, tool imports), then **G2-e** & **G2-f**.
* **A6 (Quality & Platform)**: Sequence: **G1-f** (Keycloak realm) & **G1-e** (real token security tests) in parallel with A2; migrations runner (G1-d); **G3-f** (fail-fast install).

---

## Gate 1 — 19:30: Honest and Secure Core

| Task ID | Owner | Title & Scope | Acceptance Criteria | Status |
|---|---|---|---|---|
| **G1-a** | A0 | Honest Docs & Clean Status | Release notes, ESA questionnaire, STATUS, results.md claim only what is true now. R0-1 & R0-2 resolved. | **Done** (`4e67b1d`) |
| **G1-b** | A2 | Real Keycloak JWT Auth & RBAC | Keycloak access token verification with `jose` (JWKS, issuer, audience, expiry). Tenant + roles from token only. Delete `X-Actor-Role`, `X-Actor-Id`, `mock:` tokens, and default-actor fallback. Auth before tenant middleware. `requireRole` on every route per `role-matrix.md`. Creator cannot approve own tender. Anonymous → 401; vendor on procurement → 403; wrong tenant → 403. | `In Progress` |
| **G1-c** | A2 | Real Sealed-Bid Vault | `/documents/:id` checks owning resource (bid files served only via bid routes after opening, to committee/evaluators). `vendorId` from token. Reject bids unless PUBLISHED and before deadline. Opening only when now ≥ deadline, by COMMITTEE_CHAIR. Per-bid AES-256-GCM data key wrapped with `BID_MASTER_KEY`. Attacks in P0-1/P0-2 fail as tests. | `Todo` |
| **G1-d** | A2 + A6 | Persistence Fast Path | PostgreSQL tables with `id`, `tenant_id`, `data jsonb`, timestamps for each entity. Numbered SQL migrations runner (A6). Repository layer with in-memory moved strictly to `test/fakes/`. Real `/ready` probe checking PostgreSQL, Keycloak JWKS, FileNet ping, and Orchestrate token. Data persists across API restart. | `Todo` |
| **G1-e** | A6 | Security Tests with Real Keycloak Tokens | Security tests obtain real tokens from Keycloak test realm for each role and tenant. CI `npm ci` only, blocking audit. Remove hard-coded compose passwords. Tests fail if auth is disabled. | `Todo` |
| **G1-f** | A6 | Keycloak Realm Hardening | Configure test realm with `tenant_id` claim mapper, roles, demo users per role for `kea` + `ministry_a`. Passwords supplied via environment variables. Token acquisition script verified. | `Todo` |

---

## Gate 2 — 21:30: Real FileNet and Real Orchestrate

| Task ID | Owner | Title & Scope | Acceptance Criteria | Status |
|---|---|---|---|---|
| **G2-a** | A4 | Real FileNetGraphQLContentStore | Put (multipart `createDocument` with `ECM-CS-XSRF-Token` header and cookie), get (`downloadUrl` / content endpoint), search by `TF_` properties, versions, permissions, ping = real GraphQL query. Working queries saved in `services/content-adapter/graphql/`. Evidence in `docs/evidence/G2-a/`. | `Todo` |
| **G2-b** | A4 | Provisioning Runbook & Verification | `provision/ACCE-RUNBOOK.md` + `provision/verify.js` schema checker exiting non-zero on anything missing. Verified on TechZone. Evidence in `docs/evidence/G2-b/`. | `Todo` |
| **G2-c** | A2 | Grounded AI Tool Endpoints in API | Text extraction (PDF/DOCX) chunked with section numbers. `tenderflow-ai-tools.openapi.yaml` OpenAPI 3.0 spec. Short-lived signed `ai_session` token bound to user/tenant/tender. Sealed bids return 403. Delete canned `ai-advisory.ts`. Bid screener = missing-document checklist only, no scores. | `Todo` |
| **G2-d** | A5 | Native ADK Agent Definitions & Import | Native ADK YAML (`spec_version: v1`, `kind: native`, `llm`, tools). Connection `tenderflow_api` (bearer). Tool import and agent import. `agents/import.sh` with `set -euo pipefail` and no mock mode. `orchestrate agents list` output saved to `docs/evidence/G2-d/`. | `Todo` |
| **G2-e** | A2 + A5 | Calling Agents from TenderFlow API | `orchestrate-client.ts`: IAM token from `WXO_API_KEY`, agent invocation via documented runs/chat API, prompt/answer/sources stored, audit `AI_ADVISORY_GENERATED` and `AI_ADVISORY_REVIEWED`. | `Todo` |
| **G2-f** | A5 | Real Bilingual Evaluations | `agents/evals/run-evals.js` sends 40 questions to live Orchestrate agents, checks fact accuracy and citations against FileNet documents, writes real pass rates and raw logs to `results.md`. | `Todo` |

---

## Gate 3 — 23:30: Product in the Browser & Release Pack

| Task ID | Owner | Title & Scope | Acceptance Criteria | Status |
|---|---|---|---|---|
| **G3-a** | A3 | Vendor Portal Live Wiring | Keycloak login, vendor registration & doc upload, tender listing & pack download, clarifications, submit bid with receipt (SHA-256 + timestamp), my bids. Driven by Playwright E2E. | `Todo` |
| **G3-b** | A3 | Procurement App Live Wiring | Tender drafting & pack upload, AI pack check with accept/ignore, approval by different user, publish, clarification inbox with AI draft edit/approve, addendum, opening, compliance checklist, evaluator scoring, award. Driven by Playwright E2E. | `Todo` |
| **G3-c** | A3 | Control Panel Live Wiring | Tenant listing and details from API, audit log viewer with cryptographic chain verification. | `Todo` |
| **G3-d** | A2 | Durable PostgreSQL Audit Ledger | PostgreSQL append-only audit table, HMAC signing key from environment (no default), `GET /api/v1/audit-logs/verify` returning cryptographic verification status. | `Todo` |
| **G3-e** | A2 | Authoritative PDF Generation | Opening record and committee report generated as PDF via headless Chromium (`page.pdf`) with Arabic RTL support, stored in FileNet. (Cut to roadmap if not done by 23:00). | `Todo` |
| **G3-f** | A6 | Operational Install & Fail-Fast Hardening | `deploy/install.sh` fails fast on missing prerequisites, reads secrets from `.env`. Clean installation run recorded in `docs/evidence/G3-f/`. | `Todo` |
| **G3-g** | A1 + A0 | Evidenced Documentation & ESA Pack | Release notes v1.0.0-rc1, ESA questionnaire, install/admin/user guides rewritten with facts and links to `docs/evidence/`. Roadmap lists all cut items. | `Todo` |
| **G3-h** | A0 | Release Tag `v1.0.0-rc1` | Tagged on `integration` only after all G3 items verified and reviewer notes clean. | `Todo` |

---

## Cut to Roadmap Tonight (Do Not Start)

Per [`docs/agents/TONIGHT.md`](file:///c:/Users/kabed/Downloads/KBM_Tender_Product/docs/agents/TONIGHT.md), the following items are formally deferred to [`docs/roadmap.md`](file:///c:/Users/kabed/Downloads/KBM_Tender_Product/docs/roadmap.md) to protect the 23:59 release:
1. Automated email notifications (SMTP).
2. Background deadline cron scheduler (deadline enforced at request-time on API operations).
3. Database row-level security (tenant isolation enforced strictly in repository query layer).
4. Trivy container vulnerability scanning and Prometheus `/metrics` endpoint.
5. Keycloak user management UI inside Control Panel (users configured via realm).
6. Web chat embedded widget in Procurement App (agents invoked via structured advisory buttons).
7. Bid opening quorum count calculation (enforce creator ≠ approver and Committee Chair sign-off).
8. Multi-version bid replacement before deadline.
