# Notifications, approval service levels and escalation

TenderFlow Phase 2 — workstream NOTIFY. This answers the open points of the MOI BRD: *"The notification channel (email,
SMS, in-platform), the provider, and which further events require notice are undecided"* and *"No rejection,
return-for-correction, cancellation, or escalation path has been defined for any workflow"*.

Short version:

- Every notification is rendered from an **entity-editable template** (English + Arabic) and delivered **in-app**
  always; **e-mail** (SMTP) and **SMS** (generic HTTP adapter) are delivered when the template enables them **and** the
  channel is configured on the server. A channel that is not configured is logged as `SKIPPED_NOT_CONFIGURED` — it is
  never reported as sent.
- Every delivery is in a **delivery log** with its real status, provider message id, error and attempts. Failed e-mail /
  SMS are retried with exponential back-off (max 3 attempts) by a **durable background job**.
- Approval levels can carry a **service level** (due hours). A job sends a **reminder** before the due time and, once
  overdue, records one **escalation**, notifies the escalation target and audits `APPROVAL_ESCALATED`. The approval
  itself is never changed — people still decide.
- Tender publication approval gained the missing **Reject** path.

## Where things are

| Screen | Path | Who |
|---|---|---|
| Notification templates (edit EN/AR, live preview, channels, enable/disable, restore default, send test to me, my contact) | Admin → Notifications (`/admin/notifications`) | Entity admin (edit), auditor (read) |
| Delivery log (filters by status, channel, template, text; retry a FAILED e-mail/SMS) | Admin → Delivery log (`/admin/notifications/log`) | Entity admin (retry), auditor (read) |
| Background jobs ("Run now"), approval service levels, overdue approvals | Admin → Background jobs (`/admin/jobs`) | Entity admin (run / edit), auditor (read) |
| "Overdue approvals" card | Procurement dashboard (`/procurement`) | All staff |
| "Overdue by …" / "Due in …" badge | Tender page (publication and award chains), request page (approval chain) | All staff |
| "Reject" button | Tender page, next-action card, for the approver of the waiting publication level | Approver of that level |

## API

| Method | Path | Roles |
|---|---|---|
| GET | `/api/v1/admin/notification-templates` (+ channel status) | TENANT_ADMIN, AUDITOR |
| GET | `/api/v1/admin/notification-templates/:code` | TENANT_ADMIN, AUDITOR |
| POST | `/api/v1/admin/notification-templates/:code/preview` `{subjectEn?, subjectAr?, bodyEn?, bodyAr?}` | TENANT_ADMIN |
| PATCH | `/api/v1/admin/notification-templates/:code` `{texts…, channels?, enabled?, reset?}` — audited `NOTIFICATION_TEMPLATE_UPDATED` | TENANT_ADMIN |
| POST | `/api/v1/admin/notification-templates/:code/test` — to the signed-in admin, marked `[TEST]`, audited | TENANT_ADMIN |
| GET | `/api/v1/admin/notification-deliveries?status=&channel=&templateCode=&q=&limit=` | TENANT_ADMIN, AUDITOR |
| POST | `/api/v1/admin/notification-deliveries/:id/retry` (FAILED e-mail/SMS only; audited) | TENANT_ADMIN |
| GET / PUT | `/api/v1/notifications/contact` `{email, phone}` (own, staff only; audited) | staff |
| PUT | `/api/v1/admin/notification-contacts/:userId` | TENANT_ADMIN |
| GET | `/api/v1/admin/jobs` | TENANT_ADMIN, AUDITOR |
| POST | `/api/v1/admin/jobs/:name/run` (this entity only) | TENANT_ADMIN |
| GET / PUT | `/api/v1/admin/approval-sla` `{defaultDueHours, escalateTo, remindBeforeHours}` (PUT audited `APPROVAL_SLA_UPDATED`) | staff / TENANT_ADMIN |
| GET | `/api/v1/approvals/overdue` | staff |
| GET | `/api/v1/approvals/sla?subjectId=` | staff |
| POST | `/api/v1/tenders/:id/reject` `{reason}` | approver of the waiting publication level |

Everything is tenant-scoped from the token (templates, deliveries, contacts, service levels, escalations). A job run
from the admin page processes only that entity; another entity's admin sees that a run happened, not its result.

## Events and templates

Templates are installed for every entity the first time they are needed (listing the templates, or the first
notification of that code) and by the demo seed (`seedNotifications`, one call at the end of `seed.ts`). This covers
entities created later without a hook in `identity.ts`. Edited templates are never overwritten; "Restore default text"
puts the shipped text back (audited).

Codes are fixed; texts, channels and on/off are per entity. `{entityName} {recipientName} {link} {title}` are
available in every template. A value can be language-specific: Arabic `{vendorName}` uses `vendorNameAr` when the
caller supplies it. Missing values render as `—` (never invented). Dates render in Kuwait time.

