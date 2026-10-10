# ACCE runbook: TenderFlow classes, properties and security (OPTIONAL)

> **This runbook is optional.** TenderFlow works with the base `Document` class
> (`FILENET_DOC_CLASS=Document`, `FILENET_SET_CUSTOM_PROPERTIES=false`, `FILENET_CLASS_MODEL=single`,
> `FILENET_ACL_MODE=off`). Follow §1–§5 to show TenderFlow metadata on documents in FileNet and (§1b) to mark
> records at award (about 15–20 minutes). Follow **§6** for the full TenderFlow class model (a subclass per kind of
> document, about 30 minutes) and **§7** for document security (groups and permission lists, about 15 minutes);
> **§8** switches the flags on in the right order. Until a flag is on, nothing changes for uploads — and even with
> the flags on, a class or property that is missing never breaks an upload (the document falls back to
> `FILENET_DOC_CLASS`).
>
> The Content Services GraphQL API has no mutations for class or property definitions (see
> `docs/evidence/G2-b/mutations.txt`). A person must do these steps in ACCE.

Target: the IBM TechZone FileNet environment, object store **OS1** ("Focus Corp"). The store is shared, so
change only what is listed here.

## 0. Open ACCE

1. In the browser on the Windows machine, open `http://<techzone-host>:<port>/acce`. Use the same host as
   `FILENET_GRAPHQL_URL`. The ACCE port may be different; it is listed on the TechZone reservation page.
2. Log in with the TechZone admin user from the reservation details.
3. In the left tree, expand **Object Stores** and click **OS1** (display name *Focus Corp*). A new tab opens
   for the object store.

## 1. Create five property templates

In the OS1 tab, expand **Data Design → Property Templates**. Before creating anything, check that none of the
names below already exist. Use the filter box and type `TF_`.

For each row in the table:

1. Right-click **Property Templates** → **New Property Template** (or select the folder, then **Actions → New**).
2. **Name and Describe the Property Template**:
   - Display name = the name from the table.
   - Symbolic name = the same value. It is filled in automatically; check that it matches exactly, including case.
   - Description = from the table.
   - Click **Next**.
3. **Select the Data Type**: choose **String**, then click **Next**.
4. **Select a Choice List**: leave it empty, then click **Next**.
5. **Single or Multiple Values**: choose **Single**, then click **Next**.
6. **Specify Additional Attributes**: set **Maximum length** to **64**. Leave **Value required** unchecked.
   Click **Next**.
7. Click **Finish**, then **Close**.

| Display / symbolic name | Data type | Max length | Description |
|---|---|---|---|
| `TF_TenantId` | String | 64 | TenderFlow tenant id |
| `TF_TenderId` | String | 64 | TenderFlow tender id |
| `TF_VendorId` | String | 64 | TenderFlow vendor id |
| `TF_DocType` | String | 64 | TenderFlow document type (TENDER_PACK, BID_TECHNICAL, ...) |
| `TF_Sha256` | String | 64 | SHA-256 (hex) of the stored bytes |

## 1b. Record-declaration properties (only for `FILENET_RECORDS_MODE=property`)

Skip this section unless you want TenderFlow to mark documents as records in FileNet when a tender is awarded.
Create two more property templates the same way as in §1, with these differences:

| Display / symbolic name | Data type | Max length | Description |
|---|---|---|---|
| `TF_RecordDeclared` | **Boolean** | — | TenderFlow declared this document a record (set at award) |
| `TF_RecordDeclaredAt` | String | 64 | When TenderFlow declared the record (ISO-8601 UTC text) |

- For `TF_RecordDeclared` choose **Boolean** on the **Select the Data Type** page; there is no maximum length.
- `TF_RecordDeclaredAt` is a **String** on purpose: TenderFlow writes the timestamp as text, so no date
  conversion can fail.

Add both templates to `TF_Document` in §2 step 4 (or later: open **Classes → Document → TF_Document →
Property Definitions → Add**). Then set in `.env`:

```dotenv
FILENET_DOC_CLASS=TF_Document
FILENET_RECORDS_MODE=property
```

`npm run verify:filenet` step 9 then sets `TF_RecordDeclared=true` on the verify text document and reads it back.

