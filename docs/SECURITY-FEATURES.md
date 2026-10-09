# TenderFlow security features (Phase 2, SEC workstream)

Identity, access and content protection for any entity using TenderFlow. MOI requirement references: INT-004 (staff
authenticate against MOI Active Directory), SEC-003 (internal system reachable only from MOI premises — definition
still open), SEC-005 (vendor MFA, proposed), SEC-001/002 (no screenshots while viewing tenders), FR-023 (watermarked
download, proposed), FR-035 (account administration), FR-036 (roles).

All settings are per entity (table `security_settings`, migration `005_security.sql`) and are edited by a
`TENANT_ADMIN` on **Admin → Identity & access** (`/admin/identity`). Every change is written to the HMAC audit log
(`SECURITY_SETTINGS_UPDATED`, with the changed sections). The tenant always comes from the session token.

| Control | Where | Default |
|---|---|---|
| Two-step verification (TOTP) | Admin → Identity & access → *Sign-in and document protection*; users: *Two-step verification* in their portal | OFF for vendors and staff (demo keeps working) |
| Staff single sign-on (OIDC: Entra ID / AD FS) | Admin → Identity & access → *Staff single sign-on* | not configured |
| Staff network allowlist | Admin → Identity & access → *Staff network allowlist* | OFF |
| Account administration | Admin → Accounts (`/admin/accounts`) | — |
| Tender document protection | Admin → Identity & access, or the cycle template `config.contentProtection` | OFF |

---

## 1. Two-step verification (TOTP, RFC 6238)

**What it does.** After the password, the user enters a 6-digit code from any authenticator app (Microsoft
Authenticator, Google Authenticator, …). HMAC-SHA1, 30-second steps, 6 digits, ±1 step tolerance, implemented with
`node:crypto` only (`services/api/src/auth/totp.ts`).

- **Policy** per entity and per population: `mfaVendors` and `mfaStaff`, each `OFF | OPTIONAL | REQUIRED`.
  OPTIONAL: users may enrol; once enrolled the code is asked at every sign-in. REQUIRED: a user without it must enrol
  during the next sign-in before any session is issued.
- **Enrolment**: QR code (`qrcode` package, data URL) + manual key → confirm with a current code → **8 one-time
  recovery codes shown once**. Only scrypt hashes of the recovery codes are stored.
- **Sign-in**: password OK → short-lived (5 min) `mfa_pending` token with a different JWT audience (never accepted as a
  session) → code or recovery code → normal RS256 session. A recovery code is burned when used. A TOTP step that was
  already accepted cannot be replayed.
- **Rate limit**: 5 wrong codes lock the second factor for 5 minutes (HTTP 429 `MFA_LOCKED`), plus the per-IP request
  limiter on the public routes.
- **Secrets at rest**: AES-256-GCM, bound to the user (additional authenticated data `mfa:<tenant>:<user>`). Key =
  `MFA_ENC_KEY` (base64 of 32 bytes) or, if unset, HKDF-SHA256 derived from `AUDIT_SIGNING_KEY`. Rotating the key makes
  existing enrolments unreadable — reset the users and let them enrol again.
- **Admin reset** (Accounts → *Reset two-step*, reason required) deletes the enrolment.
- **Audit**: `MFA_ENROLMENT_STARTED`, `MFA_ENROLLED`, `MFA_VERIFICATION_FAILED` (each failure, with attempt number and
  lock), `MFA_RECOVERY_CODE_USED`, `MFA_DISABLED_BY_USER`, `MFA_RESET_BY_ADMIN`, `LOGIN_PASSWORD_ACCEPTED_MFA_PENDING`,
  `LOGIN` (details.method `PASSWORD+TOTP` / `PASSWORD+RECOVERY_CODE`).

API: `POST /auth/login` → `{ mfaRequired, enrolRequired, mfaToken }`; `POST /auth/mfa/verify`,
`/auth/mfa/enrol/start`, `/auth/mfa/enrol/confirm` (with `mfaToken`); signed-in: `GET /security/mfa/me`,
`POST /security/mfa/enrol/start|confirm`, `POST /security/mfa/disable` (only when the policy is not REQUIRED).

## 2. Staff single sign-on with Active Directory (OIDC)

**What it does.** Entity staff click **“Sign in with <entity> Active Directory”** on the login page (shown only when the
entity has enabled it). Authorization-code flow with **PKCE (S256), state and nonce**
(`services/api/src/features/security/sso.ts`):