| Code | Audience | Default channels | Raised by | Placeholders |
|---|---|---|---|---|
| `NOT-001_SUBSCRIPTION_RENEWAL` (mandatory) | vendor | in-app, e-mail, SMS | MOI vendor lifecycle (other workstream) via `notify(…, templateCode: 'NOT-001')` | vendorName, expiryDate, daysLeft, renewalLink |
| `NOT-002_NEW_VENDOR_APPLICATION` | staff | in-app, e-mail | MOI vendor lifecycle | vendorName, crNumber |
| `NOT-003_GRADE_UPGRADE_APPROVED` | vendor | in-app, e-mail | MOI vendor lifecycle | vendorName, activityCode, grade |
| `NOT-004_REGISTRATION_APPROVED` | vendor | in-app, e-mail, SMS | MOI vendor lifecycle (with KNET link) | vendorName, knetLink |
| `NOT-005_VENDOR_BLOCKED` | vendor | in-app, e-mail, SMS | MOI vendor lifecycle | vendorName, action, reason, until |
| `APPROVAL_WAITING` | staff (role of the next level) | in-app | tender publication / award / request approval chains | reference, subjectTitle |
| `TENDER_PUBLISHED` | eligible vendors in the category | in-app | publication | tenderNumber, tenderTitle, deadline |
| `CLARIFICATION_ANSWERED` | asking vendor | in-app | clarification answer | tenderNumber, tenderTitle |
| `BIDS_OPENED` | bidders | in-app | bid opening (after commit) | tenderNumber, tenderTitle |
| `AWARD_APPROVED` | tender creator, recommender | in-app | final award approval | tenderNumber, tenderTitle |
| `DOCUMENT_EXPIRING` / `DOCUMENT_EXPIRED` | vendor | in-app, e-mail | document intelligence expiry check | documentTitle, date |
| `DOCUMENT_INSIGHT_READY` | officer / committee chair | in-app | document classified, needs review | documentTitle, docType |
| `APPROVAL_REMINDER` | role of the waiting level | in-app, e-mail | approval-escalation job | reference, subjectTitle, gate, level, dueAt |
| `APPROVAL_ESCALATED` | escalation target | in-app, e-mail | approval-escalation job | reference, subjectTitle, gate, level, role, dueAt, overdue |
| `TENDER_REJECTED` | tender creator | in-app | tender reject path | tenderNumber, tenderTitle, level, reason |

**For other features.** The stable API is in `services/api/src/services/notifications.ts` (signatures unchanged):

```ts
notify(q, { tenantId, userId?, vendorId?, kind, titleEn, titleAr, body?, templateCode? })   // inside your ctx.db.tx
notifyRole(q, tenantId, role, { kind, titleEn, titleAr, body?, templateCode? })
```

`templateCode` defaults to `kind`; the short BRD form `'NOT-001'` resolves to `NOT-001_SUBSCRIPTION_RENEWAL`. Pass
placeholder values in `body` (e.g. `{ vendorId, expiryDate, daysLeft, renewalLink }`; `xEn`/`xAr` for per-language
values). `titleEn/titleAr` become `{title}` and are the in-app title when no template exists for the code. Records
referenced by `tenderId`, `requestId`, `documentId`, `vendorId` fill their placeholders automatically. When a template
is disabled, nothing is delivered and the call returns `skipped: 'TEMPLATE_DISABLED'`.

## Channels

| Channel | Recipient address | Enabled when | Not configured |
|---|---|---|---|
| In-app | user or vendor (bell, `/notifications`) | always, while the template is enabled | — |
| E-mail | staff: *My contact for notifications* (`notification_contacts`), else `users.email` if present, else a username that is an e-mail; vendor: the vendor record's e-mail | template lists EMAIL **and** `SMTP_HOST` + `SMTP_FROM` are set | `SKIPPED_NOT_CONFIGURED` |
| SMS | staff contact phone; vendor record phone | template lists SMS **and** `SMS_HTTP_URL` is set | `SKIPPED_NOT_CONFIGURED` |

No address → `SKIPPED_NO_ADDRESS`. E-mail is bilingual in one message (default language first, `NOTIFY_DEFAULT_LANG`),
plain text + simple HTML. SMS uses the default language only, cut at 640 characters.

Delivery statuses: `QUEUED` → `SENT` (provider accepted it; provider message id stored) or, after a failure, back to
`QUEUED` with `next_attempt_at = now + NOTIFY_RETRY_BASE_MS × 2^(attempt-1)`, and `FAILED` after the 3rd attempt. An
admin can re-queue a FAILED delivery (fresh 3 attempts; audited). E-mail / SMS are queued inside the business
transaction and sent right after it (`NOTIFY_SEND_IMMEDIATELY`) and by the `notification-deliveries` job; a row is
leased (`locked_until`) while it is being sent, so it is never sent twice by two runs.

