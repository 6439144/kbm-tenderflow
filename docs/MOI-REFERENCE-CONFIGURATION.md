# MOI reference configuration — requirement traceability

**Source:** *MOI Tender Platform BRD v0.1* (2026-08-25, Tawfiq Habayeb, KBM — "DRAFT FOR MOI REVIEW").
**Entity in the demo:** `moi` — "Ministry of Interior (MOI) — reference configuration · demo data".
Every tender, vendor, person, department, letter and document in this entity is **fictitious** and labelled so.
There is no MOI logo or emblem; the receipt uses a neutral "MOI" initials mark.

This table states what TenderFlow does today against each BRD requirement, where it is seen, and its status. It
claims nothing the code does not do; anything not verified against a live MOI system says so.

## Status legend

| Status | Meaning |
|---|---|
| **Implemented** | Built, enforced by the server, covered by automated tests and seen in the browser. |
| **Configurable — pending MOI decision** | Built both (or all) ways; the current value is a setting shown on *Admin → Entity policies* with the badge "Open — pending MOI decision" or "Proposed — pending MOI approval". Changing it is audited; no code change. |
| **Needs MOI input** | Cannot be finished without information or a decision only MOI can give (specifications, integration details, infrastructure). Stated plainly; not a setting. |
| **Out of Phase 1 (available in the product)** | Agreed as outside Phase 1; the product already has it and the entity's cycle scope switches it on. |
| **Other workstream** | Built in a parallel TenderFlow workstream (security, notifications); not part of this branch. |

## How the demo is configured

* Cycle template **MOI Phase 1 — request to purchase** (`MOI_PHASE1`, default): scope **Publication and document sale**
  (`scope: PUBLICATION_AND_SALE`), request intake on, paid documents (KWD 25, illustrative), request approval
  Director → Assistant Undersecretary and publication approval Director — both chains labelled
  *"illustrative — MOI to confirm (DEP-001)"* with a service level in hours per step.
* Entity policies (annotated against `MOI-BRD-v0.1`): visibility *eligible only*, grade meaning *that grade and above*,
  grade *per activity*, subscription *required* (KWD 100, 12 months, from payment date), *retain purchased tenders
  after expiry*, renewal reminders 30/7/1 days, exemption *per vendor* waiving *tender documents only*, blocking by
  *Administrator* with effect *continue*, grading by *Grading authority*, content protection *view only*.
* Receipt number series `MOI-RCPT-{YYYY}-{SEQ6}`; tender numbers `MOI-T-{YYYY}-{SEQ3}`.
* Seven fictitious MoC-style activity codes (SEC-101, VEH-202, ITE-303, CON-404, UNI-505, COM-606, FUR-707).
* Users (password = `DEMO_PASSWORD`): `officer` (tender creator), `tenderdept` (Tender Department), `grader`
  (grading authority), `director`, `undersecretary`, `admin`, `auditor`; vendors `vendor1` (active, First grade
  security), `vendor2` (Second grade vehicles, subscription ends in 5 days, upgrade request pending), `vendor3`
  (application in the grading queue), `vendor4` (blocked until next week), `vendor5` (fee-exempt).
* Requests: one from Raslni (reference recorded, approved, converted to the published CCTV tender) and one from a GM
  letter with a generated PDF clearly marked "SAMPLE SCAN". Tenders: one PUBLISHED with documents for sale, one DRAFT.
* Demo Story **track C — MOI reference** (8 chapters) walks through all of the above.

## Functional requirements

