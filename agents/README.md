# TenderFlow AI agents (watsonx Orchestrate)

TenderFlow's AI layer is eleven **advisory** watsonx Orchestrate native agents: nine specialists that cover the whole
tender cycle, the supervisor **`tenderflow_assistant`** (the copilot shown in every portal) that lists the nine as
ADK `collaborators`, and the **`tenderflow_admin_builder`** that turns an administrator's plain-language request into a
validated, draft-only configuration change proposal ([docs/ADMIN-AI-BUILDER.md](../docs/ADMIN-AI-BUILDER.md)). The API (`services/api/src/ai/`) gathers the input — records from the database and document text
extracted from the content store (IBM FileNet) — and sends it **outbound** to the agent; the agent answers only from that
input and returns JSON (with citations where documents are involved). TenderFlow validates every answer, records it as an
`ai_run` (+ audit) and shows it as advice; a person takes every decision. There are no inbound callbacks in the default
flow (an optional read-only OpenAPI tool pack is described in [`tools/README.md`](tools/README.md)).

| # | Agent (name on the instance) | Cycle stage → TenderFlow screen | Who | Output (validated by TenderFlow) |
|---|---|---|---|---|
| 1 | `tenderflow_request_classifier` | Request intake → request detail, "Classify with Orchestrate" (`POST /requests/:id/ai/classify`) | staff | `{tenderType, activityCodes[], urgency LOW/MEDIUM/HIGH, estimatedBudget\|null, summaryEn, summaryAr, citations[]}` — codes must come from the lists, the budget from the text |
| 2 | `tenderflow_pack_checker` | Draft → pack check (`POST /tenders/:id/ai/pack-check`) | officer | `{summary, findings[{severity, item, detail, citation}]}` |
| 3 | `tenderflow_notice_drafter` | Publication → Kuwait Al-Youm / CAPT notice (`POST /tenders/:id/ai/notice`), saved as a DRAFT notice by the officer, approved by another person | officer | `{noticeAr, noticeEn, citations[]}` — every number must appear in the facts/pack |
| 4 | `tenderflow_relevance_matcher` | Published → rank eligible vendors (`POST /tenders/:id/ai/relevance`); vendor home "Tenders for you" (`GET/POST /vendor/ai/tenders-for-me`) | staff / vendor | `{ranked[{id, score 0-100, reasonsEn, reasonsAr}]}` — candidates are only those that passed the rule-based eligibility; ids cannot be added |
| 5 | `tenderflow_clarification_assistant` | Clarifications → draft answer (`POST /clarifications/:id/ai-draft`) | officer | `{answer, language, notFound, citations[]}` |
| 6 | `tenderflow_compliance_screener` | Opening → compliance screen (`POST /tenders/:id/ai/compliance-screen`) | chair / evaluator | `{items[{requirement, status PRESENT/MISSING/UNCLEAR, evidence, citation}]}` (no scores) |
| 7 | `tenderflow_evaluation_narrator` | Evaluation/award → committee narrative (`POST /tenders/:id/ai/narrative`), saved to FileNet by the chair (`POST /ai-runs/:id/save-narrative`) | chair | `{narrativeEn, narrativeAr}` — rejected if it quotes any number that is not in the evaluation data |
| 8 | `tenderflow_grade_reviewer` | Vendor grading → document checklist (`POST /vendors/:id/ai/grade-review {grade}`) | officer / admin | `{items[{requirement, status PRESENT/MISSING/UNCLEAR, evidence, citation}]}` against a configurable checklist (`WXO_GRADE_CRITERIA`) |
| 9 | `tenderflow_document_intelligence` | Every upload (vendor documents, tender pack/addenda, GM letters; sealed bids only after opening) → document row "Data" panel, Procurement → Document intelligence (`POST /documents/:id/ai/classify`, automatic queue) | staff / vendor (own documents) | `{docType, language, fields[{key, value, citation{section, quote}}], summaryEn, summaryAr, citations[]}` — docType from the entity catalogue, keys defined for that type, every quote must occur in the sent text, dates → ISO, amounts → number + currency. See [docs/DOCUMENT-INTELLIGENCE.md](../docs/DOCUMENT-INTELLIGENCE.md) |
| 10 | `tenderflow_assistant` (supervisor; collaborators 1-9) | Every signed-in page → assistant dock (`POST /assistant/chat`) | everyone | `{answer, notFound, citations[]}` from a role-scoped context built by TenderFlow (user, pending tasks, entity rules, the visible tender) — never bid contents or other vendors' data; thread id kept per user for follow-ups |
| 11 | `tenderflow_admin_builder` | Administration → Admin → AI builder (`POST /admin-agent/chat`), proposals reviewed and applied as DRAFTS by a TENANT_ADMIN (`POST /admin-agent/proposals/:id/apply`) | TENANT_ADMIN (auditors read) | `{reply{en,ar}, operations[], questions[]}` — only the nine catalogue operations (templates, rules, form fields/sections, document types) with exactly the documented keys; every operation is then validated by TenderFlow's own validators against the entity's configuration; never publishes, never touches users/roles or locked controls |

