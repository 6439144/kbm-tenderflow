# TenderFlow v0.9.0 — 10-Step Review Demo Script

## Purpose & Scope
This document serves as the formal acceptance test for KBM TenderFlow v0.9.0.
Every step in this script must pass on a fresh environment deployed via `deploy/install.sh` or Docker Compose.
The demo illustrates the end-to-end tender-to-award cycle across three applications:
1. **Control Panel** (`apps/control-panel`) — Tenant administration & configuration
2. **Procurement App** (`apps/procurement-app`) — Sponsoring agency workflow & bid opening
3. **Vendor Portal** (`apps/vendor-portal`) — Supplier onboarding, tender discovery & sealed bid submission

All data used in this script is synthetic. No customer or real government entity data is permitted.

---

## Prerequisites & Environment Setup
1. Stack running via `docker compose -f deploy/docker-compose.yml up -d` or `deploy/install.sh`.
2. PostgreSQL 16 initialized on port 5432.
3. Content Adapter active on port 4001 (filesystem mock or FileNet GraphQL).
4. Core API active on port 4000.
5. Keycloak realm `tenderflow` running on port 8080 with mock/preloaded credentials.
6. Mailpit running on port 8025 (Web UI) and 1025 (SMTP).

---

## 10-Step Demo Walkthrough

### Step 1: Multi-Tenant Provisioning & Branding Configuration
* **Actor**: Platform Administrator (Control Panel)
* **Action**:
  1. Log into Control Panel (`http://localhost:3002/admin`).
  2. Create a new tenant using synthetic configuration package:
     - Tenant ID: `kea`
     - Legal Name: `Kuwait Energy Authority` / `هيئة الطاقة الكويتية`
     - Currency: `KWD`
     - Language: Bilingual (Arabic/English), RTL default for Arabic.
     - Document Storage: Configured to repository object store `OS_KEA`.
  3. Verify tenant is active and branded styles/labels load dynamically.
* **Acceptance Criteria**:
  - Tenant record created in PostgreSQL with unique tenant isolation key.
  - Audit event logged: `ACTION=TENANT_CREATED`, `ACTOR=admin`, `TENANT=kea`.
  - Provisioning completes in under 2 minutes.

### Step 2: Vendor Self-Registration & Approval
* **Actor**: Vendor Representative & Procurement Officer (Vendor Portal & Procurement App)
* **Action**:
  1. Navigate to Vendor Portal (`http://localhost:3000/register`).
  2. Register synthetic company: `Gulf Infrastructure Consortium` (`CR-984210`).
  3. Upload synthetic commercial license and tax clearance PDF.
  4. Procurement Officer logs into Procurement App (`http://localhost:3001/vendors`), reviews submitted dossier, and clicks **Approve Vendor**.
* **Acceptance Criteria**:
  - Documents stored via Content Adapter; document IDs recorded in database (no document binary in PostgreSQL).
  - Vendor state advances: `PENDING_REVIEW` -> `APPROVED`.
  - Audit event logged: `ACTION=VENDOR_APPROVED`, `REASON="Compliant commercial registration"`.

### Step 3: Tender Preparation & Specification Upload
* **Actor**: Procurement Specialist (Procurement App)
* **Action**:
  1. In Procurement App, navigate to **Tenders > New Tender**.
  2. Create tender:
     - Tender Number: `KEA-TND-2026-088`
     - Title (EN): `Enterprise Data Center Modernization & High-Availability Network`
     - Title (AR): `تحديث مركز البيانات والمحفظة الشبكية عالية التوافر`
     - Category: `Information Technology`
     - Estimated Budget: `250,000 KWD`
     - Submission Deadline: Future timestamp (or configurable test offset).
  3. Upload Tender Dossier (Terms of Reference, Technical Specs, Pricing Schedule).
* **Acceptance Criteria**:
  - Tender created in `DRAFT` state.
  - Document metadata linked via Content Adapter.
  - Audit event logged: `ACTION=TENDER_CREATED`.

### Step 4: AI Advisory Review & Formal Human Approval
* **Actor**: AI Advisory Agent & Procurement Director (Procurement App)
* **Action**:
  1. Procurement Specialist clicks **Run AI Completeness Check**.
  2. watsonx Orchestrate advisory tool inspects tender requirements and generates a checklist (scope defined, SLA specified, evaluation criteria weighted).
  3. System displays advisory recommendation badge: `RECOMMENDED FOR APPROVAL`.
  4. Procurement Director logs in, inspects the advisory output, and clicks **Authorize Publication**.
* **Acceptance Criteria**:
  - Rule 7 Enforced: The AI agent strictly provides advisory insights and cannot publish or advance the state autonomously.
  - Tender state advances: `DRAFT` -> `APPROVED_FOR_PUBLICATION`.
  - Audit event logged: `ACTION=TENDER_APPROVED_FOR_PUBLISH`, `ACTOR=director@kea.gov.kw`, `AI_ADVISORY_REF=chk-2026-088`.

