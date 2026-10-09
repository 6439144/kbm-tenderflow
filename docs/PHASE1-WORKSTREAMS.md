# TenderFlow Phase 1 — parallel workstreams (read fully before you start)

TenderFlow is a bilingual (Arabic RTL / English) public-tendering product for Kuwaiti government entities, built by
KBM for the IBM Build partnership. It is reviewed by IBM next week, so everything must be **real and working**: no
mock data presented as real, no canned AI output, no buttons that do nothing.

## Stack (monorepo, npm workspaces)
- `services/api` — Express 4 + TypeScript ESM, PGlite (embedded Postgres) or pg. Migrations `services/api/migrations/*.sql`.
  Tests: `npm test -w services/api` (node:test + tsx; real app on a random port, filesystem content store).
- `apps/web` — Vite + React 18 SPA, served by the API at `/`. `npm run build -w apps/web`. Typecheck `npx tsc --noEmit -p apps/web`.
- Auth: RS256 JWT issued by TenderFlow; tenant comes **only** from the token. Roles: VENDOR, PROCUREMENT_OFFICER,
  DIRECTOR, UNDERSECRETARY, COMMITTEE_CHAIR, EVALUATOR, TENANT_ADMIN, AUDITOR.
- Content store: `ctx.store` (filesystem or IBM FileNet Content Services GraphQL, `services/api/src/content/`).
- AI: `ctx.ai` = watsonx Orchestrate agents called outbound (`services/api/src/ai/`). Not configured → 503 `AI_NOT_CONFIGURED`.
- Audit: every state change writes `auditTx(ctx, q, {...})` inside the same `ctx.db.tx`. Audit is append-only + HMAC-chained.
- PGlite has one connection: **never call `ctx.db.query` inside a `ctx.db.tx` callback** — use the `q` you are given.

## The platform layer that already exists (commit "feat(platform)…") — use it, don't rebuild it
- `services/api/src/services/templates.ts` — cycle templates (`CycleConfig`: stages on/off, approval chains
  `approvals.request|publish|award` = N levels of roles, `envelopes` ONE/TWO, technical pass mark, eligibility,
  fees, AI toggles), `configOf(tender)`, `stageList(config)`, entity profile (`getProfile`, numbering patterns).
- `eligibility.ts` — activity codes, vendor grades (1=First … 3=Third), `checkEligibility`, document purchase (TEST
  gateway; KNET refused until `KNET_MERCHANT_ID`), fee exemption.
- `tenders.ts` — template pinned on create (`template_snapshot`), N-level approval chain (`approveTender`,
  `approvalChainView`, statuses DRAFT → PENDING_APPROVAL → APPROVED → PUBLISHED …), publish creates the PORTAL
  publication + rule-based vendor notifications. `tenderDetail` returns `stages, approvalChain, awardChain,
  publications, purchaseCount, request, myEligibility, myPurchase, template, cycle`.
- `bids.ts` — two-envelope: `financialSealed`, `openFinancial` (pass mark → PASSED/FAILED), financial docs hidden until opened.
- `award.ts` — scoring rules for two envelopes, N-level award approval chain, `lockRecords` (records lock at award;
  calls optional `ctx.store.declareRecord`).
- `requests.ts` — departmental requests (LETTER with mandatory scan, or RASLNI reference), approval chain, convert to tender.
- `publications.ts` — KUWAIT_ALYOUM / CAPT notices: draft → approve (other person) → record reference (stored as NOTICE doc).
- `notifications.ts` — in-app notifications.
- Routes: `services/api/src/routes-platform.ts`. Route helpers exported from `routes.ts`: `h`, `actor`, `requireRoles`, `upload`, `sendDoc`.
- Web client: `apps/web/src/api.ts` (`api`, `http` helpers, types) and `apps/web/src/api-platform.ts` (`platform.*`).
- UI kit: `apps/web/src/components/ui.tsx` (Card, Button, Badge, Table, Field, FileInput, Modal, ReasonDialog, useAsync,
  AsyncView, ErrorBox, Spinner, EmptyState, AiNotConfiguredBanner, useToast, errText, Hash),
  `components/shared.tsx` (DocList, Citations, Receipt, Countdown), `components/Layout.tsx` (Portal, Header, DocButton).
  Styles: `apps/web/src/styles.css` (append your own section at the end, prefixed with your feature name).
