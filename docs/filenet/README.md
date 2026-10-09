# TenderFlow on IBM FileNet Content Manager

TenderFlow stores every tender document in IBM FileNet Content Manager. It writes and reads them through the
**Content Services GraphQL API**. PostgreSQL holds the workflow state and a `storeRef` for each file. The file
bytes live only in FileNet.

Code: `services/api/src/content/filenet-store.ts` (class `FileNetStore`, which implements the `ContentStore`
contract in `services/api/src/content/types.ts`). You select it with `CONTENT_STORE_TYPE=filenet`.

## Configuration (`.env` at the repo root)

```dotenv
CONTENT_STORE_TYPE=filenet
FILENET_GRAPHQL_URL=http://<techzone-host>:<port>/content-services-graphql/graphql
FILENET_OBJECT_STORE=OS1                 # "Focus Corp" demo object store (symbolic name)
FILENET_SERVICE_USER=<user>
FILENET_SERVICE_PASSWORD=<password>      # never printed or written to reports
FILENET_DOC_CLASS=Document               # TF_Document after the optional ACCE runbook
FILENET_ROOT_FOLDER=/TenderFlow          # TenderFlow writes ONLY below this folder
FILENET_SET_CUSTOM_PROPERTIES=false      # true after the optional ACCE runbook
# FILENET_TIMEOUT_MS=120000              # optional per-request timeout
```

The constructor validates these variables and throws an error that names every one that is missing. The root
folder cannot be `/`, because the object store is shared.

## Folder layout

```
/TenderFlow                                   FILENET_ROOT_FOLDER (created on first write if missing)
  /<tenantId>
    /<tenderId>
      /<ownerType>                            e.g. tender pack, clarifications, bids/<vendor>, opening, award
        <file name>                           one FileNet Document per uploaded file (major version 1.0)
  /_verify                                    written only by the verify CLI
```

- The backend passes a relative `folderPath` such as `/<tenant>/<tender>/<ownerType>`. `FileNetStore` always
  puts `FILENET_ROOT_FOLDER` in front of it. It rejects `.`, `..` and the characters FileNet does not allow in
  names (`\ / : * ? " < > |`). Any path outside the root is refused.
- Missing folders are created top-down with `createFolder`. Each folder is checked with `folder(...)` before it
  is created. Known paths are cached. If another process creates the same folder at the same moment
  (`E_NOT_UNIQUE`), the folder is re-checked and accepted.
- If a file with the same name is already filed in a folder, the new document is stored as `name [abcd1234].ext`.
  TenderFlow refers to documents only by id, never by name.

## What is stored

| Business step | Document type (`TF_DocType`) | Content |
|---|---|---|
| Vendor registration | `VENDOR_DOCUMENT` | CR / licence files as uploaded |
| Tender drafting, addenda | `TENDER_PACK` | tender pack files as uploaded |
| Sealed bid submission | `BID_TECHNICAL`, `BID_FINANCIAL` | **ciphertext only** (AES-256-GCM) |
| Opening | `OPENING_RECORD` | bilingual HTML opening record |
| Award | `COMMITTEE_REPORT` | bilingual HTML committee report |

Each document is created by one multipart `createDocument` call. That call sets the class
(`FILENET_DOC_CLASS`), `DocumentTitle` (the file name), one `ContentTransfer` element (MIME type and retrieval
name), a major-version check-in, and filing into the target folder.

`storeRef` format: `filenet:<objectStore>:<documentId>`, for example `filenet:OS1:{6A1B...}`.

With `FILENET_SET_CUSTOM_PROPERTIES=true` and class `TF_Document`, each document also carries the following
properties:

| Property | Value |
|---|---|
| `TF_TenantId` | tenant id |
| `TF_TenderId` | `properties.tenderId` |
| `TF_VendorId` | `properties.vendorId` |
| `TF_DocType` | `properties.docType` |
| `TF_Sha256` | SHA-256 of the bytes **as stored in FileNet** |

