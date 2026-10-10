# TenderFlow v1.0.0-rc5 — release notes (10 Oct 2026)

rc5 adds the **low-code Process Studio**. It also brings in the FileNet enterprise features, security hardening and OpenShift operations that the architecture and ESA documents describe. Those were previously listed as "rc4"; rc4 was never installed, so rc5 replaces it.

The user stories are in [USER-STORIES.md](USER-STORIES.md): 155 stories, of which 125–155 are new. The notes for [rc3](release-notes-v1.0.0-rc3.md) still apply.

## What is new

### Low-code Process Studio
Admin → Process Studio. Full detail: [LOW-CODE-STUDIO.md](LOW-CODE-STUDIO.md).
- **Custom forms**
  - Applies to tender, request and vendor forms.
  - 14 field types, including calculated fields; sections; required at save or at submission; public or internal; conditional visibility.
  - Live bilingual preview while editing.
- **Business rules, built visually as When · If · Then**
  - **Gates:** stop a step, require fields or documents, add approval levels.
  - **Events:** notify, create tasks (optionally blocking a later step), call integrations, set a field.
  - **Schedules:** deadline reminders.
- **Integrations:** signed webhooks with retries, a delivery log, a test button, secret rotation and SSRF protection.
- **Governance**
  - Drafts, check, simulate (sample values or a real tender), publish, discard.
  - Version history with diffs; optional four-eyes on configuration.
  - Running tenders keep the rules and form version they started with.
- **Process map** with locked integrity controls, an automation log and "My tasks".
- **Configuration packages** to roll a process out to another entity: export, then preview, then import as drafts.
- **Demo content:** KEA (8 rules, 3 forms) and MOI (2 rules, 2 forms).

### IBM FileNet enterprise features
- Evidence links into IBM Content Navigator and ACCE. Navigator is found automatically and its reachability is checked; every click is audited.
- `TF_Document` class with 5 subclasses and their properties. If a class does not exist yet, TenderFlow falls back to the default class.
- Permission lists by confidentiality level. SEALED changes to COMMITTEE at the opening, with a retry job and a read-back check.
- CE SQL search page.
- AI classification is written back to FileNet properties.
- `verify:filenet` gains steps 10–14.

### Security hardening
- Sign-in lockout with administrator unlock.
- Strict Content-Security-Policy.
- `TRUST_PROXY`.
- SSO state bound to the browser.
- Protected pdf.js viewer with single-use 60-second grants.
- `/ready` shows details to administrators and auditors only.
- nodemailer 10.1.0 and react-router-dom 6.30.6.
- New CI workflow.

### Operations
- UBI 9 / Node 22 `Containerfile`.
- OpenShift Kustomize base, plus demo and production overlays.
- `TF_ENV=production` refuses unsafe settings.
- `npm run config:check` and `npm run entity:create`.
- Migration lock, graceful shutdown and `/api/v1/version`.
- [INSTALLATION-AND-OPERATIONS.md](INSTALLATION-AND-OPERATIONS.md).

## Verified (in this sandbox)

| Check | Result |
|---|---|
| `npm test` (API and integration, PGlite) | 249 tests: 248 pass, 1 skipped (PostgreSQL-only, needs `TEST_DATABASE_URL`) |
| `npx tsx --test services/api/src/ai/*.test.ts` | 40 / 40 pass |
| Typecheck (API and web) and production build | clean |
| Process Studio screens, scripted Chromium, English and Arabic | map, rules, rule editor, form builder, simulator, integrations, activity, packages, tender process panel, tender form fields, My tasks, vendor view, registration — rendered with no page errors |

## Not yet verified live

| Item | How |
|---|---|
| FileNet classes, permissions, search and Navigator link on TechZone | ACCE runbook §6–§8, then `npm run verify:filenet` |
| Orchestrate agents (10) | `agents\import.ps1`, then `npm run verify:ai` |
| Container image build and OpenShift deployment | `deploy/openshift/README.md` |
| Webhooks to a real receiving system | Process Studio → Integrations → Send test |
| SSO against Entra ID / AD FS; e-mail and SMS | [SECURITY-FEATURES.md](SECURITY-FEATURES.md) |

## Known limits

- `npm audit --omit=dev` reports 9 advisories. None is used at runtime by the server path:
  - `tar` / `canvas` come through `unpdf`, and `canvas` is not installed;
  - `mammoth` → `sprintf-js` affects only its command-line part;
  - the 2 `react-router` advisories are fixed only in 7.x.
- `BID_MASTER_KEY` and `AUDIT_SIGNING_KEY` have no rotation tool.
- Low-code limits:
  - new stages cannot be inserted between the fixed ones (rules attach to the existing stages);
  - request approval chains are not routed by rules yet;
  - rules cannot use bid-level facts after opening.
