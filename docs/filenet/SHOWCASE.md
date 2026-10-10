# FileNet showcase: IBM FileNet as TenderFlow's system of record

TenderFlow stores every document — tender packs, addenda, notices, request letters, vendor documents, sealed bids,
opening records, committee reports and auditor evidence packs — in IBM FileNet Content Manager through the Content
Services GraphQL API (`services/api/src/content/filenet-store.ts`). PostgreSQL keeps the workflow and a reference to
each FileNet object; the bytes live only in FileNet. This page lists what FileNet does in TenderFlow, how a reviewer
sees it, and how to demonstrate it.

**Verification status.** The base store (ping, folders, upload, download, SHA-256 round trip, Arabic text, 2 MB
binary) passed live against TechZone OS1 (`npm run verify:filenet`, see `docs/filenet/README.md`). Everything else
here was built in a sandbox that **cannot reach TechZone**. It was checked against IBM's published schema
(`csgraphql_schema.graphqls`, github.com/ibm-ecm/ibm-content-platform-engine-samples), the live mutation list in
`docs/evidence/G2-b/mutations.txt` and unit / API tests against a local fake server
(`services/api/test/fakes/fake-filenet.ts`). Items marked **ASSUMED** are not confirmed by any of those sources.
**Nothing below is verified live until the steps at the end are run.** The verify tool reports each one as
PASS / FAIL / SKIP.

## What FileNet does in TenderFlow

