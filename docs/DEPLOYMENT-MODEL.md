# TenderFlow deployment model — the dedicated entity edition

Business requirement (product owner): *"The committee is per government entity. This solution will be sold to each
government entity, and they will work on it in separation from the other government entities."*

TenderFlow is therefore delivered as **one installation per government entity**. The entity's committees (chair,
evaluators), approvers, cycle templates, rules, suppliers, numbering, branding and audit chain all live in that
entity's own installation and database.

## Two modes

| | `TENANCY_MODE=dedicated` (default) | `TENANCY_MODE=shared` |
|---|---|---|
| Use | The product as sold: one installation = one entity | KBM's internal multi-entity demo (kea, gcia, moi); the automated test suite |
| Entity | `ENTITY_ID` (required with `TF_ENV=production`) | chosen at sign-in |
| Sign-in | user name + password; no entity picker. A `tenantId` sent by a client is optional and must be this entity | entity picker + user name + password |
| Supplier registration | with this entity only; the page says supplier accounts are per entity | entity picker |
| Public tender board, RSS / JSON feeds | this entity's open tenders, titled "Public tenders of &lt;entity&gt;" | all participating entities, entity filter |
| Another entity id (login, registration, public board `?entity=`, public vendor form, SSO start) | **404 "Entity not found"** — identical whether that entity exists or not | normal per-entity behaviour |
| Session tokens | a token whose `tenant_id` is another entity is refused (401) and never issued | per entity |
| Creating entities (`entity:create`, internal `createTenant`) | refused (403 `ENTITY_CREATION_DISABLED`) for any code other than `ENTITY_ID` | allowed |
| Background jobs, tender closing | scoped to the entity | all entities |
| Demo seed (`SEED_DEMO=true`, empty database) | `DEMO_ENTITY` only (kea, gcia or moi; default kea) | all three |
| Web app | entity's logo text, name (EN/AR) and colour as the brand; no cross-entity wording | original multi-entity screens |

The data model is the same in both modes (every row carries `tenant_id`, every authenticated query is scoped by the
entity in the token). Dedicated mode adds the guards above on top; they are implemented in
`services/api/src/tenancy.ts` and used by login, registration, the public routes, the token service, the scheduler and
entity provisioning. `GET /api/v1/public/deployment` returns `{ mode, entity: { id, nameEn, nameAr, primaryColor,
logoText } }` (entity `null` in shared mode or before the entity is provisioned) for the web app.

## Configuration and start-up

| Variable | Default | Notes |
|---|---|---|
| `TENANCY_MODE` | `dedicated` | `dedicated` or `shared`; anything else stops start-up with a clear error |
| `ENTITY_ID` | empty | entity code (`a-z 0-9 _ -`, 2–40). Required in production when dedicated (start-up refused and `config:check` FAIL); not allowed with `shared` |
| `DEMO_ENTITY` | `ENTITY_ID` if it is a demo entity, else `kea` | only for the demo seed of a dedicated installation; must equal `ENTITY_ID` when both are set and `SEED_DEMO=true` |

Start-up resolves the entity against the database (`resolveTenancy`):

* `ENTITY_ID` set, database empty → starts (warning "not provisioned yet"); run `npm run entity:create -- --code <ENTITY_ID> …`.
* `ENTITY_ID` set, database holds entities but not this one → **refused** (wrong database or wrong `ENTITY_ID`).
* `ENTITY_ID` set, database holds this entity and others → starts, serves only `ENTITY_ID`, warns that the database
  also holds other entities (e.g. a copy of a former shared installation).
* `ENTITY_ID` empty (development / demo only): empty database → `DEMO_ENTITY` if the demo seed runs, else no entity yet;
  exactly one entity → that one; several → **shared mode with a warning** so an existing three-entity development
  database keeps working (production refuses this case).

Production overlay (`deploy/openshift/overlays/production`): `TENANCY_MODE=dedicated` and `ENTITY_ID=` — set the entity
code before applying; the pod refuses to start while it is empty. The demo overlay keeps `TENANCY_MODE=shared`
(three-entity guided demo); for a single-entity demo use `TENANCY_MODE=dedicated` and `DEMO_ENTITY=kea|gcia|moi`.

## Infrastructure per entity

| Component | Recommended | Also supported |
|---|---|---|
| OpenShift | one namespace (e.g. `tenderflow-moh`) with its own Deployment, Route, Secret (own `BID_MASTER_KEY`, `AUDIT_SIGNING_KEY`, `JWT_PRIVATE_KEY_PEM`, `MFA_ENC_KEY`), ConfigMap (`ENTITY_ID`) and NetworkPolicy per entity | several entity namespaces on one cluster (normal case); a separate cluster for an entity that requires it |
| PostgreSQL | one database (and owner role) per entity; separate backups and restore points | one PostgreSQL server / Crunchy cluster hosting several entity databases — never several entities in one database |
| IBM FileNet | one object store per entity (own storage areas, security, backups, retention) | a shared object store with a different `FILENET_ROOT_FOLDER` per entity (e.g. `/TenderFlow-MOH`) **and** a service user per entity whose access is limited to its folder. TenderFlow writes only under its root folder and FileNet search always filters on `TF_TenantId`, but administrators and a shared service user of the object store can see every entity's folders |
| IBM watsonx Orchestrate | one instance per entity (own API key, run history and data residency) | a shared instance with separate agents per entity (`WXO_AGENT_*` take agent ids or names, so each installation can point to its own copies). The import scripts create the agents with fixed names, so a second set in the same instance has to be renamed by hand; run history in a shared instance is visible to its administrators |
| E-mail / SMS | the entity's own sender address and SMS sender | shared relay with per-installation `SMTP_FROM` / `SMS_SENDER` |
| Staff SSO | the entity's own Active Directory / Entra ID app registration | — |

Each installation has its own audit chain (`GET /api/v1/audit/verify`), keys and backups; restoring one entity never
touches another.

## Suppliers

A supplier registers separately with each entity it wants to work with: each installation has its own supplier
accounts, documents, classifications, subscription and blocks. The registration page says so.

## Moving from a shared installation

The audit log is append-only, so entities cannot be removed from a shared database. Preferred: provision a new
dedicated installation per entity (`entity:create`) and keep the shared one read-only as the record of its history.
Starting a copy of the shared database with `ENTITY_ID` set works (only that entity is served; a start-up warning lists
the others), but the copy still holds the other entities' rows — acceptable for a demo, not for production.

## What is verified

`services/api/test/dedicated-mode.test.ts` starts a database that holds all three demo entities as a dedicated `kea`
installation and checks: sign-in without an entity id; 404 for other entities (existing or not) on sign-in,
registration, public board, feeds, public vendor form and SSO start; refusal of another entity's token; entity creation
refused; jobs and tender closing scoped; no trace of the other entities in dashboards, analytics, audit, lists, admin
pages, the evidence pack or the prompts sent to Orchestrate; configuration and start-up validation.
