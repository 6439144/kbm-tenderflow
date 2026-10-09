# TenderFlow v1.0.0-rc1 — release notes (9 Oct 2026)

Every statement below is tagged **Verified** (with how) or **Built, not yet verified live**. Nothing else is claimed.

## Verified
| Capability | How it was verified |
|---|---|
| Full tender cycle from vendor registration to award, via the API | Automated integration test `services/api/test` (full-cycle test), 14/14 tests passing |
| Full cycle in the browser (open bids → AI unavailable banner → two evaluators score → chair recommends → director approves → AWARDED with committee report) | Scripted Chromium walk-through on the demo data, no client or API errors |
| Arabic (RTL) and English UI | Browser walk-through in both languages |
| Login with RS256 tokens; anonymous → 401; vendor on staff route → 403; cross-tenant → 404; forged token (other RSA key), HS256 token and token without tenant → 401 | Integration tests |
| Sealed bids encrypted at rest (AES-256-GCM per-bid key wrapped by master key); no plaintext in the file store; competitor and staff cannot read bids before opening; opening before deadline → 409; late bid → 409 | Integration tests + inspection of stored files |
| Segregation of duties (creator cannot approve; award approver ≠ recommender) | Integration tests |
| Data persists across restarts (embedded PostgreSQL via PGlite) | Integration test (restart on same data folder) |
| Append-only, HMAC-chained audit; tampering detected | Integration test (trigger blocks UPDATE/DELETE; manual tamper → verify reports broken row); demo run: 64 events, chain valid |
| AI endpoints never return canned output; without Orchestrate they return 503 AI_NOT_CONFIGURED | Integration test + browser banner |
| FileNet store request format (Basic auth, XSRF header + cookie, multipart order, folder creation, download) | 26 unit tests against a local fake server, request shapes taken from IBM's published Content Services GraphQL schema and samples |
| Orchestrate client (IAM token, agent lookup, runs, polling, JSON parsing, citation checking, retries) | 31 unit tests against a local fake server, endpoints taken from IBM's ADK source and API docs |

## Built, not yet verified live (needs the TechZone environments, run from the Windows machine)
| Item | How to verify |
|---|---|
| Documents stored in FileNet (TechZone OS1, `/TenderFlow/...`) | `npm run verify:filenet`, then run the demo with `CONTENT_STORE_TYPE=filenet` and check Navigator |
| Three Orchestrate agents (pack checker, clarification assistant, compliance screener) | `agents\import.ps1`, `npm run verify:ai`, `npm run evals` |
| External PostgreSQL server via `DATABASE_URL` | Run against a PostgreSQL 16 instance |
| DOCX text extraction | Upload a .docx pack and run the AI pack check |

## Known limitations / roadmap
- TechZone FileNet endpoint is plain HTTP with Basic auth; production requires HTTPS and a dedicated least-privilege service account.
- Reports are bilingual HTML documents; PDF rendering is roadmap.
- Container packaging (Dockerfile / OpenShift) is roadmap; tonight the product runs with `npm start`.
- AI review is recorded per AI run (per-finding review is roadmap).
- Notifications (email/SMS) and external identity provider federation are roadmap.
- Orchestrate tools calling back into TenderFlow (instead of TenderFlow sending document text) are roadmap; they need a public HTTPS endpoint.
