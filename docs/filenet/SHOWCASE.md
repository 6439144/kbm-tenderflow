# FileNet showcase: FileNet as the visible system of record

TenderFlow stores every document (tender packs, addenda, notices, request letters, sealed bids, opening
records, committee reports) in IBM FileNet Content Manager through the Content Services GraphQL API
(`services/api/src/content/filenet-store.ts`). The showcase makes that visible and governed for a reviewer:
each document has an evidence panel read live from the Content Engine, and administrators have a FileNet page.

**Verification status.** The base store (ping, folders, upload, download, SHA-256 round trip, Arabic text,
2 MB binary) passed live against TechZone OS1 (`npm run verify:filenet`, see `docs/filenet/README.md`).
Everything in this document was built in a sandbox that **cannot reach TechZone**. It was checked against
IBM's published schema (`csgraphql_schema.graphqls` in github.com/ibm-ecm/ibm-content-platform-engine-samples),
the live mutation list in `docs/evidence/G2-b/mutations.txt`, unit tests against a local fake server
(`services/api/test/fakes/fake-filenet.ts`), and in Chromium with both the filesystem store and the fake
FileNet server. Items marked **ASSUMED** are not confirmed by any of those sources. **Nothing below is verified
live until Khaled runs the steps at the end.**

## What each feature shows

| Feature | Where | What it shows | Status |
|---|---|---|---|
| Evidence panel | "FileNet evidence" button on every document row (tender pack, addenda, vendor documents) → modal | "Stored in IBM FileNet": object store, object ID, class, folder, folders filed in, TenderFlow version + repository version (major.minor, current or not), version series, SHA-256, stored size, content type, created / checked in / creator (from the repository), record status, sealed-bid note ("ciphertext in FileNet; key held by TenderFlow"), repository properties (`DocumentTitle`, `TF_*`), content elements, version history, "Open in IBM Content Navigator" | Built; tested with the fake server and in the browser against it. Live: **not verified** |
| Dev-mode evidence | Same button ("Storage evidence") when `CONTENT_STORE_TYPE=filesystem` | "Development mode — local file store; in production this panel shows the FileNet object", plus size, type and SHA-256 of the stored bytes read back now | Verified in the browser |
| DocList badges | Document tables | `v2`, `v3`… for superseding versions, and a green "Record" lock badge once the tender is awarded | Verified in the browser (filesystem and fake FileNet) |
| Health page | Admin → IBM FileNet (`/admin/filenet`), roles TENANT_ADMIN and AUDITOR | Tiles: connection (`ping()`), object store, `TF_Document` class exists, versioning flag, records mode, Navigator; configuration without secrets; the tenant folder tree `<root>/<tenant>` two levels deep with document counts; document counts by store and type; records declared; the last 50 repository operations with latency; the newest `docs/evidence/filenet-verify-*.json`; "Why FileNet" (Arabic and English) | Built; browser-checked with both stores. Live: **not verified** |
| Addenda versioning | `FILENET_VERSIONING=true` | An addendum that supersedes a pack document is checked in as the next **major** version of the same FileNet document (`checkoutDocument` → `checkinDocument` with `checkinAction: { checkinMinorVersion: false }`, content streamed as a multipart part like `createDocument`). If check-in fails the reservation is cancelled (`cancelDocumentCheckout`) and the upload fails with the server's text, never a silent fallback | Unit-tested against the fake. Mutations exist on TechZone (mutations.txt). Live round trip: **not verified** — run verify step 8 |
| Records declaration | `FILENET_RECORDS_MODE` at award (records lock in `services/award.ts`) | `none` (default): TenderFlow locks the record in its DB; detail "records declaration not configured (FILENET_RECORDS_MODE=none)". `property`: `updateDocument` sets `TF_RecordDeclared=true` and `TF_RecordDeclaredAt`, reads them back, and stores "marked … — immutability requires IBM Enterprise Records or a retention policy". `retention`: sets `CmRetentionDate = now + FILENET_RETENTION_DAYS` | `property`: unit-tested, needs ACCE-RUNBOOK §1b. `retention`: **ASSUMED** (the schema has `cmRetentionDate: DateTime` on `DocumentPropertiesInput`; whether OS1 lets the service user set it is not known) |
| Operation telemetry | Health page table | Every `put` / `get` / `describe` / `declareRecord` records `{op, ok, ms, at, ref or folder, error}` in a 100-entry in-memory ring buffer (`content/index.ts`). No file contents, no credentials. Only entries for the viewer's tenant are shown. Resets when the API restarts | Unit-tested |
| Navigator link | Evidence panel button | `FILENET_NAVIGATOR_URL/bookmark.jsp?desktop=…&repositoryId=…&repositoryType=p8&docid=<class>,<objectStoreGuid>,<documentGuid>&template_name=<class>&vsId=<versionSeriesGuid>` (no `version` parameter, so the exact version opens) | **ASSUMED** format (`content/navigator.ts`). Hidden when not configured |

### API

