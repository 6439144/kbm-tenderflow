# TenderFlow (KBM) — v1.0.0-rc2

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
- Both are optional at start-up: without them the product runs on a local file store and every AI feature says
  "not connected" — never fake output.

Docs: [BUILD-SPEC](docs/BUILD-SPEC.md) · [Implemented user stories](docs/USER-STORIES.md) ·
[What is verified (rc2)](docs/release-notes-v1.0.0-rc2.md) · FileNet: [README](docs/filenet/README.md), [showcase](docs/filenet/SHOWCASE.md) ·
AI agents: [agents/README.md](agents/README.md) · [Document intelligence](docs/DOCUMENT-INTELLIGENCE.md)

## Two demo entities, two different cycles (all fictitious)

| Entity | Default cycle | What it shows |
|---|---|---|
| `kea` — Kuwait Energy Authority | Public tender, one envelope | Request intake with a scanned GM letter, director approval, gazette notice, sealed bids, opening, evaluation, award, records lock |
| `gcia` — Gulf Coast Infrastructure Authority | RFP, two envelopes | Director → undersecretary approvals, paid documents (TEST gateway), minimum Second grade (vendor3 is not eligible), technical then financial opening |

Users in both: `officer`, `director`, `undersecretary`, `chair`, `evaluator1`, `evaluator2`, `admin`, `auditor`,
`vendor1`..`vendor4` — all with the password you set in `DEMO_PASSWORD`.

## The cycle and who does what

| Stage | Who (demo user) | Where in the app |
|---|---|---|
| Configure the entity and its cycle templates | `admin` | Admin → Cycle Designer / Entity settings / Document types |
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
13 chapters for `kea` plus a "different cycle" track for `gcia`, each switching persona (real token, audited),
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
3. `powershell -ExecutionPolicy Bypass -File agents\import.ps1` — imports the nine collaborator agents, then the supervisor.
4. `npm run verify:ai` — IAM token, all agents present, one live clarification, one supervisor turn, one document-intelligence run.
5. `npm run evals` and `npm run evals -- agents` — Arabic + English eval sets; real pass rates written under `agents/evals/`.

## Security model (summary)
- RS256 JWTs issued by TenderFlow (JWKS at `/.well-known/jwks.json`); an external OIDC IdP can be trusted via `EXTERNAL_OIDC_ISSUER`. No shared secrets.
- Tenant comes only from the token; every query is tenant-scoped.
- Sealed bids: each file is AES-256-GCM encrypted by TenderFlow with a per-bid key (wrapped by `BID_MASTER_KEY`) before it reaches the content store, so not even content-store administrators can read a bid before the recorded opening.
- Segregation of duties: tender approver ≠ creator; award approver ≠ recommender; opening only by the committee chair after the deadline.
- Audit events are append-only (database trigger) and HMAC-chained; `GET /api/v1/audit/verify` detects tampering.

## Development
`npm test` (API integration tests incl. the full cycle, plus the FileNet store and showcase tests in `services/api/test/`) · `npx tsx --test services/api/src/ai/*.test.ts` (AI unit tests) · `npm run dev` (API with reload) · `npm run dev -w apps/web` (UI on :5173, proxied to :4000).
