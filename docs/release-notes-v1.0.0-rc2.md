# TenderFlow v1.0.0-rc2 — release notes (9 Oct 2026)

rc2 turns rc1's single fixed cycle into a generic, configurable product. It also makes IBM FileNet and IBM watsonx Orchestrate visible throughout the product. The full list of 79 user stories, with how each was verified, is in [USER-STORIES.md](USER-STORIES.md). The rc1 notes ([release-notes-v1.0.0-rc1.md](release-notes-v1.0.0-rc1.md)) still apply.

## What is new
- **Configurable cycles.** Each entity has versioned cycle templates with optional stages and N-level approval chains, and the server enforces them:
  - one or two envelopes, with a technical pass mark;
  - eligibility by activity code and grade;
  - paid documents (TEST gateway) and fee exemptions;
  - gazette and CAPT notices;
  - records lock at award.
- **Admin screens.** Cycle Designer with a live preview, and entity settings. There are now two fictitious demo entities with different cycles.
- **Department requests.** A request starts from a scanned GM letter or a Raslni reference, has its own approval chain, and converts into a tender.
- **watsonx Orchestrate.** Ten agents (one supervisor and nine collaborators):
  - a TenderFlow Assistant chat in every portal;
  - "Tenders for you" for vendors;
  - notice drafting, vendor ranking, committee narrative and grade review;
  - an AI value meter;
  - a read-only OpenAPI tool pack for later use.
- **Document intelligence.** Every upload is classified and its key data is extracted with citations. A person accepts or corrects it, and rule-based flags sit beside the AI data. Sealed bids are only processed after opening. Accepted values are written to FileNet properties.
- **FileNet showcase.**
  - An evidence panel on every document, with version and record badges.
  - Addenda checked in as new FileNet versions (behind a flag).
  - Records declared at award (behind a flag).
  - A Navigator deep link, an admin health page with operation timings, and new `verify:filenet` steps.
- **Guided demo** (`DEMO_MODE=true`).
  - A 13-chapter Demo Story with persona switching, highlights and live IBM evidence, plus a second track for the other entity.
  - First-login role tours.
  - `npm run demo:reset`.

## Verified (in this sandbox)
| Check | Result |
|---|---|
| `npm test` (API, integration, FileNet store/showcase, platform, assistant, demo, document-intelligence tests) | 119 / 119 pass |
| `npx tsx --test services/api/src/ai/*.test.ts` (Orchestrate client and agent unit tests against a fake server) | 36 / 36 pass |
| Typecheck (API + web) and production build | clean |
| Scripted Chromium walk-throughs on fresh demo data: both cycles end to end (17 steps), Demo Story (13 + 3 chapters, EN/AR), FileNet evidence and health pages, document intelligence (with a fake Orchestrate, every reply marked `[FAKE]`) | all pass, no console errors, no failed API calls |
| Arabic pages scanned for untranslated interface text | fixed; what remains is seeded names and codes |

## Not yet verified live (run on the Windows machine against TechZone)
| Item | Command |
|---|---|
| Ten Orchestrate agents imported and answering | `agents\import.ps1`, `npm run verify:ai`, `npm run evals`, `npm run evals -- agents` |
| FileNet versioning and record declaration | `npm run verify:filenet` (steps 8–9), then the flags in `docs/filenet/SHOWCASE.md` |
| FileNet AI properties (`TF_DocType`, `TF_ExpiryDate`, `TF_AIReviewed`) | ACCE runbook §1c, then `FILENET_AI_PROPERTIES=true` |
| Navigator deep link format | set `FILENET_NAVIGATOR_URL`, open the printed link |

FileNet storage itself was verified live on 9 Oct 2026 (`npm run verify:filenet` passed).

## Known limitations
- Automatic document classification uses an in-memory queue. Jobs queued when the server restarts are dropped and need a manual "Classify with Orchestrate".
- Scanned images without a text layer are not extractable (OCR is roadmap).
- Reviewers can correct extracted fields but not the document type in the UI.
- KNET, AD/MFA, Raslni, email/SMS, zone deployment, watermarked viewer and PDF reports are roadmap (see USER-STORIES.md).
