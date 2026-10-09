// FileNet showcase, store level: describe(), addendum versioning (checkout + checkin), declareRecord modes,
// folder tree, operation telemetry and Navigator links — against the local fake Content Services GraphQL server.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FileNetStore, FileNetError, FileNetConfigError } from '../src/content/filenet-store.js';
import { FilesystemStore } from '../src/content/filesystem-store.js';
import { ContentTelemetry, withTelemetry } from '../src/content/index.js';
import { navigatorConfig, navigatorUrl } from '../src/content/navigator.js';
import { FakeFileNet, OS_GUID, PASSWORD } from './fakes/fake-filenet.js';

const fake = new FakeFileNet();
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const putText = (s: FileNetStore, text: string, extra: Record<string, unknown> = {}) =>
  s.put({ tenantId: 'kea', folderPath: '/kea/KEA-2026-102/TENDER_PACK', fileName: 'pack.txt', mimeType: 'text/plain', bytes: Buffer.from(text), properties: { tenderId: 'T-1', docType: 'TENDER_PACK' }, ...extra });

before(async () => { await fake.start(); });
after(async () => { await fake.stop(); });
beforeEach(() => fake.reset());

describe('configuration flags', () => {
  test('defaults: versioning off, records mode none', () => {
    const s = new FileNetStore(fake.env());
    assert.equal(s.config.versioning, false);
    assert.equal(s.config.recordsMode, 'none');
    assert.equal(s.config.retentionDays, null);
  });
  test('bad values are rejected with the variable name', () => {
    assert.throws(() => new FileNetStore(fake.env({ FILENET_VERSIONING: 'maybe' })), (e: any) => e instanceof FileNetConfigError && /FILENET_VERSIONING/.test(e.message));
    assert.throws(() => new FileNetStore(fake.env({ FILENET_RECORDS_MODE: 'hold' })), /FILENET_RECORDS_MODE must be one of none, property, retention/);
    assert.throws(() => new FileNetStore(fake.env({ FILENET_RECORDS_MODE: 'retention' })), /requires FILENET_RETENTION_DAYS/);
    assert.throws(() => new FileNetStore(fake.env({ FILENET_RECORDS_MODE: 'retention', FILENET_RETENTION_DAYS: '1.5' })), /requires FILENET_RETENTION_DAYS/);
    assert.equal(new FileNetStore(fake.env({ FILENET_RECORDS_MODE: 'retention', FILENET_RETENTION_DAYS: '3650' })).config.retentionDays, 3650);
  });
});

