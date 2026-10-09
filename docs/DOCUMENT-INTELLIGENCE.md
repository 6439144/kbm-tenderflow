# Document intelligence — every upload classified, its data extracted and cited, a person decides

> Requirement (Khaled, product owner): "Vendors, bidders, admins and procurement users all upload files. Using
> watsonx Orchestrate, files should be classified and data extracted from them."

**IBM FileNet stores the file. IBM watsonx Orchestrate understands it. TenderFlow enforces the rules.**
Each uploaded document is classified against the entity's own document-type catalogue, and its key fields are
extracted with a citation (section and exact quote) by the Orchestrate agent `tenderflow_document_intelligence`.
TenderFlow validates every value against the text it sent, computes rule-based flags, and shows the result to a
reviewer who accepts, corrects or rejects it. Only accepted data is used, and a person confirms every use.

## Flow

```
 upload (vendor / officer / GM letter)          bid opening (chair)            financial opening (chair, two envelopes)
        │ stored in FileNet (TF_Document)              │ bids OPENED                       │ financial envelopes of PASSED bids
        ▼                                              ▼                                   ▼
 document event ──► in-process queue (never blocks or fails the upload; one job at a time)
        │   only if Orchestrate is configured AND auto is on (template cfg.ai.documentIntelligence / entity setting / DOC_AI_AUTO)
        ▼
 text extraction (PDF pages, DOCX headings, TXT/MD)   ── no text layer (scan/image) ──► NOT_EXTRACTABLE (no AI call)
        ▼
 catalogue for the upload context (VENDOR, TENDER_PACK, ADDENDUM, REQUEST_LETTER, BID_TECHNICAL, BID_FINANCIAL, ENTITY)
        ▼
 Orchestrate run: tenderflow_document_intelligence   (prompt = context + catalogue + [DOC id | title | section] text)
        ▼
 TenderFlow validation  ── invalid ──► one repair turn on the same thread ── still invalid ──► FAILED (error kept)
        ▼
 insight PENDING_REVIEW  + rule-based flags (computed by TenderFlow, not the AI)  + ai_run + audit
        ▼
 reviewer: ACCEPT / CORRECT (both AI and corrected values kept) / REJECT (reason required)   ── audited
        ▼
 accepted data at work: verified vendor documents · classification prefill (officer confirms) · extracted bid totals
 ("verify against the document", never scores) · GM-letter prefill for the tender draft · pack-check context ·
 FileNet properties TF_DocType / TF_ExpiryDate / TF_AIReviewed · vendor expiry notification
```

Manual runs: "Classify with Orchestrate" in the Data panel (staff on any document they may read; a vendor on their
own company documents) — `POST /api/v1/documents/:id/ai/classify`.

## Catalogue (per entity, `document_types`)

Installed with defaults for every tenant (also for tenants created before migration 003, on first use) and edited
by TENANT_ADMIN in **Admin → Document types** (`GET/POST/PATCH /api/v1/document-types`). Each type has a code,
EN/AR names, the upload contexts it is offered in, and fields `{key, labelEn, labelAr, type: text|date|amount|number|list, required}`.

| Code | Contexts | Fields (* required) |
|---|---|---|
| COMMERCIAL_REGISTRATION | VENDOR, BID_TECHNICAL | crNumber*, companyName*, issueDate, expiryDate*, activities |
| MOCI_CLASSIFICATION_CERT | VENDOR, BID_TECHNICAL | activityCodes*, grade*, expiryDate* |
| CHAMBER_OF_COMMERCE_CERT | VENDOR, BID_TECHNICAL | membershipNumber*, expiryDate* |
| BANK_GUARANTEE | VENDOR, BID_TECHNICAL, BID_FINANCIAL | bank*, amount*, currency, validUntil*, beneficiary |
| ISO_CERTIFICATE | VENDOR, BID_TECHNICAL | standard*, certificationBody, expiryDate* |
| COMPANY_PROFILE | VENDOR, BID_TECHNICAL | yearsInBusiness, keyClients |
| TECHNICAL_PROPOSAL | BID_TECHNICAL | deliveryPeriod, warrantyPeriod, keyPersonnel |
| FINANCIAL_PROPOSAL | BID_FINANCIAL | totalAmount*, currency, validityDays, paymentTerms |
| TENDER_PACK | TENDER_PACK, ADDENDUM | submissionDeadline, bidBondAmount, bidValidityDays, evaluationCriteria |
| ADDENDUM | ADDENDUM, TENDER_PACK | changesSummary, newDeadline |
| GM_LETTER | REQUEST_LETTER, ENTITY | department*, subject*, estimatedBudget, letterDate, referenceNumber |
| OTHER | all | — (fallback; cannot be deactivated) |

Personal identity numbers are never extracted: the agent instructions forbid it and the catalogue API refuses any
field whose key or label is a civil ID / passport / national ID (`400 PERSONAL_DATA_FIELD`).

## What TenderFlow validates (services/api/src/ai/parse.ts → `validateDocumentInsight`)

