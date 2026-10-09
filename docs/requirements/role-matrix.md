# TenderFlow Role & Segregation of Duties Matrix (Task T02)

**Author**: Agent A1 (Product & Domain Lead)  
**Standard**: Regulated Enterprise Procurement Governance

---

## 1. Role Definitions

| Role Code | English Title | Arabic Title | Description |
|---|---|---|---|
| `SUPER_ADMIN` | Platform Administrator | مدير المنصة | System configuration, tenant provisioning, security policies. |
| `DIRECTOR` | Procurement Director | مدير إدارة المشتريات | Executive sign-off for tender publication, cancellation, and awards. |
| `PROCUREMENT_OFFICER` | Buyer / Procurement Officer | مسؤول مشتريات | Dossier drafting, vendor verification, answering clarifications. |
| `OPENING_COMMITTEE_CHAIR` | Bid Opening Committee Chair | رئيس لجنة فتح المظاريف | Convenes opening sessions and unseals bid envelopes. |
| `EVALUATOR` | Technical/Commercial Evaluator | عضو لجنة التقييم | Evaluates unsealed proposals and signs scorecards. |
| `VENDOR` | Authorized Vendor Representative | ممثل المورد المعتمد | Bids submission, downloads tender documents, submits inquiries. |

---

## 2. Permission Matrix Across Review Demo Steps

| Lifecycle Action | Step | Super Admin | Director | Buyer | Opening Chair | Evaluator | Vendor |
|---|---|---|---|---|---|---|---|
| Provision Tenant | Step 1 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Register Vendor Account | Step 2 | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Approve Vendor Account | Step 2 | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Draft Tender Dossier | Step 3 | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Trigger AI Completeness Check | Step 4 | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Authorize Tender Publication | Step 4 | ❌ | ✅ (Gate) | ❌ | ❌ | ❌ | ❌ |
| Publish Tender to Portal | Step 5 | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Submit Clarification Inquiry | Step 6 | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Issue Clarification / Addendum | Step 6 | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Submit Sealed Bid Envelope | Step 7 | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Inspect Sealed Bid Payload** | Step 7 | 🚫 Blocked | 🚫 Blocked | 🚫 Blocked | 🚫 Blocked | 🚫 Blocked | 🚫 Blocked |
| Execute Bid Opening Event | Step 8 | ❌ | ❌ | ❌ | ✅ (Gate) | ❌ | ❌ |
| Submit Evaluator Scorecard | Step 9 | ❌ | ❌ | ❌ | ❌ | ✅ (Gate) | ❌ |
| Sign Contract Award Notice | Step 10| ❌ | ✅ (Gate) | ❌ | ❌ | ❌ | ❌ |
| Inspect Audit Ledger Chain | Step 10| ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |

---

## 3. Segregation of Duties (SoD) Rules

1. **Rule SoD-1 (Buyer ≠ Approver)**:
   The `PROCUREMENT_OFFICER` who drafts a tender cannot authorize its publication. Authorization requires a distinct `DIRECTOR` persona.
2. **Rule SoD-2 (Evaluator ≠ Award Approver)**:
   Individual `EVALUATOR` team members score technical and commercial criteria; the final contract award decision requires formal authorization by the `DIRECTOR`.
3. **Rule SoD-3 (Opening Chair Gate)**:
   Only the designated `OPENING_COMMITTEE_CHAIR` holds the authority to record the opening event and unseal bids.
4. **Rule SoD-4 (Sealed Bid Privacy)**:
   Zero users (including `SUPER_ADMIN`) may read or export bid bodies before the recorded opening event.
