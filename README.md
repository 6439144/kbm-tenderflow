# TenderFlow (KBM) — v1.0.0-rc6

TenderFlow is a generic, configurable public-tendering product for government entities and regulated enterprises.
Each entity runs **its own tender cycle** from a versioned template (stages on/off, N-level approval chains, one or
two envelopes, eligibility by activity code and grade, paid documents, gazette/CAPT publication, records lock),
while the integrity rules stay fixed: sealed (encrypted) bids, opening only by the chair after the deadline,
approver ≠ creator, award approver ≠ recommender, append-only HMAC-chained audit. Arabic (RTL) and English throughout.

- **IBM FileNet Content Manager** is the visible system of record: every document is stored through the Content
  Services GraphQL API, with an evidence panel (object id, class, folder, versions, SHA-256, record status,
  Navigator link), addenda as new versions, records declaration at award, and an admin health page.
- **IBM watsonx Orchestrate** runs ten advisory agents: a supervisor *TenderFlow Assistant* (chat in every portal)
  with nine collaborators — request classifier, pack checker, gazette/CAPT notice drafter, vendor relevance
  matcher, clarification assistant, grade reviewer, compliance screener, evaluation narrator and **document
  intelligence** (every upload classified and its key data extracted with citations; a person accepts or corrects).
- **Platform features for government entities:** an annual vendor subscription with renewal reminders, grade upgrades,
  fee exemptions and vendor blocking with automatic reinstatement. Also two-step verification, staff single sign-on
  through Active Directory (OIDC) and a staff network allowlist. Tender documents can be view-only or downloaded
  as a watermarked copy. Editable bilingual notifications go out by in-app, e-mail and SMS, with a delivery log.
  Approval service levels escalate automatically. Every role has a dashboard, there are procurement analytics, an
  auditor evidence pack, and a public tender board of the entity's open tenders.
