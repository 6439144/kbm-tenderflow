# TenderFlow v1.0 — Hardening & Real Integration Brief (for Antigravity agents A0–A6)

Read this whole file before doing anything. It replaces the v0.9 task board.
AGENTS.md still applies; where they conflict, this file wins.

## 0. Why this brief exists

An independent review on 9 Oct 2026 ran the v0.9 API and read every source file.
v0.9 has a good skeleton (repo layout, ADRs, state model, OpenAPI contract, seed data,
bilingual strings, ContentStore interface) but most product behaviour is simulated,
and several claims in the docs are not true. IBM will review this product for an
Embedded Solution Agreement. A reviewer who runs one curl command will find the gaps.

Goal of this brief: turn v0.9 into **v1.0 release candidate** — every capability in
docs/review-demo.md works for real against PostgreSQL, Keycloak, IBM FileNet (TechZone)
and IBM watsonx Orchestrate (TechZone), and every claim in the docs is backed by evidence.

## 1. Honesty rules (new, non-negotiable, add them to AGENTS.md as rules 9–13)

9.  **No simulated success.** No stub, mock or fallback may return success for a real
    integration. If FileNet, Orchestrate, PostgreSQL or Keycloak is not configured or not
    reachable, the code must fail loudly (error + non-zero exit + health "down").
    Mocks are allowed only inside unit tests, in files named `*.test.ts` or under `test/fakes/`.
10. **No `|| true`, no `|| echo`, no "mock mode" in scripts** (install.sh, import.sh,
    provision, CI). A failing step fails the script.
11. **No hard-coded AI output.** Every AI result shown to a user comes from a model call
    through watsonx Orchestrate, grounded on documents retrieved from FileNet, with the
    source document and section returned. No canned answers, no fixed confidence numbers.
12. **Evidence or it did not happen.** Every "done" in BOARD.md links to evidence in
    `docs/evidence/<task-id>/`: command run, real output (secrets redacted), date, and
    for integrations a screenshot from GraphiQL / Navigator / Orchestrate.
13. **Docs never claim more than the code does.** Before release, every sentence in
    release notes, ESA questionnaire and architecture docs is checked against code and
    evidence. Anything not true is removed or moved to docs/roadmap.md.

## 2. Verified findings (what is actually in v0.9)

Severity: P0 = blocks IBM review, P1 = must fix for v1.0, P2 = should fix.

### P0-1 Authentication is not enforced (services/api/src/middleware/auth.ts)
- Any request without a token becomes PROCUREMENT_OFFICER; the `X-Actor-Role` header lets
  the caller pick any role; `mock:` tokens are accepted outside tests.
- Keycloak runs in docker-compose but the API never verifies a JWT; `jsonwebtoken` is unused.
- `requireRole()` exists but no route uses it.
- Proven: an anonymous caller created a tender, approved it as DIRECTOR and published it (HTTP 200 x3).

### P0-2 Sealed bids leak and the vault is not a vault
- `GET /api/v1/documents/:id` returns any document to any caller. Proven: a "VENDOR"
  downloaded another vendor's financial proposal before opening ("SECRET PRICE 9999").
- `sealed-bid-vault.ts`: `envelopeKeyEncrypted` is a random plaintext key that is never used;
  nothing is encrypted. Bids live in an in-memory Map.
- `vendorId` comes from the request body, not the authenticated vendor.
- No deadline lock: bids accepted at any time; the opening ceremony auto-closes a PUBLISHED
  tender and opens bids before the deadline. Proven: opened a year early.
- Any non-vendor role can convene the opening; no committee membership or quorum.

### P0-3 FileNet integration is a stub (services/content-adapter/src/filenet-graphql-store.ts)
- No GraphQL request is ever sent. `put` discards the content, `get` returns placeholder text,
  `search` returns [], `setPermissions` and `deleteDocument` return true, `ping` always "ok".
