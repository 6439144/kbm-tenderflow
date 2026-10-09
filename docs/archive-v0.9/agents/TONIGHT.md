# TONIGHT — finish v1.0.0-rc1 by 23:59 Fri 9 Oct 2026 (Kuwait time)

This file narrows docs/agents/V1-HARDENING-PROMPT.md to what can be finished and proven
tonight. Where they conflict, this file wins. Rules 9–13 still apply in full:
anything not finished tonight is moved to docs/roadmap.md, never faked.

## Reviewer channel
An external reviewer checks the repo at about 18:30, 19:45, 21:00, 22:15 and 23:30 and writes
findings to docs/agents/REVIEWER-NOTES.md. A0: read that file at the start of every loop.
Items marked BLOCKING are fixed before any new feature work. Reply under each item with the
commit hash that fixes it.

## Commit rule tonight
Small commits, straight to `integration`, every 30–45 minutes per agent, CI green.
Run `npm run build && npm test && npm run test:security` before each commit.

## Gate 1 — 19:30: honest and secure core
| Task | Agent | Done when |
| --- | --- | --- |
| G1-a Docs honest: release notes, esa-questionnaire, STATUS, results.md say only what is true now | A0 | No claim of encryption, FileNet, Orchestrate or eval rate without evidence |
| G1-b Keycloak JWT verification with `jose` (JWKS, issuer, audience, expiry); tenant + roles from token only; delete X-Actor-Role, X-Actor-Id, `mock:` tokens and the default-actor fallback; auth before tenant middleware; `requireRole` on every route per role-matrix.md; creator cannot approve own tender | A2 | Anonymous call → 401; vendor on procurement route → 403; wrong tenant → 403 |
| G1-c Sealed bids: `/documents/:id` checks the owning resource (bid files only via bid routes after opening, to committee/evaluators); vendorId from token; reject bids unless PUBLISHED and before deadline; opening only when now ≥ deadline, by COMMITTEE_CHAIR; AES-256-GCM per-bid data key wrapped with BID_MASTER_KEY | A2 | The 4 attacks in V1-HARDENING-PROMPT.md §2 P0-1/P0-2 all fail, as tests |
| G1-d Persistence, fast path: PostgreSQL tables with `id`, `tenant_id`, `data jsonb`, timestamps for each entity, numbered SQL migrations, repository layer; in-memory only in test/fakes; `/ready` does real checks | A2 (+A6 for migrations runner) | Restart API → data still there (test) |
| G1-e Security tests use real Keycloak tokens per role/tenant (compose test realm); CI `npm ci` only, audit blocking; remove hard-coded passwords from compose | A6 | Tests fail if auth is removed |
| G1-f Keycloak realm: tenant_id mapper, roles, demo users per role for kea + ministry_a; passwords via env | A6 | Token for each demo user obtained by script |

## Gate 2 — 21:30: real FileNet and real Orchestrate
Only if the TechZone credentials are in `.env` (humans provide them). If not, build everything,
make the verify scripts fail clearly with "credentials missing", and log a QUESTIONS.md item.
| Task | Agent | Done when |
| --- | --- | --- |
| G2-a FileNetGraphQLContentStore real: put (multipart createDocument + XSRF header and cookie), get (downloadUrl / content endpoint), search by TF_ properties, versions, permissions, ping = real query. Working queries saved in services/content-adapter/graphql/ after testing in GraphiQL | A4 | Contract tests pass against TechZone; screenshot of a TenderFlow document in Navigator in docs/evidence/G2-a |
| G2-b provision: script if GraphQL supports class creation, else ACCE-RUNBOOK.md + verify.js that exits non-zero on anything missing | A4 | verify.js passes on TechZone |
| G2-c Tool endpoints for AI: text extraction (pdf-parse / mammoth) chunked with section numbers; ai-tools OpenAPI 3.0 spec; short-lived ai_session token bound to user/tenant/tender; sealed bids 403; delete canned ai-advisory.ts; screener = missing-document checklist, no scores | A2 | Tool calls return real chunks from FileNet documents |
| G2-d ADK-format agents (spec_version v1, kind native, llm from `orchestrate models list`, style, instructions, tools), connection tenderflow_api (bearer, draft + live), `orchestrate tools import -k openapi -f ... -a tenderflow_api`, `orchestrate agents import -f`, import.sh with set -euo pipefail and no mock mode | A5 | `orchestrate agents list` output + Orchestrate chat screenshot citing a FileNet document, in docs/evidence/G2-d |
| G2-e orchestrate-client.ts: IAM token from WXO_API_KEY, invoke agent via the documented runs/chat API (record the endpoint and doc link in ADR-007), store prompt/answer/sources, audit AI_ADVISORY_GENERATED / REVIEWED | A2 + A5 | Pack checker and clarification draft work from the API |
| G2-f Real evals: run-evals.js calls the agents for the 40 questions, writes true pass rates with raw answers | A5 | results.md shows real numbers, whatever they are |

## Gate 3 — 23:30: product in the browser, docs from evidence
| Task | Agent | Done when |
| --- | --- | --- |
| G3-a Vendor portal wired: Keycloak login, register + upload documents, tender list + pack download, ask clarification, submit bid with receipt (SHA-256 + server time), my bids | A3 | Playwright runs it with a real login |
| G3-b Procurement app wired: tender draft + pack upload, AI pack check with accept/ignore, approve (different user), publish, clarification inbox with AI draft edit/approve, addendum, opening, compliance checklist, evaluator scoring, award | A3 | Playwright runs demo steps 3–7 |
| G3-c Control panel minimal: tenant list/details from API, audit log viewer with chain verify | A3 | Loads with admin login |
| G3-d Audit in PostgreSQL, append-only, HMAC key from env (no default), GET /audit-logs/verify | A2 | verify returns valid; tampered row detected in test |
| G3-e Opening record + committee report: HTML → PDF with Playwright page.pdf (Arabic RTL), stored in FileNet | A2 | PDFs visible in Navigator — CUT to roadmap if not done by 23:00 |
| G3-f install.sh fails fast, uses .env; clean run recorded | A6 | Recording / log in docs/evidence/G3-f |
| G3-g Release notes v1.0.0-rc1, ESA questionnaire, install/admin/user guides rewritten from evidence; roadmap.md lists everything cut | A1 + A0 | Every claim links to evidence |
| G3-h Tag v1.0.0-rc1 | A0 | Only after G3-g and all BLOCKING reviewer notes closed |

## Cut to roadmap tonight (do not start)
Notifications, deadline scheduler (enforce at request time instead), row-level security,
metrics/Trivy, Keycloak user management from the control panel, web chat embed, committee
quorum (keep creator ≠ approver and chair-only opening), multi-version bid replacement.

## Agent start lines
- A0: coordinate, G1-a, G3-g, G3-h, merge order, REVIEWER-NOTES replies.
- A1: G1-a support now, then seed data into FileNet (G2-a fixtures) and G3-g docs.
- A2: G1-b → G1-c → G1-d → G2-c → G2-e → G3-d (biggest load; A6 takes migrations).
- A3: G3-a/G3-b/G3-c from the start against openapi.yaml; switch to real tokens when G1-b lands.
- A4: G2-a, G2-b from the start.
- A5: G2-d setup from the start (ADK, connection, model choice, Arabic test), then G2-e/G2-f.
- A6: G1-e, G1-f, migrations runner, G3-f.
