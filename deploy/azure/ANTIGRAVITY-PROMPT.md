# Task: update the TenderFlow demo on Azure App Service to {{VERSION}} (FREE tier only)

You are the deployment operator. The release is already built, tested and checksummed on Linux. Your job is to run
the provided script, confirm every check passes, and report. You do not write or change code.

## Release folder
`C:\Users\kabed\Downloads\TenderFlow-MOI-Share\04-Azure-Deploy\{{VERSION}}`

It contains `release.json` (version, commit, SHA-256, part list), the `part.NN` files and
`deploy-tenderflow-azure-free.ps1`. Work only in this folder. Older release folders next to it are history: leave them.

Target: app `kbm-tenderflow` in resource group `rg-kbm-tenderflow` → https://kbm-tenderflow.azurewebsites.net
(MOI reference configuration, fictitious demo data).

## Hard rules
1. **Free tier only.** Never create, upgrade or scale to a paid SKU, and never add databases, storage accounts,
   Application Insights, container registries or any other billable resource. The script refuses to deploy to a
   paid plan; if it stops for that reason, stop and ask me.
2. **Do not touch other apps.** `kbm-tenderscout` shares the free plan `kbm-bootstrap-asp` (rg-kbm-platform).
   Do not change, restart, scale or delete it or any other resource.
3. **Do not edit the script, release.json or the parts.** The script checks the SHA-256 itself. If it reports a
   mismatch, stop and tell me; do not "fix" the expected value.
4. **Do not build or zip anything on Windows**, and do not touch `C:\Users\kabed\Downloads\KBM_Tender_v1`
   (especially `.env` and `data\`). No git, no pushes, no new repositories.
5. **Secrets.** Never print, log, save or paste `DEMO_PASSWORD`, `BID_MASTER_KEY` or `AUDIT_SIGNING_KEY`. Never set
   or regenerate them on the existing app (that would make sealed bids and the audit chain unreadable). Do not run
   `az webapp config appsettings list` with output to the console.
6. Ask me before deleting anything, and before any change the script does not make itself.

## Steps
1. `az --version` (install with `winget install -e --id Microsoft.AzureCLI` if missing), then `az account show`;
   if not signed in, `az login` and I will complete the browser sign-in.
2. From the release folder:
   `powershell -ExecutionPolicy Bypass -File .\deploy-tenderflow-azure-free.ps1`
   (defaults: `-AppName kbm-tenderflow -ResourceGroup rg-kbm-tenderflow -Location westeurope -Entity moi`).
   Do not add `-EphemeralData` unless step 4 tells you to.
3. The script ends with a PASS/FAIL table and writes `deploy-report-<time>.json` (no secrets). Exit code 0 means
   deployed and verified. The checks are: Version = {{VERSION}}, Dedicated entity = moi, Page / and /login = 200,
   Sign-in (officer), Presenter mode off, Demo status, Tenders API.
4. Only if something fails:
   - Upload error mentioning DNS / `getaddrinfo`: the script already retries 3 times; wait 2 minutes and rerun it.
   - `Version` fails but the site answers: the free plan may still be starting. Rerun with `-VerifyOnly` after
     3 minutes (no changes to Azure).
   - "403 – site stopped" / quota: the free plan's 60 CPU-minutes/day (shared with kbm-tenderscout) is used up.
     Stop and tell me; it resets daily. Do not upgrade.
   - Database or file-system errors under `/home/data` in `az webapp log tail -g rg-kbm-tenderflow -n kbm-tenderflow`:
     ask me before rerunning with `-EphemeralData` (demo data is then recreated after every restart).
   - Startup timeout: ask me before setting `WEBSITES_CONTAINER_START_TIME_LIMIT=600`.
5. Open https://kbm-tenderflow.azurewebsites.net/login in a browser and confirm the page shows the Ministry of
   Interior name and the demo-user hint lists admin, auditor, director, grader, officer, tenderdept,
   undersecretary, vendor1–vendor5.

## Expected free-tier behaviour (not errors)
- The app sleeps after ~20 minutes idle; the first request afterwards takes 20–60 seconds.
- IBM FileNet and watsonx Orchestrate are not connected on this Azure copy; AI features say so plainly. Correct.

## Report back (short)
- Version deployed and commit (from `release.json`), URL, resource group, plan, region.
- The PASS/FAIL table from the script, and the name of the report file.
- Anything you did beyond running the script once, and why.
- No passwords or keys. The demo password stays in Azure portal → kbm-tenderflow → Settings → Environment
  variables → `DEMO_PASSWORD`.