- `docType` is a code of the catalogue sent for that context, or `OTHER` (no fields for OTHER).
- every field key is defined for that type; every field cites a section of **this** document and a quote that
  occurs in that section (normalised for Arabic letter variants, diacritics and Arabic-Indic digits);
- text values must appear in the cited section; list items too; numbers and amounts must appear in the quote;
- dates are normalised to ISO `YYYY-MM-DD` (ISO, day-first `DD/MM/YYYY`, English/Arabic month names, Arabic-Indic
  digits; Hijri dates are never converted); amounts become `{amount, currency}` (KWD, USD, SAR, …);
- summaries in English and Arabic; any number in them must occur in the document.
Anything else is a problem → one repair turn → otherwise the run is stored as FAILED with the reason.

## The sealed-bid rule

Bid files are AES-256-GCM encrypted until the opening. Document intelligence never changes that:
- bid uploads emit no event; nothing is queued at submission;
- `BID_TECHNICAL` (and, for one-envelope tenders, `BID_FINANCIAL`) are queued when the chair opens the bids;
- in two-envelope tenders `BID_FINANCIAL` is queued only when the chair opens the financial envelopes, and only for
  the bids that passed; failed bids' financial envelopes stay sealed and are never read;
- the decryption path inside document intelligence re-checks the rule (defence in depth): a sealed document gives
  `403 BID_SEALED` / `403 FINANCIAL_SEALED` whoever asks;
- bid-document insights are visible to the chair, evaluators, director and undersecretary only (the bid read rule);
  reviewed by the chair or an evaluator; vendors never see them.
Proven in `services/api/test/document-intelligence.test.ts`: the fake Orchestrate server receives no prompt containing
bid text before the opening, receives the technical text at the opening and the financial text only after the
financial opening.

## Rule-based flags (TenderFlow, not the AI)

Computed from the extracted or corrected values every time the insight is read (so "today" is always today):

| Flag | Rule |
|---|---|
| EXPIRED | `expiryDate` / `validUntil` before today |
| EXPIRING_SOON | within 30 days |
| NAME_MISMATCH | `companyName` differs from the vendor's registered EN and AR legal names (legal forms such as W.L.L. / ذ.م.م and "(fictitious)" ignored) |
| TYPE_MISMATCH | the type differs from what the uploader chose: financial envelope → FINANCIAL_PROPOSAL, request letter → GM_LETTER, otherwise the title they typed (catalogue names and common aliases, whole words) |
| REQUIRED_MISSING | a required catalogue field was not found |
| CURRENCY_MISMATCH | FINANCIAL_PROPOSAL currency differs from the tender currency |

When an accepted vendor document is expired or expiring, the vendor gets an in-app notification (audited).

## Review and effects

- Reviewers: PROCUREMENT_OFFICER, TENANT_ADMIN (non-bid documents); COMMITTEE_CHAIR, EVALUATOR (bid documents after
  opening). `POST /api/v1/document-insights/:id/review {decision: ACCEPT|CORRECT|REJECT, fields?, docType?, reason?}`.
- **Verified documents**: vendor home "My documents — verified data"; vendor detail (staff) "Verified documents".
- **MOCI classification certificate** → "Create classification from this certificate": activity codes, grade and
  validity pre-filled; the officer confirms; saved through the existing eligibility service
  (`POST /document-insights/:id/apply-classification {confirm: true, activityCode, grade, validUntil}`), audited twice
  (`VENDOR_CLASSIFICATION_SET`, `DOCUMENT_INSIGHT_APPLIED`). The classifications editor refreshes.
- **FINANCIAL_PROPOSAL** → tender page "Financial totals extracted by Orchestrate — verify against the document. Never
  used for scoring." (`GET /tenders/:id/extracted-totals`, bid readers only).
- **GM_LETTER** (accepted) → request page "From the GM letter (accepted)" → "Use as prefill" fills the convert form
  title and passes the estimated budget.
- **TENDER_PACK / ADDENDUM** (accepted) → added as a "reviewed document data" context document to the pack check.
- **FileNet properties** (see below).

## FileNet properties

When `FILENET_AI_PROPERTIES=true` (and, for FileNet, `FILENET_DOC_CLASS=TF_Document` with the templates of
[ACCE-RUNBOOK §1c](filenet/ACCE-RUNBOOK.md)), acceptance writes `TF_DocType` (string), `TF_ExpiryDate` (date, when
present) and `TF_AIReviewed` (boolean) through `ContentStore.setProperties` (FileNet: `updateDocument`, the mutation
the records `property` mode uses, with read-back). A refusal never fails the review: the error is stored on the insight,
shown in the Data panel and audited (`DOCUMENT_PROPERTIES_FAILED`). The filesystem store records the values in the
object's sidecar and `documents.store_meta.aiProperties` (development only).

## API