### SMS HTTP adapter contract

Kuwaiti SMS providers differ, so the request is configured, not coded:

| Setting | Meaning |
|---|---|
| `SMS_HTTP_URL` | provider endpoint (enables SMS) |
| `SMS_HTTP_METHOD` | `POST` (default), `PUT` or `GET` |
| `SMS_HTTP_AUTH_HEADER` | one header line, e.g. `Authorization: Bearer <token>` or `X-API-Key: <key>` |
| `SMS_HTTP_CONTENT_TYPE` | `application/json` (default), `application/x-www-form-urlencoded` or `text/plain` |
| `SMS_HTTP_BODY_TEMPLATE` | body with `{to}` `{text}` `{sender}`; JSON-escaped for JSON, URL-encoded for forms; for GET it is appended to the URL as the query string |
| `SMS_SENDER` | value for `{sender}` |
| `SMS_HTTP_MESSAGE_ID_PATH` | dotted path of the message id in a JSON response, e.g. `data.messageId` |
| `SMS_HTTP_TIMEOUT_MS` | default 15000 |

Any 2xx response is a successful hand-over; anything else (or a timeout) is a failure and is retried.

## Background jobs (`services/scheduler.ts`)

```ts
registerJob(name, everyMs, async (ctx, { tenantId, trigger }) => ({ processed: 3 }), { labelEn, labelAr });
```

- Each job has a row in `scheduled_jobs` (last start / finish, status, result, error, run count).
- Single-run guard: a run takes a lease (`locked_until`, `locked_by`) with one atomic `UPDATE … WHERE locked_until IS
  NULL OR locked_until < now`, so an overlapping manual run, a second timer or a second process (PostgreSQL) cannot run
  the same job twice; a lease expires on its own if a process dies.
- Timers are `unref()`'d and stop before the database closes. Under `node --test` timers are off unless
  `SCHEDULER_ENABLED=true`; "Run now" always works. When `tenantId` is passed (manual run by an entity admin), the job
  must only touch that entity's data.
- Registered jobs: `notification-deliveries` (every 30 s), `approval-escalation` (every 5 min). Other features can
  register their jobs the same way (the existing per-feature `setInterval` jobs can be moved here during the merge).

## Approval service levels and escalation

Entity setting (Admin → Background jobs → *Approval service levels*, `approval_sla_settings`):

- `defaultDueHours` — due time of every waiting level; a level's own `dueHours` in the cycle template wins
  (`level.dueHours ?? defaultDueHours`, read defensively — the designer field is added by another workstream).
- `remindBeforeHours` — when to remind the approver's role (empty: no reminder).
- `escalateTo` — `NEXT_LEVEL_ROLE` (the role of the following level; the entity admin after the last level),
  `TENANT_ADMIN`, or a role. If nobody holds the target role, the entity admin is notified instead.

The `approval-escalation` job looks at every WAITING level — tender publication (from the first pack upload, the last
approval or the last return), tender award (from the recommendation or the last award approval) and departmental
requests (from submission, the last approval or the last return). For each level it creates at most one `REMINDER`
and one `ESCALATION` record (`approval_escalations`, unique per subject, gate, level and waiting-since, so a level that
waits again after a return starts a new clock), notifies, and audits `APPROVAL_REMINDER_SENT` / `APPROVAL_ESCALATED`
in the same transaction. The approval is not changed.

## Approval paths (complete set)

| Workflow | Approve | Return for correction | Reject | Cancel | Escalation |
|---|---|---|---|---|---|
| Departmental request (`/requests/:id/decision`) | level by level | `RETURN` (reason) → SUBMITTED, chain restarts | `REJECT` (reason) → REJECTED | — | service level + reminder + escalation |
| Tender publication | `/tenders/:id/approve`, level by level | `/tenders/:id/return` (reason) → DRAFT, chain restarts | **new** `/tenders/:id/reject` (reason; approver of the waiting level; not the creator; one person one level) → CANCELLED, creator notified, audited `TENDER_REJECTED` | `/tenders/:id/cancel` (director, reason) | service level + reminder + escalation |
| Tender award | `/tenders/:id/award/approve`, level by level (recommender ≠ approver) | not available | not available | via tender cancel before opening only | service level + reminder + escalation |
| Vendor registration | `/vendors/:id/decision` approve | — | reject | — | — |

Not done here: returning an award recommendation to the committee (no "return" on the award gate yet).

## Settings (`.env`, block `# --- notify ---`)