### Step 5: Tender Publication & Public Notice
* **Actor**: Procurement Officer & Vendor Community (Procurement App & Vendor Portal)
* **Action**:
  1. Procurement Officer clicks **Publish Tender**.
  2. Public notice appears on Vendor Portal (`http://localhost:3000/tenders`).
  3. Switch portal language between English and Arabic; verify RTL layout, Arabic currency formatting, and countdown clock.
* **Acceptance Criteria**:
  - Tender state advances: `APPROVED_FOR_PUBLICATION` -> `PUBLISHED`.
  - Documents downloadable by authenticated vendors.
  - Audit event logged: `ACTION=TENDER_PUBLISHED`.

### Step 6: Clarifications & Addendum Issuance
* **Actor**: Vendor Representative & Procurement Specialist
* **Action**:
  1. Vendor submits clarification question via Vendor Portal: *"Is dual-power feed mandatory for all server racks?"*
  2. Procurement Specialist views question in Procurement App. AI Advisory tool drafts proposed response: *"Confirmed, redundant A+B feeds are mandatory per Section 4.2."*
  3. Procurement Specialist reviews/edits text and clicks **Approve & Issue Addendum #1**.
  4. Public Addendum #1 appears on Vendor Portal.
* **Acceptance Criteria**:
  - Clarification stored with question, human-approved answer, and addendum document.
  - Email notification dispatched to registered interested vendors (visible in Mailpit).
  - Audit event logged: `ACTION=ADDENDUM_ISSUED`, `ADDENDUM_NO=1`.

### Step 7: Sealed Bid Submission & Cryptographic Lock Proof
* **Actor**: Two Registered Vendors (Vendor Portal)
* **Action**:
  1. Vendor 1 (`Gulf Infrastructure Consortium`) submits sealed bid package (Technical envelope + Financial envelope).
  2. Vendor 2 (`National Smart Systems`) submits sealed bid package.
  3. **Verification of Rule 1 (Non-negotiable Sealed Bids)**:
     - An API call as Procurement Officer or Tenant Admin is made to `GET /api/v1/tenders/KEA-TND-2026-088/bids/bid-001/content`.
     - System rejects the call with HTTP `403 Forbidden` (`CODE=BIDS_SEALED_UNTIL_OPENING_EVENT`).
* **Acceptance Criteria**:
  - Bids stored in `SEALED` status with envelope cryptographic digest.
  - Zero read access to bid payload bodies by any user, service, or AI agent prior to the opening event.
  - Audit event logged: `ACTION=BID_SUBMITTED_SEALED`.

### Step 8: Bid Opening Ceremony
* **Actor**: Bid Opening Committee (Procurement App)
* **Action**:
  1. Once submission deadline expires (or test trigger enabled), Bid Opening Committee members convene.
  2. Committee Chairperson enters credentials and executes **Record Bid Opening Event**.
  3. System records opening ceremony timestamp, committee attendees, and unseals technical bid envelopes.
  4. Commercial/Financial envelopes remain locked if two-stage opening is configured, or unsealed according to tender rules.
* **Acceptance Criteria**:
  - Tender state advances: `CLOSED` -> `BIDS_OPENED`.
  - Bid status advances from `SEALED` to `OPENED`.
  - Immutable audit event recorded: `ACTION=BID_OPENING_RECORDED`, `ATTENDEES=["chair@kea.gov.kw", "member1@kea.gov.kw"]`.
  - Bids now accessible for evaluation.

### Step 9: Technical & Financial Evaluation with AI Assistance
* **Actor**: Evaluation Committee & AI Advisory Agent (Procurement App)
* **Action**:
  1. Evaluators open the evaluation matrix in Procurement App.
  2. Advisory agent parses technical bids against requirement criteria, producing draft compliance matrix and gap analysis.
  3. Evaluators review each AI proposal, adjust scores as required, and submit individual evaluator scorecards.
  4. Consensus score computed: Vendor 1 receives 94/100, Vendor 2 receives 81/100.
* **Acceptance Criteria**:
  - Rule 7 Enforced: AI provides draft scoring suggestions; final scores require explicit human evaluator sign-off.
  - Scorecard records evaluator IDs, criteria breakdown, and notes.
  - Audit event logged: `ACTION=EVALUATION_COMPLETED`.

### Step 10: Award Decision & Immutable Audit Verification
* **Actor**: Authorized Awarding Officer & Compliance Auditor (Procurement App)
* **Action**:
  1. Procurement Officer submits award recommendation for `Gulf Infrastructure Consortium`.
  2. Authorized Officer signs off on final award.
  3. System issues official Award Notice to winner and unawarded notifications to remaining participants.
  4. Compliance Auditor opens the **Audit Log Explorer** in Control Panel and exports the complete audit chain for tender `KEA-TND-2026-088`.
* **Acceptance Criteria**:
  - Tender state advances: `EVALUATED` -> `AWARDED`.
  - Winning vendor status updated to `AWARDED`.
  - Exported audit log contains sequential, unbroken cryptographic event chain from Step 1 through Step 10.
  - Zero discrepancies, zero leaks, 100% tenant-isolated records.