| Capability | What happens | Switch | Status |
|---|---|---|---|
| **Store every document** | One FileNet document per file, filed in `/TenderFlow/<entity>/<tender>/<type>`; sealed bids are stored as AES-256-GCM ciphertext (the key never leaves TenderFlow) | `CONTENT_STORE_TYPE=filenet` | **Verified live** |
| **Document classes** | `TF_Document` and five subclasses — `TF_TenderDocument` (pack, addenda, notices, request letters), `TF_BidEnvelope` (sealed envelopes), `TF_VendorDocument`, `TF_CommitteeRecord` (opening records, committee reports, evaluation narratives), `TF_EvidencePack` — with TenderFlow properties: `TF_TenantId`, `TF_TenderNumber`, `TF_OwnerType`, `TF_DocumentType`, `TF_Confidentiality`, `TF_Sha256`, `TF_UploadedBy`, `TF_VersionNo`, `TF_AiClassification`, `TF_AiConfidence`, … (`TF_BidId` only on `TF_BidEnvelope`). Subclasses inherit the base properties. | `FILENET_CLASS_MODEL=subclasses` (default `single` = rc3 behaviour) | Fake-tested. Live: **not verified** — ACCE-RUNBOOK §6, verify step 10 |
| **Never break uploads** | TenderFlow asks the object store which classes and properties exist (`classDescription`, cached 5 min). A missing subclass falls back to `TF_Document`, a missing model to `FILENET_DOC_CLASS`; a property the class lacks is not written; if the Content Engine still refuses, the document is created in `FILENET_DOC_CLASS` and the refusal is recorded on it (evidence panel "Class fallback") | always | Fake-tested |
| **Document security (ACLs)** | Each document gets a confidentiality level from its type: PUBLIC (tender documents), INTERNAL (vendor documents, request letters), SEALED (bid envelopes), COMMITTEE (opened bids, committee records), AUDIT (evidence packs). With groups on, the permission list is written at create: the service user gets full control (998903), the level's groups get *view content* (131201), and it is read back. **Sealed envelopes are reachable by nobody but the service user** until the chair opens them; then TenderFlow changes them to COMMITTEE in FileNet, reads the list back and audits `FILENET_ACCESS_CHANGE_REQUESTED` / `FILENET_ACCESS_CHANGED`. A refused change is recorded (`FILENET_ACCESS_CHANGE_FAILED`) and retried by the job `filenet-access-retry` (Admin → Background jobs; at most 10 attempts per document). A refused permission list at create never fails the upload. | `FILENET_ACL_MODE=groups` + `FILENET_GROUP_<LEVEL>` (default `off`) | Fake-tested. Permission input shape **ASSUMED**. Live: verify step 11 |
| **Search** | Procurement / Admin → **FileNet search**: a Content Engine SQL query (`documents(repositoryIdentifier, from, where, pageSize)`). The WHERE clause always starts with `TF_TenantId = '<entity from the login token>' AND IsCurrentVersion = TRUE`; name words, tender number and document type come from strict whitelists (no quote, backslash, `%` or operator can reach FileNet). Every hit is mapped to its TenderFlow document and shown only if the user may read it — a sealed bid never appears before the opening. The page shows the query that ran. | needs `TF_TenantId` on the class (class model, or `FILENET_DOC_CLASS=TF_Document` + `FILENET_SET_CUSTOM_PROPERTIES=true`) | Fake-tested. `documents` query **ASSUMED** to accept CE SQL as in IBM's samples. Live: verify step 12 |
| **Evidence opens the real document** | Every evidence panel has **Open in IBM Content Navigator** (a bookmark to the exact version), **Open ACCE** and **Copy object ID**. Navigator is the configured URL, or is found on the FileNet server (`<origin>/navigator`, then `<origin>/icn/navigator`), checked without credentials (2xx / 3xx / 401 = answers, 5 s timeout, cached 5 min). If Navigator does not answer, the link is still shown **with a warning**, next to the object id and ACCE — never a dead link presented as working. Each click is audited (`FILENET_LINK_OPENED`: who opened which object, where). Links open in a new tab (`rel="noopener noreferrer"`). | `FILENET_NAVIGATOR_URL` (unset = find it; `off` = no Navigator links), `FILENET_ACCE_URL` | Probe + links fake-tested. Bookmark format **ASSUMED** (`bookmarkUrl()` in `content/navigator.ts`). Live: verify step 13 |
| **Versions** | An addendum that supersedes a document is checked in as the next **major** version of the same FileNet document (checkout → checkin; reservation cancelled on failure, never a silent fallback) | `FILENET_VERSIONING=true` | Fake-tested; mutations exist on TechZone. Live: verify step 8 |
| **Records** | At award, documents are declared records: `TF_RecordDeclared` property, or `CmRetentionDate` (retention mode) | `FILENET_RECORDS_MODE=property\|retention` | `property` fake-tested; `retention` **ASSUMED**. Live: verify step 9 |
| **AI properties** | When watsonx Orchestrate classifies a document (before review), TenderFlow writes `TF_AiClassification` and `TF_AiConfidence` on the FileNet object if its class has them (audited `FILENET_AI_PROPERTIES_WRITTEN`). `TF_AiConfidence` is **measured by TenderFlow** — the share of the suggested type's required fields that came back with a verified citation; the agent returns no probability. When a person accepts, `TF_DocType` / `TF_ExpiryDate` / `TF_AIReviewed` are written (`FILENET_AI_PROPERTIES`, see `docs/DOCUMENT-INTELLIGENCE.md`). | class model with the properties | Fake-tested. Float literal **ASSUMED**. Live: verify step 14 |
| **Health page** | Admin → IBM FileNet: connection, object store, class model (which classes / properties exist, what is missing), document security mapping (level → groups), Navigator check (every address tried, status, latency), folder tree, counts, last repository operations, latest verify report with PASS / FAIL / SKIP | TENANT_ADMIN, AUDITOR | Fake-tested |

### Vendors see no repository internals

A vendor's evidence panel (own documents, published tender documents) shows the document, its version, hashes and
FileNet object id only: no object store name or id, no class-model detail, no property bag, no service account,
no ACL group names, no Navigator / ACCE link (vendors have no FileNet login, and the bookmark carries the object
store id). Covered by `test/filenet-enterprise.test.ts`.

## API