- `provision/provision-classes.js` only prints the class names and returns fake success
  when FILENET_GRAPHQL_URL is unset.
- docker-compose sets `CONTENT_STORE_TYPE=filesystem`, so FileNet is never used.

### P0-4 AI is canned and watsonx Orchestrate is not connected
- `services/api/src/services/ai-advisory.ts` never calls a model. The clarification draft
  always talks about "dual-power feeds (A+B)" whatever the question (proven); confidence 0.94
  and source references are hard-coded; the bid score is 94 if the vendor name contains
  "Consortium", else 85.
- The bid screener suggests technical scores — this breaks rule 7 (AI never scores for award).
- `agents/*.yaml` are not ADK format (`spec_version: 2.0.0`, inline endpoints, no `kind`/`llm`/`style`);
  `agents/tools/*.json` are not OpenAPI specs; `orchestrate agents apply` is not an ADK command;
  `import.sh` hides failures with `|| true` and a "mock mode".
- `agents/evals/score-evals.js` marks a question "passed" if its expected answer is non-empty;
  no model is called. The 100% / 40/40 figure in results.md and the release notes is not real.

### P0-5 Docs overclaim
- release-notes-v0.9.0.md and docs/architecture/esa-questionnaire.md claim envelope encryption,
  proven tenant isolation, FileNet integration and 100% AI evals. None is true today.

### P1-1 No persistence
- `services/api/src/db/client.ts` keeps everything in Maps; the pg pool is created but never
  queried; `schema.sql` is never applied. A restart loses all data. `/health` is hard-coded "connected".

### P1-2 Tenant isolation is header-based
- Tenant comes from `X-Tenant-ID`, chosen by the caller; middleware order runs tenant before auth.
  Proven: anonymous `GET /api/v1/audit-logs` returns 200.

