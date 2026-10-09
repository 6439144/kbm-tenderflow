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