| BRD ID | Requirement (short) | How TenderFlow meets it | Screen | Status |
|---|---|---|---|---|
| FR-001 | Departments submit requests | Requests register with numbering `MOI-REQ-YYYY-NNNN`; source Raslni or signed letter | Procurement → Requests | Implemented |
| FR-002 | Raslni electronic submission | The Tender Department records a Raslni request with its Raslni reference (mandatory). There is **no integration with Raslni** itself | Requests → Register request (Raslni) | Needs MOI input (DEP-002 Raslni documentation; RISK-001 third-party owner) |
| FR-003 | Official GM letter | Letter requests carry the signed letter scan as a document | Request detail → Signed letter | Implemented |
| FR-004 | Tender Department receives requests | `tenderdept` role records and follows requests | Requests | Implemented |
| FR-005 | Vendors view tenders | Vendor home lists the tenders the vendor may see | Vendor → My company | Implemented |
| FR-006 | Purchase via KNET | Purchase works end to end with the **TEST gateway** (labelled "TEST PAYMENT — no money taken"). KNET is refused with `503 KNET_NOT_CONFIGURED` until a merchant is configured | Vendor tender → Tender documents purchase | Implemented (TEST); KNET Needs MOI input (DEP-004) |
| FR-007 | Printable receipt | Receipt page with print layout; TEST receipts say so in capitals | `/receipt/:number` | Implemented |
| FR-009 / BR-002 | Grades First / Second / Third | Grade 1–3 per activity (or company-wide, see BR-007) | Grading; Subscription & grade | Implemented |
| FR-010 | Grade upgrade request with documents → approval → notification | Vendor uploads up to 5 documents (content store, SHA-256, document intelligence when configured) → grading authority approves/declines with reason (requester ≠ decider) → classification updated → NOT-003. The Orchestrate grade reviewer panel is on the request page (advisory) | Vendor → Subscription & grade; Procurement → Grading → upgrade | Implemented (single decision by the grading function). A multi-step upgrade approval needs MOI input (DEP-003) |
| FR-011 | Staff record a request manually | Register request form | Requests | Implemented |
| FR-012 / BR-005 | Scanned GM letter mandatory | The server refuses a letter request without the scan (`400`) | Requests | Implemented |
| FR-013 | Block a vendor = full suspension preventing login | Block from the admin panel; login refused with `403 ACCOUNT_SUSPENDED` **after** the password is verified (no username probing); the demo persona switch is refused too; tender access and purchases refused while blocked | Admin → Vendor lifecycle; Login | Implemented |
| FR-014 | Automatic restore at end date | Lifecycle job (every 15 min, `LIFECYCLE_JOB_INTERVAL_MS`; "Run now" for the administrator) ends the block, audited `VENDOR_REINSTATED` | Admin → Vendor lifecycle | Implemented |
| FR-015 | Apply via the external portal with documents | Public registration + document upload; the required document list is a policy shown to vendors and graders (the registration form does not yet enforce the list) | `/register`; My company | Implemented; document list Configurable — pending MOI decision |
| FR-016 | Grading authority assigns grade from the documents | Grading queue: documents, expected list, grade per activity (or company grade), approve/reject with reason. While a subscription is required the v1 "approve vendor" route answers `409 GRADING_REQUIRED` | Procurement → Grading | Implemented |
| FR-017 | On approval, KNET link for a one-year subscription | Approval issues a payment link (NOT-004); payment activates a 12-month period | Vendor → Subscription & grade | Implemented (TEST gateway; KNET as FR-006) |
| FR-018 | Exempt a vendor from purchasing tenders | Per-vendor flag **or** vendor category; waives tender documents only **or** also the subscription; exempt purchase gets a zero-amount receipt (`EXEMPT`) | Admin → Vendor lifecycle; Entity policies | Configurable — pending MOI decision |
| FR-019 | Tender creator selects activities and grade | Tender form: activity codes (one or more) + minimum grade | New tender | Implemented |
| FR-020 / SEC-006 | Vendor sees only matching tenders, on every access | Enforced on list, detail, and every pack/addendum download (`404` for a hidden tender — existence not revealed) | Vendor home / tender | Implemented |
| FR-022 (proposed) | Receipt is an MOI document with MOI's number series and the KNET transaction id | One series for document purchases and subscription payments; gateway transaction id on the receipt | Receipt | Implemented (pending MOI approval of the proposal) |
| FR-023 (proposed) | Watermarked download stamped with vendor ID, name, time | Option `WATERMARKED_DOWNLOAD` of the content-protection policy | Entity policies | Configurable — pending MOI decision; enforcement: other workstream (security) |
| FR-024 (proposed) | Blocked vendor notified out-of-band; login says suspended | Login screen: "suspended until …" (EN/AR); in-app NOT-005 notice | Login; bell | Implemented (in-app + login). E-mail/SMS: other workstream (notifications) |
| FR-026 | System executes the internal approval workflow | N-level approval chains per template (request, publication), different person per level, service level in hours | Request / tender detail; Cycle Designer | Implemented; the actual MOI steps are Configurable — pending MOI decision (DEP-001) |
| FR-027 / AUD-001 | Full approval cycle recorded and auditable | Every step, decision, actor, reason, timestamp in the append-only HMAC-chained audit log; auditor can verify the chain | Audit log | Implemented |
| — | "No rejection, return-for-correction, cancellation or escalation path has been defined" | Return / reject with mandatory reason exist for requests, applications and upgrades; escalation uses the stored service level (notifications workstream) | — | Available; MOI to confirm which paths apply |