1. `GET /api/v1/auth/oidc/<tenant>/start` → discovery (`<issuer>/.well-known/openid-configuration`) → redirect to the
   IdP. state/nonce/verifier are stored server-side for 10 minutes, single use.
2. IdP → `GET /api/v1/auth/oidc/callback` → code exchanged at the token endpoint (client secret from the server
   environment) → **ID token validated with the issuer JWKS (jose)**: signature, `iss`, `aud` = client id, `exp/nbf`
   (60 s tolerance), `nonce`.
3. Groups claim → TenderFlow roles through the mapping table (staff roles only; vendors never use staff SSO).
4. Provisioning:
   - `ADMIN_CREATED` (MOI open item “account provisioning”): the username must already exist (created on Admin → Users);
     the account is linked to the directory subject at first sign-in and keeps its TenderFlow roles.
   - `JIT_FROM_GROUPS`: the account is created or updated at sign-in; roles are replaced from the mapped groups at every
     sign-in; no mapped group → refused.
5. Disabled accounts and the staff network allowlist are checked, then a 60-second single-use hand-off returns the
   browser to `/login`, which exchanges it (`POST /auth/oidc/exchange`) for the normal TenderFlow RS256 session.

Refusals return to the login page with a bilingual message and are audited (`SSO_LOGIN_REFUSED` with the reason code):
`SSO_NONCE_MISMATCH`, `SSO_TOKEN_AUDIENCE`, `SSO_TOKEN_EXPIRED`, `SSO_TOKEN_ISSUER`, `SSO_TOKEN_INVALID` (signature),
`SSO_NO_MAPPED_GROUP`, `SSO_NOT_PROVISIONED`, `SSO_GROUPS_OVERAGE` (Entra ID group overage — emit only groups
assigned to the application, or app roles), `SSO_IDP_ERROR`, `SSO_TOKEN_EXCHANGE_FAILED`, `SSO_STATE_INVALID`, …
Successful provisioning/linking is audited (`USER_PROVISIONED_FROM_DIRECTORY`, `USER_LINKED_TO_DIRECTORY`,
`USER_ROLES_SYNCED_FROM_DIRECTORY`).

**Configuration** (admin page): issuer URL, client id, **client secret by environment-variable reference only**
(`TF_OIDC_SECRET_*`; the secret is never entered, stored or returned), scopes, groups claim, username claim, mapping
table, provisioning mode, button names (EN/AR). *Test connection* reads the discovery document. The redirect URI to
register is shown on the page: `<PUBLIC_BASE_URL>/api/v1/auth/oidc/callback`.

### Trying SSO against Microsoft Entra ID (Windows)

1. Entra admin center → **App registrations → New registration**. Name *TenderFlow*. Redirect URI: platform **Web**,
   `https://<your TenderFlow host>/api/v1/auth/oidc/callback` (for a local test: `http://localhost:4000/api/v1/auth/oidc/callback`
   with `PUBLIC_BASE_URL=http://localhost:4000`).
2. **Certificates & secrets → New client secret**; copy the value.
3. **Token configuration → Add groups claim** → *Security groups* (or *Groups assigned to the application* for large
   directories). Keep “Group ID” for the ID token. Optional: add the `preferred_username` optional claim.
4. In PowerShell, before starting TenderFlow:
   ```powershell
   $env:TF_OIDC_SECRET_MOI = "<the client secret value>"
   npm start
   ```
5. In TenderFlow, Admin → Identity & access → Staff single sign-on: issuer
   `https://login.microsoftonline.com/<Directory (tenant) ID>/v2.0`, client id = *Application (client) ID*, secret
   variable `TF_OIDC_SECRET_MOI`, groups claim `groups`, username claim `preferred_username`. Add mapping rows with the
   **group object IDs** (Entra → Groups → the group → *Object ID*) and their roles. Choose the provisioning mode, tick
   “Show … on the login page”, Save, then *Test connection*.
6. Sign out, choose the entity on the login page and click **Sign in with … Active Directory**.

AD FS 2016+: create an *Application Group* (“Server application accessing a web API” or “Web browser accessing a web
application”), issuer `https://<adfs-host>/adfs`, and an issuance transform rule that emits `groups` (e.g. *Send LDAP
Attributes as Claims* → Token-Groups → `groups`) and `preferred_username`/`upn` (set the username claim accordingly).

**Verified:** against a local fake OIDC provider (`services/api/test/fakes/fake-oidc.ts`: discovery, JWKS, authorize,
token endpoint with PKCE and client-secret checks) in `test/sec-sso.test.ts`. **Not verified against a live Entra ID or
AD FS** (not reachable from the build environment).

