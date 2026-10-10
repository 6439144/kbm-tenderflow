# TenderFlow v1.0 — Build Spec (single source of truth, Fri 9 Oct 2026)

Built by Claude's agents on branch `claude/v1-full-cycle`. Supersedes TONIGHT.md and the v0.9 code
where they conflict. Rules 9–13 in AGENTS.md apply: no simulated success, no canned AI, no claims
without evidence.

## 0. Deployment model (added for 1.0: dedicated entity edition)

One installation per government entity (`TENANCY_MODE=dedicated`, the default; `ENTITY_ID` required in production).
Every request is bound to that entity: sign-in and supplier registration need no entity id, any other entity id is
answered with 404, tokens of another entity are refused, entity creation is disabled, jobs are scoped, and the public
board and feeds show only the entity. `TENANCY_MODE=shared` (several entities, the original multi-tenant behaviour) is
kept for KBM's multi-entity demo and the tests. Full description: [DEPLOYMENT-MODEL.md](DEPLOYMENT-MODEL.md).
Where sections below say "tenant", read "entity"; in a dedicated installation there is exactly one.

## 1. The full cycle (what the product does, end to end)

| # | Stage | Actor (role) | What happens | Stored where | Status after |
|---|---|---|---|---|---|
| 1 | Vendor registration | Vendor (self-service) | Registers company + uploads CR/licence docs | PG `vendors`; docs → content store (class TF_Document, docType VENDOR_DOCUMENT) | vendor `PENDING_REVIEW` |
| 2 | Vendor approval | Procurement officer | Reviews docs, approves or rejects with reason | PG + audit | vendor `APPROVED` / `REJECTED` |
| 3 | Tender drafting | Procurement officer | Creates tender (bilingual title, category, budget, deadline, evaluation criteria + weights, required bid documents), uploads tender pack files | PG `tenders`; pack → content store (TENDER_PACK) | tender `DRAFT` |
| 4 | AI pack check (advisory) | Officer triggers; Orchestrate agent `tender-pack-checker` | Pack text extracted from content store → agent → findings with citations; officer marks each accepted/ignored | PG `ai_runs` + audit | unchanged |
| 5 | Approval | Director (≠ creator) | Approves for publication or returns with reason | PG + audit | `APPROVED` / back to `DRAFT` |
| 6 | Publication | Procurement officer | Publishes; approved vendors in the tender category can see it and download the pack | PG + audit | `PUBLISHED` |
| 7 | Clarifications | Vendor asks; officer answers | Vendor question → officer optionally asks Orchestrate agent `clarification-assistant` for a cited draft → officer edits and publishes answer; answers visible to all vendors; officer may issue an addendum file (new TENDER_PACK doc, flagged addendum) | PG `clarifications`, addendum → content store | unchanged |
| 8 | Sealed bid submission | Vendor (approved) | Uploads technical + financial files before deadline; server encrypts each file with a per-bid AES-256-GCM data key (wrapped by BID_MASTER_KEY) and stores ciphertext in content store; vendor gets receipt (bid id, SHA-256 of plaintext, server UTC time) | PG `bids` (+ wrapped key, iv, tag per file); ciphertext → content store (BID_TECHNICAL / BID_FINANCIAL) | bid `SEALED` |
| 9 | Close | System | At/after deadline the tender closes (checked on every read/write and by a 1-minute interval job) | PG + audit (actor SYSTEM) | `CLOSED` |
| 10 | Opening | Committee chair | Allowed only when `CLOSED` and now ≥ deadline; records attendees; all bids unsealed; opening record generated (bilingual HTML) and stored | PG `openings`; record → content store (OPENING_RECORD) | `OPENED`, bids `OPENED` |
| 11 | Compliance screening (advisory) | Chair/evaluator triggers; Orchestrate agent `bid-compliance-screener` | For each opened bid, decrypted text vs required-document list → checklist PRESENT / MISSING / UNCLEAR with evidence. **No scores.** | PG `ai_runs` + audit | unchanged |
| 12 | Evaluation | Evaluators | Each evaluator scores each bid per criterion (0–100) with comment; weighted total computed | PG `evaluations` | `EVALUATION` (on first score) |
| 13 | Award | Committee chair recommends, director approves (≠ chair) | Recommendation (bid + justification) → director approves → committee report (bilingual HTML: bids, scores, compliance, decision) generated and stored | PG `awards`; report → content store (COMMITTEE_REPORT) | `AWARDED` |
| 14 | Audit | Auditor / admin | Every state change and privileged action in an append-only, HMAC-chained audit log; `GET /audit/verify` checks the chain | PG `audit_events` | — |