- `GET /api/v1/documents/:id/evidence` — same access rules as the downloads: non-bid documents follow
  `GET /documents/:id` (shared `loadReadableDocument` in `services/documents.ts`); bid documents follow
  `GET /bids/:id/documents/:docId` (owner vendor, or chair / evaluators / director / undersecretary after
  opening, financial envelope only once opened). The evidence route never returns document content; for a
  sealed bid `describe()` reports only repository metadata (or, in dev mode, the ciphertext size and hash).
- `GET /api/v1/filenet/health` — TENANT_ADMIN, AUDITOR. Read-only.

## Environment flags (FileNet block of `.env.example`)

| Variable | Default | Meaning |
|---|---|---|
| `FILENET_VERSIONING` | `false` | `true` = check in superseding documents as the next major version. `false` = new document; TenderFlow keeps the chain (`documents.supersedes_id` / `version_no`) |
| `FILENET_RECORDS_MODE` | `none` | `none` \| `property` \| `retention` |
| `FILENET_RETENTION_DAYS` | — | Required for `retention` (1–36500) |
| `FILENET_NAVIGATOR_URL` | — | e.g. `http://<host>:<port>/navigator`. No link when empty |
| `FILENET_NAVIGATOR_DESKTOP` | `ICN` | Navigator desktop id |
| `FILENET_NAVIGATOR_REPOSITORY` | `FILENET_OBJECT_STORE` | Navigator repository id (as configured in the Navigator admin desktop) |

Existing flags are unchanged (`FILENET_GRAPHQL_URL`, `FILENET_OBJECT_STORE`, `FILENET_SERVICE_USER`,
`FILENET_SERVICE_PASSWORD`, `FILENET_DOC_CLASS`, `FILENET_ROOT_FOLDER`, `FILENET_SET_CUSTOM_PROPERTIES`,
`FILENET_TIMEOUT_MS`).

## Known limits and assumptions

- **Folder of a checked-in version.** With versioning, the new version stays filed with its version series (the
  folder of the first version). TenderFlow therefore does not record a folder for it; the evidence panel shows the
  folders the repository reports. ASSUMED: P8 keeps the folder filing on the series (dynamic containment).
- **Boolean literal.** Property mode sends `{TF_RecordDeclared: true}` as a `PropertyIdentifierAndScalarValue`
  literal, like the string literals that passed live. ASSUMED for a Boolean property.
- **Folder tree counts** are the first page of `containedDocuments`; a `+` means more documents exist.
- **Telemetry** is per API process and in memory only.
- **Records are a marker in `property` mode.** Real immutability needs IBM Enterprise Records or a retention
  policy; TenderFlow says so in the stored record detail and on the health page.

## How Khaled verifies it live (Windows machine with TechZone access)

1. Pull the branch, then:

   ```powershell
   npm install
   npm run build
   ```

2. **Versioning proof.** With the existing FileNet settings in `.env` (leave `FILENET_VERSIONING=false` for now):

   ```powershell
   npm run verify:filenet
   ```

   Step 8 must print four `✓ 8 versioning: …` lines; the last ends with `series {…}: 1.0 → 2.0`. In ACCE or Navigator
   open `/TenderFlow/_verify/verify-version-…` → **Versions**: two major versions. Screenshot it. If a step
   fails, the error is the server's own text; send `docs/evidence/filenet-verify-<timestamp>.json`.
   Only after step 8 passes, set `FILENET_VERSIONING=true` in `.env`.

3. **Records (optional).** Do ACCE-RUNBOOK §1b, set `FILENET_DOC_CLASS=TF_Document` and
   `FILENET_RECORDS_MODE=property`, run `npm run verify:filenet` again: step 9 must pass.

4. **Navigator (optional).** Set `FILENET_NAVIGATOR_URL=http://<host>:<port>/navigator` (and
   `FILENET_NAVIGATOR_REPOSITORY` if the Navigator repository id is not `OS1`). Rerun `npm run verify:filenet`:
   it prints the link for the v2 document. Open it in the browser. If Navigator shows an error, the link format is
   wrong: note the URL Navigator itself gives with **Copy link** and change only `navigatorUrl()` in
   `services/api/src/content/navigator.ts`.

5. **In the app** (`CONTENT_STORE_TYPE=filenet`, `npm start`):
   - Log in as `admin` (entity `kea`) → **IBM FileNet**: connection, OS1, `TF_Document`, folder tree under
     `/TenderFlow/kea`, operations with latency, and the verify report from step 2.
   - Log in as `officer` → tender KEA-2026-102 → issue an addendum that supersedes the pack (versioning on) →
     **FileNet evidence** on the addendum: repository version 2.0, the same version series as the pack, and the
     version history. Click **Open in IBM Content Navigator**.
   - Award a tender (chair recommends, director approves) → the documents show the **Record** badge; with
     `property` mode the evidence panel shows "Declared in the repository" and `TF_RecordDeclared = true`.
   - Log in as `vendor1` → the same tender → **FileNet evidence** works on the pack; another vendor's bid
     documents are not reachable (404).

6. Save the screenshots and the verify JSON under `docs/evidence/` for the ESA pack.