| Route | Who | What |
|---|---|---|
| `GET /api/v1/documents/:id/evidence` | same rule as the download (bid documents: owner vendor, or chair / evaluators / director / undersecretary after the opening; evidence packs: auditor, entity admin) | evidence + `links: { navigator?: {url, reachable, source, checkedAt}, acce?: {url}, objectId, versionSeriesId, path }`, `access: {mode, level, status, grantees (staff)}`, `aiClassification`. rc3 field `navigatorUrl` kept |
| `POST /api/v1/documents/:id/filenet-opened` `{target: navigator\|acce\|copy}` | anyone who may see the evidence | audits `FILENET_LINK_OPENED` |
| `GET /api/v1/filenet/search?q=&tenderNumber=&documentType=` | staff | CE SQL search (see above); 409 `FILENET_SEARCH_UNAVAILABLE` with the reason when the class has no `TF_TenantId` or the store is not FileNet; 400 for any unsafe value |
| `GET /api/v1/filenet/model[?refresh=true]` | TENANT_ADMIN, AUDITOR | class model spec, what exists in the object store, ACL configuration |
| `GET /api/v1/filenet/navigator[?refresh=true]` | TENANT_ADMIN, AUDITOR | Navigator probe (configured / derived / off, addresses tried) and the ACCE link |
| `GET /api/v1/filenet/health` | TENANT_ADMIN, AUDITOR | as before, plus `classModel`, `aclMode`, Navigator mode, ACCE |

## Environment flags

| Variable | Default | Meaning |
|---|---|---|
| `FILENET_CLASS_MODEL` | `single` | `single`: every document in `FILENET_DOC_CLASS` (rc3). `subclasses`: the TF_* subclass of each document, with fallback |
| `FILENET_ACL_MODE` | `off` | `off`: class default security. `groups`: write the permission list per confidentiality level |
| `FILENET_GROUP_PUBLIC` / `_INTERNAL` / `_SEALED` / `_COMMITTEE` / `_AUDIT` | — | Directory group (short name or DN) for each level. Letters, digits, space and `. _ @ = , ( ) # -` only. At least one is required with `groups`. SEALED normally stays empty |
| `FILENET_ACL_SERVICE_GRANTEE` | `FILENET_SERVICE_USER` | Grantee name of the service account (full control on every document — TenderFlow must never lock itself out) |
| `FILENET_ACCESS_RETRY_MS` | `300000` | Interval of the `filenet-access-retry` job |
| `FILENET_NAVIGATOR_URL` | (found on the FileNet server) | Navigator base URL; `off` disables Navigator links |
| `FILENET_NAVIGATOR_DESKTOP` | `ICN` | Navigator desktop id |
| `FILENET_NAVIGATOR_REPOSITORY` | `FILENET_OBJECT_STORE` | Navigator repository id |
| `FILENET_ACCE_URL` | `<FileNet origin>/acce` | ACCE address; `off` hides the ACCE link |
| `FILENET_VERSIONING`, `FILENET_RECORDS_MODE`, `FILENET_RETENTION_DAYS`, `FILENET_AI_PROPERTIES` | unchanged | see `.env.example` |

## ASSUMED protocol details (each isolated in one place)

| What | Where | How to check live |
|---|---|---|
| `ClassDescription.propertyDescriptions { symbolicName }` | `FileNetStore.classStatus()` | verify step 10. If refused, the class is still checked and properties are reported "not available" (uploads still work) |
| `documentProperties.permissions: { replace: [{ type: ACCESS_PERMISSION, subAccessPermission: { accessType: ALLOW, inheritableDepth: 0, accessMask, granteeName } }] }` and the read-back selection | `permissionsLiteral()` / `PERMISSIONS_SELECTION` in `content/filenet-model.ts` | verify step 11; `node services/api/dist/tools/filenet-introspect.js` dumps `PermissionListInput`, `AccessPermission` … |
| `documents(repositoryIdentifier, from, where, pageSize)` accepting a CE SQL WHERE clause | `FileNetStore.search()` | verify step 12 |
| Navigator bookmark format | `bookmarkUrl()` in `content/navigator.ts` | open the link from verify step 8/13; compare with Navigator's own **Copy link** |
| Integer / Float property literals (`{TF_VersionNo: 2}`, `{TF_AiConfidence: 0.5}`) | `scalarLiteral()` in `filenet-store.ts` | verify steps 10 and 14 |
| A checked-in version keeps the security of its version series | `put()` (versioning) | ACCE → the addendum → Security |

## Demo script (about 10 minutes)