**Supervisor and collaborators.** TenderFlow calls each specialist directly for its own screen (deterministic input,
strict validation). The supervisor answers the chat itself from the context TenderFlow sends; its `collaborators:` list
lets it delegate a full specialist task when someone uses it in the Orchestrate chat UI. Import order therefore matters:
the nine collaborators first, the supervisor last (the scripts do this).

If the instance is not configured or a call fails, the API raises an error (`AI_NOT_CONFIGURED` / Orchestrate error /
invalid-output error). It never returns canned output (AGENTS.md rules 9–11).

## Prerequisites (Windows)

- Python **3.11+** (python.org installer, tick "Add python.exe to PATH").
- The ADK CLI: `py -m pip install --upgrade ibm-watsonx-orchestrate` (checked with ADK 2.18.1; it provides the `orchestrate` command).
- Node.js 20+ for the TenderFlow API and the `verify:ai` / `evals` scripts.
- The TechZone "watsonx Orchestrate Dedicated Trial" instance (IBM Cloud) and its API key:
  open the Orchestrate UI → profile icon → **Settings** → **API details** → copy the **service instance URL**, then
  **Generate API key** (this opens IBM Cloud IAM → Create). IBM's docs warn not to use the credentials shown on the IBM
  Cloud resources page. An IBM Cloud API key of the TechZone user that can access the instance is what the IAM flow needs.

## Steps on Windows (PowerShell, from the repo root)

```powershell
# 1. ADK CLI (once)
py -m pip install --upgrade ibm-watsonx-orchestrate
orchestrate --version

# 2. Put the instance settings in the repo .env (never commit it; .env is git-ignored)
#    WXO_INSTANCE_URL=https://api.<region>.watson-orchestrate.cloud.ibm.com/instances/<instance-id>
#    WXO_API_KEY=<your IBM Cloud API key>
#    WXO_IAM_URL=https://iam.cloud.ibm.com/identity/token      (default; may be omitted)
#    optional: WXO_LLM=<model id from step 4>, WXO_TIMEOUT_MS=90000
notepad .env

# 3. Import the eleven agents: 9 collaborators and the admin builder, then the supervisor (adds + activates env "techzone", imports, lists, verifies)
powershell -ExecutionPolicy Bypass -File agents\import.ps1

# 4. If an import fails because the model is not available on your tenant, pick one and re-run step 3:
orchestrate models list
#    → add WXO_LLM=<id from the list> to .env, then run step 3 again

# 5. Build and verify the live integration (exits non-zero on any failure)
npm install
npm run build
npm run verify:ai

# 6. Run the bilingual eval sets against the real agents; writes agents/evals/results.md (clarification)
#    and agents/evals/agents/results.md (the Phase 1 agents and document intelligence)
npm run evals
#    or one part only:  npm run evals -- agents      /  npm run evals -- clarification
```

`import.ps1` stops on the first failing command, never prints the API key, answers the "update existing environment?"
prompt so it can be re-run, and finishes by checking that all eleven agent names exist on the instance.
`agents/import.sh` does the same on Linux/macOS (`bash agents/import.sh`).

Manual equivalent (what the scripts run):

```powershell
orchestrate env add -n techzone -u <WXO_INSTANCE_URL> --type ibm_iam
orchestrate env activate techzone --api-key <WXO_API_KEY>
orchestrate agents import -f agents\tenderflow_pack_checker.yaml
orchestrate agents import -f agents\tenderflow_clarification_assistant.yaml
orchestrate agents import -f agents\tenderflow_compliance_screener.yaml
orchestrate agents import -f agents\tenderflow_request_classifier.yaml
orchestrate agents import -f agents\tenderflow_notice_drafter.yaml
orchestrate agents import -f agents\tenderflow_relevance_matcher.yaml
orchestrate agents import -f agents\tenderflow_evaluation_narrator.yaml
orchestrate agents import -f agents\tenderflow_grade_reviewer.yaml
orchestrate agents import -f agents\tenderflow_document_intelligence.yaml
orchestrate agents import -f agents\tenderflow_admin_builder.yaml
orchestrate agents import -f agents\tenderflow_assistant.yaml   # supervisor last: its collaborators must exist
orchestrate agents list
```

