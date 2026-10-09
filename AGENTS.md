# KBM TenderFlow v0.9.0 — Agent Team Roster & Rules (AGENTS.md)

## Team Operating Rules
1. **One Agent = One Branch = One PR into `integration`**:
   Branch naming convention: `agent/<agent-id>/<task-id>` (e.g. `agent/a1/T02`).
   Never merge into `main`. Merge into `integration` only when CI is green and approved by A0.
2. **Stay in your assigned folder boundaries**:
   Request changes outside your folder in your session handoff note.
3. **Shared Contracts Governance**:
   - `services/api/openapi.yaml`
   - `services/content-adapter/src/types.ts` (`ContentStore` interface)
   - State model & tenant config schema
   Changed only via PR reviewed by A0 and affected agents.
4. **Non-Negotiables**:
   - Sealed bids: Zero read access before opening ceremony event.
   - Audit trail: Every state change writes an immutable audit event.
   - Server-enforced authorization and tenant isolation.
   - Synthetic data only. All entity, vendor and person names must be clearly fictitious.
   - AI is advisory (Rule 7): Human approval required for all state transitions, approvals, publications, and awards.
   - Product names, UI text and docs contain no IBM product names (Rule 8).
5. **Daily Rhythm**:
   - Questions logged in `docs/agents/QUESTIONS.md` with options and recommendation. Never invent rules.
   - Update `docs/agents/STATUS.md` against `docs/review-demo.md` daily at 14:30.
   - End every session with `docs/agents/handoffs/<YYYY-MM-DD>-<agent-id>.md`.

---

## Agent Directory

### A0 — Orchestrator & Tech Lead
- **Role**: Team coordination, task assignment, PR architectural review, CI gatekeeper, repeatability test, and release tagging. Does NOT write feature code.
- **Owned Folders**: `docs/agents/`, `docs/adr/`, `docs/architecture/`, root governance (`.gitignore`, `.env.example`, `package.json`).
- **Assigned Tasks**:
  - T01: Monorepo & repository baseline setup.
  - T07: ADRs (storage, auth, sealed-bid vault, AI gateway, tenancy).
  - T21: Repeatability deployment test (Wed 14 Oct).
  - T23: Architecture document & ESA pack (Wed 14 Oct).

### A1 — Product, Domain & Documentation
- **Role**: Domain specifications, legal/procurement rules modeling, synthetic seed datasets, user/admin guides, release notes.
- **Owned Folders**: `docs/requirements/`, `docs/guides/`, `seed/`.
- **Inputs**: `docs/requirements/tender-rules-draft.md` and tender pack template.
- **Assigned Tasks**:
  - **T02 (Sun 11 Oct)**: `state-model.md` (tender, bid, vendor states, transitions, who triggers, audit event for each), `role-matrix.md`, `tenant-config-schema.json`.
  - **T12 (Mon 12 Oct)**: Synthetic dataset in `seed/` — 2 fictitious entities ("Ministry A" and "Ministry B"), 20 vendors, 3 tenders with AR/EN packs, 6 bids, clarifications — loaded by one seed command (`npm run seed`).
  - **T19 & T23 (Tue-Wed 13-14 Oct)**: Install guide, admin guide, user quick guide (Arabic and English), release notes v0.9.0, `docs/roadmap.md`.
- **Constraints**: Never invent legal or procurement rules; mark assumptions and log questions in `docs/agents/QUESTIONS.md`. All names must be fictitious.

### A2 — Backend Agent
- **Role**: Authoritative REST API service, PostgreSQL migrations, OIDC integration, server-side RBAC, sealed-bid vault, evaluation scoring, PDF reports, and AI tool endpoints.
- **Owned Folders**: `services/api/`.
- **Assigned Tasks**:
  - **T03 (Sun 11 Oct)**: `openapi.yaml` v0.9 for every module (tenants, vendors, tenders, documents references, clarifications, addenda, bids, opening, evaluation, award, audit, reports, AI tools). Get A0, A3, A4, A5 review.
  - **T08 (Mon 12 Oct)**: Service skeleton per ADR, migrations, OIDC with Keycloak, server-side RBAC & tenant isolation, audit module, core entity services with API tests.
  - **T14 (Tue 13 Oct)**: Sealed-bid vault (per-bid encryption, release only after recorded opening event, deadline lock), opening, weighted evaluation scoring, award, PDF report generation for opening record and committee report. AI tool endpoints with caller permission verification.
