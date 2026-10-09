# ACCE runbook: TenderFlow class and properties (OPTIONAL)

> **This runbook is optional.** TenderFlow works tonight with the base `Document` class
> (`FILENET_DOC_CLASS=Document`, `FILENET_SET_CUSTOM_PROPERTIES=false`). Follow these steps only to show
> TenderFlow metadata (tenant, tender, vendor, document type, SHA-256) on documents in FileNet, and (§1b) to
> mark records at award. Allow about 15–20 minutes.
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
✓ 6 document class TF_Document exists
✓ 6 custom TF_* properties stored — all 5 match
```

To see the result in ACCE, open **Browse → Root Folder → TenderFlow → _verify → verify-text-…**. The
**Properties** tab shows the `TF_*` values, and **Class** shows `TF_Document`. Take a screenshot for the ESA
evidence pack.

If step 6 fails, the error text names the missing property or the value that came back. Check that the symbolic
names match exactly, including case.

## Rollback

Set `FILENET_DOC_CLASS=Document`, `FILENET_SET_CUSTOM_PROPERTIES=false` and `FILENET_RECORDS_MODE=none` in `.env`,
then restart the API.
Documents already created as `TF_Document` stay valid and readable. Do not delete the class or the templates
while documents still use them.