The caller may also pass the `TF_*` keys directly. Values longer than 64 characters are rejected. Unknown keys
are ignored. For sealed bids, `TF_Sha256` is the hash of the ciphertext. The vendor's receipt shows the hash of
the plaintext, which is kept in PostgreSQL.

## Sealed bids: FileNet admins cannot read them before opening

TenderFlow encrypts each bid file **before** it reaches FileNet:

- Each bid gets its own AES-256-GCM data key.
- That key is wrapped by `BID_MASTER_KEY`, which lives only in the TenderFlow API's environment.
- The wrapped key, IV and auth tag are stored in PostgreSQL, not in FileNet.

So FileNet holds only ciphertext. An object-store administrator, a backup operator, or anyone with ACCE or
Navigator access sees an opaque `application/octet-stream` blob, and cannot decrypt it until the committee chair
runs the opening in TenderFlow. FileNet still provides what it is good at: durable storage, versioning, audit and
records/retention. TenderFlow provides confidentiality until the deadline.

## TechZone limitation: plain HTTP

The TechZone FileNet environment exposes the GraphQL endpoint over **plain HTTP** with Basic authentication.
Credentials and document bytes therefore travel unencrypted between the TenderFlow API and FileNet. Sealed bids
are still protected, because they are encrypted before upload. Other documents and the service password are not.

This is acceptable for the demo for three reasons:

- It uses a demo-only service account.
- The environment is reachable only from the presenter's machine.
- It holds no real customer data.

For production:

- Use HTTPS (or a TLS-terminating route) for `FILENET_GRAPHQL_URL`.
- Use OIDC bearer tokens instead of Basic authentication.
- Use a least-privilege service account limited to the TenderFlow folder and class.

Because the endpoint is plain HTTP, never reuse the TechZone password anywhere else.

## Protocol details and their sources

| Shape used | Source |
|---|---|
| `objectStore(identifier:)` → `id displayName symbolicName` | published schema, and confirmed live by the previous attempt |
| `folder(repositoryIdentifier:, identifier: <path>)` | published schema (`Query.folder`) |
| `createFolder(repositoryIdentifier:, folderProperties: { name, parent: { identifier } })` | published schema (`FolderPropertiesInput`, `ObjectReferenceInput`), IBM JS samples, live mutation list |
| `createDocument(repositoryIdentifier:, classIdentifier:, fileInFolderIdentifier:, checkinAction: {}, documentProperties: {...})` | published schema, IBM JS samples, live mutation list |
| `contentElements: { replace: [{ type: CONTENT_TRANSFER, contentType, subContentTransfer: { content: $contvar, retrievalName } }] }` | published schema (`ContentElementListInput`, `BaseContentElementInput`, `SubContentTransferInput`) |
| `properties: [{TF_TenantId: "..."}, ...]` (custom scalar `PropertyIdentifierAndScalarValue`) | published schema (scalar), IBM JS samples (literal `{Name: value}` form) |
| `document(...) { contentElements { ... on ContentTransfer { contentSize retrievalName downloadUrl } } }` | published schema, IBM JS samples |
| `classDescription(repositoryIdentifier:, identifier:)` | published schema |
| Multipart form: part `graphql` = `{query, variables}` first, then a file part named after the variable (`contvar`), with `variables.contvar = null` | IBM community article (`-F graphql=... -F contvar=@file`) |
| `ECM-CS-XSRF-Token` sent as a header and as a cookie with the same random value | IBM community article and samples |
| Download: relative `downloadUrl`; fallback `/content-services-graphql/content?repositoryIdentifier=&documentId=&elementSequenceNumber=0` | IBM community article |
| **Assumed:** "not found" errors match `FNRCE0051` / `E_OBJECT_NOT_FOUND` / "not found" | CE error codes; not in the schema |
| **Assumed:** "duplicate name" errors match `FNRCE0022` / `E_NOT_UNIQUE` | CE error codes; not in the schema |