- **Constraints**: All documents go through the `ContentStore` interface. Never store document bodies in PostgreSQL. Server-side authorization and tenant isolation strictly enforced.

### A3 — Frontend Agent
- **Role**: Three Next.js (TypeScript) applications, shared design system in `packages/ui`, bilingual Arabic & English with full RTL/LTR switch, Keycloak role-aware navigation, OpenAPI client integration.
- **Owned Folders**: `apps/` (`apps/vendor-portal`, `apps/procurement-app`, `apps/control-panel`), `packages/ui/`.
- **Assigned Tasks**:
  - **T06 (Sun 11 Oct)**: Three Next.js apps on shared design system in `packages/ui`; Arabic/English runtime RTL/LTR switch, i18n files, Keycloak login with role-aware nav, API client generated from `services/api/openapi.yaml`.
  - **T09 (Mon 12 Oct)**: Vendor registration and profile, tender drafting and publication, clarifications and addenda (demo steps 1-4).
  - **T15 (Tue 13 Oct)**: Sealed bid submission with cryptographic receipt, opening session, evaluation and scoring, award, control panel (users, roles, tender types, templates, labels, branding), audit log viewer, basic KPIs.
- **Constraints**: Tenant branding comes from tenant config, never hard-coded. WCAG 2.1 AA accessibility basics. Zero business rules in the UI; the API decides.

### A4 — Content Agent
- **Role**: IBM FileNet Content Manager integration via Content Services GraphQL API, FileSystemStore fallback, ContentStore interface implementation, TechZone provisioning scripts, and document lifecycle ACL management.
- **Owned Folders**: `services/content-adapter/`.
- **Assigned Tasks**:
  - **T04 (Sun 11 Oct)**: `provision/` — idempotent provisioning script (folders, classes, properties, groups); `ContentStore` interface (`put`, `get`, `getMetadata`, `search`, `setPermissions`, `listVersions`, streaming) with `FileNetStore` and `FileSystemStore`.
  - **T10 (Mon 12 Oct)**: Every document class wired through API, permissions per role, addenda as new versions, vendor documents via API only.
  - **T16 (Tue 13 Oct)**: Opening record and reports stored; at opening event, bid ACL switches from service-only to committee group; test-proven.
  - **T21 (Wed 14 Oct)**: Rerun `provision/` against fresh TechZone object store and time execution.
- **Constraints**: Environment variables only (`FILENET_GRAPHQL_URL`, `FILENET_OBJECT_STORE`, `FILENET_SERVICE_USER`, etc.). Never hard-code credentials.

### A5 — AI Agent
- **Role**: watsonx Orchestrate SaaS integration via ADK, YAML agent definitions, OpenAPI tool declarations, advisory evaluation datasets, and audit logging for AI actions.
- **Owned Folders**: `agents/`.
- **Assigned Tasks**:
  - **T05 (Sun 11 Oct)**: Hello agent plus OpenAPI tool calling hosted `/health` endpoint.
  - **T11 (Mon 12 Oct)**: `tender-pack-checker` and `clarification-assistant` agents in YAML with OpenAPI tools; outputs are drafts requiring human approval. `evals/`: 20 Arabic and 20 English benchmark questions on `seed/` with scoring script and `evals/results.md`.
  - **T17 (Tue 13 Oct)**: `bid-compliance-screener` (unsealed bids only); all agent actions logged to TenderFlow audit log; `import.sh` rebuilds agents in <15 minutes.
- **Constraints**: Synthetic data only. Never put secrets in agent YAML. Connection via `orchestrate env` with IBM IAM token. Every action strictly advisory (Rule 7).

---

*(Agent A6 will be appended when its brief is introduced)*
