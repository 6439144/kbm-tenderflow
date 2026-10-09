# TenderFlow (KBM) — v1.0.0-rc1

TenderFlow runs the full public-tender cycle for government entities and regulated enterprises:
vendor registration → tender drafting → AI pack check → approval → publication → clarifications →
sealed (encrypted) bids → automatic close → bid opening → AI compliance screening → evaluation → award,
with an HMAC-chained audit trail. Arabic (RTL) and English throughout.

Documents are stored in **IBM FileNet Content Manager** (Content Services GraphQL API); the AI
advisor runs on **IBM watsonx Orchestrate** agents. Both are optional at start-up: without them the
product runs on a local file store and the AI buttons say "not connected" (never fake output).

Full specification: [docs/BUILD-SPEC.md](docs/BUILD-SPEC.md) · FileNet: [docs/filenet/README.md](docs/filenet/README.md) ·
AI agents: [agents/README.md](agents/README.md) · What is verified: [docs/release-notes-v1.0.0-rc1.md](docs/release-notes-v1.0.0-rc1.md)

## The cycle and who does what

| Stage | Who (demo user) | Where in the app |
|---|---|---|
| Register company, upload documents | new vendor (`/register`) | Vendor portal |
| Approve vendor | `officer` | Procurement → Vendors |
| Draft tender, upload pack, AI pack check | `officer` | Procurement → Tenders → New / tender page |
| Approve for publication (not the creator) | `director` | tender page |
| Publish | `officer` | tender page |
| Ask clarification / answer with AI draft | `vendor1` / `officer` | tender page |
| Submit sealed bid, get receipt | `vendor1`..`vendor3` | Vendor portal → tender |
| Close at deadline | system | automatic |
| Open bids (opening record generated) | `chair` | tender page |
| AI compliance checklist (no scores) | `chair` / `evaluator1` | tender page |
| Score bids per criterion | `evaluator1`, `evaluator2` | tender page |
| Recommend award / approve award (different people) | `chair` / `director` | tender page |
| Verify audit chain, manage users | `auditor` / `admin` | Admin portal |

Demo tenant: **Kuwait Energy Authority (fictitious)** (`kea`). Seeded tenders: one DRAFT, one PUBLISHED,
one CLOSED with three sealed bids ready to open. All users share the password you set in `DEMO_PASSWORD`.

## Run it on Windows (Node.js 20 or newer)

```powershell
cd C:\Users\kabed\Downloads\KBM_Tender_v1        # the folder with this README
copy .env.example .env
npm install
npm run gen-keys                                  # paste both printed lines into .env
notepad .env                                      # set DEMO_PASSWORD=<choose one>, SEED_DEMO=true
npm run build
npm start                                         # then open http://localhost:4000
```

Data (database + files) lives in `.\data`. Delete that folder to start again with fresh demo data.

## Connect IBM FileNet (TechZone)

1. In `.env`: `CONTENT_STORE_TYPE=filenet` and the four `FILENET_*` values (endpoint, object store `OS1`, user, password).
2. `npm run verify:filenet` — uploads and downloads test files under `/TenderFlow/_verify` and checks the hashes.
   If anything fails, also run `node services/api/dist/tools/filenet-introspect.js` and send both files from `docs\evidence\`.
3. Delete `.\data` and `npm start` again — the demo seed now stores every document in FileNet under `/TenderFlow/kea/...`.
4. Optional: create class `TF_Document` with TenderFlow properties ([docs/filenet/ACCE-RUNBOOK.md](docs/filenet/ACCE-RUNBOOK.md)).

## Connect IBM watsonx Orchestrate (TechZone)

1. `py -m pip install --upgrade ibm-watsonx-orchestrate` (Python 3.11+).
2. In `.env`: `WXO_INSTANCE_URL` and `WXO_API_KEY` (Orchestrate → Settings → API details).
3. `powershell -ExecutionPolicy Bypass -File agents\import.ps1` — imports the three agents.
4. `npm run verify:ai` — runs one real bilingual clarification through Orchestrate.
5. `npm run evals` — 23 questions (Arabic + English + not-found), real pass rate written to `agents/evals/results.md`.

## Security model (summary)
- RS256 JWTs issued by TenderFlow (JWKS at `/.well-known/jwks.json`); an external OIDC IdP can be trusted via `EXTERNAL_OIDC_ISSUER`. No shared secrets.
- Tenant comes only from the token; every query is tenant-scoped.
- Sealed bids: each file is AES-256-GCM encrypted by TenderFlow with a per-bid key (wrapped by `BID_MASTER_KEY`) before it reaches the content store, so not even content-store administrators can read a bid before the recorded opening.
- Segregation of duties: tender approver ≠ creator; award approver ≠ recommender; opening only by the committee chair after the deadline.
- Audit events are append-only (database trigger) and HMAC-chained; `GET /api/v1/audit/verify` detects tampering.

## Development
`npm test` (API integration tests incl. the full cycle, plus the FileNet store and showcase tests in `services/api/test/`) · `npx tsx --test services/api/src/ai/*.test.ts` (AI unit tests) · `npm run dev` (API with reload) · `npm run dev -w apps/web` (UI on :5173, proxied to :4000).