Tender states: `DRAFT → APPROVED → PUBLISHED → CLOSED → OPENED → EVALUATION → AWARDED` (+ `CANCELLED` from DRAFT/APPROVED/PUBLISHED by director with reason).

## 2. Roles (JWT `roles` claim) and tenancy
`VENDOR`, `PROCUREMENT_OFFICER`, `DIRECTOR`, `COMMITTEE_CHAIR`, `EVALUATOR`, `TENANT_ADMIN`, `AUDITOR`.
Tenant comes **only** from the JWT `tenant_id` claim. Every query filters by tenant_id. Vendors are per tenant.
Segregation of duties: approver ≠ tender creator; award approver (director) ≠ recommending chair.

## 3. Architecture decisions (tonight)
- **One deployable**: `services/api` (Express, TypeScript, Node ≥ 20) serves the REST API at `/api/v1` **and** the built web app (`apps/web/dist`) at `/`. One command: `npm run build && npm start`. Default port 4000.
- **Database**: PostgreSQL. If `DATABASE_URL` is set → `pg` Pool. Otherwise → **PGlite** (`@electric-sql/pglite`, real Postgres in-process) persisted at `DATA_DIR/pg` (default `./data/pg`). Same SQL for both. Numbered migrations in `services/api/migrations/NNN_name.sql`, applied at startup, tracked in `schema_migrations`.
- **Identity**: TenderFlow's own OIDC-style token service in the API: users table (bcryptjs hashes), `POST /api/v1/auth/login` issues **RS256** JWTs (iss = `PUBLIC_BASE_URL`, aud = `tenderflow`, 8 h). Signing key: `JWT_PRIVATE_KEY_PEM` env, else generated once and persisted in DB table `signing_keys`. JWKS at `/.well-known/jwks.json`. Verifier accepts this issuer, plus an optional external IdP (`EXTERNAL_OIDC_ISSUER`, `EXTERNAL_OIDC_AUDIENCE`, verified via its JWKS — Keycloak/Entra/AD FS). **No symmetric secrets, no test secret in src.** Tests create users through the same service.
- **Content store**: interface in `services/api/src/content/types.ts`. `FILENET` (Content Services GraphQL, real calls) or `FILESYSTEM` (dev/tests, under `DATA_DIR/content`). Selected by `CONTENT_STORE_TYPE`. If `filenet` is selected and unreachable → startup `/ready` reports down; uploads fail with 503. No fallback.
- **AI**: watsonx Orchestrate, invoked **outbound** from the API (no inbound tool callbacks needed tonight, so no public URL is required). The API retrieves documents from the content store, extracts text, and sends it with the task to the Orchestrate agent; agent instructions require answers only from the provided text, with citations (document title + section/page). If `WXO_INSTANCE_URL`/`WXO_API_KEY` are missing → AI endpoints return **503 AI_NOT_CONFIGURED** (never canned output). OpenAPI callback tools are roadmap.
- **Text extraction**: `services/api/src/content/extract.ts` — PDF (`unpdf` or `pdf-parse`), DOCX (`mammoth`), TXT/MD/HTML (strip tags). Returns `[{section, text}]` (page or heading based).
- **Reports**: opening record and committee report as bilingual **HTML** documents (RTL Arabic + English), stored in the content store. PDF rendering is roadmap.
- **Web app**: `apps/web` — Vite + React + TypeScript SPA, React Router, three portals: `/vendor`, `/procurement` (officer, director, chair, evaluator), `/admin` (tenant admin, auditor). Arabic (RTL) / English toggle. Calls the API on the same origin with the JWT from login (stored in sessionStorage).
- **Removed**: old fake Next.js apps (`apps/vendor-portal`, `apps/procurement-app`, `apps/control-panel`), `packages/ui`, `services/content-adapter` (moved into `services/api/src/content`), canned `ai-advisory.ts`, fake evals. Kept: docs, seed data (reused), ADRs (updated later).

