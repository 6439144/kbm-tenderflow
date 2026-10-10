# Low-code Process Studio

The Process Studio (`Admin → Process Studio`, `/admin/studio`) lets each government entity customise its procurement process **without code**.
Everything is configuration that the server validates, versions and audits. The integrity controls of the tender cycle stay fixed.

## What an entity can customise

| Building block | What it does | Where it applies |
|---|---|---|
| **Custom forms** | Extra fields on the tender, departmental-request and vendor-registration forms. Field types: text, long text, number, amount, percentage, date, choice, multiple choice, yes/no, e-mail, phone, web address, and **calculated** fields (for example `round(budget * bidBondPercent / 100, 3)`). Each field can be required (when saving, or only before submission for approval), public or internal, limited by min, max, length or a format (IBAN, civil ID, CR number…), and shown only when another field has a given value. | New tender / edit tender, vendor self-registration (public fields), staff vendor review (internal fields), departmental requests |
| **Gate rules** (⛔) | Run *inside* a step: they can **stop** the step with a bilingual message, **require** custom fields or pack documents, or **add approval levels** (conditional routing). | Submission for approval, publication, award recommendation |
| **Event rules** (⚡) | Run right *after* a step is committed: they can **notify** a role, the creator or the vendor; **create a task** (optionally one that must be done before publication or the award recommendation); **call an integration** (webhook); or **set a custom field**. | Tender created / approved / returned / published / closed / cancelled, addendum, clarification, bids opened, award recommended / approved, vendor registered / decided, vendor document, request submitted |
| **Schedule rules** (⏰) | Run on a timer, once per tender. | Submission deadline approaching (N hours before) |
| **Integrations** | Signed JSON events (HMAC-SHA256) to ERP, finance, document management or IBM App Connect, with retries and a delivery log. | Any event, by subscription or from a rule |
| **Packages** | Export an entity's process (cycle templates, forms, rules, integrations — never secrets) and import it into another entity as drafts. | Rolling a reference configuration out to a new entity |

Conditions are built visually: *field* · *operator* · *value*, grouped with **all of** / **any of** (nested up to 4 levels, 25 tests per rule).
Facts include budget, category, cycle template, envelopes, days until deadline, pack/addenda/clarification counts, minimum grade, award bid
count, recommended bid's score and rank, vendor status, categories and grade, request budget, department and source, document kind, size and type,
the acting user's roles, and **every custom field**.

## Guided experience (rc6)

Since rc6 both configuration screens guide an administrator who is not a technical user. All of it is in Arabic and English
(right-to-left included) and uses the existing APIs only; the server still validates everything on save, check and publish.

**Cycle Designer** (`Admin → Cycle Designer`)

| Aid | What it does |
|---|---|
| **New-template wizard** | Six short steps: 1 start from a starter template, a copy of one of the entity's templates, or blank · 2 envelopes and pass mark · 3 approvals (presets, due times in days + hours) · 4 stages as on/off cards · 5 eligibility and fees · 6 review with the plain-language summary, the stage strip and the server's validation. The result is a **draft**. |
| **In plain words** | A live summary of the template as sentences ("Before publication the tender is approved by …. The person who drafted it can never approve it."). |
| **Stage strip** | Click a stage to jump to the settings card that shapes it. |
| **Inline validation** | The server's message is shown next to the card it concerns (friendly bilingual text plus the server's own words), with a "jump to" list; the sticky action bar counts the problems. |
| **Unsaved-changes guard** | Warns before closing the tab, following an in-app link or switching template with unsaved edits. |
| **Compare with live version** | A table of what the draft changes against the published version. |
| **Approval chains** | Level cards that can be dragged into order (the ↑/↓ buttons still work), quick presets; labels in an optional disclosure. |

**Process Studio** (`Admin → Process Studio`)