> These properties are a **marker**, not a lock. FileNet itself only refuses change or deletion with IBM
> Enterprise Records or a retention policy (CmRetentionDate). TenderFlow says this in the record detail it stores.
> `FILENET_RECORDS_MODE=retention` (with `FILENET_RETENTION_DAYS`) sets CmRetentionDate instead; it needs no
> ACCE change but is **not verified live** — see `docs/filenet/SHOWCASE.md`.

## 1c. Document-intelligence properties (only for `FILENET_AI_PROPERTIES=true`)

Skip this section unless you want TenderFlow to write what watsonx Orchestrate read from a document — after a person
accepted it — onto the FileNet document itself (see `docs/DOCUMENT-INTELLIGENCE.md`). `TF_DocType` already exists
from §1 (String, 64). Create two more property templates the same way as in §1:

| Display / symbolic name | Data type | Max length | Description |
|---|---|---|---|
| `TF_ExpiryDate` | **Date Time** | — | Expiry / valid-until date accepted by the reviewer (midnight UTC) |
| `TF_AIReviewed` | **Boolean** | — | A person accepted (or corrected) the data Orchestrate extracted |

Add both to `TF_Document` (§2 step 4, or later via **Property Definitions → Add**), then set in `.env`:

```dotenv
FILENET_DOC_CLASS=TF_Document
FILENET_AI_PROPERTIES=true
```

On acceptance TenderFlow calls `updateDocument` (the same mutation as §1b) with
`{TF_DocType: "<code, e.g. COMMERCIAL_REGISTRATION>"} {TF_ExpiryDate: "<YYYY-MM-DD>T00:00:00.000Z"} {TF_AIReviewed: true}`
and reads the values back. On acceptance `TF_DocType` changes from the upload slot (e.g. `VENDOR`) to the
classified type. If the Content Engine refuses (e.g. the templates are missing), the review still succeeds and the
error is shown in the document's Data panel and audited as `DOCUMENT_PROPERTIES_FAILED`.

> **Not verified live.** The Date Time literal and the Boolean literal are ASSUMED (same literal form as the String
> properties that passed live); tested only against the local fake Content Services server.

## 2. Create document class `TF_Document`

1. In the OS1 tab, expand **Data Design → Classes → Document**.
2. Right-click **Document** → **New Class**. This makes `TF_Document` a subclass of `Document`.
3. **Name and Describe the Class**:
   - Display name = `TF_Document`.
   - Symbolic name = `TF_Document`. Check that it matches exactly.
   - Description = `TenderFlow document`.
   - Click **Next**.
4. **Select Properties**: in the available list, filter by `TF_`. Add all five templates: `TF_TenantId`,
   `TF_TenderId`, `TF_VendorId`, `TF_DocType`, `TF_Sha256`. Click **Next**.
   If you did §1b, also add `TF_RecordDeclared` and `TF_RecordDeclaredAt`.
5. On the summary page, click **Finish**, then **Close**.
6. Refresh **Classes → Document** and confirm that `TF_Document` appears. Open it and check the **Property
   Definitions** tab: all five `TF_*` properties should be listed, along with the inherited ones.

## 3. Create folder `/TenderFlow` (optional; TenderFlow creates it on first upload)

1. In the OS1 tab, expand **Browse → Root Folder**.
2. If `TenderFlow` is not there, right-click **Root Folder** → **New Folder**. Set the name to `TenderFlow`,
   leave the class as `Folder`, then click **Next** and **Finish**.

## 4. Check the service user's permissions

The user in `FILENET_SERVICE_USER` needs the following rights:

- On the object store: **Connect to store**, **Create new objects** and **Modify existing objects**. In the
  TechZone image the admin user already has these.
- On the `/TenderFlow` folder (**Security** tab): **File in folder / Link**, **Create subfolder** and
  **View properties**. Subfolders and documents inherit this through the folder's security inheritance.

Do not change security anywhere else in OS1.

## 5. Switch TenderFlow to the class and properties, then verify

Edit `.env` at the repo root on the Windows machine:

```dotenv
FILENET_DOC_CLASS=TF_Document
FILENET_SET_CUSTOM_PROPERTIES=true
```

Then rerun the verification:

```powershell
npm run verify:filenet
```

Step 6 must now print:

```
✓ PASS 6 document class TF_Document exists
✓ PASS 6 custom TF_* properties stored — all 5 match
```

To see the result in ACCE, open **Browse → Root Folder → TenderFlow → _verify → verify-text-…**. The
**Properties** tab shows the `TF_*` values, and **Class** shows `TF_Document`. Take a screenshot for the ESA
evidence pack.

