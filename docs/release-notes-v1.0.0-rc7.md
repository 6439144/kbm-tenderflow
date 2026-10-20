# TenderFlow v1.0.0-rc7 — release notes (20 Oct 2026)

rc7 is a hardening release. It has no new features and no database migrations. It fixes what a full quality sweep of the
public Azure demo found, and it makes releasing to Azure repeatable and self-checking. The notes for
[rc6](release-notes-v1.0.0-rc6.md) still apply.

## How it was tested
Every role of the dedicated MOI demo (admin, officer, tenderdept, grader, director, undersecretary, auditor, an
approved vendor and a vendor awaiting approval) opened every menu entry and one record of every list, in English and
Arabic. The crawler recorded page errors, console errors, failed API calls, error boxes, raw translation keys, empty
pages and layout overflow. The KEA configuration (shared demo) was swept the same way.

## Fixes
| # | What users saw | Fix |
|-|----------------------------------------|----------------------------------------|
| 1 | Every page made a failed request (`/demo/status` → 404) when presenter mode is off, filling the browser console. | The status probe answers `{ enabled: false }`. Every presenter control is still 404 when off. |
| 2 | A supplier whose application is still being graded got a failed request on its home page (AI "tenders for me", 409). | The panel loads and says the supplier is not approved yet; ranking stays refused until approval. |
| 3 | Administrators and auditors who opened a tender or request from a dashboard, task or link saw "You do not have access". | They are taken to a read-only view of the record inside their own portal (Admin → … /tenders/:id, /requests/:id). Rights are unchanged: the server still decides what each role may do. |
| 4 | The sign-in page of a dedicated installation listed another entity's demo users (chair, evaluator1 …). | A demo installation lists its own demo users. Installations without demo data show no list. |
| 5 | After a redeploy a browser could keep the previous release (cached `index.html`). | `index.html` is never cached; the content-hashed build files are cached for a year. A new release is picked up on the next visit. |
| 6 | In the read-only admin view of a record, "← Tenders" led to a page administrators may not open. | The link says "← Back" and returns to where they came from (or the admin overview). |
| 7 | Timeline entries were set in a monospace font, which reads poorly in Arabic. | They use the normal text font. |

## Security and dependencies
- PDF text extraction (`unpdf`) upgraded from 0.12 to 1.8. The old version pulled in the native `canvas` module and,
  through its installer, a `tar` version with critical advisories. Neither is installed any more; the package is
  smaller and has no native build for PDF.
- `npm audit --omit=dev` now reports 5 moderate advisories and no high or critical ones. Assessed:
  `react-router-dom` 6.x (open redirect through attacker-supplied paths passed to `<Link>`/`navigate`, and SSR
  issues): TenderFlow never navigates to a user-supplied path and does not use SSR, so not exploitable; the move to
  v7 is planned with the next feature release. `mammoth` → `argparse`/`sprintf-js`: used only by mammoth's command-line
  tool, which TenderFlow does not run.
- `/api/v1/version` of a release package also shows the commit and build time, so a deployment can be traced to its
  source.

## Azure release process
- `scripts/release/build-azure-package.sh` builds the Linux package, smoke-tests it (starts it in dedicated MOI mode
  on a fresh database), splits it into 25 MB parts and writes `release.json` (version, commit, SHA-256, part list).
- `deploy/azure/deploy-tenderflow-azure-free.ps1` reads `release.json` (nothing to edit by hand), refuses any plan
  other than Free F1, keeps keys and the demo password of an existing app, retries the upload for a new app's DNS
  delay, waits for the **new** version, and runs eight release checks with a PASS/FAIL table and a report file.
- `deploy/azure/ANTIGRAVITY-PROMPT.md` is the operator prompt for an AI deployment assistant.
- Runbook: [AZURE-DEMO-DEPLOYMENT.md](AZURE-DEMO-DEPLOYMENT.md).

## Upgrade
No migrations. Redeploy the rc7 release folder with its script; data, keys and the demo password are kept.
