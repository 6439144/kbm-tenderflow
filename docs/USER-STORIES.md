# TenderFlow v1.0.0-rc3 — implemented user stories

As of 10 Oct 2026. 124 user stories are implemented: 79 in rc2 and 45 added in rc3 (sections 14–18).

How each story was verified:
- **Test**: covered by automated API, integration or unit tests. 214 tests pass: 174 API/integration and 40 AI unit tests.
- **Browser**: walked through in Chromium with a script, on freshly seeded demo data, in English and Arabic where noted. Four scripted walk-throughs pass with no console errors.
- **Live IBM**: not yet run against the TechZone FileNet or watsonx Orchestrate instance. These were built and tested against local fake servers that follow IBM's published APIs, and must be verified on the Windows machine. The commands are in the README.

FileNet storage itself (upload, download, Arabic text, 2 MB files, SHA-256 match) was **verified live against TechZone on 9 Oct 2026** (`npm run verify:filenet`).

## 1. Entity set-up and configurable cycle

| # | User story | Verified |
|---|---|---|
| 1 | As a tenant admin, I can open the Cycle Designer, switch optional stages on or off, edit N-level approval chains, choose one or two envelopes with a pass mark, set eligibility, fees and AI agents, and watch a live preview of the cycle, so that each entity runs its own process. | Browser, Test |
| 2 | As a tenant admin, I can validate a template, save it as a new version and publish it (optionally as the default). Running tenders keep the version they started with. | Browser, Test |
| 3 | As a tenant admin, I cannot publish a template that breaks the fixed integrity rules (sealed bids, opening by the chair, approver ≠ creator, recommender ≠ award approver, append-only audit). | Test |
| 4 | As a tenant admin, I can set the entity profile (names EN/AR, colour, tender and receipt numbering with a live example, KNET/gazette/CAPT channels, identity provider, fiscal year) and manage activity codes. | Browser (viewed), Test (save) |
| 5 | As a tenant admin, I can install three starter templates (public tender, limited tender, two-envelope RFP), so a new entity works on day one. | Test |
| 6 | As a tenant admin, I can edit the document-type catalogue (types, contexts, fields with EN/AR labels). Fields for civil ID or passport numbers are refused. | Browser, Test |

## 2. Department requests

| # | User story | Verified |
|---|---|---|
| 7 | As a procurement officer, I can register a department request from a scanned GM letter (upload mandatory) or a Raslni reference (reference mandatory), with a suggested template. | Browser, Test |
| 8 | As a director, I can approve, return or reject a request at my level of its approval chain. | Browser (approve), Test (all) |
| 9 | As a procurement officer, I can convert an approved request into a draft tender that links back to the request. | Browser, Test |
| 10 | As staff, I can have Orchestrate classify the request letter (template, activity codes, urgency, budget, EN/AR summary, citations) and accept or ignore the suggestion. | Test; Live IBM |

## 3. Vendors, eligibility and fees

| # | User story | Verified |
|---|---|---|
| 11 | As a company, I can register and upload my documents; as an officer I can approve or reject the vendor. | Browser, Test |
| 12 | As an officer or admin, I can set a vendor's activity codes and grades (First/Second/Third) with validity dates. | Test (editor built, not walked) |
| 13 | As a vendor who does not meet a tender's eligibility rule, I see the reasons in Arabic and English and the bid form is closed. The server refuses the bid as well. | Browser, Test |
| 14 | As a vendor, I can buy tender documents through the TEST gateway. It is labelled unmistakably as "TEST PAYMENT", and I get a numbered receipt, after which bidding opens. KNET is refused until a merchant ID is configured. | Browser, Test |
| 15 | As an officer, I can grant a fee exemption when the template allows it, and the exemption is audited. | Test |
| 16 | As an officer or admin, I can have Orchestrate check a vendor's documents against the grade checklist (PRESENT/MISSING/UNCLEAR with evidence). The officer still decides the grade. | Test; Live IBM |