describe('put() metadata and describe()', () => {
  test('put returns the FileNet object id, class, folder, name and version label', async () => {
    const s = new FileNetStore(fake.env());
    const out = await putText(s, 'v1');
    assert.equal(out.meta?.objectStore, 'OS1');
    assert.equal(out.meta?.objectId, s.parseStoreRef(out.storeRef).id);
    assert.equal(out.meta?.className, 'Document');
    assert.equal(out.meta?.folderPath, '/TenderFlow/kea/KEA-2026-102/TENDER_PACK');
    assert.equal(out.meta?.name, 'pack.txt');
    assert.equal(out.meta?.versionLabel, '1.0');
    assert.match(String(out.meta?.versionSeriesId), /^\{VS-/);
    assert.equal(out.meta?.repositoryVersioning, false);
    assert.match(fake.graphqlOps('TfCreateDocument')[0].query!, /\) \{ id name className majorVersionNumber minorVersionNumber versionSeries \{ id \} \}/);
  });

  test('describe reports class, version, series, folders, content and only the properties that exist', async () => {
    const s = new FileNetStore(fake.env());
    const out = await putText(s, 'مرحبا');
    const d = await s.describe(out.storeRef);
    assert.equal(d.type, 'filenet');
    assert.equal(d.objectStore, 'OS1');
    assert.equal(d.objectStoreId, OS_GUID);
    assert.equal(d.className, 'Document');
    assert.equal(d.majorVersionNumber, 1);
    assert.equal(d.minorVersionNumber, 0);
    assert.equal(d.isCurrentVersion, true);
    assert.deepEqual(d.folders, ['/TenderFlow/kea/KEA-2026-102/TENDER_PACK']);
    assert.equal(d.contentElements?.[0].contentSize, Buffer.byteLength('مرحبا'));
    assert.equal(d.byteSize, Buffer.byteLength('مرحبا'));
    assert.deepEqual(d.properties, { DocumentTitle: 'pack.txt' });
    assert.equal(d.versions?.length, 1);
    assert.equal('cmRetentionDate' in d, false, 'cmRetentionDate is only queried in retention mode');
    const q = fake.graphqlOps('TfDescribeFull')[0];
    assert.deepEqual(q.variables.props, ['DocumentTitle'], 'TF_* names are not requested from the base Document class');
    assert.doesNotMatch(q.query!, /cmRetentionDate/);
  });

  test('describe asks for TF_* and record properties only when they are enabled', async () => {
    fake.classes.add('TF_Document');
    const s = new FileNetStore(fake.env({ FILENET_DOC_CLASS: 'TF_Document', FILENET_SET_CUSTOM_PROPERTIES: 'true', FILENET_RECORDS_MODE: 'property' }));
    const out = await putText(s, 'x');
    const d = await s.describe(out.storeRef);
    assert.equal(d.properties?.TF_DocType, 'TENDER_PACK');
    assert.equal(d.properties?.TF_Sha256, sha(Buffer.from('x')));
    assert.deepEqual(fake.graphqlOps('TfDescribeFull')[0].variables.props,
      ['DocumentTitle', 'TF_TenantId', 'TF_TenderId', 'TF_VendorId', 'TF_DocType', 'TF_Sha256', 'TF_RecordDeclared', 'TF_RecordDeclaredAt']);
  });

  test('describe of a missing document throws the server error', async () => {
    const s = new FileNetStore(fake.env());
    await assert.rejects(s.describe('filenet:OS1:{NOPE}'), /E_OBJECT_NOT_FOUND/);
  });
});

