# TenderFlow v0.9.0 — Human Decisions & Questions Log

**Purpose**: Formal log for questions directed to human product owners / lead architects.
**Rule**: Never invent business rules; record the assumption, provide clear options, and state the agent recommendation.

---

## Logged Questions

### Q-001: Bid Opening Committee Quorum Requirement
* **Context**: Step 8 of `docs/review-demo.md` requires recording the "Bid Opening Event" to unseal submitted bids.
* **Question**: Does TenderFlow require a multi-person cryptographic threshold / quorum (e.g. at least 2 committee members signing off simultaneously) before bids can be unsealed, or is a single committee chairperson sign-off sufficient for v0.9.0?
* **Options**:
  1. *Option A (Recommended for v0.9.0)*: Single authorized Bid Opening Committee Chairperson executes the opening event with an attendee list recorded in the audit event.
  2. *Option B*: Multi-signature quorum requiring 2 or more distinct committee members to authenticate and approve within a 30-minute opening window.
* **Working Assumption for v0.9.0**: Implement Option A as the baseline to ensure demo flow runs smoothly without multi-operator login friction, but design the data model with an `opening_attendees` array so Option B multi-sig can be activated in v1.0.0.

---

### Q-002: Two-Stage vs. Single-Stage Bid Envelope Unsealing
* **Context**: In government procurement, technical bids are often opened and evaluated first, while financial/commercial bids remain sealed until technical qualification is passed.
* **Question**: Should v0.9.0 enforce two-stage opening (technical first, financial later) or single-stage simultaneous opening?
* **Options**:
  1. *Option A (Recommended)*: Tenant-configurable per tender type (`TWO_STAGE_ENVELOPE` vs `SINGLE_STAGE_COMBINED`), defaulting to `TWO_STAGE_ENVELOPE` for standard tenders.
  2. *Option B*: Single-stage only for v0.9.0.
* **Working Assumption for v0.9.0**: Tenant configuration package defines `envelope_mode: "TWO_STAGE" | "SINGLE_STAGE"`. In the 10-step review demo, technical envelopes unseal at opening, and financial envelopes unseal upon technical committee qualification sign-off.

---

### Q-003: Keycloak Realm Pre-configuration vs Dynamic Client Registration
* **Context**: The deployment must run on clean VM instances via `install.sh` and Docker Compose.
* **Question**: Should the Keycloak realm be pre-seeded via exported JSON realm file or configured dynamically via Keycloak Admin REST API on startup?
* **Options**:
  1. *Option A (Recommended)*: Ship pre-exported `deploy/keycloak/tenderflow-realm.json` mounted into the Keycloak container import directory (`/opt/keycloak/data/import`).
  2. *Option B*: Python/Bash startup script that runs REST calls against Keycloak admin endpoint.
* **Working Assumption for v0.9.0**: Option A is the most reliable, deterministic, and self-contained approach for reproducible zero-friction builds.