## 4. Drafting, approval and publication

| # | User story | Verified |
|---|---|---|
| 17 | As an officer, I can draft a tender from a template (its stage strip shown), set per-tender eligibility and criteria, and upload the pack, which is stored in FileNet. | Browser, Test; FileNet live (storage) |
| 18 | As an officer, I can run the Orchestrate pack check and see findings with citations to the page or section. | Test; Live IBM |
| 19 | As the holder of the waiting level's role (director, undersecretary, …), I can approve "Level n of N" or return the tender. The creator can never approve. | Browser, Test |
| 20 | As an officer, I can publish an approved tender; the portal publication is created and eligible vendors are notified. | Browser, Test |
| 21 | As an officer, I can draft a Kuwait Al-Youm or CAPT notice (manually or with the Orchestrate notice drafter). Another person approves it, and the officer then records the gazette reference and date. | Browser (manual), Test; Live IBM (AI draft) |
| 22 | As staff, I can rank the eligible vendors for a published tender with Orchestrate, with the reasons shown. Rules decide eligibility; AI only ranks. | Browser (fake), Test; Live IBM |
| 23 | As a vendor, I see "Tenders for you": open tenders I am eligible for, ranked by Orchestrate with reasons. | Browser (fake), Test; Live IBM |
| 24 | As any user, I get in-app notifications in a header bell (unread count, list, mark read, open the tender or request). | Browser (list), Test |

## 5. Clarifications, addenda and sealed bids

| # | User story | Verified |
|---|---|---|
| 25 | As a vendor, I can ask a clarification; as an officer I can answer it, optionally from an Orchestrate draft that cites the pack. | Browser, Test; Live IBM (AI draft) |
| 26 | As an officer, I can issue an addendum that becomes the next major version of the same FileNet document (`FILENET_VERSIONING=true`). It fails loudly and never falls back silently. | Test, Browser (fake FileNet); Live IBM |
| 27 | As a vendor, I can submit a sealed bid (technical and financial files) and get a cryptographic receipt. Each file is AES-256-GCM encrypted before it reaches FileNet. | Browser, Test |
| 28 | As a competitor or staff member, I cannot read a bid before the recorded opening. A late bid is refused. | Test |
| 29 | As the system, I close submissions automatically at the deadline. | Test |

## 6. Opening, evaluation and award

| # | User story | Verified |
|---|---|---|
| 30 | As the committee chair, I can open the bids only after the deadline. The opening record is generated and stored in FileNet. | Browser, Test |
| 31 | As the chair of a two-envelope tender, I can open the financial envelopes after technical scoring. Bids below the pass mark stay FAILED, and a financial opening record is produced. | Browser, Test |
| 32 | As an evaluator, I score technical criteria only until the financial opening, then all criteria for bids that passed. | Browser, Test |
| 33 | As the chair or an evaluator, I can run the Orchestrate compliance screening (checklist, never scores). | Test; Live IBM |
| 34 | As the chair, I can recommend an award (two-envelope: only after the financial opening, only a passed bid). As the approvers, we approve the award chain level by level, never by the recommender. | Browser, Test |
| 35 | As the chair, I can have Orchestrate draft the committee narrative (EN/AR) and save it to FileNet. Any number not in the scores is rejected. | Test; Live IBM |
| 36 | As an approver, awarding a tender locks its records. With `FILENET_RECORDS_MODE=property` (or `retention`, unconfirmed), the documents are declared records in FileNet. | Browser (lock), Test, Browser (fake FileNet); Live IBM |
| 37 | As staff, I can download the bilingual opening record and committee report. | Browser, Test |

## 7. Document intelligence (every upload)