(`env add --activate` is not used because, without `--api-key`, it prompts for the key interactively; activation is
done in a second command with `--api-key`. The CLI's own token from `env activate` expires after about two hours;
re-run `orchestrate env activate techzone --api-key ...` before further CLI work. The TenderFlow API fetches its own
IAM tokens and does not depend on the CLI login.)

### Choosing the model

The YAML files use `watsonx/meta-llama/llama-3-3-70b-instruct` as a placeholder default. **Check it against
`orchestrate models list` on the TechZone tenant** — model availability differs per tenant/region. Prefer a large
multilingual model that handles Arabic well (for example a Llama 3.x 70B, Mistral Large/Medium or `groq/openai/gpt-oss-120b`
if listed); small 8B models are noticeably weaker in Arabic and in strict JSON output. Set `WXO_LLM` in `.env` and
re-run the import script (the repo YAML files are not modified; patched copies go to a temp folder). Then run
`npm run evals` and compare pass rates per model.

## Settings read by the API (`services/api/src/ai/config.ts`)

| Variable | Default | Notes |
|---|---|---|
| `WXO_INSTANCE_URL` | — (required) | Service instance URL from Settings → API details |
| `WXO_API_KEY` | — (required) | IBM Cloud API key; never logged |
| `WXO_IAM_URL` | `https://iam.cloud.ibm.com/identity/token` | A base URL is accepted (`/identity/token` is appended) |
| `WXO_AGENT_PACK_CHECKER` | `tenderflow_pack_checker` | Agent **name** (resolved to id via the list endpoint) or agent **id** (UUID) |
| `WXO_AGENT_CLARIFICATION` | `tenderflow_clarification_assistant` | same |
| `WXO_AGENT_COMPLIANCE` | `tenderflow_compliance_screener` | same |
| `WXO_AGENT_REQUEST_CLASSIFIER` | `tenderflow_request_classifier` | same |
| `WXO_AGENT_NOTICE_DRAFTER` | `tenderflow_notice_drafter` | same |
| `WXO_AGENT_RELEVANCE_MATCHER` | `tenderflow_relevance_matcher` | same |
| `WXO_AGENT_EVALUATION_NARRATOR` | `tenderflow_evaluation_narrator` | same |
| `WXO_AGENT_GRADE_REVIEWER` | `tenderflow_grade_reviewer` | same |
| `WXO_AGENT_DOCUMENT_INTELLIGENCE` | `tenderflow_document_intelligence` | same |
| `WXO_AGENT_ASSISTANT` | `tenderflow_assistant` | same (the supervisor) |
| `WXO_AGENT_ADMIN_BUILDER` | `tenderflow_admin_builder` | same (the AI admin builder) |
| `WXO_GRADE_CRITERIA` | built-in 6-item checklist | JSON checklist for the grade reviewer: `[{"key","nameEn","nameAr"}]` for all grades or `{"1":[...],"2":[...],"3":[...]}`. It is a configurable document checklist, not a statement of grading law |
| `WXO_TIMEOUT_MS` | `60000` | Deadline for one agent call (create run + wait + read answer) |
| `WXO_MAX_DOC_CHARS` | `24000` | Document-text budget per prompt; sections mentioning the key terms are preferred |

`isConfigured()` is true when the URL and API key are set (agent references have defaults).

## How a call works (implemented in `services/api/src/ai/orchestrate-client.ts`)

1. **IAM token** — `POST {WXO_IAM_URL}` with `Content-Type: application/x-www-form-urlencoded`,
   body `grant_type=urn:ibm:params:oauth:grant-type:apikey&apikey=<key>` → `access_token`, `expires_in`, `expiration`.
   Cached until 5 minutes before expiry; refreshed once on a 401.
2. **Resolve agent** — `GET {instance}/v1/orchestrate/agents?names=<name>` → JSON array of agents (`id`, `name`, `llm`, …). Cached.
3. **Run** — `POST {instance}/v1/orchestrate/runs` with `{"message":{"role":"user","content":"<prompt>"},"agent_id":"<id>"}`
   → `{thread_id, run_id, task_id, message_id}`.
4. **Wait** — poll `GET {instance}/v1/orchestrate/runs/{run_id}` until `status` is `completed`
   (`failed`/`cancelled`/`expired`/`requires_input` → error with `last_error`).
5. **Read answer** — `GET {instance}/v1/orchestrate/threads/{thread_id}/messages` → last `role: "assistant"` message;
   text = the `text` of its `content[]` items with `response_type: "text"` (fallback: `result.data.message.content` of the run).
