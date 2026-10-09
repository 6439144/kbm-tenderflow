# TenderFlow v1.0.0-rc3 — release notes (10 Oct 2026)

rc3 adds the MOI reference configuration and a set of platform features government entities ask for. The full list of 124 user stories, with how each was verified, is in [USER-STORIES.md](USER-STORIES.md). The notes for [rc1](release-notes-v1.0.0-rc1.md) and [rc2](release-notes-v1.0.0-rc2.md) still apply.

## What is new
- **MOI reference configuration**, a third demo entity built from KBM's MOI BRD v0.1. Every confirmed requirement is implemented, and every open MOI decision is a setting on Admin → Entity policies. The requirement-by-requirement traceability is in [MOI-REFERENCE-CONFIGURATION.md](MOI-REFERENCE-CONFIGURATION.md).
- **Cycle scope.** An entity can run only "publication and document sale" (MOI Phase 1). Bidding, opening and award are then refused by the server.
- **Vendor lifecycle.**
  - Grading authority queue and annual subscription (TEST gateway, MOI receipt number series).
  - Renewal reminders and grade upgrades.
  - Blocking with automatic reinstatement, and fee exemption per vendor or category.
  - Eligibility semantics as settings.
- **Identity and access.**
  - TOTP two-step verification with recovery codes.
  - Staff single sign-on through Active Directory (OIDC, group-to-role mapping, just-in-time or admin-created accounts).
  - Staff network allowlist, and account enable/disable.
- **Content protection.** A view-only protected viewer with a per-vendor watermark and audit of every view, plus watermarked PDF downloads after purchase.
- **Notifications.**
  - Editable bilingual templates, including NOT-001 to NOT-005.
  - E-mail (SMTP) and SMS (HTTP adapter), with a delivery log and retries.
  - A durable job scheduler.
  - Approval service levels with reminders and escalation, and a tender reject path.
- **Insight.**
  - A dashboard for every role.
  - Procurement analytics with CSV export.
  - An auditor evidence pack: a ZIP with hashes and the audit-chain slice, stored as a document.
  - A public tender board across entities, with RSS and JSON feeds, which each entity can switch on or off.
- **Integration fixes.**
  - MOI's lifecycle job runs on the shared scheduler.
  - The BRD notifications use their templates.
  - Content protection has one resolution order: template → security settings → entity policies → profile.
  - Administrators and auditors land on their dashboard.
  - KNET can never record a payment without a real adapter.

## Verified (in this sandbox)
| Check | Result |
|---|---|
| `npm test` (all API and integration tests) | 174 / 174 pass |
| `npx tsx --test services/api/src/ai/*.test.ts` | 40 / 40 pass |
| Typecheck (API + web) and production build | clean |
| Scripted Chromium walk-throughs on the merged build | Security (MFA, recovery codes, allowlist, viewer, watermarked PDF, audit): all checks pass. Both cycles end to end: pass. Demo Story: pass. MOI walks 1–5: pass. The only failures were stale script selectors and one walk-through re-run on data an earlier run had already used. |
| Page sweep: 27 screens in English and Arabic as admin, director, grading authority, vendor (kea and moi) | 0 console errors, 0 failed API calls |

## Not yet verified live
| Item | How |
|---|---|
| Staff single sign-on against Entra ID / AD FS | [SECURITY-FEATURES.md](SECURITY-FEATURES.md), Windows steps |
| E-mail and SMS delivery | Set `SMTP_*` / `SMS_HTTP_*` in `.env`, then Admin → Notifications → "Send test to me" |
| Evidence pack and AI properties stored in TechZone FileNet | Run with `CONTENT_STORE_TYPE=filenet` and generate a pack |
| Orchestrate agents (10) | `agents\import.ps1`, `npm run verify:ai` |

## Known limits
- **Screenshots and photos:** a browser cannot prevent them. The watermark and the audit trail make any leak traceable.
- **Protected viewer layout:** it shows the document's text, not its original page layout.
- **PDF stamp language:** it uses the vendor's English name, because the standard PDF fonts are Latin only.
- **No real KNET payments yet:** KNET and Raslni need MOI and third-party access (BRD DEP-002, DEP-004).
- **Upgrade approval:** a single decision until MOI defines the process (DEP-003).
- **Phone layout:** at phone width, some existing list pages scroll sideways.