| Route | Who |
|---|---|
| `POST /api/v1/documents/:id/ai/classify` | staff on documents they may read; vendor on own company documents. 503 `AI_NOT_CONFIGURED` when Orchestrate is not configured (no insight row) |
| `GET /api/v1/documents/:id/insight` | same rule as reading the document → `{configured, classifiable, queued, canClassify, insight}` |
| `GET /api/v1/document-insights/latest?documentIds=a,b` | batch for document lists (unreadable documents left out) |
| `GET /api/v1/document-insights?status=&ownerType=&docType=` | staff queue (latest result per document; bid documents only for bid readers) |
| `POST /api/v1/document-insights/:id/review` | reviewers above |
| `POST /api/v1/document-insights/:id/apply-classification` | PROCUREMENT_OFFICER, TENANT_ADMIN |
| `GET /api/v1/vendor/me/verified-documents` · `GET /api/v1/vendors/:id/verified-documents` | vendor (own) · staff |
| `GET /api/v1/tenders/:id/extracted-totals` | chair, evaluators, director, undersecretary |
| `GET/POST/PATCH /api/v1/document-types` | staff read; TENANT_ADMIN writes |

Data: migration `003_document_intelligence.sql` (`document_types`, `document_insights`, ai_runs kind
`DOCUMENT_INTELLIGENCE`). Every run, review, applied effect and property write is audited.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `WXO_AGENT_DOCUMENT_INTELLIGENCE` | `tenderflow_document_intelligence` | agent name or id |
| `DOC_AI_AUTO` | empty | `true`: vendor and request-letter uploads are also classified automatically (the entity setting in Admin → Document types wins); `false`: never automatic; empty: tender documents per template, vendor/letters per entity setting (off by default) |
| cycle template `ai.documentIntelligence` | `true` | automatic runs for that tender's documents (pack, addenda, bids at opening) — Cycle Designer → AI |
| `FILENET_AI_PROPERTIES` | `false` | write the three properties on acceptance |

## Web

- Every document list: badge per row ("Commercial registration · needs review / accepted / not extractable /
  Orchestrate not connected") + flag chips, a **Data** button (fields with quote + section, flags, EN/AR summary,
  "Powered by IBM watsonx Orchestrate · stored in IBM FileNet" with agent / model / run id, Accept / Correct (inline)
  / Reject, "Classify with Orchestrate"); after an upload "Orchestrate is reading this document…" with polling for
  up to 45 s, then the outcome or "check back later".
- Opened bids: badge + Data per envelope; "Financial totals extracted by Orchestrate".
- **Procurement → Document intelligence** (`/procurement/documents`, also Admin → Document intelligence): queue with
  counts per status, filters (status, uploaded as, type) and links to the vendor / tender / request.
- **Admin → Document types** (`/admin/document-types`): catalogue editor + the entity auto-classification setting.
- Demo Story: chapter 2 of the KEA track ("A vendor uploads a commercial registration; Orchestrate reads it; the
  officer accepts it") and an officer tour step on the new navigation link.

## Verified vs built

| What | Status |
|---|---|
| Validation, repair, sealed-bid rule, two envelopes, access rules, review, flags, notifications, apply classification, template toggle, `DOC_AI_AUTO=false`, not-configured 503, NOT_EXTRACTABLE | API tests against the **fake** Orchestrate server (`test/document-intelligence.test.ts`, 15 tests) and unit tests (`src/ai/docintel.test.ts`) |
| FileNet property write + refusal recorded | API test against the **fake** Content Services server |
| UI: upload → reading → classified → Data panel → officer correct/accept → vendor verified data + expiry flag; admin catalogue; chair before/after opening; EN + AR | Browser (Chromium) against the app with the **fake** Orchestrate (every free-text reply marked `[FAKE ORCHESTRATE]`) and with no Orchestrate ("not connected") |
| The real agent on the TechZone instance (import, prompt quality, Arabic) | **Not verified live** — TechZone is not reachable from the build sandbox |
| FileNet `updateDocument` with Date Time / Boolean literals on OS1 | **Not verified live** (ASSUMED literal form) |
| OCR for scanned images | Not built: NOT_EXTRACTABLE with the roadmap message (IBM Datacap or a watsonx.ai vision model) |

## Verify on Windows (TechZone access)

```powershell
# 1. Import the agents (now ten; tenderflow_document_intelligence before the supervisor)
powershell -ExecutionPolicy Bypass -File agents\import.ps1
# 2. Live check: IAM, all ten agents, a clarification, a supervisor turn and a document-intelligence run on a CR sample
npm run verify:ai
# 3. Eval set (8 EN/AR cases: CR, MOCI certificate, bank guarantee, financial proposal, GM letter, OTHER)
npm run evals -- agents        # writes agents/evals/agents/results.md
# 4. FileNet properties: create TF_ExpiryDate + TF_AIReviewed (docs/filenet/ACCE-RUNBOOK.md §1c), then in .env
#    FILENET_DOC_CLASS=TF_Document  FILENET_AI_PROPERTIES=true  DOC_AI_AUTO=true
npm run build; npm start
# 5. As vendor1 upload a CR (PDF with a text layer); as officer open Procurement → Document intelligence, accept;
#    open the document's "FileNet evidence" — the TF_DocType / TF_ExpiryDate / TF_AIReviewed properties are listed
#    there and in IBM Content Navigator.
```