## 4. Environment variables
```
PORT=4000
PUBLIC_BASE_URL=http://localhost:4000
DATA_DIR=./data
DATABASE_URL=                      # optional; empty → embedded PGlite
JWT_PRIVATE_KEY_PEM=               # optional; empty → generated & persisted
EXTERNAL_OIDC_ISSUER= / EXTERNAL_OIDC_AUDIENCE=   # optional
BID_MASTER_KEY=                    # required, 32 bytes base64 (startup fails without)
AUDIT_SIGNING_KEY=                 # required (startup fails without)
SEED_DEMO=true                     # seed demo tenants/users/data on first start
DEMO_PASSWORD=                     # required when SEED_DEMO=true
CONTENT_STORE_TYPE=filesystem|filenet
FILENET_GRAPHQL_URL= FILENET_OBJECT_STORE= FILENET_SERVICE_USER= FILENET_SERVICE_PASSWORD=
FILENET_DOC_CLASS=Document          # TF_Document once created in ACCE
FILENET_ROOT_FOLDER=/TenderFlow
WXO_INSTANCE_URL= WXO_API_KEY= WXO_IAM_URL=https://iam.cloud.ibm.com/identity/token
WXO_AGENT_PACK_CHECKER= WXO_AGENT_CLARIFICATION= WXO_AGENT_COMPLIANCE=   # agent ids or names
```
`scripts/gen-keys.mjs` prints fresh BID_MASTER_KEY and AUDIT_SIGNING_KEY values.

## 5. Data model (PostgreSQL)
```
tenants(id text pk, name_en, name_ar, primary_color, status, created_at)
users(id uuid pk, tenant_id, username unique-per-tenant, password_hash, display_name, roles text[], vendor_id null, active bool, created_at)
signing_keys(kid pk, private_pem, public_jwk jsonb, created_at)
vendors(id uuid pk, tenant_id, legal_name_en, legal_name_ar, cr_number, email, phone, categories text[], status, decision_reason, decided_by, created_at, decided_at)
documents(id uuid pk, tenant_id, owner_type ['VENDOR','TENDER_PACK','ADDENDUM','BID_TECHNICAL','BID_FINANCIAL','OPENING_RECORD','COMMITTEE_REPORT'], owner_id, tender_id null, vendor_id null, bid_id null, title, mime_type, byte_size, sha256_plain, store_type, store_ref, encrypted bool, enc_iv, enc_tag, uploaded_by, created_at)
tenders(id uuid pk, tenant_id, tender_number unique-per-tenant, title_en, title_ar, description_en, description_ar, category, estimated_budget numeric, currency, submission_deadline timestamptz, criteria jsonb [{key,name_en,name_ar,weight}], required_documents jsonb [{key,name_en,name_ar}], status, created_by, approved_by, published_at, closed_at, opened_at, awarded_at, created_at, updated_at)
clarifications(id uuid pk, tenant_id, tender_id, vendor_id, question, language, answer, answered_by, status ['OPEN','ANSWERED'], ai_run_id null, created_at, answered_at)
bids(id uuid pk, tenant_id, tender_id, vendor_id, status ['SEALED','OPENED'], wrapped_key, wrap_iv, wrap_tag, receipt_sha256, submitted_at, opened_at)  unique(tender_id,vendor_id)
openings(id uuid pk, tenant_id, tender_id unique, chair_id, attendees jsonb, notes, record_document_id, opened_at)
evaluations(id uuid pk, tenant_id, tender_id, bid_id, evaluator_id, scores jsonb [{criterion,score,comment}], weighted_total numeric, submitted_at) unique(bid_id, evaluator_id)
awards(id uuid pk, tenant_id, tender_id unique, bid_id, recommended_by, justification, approved_by, status ['RECOMMENDED','APPROVED'], report_document_id, created_at, approved_at)
ai_runs(id uuid pk, tenant_id, tender_id, kind ['PACK_CHECK','CLARIFICATION_DRAFT','COMPLIANCE_SCREEN'], agent, model, request jsonb, response jsonb, citations jsonb, status ['OK','ERROR'], error, requested_by, reviewed_by, review_decision, created_at)
audit_events(seq bigserial pk, id uuid, tenant_id, actor_id, actor_roles text[], action, resource_type, resource_id, prev_state, new_state, reason, details jsonb, at timestamptz, prev_hmac, hmac)  -- append-only (no UPDATE/DELETE in code; trigger raises on update/delete)
```