| # | User story | Verified |
|---|---|---|
| 38 | As a vendor, I upload a document and see "Orchestrate is reading this document…", then its type and a needs-review badge. | Browser (fake), Test; Live IBM |
| 39 | As a vendor or officer, I open "Data" and see each extracted value with the exact quote and section it came from, plus rule checks computed by TenderFlow: expired, expiring within 30 days, company name mismatch, wrong document type, missing required field, currency mismatch. | Browser (fake, EN/AR), Test |
| 40 | As an officer or admin, I review the queue in Procurement → Document intelligence and accept, correct (original and corrected values kept) or reject, all audited. | Browser (fake), Test |
| 41 | As a vendor, I see my verified documents with expiry warnings and get a notification when an accepted document is expired or expiring. | Browser (fake), Test |
| 42 | As an officer, I can create a vendor classification from an accepted MoCI certificate, only after confirming. | Test |
| 43 | As the chair or an evaluator, I see extracted data for bid documents only after opening, and for financial envelopes only after the financial opening. The fake Orchestrate server provably receives no bid text before opening. | Browser (fake), Test |
| 44 | As the chair or an evaluator, I see each bid's extracted total marked "verify against the document"; it is never used for scoring. | Browser (fake), Test |
| 45 | As an officer, I can use accepted GM-letter data to prefill the tender draft. Accepted pack data feeds the pack check. | Built and type-checked |
| 46 | As a reviewer, when I accept extracted data, `TF_DocType`, `TF_ExpiryDate` and `TF_AIReviewed` are written to the FileNet document. If FileNet refuses, the review still succeeds and the error is recorded. | Test (fake FileNet); Live IBM |
| 47 | As anyone uploading while Orchestrate is not connected, my upload still works and the screen says "Orchestrate not connected". Nothing is invented. Scanned images without text are marked "not extractable". | Browser, Test |

## 8. IBM FileNet showcase

| # | User story | Verified |
|---|---|---|
| 48 | As an officer, I can open "FileNet evidence" on any document: object store, object ID, class, folder, version chain, SHA-256, record status, sealed-bid note, repository properties and the Navigator link. | Browser (local and fake FileNet), Test; Live IBM |
| 49 | As a vendor, I can see the evidence for documents I may read, but never for another vendor's bid. | Test, Browser (pack docs) |
| 50 | As any user, I see version (v2, v3…) and "Record" badges in document lists. | Browser |
| 51 | As an admin or auditor, I can open Admin → IBM FileNet: connection, object store, `TF_Document` class, flags, the entity folder tree with counts, document counts, the last 50 FileNet operations with timings, the latest verification report, and "Why FileNet" in EN/AR. | Browser, Test |
| 52 | As Khaled, I can prove versioning and record declaration live with `npm run verify:filenet` (steps 8 and 9) before switching the flags on. | Test (fake); Live IBM |

## 9. watsonx Orchestrate assistant

| # | User story | Verified |
|---|---|---|
| 53 | As any signed-in user, I can ask the TenderFlow Assistant (supervisor agent) "what is waiting for me" or about the tender on screen, and get a cited answer that only uses what my role may see. Sealed bids and other vendors' data are never sent. | Browser (fake, EN/AR), Test; Live IBM |
| 54 | As any user, I see my task list computed by TenderFlow without AI, so it works even when Orchestrate is down. | Browser, Test |
| 55 | As an admin or auditor, I see the AI value meter: runs per kind, failures, accepted/edited/ignored, median time, and drafts people saved. Measured numbers only. | Browser, Test |
| 56 | As Khaled, I can import all ten agents with one script (collaborators first, supervisor last) and check them with `verify:ai` and the Arabic and English eval sets. | Agent YAMLs load in the IBM ADK 2.18.1 loader; scripts dry-run; Live IBM |
| 57 | As an integrator, I have a read-only OpenAPI tool pack so Orchestrate agents can call TenderFlow, once TenderFlow has a public HTTPS address. It is not wired by default. | ADK loader; Live IBM |

## 10. Guided demo and onboarding