| Aid | What it does |
|---|---|
| **Rule recipes** | "New rule" (and "Add rule here" on the process map) opens a gallery: extra approval above an amount · require a field when… · require a document before publication · minimum bidding days · remind before the deadline · notify a role when… · task that must be done before award · call an integration when… · blank rule. Recipes are built from the server catalogue; one that needs a published tender field or an integration the entity does not have is shown disabled with the reason. |
| **Step-by-step rule editor** | 1 When → 2 If → 3 Then → 4 Name & review. The plain-language sentence is always visible, and the review shows the rule in both languages. Triggers are grouped as gate / event / schedule; the fact picker is searchable with descriptions; value inputs match the fact (choices, amount with currency, days, yes/no, roles); operators use everyday words. Obvious mistakes are flagged before saving. |
| **Rules list** | Search; filter by gate / event / schedule and on / off; "where it applies" chips (kind, stage, object); delete with **Undo**. |
| **Form builder** | Field-type palette with icons and descriptions; drag-and-drop ordering (↑/↓ kept); camelCase keys generated from the English label (locked once published); calculated-field helper that inserts fields, operators and functions, checks completeness and shows a live result; live preview side by side. |

**On both pages:** a **Help** drawer with a searchable glossary, and a dismissible **Getting started** checklist (Cycle
Designer: have a template → create one with the wizard → read the summary → publish a default; Process Studio: look at the
process map → add form fields → add a rule from a recipe → try the simulator → publish). Steps are ticked from real data
where available; hiding the checklist is remembered in that browser only.

Limits: the unsaved-changes guard does not catch the browser **Back** button; the wizard's starter templates are client-side
copies of the server's starter settings (kept in step by hand, still validated by the server).

## Describe it instead of building it — AI builder (rc6)

Administrators can also describe a change in plain language (Arabic or English) and let the watsonx Orchestrate agent
`tenderflow_admin_builder` prepare it: in **Admin → AI builder**, or with the **Describe a change** button in the Cycle
Designer and Process Studio headers. The agent proposes forms, form fields, rules, cycle templates and document types; the
server validates every operation with the same validators as these screens and shows each one as a bilingual sentence with
its exact changes. **Create drafts** creates drafts only — publishing (and four-eyes) stays as described below, and the
locked controls cannot be touched. Notification templates, users and roles are not covered. Details:
[ADMIN-AI-BUILDER.md](ADMIN-AI-BUILDER.md).

## What can never be changed (locked controls)

- Bids are encrypted (AES-256-GCM) until the opening; no fact, message or webhook can contain bid prices, files or bidder identities before opening.
- Only the committee chair opens, only after the deadline.
- The creator can never approve; one person can approve only one level; the recommender can never approve the award.
- Every action is in the HMAC-chained, append-only audit trail.

Rules can only **add** controls (an approval level, a block, a requirement, a task). There is no action that removes an approval, skips a stage,
opens a bid or edits the audit trail. The server rejects any rule that tries, with a clear reason (for example "events cannot block or add approvers — use a gate trigger").

## Lifecycle and governance

1. **Draft** — the administrator clicks *Edit (new draft)*. Only one draft per form / rule set is open at a time.
2. **Check** — the server validates the draft against the entity's live forms and integrations, and lists errors and warnings (for example a rule that blocks every tender).
3. **Simulate** — run the draft against sample values or a real tender and see which rules fire, the resulting approval chain and whether the step would be stopped.
4. **Publish** — the previous version is retired and kept for the record. With **four-eyes on configuration** (`configFourEyes` in the entity profile), the last editor of a draft cannot publish it.
5. **Pinning** — a new tender pins the tender-form version and the gate rules that were live when it was created. Later changes never alter a running tender
   (event automations always use the live rule set).
6. **History** — every version, with the rules/fields added, removed and changed, is visible to administrators and auditors.

Every step is audited: `LOWCODE_DRAFT_CREATED`, `LOWCODE_DRAFT_UPDATED`, `LOWCODE_DRAFT_DISCARDED`, `LOWCODE_PUBLISHED`, `LOWCODE_GATE_BLOCKED`,
`LOWCODE_TASK_CREATED/COMPLETED/CANCELLED`, `LOWCODE_FIELD_SET`, `VENDOR_CUSTOM_FIELDS_UPDATED`, `WEBHOOK_CREATED/UPDATED/SECRET_ROTATED/TEST_SENT/DELIVERY_REQUEUED`,
`LOWCODE_PACKAGE_EXPORTED/IMPORTED`.

## How it works (architecture)