## 6. REST API (all JSON; `Authorization: Bearer <jwt>`; errors `{code,message}`)
Auth & meta
- `GET /api/v1/public/deployment` → {mode: 'dedicated'|'shared', entity: {id,nameEn,nameAr,primaryColor,logoText}|null}  (public)
- `POST /api/v1/auth/login` {tenantId (optional in a dedicated installation; must be its entity), username, password} → {token, user:{id,username,displayName,roles,tenantId,vendorId}}  (public)
- `GET /api/v1/auth/me` → user
- `GET /api/v1/public/tenants` → [{id,nameEn,nameAr,primaryColor}]  (public)
- `GET /health` (process) · `GET /ready` (real checks: db, content store ping, ai configured/ok; anonymous callers and probes get `{status}` only, details for a signed-in TENANT_ADMIN/AUDITOR — docs/SECURITY-FEATURES.md §6.4)
- `GET /.well-known/jwks.json`

Vendors
- `POST /api/v1/public/vendors/register` {tenantId (optional in a dedicated installation; must be its entity), legalNameEn, legalNameAr, crNumber, email, phone, categories[], username, password} → vendor (public; creates PENDING vendor + VENDOR user)
- `POST /api/v1/vendors/me/documents` multipart(file, title) → document  (VENDOR)
- `GET /api/v1/vendors` ?status= (OFFICER, DIRECTOR, ADMIN, AUDITOR) · `GET /api/v1/vendors/:id` (+documents)
- `POST /api/v1/vendors/:id/decision` {decision:'APPROVE'|'REJECT', reason} (OFFICER)
- `GET /api/v1/vendors/me` (VENDOR)

Tenders
- `GET /api/v1/tenders` — vendors: only PUBLISHED+ in their categories (and only if vendor APPROVED); staff: all in tenant; `?status=`
- `POST /api/v1/tenders` (OFFICER) · `PATCH /api/v1/tenders/:id` (OFFICER, DRAFT only) · `GET /api/v1/tenders/:id` (+documents visible to caller, clarifications visible to caller, bid count; staff see ai_runs)
- `POST /api/v1/tenders/:id/documents` multipart(file, title, addendum?) (OFFICER; DRAFT, or PUBLISHED when addendum=true)
- `POST /api/v1/tenders/:id/ai/pack-check` (OFFICER) → ai_run · `POST /api/v1/ai-runs/:id/review` {decision:'ACCEPTED'|'IGNORED'|'EDITED', note}
- `POST /api/v1/tenders/:id/approve` {reason} (DIRECTOR, ≠ creator) · `POST /api/v1/tenders/:id/return` {reason} (DIRECTOR)
- `POST /api/v1/tenders/:id/publish` (OFFICER) · `POST /api/v1/tenders/:id/cancel` {reason} (DIRECTOR)

Clarifications
- `POST /api/v1/tenders/:id/clarifications` {question} (VENDOR, PUBLISHED, before deadline)
- `POST /api/v1/clarifications/:id/ai-draft` (OFFICER) → ai_run with draft + citations
- `POST /api/v1/clarifications/:id/answer` {answer} (OFFICER) → published to all vendors of the tender

Bids
- `POST /api/v1/tenders/:id/bids` multipart(technical file, financial file) (VENDOR APPROVED, PUBLISHED, now < deadline, one bid per vendor; resubmission replaces before deadline) → receipt {bidId, submittedAt, receiptSha256, files:[{title, sha256}]}
- `GET /api/v1/tenders/:id/bids` — vendor: own bid receipt only; staff: list with vendor names and status only (no file access) until OPENED
- `GET /api/v1/bids/:id/documents/:docId` → decrypted stream; staff COMMITTEE_CHAIR/EVALUATOR/DIRECTOR only, only after OPENED; vendor: own files only (always)

Opening, screening, evaluation, award
- `POST /api/v1/tenders/:id/open` {attendees[], notes} (COMMITTEE_CHAIR; CLOSED and now ≥ deadline) → opening + record document
- `POST /api/v1/tenders/:id/ai/compliance-screen` (COMMITTEE_CHAIR, EVALUATOR; OPENED+) → ai_run
- `POST /api/v1/bids/:id/evaluation` {scores:[{criterion,score,comment}]} (EVALUATOR; OPENED/EVALUATION) → evaluation
- `GET /api/v1/tenders/:id/evaluations` (CHAIR, DIRECTOR, EVALUATOR-own)
- `POST /api/v1/tenders/:id/award/recommend` {bidId, justification} (COMMITTEE_CHAIR)
- `POST /api/v1/tenders/:id/award/approve` {reason} (DIRECTOR, ≠ recommender) → award + committee report document