- **Low-code Process Studio:** each entity customises its process without code — custom fields and calculated values on
  tender, request and vendor forms; visual rules that route approvals, stop steps until conditions are met, create tasks,
  notify and call other systems through signed webhooks; drafts, simulation, versioning and four-eyes publishing; packages
  to roll a process out to another entity. The integrity rules above can never be weakened by a rule.
  Since rc6 both configuration screens guide non-technical administrators: a new-template wizard, the cycle "in plain
  words", rule recipes, a step-by-step rule editor, drag-and-drop approval chains and form fields, a formula helper,
  help and getting-started checklists ([guided experience](docs/LOW-CODE-STUDIO.md#guided-experience-rc6)).
- **AI admin builder (rc6):** an administrator describes a change in Arabic or English (Admin → AI builder, or
  *Describe a change* in the Cycle Designer and Process Studio) and the Orchestrate agent `tenderflow_admin_builder`
  proposes it; TenderFlow validates every operation with the screens' own rules, shows it as a bilingual sentence with the
  exact changes and creates **drafts only** — publishing stays a human step ([docs/ADMIN-AI-BUILDER.md](docs/ADMIN-AI-BUILDER.md)).
- Both IBM services are optional at start-up: without them the product runs on a local file store and every AI feature says
  "not connected" — never fake output.

**One installation per government entity.** TenderFlow is sold to each government entity separately and each works in
separation: by default (`TENANCY_MODE=dedicated`, `ENTITY_ID=<entity code>`) an installation serves exactly one entity
with its own database, FileNet object store (or root folder), Orchestrate instance, keys, committees, suppliers and
branding. Sign-in and supplier registration have no entity picker, the public board shows only that entity, and any
other entity id is answered with 404. `TENANCY_MODE=shared` (several entities in one installation) is kept for KBM's
multi-entity demo and the tests. Details: [docs/DEPLOYMENT-MODEL.md](docs/DEPLOYMENT-MODEL.md).

Docs: [Deployment model](docs/DEPLOYMENT-MODEL.md) · [BUILD-SPEC](docs/BUILD-SPEC.md) · [Installation & operations (Windows, OpenShift, PostgreSQL, backups, upgrades)](docs/INSTALLATION-AND-OPERATIONS.md) · [Implemented user stories](docs/USER-STORIES.md) ·
[What is verified (rc6)](docs/release-notes-v1.0.0-rc6.md) · [Low-code Process Studio](docs/LOW-CODE-STUDIO.md) · [AI admin builder](docs/ADMIN-AI-BUILDER.md) · [MOI reference configuration](docs/MOI-REFERENCE-CONFIGURATION.md) ·
[Security](docs/SECURITY-FEATURES.md) · [Notifications & escalation](docs/NOTIFICATIONS-AND-ESCALATION.md) · [Analytics & evidence](docs/ANALYTICS-AND-EVIDENCE.md) · FileNet: [README](docs/filenet/README.md), [showcase](docs/filenet/SHOWCASE.md) ·
AI agents: [agents/README.md](agents/README.md) · [Document intelligence](docs/DOCUMENT-INTELLIGENCE.md)

## Three demo entities, three different cycles (all demo data is fictitious)

A dedicated installation seeds **one** of them (`DEMO_ENTITY=kea|gcia|moi`, default `kea`). To show all three side by
side in one installation (KBM's multi-entity demo), set `TENANCY_MODE=shared` and leave `ENTITY_ID` empty.

| Entity | Default cycle | What it shows |
|---|---|---|
| `kea` — Kuwait Energy Authority | Public tender, one envelope | Request intake with a scanned GM letter, director approval, gazette notice, sealed bids, opening, evaluation, award, records lock |
| `gcia` — Gulf Coast Infrastructure Authority | RFP, two envelopes | Director → undersecretary approvals, paid documents (TEST gateway), minimum Second grade (vendor3 is not eligible), technical then financial opening |
| `moi` — Ministry of Interior, **reference configuration · demo data** | MOI Phase 1: request → approval → targeted tender → purchase | Configured from KBM's MOI BRD v0.1: Raslni + GM-letter intake, activity + grade targeting, annual subscription, MOI receipt numbers, grading, upgrades, blocking, exemptions, view-only content. Bidding and award are outside MOI's Phase 1 scope. Every open MOI decision is a setting on Admin → Entity policies ([traceability](docs/MOI-REFERENCE-CONFIGURATION.md)). |

Users in `kea` and `gcia`: `officer`, `director`, `undersecretary`, `chair`, `evaluator1`, `evaluator2`, `admin`, `auditor`,
`vendor1`..`vendor4`. Users in `moi`: `tenderdept` (Tender Department), `officer` (tender creator), `grader` (grading
authority), `director`, `undersecretary`, `admin`, `auditor`, `vendor1` (active, First grade), `vendor2` (subscription ends
in 5 days), `vendor3` (application waiting for grading), `vendor4` (blocked until next week), `vendor5` (fee-exempt).
All use the password you set in `DEMO_PASSWORD`.

## The cycle and who does what

| Stage | Who (demo user) | Where in the app |
|---|---|---|
| Configure the entity and its cycle templates | `admin` | Admin → Cycle Designer / Process Studio / AI builder / Entity settings / Document types |
| Department request (scanned letter or Raslni ref.), approval chain, convert to tender | `officer`, `director` | Procurement → Requests |
| Register company, upload documents; every upload classified and data extracted | vendor (`/register`), `officer` reviews | Vendor portal · Procurement → Document intelligence |
| Approve vendor, set activity codes and grades | `officer` | Procurement → Vendors |
| Draft tender, upload pack, AI pack check | `officer` | Procurement → Tenders → New / tender page |
| Approval chain (level by level, never the creator) | `director` (+ `undersecretary` in gcia) | tender page |
| Publish; gazette/CAPT notice drafted, approved by another person, reference recorded; eligible vendors alerted | `officer`, `director` | tender page |
| Buy tender documents (TEST gateway) if the cycle requires it | vendor | Vendor portal → tender |
| Ask clarification / answer with AI draft | vendor / `officer` | tender page |
| Submit sealed bid, get receipt | vendors | Vendor portal → tender |
| Close at deadline | system | automatic |
| Open bids (and financial envelopes in two-envelope cycles) | `chair` | tender page |
| AI compliance checklist (no scores), score bids, AI committee narrative | `chair`, `evaluator1/2` | tender page |
| Recommend award / approve award chain; records locked | `chair` / `director` (+ `undersecretary`) | tender page |
| Verify audit chain; FileNet health | `auditor` / `admin` | Admin portal |

## Guided demo for presentations

Set `DEMO_MODE=true` in `.env` (never in production). After login a **Guided demo** button opens the Demo Story:
13 chapters for `kea`, a "different cycle" track for `gcia` and an 8-chapter MOI reference track (a dedicated installation shows only its own entity's track), each switching persona (real token, audited),
opening the right screen, highlighting what to click and showing live FileNet / Orchestrate evidence.
First-time users of every role also get a short tour of their screens. To start again from clean demo data:
`npm run demo:reset` (dry run) then `npm run demo:reset -- --yes`.

## Run it on Windows (Node.js 20 or newer)

```powershell
cd C:\Users\kabed\Downloads\KBM_Tender_v1        # the folder with this README
copy .env.example .env                            # first time only
npm install
npm run gen-keys                                  # first time only: paste both printed lines into .env
notepad .env                                      # DEMO_PASSWORD=<choose one>, SEED_DEMO=true, DEMO_MODE=true
                                                  # one entity (default): DEMO_ENTITY=kea | all three: TENANCY_MODE=shared
npm run build
npm start                                         # then open http://localhost:4000
```

Data (database + files) lives in `.\data`. Delete that folder (or `npm run demo:reset -- --yes`) to start again with fresh demo data.

## Connect IBM FileNet (TechZone)

1. In `.env`: `CONTENT_STORE_TYPE=filenet` and the four `FILENET_*` values (endpoint, object store `OS1`, user, password).
2. `npm run verify:filenet` — uploads and downloads test files under `/TenderFlow/_verify`, checks the hashes, and
   (new) proves versioning and record declaration before you switch those flags on.
   If anything fails, also run `node services/api/dist/tools/filenet-introspect.js` and send both files from `docs\evidence\`.
3. Delete `.\data` and `npm start` again — the demo seed now stores every document in FileNet under `/TenderFlow/<entity>/...`.
4. Optional, in this order (details in [docs/filenet/SHOWCASE.md](docs/filenet/SHOWCASE.md)): `FILENET_VERSIONING=true`
   after verify step 8 passes; class `TF_Document` + properties ([ACCE runbook](docs/filenet/ACCE-RUNBOOK.md)) with
   `FILENET_DOC_CLASS=TF_Document`, `FILENET_RECORDS_MODE=property`, `FILENET_AI_PROPERTIES=true`; `FILENET_NAVIGATOR_URL` for "Open in Navigator".

## Connect IBM watsonx Orchestrate (TechZone)

1. `py -m pip install --upgrade ibm-watsonx-orchestrate` (Python 3.11+).
2. In `.env`: `WXO_INSTANCE_URL` and `WXO_API_KEY` (Orchestrate → Settings → API details); optional `WXO_LLM`; `DOC_AI_AUTO=true` to classify uploads automatically.
3. `powershell -ExecutionPolicy Bypass -File agents\import.ps1` — imports eleven agents: the nine collaborators and the
   admin builder, then the supervisor.
4. `npm run verify:ai` — IAM token, all agents present, one live clarification, one supervisor turn, one document-intelligence
   run and one admin-builder turn.
5. `npm run evals` and `npm run evals -- agents` — Arabic + English eval sets; real pass rates written under `agents/evals/`.

## Security model (summary)
- RS256 JWTs issued by TenderFlow (JWKS at `/.well-known/jwks.json`); an external OIDC IdP can be trusted via `EXTERNAL_OIDC_ISSUER`. No shared secrets.
- Tenant comes only from the token; every query is tenant-scoped. A dedicated installation additionally refuses any token, sign-in, registration or public read for another entity (404 / 401).
- Sealed bids: each file is AES-256-GCM encrypted by TenderFlow with a per-bid key (wrapped by `BID_MASTER_KEY`) before it reaches the content store, so not even content-store administrators can read a bid before the recorded opening.
- Segregation of duties: tender approver ≠ creator; award approver ≠ recommender; opening only by the committee chair after the deadline.
- Audit events are append-only (database trigger) and HMAC-chained; `GET /api/v1/audit/verify` detects tampering.

## Operations
`npm run config:check` (every setting OK/WARN/FAIL, secrets never printed) · `npm run entity:create -- --code … --name-en … --name-ar …`
(the installation's entity with its first administrator; a dedicated installation refuses any code other than `ENTITY_ID`) · `TF_ENV=production` refuses unsafe settings at start-up ·
OpenShift: [`Containerfile`](Containerfile) and [`deploy/openshift`](deploy/openshift/README.md) · `GET /api/v1/version`, `/health`, `/ready`.

## Development
`npm test` (API integration tests incl. the full cycle, plus the FileNet store and showcase tests in `services/api/test/`) · `npx tsx --test services/api/src/ai/*.test.ts` (AI unit tests) · `npm run dev` (API with reload) · `npm run dev -w apps/web` (UI on :5173, proxied to :4000).