If step 6 fails, the error text names the missing property or the value that came back. Check that the symbolic
names match exactly, including case.


## 6. TenderFlow class model (for `FILENET_CLASS_MODEL=subclasses`)

The model is `TF_Document` (from §2) plus five subclasses. Subclasses inherit every property of `TF_Document`, so the
properties are added **once**, on `TF_Document`. TenderFlow checks what exists (`classDescription`) before each
upload (cached 5 minutes) and writes only the classes and properties it finds.

| Class | Parent | Holds (TenderFlow owner types) |
|---|---|---|
| `TF_Document` | `Document` | anything not listed below |
| `TF_TenderDocument` | `TF_Document` | `TENDER_PACK`, `ADDENDUM`, `NOTICE`, `REQUEST_LETTER` |
| `TF_BidEnvelope` | `TF_Document` | `BID_TECHNICAL`, `BID_FINANCIAL` (ciphertext) |
| `TF_VendorDocument` | `TF_Document` | `VENDOR` |
| `TF_CommitteeRecord` | `TF_Document` | `OPENING_RECORD`, `COMMITTEE_REPORT`, `EVALUATION_NARRATIVE` |
| `TF_EvidencePack` | `TF_Document` | `EVIDENCE_PACK` |

### 6a. Property templates

Create the templates that do not exist yet (the five of §1 are reused), the same way as in §1. Filter by `TF_`
first. **Integer** and **Float** are chosen on the *Select the Data Type* page (no maximum length).

| Display / symbolic name | Data type | Max length | Description |
|---|---|---|---|
| `TF_TenderNumber` | String | 64 | Tender number, e.g. KEA-2026-102 |
| `TF_OwnerType` | String | 32 | Upload slot: TENDER_PACK, BID_TECHNICAL, VENDOR … |
| `TF_DocumentType` | String | 64 | Document type at upload |
| `TF_Confidentiality` | String | 16 | PUBLIC, INTERNAL, SEALED, COMMITTEE or AUDIT |
| `TF_UploadedBy` | String | 64 | TenderFlow user id of the uploader |
| `TF_VersionNo` | **Integer** | — | TenderFlow version number (1, 2, …) |
| `TF_AiClassification` | String | 64 | Document type suggested by watsonx Orchestrate (not yet reviewed) |
| `TF_AiConfidence` | **Float** | — | Share (0–1) of the suggested type's required fields found with a verified citation |
| `TF_BidId` | String | 64 | TenderFlow bid id — **only** for `TF_BidEnvelope` (6c) |

### 6b. Add the properties to `TF_Document`

1. Open **Data Design → Classes → Document → TF_Document → Property Definitions**.
2. Click **Add** and add every template of 6a **except `TF_BidId`**, plus the five of §1 if they are not there yet
   (`TF_TenantId`, `TF_TenderId`, `TF_VendorId`, `TF_DocType`, `TF_Sha256`). Optional: §1b and §1c templates.
3. **Save**.

### 6c. Create the five subclasses

For each subclass in the table above:

1. Right-click **TF_Document** → **New Class** (this makes it a subclass of `TF_Document`).
2. Display name = symbolic name = the class name, exactly as in the table (case matters). Description = the
   "Holds" column. **Next**.
3. *Select Properties*: nothing to add — the inherited `TF_*` properties are already there. **Only for
   `TF_BidEnvelope`**: add `TF_BidId`. **Next**, **Finish**, **Close**.
4. Open the new class → **Property Definitions**: the inherited `TF_*` properties are listed.

Default instance security of the subclasses: leave as inherited from `TF_Document` (§7 sets security per document).

### 6d. Check from TenderFlow

Set `FILENET_CLASS_MODEL=subclasses` (see §8) and run `scripts\windows\filenet-check.cmd` (or `npm run verify:filenet`).
Step 10 must print:

```
✓ PASS 10 class model: classes and properties exist — 6 classes ready
✓ PASS 10 class model: a tender document is stored as TF_TenderDocument with its properties — {…} (TF_TenderDocument)
```

A FAIL names each missing class or property. The Admin → IBM FileNet page shows the same table ("Document classes").

## 7. Document security: groups and permission lists (for `FILENET_ACL_MODE=groups`)