Documents (generic download, deny by default)
- `GET /api/v1/documents/:id` → stream if caller allowed by owner_type rules: VENDOR docs → that vendor + staff; TENDER_PACK/ADDENDUM → staff always, vendors only if tender PUBLISHED+; BID_* → only via bids route rule; OPENING_RECORD/COMMITTEE_REPORT → staff. Unknown id or other tenant → 404.

Admin & audit
- `GET /api/v1/admin/users` · `POST /api/v1/admin/users` {username, displayName, roles[], password} (TENANT_ADMIN)
- `GET /api/v1/audit` ?resourceId=&limit= (AUDITOR, TENANT_ADMIN, DIRECTOR) · `GET /api/v1/audit/verify` → {valid, count, brokenAt?}
- `GET /api/v1/dashboard` → counts by tender status, vendors pending, bids, AI runs (staff)

## 7. Demo seed (SEED_DEMO=true, first start only)
Tenants `kea` (Kuwait Energy Authority — fictitious) and `ministry_a`. Users per tenant, password = DEMO_PASSWORD:
`officer`, `director`, `chair`, `evaluator1`, `evaluator2`, `admin`, `auditor`, vendors `vendor1`..`vendor3` (approved, category IT), `vendor4` (pending).
Tenders for `kea`: one DRAFT with pack files (from `seed/files/`), one PUBLISHED with deadline +2 days and 2 clarifications, one CLOSED (deadline −1 hour) with 3 sealed bids ready to open. Seed goes through the same services (so files land in the configured content store and bids are encrypted).

## 8. File ownership (agents must not edit outside their area)
- **Backend agent**: `services/api/**` except `services/api/src/ai/**` and `services/api/src/content/filenet-store.ts`; root `package.json`, `scripts/`, `seed/`.
- **AI agent**: `services/api/src/ai/**`, `agents/**`.
- **Web agent**: `apps/web/**`.
- **Lead (Claude)**: `services/api/src/content/filenet-store.ts`, `docs/**`, `deploy/**`, integration and verification.

AI service interface (backend calls it; AI agent implements it) — `services/api/src/ai/index.ts`:
```ts
export interface DocText { documentId: string; title: string; sections: { section: string; text: string }[] }
export interface Citation { documentId: string; title: string; section: string; quote?: string }
export interface AiResult<T> { ok: true; agent: string; model?: string; output: T; citations: Citation[]; raw?: unknown }
export interface PackFinding { severity: 'HIGH'|'MEDIUM'|'LOW'; item: string; detail: string; citation?: Citation }
export interface ClarificationDraft { answer: string; language: 'ar'|'en'; citations: Citation[]; notFound: boolean }
export interface ComplianceItem { requirement: string; status: 'PRESENT'|'MISSING'|'UNCLEAR'; evidence?: string; citation?: Citation }
export interface AiService {
  isConfigured(): boolean;
  ping(): Promise<{ ok: boolean; detail: string }>;
  checkTenderPack(input: { tender: { titleEn: string; titleAr: string; category: string; deadline: string; criteria: unknown; requiredDocuments: unknown }; documents: DocText[]; language: 'ar'|'en' }): Promise<AiResult<{ findings: PackFinding[]; summary: string }>>;
  draftClarification(input: { tender: { titleEn: string; titleAr: string }; question: string; documents: DocText[]; priorAnswers: { question: string; answer: string }[] }): Promise<AiResult<ClarificationDraft>>;
  screenCompliance(input: { requiredDocuments: { key: string; nameEn: string; nameAr: string }[]; bid: { bidId: string; vendorName: string; documents: DocText[] } }): Promise<AiResult<{ items: ComplianceItem[] }>>;
}
export class AiNotConfiguredError extends Error { code = 'AI_NOT_CONFIGURED' }
export function createAiService(): AiService;
```
Content store interface — `services/api/src/content/types.ts`:
```ts
export interface StoredObject { storeRef: string; storeType: 'filesystem'|'filenet'; byteSize: number }
export interface ContentStore {
  type: 'filesystem'|'filenet';
  ping(): Promise<{ ok: boolean; detail: string }>;
  put(input: { tenantId: string; folderPath: string; fileName: string; mimeType: string; bytes: Buffer; properties: Record<string,string> }): Promise<StoredObject>;
  get(storeRef: string): Promise<Buffer>;
}
```