### P1-3 The three apps are click-throughs
- apps/*/src/app/page.tsx: buttons only change React state; no API calls, no login, tenants
  hard-coded. `packages/ui/src/api/client.ts` exists but no app uses it.

### P1-4 Tests do not test security
- Security and E2E tests set their own role through `X-Actor-Role`, so they pass by construction.
- CI: `npm ci || npm install`; `npm audit` non-blocking.

### P1-5 Audit trail
- Hash chain is in memory; HMAC key defaults to a hard-coded string.

### P2
- Hard-coded passwords in docker-compose (keycloak admin, postgres). No helmet/rate limit/
  request size limits/upload type checks. No committee report or opening record PDF.
  No deadline scheduler. No notifications. Segregation of duties not enforced.

## 3. Target: definition of v1.0 done

All 10 steps of docs/review-demo.md pass **in the browser**, logged in through Keycloak,
on the hosted stack with `CONTENT_STORE_TYPE=filenet`, with these proofs:
1. Every uploaded document is visible in FileNet Navigator with TenderFlow class and metadata.
2. A sealed bid cannot be read before opening by anyone: vendor, officer, admin, AI tool,
   direct document URL, or FileNet user other than the service account. Each path tested.
3. All three AI agents run in the TechZone Orchestrate instance, call TenderFlow OpenAPI tools,
   answer from FileNet documents with citations, and work in Arabic and English.
4. Stop the API and restart it: all data is still there.
5. `deploy/install.sh` on a clean VM brings up the stack; a fresh TechZone reservation is
   rebuilt by `provision` + `agents/import.sh` + `seed`, all scripted, all timed.
6. Release notes and ESA questionnaire contain only verified statements.

## 4. Work packages by agent

Order matters. Phase A must merge before B and C start touching routes.

### Phase A — Truth & security foundation (A0, A2, A6) — first

**A0**
- Add rules 9–13 to AGENTS.md. Re-seed BOARD.md from this file (tasks H-xx below).
- Immediately edit release-notes-v0.9.0.md and esa-questionnaire.md: mark FileNet, Orchestrate,
  encryption and eval claims as "in progress (v1.0)". Do this before any other work.
- New ADRs: ADR-007 identity propagation to AI tools; ADR-008 bid encryption & key handling;
  ADR-009 persistence (repository layer, migrations).

**A2 — H-01 Real authentication & authorization**
- Verify Keycloak access tokens with JWKS (`jose` library): issuer, audience, expiry, signature.
- Tenant id and roles come only from token claims (`tenant_id` claim, realm roles). Delete the
  `X-Actor-Role`/`X-Actor-Id` headers and `mock:` tokens. `X-Tenant-ID` may only select among
  tenants listed in the token; mismatch = 403.
- Auth runs before tenant middleware. Public routes: `/health`, `/ready`, vendor self-registration,
  published tender listing. Everything else 401 without a valid token.
- Apply `requireRole()` to every route from docs/requirements/role-matrix.md.
- Segregation of duties: the approver of a tender cannot be its creator; opening needs the
  committee chair plus quorum from the tender's committee; award approval by the award authority.
- Keycloak realm: one realm, groups per tenant, roles VENDOR, PROCUREMENT_OFFICER, DIRECTOR,
  COMMITTEE_CHAIR, COMMITTEE_MEMBER, EVALUATOR, TENANT_ADMIN, AUDITOR; `tenant_id` mapper;
  demo users per role per tenant; passwords from env, never in the realm JSON.

**A2 — H-02 Persistence**
- Repository interfaces for tenants, vendors, tenders, clarifications, bids, openings,
  evaluations, awards, audit. PostgreSQL implementation using `pg` with versioned migrations
  (`node-pg-migrate` or plain numbered SQL + runner). Apply on startup or via `npm run migrate`.
- Every query filters by tenant_id; add row-level security policies on tenant_id as defence in depth.
- In-memory implementations only under `test/fakes/`.
- `/health` = process up; `/ready` = real checks of PostgreSQL, Keycloak JWKS, content store `ping`
  (which must make a real FileNet call), Orchestrate token fetch. Report each.

**A2 — H-03 Sealed-bid vault, for real**
- Bids, openings, keys in PostgreSQL.
- Encryption: per bid, generate a data key; encrypt each bid file with AES-256-GCM before it
  leaves the API; store ciphertext in FileNet; wrap the data key with a master key from
  `BID_MASTER_KEY` (32 bytes, base64, from the secrets store; later KMS/HSM) and store the
  wrapped key + IV + auth tag in PostgreSQL. Decrypt only after a recorded opening.
- vendorId = authenticated vendor's id. Reject bids when tender is not PUBLISHED or after
  `submissionDeadline` (server clock, UTC). Allow withdraw/replace before deadline (new version).
- Scheduler (node-cron or pg-boss): auto-close tenders at deadline, audit "TENDER_CLOSED by SYSTEM".
- Opening allowed only when status CLOSED and now >= deadline, by committee chair, with quorum
  recorded; generates the opening record (see H-09).
- `/api/v1/documents/:id`: look up the document's owning resource; bid documents are served only
  through the bid routes and only after opening to committee/evaluators; tender pack documents to
  vendors only after publication; vendor documents to that vendor and procurement roles.

**A6 — H-04 Make tests mean something**
- Security tests obtain real tokens from Keycloak (test realm in compose) for each role and tenant.
- Required negative tests: anonymous → 401 on every non-public route; vendor → 403 on procurement
  routes; tenant A user → 404/403 on tenant B resources; competitor vendor cannot read another bid
  via any route incl. `/documents/:id`; nobody reads a bid before opening; opening before deadline
  → 409; creator cannot approve own tender; AI tool endpoints refuse sealed bids.
- CI: `npm ci` only; `npm audit --audit-level=high` blocking; tests run against compose services
  (postgres, keycloak); add an integration job that runs against TechZone only when secrets exist
  and is marked skipped (not passed) otherwise.
- Add `helmet`, `express-rate-limit`, JSON body limit, upload size/type checks (magic bytes),
  and remove hard-coded passwords from docker-compose (use `.env`).

### Phase B — FileNet, real (A4) — after H-01/H-02 merge

**H-05 FileNetGraphQLContentStore with real calls.** Use Content Services GraphQL:
- Endpoint: `${FILENET_GRAPHQL_URL}` (ends with `/content-services-graphql/graphql`).
  Auth: Basic (service user) or bearer, from env. XSRF: generate a UUID per client and send it as
  both header `ECM-CS-XSRF-Token: <uuid>` and cookie `ECM-CS-XSRF-Token=<uuid>`.
- Upload: multipart POST, field `graphql` = `{"query": "mutation ($contvar:String) { createDocument(repositoryIdentifier: ..., classIdentifier: \"TF_Bid\", fileInFolderIdentifier: ..., documentProperties: { name: ..., properties: [...], contentElements: { replace: [{ type: CONTENT_TRANSFER, contentType: ..., subContentTransfer: { content: $contvar, retrievalName: ... } }] } }, checkinAction: {}) { id name } }", "variables": {"contvar": null}}`
  and a file part named `contvar`. For large files set `ECM-CS-Use-Multipart-Streaming: true`,
  put the graphql part first, and set contentType and retrievalName explicitly.
- Download: query `document(...) { contentElements { ... on ContentTransfer { downloadUrl } } }`
  then GET base URL + downloadUrl (or `/content-services-graphql/content?repositoryIdentifier=..&documentId=..&elementSequenceNumber=0`), streamed.
- Implement search (by TF_TenantId, TF_TenderId, TF_VendorId, TF_DocType), versions (checkout /
  checkin as new version for addenda and bid replacement), permissions (replace ACL), ping
  (query repository displayName — real call).
- Verify every query and mutation shape in GraphiQL on the TechZone instance first and save the
  working queries in `services/content-adapter/graphql/*.graphql`. Do not guess field names.

**H-06 Provisioning, honest.**
- Introspect the schema in GraphiQL. If class/property definitions can be created through
  GraphQL, script it idempotently. If not, write `provision/ACCE-RUNBOOK.md` (exact clicks in ACCE)
  plus `provision/verify.js`, which queries the repository and exits non-zero listing any missing
  class, property, folder or group. Never print success for something not verified.
- Classes: TF_VendorDocument, TF_TenderPack, TF_Addendum, TF_Clarification, TF_Bid, TF_OpeningRecord,
  TF_EvaluationSheet, TF_CommitteeReport. Properties: TF_TenantId, TF_TenderId, TF_VendorId,
  TF_DocType, TF_Language, TF_Confidentiality, TF_Sha256. Folders `/TenderFlow/<tenant>/<tender>/{pack,addenda,bids,opening,evaluation}`.
- Bid documents: ACL = TenderFlow service account only until opening; at opening the API adds
  the tender's committee group (READ). Content is ciphertext anyway (H-03).

**H-07 Turn FileNet on.** `CONTENT_STORE_TYPE=filenet` in the hosted compose; contract tests run
against both stores; evidence = Navigator screenshots of each demo step's documents.

### Phase C — watsonx Orchestrate, real (A5, with A2 for tool endpoints) — after H-01/H-05

**H-08 Grounded AI tools in the API (A2).**
- Text extraction for tender documents (PDF via `pdf-parse` or `unpdf`; DOCX via `mammoth`),
  chunked with section numbers, cached in PostgreSQL per document version.
- OpenAPI 3.0 spec `agents/tools/tenderflow-ai-tools.openapi.yaml` (servers = public API URL)
  with operations, each enforcing the caller's permissions:
  `getPublishedTenderPack(tenderId)` → chunks with doc id, title, section;
  `listClarifications(tenderId)`; `getTenderTemplateClauses(tenantId, tenderType)`;
  `getDraftTenderPack(tenderId)` (procurement only);
  `getOpenedBidDocuments(tenderId, bidId)` → 403 until opening.
- Identity propagation (ADR-007): when the API starts an agent run it mints a short-lived
  (10 min) signed `ai_session` token bound to user, tenant, tender and allowed operations. Every
  tool operation requires it as a parameter and enforces it. The Orchestrate connection itself
  uses a team bearer service credential limited to the AI-tool routes.
- Remove `ai-advisory.ts` canned logic. Bid screener returns a **compliance checklist only**
  (required document present / missing, with page references) — no scores.

**H-09 Agents in ADK format (A5).**
- Install ADK: `pip install --upgrade ibm-watsonx-orchestrate`. Connect:
  `orchestrate env add -n techzone -u "$WXO_INSTANCE_URL" --type ibm_iam --activate` then
  `orchestrate env activate techzone --api-key "$WXO_API_KEY"` (expires every 2 hours).
- Connection: `orchestrate connections add -a tenderflow_api`;
  `orchestrate connections configure -a tenderflow_api --env draft -t team -k bearer` (repeat for `--env live`);
  `orchestrate connections set-credentials -a tenderflow_api --env draft --token "$TF_TOOL_SERVICE_TOKEN"` (and live).
- Tools: `orchestrate tools import -k openapi -f agents/tools/tenderflow-ai-tools.openapi.yaml -a tenderflow_api`.
- Agents: rewrite each YAML as
  `spec_version: v1`, `kind: native`, `name`, `description`, `llm: <model from orchestrate models list>`,
  `style: default` (or `react_core` if skills are needed), `instructions`, `tools: [operation names]`;
  import with `orchestrate agents import -f <file>`. Check every command and field against the
  current ADK docs (https://developer.watson-orchestrate.ibm.com/llms.txt) before using it.
- Instructions must require: answer only from tool results; cite document title and section;
  answer in the question's language; say "not found in the tender documents" when unsupported;
  never approve, reject, score or publish.
- `agents/import.sh`: idempotent, `set -euo pipefail`, no mock mode, prints each imported item and
  ends with `orchestrate agents list` output saved to docs/evidence.

**H-10 Calling the agents from TenderFlow (A2 + A5).**
- `services/api/src/integrations/orchestrate-client.ts`: obtains an IAM token from
  `WXO_API_KEY`, invokes the agent through the Orchestrate runs/chat API for the instance, passes
  the user's question plus the `ai_session` token, returns the answer and tool-call sources.
  Find the exact endpoint in the ADK/API docs and record it in ADR-007; do not guess.
- Every AI result stored (prompt, answer, sources, model, user, timestamps) and audited
  `AI_ADVISORY_GENERATED`; human approve/edit/reject recorded `AI_ADVISORY_REVIEWED`.
- Optional: embed the Orchestrate web chat in the procurement app for free-form questions.

**H-11 Real evaluations (A5).**
- `agents/evals/run-evals.js` sends each of the 40 questions through H-10 against seed tenders
  stored in FileNet, compares with expected answers (exact facts + required citation), records
  pass/fail per question with the raw answer, and writes results.md. Report the true rate.
  If below 80% in either language, A5 tunes instructions/model and reports what changed.

### Phase D — Product completeness (A3, A1, A2, A6)

**H-12 Apps wired to the API (A3).**
- Keycloak login in all three apps (`next-auth` with Keycloak provider, or `keycloak-js`); token
  sent on every call; tenant from the token; role-based navigation.
- Real pages: vendor registration & documents, tender list/detail/download pack, clarification Q&A,
  bid submit (with receipt showing SHA-256 and server timestamp), my bids; procurement: tender
  drafting with template and pack upload, AI pack check with findings + accept/ignore, approval,
  publish, clarification inbox with AI draft + edit + approve, addendum issue, opening session,
  compliance checklist, evaluation scoring by evaluators, award, reports; control panel: tenant
  config package import, users/roles (via Keycloak admin API), categories, templates, labels,
  branding, audit log viewer with chain verification.
- Loading, empty and error states; Arabic/English with RTL; keyboard and labels (WCAG 2.1 AA basics).
- Playwright E2E drives the browser through all 10 demo steps with real logins.

**H-13 Documents generated by the product (A2).**
- Opening record and committee report as PDF with correct Arabic shaping and RTL: render HTML
  with the tenant branding and print with headless Chromium (Playwright `page.pdf`). Store in
  FileNet as TF_OpeningRecord / TF_CommitteeReport.

**H-14 Notifications (A2).** Email through SMTP (Mailpit in dev) on registration decision,
publication, addendum, clarification answer, deadline reminder, opening, award. Bilingual templates.

**H-15 Audit (A2).** Audit events in PostgreSQL, append-only (revoke UPDATE/DELETE), hash chain
with HMAC key from env (no default), `GET /audit-logs/verify` returning chain status.
AUDITOR role read-only.

**H-16 Operations (A6).** install.sh fails fast; secrets from `.env`; backup + restore tested;
structured JSON logs with request id; Prometheus metrics endpoint; SBOM; image scan (Trivy).

**H-17 Docs & ESA pack (A1 + A0).** Update install, admin, user (AR/EN) and API guides from the
real product; release notes v1.0.0-rc1 listing only evidenced features; ESA questionnaire
updated with real screenshots, the real architecture, FileNet and Orchestrate roles, and the
repeatability timings from evidence.

## 5. Sequence and parallelism

1. Phase A (H-01..H-04) — A2 and A6 in parallel; A0 docs correction immediately.
2. Phase B (H-05..H-07, A4) and Phase C tool endpoints (H-08, A2) start once H-01/H-02 merge.
   A5 can start H-09 setup (ADK, connection, model choice, Arabic test) on day 1.
3. H-10/H-11 after H-05 and H-08.
4. A3 starts H-12 on day 1 against the OpenAPI contract and wires each page as endpoints land.
5. H-13..H-17 last; A1 writes docs continuously from evidence.

Shared contracts (openapi.yaml, ContentStore, state model, tenant schema, ai-tools OpenAPI) change
only through PRs reviewed by A0 and the affected owners.

## 6. Environment variables the code must read (never commit values)

```
DATABASE_URL
KEYCLOAK_ISSUER_URL, KEYCLOAK_AUDIENCE, KEYCLOAK_ADMIN_CLIENT_ID, KEYCLOAK_ADMIN_CLIENT_SECRET
CONTENT_STORE_TYPE=filenet|filesystem
FILENET_GRAPHQL_URL, FILENET_OBJECT_STORE, FILENET_SERVICE_USER, FILENET_SERVICE_PASSWORD, FILENET_CA_CERT
BID_MASTER_KEY, AUDIT_SIGNING_KEY, AI_SESSION_SIGNING_KEY
WXO_INSTANCE_URL, WXO_API_KEY, WXO_AGENT_IDS (json), TF_TOOL_SERVICE_TOKEN, PUBLIC_API_BASE_URL
SMTP_HOST, SMTP_PORT, SMTP_FROM
```
Missing required variables = startup error naming the variable.

## 7. Each agent's first message back

Before writing code, each agent replies in its handoff file with: the findings above that it
owns, anything it disagrees with (with file and line), its task list with order, and the
external facts it must verify (GraphQL field names, ADK commands, Orchestrate run endpoint).
Then start.

## 8. Stop and ask a human (docs/agents/QUESTIONS.md) when
- a TechZone credential or access is missing or expired;
- a GraphQL operation or ADK command does not behave as documented;
- an AI eval language rate stays below 80% after two tuning rounds;
- a security test can only pass by weakening a rule;
- the same failure survives two fix attempts.
