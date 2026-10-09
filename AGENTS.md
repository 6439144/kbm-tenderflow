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

---

*(Additional agents A2 through A6 will be appended as their briefs are introduced)*