All of these live in the constant `FILENET_PROTOCOL` in `filenet-store.ts`. IBM's JavaScript sample uses the
`operations` + `map` multipart convention, but the article and the curl examples use `graphql`. If the live
server rejects `graphql`, change `multipartQueryPart` there.

## Verifying against TechZone (from the Windows machine)

```powershell
npm install
npm run build -w services/api
npm run verify:filenet
```

If the full API build is broken mid-rewrite, `tsc` still emits JavaScript by default. If it emits nothing,
compile only the FileNet tools:

```powershell
npx -y -p typescript@5.6 tsc --outDir services/api/dist --rootDir services/api/src --module NodeNext --moduleResolution NodeNext --target ES2022 --skipLibCheck services/api/src/tools/verify-filenet.ts services/api/src/tools/filenet-introspect.ts
```

`verify:filenet` runs these steps:

1. Ping the object store.
2. Ensure `/TenderFlow/_verify` exists.
3. Upload an Arabic + English UTF-8 text file.
4. Download it and compare SHA-256.
5. Do the same round trip with a 2 MB binary.
6. Check the class and the `TF_*` properties (only when they are configured).
7. Read back document metadata for the evidence report.
8. Versioning: create v1, check in v2 as the next major version (checkout + checkin), read both back, compare
   SHA-256, and confirm both share one version series with v2 current. Runs whatever `FILENET_VERSIONING` is,
   so the flag can be turned on only after it passes (skip with `VERIFY_SKIP_VERSIONING=true`).
9. Records declaration (only when `FILENET_RECORDS_MODE` is `property` or `retention`).
Then it prints document ids and Navigator paths (and a Navigator link when `FILENET_NAVIGATOR_URL` is set).

It writes `docs/evidence/filenet-verify-<timestamp>.json` with no secrets. It stops at the first failure with the
full server error.

If a step fails, run the following and send both files from `docs/evidence/`:

```powershell
node services/api/dist/tools/filenet-introspect.js
```

The introspection tool dumps the live definitions of `DocumentPropertiesInput`, `ContentElementListInput`,
`BaseContentElementInput`, `SubContentTransferInput`, `PropertyIdentifierAndScalarValue`,
`FolderPropertiesInput`, `ObjectReferenceInput`, `Document`, `ContentTransfer` and the related root fields to
`docs/evidence/filenet-schema-<timestamp>.txt`.

The verify documents stay in `/TenderFlow/_verify`, so you can screenshot them in Navigator or ACCE. You can
delete them there by hand. The tool never deletes anything.

## Tests

```bash
npm test                      # all API tests, including the FileNet ones below
cd services/api && node --import tsx --test test/filenet-store.test.ts test/filenet-showcase-store.test.ts test/filenet-showcase-api.test.ts
```

The fake server lives in `services/api/test/fakes/fake-filenet.ts`.

The test starts a local fake Content Services GraphQL server. The fake checks the following:

- Basic auth.
- The XSRF header matches the XSRF cookie.
- The session cookie is sent back.
- The multipart part order (`graphql` first) and the file part name (`contvar`).
- Folder creation order and the existence checks.
- Download paths, including the fallback.
- Custom property literals.
- GraphQL and HTTP errors surface as exceptions.
- Nothing is written outside the root.
- The verify and introspect CLIs pass end-to-end.
- Checkout + major check-in for versioning, the reservation is cancelled when check-in fails, and nothing falls
  back silently (`test/filenet-showcase-store.test.ts`).
- `describe()`, `declareRecord()` (none / property / retention), the folder tree and the telemetry ring buffer.
- The evidence and health routes and their access rules (`test/filenet-showcase-api.test.ts`).

What the FileNet showcase adds (evidence panel, health page, versioning, records) is described in
[SHOWCASE.md](SHOWCASE.md).