- **Definitions** — `lowcode_definitions` (kind `FORM` with code `TENDER`/`REQUEST`/`VENDOR`, or kind `RULESET` with code `PROCESS`), versioned DRAFT → PUBLISHED → RETIRED.
- **No code is executed.** Conditions are a JSON tree evaluated by a small interpreter; calculated fields use a safe arithmetic grammar (numbers, + − × ÷, parentheses, `min`, `max`, `round`, `abs`, field names). There is no `eval`.
- **Gates** are evaluated before the transition's transaction (`lowcode/gates.ts`). A stop is logged, audited and returned as `409 PROCESS_RULE_BLOCKED` with bilingual reasons. Approval levels added by routing rules are stored on the tender (`tenders.routing`) and merged into its chain, so the approval screens, reminders/escalation, dashboards and evidence pack all see them.
- **Events** are read from the committed audit trail by the `lowcode-automation` background job, from a per-entity cursor, one event per transaction together with the cursor move. An automation can therefore never slow down, fail or roll back the user's action, nothing is lost across a restart, and history is never replayed when rules are first published.
- **Webhooks** — `webhook-deliveries` job; retries after 1 min, 5 min, 30 min and 2 h, then `DEAD`. https only (http only outside production with `LOWCODE_WEBHOOK_ALLOW_HTTP=true`); private, loopback and link-local targets are refused at registration and again at send time (`LOWCODE_WEBHOOK_ALLOW_PRIVATE=true` is for tests only, ignored in production); redirects are not followed. The signing secret is stored encrypted (AES-256-GCM) and shown only once.
  Receivers verify `X-TenderFlow-Signature: t=<unix time>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`.
- **Custom values** are validated by the server against the pinned form version; calculated values are computed by the server, and internal fields never reach vendors.

## API (summary)

| Method | Path | Who |
|---|---|---|
| GET | `/api/v1/lowcode/catalog` | staff |
| GET/POST/PATCH/DELETE | `/api/v1/lowcode/definitions[/:id]`, `POST …/:id/publish`, `POST /lowcode/check`, `GET /lowcode/history/:kind/:code` | admin (auditor read) |
| POST | `/api/v1/lowcode/simulate` · GET `/lowcode/process-map` · GET `/lowcode/runs` · POST `/lowcode/run-now` | admin/auditor |
| GET | `/api/v1/lowcode/forms/:code` · `/api/v1/public/forms/vendor?tenant=` | staff / public (public fields) |
| GET | `/api/v1/tenders/:id/process` | staff (full) / vendor (public values) |
| GET/POST | `/api/v1/lowcode/tasks`, `…/:id/complete`, `…/:id/cancel` | assigned role / admin |
| GET/POST/PATCH | `/api/v1/lowcode/webhooks[/:id]`, `…/rotate-secret`, `…/test`, `/lowcode/webhook-deliveries[/:id/retry]` | admin (auditor read) |
| GET/POST | `/api/v1/lowcode/package`, `…/preview`, `…/import` (`confirm: true`) | admin |
| PATCH | `/api/v1/vendors/:id/custom-fields` | officer, admin, grading authority |

Settings: `LOWCODE_AUTOMATION_MS` (default 5000), `LOWCODE_WEBHOOK_MS` (10000), `LOWCODE_WEBHOOK_TIMEOUT_MS` (8000), `LOWCODE_WEBHOOK_ALLOW_HTTP`, `LOWCODE_WEBHOOK_ALLOW_PRIVATE`.

## Demo content (fictitious)

**KEA** has tender, vendor and request forms and eight rules:
- tenders above 500,000 KWD get an Undersecretary approval;
- strategic projects must state local content;
- grant-funded tenders need 14 days to bid;
- a security-clearance task blocks the award recommendation;
- recommending a bid that is not the top-scored adds an approval level;
- the director is told about clarifications on large tenders;
- new vendors get a 2-day review task;
- officers are reminded 48 hours before a deadline.

The draft tender KEA-2026-101 shows a gate that is not ready: the budget line and minimum local content are missing.

**MOI** (reference configuration) has request and tender fields:
- classified tenders get an Undersecretary approval;
- IT requests create a technical-review task.
