# Optional read-only tool pack (OpenAPI) — not wired by default

`tenderflow-readonly.openapi.yaml` describes three read-only TenderFlow endpoints as watsonx Orchestrate tools:

| Tool (operationId) | TenderFlow endpoint | Returns |
|---|---|---|
| `tenderflow_my_tasks` | `GET /api/v1/assistant/my-tasks` | the caller's pending tasks, computed by TenderFlow (no AI) |
| `tenderflow_list_tenders` | `GET /api/v1/tenders?status=` | tenders visible to the caller |
| `tenderflow_get_tender` | `GET /api/v1/tenders/{id}` | one tender as TenderFlow shows it to the caller |

**The default runtime flow does not use it.** TenderFlow calls the agents outbound (`POST /v1/orchestrate/runs`) and
puts the role-scoped context into the message itself, so nothing on the Orchestrate side ever calls TenderFlow. That is
what works from a laptop or a private network and is what the tests cover.

The tool pack is for a later step where the supervisor `tenderflow_assistant` reads TenderFlow live from the
Orchestrate chat. It needs:

1. **TenderFlow on a public HTTPS URL** that the Orchestrate instance (IBM Cloud) can reach. A laptop on
   `http://localhost:8080` does not work. Replace `servers[0].url` in the YAML with `https://<your host>/api/v1`.
2. **A bearer token** for the TenderFlow user the tools act as. TenderFlow tokens are RS256 JWTs issued by
   `POST /api/v1/auth/login` and expire; the role scope comes only from the token (a vendor token only ever sees that
   vendor's view). Use a dedicated read-only account (e.g. an `AUDITOR`) and rotate the token.

## Import (PowerShell, after `agents\import.ps1` has activated the environment)

```powershell
orchestrate connections add -a tenderflow_api
orchestrate connections configure -a tenderflow_api --env draft -t team -k bearer
orchestrate connections set-credentials -a tenderflow_api --env draft --token "<TenderFlow JWT>"
# repeat configure + set-credentials with --env live before deploying the agent
orchestrate tools import -k openapi -f agents\tools\tenderflow-readonly.openapi.yaml -a tenderflow_api
orchestrate tools list
```

Then add the tool names to the supervisor (`tools:` in `agents/tenderflow_assistant.yaml`, e.g.
`- tenderflow_my_tasks`) and re-import it with `orchestrate agents import -f agents\tenderflow_assistant.yaml`.
Keep `tools: []` in the repository version so a default import never depends on a public URL.

## Status

- Written against the ADK documentation (OpenAPI tools, bearer connections). The spec is parsed into three tools by the
  ADK 2.18.1 loader (`create_openapi_json_tools_from_content`) locally. **Not imported or called against a live instance
  from this environment** — the TechZone instance is not reachable here.
- All three endpoints are the real TenderFlow routes covered by the API tests (`services/api/test/`).

---

# Optional admin tool pack (OpenAPI) — `tenderflow_admin_builder` in the Orchestrate chat

`tenderflow-admin.openapi.yaml` lets the admin builder agent be used from the watsonx Orchestrate chat UI as well as from
TenderFlow's own **Admin → AI builder** page. It has two tools and deliberately **no apply or publish operation**:

| Tool (operationId) | TenderFlow endpoint | What it does |
|---|---|---|
| `submit_admin_proposal` | `POST /api/v1/admin-agent/proposals` | Submits `{request, reply{en,ar}, operations[]}`. TenderFlow checks the shape strictly (unknown operations or keys → 400), validates every operation against the entity's current configuration and stores a **PROPOSAL**. Nothing in the configuration changes (`applied: false`); the response carries `reviewPath` (`/admin/builder?proposal=<id>`) and the per-operation validation in English and Arabic. |
| `get_admin_proposal` | `GET /api/v1/admin-agent/proposals/{id}` | Reads the proposal back: status (`PROPOSED`/`APPLIED`/`DISCARDED`/`FAILED`), validation, and the drafts created once an administrator applied it. |

The administrator then opens the proposal in TenderFlow, reads the plain-language sentence and the diff of every operation
and clicks **Create drafts** (or **Discard**). Applying creates DRAFT versions only; publishing stays a separate human click
in Cycle Designer / Process Studio, under the entity's four-eyes setting. Every step is audited (`ADMIN_AGENT_PROPOSED`,
`ADMIN_AGENT_APPLIED`, `ADMIN_AGENT_DISCARDED`). See [docs/ADMIN-AI-BUILDER.md](../../docs/ADMIN-AI-BUILDER.md).

It needs, like the read-only pack:

1. **TenderFlow on a public HTTPS URL** reachable from the Orchestrate instance — replace `servers[0].url` with
   `https://<your host>/api/v1`.
2. **A bearer token of a `TENANT_ADMIN`** of the entity (the endpoints refuse every other role with 403). The entity comes
   only from the token, so proposals always land in that administrator's own entity. Use a dedicated administrator
   account for the connection, keep its token short-lived (TenderFlow tokens expire after 8 hours) and rotate it. Even with
   this token the tools can only *propose*: there is no endpoint in the pack that applies, publishes, or touches users.

## Import (PowerShell, after `agents\import.ps1` has imported the agents and activated the environment)

```powershell
orchestrate connections add -a tenderflow_admin_api
orchestrate connections configure -a tenderflow_admin_api --env draft -t team -k bearer
orchestrate connections set-credentials -a tenderflow_admin_api --env draft --token "<TenderFlow JWT of a TENANT_ADMIN>"
# repeat configure + set-credentials with --env live before deploying the agent
orchestrate tools import -k openapi -f agents\tools\tenderflow-admin.openapi.yaml -a tenderflow_admin_api
orchestrate tools list
```

Then add the two tool names to the agent (`tools:` in `agents/tenderflow_admin_builder.yaml`):

```yaml
tools:
  - submit_admin_proposal
  - get_admin_proposal
```

and re-import it with `orchestrate agents import -f agents\tenderflow_admin_builder.yaml`. Keep `tools: []` in the
repository version so a default import never depends on a public URL. The agent's instructions already describe this
"Orchestrate chat" mode: it submits the proposal and tells the user to review it in TenderFlow; it never claims that
anything was created.

## Status

- Written against the ADK documentation (OpenAPI tools, bearer connections), parsed locally as YAML. **Not imported or
  called against a live instance from this environment** (the TechZone instance is not reachable here).
- Both endpoints are the real TenderFlow routes covered by `services/api/test/admin-agent.test.ts` (structured
  submission validated without AI, never applied; roles; entity isolation).