## 3. Staff network allowlist (“premises restriction”, SEC-003)

**What it does.** When `staffNetwork.mode = ALLOWLIST`, any request with a staff-role token **and** every staff sign-in
(password, second step, SSO hand-off) is accepted only from the listed IPv4/IPv6 CIDR ranges; otherwise HTTP 403
`OUTSIDE_PREMISES` with a bilingual message. Vendors are never affected. CIDR matching is our own small implementation
(`services/api/src/auth/cidr.ts`, IPv4, IPv6, IPv4-mapped IPv6, zone ids).

- **Caller address**: the TCP peer address; only when *trustProxyHeader* is on, the address appended by the entity’s
  own reverse proxy (`X-Forwarded-For`, right-most hop — Express `trust proxy = 1`). Turn it on only behind your own
  proxy, otherwise a client could claim any address.
- **basis**: the entity records which reading of SEC-003 the ranges implement — `PREMISES_NETWORK`,
  `VPN_ADDRESS_POOL` or `PREMISES_AND_VPN`. *Managed devices* (device certificates / MDM / conditional access) are
  **not** implemented by an IP allowlist; with Entra ID that reading is best enforced by Conditional Access on the SSO
  app.
- The admin page shows the caller’s address as the server sees it and whether it is inside; *Check my address* tests
  a list before saving.
- **No silent lock-out**: saving a list that excludes the saver’s own address is refused (409 `SELF_LOCKOUT`) unless the
  admin confirms explicitly (`confirmSelfLockout`, audited). Emergency switch: `STAFF_NETWORK_BREAK_GLASS=true` in the
  server environment disables enforcement (warning shown on the admin page).
- **Audit**: `STAFF_ACCESS_OUTSIDE_PREMISES` (rate-limited: one event per user, address, phase and minute).

## 4. Account administration (FR-035 / FR-036)

Admin → **Accounts** lists all entity staff and vendor users with roles, status, second-factor state, sign-in source
(local / directory) and last sign-in. Actions (all audited, reason required where marked):

- **Disable / enable** (reason) → `USER_DISABLED` / `USER_ENABLED`. A disabled user cannot sign in (password or SSO,
  `LOGIN_REFUSED_ACCOUNT_DISABLED`), and **tokens already issued stop working at the next request**.
- **Roles** (staff only; vendor users always keep exactly `VENDOR`) → `USER_ROLES_CHANGED`. A role change also ends the
  user’s current session (the token’s roles must match the account).
- **Amend** display name / reset password (not for directory accounts) → `USER_AMENDED`.
- **Reset two-step verification** (reason) → `MFA_RESET_BY_ADMIN`.
- Guards: an admin cannot disable themself or remove their own admin role; the entity always keeps one active admin.
- The role catalogue with what each role may do is served by `GET /security/roles` (roles are fixed in this release and
  enforced on the server; per-entity custom roles are not implemented).

New staff users are still created on Admin → Users; vendor users come from vendor registration.

## 5. Tender document protection (SEC-001/002, FR-023)

**Mode** per tender: cycle template `config.contentProtection` → entity security setting → entity profile
`contentProtection` → `OFF`. Values: `OFF | VIEW_ONLY | WATERMARKED_DOWNLOAD`. Applies to vendors and to tender pack /
addendum documents only. **Staff always see the originals.**

When protected, a vendor’s `GET /documents/:id` for that document is refused (403 `CONTENT_PROTECTED`); the document
list shows **View** (and, when allowed, **Watermarked PDF**) instead of Download.

### Protected viewer (chosen approach)

The server extracts the document text page by page (PDF: unpdf; DOCX: mammoth; text/markdown/HTML as text; PNG/JPEG
as the image), inserts an invisible per-view fingerprint (zero-width characters encoding the view id) and returns it with
the watermark lines (vendor company name, vendor ID + CR, username, UTC time, short request id, receipt number if
purchased). The browser paints the text **and a tiled diagonal watermark into the same `<canvas>` pixels**; the text
is never in the DOM, so it cannot be selected or copied, and any screenshot or photo carries the vendor’s identity.
We chose this over server-side rasterisation (pdf.js + canvas native modules on the server) because it has no native
dependencies, works for every text format and keeps Arabic shaping correct (the browser shapes the text).
Limitation: layout is simplified (text flow, not the original page design); scanned PDFs without a text layer show a
“no text layer” page — such files need OCR before publishing.

