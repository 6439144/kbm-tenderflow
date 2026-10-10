# TenderFlow v1.0.0-rc6 — release notes (10 Oct 2026)

rc6 makes TenderFlow easier to configure and sells it the way government entities buy it. It adds three things:

1. **Easier configuration** in the Cycle Designer and the Process Studio: guided set-up, ready-made rules, plain-language explanations and drag-and-drop.
2. **AI admin builder:** an administrator describes a change in Arabic or English, and a watsonx Orchestrate agent prepares it as drafts. A person still reviews and publishes every change.
3. **Dedicated entity edition:** each government entity gets its own installation, with its own data, committees, suppliers and branding.

The user stories are in [USER-STORIES.md](USER-STORIES.md): 189 stories, of which 156–189 are new. The notes for [rc5](release-notes-v1.0.0-rc5.md) and [rc3](release-notes-v1.0.0-rc3.md) still apply.

## What is new — for procurement teams

### 1. Configuring the tender cycle and the process is easier
Admin → Cycle Designer and Admin → Process Studio. Full detail: [LOW-CODE-STUDIO.md](LOW-CODE-STUDIO.md#guided-experience-rc6).

- **New-template wizard.** Six short steps create a new tender cycle:
  1. Choose a starting point: a ready-made starter, a copy of one of the entity's templates, or a blank template.
  2. Envelopes and pass mark.
  3. Approvals, with presets and due times in days and hours.
  4. Stages, switched on or off as cards.
  5. Eligibility and fees.
  6. A review that shows the server's validation result.

  The wizard always ends as a **draft**. Nothing goes live until someone publishes it.
- **The cycle in plain words.** A live summary of the template as sentences, for example "Bids are sealed in two envelopes. Only bids scoring at least 70 out of 100 in the technical evaluation have their price opened."
- **Easier to navigate and check:**
  - Click a stage in the stage strip to jump to its settings.
  - Problems are shown next to the setting they concern, with a "jump to" list.
  - The action bar stays visible and counts the problems.
- **Fewer mistakes:**
  - TenderFlow warns before you leave with unsaved changes.
  - **Compare with live version** shows exactly what a draft changes.
- **Approval chains:** drag and drop to reorder the levels (the keyboard buttons still work), and use quick presets.
- **Rule recipes.** "New rule" opens a gallery of common needs, for example:
  - an extra approval above an amount;
  - require a field when…;
  - require a document before publication;
  - minimum bidding days;
  - a reminder before the deadline;
  - notify a role;
  - a task that must be done before award;
  - call another system.

  Recipes are built only from what the entity actually has. A recipe that needs something missing is shown greyed out, with the reason.
- **Step-by-step rule editor** with four steps: *When → If → Then → Name & review*.
  - The rule is always shown as a sentence, and as both English and Arabic sentences at review.
  - You search for a field instead of scrolling a long list.
  - Each value is entered in the way that suits its field: a choice, an amount, days, yes/no or a role.
- **Rules list:** search, filters (gate / event / schedule, on / off), "where it applies" chips, and **Undo** after a delete.
- **Form builder:**
  - a palette of field types, with descriptions;
  - drag-and-drop field order;
  - field keys generated from the English label;
  - a formula helper for calculated fields that shows the result live.
- **Help everywhere:** a Help drawer with a glossary, and a getting-started checklist on both pages. Everything is in Arabic and English, right-to-left included.

### 2. AI admin builder — "describe a change"
Admin → AI builder, and the **Describe a change** button in the Cycle Designer and Process Studio headers. Full detail: [ADMIN-AI-BUILDER.md](ADMIN-AI-BUILDER.md).

- The administrator writes the change in Arabic or English, for example:
  - "Tenders above 1,000,000 KWD need the Undersecretary"
  - "Add a required Project code field"
  - "Remind officers 72 hours before the deadline"

  The watsonx Orchestrate agent **`tenderflow_admin_builder`** turns the request into a **change proposal**.
- TenderFlow checks every proposed change with the **same rules as the screens**. It then shows each change:
  - as a sentence in English and Arabic, written by TenderFlow and not by the AI;
  - with a valid / not valid badge and the reasons;
  - with the exact before/after values.
- Follow-ups such as "make it 2 million instead" revise the same proposal.
- **Create drafts** creates drafts only. Publishing stays a separate human step, and four-eyes applies when the entity has switched it on.
- The integrity controls cannot be changed by the AI or by anyone else:
  - sealed bids;
  - only the chair opens, and only after the deadline;
  - the approver is never the creator;
  - the recommender never approves the award;
  - the audit trail.
- Requests about users, roles, tenders, bids, notification texts or entity settings get an explanation of where that is done, and no changes.
- Every proposal, apply and discard is in the audit trail.
- Only an entity administrator can apply a proposal. Auditors can read proposals. Another entity never sees them.
- If Orchestrate is not connected, the page says so. TenderFlow never invents a proposal.

### 3. One installation per government entity
Full detail: [DEPLOYMENT-MODEL.md](DEPLOYMENT-MODEL.md).

- TenderFlow is sold to each government entity separately, and each entity works separately from the others. A **dedicated installation**, now the default, serves exactly one entity. That entity has its own:
  - database and FileNet object store (or root folder);
  - watsonx Orchestrate instance;
  - keys and audit chain;
  - committees and suppliers;
  - branding.
- **Sign-in and supplier registration** have no entity picker. The header shows the entity's name, logo text and colour.
- **The public tender board** is titled "Public tenders of &lt;entity&gt;" and shows only that entity's tenders.
- **Other entities are invisible.** Any request for another entity is answered "Entity not found", whether or not that entity exists. Tokens for another entity are refused.
- **Suppliers register with each entity** they want to work with, and the registration page says so.
- **Background jobs** work only on the installation's entity.
- **KBM's three-entity demo** (KEA, GCIA, MOI side by side) remains available as `TENANCY_MODE=shared`.

## Technical notes

- **Usability (web only).** These changes are in `apps/web` and use the existing APIs only (`createTemplate`, `validateTemplate`, low-code definitions, check and simulate). The server still validates everything on save, check and publish.
  - Shared UX kit in `apps/web/src/components/ux.tsx`: help drawer, checklist, unsaved-changes guard, drag ordering, duration input, step navigation.
  - New strings in `locales/ux.ts`; styles in `styles/ux.css` (logical properties, so right-to-left works).
  - Screenshot harness: `scripts/dev/designer-shots.mts`.
- **AI admin builder.**
  - API: `/api/v1/admin-agent/{status, chat, proposals, proposals/:id, proposals/:id/apply, proposals/:id/discard}`.
  - **Operations (nine):** `CREATE_TEMPLATE`, `NEW_TEMPLATE_VERSION`, `ADD_RULE`, `UPDATE_RULE`, `SET_RULE_ENABLED`, `ADD_FORM_SECTION`, `ADD_FORM_FIELD`, `UPDATE_FORM_FIELD`, `ADD_DOCUMENT_TYPE` (created switched off).
  - **Validation:** `parseConfig`, `validateFormDefinition`, `validateRuleset` and the document-type parsers, run against the entity's current configuration. The proposal is validated again inside the apply transaction.
  - **Apply:** one transaction, idempotent. A second apply returns 409 `PROPOSAL_ALREADY_APPLIED`; a proposal that is no longer valid returns 409 `PROPOSAL_INVALID`.
  - **Strict JSON contract:** the agent gets one repair turn on the same thread, then 502 `AI_ERROR`.
  - **Not connected:** 503 `AI_NOT_CONFIGURED` / `AI_AGENT_NOT_IMPORTED`.
  - The draft writers are now transaction-scoped (`insertTemplateDraft`, `updateTemplateDraft`, `insertDraft`, `saveDraft`, `insertDocumentType`), with unchanged behaviour and audit events.
  - **Orchestrate tool pack** `agents/tools/tenderflow-admin.openapi.yaml`: `submit_admin_proposal` / `get_admin_proposal`, with no apply or publish tool.
  - Audit: `ADMIN_AGENT_PROPOSED`, `ADMIN_AGENT_APPLIED`, `ADMIN_AGENT_DISCARDED`, `ADMIN_AGENT_APPLY_FAILED`. Drafts carry `details.via = "ADMIN_AGENT"` and the `proposalId`.
  - Agent file `agents/tenderflow_admin_builder.yaml`; eval set `agents/evals/agents/admin-builder.json` (6 cases, EN + AR).
- **Dedicated edition.**
  - Guards are in `services/api/src/tenancy.ts`, used by login, registration, public routes, the token service, the scheduler and entity provisioning.
  - `GET /api/v1/public/deployment` returns `{ mode, entity }` for the web app.
  - The demo seed is split per entity.
  - `entity:create` refuses any code other than `ENTITY_ID` (403 `ENTITY_CREATION_DISABLED`).
  - The OpenShift production overlay sets `TENANCY_MODE=dedicated` and an empty `ENTITY_ID` that must be filled in. The demo overlay keeps `TENANCY_MODE=shared`.

## Upgrade notes (from rc5)

Follow [INSTALLATION-AND-OPERATIONS.md §8](INSTALLATION-AND-OPERATIONS.md#8-upgrade-procedure). Back up the database first. In addition:

1. **Migration `011_admin_agent.sql`** runs automatically at start-up, under the migration lock.
   - It adds the table `admin_proposals`.
   - It widens the `ai_runs.kind` check to allow `ADMIN_BUILDER`.
   - It is additive, so the rolling upgrade works.
2. **New settings** (`.env` / ConfigMap; see `.env.example`):

   | Variable | Default | What to do |
   |---|---|---|
   | `TENANCY_MODE` | `dedicated` | Keep `dedicated` for a customer installation. Set `shared` for KBM's three-entity demo. |
   | `ENTITY_ID` | empty | The entity code of this installation, e.g. `moi`. **Required with `TF_ENV=production` in dedicated mode:** start-up is refused and `config:check` reports FAIL while it is empty. Not allowed with `shared`. |
   | `DEMO_ENTITY` | `ENTITY_ID` if it is a demo entity, else `kea` | Only for the demo seed of a dedicated installation (`kea`, `gcia` or `moi`). |
   | `WXO_AGENT_ADMIN_BUILDER` | `tenderflow_admin_builder` | Optional. Set it only if the agent has another name or id on the Orchestrate instance. |

3. **Existing installations:**
   - **Production:** set `ENTITY_ID` to the entity the database holds. A database that holds other entities but not `ENTITY_ID` is refused at start-up.
   - **Development or demo databases with all three demo entities:** set `TENANCY_MODE=shared`. With `ENTITY_ID` empty and several entities, a non-production start falls back to shared mode with a warning, but production refuses it.
   - **OpenShift production overlay:** fill in `ENTITY_ID` before `oc apply -k`.
4. **Import the new agent:** `powershell -ExecutionPolicy Bypass -File agents\import.ps1` on Windows, or `bash agents/import.sh`. The scripts now import eleven agents, including `tenderflow_admin_builder`.
5. **Verify:**
   - `npm run build && npm run verify:ai`. This checks that the agent exists and runs one live admin-builder turn, which must produce an `ADD_RULE` for "Tenders above 1,000,000 KWD need the Undersecretary".
   - `npm run evals -- agents`, which includes the admin-builder set.
6. Run `npm run config:check`, then check `GET /api/v1/version`, which must report `1.0.0-rc6`.

## Verified (in this sandbox)

| Check | Result |
|---|---|
| `npm test` (API and integration, PGlite) | 279 tests: 278 pass, 0 fail, 1 skipped (PostgreSQL-only, needs `TEST_DATABASE_URL`) |
| — AI admin builder (`services/api/test/admin-agent.test.ts`) | 13 tests, run against the **test-only fake Orchestrate**: not configured / not imported; valid plan; invalid operations refused; roles; entity isolation; same-thread refinement; drafts only, with a second apply refused; open drafts reused; tool path; invalid agent JSON; out-of-scope request; audit chain |
| — Dedicated edition (`services/api/test/dedicated-mode.test.ts`) | 14 tests: configuration and start-up rules; sign-in; tokens; registration; public board and feeds; entity creation; jobs; no other entity's data in screens, the evidence pack or Orchestrate prompts |
| `npx tsx --test services/api/src/ai/*.test.ts` | 40 / 40 pass |
| Typecheck (API and web) and production build | clean (the only warning is Vite's chunk size) |
| Cycle Designer and Process Studio usability screens | No automated UI tests. Typecheck and build are clean. Scripted screenshots in English and Arabic (right-to-left), taken against the real API during development (`scripts/dev/designer-shots.mts`) |
| AI builder screens and dedicated-edition screens | Scripted screenshots during development: `scripts/dev/admin-agent-shots.mts` (fake Orchestrate) and `scripts/dev/dedicated-shots.mts` |

## Not yet verified live

| Item | How |
|---|---|
| **AI admin builder against a real watsonx Orchestrate instance.** It has been tested only against the test fake of Orchestrate, so it is not yet known whether the real agent and model keep to the JSON contract, in Arabic and English. | On TechZone: `agents\import.ps1`, `npm run verify:ai`, `npm run evals -- agents`. Then tune the instructions or model from `agents/evals/agents/results.md`. |
| Orchestrate chat tool pack (`submit_admin_proposal`) | TenderFlow on a public HTTPS URL plus a bearer connection holding a `TENANT_ADMIN` token. See [agents/tools/README.md](../agents/tools/README.md). |
| Dedicated installation on OpenShift with its own PostgreSQL database, FileNet object store (or root folder) and Orchestrate instance | `deploy/openshift/overlays/production` with `ENTITY_ID` set, then `entity:create`, `verify:filenet` and `verify:ai` |
| Still open from rc5: FileNet classes, permissions, search and Navigator on TechZone; the other 10 Orchestrate agents; container image build and OpenShift deployment; webhooks to a real receiving system; SSO, e-mail and SMS | See [rc5 notes](release-notes-v1.0.0-rc5.md#not-yet-verified-live) |

## Known limits

- **AI admin builder:**
  - **Notification templates are not covered**, because they are edited live, not as drafts. Users and roles are not covered either, because they are security-sensitive. Entity settings (four-eyes, numbering) and integrations are also out of scope. For all of these the agent says where the change is made.
  - **Evaluation weights are entered per tender**, not in the template. For "a 60/40 technical/price split", the agent creates the template (envelopes, pass mark, price criterion) and says that the weights are set on each tender's evaluation criteria.
  - Validation messages from the existing services are in English. The Arabic text carries the same message after an Arabic introduction.
  - A rule that tests a field which exists only in a form draft is flagged. Publish the form draft before the rule set.
  - In a shared Orchestrate instance, the import scripts use fixed agent names, so a second entity's set must be renamed by hand.
- **Usability:**
  - The unsaved-changes guard covers closing the tab, in-app links and switching template. It does **not** catch the browser **Back** button.
  - The wizard's starter templates are **client-side copies** of the server's starter settings. They are kept in step by hand, and the server still validates the result.
  - The dismissed getting-started checklist is remembered per browser only.
- **Dedicated edition:**
  - The audit log is append-only, so entities cannot be removed from a former shared database. Use a new dedicated installation per entity.
  - A copy of a shared database started with `ENTITY_ID` serves only that entity but still holds the other entities' rows. This is acceptable for a demo, not for production.
- The rc5 limits still apply:
  - npm audit advisories outside the runtime path;
  - no rotation tool for `BID_MASTER_KEY` / `AUDIT_SIGNING_KEY`;
  - no new stages between the fixed ones;
  - no rule-routed request approval chains;
  - no bid-level facts after opening.
