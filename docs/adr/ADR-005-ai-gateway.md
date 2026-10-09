# ADR-005: AI Gateway & Advisory Agent Architecture (T07)

## Status
Accepted (Non-negotiable Rules 7 & 8)

## Context
TenderFlow integrates AI capabilities to assist procurement specialists with tender scope completeness checks, drafting clarification answers, and preliminary bid compliance matrices.
However:
- **Rule 7**: AI is advisory: agents never approve, reject, score for award, or publish to vendors without a recorded human approval.
- **Rule 8**: Product names, UI text, and docs contain no IBM product names.
- watsonx Orchestrate agents run on SaaS / TechZone and invoke TenderFlow tools via OpenAPI. Every tool call must carry the end user's identity and tenant context.

## Decision
1. **Advisory Gatekeeper**: The API exposes dedicated endpoints under `/api/v1/ai/advisory/` that return recommendations, draft responses, and compliance matrices marked with `isAdvisory: true`.
2. State transition endpoints (`approve-publish`, `publish`, `award`, `vendors/approve`) require explicit human authorization roles (`DIRECTOR`, `PROCUREMENT_OFFICER`) and record human actor IDs in the audit log.
3. watsonx Orchestrate agents are defined via the Agent Development Kit (ADK) in `agents/agent.yaml` and OpenAPI tool specifications in `agents/tools/`.
4. Automated import script `agents/import.sh` rebuilds and applies tools to any clean TechZone Orchestrate environment.
5. In customer-facing UI and documentation, the AI service is universally titled "Procurement AI Advisor" without third-party vendor proprietary branding.

## Consequences
- Guaranteed compliance with Rule 7 and Rule 8.
- Full accountability and auditability of all critical procurement milestones.