## Business rules

| BRD ID | Rule | How | Status |
|---|---|---|---|
| BR-006 | Block for a date range or permanently | `DATE_RANGE` (from/to) or `PERMANENT`, ground + reason, authorised roles per policy, audited | Implemented; grounds / authoriser / effect on paid subscription Configurable — pending MOI decision |
| BR-007 | Visible when ≥1 activity overlaps AND grade satisfies the level | `checkEligibility` with `gradeMatch` (EXACT "that grade only" / AT_LEAST "that grade and above") and `gradeScope` (PER_ACTIVITY / COMPANY) | Implemented; both open questions Configurable — pending MOI decision |
| BR-008 (proposed) | No valid subscription → cannot view or purchase | `subscriptionRequired`; refused with `403 SUBSCRIPTION_REQUIRED`, explained on the vendor home | Configurable — pending MOI approval |
| BR-009 (proposed) | Year runs from payment date | `subscriptionStart` PAYMENT_DATE / APPROVAL_DATE; an early renewal starts when the current period ends | Configurable — pending MOI approval |
| BR-010 (proposed) | Keep access to purchased tenders after expiry | `retainPurchasedAfterExpiry` | Configurable — pending MOI approval |

## Notifications

| BRD ID | Notification | How | Status |
|---|---|---|---|
| NOT-001 | Renewal reminder before expiry (mandatory) | Job sends one in-app reminder per crossed threshold (default 30/7/1 days), never twice; vendor page shows the reminder banner | Implemented (in-app); timing Configurable — pending MOI decision; e-mail/SMS: other workstream |
| NOT-002 | MOI notified of a new application / upgrade request | In-app to every role in the grading policy | Implemented (in-app) |
| NOT-003 | Vendor notified of the upgrade decision | In-app with reason | Implemented (in-app) |
| NOT-004 | Vendor receives the subscription link | In-app with the pay link | Implemented (in-app) |
| NOT-005 | Block / suspension notice | In-app; reinstatement notice too | Implemented (in-app) |

## Security and integration

| BRD ID | Requirement | Status |
|---|---|---|
| SEC-001 / SEC-002 | No screenshots while viewing tenders | Content-protection mode is a policy (default *view only*, pending decision); enforcement: other workstream (security). Browsers cannot fully prevent screenshots — view-only and watermarking reduce and trace leakage. Needs MOI decision |
| SEC-003 | MOI internal system only from MOI premises | Needs MOI input (deployment / network decision) |
| SEC-004 (proposed) | Purchase granted only after server-side verification, never the redirect | The TEST gateway records the payment on the server (no browser redirect is trusted). Real KNET verification Needs MOI input (DEP-004 merchant + spec) |
| SEC-005 (proposed) | Vendor MFA | Other workstream (security) |
| SEC-006 | Eligibility enforced on every access | Implemented (see FR-020) |
| SEC-008 (proposed) | Push-only from the internal zone to the vendor zone | Needs MOI input (architecture decision) |
| INT-004 / DEP-005 | Staff authenticate with MOI Active Directory | Other workstream (security) for the AD/OIDC login; account provisioning (admin-created vs AD groups) is a policy — AD groups Need MOI input (DEP-005) |