| Setting | Default | |
|---|---|---|
| `SMTP_HOST`, `SMTP_FROM` | — | both required to enable e-mail |
| `SMTP_PORT` | 587 (465 when `SMTP_SECURE=true`) | |
| `SMTP_SECURE` | false | true = implicit TLS (465); false = STARTTLS when offered |
| `SMTP_USER`, `SMTP_PASS` | — | AUTH when set |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | true | false only for an internal relay with a self-signed certificate |
| `SMS_HTTP_*`, `SMS_SENDER` | — | see the adapter contract |
| `NOTIFY_DEFAULT_LANG` | ar | SMS language, first half of e-mails |
| `SCHEDULER_ENABLED` | true (false under `node --test`) | automatic job runs |
| `NOTIFY_DELIVERY_JOB_MS` | 30000 | |
| `NOTIFY_RETRY_BASE_MS` | 60000 | first retry wait; doubles each time |
| `NOTIFY_SEND_IMMEDIATELY` | true | send right after the business transaction |
| `APPROVAL_ESCALATION_JOB_MS` | 300000 | |
| `PUBLIC_BASE_URL` | — | makes `{link}` absolute in e-mail / SMS |

## Pointing TenderFlow at a real SMTP server (Windows)

1. Ask the mail team for: relay host name, port (587 STARTTLS or 465 TLS), whether authentication is required, the
   sender address allowed to relay (e.g. `tenderflow@entity.gov.kw`), and whether the relay uses a private CA.
2. Check the server can reach the relay (PowerShell):
   `Test-NetConnection smtp.entity.gov.kw -Port 587` → `TcpTestSucceeded : True`.
3. Edit `.env` in the TenderFlow folder (Notepad):
   ```
   SMTP_HOST=smtp.entity.gov.kw
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_USER=tenderflow@entity.gov.kw
   SMTP_PASS=<password from the mail team>
   SMTP_FROM=TenderFlow <tenderflow@entity.gov.kw>
   PUBLIC_BASE_URL=https://tenderflow.entity.gov.kw
   ```
   For Microsoft 365 use `smtp.office365.com`, port 587, `SMTP_SECURE=false`, a licensed mailbox with SMTP AUTH
   enabled. For an internal relay with a private CA either import the CA (set `NODE_EXTRA_CA_CERTS=C:\certs\ca.pem`)
   or, as a last resort, `SMTP_TLS_REJECT_UNAUTHORIZED=false`.
4. Restart TenderFlow (stop the running `npm start` window with Ctrl+C and run `npm start` again, or restart the
   Windows service if it was installed as one).
5. Sign in as the entity admin → Admin → Notifications. The channel strip must show **E-mail configured** with the host.
6. In *My contact for notifications* enter your mailbox, Save, choose a template that has E-mail ticked and press
   **Send test to me**. The result shows `E-mail — Sent` with the provider message id, or `Failed` with the SMTP error.
7. Admin → Delivery log shows the same row; a failure is retried automatically (3 attempts) and can be re-queued with
   **Retry**.

SMS: set `SMS_HTTP_URL` and the other `SMS_HTTP_*` values from the provider's API document, restart, enter your mobile
in *My contact*, tick SMS on a template and **Send test to me**.

## What is verified

| Item | How | Status |
|---|---|---|
| Template rendering, placeholders, language-specific values, Kuwait time, missing value → `—` | `test/notify.test.ts` | test |
| Templates installed per entity (BRD set + system events), tenant isolation of templates and logs | `test/notify.test.ts` | test |
| Admin edit audited; unknown placeholder refused; preview with sample values in EN + AR | test + browser | test, browser (EN + AR) |
| Channel not configured → `SKIPPED_NOT_CONFIGURED`, never `SENT` | test + browser (delivery log, test send) | test, browser |
| E-mail through SMTP (AUTH, recipient, bilingual body, message id) | `test/notify-channels.test.ts` with `test/fakes/fake-smtp.ts`; browser with the same fake running | test, browser |
| SMS HTTP adapter (auth header, JSON body template, message id path) | `test/notify-channels.test.ts` with `test/fakes/fake-sms.ts`; browser | test, browser |
| Retries with back-off, FAILED after 3 attempts, re-queue | `test/notify-channels.test.ts` | test |
| Scheduler single-run guard, durable last run / result / error, per-entity result visibility | `test/notify.test.ts` | test |
| Reminder before due; one escalation per level + notification + audit; tenant isolation | `test/notify.test.ts` | test |
| "Run now" escalation → overdue badge (dashboard card, request and tender chains), escalation in admin's bell | browser (EN + AR) | browser |
| Tender reject: reason required, role / creator / segregation checks, audited, creator notified | test + browser | test, browser |
| A real SMTP relay, Microsoft 365, a real Kuwaiti SMS provider | — | **needs live system** |

Screenshots of the browser checks: `/tmp/notify-shots/` on the build machine (not committed).
