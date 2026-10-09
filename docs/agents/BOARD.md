# TenderFlow v0.9.0 — Master Task Board (T01 - T25)

**Board Owner**: Agent A0 (Tech Lead & Orchestrator) & Agent A6 (Quality, Security & Platform Lead)  
**Timeline**: Code Freeze Wed 14 Oct 2026, 18:00 Kuwait Time | Release Tag v0.9.0: Thu 15 Oct 2026  
**Status Key**: `Todo` | `In Progress` | `In Review` | `Done` | `Blocked` | `Cut to Roadmap`

---

## Agent Ownership Directory (7 Agents)
* **A0 (Tech Lead & Orchestrator)**: Monorepo baseline, ADRs, board governance, repeatability tests, release tagging. (Does not write feature code).
* **A1 (Product, Domain & Documentation)**: Domain specifications, legal/procurement rules modeling, synthetic seed datasets, user/admin guides, release notes.
* **A2 (Backend Agent)**: Authoritative REST API service, PostgreSQL migrations, OIDC integration, server-side RBAC, sealed-bid vault, evaluation scoring, PDF reports, AI tool endpoints.
* **A3 (Frontend Agent)**: Three Next.js apps (`vendor-portal`, `procurement-app`, `control-panel`), shared design system in `packages/ui`, bilingual AR/EN RTL/LTR, typed API client.
* **A4 (Content Agent)**: IBM FileNet Content Manager integration via GraphQL API, FileSystemStore fallback, ContentStore interface implementation, TechZone provisioning scripts.
* **A5 (AI Agent)**: watsonx Orchestrate SaaS integration via ADK, YAML agent definitions, OpenAPI tool declarations, bilingual evaluation datasets, rapid import script.
* **A6 (Quality, Security & Platform Agent)**: Multi-container Compose stack, TLS reverse proxy, `install.sh`, CI quality gates (lint, typecheck, tests, images, secret scan, dependency audit, SBOM), security penetration tests, and E2E test suites.

---

## Master Task Board (T01 - T25)