| # | User story | Verified |
|---|---|---|
| 58 | As the presenter, I see "Guided demo" only when the server runs with `DEMO_MODE=true`; all demo routes return 404 otherwise. | Browser, Test |
| 59 | As the presenter, I press Go on a chapter to switch persona (real token, audited, same entity only), open the right screen and highlight what to click. There are 13 chapters for `kea`. | Browser, Test |
| 60 | As the presenter, I can expire a published tender's deadline through the real close path. It is labelled as a demo control and audited. | Browser, Test |
| 61 | As the presenter, every chapter shows "Powered by IBM FileNet / watsonx Orchestrate" callouts with live connection status and the newest matching audit evidence. It says "not connected" when that is the case. | Browser |
| 62 | As the presenter, I can switch to the "Same product, different cycle" track for `gcia` and sign out to a pre-filled login (never the password). | Browser |
| 63 | As a presenter in Arabic, the panel is fully RTL. | Browser |
| 64 | As any first-time user of a role (officer, director/undersecretary, chair, evaluator, auditor, admin, vendor), I get a short bilingual tour of my real screens. It is skippable and replayable, starts only on my home screen and never pulls me away from a page I opened. | Browser (officer, vendor, auditor) |
| 65 | As an operator, I can run `npm run demo:reset` (dry run unless `-- --yes`) to start from clean demo data. The append-only audit log rules out an in-app reset. | Command line |

## 11. Security, audit and platform (from rc1, still green)

| # | User story | Verified |
|---|---|---|
| 66 | As any user, I sign in with an RS256 token. Anonymous calls, forged tokens, HS256 tokens and tokens without a tenant are refused. | Test |
| 67 | As an entity, my data is never visible to another entity (the tenant comes only from the token). | Test |
| 68 | As an auditor, I can verify the append-only, HMAC-chained audit trail and see readable bilingual action names. Tampering is detected. | Browser, Test |
| 69 | As an admin, I can manage users and roles. | Browser, Test |
| 70 | As any user, I can use the whole product in Arabic (RTL) or English. | Browser |
| 71 | As an operator, my data survives restarts (embedded PostgreSQL), or I can point TenderFlow at PostgreSQL via `DATABASE_URL`. | Test (embedded); external PostgreSQL not yet run |

## 12. Dashboards

| # | User story | Verified |
|---|---|---|
| 72 | As staff, my dashboard shows "Waiting for my approval" (tenders and requests at my level) and the entity's default cycle. | Browser |
| 73 | As staff, I see live counts: tenders by status, vendors, bids, open clarifications and AI runs. | Browser |

## 13. Integration and correctness fixes made while merging

| # | User story | Verified |
|---|---|---|
| 74 | As an auditor, I land on the audit log after sign-in instead of a page I may not use. | Browser |
| 75 | As an approver of a two-level chain, after approving level 1 I see "waiting for the next level" rather than "approved" or "awarded". | Browser |
| 76 | As an officer, the vendor review screen includes the Orchestrate grade review. | Built and type-checked |
| 77 | As a presenter, the Assistant button no longer covers the Demo Story panel. | Browser (screenshot) |
| 78 | As a tenant admin, publishing a new version of the default template keeps it the default; other templates become default only when asked. | Test |
| 79 | As a user following a link straight to a tender, the first-login tour does not redirect me. | Browser |

## 14. MOI reference configuration and entity policies (from KBM's MOI BRD v0.1)

