# TenderFlow v0.9.0 — User Quick Guide (English)

**Product**: TenderFlow Enterprise Digital Tendering Platform  
**Target Release**: v0.9.0 (ESA Review Build)  
**Standard**: Regulated Enterprise & Public Procurement Governance  

---

## 1. Overview & Applications

TenderFlow manages the complete end-to-end tendering lifecycle across three specialized, role-aware web applications:

| Application | Audience & Primary Roles | Default URL | Key Responsibilities |
|---|---|---|---|
| **Vendor Portal** | `VENDOR`, Public Suppliers | `https://localhost` (or `:3000`) | Self-registration, browsing tenders, Q&A inquiries, cryptographic sealed bid submission. |
| **Procurement App** | `PROCUREMENT_OFFICER`, `DIRECTOR`, `EVALUATOR`, `OPENING_COMMITTEE_CHAIR` | `https://localhost/procurement/` (or `:3001`) | Dossier drafting, AI completeness check, publication sign-off, bid opening ceremony, scoring, and contract award. |
| **Control Panel** | `SUPER_ADMIN`, Platform Auditors | `https://localhost/control-panel/` (or `:3002`) | Tenant package provisioning (<1 hr), role management, branding, and immutable audit trail verification. |

---

## 2. Walkthrough: The 10-Step Review Lifecycle

### Step 1: Tenant Provisioning
- The Platform Administrator accesses the **Control Panel**.
- A tenant configuration package (e.g. `Ministry A` or `Ministry B`) is imported.
- The platform dynamically loads localized branding, default currency (`KWD`), tender category taxonomy, and role definitions without restarting services.

### Step 2: Vendor Registration & Qualification
- Prospective suppliers navigate to the **Vendor Portal** and submit self-registration details:
  - Arabic and English commercial trade names.
  - Commercial Registration (CR) number.
  - Authorized signatory contact details and company license documents.
- The Procurement Officer reviews submitted credentials in the **Procurement App** and signs off on the qualification approval.
- An automated welcome and activation receipt is dispatched via the notification sandbox.

### Step 3: Tender Preparation (`DRAFT`)
- The Procurement Officer initiates a new tender in the **Procurement App**.
- Enters bilingual tender title, unique reference number (e.g. `KEA-TND-2026-088`), estimated budget, submission deadline, and attaches technical specifications and terms of reference.
- Documents are streamed directly to the secure enterprise content repository (no document bodies are stored in the relational database).
- The tender is saved in `DRAFT` status.

### Step 4: AI Completeness Review & Director Sign-Off (Rule 7)
- The Procurement Officer runs the **AI Completeness Check**.
- The Advisory Assistant reviews the dossier against mandatory regulatory requirements (budget threshold, deadline sanity, mandatory document attachments).
- The Advisory Assistant returns an advisory scorecard and recommendation (`RECOMMENDED_FOR_APPROVAL`).
- **Rule 7 Enforced**: The AI cannot publish or approve. The **Procurement Director** reviews the advisory report, enters an approval justification, and signs off. Status transitions to `APPROVED_FOR_PUBLICATION`.

### Step 5: Tender Publication to Vendor Portal
- The Procurement Officer executes the final publication command.
- Status transitions to `PUBLISHED`.
- The tender dossier immediately becomes visible on the public **Vendor Portal** for registered suppliers to inspect and download.

### Step 6: Clarifications & Addenda
- Registered suppliers submit written inquiries via the tender inquiry interface on the **Vendor Portal**.
- In the **Procurement App**, the Procurement Officer reviews inquiries.
- The Advisory Assistant generates a recommended bilingual draft answer citing the tender dossier.
- The Procurement Officer reviews, edits, and officially publishes the answer and an Addendum notice to all participating suppliers simultaneously.

### Step 7: Sealed Bid Submission & Cryptographic Receipt (Rule 1)
- The vendor prepares two separate proposals: **Technical Proposal** and **Financial Proposal**.
- On the **Vendor Portal**, the vendor uploads both envelopes.
- The system generates client-side SHA-256 cryptographic digests, encrypts the envelopes into the Sealed Bid Vault, and delivers an immutable digital receipt (`hashDigest`).
- **Rule 1 Enforced**: The bid content is cryptographically sealed. Zero read access is permitted to any user, administrator, or AI agent prior to the formal opening event. Any read attempt returns HTTP `403 Forbidden`.

### Step 8: Bid Opening Ceremony
- Once the submission deadline elapses, the tender transitions to `CLOSED`.
- The Bid Opening Committee convenes with the **Bid Opening Committee Chair** and designated witnesses.
- The Committee Chair executes the formal **Bid Opening Ceremony**, recording attendee names and meeting minutes.
- The ceremony event unseals the technical proposals, logs an immutable audit event, and grants technical evaluators read access to the proposals.

### Step 9: Evaluator Scorecard & AI Scoring Advice
- Designated **Evaluators** inspect the unsealed technical proposals.
- An AI compliance advisory assistant screens proposals for criteria compliance and suggests scoring baselines.
- Evaluators submit individual scorecards using the weighted evaluation matrix (70% Technical, 30% Financial).
- Composite scores are calculated and locked in the evaluation ledger.

### Step 10: Contract Award Sign-Off & Audit Trail (Rule 2)
- The **Procurement Director** reviews the final composite evaluation ranking.
- The Director authorizes the contract award to the top-ranked vendor, issuing the official Award Notice and Letter of Intent.
- **Rule 2 Enforced**: The platform verifies the entire HMAC SHA-256 tamper-evident audit ledger chain from Step 1 to Step 10, proving complete end-to-end traceability and cryptographic integrity.

---

## 3. Keyboard & Language Controls
- **Language Switch**: Click the language toggle (`العربية` / `English`) in the top navigation bar to switch between Arabic (RTL) and English (LTR) at runtime.
- **Tenant Context**: Switch tenant view in the top header to inspect isolated data per entity.