Viewer deterrents: no download button in `VIEW_ONLY`; right-click, copy, select-all, save and print shortcuts blocked;
content blurred while the window loses focus or the tab is hidden; **PrintScreen → blur + audit event**; `@media print`
prints only a “printing not allowed” notice. Deterrent events are audited (`CONTENT_PROTECTION_EVENT`, max 30 per view).
Every opening is audited: **`TENDER_DOCUMENT_VIEWED`** (vendor, user, document, tender, mode, view id). The viewer is
available before and after purchase (SEC-001/002).

**Honest limit (also shown in the viewer):** a web browser cannot technically prevent screenshots, screen recording or
photographing the screen. The controls deter casual copying; the per-vendor watermark and the audit trail make any
leak traceable to the vendor account.

### Watermarked download (`WATERMARKED_DOWNLOAD`)

`GET /security/content/documents/:id/download` (vendors): when purchase is required by the cycle and the vendor has not
purchased → 402 `PURCHASE_REQUIRED`. PDFs are stamped with pdf-lib on **every page**: a tiled diagonal stamp and a
footer (vendor name, vendor ID, CR, username, UTC timestamp, download id, receipt number). The stored original (FileNet
or file store) is never modified; the stamped copy is generated per download. Non-PDF files stay view-only
(409 `VIEW_ONLY_FORMAT`); encrypted PDFs cannot be stamped (409 `PDF_ENCRYPTED`). Standard PDF fonts are Latin-only,
so the PDF stamp uses the vendor’s English legal name. Audit: `TENDER_DOCUMENT_DOWNLOADED_WATERMARKED` with the SHA-256
of the original and of the stamped copy.

---

## Settings reference

`PUT /security/settings` (TENANT_ADMIN), any subset of:

```json
{
  "mfaVendors": "OFF|OPTIONAL|REQUIRED",
  "mfaStaff": "OFF|OPTIONAL|REQUIRED",
  "contentProtection": "OFF|VIEW_ONLY|WATERMARKED_DOWNLOAD|null",
  "staffNetwork": { "mode": "OFF|ALLOWLIST", "cidrs": ["10.20.0.0/16"], "trustProxyHeader": false, "basis": "PREMISES_NETWORK" },
  "oidc": { "enabled": true, "displayNameEn": "MOI Active Directory", "displayNameAr": "الدليل النشط لوزارة الداخلية",
            "issuer": "https://login.microsoftonline.com/<tid>/v2.0", "clientId": "…", "clientSecretEnv": "TF_OIDC_SECRET_MOI",
            "scopes": "openid profile email", "groupsClaim": "groups", "usernameClaim": "preferred_username",
            "mappings": [{ "group": "<group object id>", "roles": ["PROCUREMENT_OFFICER"] }], "provisioning": "ADMIN_CREATED" },
  "confirmSelfLockout": false,
  "reason": "optional, written to the audit event"
}
```

Environment (`.env.example`, block `# --- security ---`): `MFA_ENC_KEY`, `STAFF_NETWORK_BREAK_GLASS`,
`OIDC_ALLOW_HTTP` (plain-http non-localhost issuer, never in production), `TF_OIDC_SECRET_*`.

## What is verified

| Control | Automated tests | Browser (EN + AR) | Live system |
|---|---|---|---|
| TOTP (RFC 6238 Appendix B vectors), Base32, recovery codes, secret encryption | `test/sec-units.test.ts` | — | — |
| MFA sign-in OFF/OPTIONAL/REQUIRED, replay, lock-out, admin reset, recovery code once | `test/sec-access.test.ts` | enrol + code sign-in + recovery code once / reuse refused | — |
| Account disable/enable, roles, amend, guards | `test/sec-access.test.ts` | accounts page | — |
| Staff network allowlist (IPv4/IPv6 CIDR, proxy header, self-lock-out, audit, vendors unaffected) | `test/sec-units.test.ts`, `test/sec-access.test.ts` | refusal message EN/AR via trusted proxy header; self-lock-out confirmation | — |
| OIDC SSO (PKCE, state, nonce, JWKS, audience, expiry, foreign signature, unmapped groups, ADMIN_CREATED, allowlist) | `test/sec-sso.test.ts` with the fake provider | admin configuration page | **not verified** with Entra ID / AD FS |
| Protected viewer, audit, deterrent events, other tenant refused, purchase rules | `test/sec-content.test.ts` | watermark on canvas, blur on focus loss, PrintScreen | — |
| Watermarked PDF (every page, vendor, ID, time, receipt; original unchanged) | `test/sec-content.test.ts`, `test/sec-units.test.ts` | downloaded from the UI and checked with unpdf | FileNet-stored originals not verified live |