| # | User story | Verified |
|---|---|---|
| 80 | As a presenter, I can sign in to a third entity, "Ministry of Interior — reference configuration · demo data", configured from the MOI BRD. All its vendors, tenders and people are fictitious. | Test, Browser |
| 81 | As an administrator, I see every entity policy with its BRD reference and a Confirmed / Proposed / Open badge, and can change it. Each change is audited with old and new values. | Test, Browser (EN/AR) |
| 82 | As an administrator, I see each open item from BRD section 15 next to the setting that absorbs it, or a plain "Needs MOI input". | Browser |
| 83 | As an administrator, I can set a cycle's scope to "publication and document sale" (MOI Phase 1). Bidding, opening and award then disappear from that cycle, and the API refuses them with STAGE_NOT_IN_SCOPE. | Test, Browser |
| 84 | As an administrator, I can set a service level in hours for each approval step in the Cycle Designer. | Test, Browser |
| 85 | As an administrator, I can choose whether a tender's grade level means "that grade only" or "that grade and above", and whether grades are company-wide or per activity (BR-007 open questions). | Test |
| 86 | As a vendor, I see only tenders matching my activity and grade. Anything else is "not found" on the list, the tender page and every document download (FR-020, SEC-006). | Test, Browser |
| 87 | As a vendor, I buy tender documents through the TEST gateway and print a receipt numbered in MOI's own series (`MOI-RCPT-…`) that shows the gateway transaction ID (FR-007, FR-022). | Test, Browser (EN/AR) |
| 88 | As an administrator, I can import activity codes from a file, audited (activity code sourcing). | Test |

## 15. Vendor lifecycle

| # | User story | Verified |
|---|---|---|
| 89 | As the grading authority (new role), I review applications in a queue and assign grades per activity or company-wide. Approval issues the vendor's subscription payment link (FR-016, FR-017, NOT-004). | Test, Browser |
| 90 | As a vendor, I pay my annual subscription (TEST gateway) and see its status, end date and receipts. Without a valid subscription I cannot view or buy tenders when the entity requires one (BR-008/009). | Test, Browser |
| 91 | As an administrator, I decide whether vendors keep access to tenders already bought after their subscription expires (BR-010). | Test |
| 92 | As the system, I send each renewal reminder once per threshold (default 30, 7 and 1 days before expiry) and expire subscriptions. This runs as a scheduled job (NOT-001). | Test |
| 93 | As a vendor, I request a grade upgrade with documents. The grading authority approves or declines it (the requester can never decide their own), and I am notified (FR-010, NOT-003). | Test, Browser |
| 94 | As an administrator, I block a vendor for a date range or permanently, with grounds. The vendor cannot sign in and sees "account suspended until …" in Arabic or English. Access returns automatically at the end date, audited (FR-013/014, BR-006, NOT-005). | Test, Browser |
| 95 | As an administrator, I grant fee exemptions per vendor or by vendor category, and manage the categories (FR-018). | Test, Browser |
| 96 | As MOI, I am notified of each new vendor application (NOT-002). | Test |
| 97 | As a presenter, a blocked vendor cannot be used through the demo persona switch either. | Test |

## 16. Identity, access and content protection

| # | User story | Verified |
|---|---|---|
| 98 | As a vendor, I set up two-step verification (TOTP, QR code) and sign in with a code (SEC-005). | Test, Browser (EN/AR) |
| 99 | As a vendor, I can use each of my one-time recovery codes once if I lose my phone. | Test, Browser |
| 100 | As an administrator, I set two-step verification to off, optional or required, separately for vendors and staff. "Required" forces setup at next sign-in. Five wrong codes lock it for 5 minutes. | Test, Browser |
| 101 | As an administrator, I can reset a user's two-step verification (audited). | Test, Browser |
| 102 | As MOI staff, I sign in with Active Directory through OIDC (Entra ID or AD FS). Roles come from my directory groups, and accounts are either created by an administrator first or automatically from groups (INT-004). | Test (local fake provider); Live AD |
| 103 | As an administrator, I configure single sign-on and the group-to-role mapping. The client secret is never shown or stored; only the name of its setting is. | Test, Browser |
| 104 | As an administrator, I limit staff access to listed IP ranges and record whether they mean premises, VPN or both. Vendors are unaffected, and refusals are audited (SEC-003). | Test, Browser |
| 105 | As an administrator, I am warned and must confirm before saving a network list that would lock me out. | Test, Browser |
| 106 | As an administrator, I enable or disable any staff or vendor user, assign roles and see last sign-in. Disabling a user or changing their roles ends their sessions at once (FR-035/036). | Test, Browser |
| 107 | As a vendor, I read tender documents in a protected viewer with my identity watermarked on every page, before and after purchase. Copying and printing are disabled and the page blurs when it loses focus. Every view is audited (SEC-001/002). The viewer says honestly that screenshots cannot be technically prevented. | Test, Browser |
| 108 | As a vendor who has paid, I can download a PDF stamped on every page with my vendor ID, name, time and receipt. The original in FileNet is never changed (FR-023). | Test, Browser |
| 109 | As staff, I always see the original documents. | Test |