## Platform, roles and environments

| BRD item | How | Status |
|---|---|---|
| Three interfaces (admin, MOI team, vendor) | Admin portal, procurement portal (incl. Grading), vendor portal | Implemented |
| Actors ACT-001…008 ("functions, not job titles") | ACT-003 → Procurement officer (`tenderdept`), ACT-005 → new role **Grading authority** (`GRADING_AUTHORITY`), ACT-006/008 → Administrator, ACT-007 → Procurement officer; which roles grade and block is a policy | Implemented; final role mapping Configurable — pending MOI decision |
| Platform configuration by an administrator | Cycle Designer (scope, stages, approval chains with service levels, eligibility, fees), Entity settings, Entity policies — every change audited | Implemented |
| User and role management, both sides | Administrator creates staff users with any role combination; vendors self-register | Implemented (staff). Several users per vendor company: not in the product today |
| Dashboard for every user | Role dashboards and vendor home exist | Needs MOI input (KPIs per user group) |
| Activity code sourcing | Manual entry and CSV/TSV file import (admin, audited) work; MoC API needs its specification | Configurable — MoC API Needs MOI input |
| Dev + prod environments, release promotion | — | Needs MOI input |
| NFRs | — | Needs MOI input |
| Refunds, failed payments | An unpaid subscription link stays open for retry; no refund flow | Needs MOI input |

## Outside Phase 1 (agreed with MOI)

| Capability | Status |
|---|---|
| Bid submission (sealed, encrypted) | Out of Phase 1 (available in the product). With scope `PUBLICATION_AND_SALE` the stages are absent from the cycle, the UI shows "Bidding and award are outside this entity's current scope (Phase 2)", and the API refuses with `409 STAGE_NOT_IN_SCOPE` |
| Bid opening / committees | Out of Phase 1 (available in the product) — same switch |
| Technical and financial evaluation | Out of Phase 1 (available in the product) — same switch |
| Award | Out of Phase 1 (available in the product) — same switch |
| Contracts and guarantees | Not in the product today (bank guarantees exist only as a document type) |

## BRD section 15 open items

The policies page lists every section-15 item with the setting that absorbs it, or "Needs MOI input — not
configurable". Summary: 14 configurable, 1 available (rejection handling), 1 implemented (configuration audit),
9 need MOI input (network boundary, portal boundary, NFRs, refunds, failed payments, grade criteria, dashboards,
dev environment, release promotion).

## Verification

* Automated: `services/api/test/moi-lifecycle.test.ts` (scope refusal, policies edit/audit, grading + NOT-002/004,
  subscription required/expiry/retain, eligibility EXACT/AT_LEAST × PER_ACTIVITY/COMPANY on list/detail/download,
  reminder job once per threshold, upgrade flow, exemption modes, blocking date-range + permanent with automatic
  reinstatement, activity-code import) and `services/api/test/moi-seed.test.ts` (the seeded entity end to end,
  including the blocked persona switch).
* Browser (EN + AR, Playwright against a local server): policies page; Tender Department records a GM-letter request;
  director approves level 1; officer creates a tender for activities + grade; vendor1 buys (TEST) and prints the MOI
  receipt; vendor2 sees no tender; blocked vendor login message; grader grades the pending application and approves
  the upgrade; vendor3 pays its link (KNET refused as not configured); Cycle Designer scope; Demo Story track C.
* **Not verified against live systems:** KNET, Raslni, MOI Active Directory, e-mail/SMS delivery, IBM FileNet and
  watsonx Orchestrate (the demo runs with the local content store and without AI unless configured).