6. **Parse** — extract the JSON object (code fences/prose tolerated), validate the shape, map citations back to the
   provided `documentId`/`section` (invented ones are dropped; quotes are kept only if they occur in that section).
   If invalid, one repair turn is sent **on the same thread**; if still invalid → error.

Every request has a timeout (default 60 s overall per call) and one retry on HTTP 429/5xx. Errors carry the HTTP status
and the (redacted) IBM error body; API key and bearer token are never included.

## What was verified, and where

| Fact | Source |
|---|---|
| IBM Cloud instances use auth type `ibm_iam`; AWS instances use `mcsp` | https://developer.watson-orchestrate.ibm.com/environment/initiate_environment , https://developer.watson-orchestrate.ibm.com/environment/production_import |
| `ibm_iam` token URL is `https://iam.cloud.ibm.com/identity/token`; URLs containing `.cloud.ibm.com` infer `ibm_iam`; MCSP (AWS) uses `https://iam.platform.saas.ibm.com` instead | ADK source, PyPI `ibm-watsonx-orchestrate==2.18.1`: `cli/commands/server/types.py` (`AUTH_TYPE_DEFAULT_URL_MAPPING`), `ibm-watsonx-orchestrate-clients==2.18.1`: `common/service_instance/service_instance.py` (`IAMAuthenticator`). Confirmed at runtime: `orchestrate env activate` on an ibm_iam env calls `iam.cloud.ibm.com/identity/token` |
| IAM API-key grant request/response format | https://ibm-client-engineering.github.io/solution-wxo/watsonx/GettingStarted/auth/ (and IBM Cloud IAM `IAMAuthenticator`) |
| Remote API base is `{instance_url}/v1/orchestrate` | ADK clients `common/base_client.py` (`BaseWXOClient`: non-local → `/v1/orchestrate`) |
| `GET /v1/orchestrate/agents` (`names`, `ids` filters; bare array response) | https://developer.watson-orchestrate.ibm.com/apis/agents/list-registered-agents ; ADK `agents/agent_client.py` (`names=` query) |
| `POST /v1/orchestrate/runs` request (`message`, `agent_id`, `thread_id`) and response (`thread_id`, `run_id`, …) | https://developer.watson-orchestrate.ibm.com/apis/orchestrate-agent/chat-with-orchestrate-assistant ; ADK `chat/run_client.py` (`create_run`) |
| `GET /v1/orchestrate/runs/{run_id}` and status values (`pending`, `running`, `completed`, `failed`, `cancelled`, `requires_input`, `expired`, …) | https://developer.watson-orchestrate.ibm.com/apis/orchestrate-agent/get-orchestrate-assistant-run ; ADK `run_client.wait_for_run_completion` |
| Final answer = last assistant message of the thread, text from `content[]` items with `response_type: "text"` | ADK CLI `cli/commands/chat/chat_controller.py` (`orchestrate chat ask` flow: create_run → wait_for_run_completion → get_thread_messages) |
| Native agent YAML (`spec_version: v1`, `kind: native`, `name`, `description`, `instructions`, `llm`, `style`, `tools`, `collaborators`, `hide_reasoning`); `style` values include `default`, `react`, `planner`, `react_core` | https://developer.watson-orchestrate.ibm.com/agents/build_agent ; ADK `agent_builder/agents/types.py`. All nine YAML files load with ADK 2.18.1 `Agent.from_spec()` (supervisor: 8 collaborators); this is a local schema check, not an import into an instance |
| `collaborators:` is a list of agent **names** (strings); the collaborator's `description` is what the supervisor uses to route | https://developer.watson-orchestrate.ibm.com/agents/build_agent |
| OpenAPI tools: `orchestrate tools import -k openapi -f <spec> -a <app_id>`; bearer connections via `orchestrate connections add/configure -k bearer/set-credentials --token` | https://developer.watson-orchestrate.ibm.com/connections/associate_connection_to_tool/openapi_connections , https://developer.watson-orchestrate.ibm.com/connections/build_connections |
| CLI: `orchestrate env add -n -u --type --activate`, `env activate --api-key` | https://developer.watson-orchestrate.ibm.com/environment/initiate_environment ; `--help` of ADK 2.18.1 |
| `orchestrate agents import -f <file>` (re-import updates an existing agent; `--safe` adds a confirmation) | https://developer.watson-orchestrate.ibm.com/agents/import_agent |
| `orchestrate agents list [-v]`, `orchestrate models list` | `--help` of ADK 2.18.1 |
| `pip install --upgrade ibm-watsonx-orchestrate`, Python 3.11+ | https://developer.watson-orchestrate.ibm.com/getting_started/installing |
| Docs index used | https://developer.watson-orchestrate.ibm.com/llms.txt → https://developer.watson-orchestrate.ibm.com/_llms/2-x.md |

