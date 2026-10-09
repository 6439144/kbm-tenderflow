# TenderFlow Domain State Model Specification (Task T02)

**Author**: Agent A1 (Product & Domain Lead)  
**Governing Standard**: Multi-Tenant Regulated Procurement State Machine  
**Rule**: Every state change writes an immutable audit record (Rule 2).

---

## 1. Tender State Lifecycle

```mermaid
stateDiagram-v2
    [*] --> DRAFT: Procurement Officer creates tender
    DRAFT --> PENDING_APPROVAL: Officer submits for publication review
    PENDING_APPROVAL --> APPROVED_FOR_PUBLICATION: Director approves (Human sign-off)
    PENDING_APPROVAL --> DRAFT: Returned for rework
    APPROVED_FOR_PUBLICATION --> PUBLISHED: Officer publishes to Vendor Portal
    PUBLISHED --> CLOSED: Deadline elapsed
    CLOSED --> BIDS_OPENED: Opening Committee executes opening ceremony
    BIDS_OPENED --> EVALUATED: Evaluators submit signed scorecards
    EVALUATED --> AWARDED: Director signs final award
    DRAFT --> CANCELLED: Director cancels
    PUBLISHED --> CANCELLED: Director cancels with justification
```

### Tender Transitions & Audit Table

| From State | To State | Triggered By | Conditions & Rules | Mandatory Audit Event |
|---|---|---|---|---|
| `*` (New) | `DRAFT` | `PROCUREMENT_OFFICER` | Valid bilingual titles, estimated budget > 0 | `TENDER_CREATED` |
| `DRAFT` | `PENDING_APPROVAL` | `PROCUREMENT_OFFICER` | Specifications attached, AI completeness check reviewed | `TENDER_SUBMITTED_FOR_APPROVAL` |
| `PENDING_APPROVAL` | `APPROVED_FOR_PUBLICATION`| `DIRECTOR` | **Rule 7 Gate**: Formal recorded human sign-off with reason | `TENDER_APPROVED_FOR_PUBLISH` |
| `PENDING_APPROVAL` | `DRAFT` | `DIRECTOR` | Revision requested; change comments recorded | `TENDER_RETURNED_FOR_REWORK` |
| `APPROVED_FOR_PUBLICATION`| `PUBLISHED` | `PROCUREMENT_OFFICER` | Public notice visible on Vendor Portal | `TENDER_PUBLISHED` |
| `PUBLISHED` | `CLOSED` | `SYSTEM` / `OFFICER` | Submission deadline reached; no more bids accepted | `TENDER_CLOSED` |
| `CLOSED` | `BIDS_OPENED` | `OPENING_COMMITTEE_CHAIR` | **Rule 1 Gate**: Opening ceremony convened; attendees logged | `BID_OPENING_RECORDED` |
| `BIDS_OPENED` | `EVALUATED` | `EVALUATOR` / `CHAIR` | All technical & financial scorecards signed | `TENDER_EVALUATED` |
| `EVALUATED` | `AWARDED` | `DIRECTOR` | Winner selected based on scoring matrix | `TENDER_AWARDED` |
| `ANY` | `CANCELLED` | `DIRECTOR` | Mandatory legal cancellation justification | `TENDER_CANCELLED` |

---

## 2. Vendor State Lifecycle

```mermaid
stateDiagram-v2
    [*] --> PENDING_REVIEW: Supplier self-registers
    PENDING_REVIEW --> APPROVED: Buyer verifies commercial license
    PENDING_REVIEW --> REJECTED: Incomplete credentials
    APPROVED --> SUSPENDED: Disciplinary / sanction action
    SUSPENDED --> APPROVED: Reinstated
```

### Vendor Transitions & Audit Table

| From State | To State | Triggered By | Conditions & Rules | Mandatory Audit Event |
|---|---|---|---|---|
| `*` (New) | `PENDING_REVIEW` | `APPLICANT` (Vendor) | Commercial license & contact info provided | `VENDOR_REGISTERED` |
| `PENDING_REVIEW` | `APPROVED` | `PROCUREMENT_OFFICER` | Valid registration, clear tax certificate | `VENDOR_APPROVED` |
| `PENDING_REVIEW` | `REJECTED` | `PROCUREMENT_OFFICER` | Non-compliant or expired license | `VENDOR_REJECTED` |
| `APPROVED` | `SUSPENDED` | `DIRECTOR` | Formal sanction or compliance breach | `VENDOR_SUSPENDED` |
| `SUSPENDED` | `APPROVED` | `DIRECTOR` | Clearance of sanction | `VENDOR_REINSTATED` |

---

## 3. Bid State Lifecycle

```mermaid
stateDiagram-v2
    [*] --> SEALED: Vendor submits bid envelope
    SEALED --> OPENED: Opening ceremony unlocks technical envelope
    SEALED --> DISQUALIFIED: Formal bid withdrawal before opening
    OPENED --> DISQUALIFIED: Non-responsive technical evaluation
    OPENED --> AWARDED: Final contract award selection
```

### Bid Transitions & Audit Table

| From State | To State | Triggered By | Conditions & Rules | Mandatory Audit Event |
|---|---|---|---|---|
| `*` (New) | `SEALED` | `VENDOR` | Submitted before deadline with SHA-256 digest | `BID_SUBMITTED_SEALED` |
| `SEALED` | `OPENED` | `OPENING_COMMITTEE_CHAIR` | **Rule 1 Enforcement**: Unsealed only upon ceremony event | `BID_UNSEALED` |
| `OPENED` | `DISQUALIFIED` | `EVALUATOR` | Technical score below mandatory qualification threshold | `BID_DISQUALIFIED` |
| `OPENED` | `AWARDED` | `DIRECTOR` | Top ranking compliant composite score | `BID_AWARDED` |

---

## 4. Clarification Lifecycle

| From State | To State | Triggered By | Conditions & Rules | Mandatory Audit Event |
|---|---|---|---|---|
| `*` (New) | `PENDING` | `VENDOR` | Submitted prior to clarification cutoff | `CLARIFICATION_SUBMITTED` |
| `PENDING` | `ANSWERED` | `PROCUREMENT_OFFICER` | Reviewed AI draft response, recorded official answer | `CLARIFICATION_ANSWERED` |