## 17. Notifications, service levels and escalation

| # | User story | Verified |
|---|---|---|
| 110 | As an administrator, I edit each notification (including the BRD's NOT-001 to NOT-005) in English and Arabic with a live preview, choose its channels and switch it on or off (audited). | Test, Browser (EN/AR) |
| 111 | As an administrator, I send a template test to myself. | Test, Browser |
| 112 | As an operator, I point TenderFlow at an SMTP server and an HTTP SMS provider. A channel that is not configured is logged as "skipped — not configured", never as "sent". | Test (fake mail and SMS servers); Live provider |
| 113 | As an administrator or auditor, I filter the delivery log and retry failed e-mails or SMS messages. Retries back off exponentially, up to 3 attempts. | Test, Browser |
| 114 | As an administrator, I see the background jobs with their last run, result and errors, and can press "Run now". Only one run of a job happens at a time. | Test, Browser |
| 115 | As an administrator, I set approval service levels: due hours, a reminder before due, and who to escalate to. | Test, Browser |
| 116 | As an approver, I get a reminder before an approval is due. When it is overdue it is escalated once per level, shown as "overdue by …" on the approval chain and the dashboard, and audited. The decision stays with people. | Test, Browser |
| 117 | As the approver of the waiting level, I can reject a tender with a reason. It is cancelled, its creator is notified and the rejection is audited. | Test, Browser |

## 18. Dashboards, analytics, evidence and public board

| # | User story | Verified |
|---|---|---|
| 118 | As any user (officer, director, undersecretary, chair, evaluator, auditor, administrator, vendor), I see a dashboard for my role with real numbers when I sign in (FR-031). | Test, Browser |
| 119 | As a director, undersecretary, administrator or auditor, I see cycle time per stage (median and p90), tenders by status and category, vendor participation, approval turnaround, document sales (TEST payments shown separately), AI usage and stored documents for a date range. Each table can be exported as CSV. | Test, Browser |
| 120 | As an auditor, I generate an evidence pack (ZIP) for a tender or date range. It holds a manifest with FileNet object IDs and SHA-256 hashes, the audit chain slice and its verification, approvals and the documents, with sealed bids excluded before opening. It is stored as a document (in FileNet) and audited. | Test, Browser (hashes checked with `sha256sum -c`); FileNet live |
| 121 | As a member of the public, I browse published tenders across entities at `/tenders` without signing in, filter them, and subscribe by RSS or JSON. Drafts and entities that opted out (MOI by default) never appear, and no private field leaks. | Test, Browser |
| 122 | As an administrator, I switch my entity's public board listing on or off. | Test, Browser |

## 19. Integration fixes (rc3 merge)

| # | User story | Verified |
|---|---|---|
| 123 | As an administrator or auditor, I land on my dashboard after sign-in. | Browser |
| 124 | As a vendor or entity, a KNET payment is never recorded until a real KNET adapter exists (needs the merchant account and spec); the TEST gateway stays clearly labelled. | Test |

## Not yet built (roadmap — needs MOI or third-party access, or after the IBM review)

- KNET payments (needs MOI's merchant account and KNET's integration specification, BRD DEP-004)
- Raslni integration (needs the interface spec from the third-party owner, DEP-002)
- Internal/external zone deployment with push-only replication on OpenShift (SEC-008)
- OCR for scanned images (IBM Datacap or a watsonx.ai vision model)
- PDF reports
- Refunds, contracts and guarantees
- Multi-step upgrade approval (waits on MOI's DEP-003)
- Custom roles defined by an entity