describe('addendum versioning', () => {
  test('FILENET_VERSIONING=false: a superseding upload is a new document (TenderFlow keeps the chain)', async () => {
    const s = new FileNetStore(fake.env());
    const v1 = await putText(s, 'v1');
    const v2 = await putText(s, 'v2', { fileName: 'pack-v2.txt', supersedesRef: v1.storeRef });
    assert.notEqual(v1.storeRef, v2.storeRef);
    assert.equal(fake.graphqlOps('TfCheckout').length, 0);
    assert.equal(fake.graphqlOps('TfCreateDocument').length, 2);
    assert.equal(v2.meta?.versionLabel, '1.0');
    assert.notEqual(v1.meta?.versionSeriesId, v2.meta?.versionSeriesId);
  });

  test('FILENET_VERSIONING=true: checkout + major check-in; both versions readable with their own bytes', async () => {
    const s = new FileNetStore(fake.env({ FILENET_VERSIONING: 'true' }));
    const v1 = await putText(s, 'version one');
    const v2 = await putText(s, 'version two', { fileName: 'addendum.txt', supersedesRef: v1.storeRef });
    assert.equal(v2.meta?.repositoryVersioning, true);
    assert.equal(v2.meta?.folderPath, null, 'a checked-in version is filed with its version series, not in the requested folder');
    assert.equal(v2.meta?.versionLabel, '2.0');
    assert.equal(v2.meta?.supersedesObjectId, s.parseStoreRef(v1.storeRef).id);
    assert.equal(v2.meta?.versionSeriesId, v1.meta?.versionSeriesId);
    // Exactly one checkout and one multipart check-in; no new document was created.
    const co = fake.graphqlOps('TfCheckout');
    assert.equal(co.length, 1);
    assert.equal(co[0].variables.id, s.parseStoreRef(v1.storeRef).id);
    const ci = fake.graphqlOps('TfCheckin');
    assert.equal(ci.length, 1);
    assert.deepEqual(ci[0].multipart!.partOrder, ['graphql', 'contvar']);
    assert.match(ci[0].variables.id, /^\{RES-/, 'check-in targets the reservation');
    assert.match(ci[0].query!, /checkinAction: \{ checkinMinorVersion: false \}/);
    assert.equal(fake.graphqlOps('TfCreateDocument').length, 1);
    // Bytes of both versions.
    assert.equal((await s.get(v1.storeRef)).toString(), 'version one');
    assert.equal((await s.get(v2.storeRef)).toString(), 'version two');
    // Repository view.
    const d1 = await s.describe(v1.storeRef);
    const d2 = await s.describe(v2.storeRef);
    assert.equal(d1.isCurrentVersion, false);
    assert.equal(d2.isCurrentVersion, true);
    assert.equal(d2.majorVersionNumber, 2);
    assert.deepEqual(d2.versions?.map((v) => `${v.majorVersionNumber}.${v.minorVersionNumber}`), ['1.0', '2.0']);
  });

  test('custom properties are re-sent on check-in with the new SHA-256', async () => {
    fake.classes.add('TF_Document');
    const s = new FileNetStore(fake.env({ FILENET_VERSIONING: 'true', FILENET_DOC_CLASS: 'TF_Document', FILENET_SET_CUSTOM_PROPERTIES: 'true' }));
    const v1 = await putText(s, 'one');
    const v2 = await putText(s, 'two', { supersedesRef: v1.storeRef });
    const d2 = await s.describe(v2.storeRef);
    assert.equal(d2.properties?.TF_Sha256, sha(Buffer.from('two')));
  });

  test('failed check-in throws the server text and cancels the reservation (no silent new document)', async () => {
    const s = new FileNetStore(fake.env({ FILENET_VERSIONING: 'true' }));
    const v1 = await putText(s, 'one');
    fake.failCheckin = 'FNRCE0066E: E_ACCESS_DENIED: you may not check in';
    await assert.rejects(putText(s, 'two', { supersedesRef: v1.storeRef }), (e: any) => e instanceof FileNetError
      && /FILENET_VERSIONING=true/.test(e.message) && /E_ACCESS_DENIED: you may not check in/.test(e.message) && /reservation cancelled/.test(e.message)
      && e.code === 'CONTENT_STORE_UNAVAILABLE');
    assert.equal(fake.graphqlOps('TfCancelCheckout').length, 1);
    assert.equal(fake.graphqlOps('TfCreateDocument').length, 1, 'no fallback document was created');
    assert.equal([...fake.docs.values()].filter((d) => d.reservation).length, 0);
    // The original is usable and can be versioned afterwards.
    const v2 = await putText(s, 'two', { supersedesRef: v1.storeRef });
    assert.equal(v2.meta?.versionLabel, '2.0');
  });

  test('checkout refused (not the current version) is surfaced', async () => {
    const s = new FileNetStore(fake.env({ FILENET_VERSIONING: 'true' }));
    const v1 = await putText(s, 'one');
    await putText(s, 'two', { supersedesRef: v1.storeRef });
    await assert.rejects(putText(s, 'three', { supersedesRef: v1.storeRef }), /checkout of .* failed — .*E_NOT_CURRENT_VERSION/);
  });
});

describe('declareRecord', () => {
  test('none (default) returns ok:false without calling the server', async () => {
    const s = new FileNetStore(fake.env());
    const out = await putText(s, 'x');
    const before = fake.log.length;
    assert.deepEqual(await s.declareRecord(out.storeRef, { reason: 'awarded' }), { ok: false, detail: 'records declaration not configured (FILENET_RECORDS_MODE=none)' });
    assert.equal(fake.log.length, before);
  });

  test('property mode sets TF_RecordDeclared / TF_RecordDeclaredAt and reads them back', async () => {
    fake.classes.add('TF_Document');
    fake.recordProperties = true;
    const s = new FileNetStore(fake.env({ FILENET_DOC_CLASS: 'TF_Document', FILENET_RECORDS_MODE: 'property' }));
    const out = await putText(s, 'x');
    const r = await s.declareRecord(out.storeRef, { reason: 'awarded' });
    assert.equal(r.ok, true);
    assert.match(r.detail, /marked TF_RecordDeclared=true .* — immutability requires IBM Enterprise Records or a retention policy/);
    const q = fake.graphqlOps('TfDeclareRecord')[0].query!;
    assert.match(q, /documentProperties: \{ properties: \[\{TF_RecordDeclared: true\} \{TF_RecordDeclaredAt: "\d{4}-\d\d-\d\dT[^"]+Z"\}\] \}/);
    const d = await s.describe(out.storeRef);
    assert.equal(d.properties?.TF_RecordDeclared, true);
  });

  test('property mode without the ACCE properties throws the server error', async () => {
    const s = new FileNetStore(fake.env({ FILENET_RECORDS_MODE: 'property' }));
    const out = await putText(s, 'x');
    await assert.rejects(s.declareRecord(out.storeRef, { reason: 'awarded' }), /property TF_RecordDeclared not found in class Document/);
  });

  test('retention mode sets CmRetentionDate = now + days and reads it back', async () => {
    const s = new FileNetStore(fake.env({ FILENET_RECORDS_MODE: 'retention', FILENET_RETENTION_DAYS: '30' }));
    const out = await putText(s, 'x');
    const t0 = Date.now();
    const r = await s.declareRecord(out.storeRef, { reason: 'awarded' });
    assert.equal(r.ok, true);
    assert.match(r.detail, /CmRetentionDate set to .* \(30 days\) — the Content Engine refuses deletion before that date/);
    const until = Date.parse(fake.graphqlOps('TfRetain')[0].variables.until);
    assert.ok(Math.abs(until - (t0 + 30 * 86_400_000)) < 60_000);
    const d = await s.describe(out.storeRef);
    assert.equal(Date.parse(d.cmRetentionDate!), until);
  });
});

describe('folder tree', () => {
  test('FileNet: two levels below <root>/<tenant> with document counts, in one request', async () => {
    const s = new FileNetStore(fake.env());
    await putText(s, 'a');
    await putText(s, 'b', { fileName: 'b.txt' });
    await s.put({ tenantId: 'kea', folderPath: '/kea/vendors/VENDOR', fileName: 'cr.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-'), properties: {} });
    const before = fake.graphqlOps().length;
    const tree = await s.folderTree('/kea', 2);
    assert.equal(fake.graphqlOps().length - before, 1);
    assert.equal(tree?.path, '/TenderFlow/kea');
    assert.deepEqual(tree?.children.map((c) => c.name), ['KEA-2026-102', 'vendors']);
    assert.equal(tree?.children[0].children[0].name, 'TENDER_PACK');
    assert.equal(tree?.children[0].children[0].documentCount, 2);
    assert.equal(tree?.children[1].children[0].documentCount, 1);
    assert.equal(await s.folderTree('/nobody', 2), null);
  });

  test('filesystem: same shape from the local store, sidecars not counted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-fs-'));
    const s = new FilesystemStore(dir);
    await s.put({ tenantId: 'kea', folderPath: '/kea/T-1/TENDER_PACK', fileName: 'a.txt', mimeType: 'text/plain', bytes: Buffer.from('a'), properties: {} });
    const tree = await s.folderTree('/kea', 2);
    assert.equal(tree?.children[0].name, 'T-1');
    assert.equal(tree?.children[0].children[0].documentCount, 1);
    const d = await s.describe('kea/T-1/TENDER_PACK/a.txt');
    assert.deepEqual({ type: d.type, byteSize: d.byteSize, storedSha256: d.storedSha256 }, { type: 'filesystem', byteSize: 1, storedSha256: sha(Buffer.from('a')) });
    assert.equal(JSON.stringify(d).includes(dir), false, 'no absolute paths');
  });
});