| Task ID | Owner | Day / Due | Depends On | Title & Scope | Acceptance Criteria | Status |
|---|---|---|---|---|---|---|
| **T01** | A0 / A6 | Sun 11 Oct | None | Monorepo baseline, Docker Compose, install.sh v0, and CI pipeline | Compose with apps, API, PG16, Keycloak, Mailpit, TLS proxy; CI with lint, typecheck, tests, image builds, secret scan, SBOM. | **Done** |
| **T02** | A1 | Sun 11 Oct | None | Domain specifications: state model, role matrix, tenant config schema | `state-model.md`, `role-matrix.md`, `tenant-config-schema.json`. | **Done** |
| **T03** | A2 | Sun 11 Oct | T02 | Authoritative OpenAPI v0.9 specification | `services/api/openapi.yaml` covering all 10 demo steps, reports, sealed bids, and AI tools. | **Done** |
| **T04** | A4 | Sun 11 Oct | None | `provision/` script & `ContentStore` interface | FileNet GraphQL + FileSystemStore implementations; idempotent provisioning scripts. | **Done** |
| **T05** | A5 | Sun 11 Oct | T03 | Hello AI agent & OpenAPI health tool | `hello-agent.yaml` + `health-tool.json` calling `/health`. | **Done** |
| **T06** | A3 | Sun 11 Oct | T03 | Shared UI design system & 3 Next.js applications | `@tenderflow/ui` with AR/EN RTL tokens; `vendor-portal`, `procurement-app`, `control-panel` skeletons. | **Done** |
| **T07** | A0 | Sun 11 Oct | None | Architectural Decision Records (ADRs) | ADR-001 through ADR-006 (storage, auth, sealed bids, AI gateway, tenancy). | **Done** |
| **T08** | A2 | Mon 12 Oct | T01, T03 | Core API skeleton, migrations, OIDC, RBAC, tenant isolation, audit | Express REST API, PostgreSQL schema, HMAC audit logger, tenant isolation middleware. | **Done** |
| **T09** | A3 | Mon 12 Oct | T06, T08 | UI: Vendor registration, tender drafting/publish, clarifications (Steps 1-4) | Bilingual frontend views wired with live API client. | **Done** |
| **T10** | A4 | Mon 12 Oct | T04, T08 | FileNet document classes wired through API & ACL permissions | All documents stored via `ContentStore`; zero bodies in PG; addenda versioning. | **Done** |
| **T11** | A5 | Mon 12 Oct | T05, T08 | AI Advisory Agents & 40-question bilingual evaluation suite | `tender-pack-checker.yaml`, `clarification-assistant.yaml`; 40/40 benchmark passed in `evals/results.md`. | **Done** |
| **T12** | A1 | Mon 12 Oct | T02 | Synthetic seed dataset in `seed/` | 2 entities ("Ministry A", "Ministry B"), 20 vendors, 3 tenders, 6 bids loaded via `npm run seed`. | **Done** |
| **T13** | A6 | Mon 12 Oct | T01, T08 | Security tests & Automated E2E runner for demo steps 1-4 | Vendor cannot call procurement endpoints; no cross-tenant leak; Rule 1 sealed bid lock; steps 1-4 passing. | **Done** |
| **T14** | A2 | Tue 13 Oct | T08, T10 | Sealed-bid vault, opening ceremony, weighted evaluation, award, PDF reports | Non-negotiable Rule 1 cryptographic vault; server-side deadline lock; opening event unsealing. | **Done** |
| **T15** | A3 | Tue 13 Oct | T09, T14 | UI: Sealed bid submission receipt, opening session, evaluation, control panel | Cryptographic receipt, unsealing session, scorecards, audit explorer, basic KPIs. | **Done** |
| **T16** | A4 | Tue 13 Oct | T10, T14 | Opening record and committee report stored; bid ACL switch | At opening ceremony, ACL unlocks technical proposals for committee. | **Done** |
| **T17** | A5 | Tue 13 Oct | T11, T14 | `bid-compliance-screener` AI agent & `import.sh` (<15 min rebuild) | Screen unsealed bids only; AI actions audited; rapid rebuild script. | **Done** |
| **T18** | A6 | Tue 13 Oct | T13, T14 | Automated E2E runner for steps 5-8, nightly DB dump, zero CVEs | Steps 5-8 passing; `backup-db.sh` automated; security audit passing. | **Done** |
| **T19** | A1 | Tue 13 Oct | T12 | Product guides: Admin guide, install guide, user quick guide (AR/EN), release notes v0.9.0 | Bilingual guides in `docs/guides/` matching review demo workflows and v0.9.0 release notes. | **Done** |
| **T20** | A0 | Tue 13 Oct | T18 | Scope cuts review (18:00 Kuwait time) | Cut incomplete features to `docs/roadmap.md`; protect product-grade release. | `Todo` |
| **T21** | A0 / A4 | Wed 14 Oct | T16, T18 | Repeatability deployment test on fresh TechZone instance | Time execution of `install.sh`, `provision/`, and `import.sh` (<15m rebuild documented). | **Done** |
| **T22** | A6 | Wed 14 Oct | T18 | Clean VM install recording & full demo video fallback | Video capture of 10-step demo as failsafe for ESA evaluation. | `Todo` |
| **T23** | A0 / A1 | Wed 14 Oct | T21 | Architecture document, ESA questionnaire pack, release notes v0.9.0 | ESA submission package, overview diagrams, and formal release notes complete. | **Done** |
| **T24** | A0 | Wed 14 Oct | All | Code freeze at 18:00 Kuwait Time | Final PR architectural review; lock integration branch. | `Todo` |
| **T25** | A0 | Thu 15 Oct | T24 | Official Release Tag `v0.9.0` | Tag `v0.9.0` created and verified for ESA presentation. | `Todo` |