Prepared: `CONTENT_STORE_TYPE=filenet`, `FILENET_CLASS_MODEL=subclasses`, `FILENET_ACL_MODE=groups` with the
groups of ACCE-RUNBOOK §7, `FILENET_VERSIONING=true`, `FILENET_RECORDS_MODE=property`; `npm run verify:filenet`
passed. Entity `kea`, password `DEMO_PASSWORD`.

1. **admin → IBM FileNet.** Connection to OS1, the class model table (all six classes "Defined"), the security
   table (which group sees which level), the Navigator check ("Navigator answers"), the folder tree under
   `/TenderFlow/kea`, the verify report (PASS / SKIP per step). *"FileNet is the system of record, and TenderFlow
   shows you exactly how it uses it."*
2. **officer → KEA-2026-102 → FileNet evidence** on the tender pack: class `TF_TenderDocument`, the `TF_*`
   properties, security PUBLIC with its groups. Click **Open in IBM Content Navigator** — the same object opens in
   Navigator (show the properties and security tabs there). Back in TenderFlow: Admin → Audit shows
   `FILENET_LINK_OPENED`.
3. **officer → FileNet search**: tender `KEA-2026-102`, type *Tender pack* → the query that ran in FileNet is
   shown. Search type *Bid technical envelope* for `KEA-2026-088`: "N more in FileNet that you may not read" —
   sealed bids are invisible.
4. **chair → KEA-2026-088 → open the bids.** Evidence on an envelope: security COMMITTEE, "Applied and read
   back". In ACCE the envelope's security now lists the committee group. Audit: `FILENET_ACCESS_CHANGED`
   (chair) per envelope.
5. **officer → addendum** that supersedes the pack → evidence shows FileNet version 2.0 of the same version series.
6. **vendor1 → the tender → FileNet evidence**: object id and hashes only — no repository internals.
7. **Award** → documents show the Record badge; evidence shows `TF_RecordDeclared = true`.

## How to verify it live (Windows machine with TechZone access)

1. Pull the branch, `npm install`.
2. Without building: `scripts\windows\filenet-check.cmd` (or `npm run build` then `npm run verify:filenet`).
   Each step prints `PASS`, `FAIL` (with the server's own error text) or `SKIP` (with the reason); the report goes
   to `docs/evidence/filenet-verify-<time>.json` and appears on the health page.
3. Steps 1–9 as before (connection, folder, upload / download, class, versioning, records).
4. **Class model** (ACCE-RUNBOOK §6, then `FILENET_CLASS_MODEL=subclasses`): step 10 must PASS — all six classes
   with their properties, and a test document stored as `TF_TenderDocument`.
5. **Security** (ACCE-RUNBOOK §7, then `FILENET_ACL_MODE=groups`): step 11 must PASS — a sealed envelope written with
   the service user only, then changed to COMMITTEE, each read back. If FileNet refuses the permission input, run
   `filenet-introspect` and send `docs/evidence/filenet-schema-*.txt`; only `permissionsLiteral()` changes.
6. **Search**: step 12 must PASS (the text document is found by CE SQL).
7. **Navigator**: step 13 must PASS. If it FAILs, the line lists every address tried; set `FILENET_NAVIGATOR_URL`
   to the Navigator address from the TechZone reservation (e.g. `https://<host>:9443/navigator`) — or `off`. Open
   the printed link for the v2 document; if Navigator shows an error, change only `bookmarkUrl()`.
8. **AI properties**: step 14 must PASS once the class model has `TF_AiClassification` / `TF_AiConfidence`.
9. Save screenshots (ACCE class tree, a document's properties and security, Navigator showing the document) and
   the verify JSON under `docs/evidence/`.

## Known limits

- **Search scope**: in `subclasses` mode the search runs on `TF_Document` (subclasses included). Documents that
  fell back to `Document` have no `TF_TenantId` and are not found — by design they can never leak across entities.
- **Folder of a checked-in version**: it stays filed with its version series (ASSUMED dynamic containment).
- **Records are a marker in `property` mode**; real immutability needs IBM Enterprise Records or a retention policy.
- **Telemetry** is per API process and in memory only; the Navigator probe and class-model results are cached per
  process for 5 minutes (refresh buttons on the health page).
- **ACLs are defence in depth**: TenderFlow's own access rules decide every read through the API; the FileNet
  permission list governs people who open the repository directly.
