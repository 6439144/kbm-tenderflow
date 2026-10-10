# TenderFlow — installation and operations

For: KBM delivery engineers and the entity's IT operations team. Version 1.0.0-rc3.

**One installation per government entity.** TenderFlow is sold to each entity separately and runs in separation from
other entities: every entity gets its own installation (`TENANCY_MODE=dedicated`, `ENTITY_ID=<entity code>`), its own
database, its own FileNet object store (or root folder) and its own Orchestrate instance (or agent set). See §5 and
[DEPLOYMENT-MODEL.md](DEPLOYMENT-MODEL.md). `TENANCY_MODE=shared` (several entities in one installation) is only for
KBM's multi-entity demo.

| Deployment | Database | Documents | Use |
|---|---|---|---|
| Windows laptop (demo) | embedded PGlite in `.\data` | local files (or FileNet TechZone) | presentations, workshops |
| OpenShift `demo` overlay | PGlite on a PVC, 1 pod | PVC (or FileNet) | shared demo / UAT with fictitious data |
| OpenShift `production` overlay | PostgreSQL | IBM FileNet Content Manager | live tendering, 2+ pods |

Contents: [1 Windows demo](#1-windows-demo-install) · [2 OpenShift](#2-openshift-install) · [3 PostgreSQL](#3-postgresql) ·
[4 Configuration and production safety](#4-configuration-and-production-safety) · [5 One installation per entity](#5-one-installation-per-entity) ·
[6 Backups](#6-backups-database--filenet--keys) · [7 Keys](#7-keys-and-rotation) · [8 Upgrades](#8-upgrade-procedure) ·
[9 Monitoring](#9-monitoring-endpoints) · [10 Troubleshooting](#10-troubleshooting)

---

## 1. Windows demo install

Requirements: Windows 10/11, Node.js 20 or newer (22 LTS recommended), 2 GB free disk.

```powershell
cd C:\TenderFlow                         # the folder with README.md
copy .env.example .env                    # first time only
npm install
npm run gen-keys                          # paste the two printed lines into .env
notepad .env                              # DEMO_PASSWORD=<choose one>; SEED_DEMO=true; DEMO_MODE=true; TF_ENV=demo
                                          # one demo entity (default): DEMO_ENTITY=kea|gcia|moi; all three: TENANCY_MODE=shared
npm run config:check                      # every line OK or WARN (WARN = would be refused in production)
npm run build
npm start                                 # http://localhost:4000
```

* Data (database + files) lives in `.\data`. Stop the server and delete the folder, or run `npm run demo:reset -- --yes`,
  to start again with fresh demo data.
* FileNet / Orchestrate on TechZone: see the README sections "Connect IBM FileNet" and "Connect IBM watsonx Orchestrate".
  A plain-http TechZone FileNet endpoint is fine outside production; with `TF_ENV=production` it needs
  `ALLOW_INSECURE_FILENET=true` explicitly.
* Stop with Ctrl+C: the server finishes running requests, stops background jobs and closes the database cleanly.

## 2. OpenShift install

Manifests: [`deploy/openshift/`](../deploy/openshift/README.md) (Kustomize base + `demo` and `production` overlays).
Image: [`Containerfile`](../Containerfile) (UBI 9 Node.js 22, non-root, works with arbitrary UIDs).

1. **Project:** one project per entity, e.g. `oc new-project tenderflow-moh` (production; set `namespace:` in your copy of
   the overlay) or `oc new-project tenderflow-demo`.
2. **Image:** build in the cluster or with Podman (commands in `deploy/openshift/README.md`). Pass `TF_COMMIT` and
   `TF_BUILD_TIME` build arguments so `GET /api/v1/version` identifies the build.
3. **PostgreSQL** (production): see §3. Put `DATABASE_URL` in the Secret.
4. **Secret:** `npm run gen-keys -- --production > tenderflow-secrets.env`, add the site values listed in
   `deploy/openshift/base/secret.template.yaml`, then `oc create secret generic tenderflow-secrets --from-env-file=tenderflow-secrets.env`.
   Store the file in the customer's vault and delete the local copy.
5. **Overlay values:** in `overlays/production/kustomization.yaml` set `ENTITY_ID` (the entity code, e.g. `moh`; the
   API refuses to start in production while it is empty), `PUBLIC_BASE_URL` (the final https URL),
   the image name/tag, and in `pvc-patch.yaml` a ReadWriteMany storage class (e.g. ODF CephFS).
6. **Check, then apply:** run `config:check` in a one-off pod with the same Secret (command in the deploy README), then
   `oc apply -k deploy/openshift/overlays/production` and `oc rollout status deploy/tenderflow`.
7. **Smoke test:** `curl -s https://<route>/api/v1/version`, `curl -si https://<route>/ready` (200), sign in.
8. **The entity:** §5 (`entity:create` with `--code` = `ENTITY_ID`).

What is created: Deployment (startup/readiness/liveness probes, requests/limits, restricted securityContext, read-only
root filesystem), Service, Route (edge TLS, http→https redirect, 120 s timeout, HSTS), PVC for `/data`, ConfigMap,
NetworkPolicy (only the router may connect), PodDisruptionBudget (one pod at a time).

Ports and paths: the container listens on 4000; it writes only to `/data` (PVC) and `/tmp` (emptyDir).

## 3. PostgreSQL

* PostgreSQL 14 or newer (15/16 recommended): Crunchy Postgres for Kubernetes, EDB, a managed service, or the entity's
  existing cluster. No extensions are required.
* Create a database and an owner role (TenderFlow creates its own tables at start-up):

  ```sql
  CREATE ROLE tenderflow LOGIN PASSWORD '<from the vault>';
  CREATE DATABASE tenderflow OWNER tenderflow ENCODING 'UTF8';
  ```

* `DATABASE_URL=postgresql://tenderflow:<password>@<host>:5432/tenderflow` (add `?sslmode=require` when the server
  uses TLS). Each pod opens up to 10 connections; size `max_connections` for replicas × 10 plus admin tools.
* Migrations (`services/api/migrations/NNN_*.sql`) run automatically at start-up under a PostgreSQL advisory lock, so pods
  that start together wait instead of colliding. `/ready` stays 503 while any migration is pending.
* The audit table is append-only (a trigger refuses UPDATE, DELETE and TRUNCATE) — including for the database owner.
  Do not "clean up" audit rows; a restore must bring the whole table back.
* `npm run config:check -- --connect` (or `node services/api/dist/tools/config-check.js --connect` in a pod) checks that the
  database is reachable and lists pending migrations.

## 4. Configuration and production safety

All settings are environment variables (`.env` locally; ConfigMap + Secret on OpenShift). Reference: `.env.example`.

`TF_ENV` = `development` (default) · `demo` · `test` · `production`. With **`TF_ENV=production` the API refuses to start**
and prints every reason when any of these is true:

| Refused in production | Fix |
|---|---|
| `TENANCY_MODE=dedicated` (default) without `ENTITY_ID` | set `ENTITY_ID` to the entity code |
| `DEMO_MODE=true`, `SEED_DEMO=true` or `DEMO_PASSWORD` set | remove them |
| no `DATABASE_URL` (embedded PGlite) | PostgreSQL (§3) |
| `BID_MASTER_KEY`, `AUDIT_SIGNING_KEY` missing, weak (low entropy, < 32 characters), a placeholder, or the same value | `npm run gen-keys -- --production` |
| `JWT_PRIVATE_KEY_PEM` missing or an RSA key under 2048 bits | same command (RSA 3072) |
| `MFA_ENC_KEY` set but weak | same command |
| `PUBLIC_BASE_URL` not `https://` | the Route URL |
| FileNet GraphQL over plain `http://` | https, or `ALLOW_INSECURE_FILENET=true` (explicit, shown as WARN) |
| `OIDC_ALLOW_HTTP=true`, or an external OIDC issuer over http | https identity provider |

**`npm run config:check`** prints every check as OK / WARN / FAIL and exits 1 on any FAIL. It never prints secret values
(only "set / missing / length / strength"; URLs without credentials). Options: `--connect` (PostgreSQL round trip and
pending migrations), `--json`. Outside production the production rules appear as WARN "would refuse to start with
TF_ENV=production", so a UAT system shows what is left before go-live.

Other ops settings: `TRUST_PROXY` (reverse-proxy hops, default 1 = the OpenShift router; used for client IPs in the audit
log, rate limits and the staff network allowlist), `SHUTDOWN_DELAY_MS` / `SHUTDOWN_TIMEOUT_MS` (§9), `TF_EVIDENCE_DIR`.

## 5. One installation per entity

Each government entity gets its own installation; a new entity is a new installation, never a new tenant in an
existing one (a dedicated installation refuses to create any entity other than `ENTITY_ID`, answer 403
`ENTITY_CREATION_DISABLED`).

| Per entity | Recommended | Also supported |
|---|---|---|
| OpenShift | own namespace (`tenderflow-<code>`) with its Deployment, Route, ConfigMap (`ENTITY_ID`), NetworkPolicy and **own Secret** (own `BID_MASTER_KEY`, `AUDIT_SIGNING_KEY`, `JWT_PRIVATE_KEY_PEM`, `MFA_ENC_KEY`) | several entity namespaces on one cluster |
| PostgreSQL | own database and owner role, own backups | several entity databases on one PostgreSQL server; never two entities in one database |
| FileNet | own object store | shared object store with a different `FILENET_ROOT_FOLDER` per entity (e.g. `/TenderFlow-MOH`) and a service user per entity limited to that folder |
| Orchestrate | own instance (own API key and run history) | shared instance with a separate agent set per entity, referenced through `WXO_AGENT_*` (renamed copies; the import scripts use fixed names) |

Start-up checks: with `ENTITY_ID` set, a database that holds other entities but not this one is refused; an empty
database starts and waits for the entity to be provisioned (below). `GET /api/v1/public/deployment` shows the
installation's mode and entity.

### Provision the installation's entity

```bash
npm run entity:create -- --code moh --name-en "Ministry of Health (example)" --name-ar "وزارة الصحة (مثال)" \
  --colour "#0B4F6C" --sector "Health" --default-template PUBLIC_TENDER [--admin-username admin] [--dry-run]
# OpenShift: oc exec deploy/tenderflow -- node services/api/dist/tools/entity-create.js --code moh …
```

In a dedicated installation `--code` must be the installation's `ENTITY_ID`. It creates the entity and its profile (numbering `MOH-{YYYY}-{SEQ3}`, receipts `MOH-R-{YYYY}-{SEQ5}`), the first
administrator (`TENANT_ADMIN`), the three starter cycle templates (published; the chosen one is the default), the default
document types, the bilingual notification templates and a 48-hour approval service level. Every step is written to the
entity's audit chain, plus an `ENTITY_PROVISIONED` summary.

* **Password:** set `TF_ENTITY_ADMIN_PASSWORD` (≥ 12 characters, never printed) or let the tool generate a one-time
  password that is **printed once** on the console. It is stored only as a bcrypt hash and never written to the audit
  log. The administrator should enrol two-step verification, create named administrator accounts and then reset or
  disable the bootstrap account (Admin → Identity & access). TenderFlow has no forced "change password at first sign-in".
* **Idempotent:** running it again for the same code changes nothing (an existing administrator keeps its password) and
  says "already fully provisioned"; after an interrupted run it completes only the missing parts.
* **PGlite:** stop the API first (one process per data directory). PostgreSQL: run it any time.

## 6. Backups (database + FileNet + keys)

A consistent restore needs **three** things from the same point in time:

1. **The TenderFlow database.**
   * PostgreSQL: nightly `pg_dump -Fc -d "$DATABASE_URL" -f tenderflow-$(date +%F).dump` plus WAL archiving / PITR from
     your operator (Crunchy PGO `pgBackRest`, EDB Barman, or the managed service). Restore into an empty database with
     `pg_restore --no-owner -d <url> tenderflow-….dump`, then start the API.
   * PGlite (demo): stop the API (or scale the Deployment to 0), copy `DATA_DIR` (`.\data`, or the PVC via
     `oc rsync`), start again. Never copy a running PGlite directory.
2. **The documents.**
   * FileNet: back up the object store **database** and its **storage areas** together, following IBM's FileNet P8 backup
     procedure (TenderFlow documents live under `/TenderFlow/<entity>/…`). TenderFlow rows reference FileNet object ids,
     so restore FileNet and the TenderFlow database to the same point.
   * Filesystem store: `DATA_DIR/content` (with the database, same moment).
3. **The keys** (`BID_MASTER_KEY`, `AUDIT_SIGNING_KEY`, `JWT_PRIVATE_KEY_PEM`, `MFA_ENC_KEY`) in the customer's vault,
   versioned. Sealed bids stored in FileNet are encrypted by TenderFlow: **without the matching `BID_MASTER_KEY` no backup
   can open them**, and without `AUDIT_SIGNING_KEY` the audit chain cannot be verified.

After any restore: `GET /ready` (200), Admin → FileNet health, and `GET /api/v1/audit/verify` as an auditor for each
entity (`valid: true`).

## 7. Keys and rotation

| Key | Protects | Rotation in 1.0 |
|---|---|---|
| `BID_MASTER_KEY` | wraps each bid's data key (AES-256-GCM) | **No re-wrap tool.** Changing it makes every stored bid unreadable. Rotate only when no tender holds unopened or unarchived bids, or wait for a re-wrap tool (roadmap). If compromised, contact KBM. |
| `AUDIT_SIGNING_KEY` | HMAC chain of the audit log; also derives the MFA key when `MFA_ENC_KEY` is unset | **Do not rotate**: verification uses one key, so the existing chain would show as broken. Set `MFA_ENC_KEY` explicitly in production so the two are independent. |
| `JWT_PRIVATE_KEY_PEM` | session tokens (RS256, 8 h), JWKS at `/.well-known/jwks.json` | Replace the Secret value and `oc rollout restart deploy/tenderflow`. Signed-in users must sign in again; systems that cache the JWKS must refresh it. |
| `MFA_ENC_KEY` | TOTP secrets at rest | Changing it makes existing enrolments unreadable: users must be reset (Admin → Identity & access) and enrol again. |
| DB password, `FILENET_SERVICE_PASSWORD`, `WXO_API_KEY`, `SMTP_PASS`, `SMS_HTTP_AUTH_HEADER`, `TF_OIDC_SECRET_*` | integrations | Change at the source, update the Secret, `oc rollout restart deploy/tenderflow` (rolling, no downtime with 2+ pods). |

Without `JWT_PRIVATE_KEY_PEM` (development / demo) the signing key is generated once and stored in the database; all pods
use the same one.

## 8. Upgrade procedure

1. Read the release notes (new settings, new migrations, breaking changes).
2. Back up the database (§6). FileNet backup if the release changes document handling.
3. Build the new image with a new tag; run `config:check` from the **new** image with the production Secret.
4. Update `images: newTag` in the overlay and `oc apply -k …`. The first new pod applies migrations under the lock; old
   pods keep serving until new pods are ready (`maxUnavailable: 0`). Migrations must be additive (new tables/columns, no drops or
   renames in the same release) so old pods keep working during the roll; a release that cannot follow this says so and
   is upgraded with `oc scale deploy/tenderflow --replicas=0` first.
5. Verify: `GET /api/v1/version` (new version/commit), `/ready` 200 on every pod, sign in, `GET /api/v1/audit/verify`.
6. Rollback: re-apply the previous tag. Migrations are forward-only; if a release note says a migration is not backward
   compatible, roll back by restoring the step-2 backup.

Demo overlay: the strategy is `Recreate` (PGlite), so the demo is briefly unavailable during an upgrade.
Windows: stop, replace the folder (keep `.env` and `data`), `npm install`, `npm run build`, `npm start`.

## 9. Monitoring endpoints

| Endpoint | Auth | Use |
|---|---|---|
| `GET /health` | none | Liveness: the process answers. Never touches the database. |
| `GET /ready` | none | Readiness: database reachable, every migration applied, content store reachable. 200 / 503; probes use the status code only. 503 while the pod drains on SIGTERM. |
| `GET /api/v1/version` | none | `{ name, version, commit, buildTime }` of the running build. |
| `GET /api/v1/audit/verify` | auditor / admin | Audit chain of the caller's entity: `valid`, `count`, `brokenAt`. |
| `GET /api/v1/admin/jobs` | admin / auditor | Background jobs (notification delivery, escalation, MOI lifecycle): last run, status, errors. |
| `GET /api/v1/filenet/health` | admin / auditor | FileNet connectivity, configuration and recent operations. |
| Logs (stdout) | `oc logs` | Start-up line with version, environment, database and store; `[scheduler]`, `[shutdown]`, `[seed]` lines. |

Graceful shutdown on SIGTERM: `/ready` → 503, wait `SHUTDOWN_DELAY_MS` (OpenShift 5 s) so the router stops sending
traffic, stop accepting connections, let in-flight requests finish (`SHUTDOWN_TIMEOUT_MS`, 25 s), stop jobs, close the
database, exit 0. A second signal exits immediately.

There is no Prometheus metrics endpoint in 1.0; alert on probe failures, pod restarts and `last_status = 'ERROR'` jobs.

## 10. Troubleshooting

| Symptom | Cause / action |
|---|---|
| Pod exits at once: "TenderFlow refuses to start with TF_ENV=production" | Each reason is listed. Fix them; `config:check` shows the same list without starting the API. |
| "TenderFlow configuration error: missing required environment variable" | The Secret is missing a key or is not referenced; `oc set env deploy/tenderflow --list` shows which ConfigMap/Secret the pod reads; `config:check` in a one-off pod shows what is missing. |
| `EACCES` / permission denied under `/data` | The volume is not writable by group 0. Use the image as built (it sets group 0 on `/data`), do not override `runAsGroup`, or add `fsGroup` if your storage class needs it. |
| `Multi-Attach error` for `tenderflow-data` | Several pods on a ReadWriteOnce claim: use the production overlay's ReadWriteMany claim, or 1 replica. |
| Startup probe fails, "startup failed: connect ECONNREFUSED / timeout" | PostgreSQL unreachable: `DATABASE_URL`, NetworkPolicy/egress, `config:check --connect`. |
| `/ready` 503 | `oc exec deploy/tenderflow -- node -e "fetch('http://127.0.0.1:4000/ready').then(r=>r.text()).then(console.log)"`; database, migrations pending, or FileNet unreachable (FileNet health page). |
| Signed out when the next request hits another pod / "Invalid token" | Pods use different signing keys: set `JWT_PRIVATE_KEY_PEM` in the Secret (required in production). |
| "Untrusted token issuer" | `PUBLIC_BASE_URL` changed after sign-in or differs from the Route URL; users sign in again after fixing it. |
| 504 Gateway Timeout on AI actions | Route timeout (`haproxy.router.openshift.io/timeout`, 120 s) lower than `WXO_TIMEOUT_MS`. |
| Client IP in the audit log is the router's | `TRUST_PROXY` must be 1 (one router hop), or the proxies' addresses. |
| `entity:create` hangs or fails on PGlite | The API is running on the same data directory; stop it first. |
| FileNet refused in production with plain http | Use https, or `ALLOW_INSECURE_FILENET=true` for an isolated test system only. |
| Demo data missing after restart (OpenShift demo) | The PVC was deleted or `SEED_DEMO=false`; the seed runs only when the database has no entities. |
| "ENTITY_ID 'x' is not an entity in this database (it holds: …)" | The pod points at another entity's database, or `ENTITY_ID` is wrong. Fix `DATABASE_URL` / `ENTITY_ID`. |
| Start-up warning "TENANCY_MODE=dedicated but ENTITY_ID is not set and this database holds N entities: running in SHARED mode" | Development/demo only (production refuses). Set `ENTITY_ID`, or `TENANCY_MODE=shared` for the multi-entity demo. |
| `entity:create` answers `ENTITY_CREATION_DISABLED` | Dedicated installation: only `--code <ENTITY_ID>` is allowed. A new entity needs its own installation. |
| Sign-in or registration answers 404 "Entity not found" | A client sent another entity's id to a dedicated installation (old bookmark with `?tenant=…`, or a script). Leave the id out. |
