# Analytics, role dashboards, auditor evidence pack and public tender board

Workstream INSIGHT (Phase 2). Answers MOI BRD FR-031 ("every user of the platform shall be presented a dashboard on
the interface they sign in to"), the open item "audit export for external auditors", and KBM's request to consolidate
and publish tenders across entities (TenderScout).

Every figure on these pages is a query over the entity's own recorded data at the moment the page is opened. Nothing
is estimated, extrapolated or invented; an empty result shows "No data yet". The only cross-entity read in the product
is the public tender board (section 4), which is deliberately narrow.

| What | Where (UI) | API | Roles |
|---|---|---|---|
| Role dashboards | `/procurement` (staff), `/vendor` (vendor), `/admin/overview` (admin, auditor) | `GET /api/v1/insight/dashboard` | any signed-in user; one section per role held |
| Procurement analytics | `/procurement/analytics`, `/admin/analytics` | `GET /api/v1/insight/analytics?from=&to=` | DIRECTOR, UNDERSECRETARY, TENANT_ADMIN, AUDITOR |
| Evidence pack | `/admin/evidence` (`?tenderId=` preselects) | `POST /api/v1/audit/evidence-pack`, `GET /api/v1/audit/evidence-packs`, `GET /api/v1/audit/evidence-packs/:id/download` | AUDITOR, TENANT_ADMIN |
| Public tender board | `/tenders` (no login) | `GET /api/v1/public/tenders`, `.rss`, `.json` | public, rate-limited |
| Board opt-in/out | Admin → Entity settings → "Public tender board" | `PUT /api/v1/entity/profile` (`publicBoard`) | TENANT_ADMIN |

Code: `services/api/src/features/insight.ts` + `services/api/src/features/insight/` (dashboards, analytics, evidence,
public-board, zip), `apps/web/src/features/insight/`, `apps/web/src/locales/insight.ts`, `apps/web/src/styles/insight.css`.
Migration: `services/api/migrations/007_analytics_evidence.sql` (only extends the `documents.owner_type` check with
`EVIDENCE_PACK`; everything else is queries over existing tables). Tests: `services/api/test/insight.test.ts`.

## 1. Role dashboards

`GET /insight/dashboard` returns `{ roles, generatedAt, officer?, approver?, committee?, auditor?, admin?, vendor? }`:
a section is computed only when the caller holds that role, always scoped to the tenant in the token.

| Section | Tiles / lists | Chart |
|---|---|---|
| Procurement officer | my drafts (with pack-document count), clarifications waiting (with age), documents needing review (latest document-intelligence insight `PENDING_REVIEW`), deadlines in the next 14 days (with purchases), approved requests to convert, vendor registrations to review | tenders by stage (bar) |
| Director / undersecretary | items waiting for *my* decision at their next level (tender publication, award, request, gazette/CAPT notice) with level n of m and age; oldest and median wait; published this month (Kuwait calendar month); overdue/escalated count **only when** `GET /approvals/overdue` exists (NOTIFY workstream; a 404/403 hides the tile) | wait per item (bar) |
| Committee chair / evaluator | opening sessions due (chair), financial openings due (two-envelope, chair), awards to recommend (chair), evaluations in progress with phase and score sheets, my scoring progress (evaluator) | score sheets per tender (bar) |
| Auditor | HMAC audit-chain verification (valid / broken at seq), events this month, records declared and in repository, tenders with records locked, AI suggestions accepted/ignored, recent evidence packs | audit events per Kuwait day for 30 days (line), AI runs by review outcome (donut), most frequent actions (bar) |
| Tenant admin | active users, approved/pending vendors, content store reachability (FileNet `ping`, 8 s timeout) with document counts, watsonx Orchestrate status (configured / agents missing / last successful run), published cycle templates and all versions | users by role (donut), vendors by best grade (bar), vendors by status (donut) |
| Vendor | open tenders in my categories with eligibility (reasons when not eligible), document price / purchased, bid submitted; my purchases and receipts (TEST gateway labelled **TEST PAYMENT**); my bids with receipt hash and outcome; documents and classifications expiring within 60 days (expiry dates only from documents the entity *verified*); subscription status **only when** `GET /vendor/me/subscription` exists (MOI workstream) | my bids by outcome (donut) |

Approver items use the same rules as the approve endpoints: role of the next level, never the creator or the award
recommender, never twice in the same round. "Waiting since" is the previous level's decision; for level 1 the later of
creation, last pack upload and last return.

## 2. Procurement analytics

`GET /insight/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD` (Kuwait dates; default the last 365 days; 400 on bad dates).

| Block | Definition |
|---|---|
| Cycle time per stage | From audit-log timestamps per tender: created→approved (last `TENDER_APPROVED`, i.e. after any return), approved→published, published→closed, closed→opened, opened→`AWARD_APPROVED`. A tender counts in the range in which the stage *ended*. n, median, p90 (type-7 quantile, as R/numpy), mean, min, max in days. |
| Tenders by status / category | Tenders created in the range. |
| Vendor participation | Tenders published in the range: eligible vendors (approved, in the category, passing the tender's activity-code + grade rule today), purchases (only for cycles that sell documents; otherwise "n/a", never 0), bids, unique bidders, bids per tender (mean, median); funnel eligible → purchased → bid. |
| Approval turnaround | Per gate (request / publication / award) and level: level 1 from submission (or the last return), each later level from the previous decision. |
| Document sales | Paid purchases by gateway/currency/status. TEST gateway amounts are shown separately as *Simulated* with a TEST PAYMENT badge; real gateways as *Collected*. |
| AI usage | `ai_runs` per kind: total, OK, error, accepted, edited, ignored, unreviewed; document-intelligence review statuses. |
| Stored documents | Count, records and bytes per document type and content store. |

Every table has a **CSV** button (UTF-8 with BOM so Excel shows Arabic; text cells starting with `= + - @` are
prefixed with `'` against spreadsheet formula injection). Charts are plain SVG (`apps/web/src/features/insight/charts.tsx`:
bar, line, donut; no chart library): each is a `<figure>` with an accessible title, native tooltips per mark, direct
value labels and a "Show data table" fallback. Bars mirror in Arabic; time series read left to right in both languages.

## 3. Auditor evidence pack

`POST /audit/evidence-pack` with `{ "tenderId": "…" }` or `{ "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }` (max 366 days)
builds a ZIP (own deflate writer on `node:zlib`, no dependency), stores it with `putDocument` as an `EVIDENCE_PACK`
document (so it lands in IBM FileNet in production, folder `evidence-packs`) and writes `EVIDENCE_PACK_GENERATED`
(pack SHA-256, size, store ref, scope, counts, chain result) in the same transaction as the document row. Downloads
are audited `EVIDENCE_PACK_DOWNLOADED`. Packs never appear through the generic `/documents/:id` route.

| File | Content |
|---|---|
| `manifest.json` | format `tenderflow-evidence-pack/1`, scope, entity, generated at/by, content store, chain result, and **every** document in scope: FileNet object store + object id (or local store ref), folder, version and supersedes, SHA-256 recorded at upload, record status, encrypted-at-rest, `included` + `path`, or `exclusionReason` |
| `audit-events.json` | the audit-event slice (every event about the tender, its documents, bids, publications, opening, award, clarifications, purchases, AI runs, request) in numeric `seq` order with `prev_hmac`/`hmac`, plus the verification of the entity's whole chain and the chain head |
| `approvals.json` | every approval decision and the configured chain per gate |
| `tender.json` / `tenders.json` | tender (public fields + eligibility rule), publications, purchases (`testPayment` flag), bids (status, receipt hash, opening times, technical result; never keys), opening record, award, clarifications |
| `documents/<TYPE>/…` | non-sealed documents: pack, addenda, notices, request letter, opening record, committee report, narratives |
| `bids/<vendor>-<id>/…` | bid documents **only after the opening**; in a two-envelope tender the financial envelope only after the financial opening |
| `SHA256SUMS` | SHA-256 of every other file |
| `README.txt` | how to verify (English + Arabic) |

Exclusion reasons: `SEALED_UNTIL_OPENING`, `FINANCIAL_ENVELOPE_SEALED`, `ENCRYPTED`, `HASH_MISMATCH` (stored bytes do
not match the recorded hash; investigate), `READ_FAILED: …`. If the content store is unreachable the request fails
(`CONTENT_STORE_UNAVAILABLE`); there are no partial packs. Packs are capped at 150 MB of documents (`413 PACK_TOO_LARGE`).

Verifying a pack:

```
unzip evidence-pack-KEA-2026-088-*.zip -d pack && cd pack
sha256sum -c SHA256SUMS              # every line OK
# each manifest document with "included": true: sha256(path) == sha256 (the hash recorded at upload / in the bid receipt)
# FileNet: look up objectId in objectStore and compare TF_Sha256 with sha256
# audit chain: chainVerification.valid; with the signing key, recompute hmac = HMAC-SHA256(key, prev_hmac | canonical JSON)
```

## 4. Public tender board

`/tenders` (no login), `GET /api/v1/public/tenders?entity=&activity=&q=`, RSS 2.0 `…/tenders.rss`, JSON Feed 1.1
`…/tenders.json`. Rate-limited per client IP (`PUBLIC_BOARD_RATE_LIMIT_PER_MIN`, default 60; `429 RATE_LIMITED`),
`Cache-Control: public, max-age=60`.

Lists only tenders in status **PUBLISHED** whose deadline has not passed, of **ACTIVE** entities whose profile
setting `publicBoard` is not `false` (read defensively; unset = on, so kea and gcia are on; the MOI workstream seeds
`moi` with `false` because MOI shows tenders only to eligible vendors). Fields: entity name (EN/AR), tender number,
titles EN/AR, category, activity codes (with names), submission deadline, published at, document price (or free), and
the Kuwait Al-Youm / CAPT publication references. Never documents, descriptions, budgets, internal ids, vendors, bids
or purchases (the test asserts no UUID and no such field appears in the JSON or RSS).

The entity administrator switches it in Admin → Entity settings ("List published tenders on the public board"). A
profile save that does not mention `publicBoard` keeps the current value, so another settings form can never silently
re-publish an entity.

## Configuration

```
# --- insight ---
PUBLIC_BOARD_RATE_LIMIT_PER_MIN=60
```

## Verification status

| Item | Status |
|---|---|
| Dashboards per role, analytics figures, evidence pack contents/hashes/access/sealing, board filters/feeds/privacy/rate limit | automated (`services/api/test/insight.test.ts`, 9 tests) |
| Each kea demo user's dashboard, analytics charts + CSV, evidence pack generated in the UI for KEA-2026-088 then unzipped and checked with `sha256sum -c`, public board without login, board toggle round trip | browser (Playwright, EN + AR) |
| Evidence pack stored in a live IBM FileNet object store | needs live system (uses the same `putDocument` path as every other document; tested against the filesystem store) |
| Overdue approvals tile, vendor subscription tile | appear only once the NOTIFY / MOI endpoints are merged |