### Still to confirm live on the TechZone instance (this build network could not reach IBM Cloud)

1. **Thread messages path.** The public API reference lists `GET /v1/threads/{thread_id}/messages` (developer-edition
   server shape), while the ADK's remote client calls `{instance}/v1/orchestrate/threads/{thread_id}/messages`. The code
   follows the ADK (same prefix as the documented `/v1/orchestrate/runs` and `/v1/orchestrate/agents`). `npm run verify:ai`
   exercises it; if it 404s, this path is the first thing to adjust.
2. **Assistant text field.** The OpenAPI schema does not define the text field of a content item; the ADK CLI reads
   `content[].text` where `response_type == "text"`. The client also accepts a plain-string content and falls back to the
   run's `result.data.message.content`.
3. **Model id.** `watsonx/meta-llama/llama-3-3-70b-instruct` is a placeholder; confirm with `orchestrate models list`.
4. **Workspace scoping.** `GET /agents` without `workspace_id` returns global-workspace agents per the API reference;
   agents imported by the CLI into an IBM Cloud instance go to the global workspace by default. If `verify:ai` reports an
   agent as MISSING although `orchestrate agents list` shows it, set `WXO_AGENT_*` to the agent **id** instead of the name.
5. **Latency.** A 24k-character prompt on a 70B model may approach the 60 s default; raise `WXO_TIMEOUT_MS` if runs time out.
6. **Phase 1 agents.** The six new agents (classifier, notice drafter, relevance matcher, evaluation narrator, grade
   reviewer, supervisor) and the supervisor's collaborator routing have been tested only against the local fake
   Orchestrate server. Run `agents\import.ps1`, `npm run verify:ai` (it now also runs one supervisor turn) and
   `npm run evals -- agents` on the instance; tune the instructions or the model from `agents/evals/agents/results.md`.
7. **API key type.** The TechZone "student" credential must be an IBM Cloud IAM API key for a user with access to the
   instance. A non-IAM key fails at step 1 with the IAM error body shown by `verify:ai`.

## Evals

- `agents/evals/sample-tender.md` — synthetic bilingual tender (Ministry A is fictitious).
- `agents/evals/clarification-evals.json` — 10 English + 10 Arabic questions with expected key facts and expected
  citation section, plus 3 questions the documents do not answer (expect `notFound: true`).
- `npm run evals` (`services/api/src/tools/run-evals.ts`) calls the real clarification agent for every question and writes
  `agents/evals/results.md`: the raw agent text, parsed answer, citations, pass/fail per question, true totals and a
  timestamp. Pass = all expected keywords present (case/diacritic-insensitive, `|` alternatives) **and** a citation in an
  expected section; not-found questions pass only with `notFound: true`. It exits 0 whatever the pass rate (non-zero only
  if it cannot run). There are no pre-filled results in the repo: `results.md` exists only after a real run.

- `agents/evals/agents/phase1-agents.json` — 12 cases (Arabic and English, fictitious data) for the six Phase 1 agents:
  request classification (template/codes/urgency/budget), Kuwait Al-Youm and CAPT notices (numbers copied), vendor and
  tender ranking (expected top candidate), the committee narrative (scores quoted exactly), the grade checklist (expected
  status per item) and the supervisor (answers from the context; says "not found" for other bidders' prices).
  `npm run evals -- agents` runs them through the production service (same prompts, validation and repair turn) and
  writes `agents/evals/agents/results.md`. No results are pre-filled.

## Tests

- `npx tsx --test services/api/src/ai/*.test.ts` — client/parse unit tests against a local fake HTTP server defined inside
  the test file (IAM + agents + runs + threads).
- `npm test -w services/api` includes `test/ai-agents.test.ts` (each new AiService method against the fake Orchestrate in
  `test/fakes/orchestrate.ts`: valid output, repair turn on the same thread, invalid output rejected, numbers not in the
  input rejected, not configured → `AI_NOT_CONFIGURED`, and the eval set above) and `test/assistant-routes.test.ts` (the
  routes on the seeded demo data: role access rules, `ai_runs` kind/subject, 503 when not configured, chat context never
  containing sealed or opened bid contents or other vendors' data, thread ownership, paid-document gating, narrative saved
  to the content store). Fakes exist only under `test/` and in `*.test.ts` files (AGENTS.md rule 9).