- i18n: `useI18n()` → `{ t, te, pick, fmtDate, fmtMoney, lang }`. **Every new UI string** goes in your feature's
  `apps/web/src/locales/<feature>.ts` (both `en` and `ar`, keys prefixed `<feature>.`). Replace the placeholder key.

## Demo data (SEED_DEMO=true, password = DEMO_PASSWORD)
- Entity `kea` — Kuwait Energy Authority (fictitious): default template PUBLIC_TENDER (one envelope, gazette, request
  intake, records lock). Tenders KEA-2026-101 (DRAFT), KEA-2026-102 (PUBLISHED, 2 clarifications), KEA-2026-088 (CLOSED,
  3 sealed bids). Request KEA-REQ-2026-0001 with a GM letter. Activity codes IT-01, IT-02, ENG-03, CONS-01.
- Entity `gcia` — Gulf Coast Infrastructure Authority (fictitious): default RFP_TWO_ENVELOPE (2-level approvals
  director → undersecretary, paid documents 50 KWD TEST gateway, gazette + CAPT, min Second grade). Tenders: one
  PENDING_APPROVAL (waiting undersecretary), one PUBLISHED (vendor1 purchased), one CLOSED two-envelope with 2 bids.
- Users in both: officer, director, undersecretary, chair, evaluator1, evaluator2, admin, auditor, vendor1..vendor4
  (vendor4 pending approval; in gcia vendor3 is Third grade → not eligible).

## Non-negotiable rules
1. Never fabricate: no fake success, no canned AI text, no invented numbers. If an integration is not configured,
   say so in the UI. Anything simulated is labelled (e.g. "TEST PAYMENT").
2. Integrity rules stay fixed: sealed bids encrypted until opening; opening only by the chair after the deadline;
   approver ≠ creator; award approver ≠ recommender; append-only audit.
3. Arabic and English for every string; layout must work RTL.
4. Only edit the files your workstream owns (listed in your brief). If you truly need a change elsewhere, keep it
   minimal and mention it in your final report.
5. Keep `npm test -w services/api`, `npx tsc --noEmit -p services/api`, `npx tsc --noEmit -p apps/web` and
   `npm run build -w apps/web` green. Add tests for new backend behaviour.
6. Commit your work on your branch at the end (`git add -A && git commit -m "..."`), with the trailer lines
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
   `Claude-Session: https://claude.ai/code/session_01THCTPiHwoxnpPC1vREqFMF`.
7. The TechZone FileNet and Orchestrate endpoints are NOT reachable from this sandbox. Build against the published
   APIs, unit-test with local fake servers, and mark anything not verified live as such in your docs.

## Setup in a fresh worktree
`node_modules` are not in git. From your worktree root run:
`ln -s /home/claude/tf/node_modules node_modules && ln -s /home/claude/tf/services/api/node_modules services/api/node_modules && ln -s /home/claude/tf/apps/web/node_modules apps/web/node_modules`
(or `npm install` if the links fail). Do **not** commit the symlinks (`node_modules` is git-ignored).

To run the app for a browser check: build the web app, then from `services/api`:
`BID_MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") AUDIT_SIGNING_KEY=dev-audit-key-0123456789 SEED_DEMO=true DEMO_PASSWORD=Demo-Passw0rd! DATA_DIR=/tmp/<you>-data PORT=<unique port> npx tsx src/server.ts`
Browser checks: Playwright is installed at `/tmp/e2e/node_modules/playwright` (write your script under `/tmp/<you>-e2e/` and `import { chromium } from "/tmp/e2e/node_modules/playwright/index.mjs"`), launch with `executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"`.