describe('telemetry wrapper', () => {
  test('records put/get/describe/declareRecord with timings, newest first, without contents or secrets', async () => {
    const t = new ContentTelemetry();
    const s = withTelemetry(new FileNetStore(fake.env()), t);
    const out = await s.put({ tenantId: 'kea', folderPath: '/kea/T/TENDER_PACK', fileName: 'secret-content.txt', mimeType: 'text/plain', bytes: Buffer.from('TOP-SECRET-BYTES'), properties: {} });
    await s.get(out.storeRef);
    await s.describe!(out.storeRef);
    await s.declareRecord!(out.storeRef, { reason: 'x' });
    await assert.rejects(s.get('filenet:OS1:{NOPE}'));
    const ops = s.telemetry!();
    assert.deepEqual(ops.map((o) => `${o.op}:${o.ok}`), ['get:false', 'declareRecord:false', 'describe:true', 'get:true', 'put:true']);
    assert.equal(ops[4].ref, out.storeRef);
    assert.equal(ops[4].folder, '/kea/T/TENDER_PACK');
    assert.match(ops[0].error!, /E_OBJECT_NOT_FOUND/);
    assert.match(ops[1].error!, /FILENET_RECORDS_MODE=none/);
    for (const o of ops) { assert.equal(typeof o.ms, 'number'); assert.ok(!Number.isNaN(Date.parse(o.at))); }
    const dump = JSON.stringify(ops);
    assert.equal(dump.includes('TOP-SECRET-BYTES'), false);
    assert.equal(dump.includes(PASSWORD), false);
  });

  test('ring buffer keeps the last 100 operations', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-fs-'));
    const s = withTelemetry(new FilesystemStore(dir));
    const out = await s.put({ tenantId: 'k', folderPath: '/k', fileName: 'a.txt', mimeType: 'text/plain', bytes: Buffer.from('a'), properties: {} });
    for (let i = 0; i < 120; i++) await s.get(out.storeRef);
    assert.equal(s.telemetry!().length, 100);
    assert.equal(s.telemetry!(5).length, 5);
    assert.equal(s.telemetry!().some((o) => o.op === 'put'), false, 'the oldest entries were dropped');
    assert.equal(s.declareRecord, undefined, 'optional capabilities are not invented by the wrapper');
    assert.equal(withTelemetry(s), s, 'not double-wrapped');
  });
});

