# Azure demo deployment (Free F1) — release runbook

The public demo at https://kbm-tenderflow.azurewebsites.net runs TenderFlow in **dedicated** mode for the MOI
reference configuration with fictitious demo data. It uses only the Azure App Service **Free (F1)** Linux tier.
This runbook is how a release gets there. Owner: KBM Digital Solutions.

## Topology

| Item | Value |
|----------|----------------------------------------|
| App | `kbm-tenderflow` (resource group `rg-kbm-tenderflow`) |
| Plan | `kbm-bootstrap-asp` (F1 Linux, `rg-kbm-platform`, West Europe), shared with `kbm-tenderscout` |
| Runtime | Node 22 LTS, startup `node services/api/dist/server.js`, `WEBSITE_RUN_FROM_PACKAGE=1`, no build on Azure |
| Data | PGlite under `DATA_DIR=/home/data/tenderflow` (persistent `/home` share); `-EphemeralData` uses `/tmp` |
| Mode | `TENANCY_MODE=dedicated`, `ENTITY_ID=moi`, `SEED_DEMO=true`, `DEMO_MODE=false` |
| Secrets | `BID_MASTER_KEY`, `AUDIT_SIGNING_KEY`, `DEMO_PASSWORD`: App Service settings only, created once, never rotated in place |

Free-tier limits: 60 CPU-minutes/day **for the whole plan** (TenderScout included), 1 GB memory, the app sleeps after
~20 minutes idle. Measured: cold start ~7 s on Linux, ~370 MB RSS.

## 1. Build the release (Linux or WSL, Node 22)

```bash
git checkout <release commit>      # clean tree; the version comes from services/api/package.json
scripts/release/build-azure-package.sh dist-release/azure
```

The script builds, stages the runtime files only (no sources, tests or docs), installs production dependencies,
**smoke-tests the staged package** (starts it in dedicated MOI mode on a fresh database and checks
`/api/v1/version`, `/api/v1/public/deployment` and `/login`), then zips it, splits it into 25 MB `part.NN` files and
writes `release.json`:

```json
{ "version": "1.0.0-rc7", "commit": "abc1234", "sha256": "…", "parts": ["part.00", "part.01", "part.02"] }
```

It also copies `deploy-tenderflow-azure-free.ps1` and `ANTIGRAVITY-PROMPT.md` (version filled in) into the folder.
Nothing in the release needs editing by hand: the deploy script reads the SHA-256 and part list from `release.json`.

## 2. Hand over

Copy the whole folder to `C:\Users\kabed\Downloads\TenderFlow-MOI-Share\04-Azure-Deploy\<version>` (one folder per
release, so an older release can be redeployed as is).

## 3. Deploy

Either run it yourself from that folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy-tenderflow-azure-free.ps1
```

or give an AI deployment assistant the `ANTIGRAVITY-PROMPT.md` from the same folder. The script:

1. joins the parts (or reuses a zip that already matches) and verifies the SHA-256;
2. refuses to continue if the app sits on anything but an F1 plan;
3. on first deployment only, creates the app on an existing free plan and generates keys and the demo password;
4. sets the settings, uploads the package (3 attempts, for a new app's SCM DNS delay);
5. waits for the **new** version to answer and runs the release checks.

| Check | Pass condition |
|--------------|----------------------------------------|
| Version | `/api/v1/version` equals `release.json` version |
| Dedicated entity | `/api/v1/public/deployment` → `mode: dedicated`, entity `moi` |
| Pages | `/` and `/login` → 200 |
| Sign-in (officer) | token issued (password read from app settings into memory, never printed) |
| Presenter mode off | `POST /api/v1/demo/persona` → 401/403/404 |
| Demo status | `/api/v1/demo/status` → `enabled: false` |
| Tenders API | `GET /api/v1/tenders` as officer → 200 |
| watsonx Orchestrate | when the app has `WXO_*` settings: `/ready` (administrator token) → IAM token OK and every agent found; otherwise shown as OFF (not a failure) |

Exit code 0 = deployed and verified; 2 = deployed but a check failed. A `deploy-report-<time>.json` (no secrets) is
written next to the script. `-VerifyOnly` reruns the checks without touching Azure.

## Two apps on the same free plan

| App | Tenancy | Purpose | Deploy |
|---|---|---|---|
| `kbm-tenderflow` | dedicated, MOI | the product edition shown to MOI | `.\deploy-tenderflow-azure-free.ps1` |
| `kbm-tenderflow-demo` | shared: KEA, GCIA, MOI with an entity picker | KBM's multi-entity demo | `.\deploy-tenderflow-azure-free.ps1 -AppName kbm-tenderflow-demo -Tenancy shared` |

Both use the plan `kbm-bootstrap-asp` and its 60 CPU-minutes/day with TenderScout; an idle app uses none. Each app has
its own keys, demo password and database. The script never switches an existing app between dedicated and shared
unless `-AllowTenancyChange` is given.

## watsonx Orchestrate

1. On the machine with the TechZone instance details in the repo `.env`, import and check the agents:
   `powershell -ExecutionPolicy Bypass -File agents\import.ps1`, then `npm run verify:ai`.
2. Deploy with `-WatsonxFrom C:\Users\kabed\Downloads\KBM_Tender_v1\.env`. The script copies only the `WXO_*`
   runtime settings into the app settings and prints their names, never their values.
3. The `watsonx Orchestrate` check must PASS (IAM token OK, every agent found).
4. `-DisconnectWatsonx` removes the settings again.

Each user may make 20 AI requests a minute (`AI_RATE_LIMIT_PER_MIN`), so a shared demo password cannot exhaust the
instance. The TechZone reservation has an end date: when it expires the check fails and AI features say the service is
unavailable; disconnect or reconnect with the new instance.

## 4. Accept

After the script passes, open `/login` and sign in as `officer` and `admin`, in English and Arabic, and confirm the
entity name and demo-user hint are MOI's. For a full regression run the QA crawler (every role × both languages,
page errors, failed API calls, raw i18n keys, layout overflow) against the release before handing it over.

## Rollback

Redeploy the previous release folder with its own script. The database is kept (`/home/data`), and migrations are
forward-only, so roll back only between releases without new migrations, or redeploy with `-EphemeralData` for a
fresh demo database.

## Do not

- upgrade or scale the plan, or add paid resources; touch `kbm-tenderscout`;
- build the package on Windows (native modules);
- change `BID_MASTER_KEY` or `AUDIT_SIGNING_KEY` on an existing app;
- put the demo password in email, files, logs or chat (share it by Teams).