TenderFlow gives each document a confidentiality level and, with `FILENET_ACL_MODE=groups`, replaces the document's
permission list at create: the **service user** gets *Full Control* (998903) and the level's groups get *View
content* (131201). Sealed envelopes have **only the service user** until the chair opens the bids; TenderFlow then
changes them to COMMITTEE and reads the list back. TenderFlow still enforces every read through the API — the
permission list protects documents that people open directly in Navigator or ACCE.

| Level | Documents | Groups with *View content* |
|---|---|---|
| PUBLIC | tender pack, addenda, notices | PUBLIC, INTERNAL, COMMITTEE, AUDIT |
| INTERNAL | vendor documents, request letters | INTERNAL, AUDIT |
| SEALED | bid envelopes before the opening | — (service user only) |
| COMMITTEE | opened envelopes, opening records, committee reports, evaluation narratives | COMMITTEE, AUDIT |
| AUDIT | auditor evidence packs | AUDIT |

1. **Groups.** In the directory used by the TechZone Content Platform Engine (LDAP), create or pick one group per
   level you want to grant — for example `TF_Public_Readers`, `TF_Entity_Staff`, `TF_Committee`, `TF_Auditors`.
   Add the demo people who should open documents in Navigator. (On TechZone ask the reservation owner if the LDAP
   is read-only; existing groups can be used.)
2. **Check the names resolve.** In ACCE open any test document → **Security** → **Add** → search each group: use
   the name exactly as ACCE shows it (short name or full DN). Cancel — do not save.
3. **Service user rights.** The service user must hold *Modify permissions* (WRITE_ACL) on documents it creates.
   It is the creator and gets Full Control on each document from TenderFlow's own list, so nothing else is needed
   unless the object store's default security removes WRITE_ACL from creators.
4. **Settings** in `.env` (names exactly as in step 2; leave `FILENET_GROUP_SEALED` empty):

   ```dotenv
   FILENET_ACL_MODE=groups
   FILENET_GROUP_PUBLIC=TF_Public_Readers
   FILENET_GROUP_INTERNAL=TF_Entity_Staff
   FILENET_GROUP_COMMITTEE=TF_Committee
   FILENET_GROUP_AUDIT=TF_Auditors
   # FILENET_ACL_SERVICE_GRANTEE=<only if ACCE shows the service user under another name, e.g. a DN>
   ```

5. Run the check: step 11 must print `PASS` twice (sealed envelope written with the service user only; changed to
   COMMITTEE). If the Content Engine refuses a grantee, the error names it (`E_BAD_SECURITY_PRINCIPAL` or similar).
   If it refuses the permission **input shape**, run `node services/api/dist/tools/filenet-introspect.js` and send
   `docs/evidence/filenet-schema-*.txt`: only `permissionsLiteral()` in `services/api/src/content/filenet-model.ts`
   changes.
6. In ACCE open `/TenderFlow/_verify/verify-acl-…` → **Security**: the service user and the committee / audit groups.
   Screenshot it.

## 8. Switch the flags on (order matters)

Change one line at a time in `.env`, restart the API, run the check, and only then go to the next line:

| Order | Setting | Check step that must PASS first |
|---|---|---|
| 1 | `FILENET_VERSIONING=true` | 8 |
| 2 | `FILENET_DOC_CLASS=TF_Document`, `FILENET_SET_CUSTOM_PROPERTIES=true` (rc3 metadata) | 6 |
| 3 | `FILENET_RECORDS_MODE=property` | 9 |
| 4 | `FILENET_CLASS_MODEL=subclasses` | 10 (and 12: search) |
| 5 | `FILENET_ACL_MODE=groups` + `FILENET_GROUP_*` | 11 |
| 6 | `FILENET_AI_PROPERTIES=true` | 14 (and DOCUMENT-INTELLIGENCE.md) |
| — | `FILENET_NAVIGATOR_URL` only if step 13 FAILs with the derived addresses | 13 |

Then open Admin → IBM FileNet: the tiles show the class model and document security on, the class table shows six
"Defined" classes and the Navigator check shows "Navigator answers".

## Rollback

Set `FILENET_DOC_CLASS=Document`, `FILENET_SET_CUSTOM_PROPERTIES=false`, `FILENET_RECORDS_MODE=none`,
`FILENET_CLASS_MODEL=single` and `FILENET_ACL_MODE=off` in `.env`, then restart the API.
Permission lists already written stay on their documents (the service user keeps Full Control); TenderFlow stops
changing them.
Documents already created as `TF_Document` stay valid and readable. Do not delete the class or the templates
while documents still use them.