describe('Navigator links', () => {
  test('no URL without FILENET_NAVIGATOR_URL', () => {
    assert.equal(navigatorConfig({}), null);
    assert.equal(navigatorUrl(null, { type: 'filenet', className: 'Document', objectStoreId: OS_GUID, id: '{D}', versionSeriesId: '{V}' }), null);
  });
  test('bookmark.jsp with desktop, repository, P8 docid, class and version series', () => {
    const cfg = navigatorConfig({ FILENET_NAVIGATOR_URL: 'http://icn:9080/navigator/', FILENET_OBJECT_STORE: 'OS1' });
    assert.deepEqual(cfg, { baseUrl: 'http://icn:9080/navigator', desktop: 'ICN', repositoryId: 'OS1' });
    const u = new URL(navigatorUrl(cfg, { type: 'filenet', className: 'TF_Document', objectStoreId: OS_GUID, id: '{D-1}', versionSeriesId: '{V-1}' })!);
    assert.equal(u.pathname, '/navigator/bookmark.jsp');
    assert.equal(u.searchParams.get('desktop'), 'ICN');
    assert.equal(u.searchParams.get('repositoryId'), 'OS1');
    assert.equal(u.searchParams.get('repositoryType'), 'p8');
    assert.equal(u.searchParams.get('docid'), `TF_Document,${OS_GUID},{D-1}`);
    assert.equal(u.searchParams.get('template_name'), 'TF_Document');
    assert.equal(u.searchParams.get('vsId'), '{V-1}');
    const custom = navigatorConfig({ FILENET_NAVIGATOR_URL: 'https://icn/navigator', FILENET_NAVIGATOR_DESKTOP: 'TenderFlow', FILENET_NAVIGATOR_REPOSITORY: 'FocusCorp' });
    assert.equal(custom?.desktop, 'TenderFlow');
    assert.equal(custom?.repositoryId, 'FocusCorp');
    assert.equal(navigatorConfig({ FILENET_NAVIGATOR_URL: 'http://user:pw@icn/navigator' }), null, 'credentials in the URL are refused');
  });
});
