// Tests for FileNetStore against a local fake Content Services GraphQL server (test/fakes/fake-filenet.ts).
// The fake checks the request shapes (auth, XSRF header + cookie, multipart layout, folder order, download path)
// and answers with responses shaped like the published CS GraphQL schema.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileNetStore, FileNetError, FileNetConfigError, sanitizeDocumentName } from '../src/content/filenet-store.js';

import { FakeFileNet, USER, PASSWORD } from './fakes/fake-filenet.js';

const fake = new FakeFileNet();
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  FILENET_GRAPHQL_URL: fake.url, FILENET_OBJECT_STORE: 'OS1', FILENET_SERVICE_USER: USER, FILENET_SERVICE_PASSWORD: PASSWORD, ...extra,
});
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

before(async () => { await fake.start(); });
after(async () => { await fake.stop(); });
beforeEach(() => fake.reset());

describe('configuration', () => {
  test('constructor names every missing variable', () => {
    assert.throws(() => new FileNetStore({}), (e: any) => e instanceof FileNetConfigError
      && /FILENET_GRAPHQL_URL/.test(e.message) && /FILENET_OBJECT_STORE/.test(e.message)
      && /FILENET_SERVICE_USER/.test(e.message) && /FILENET_SERVICE_PASSWORD/.test(e.message));
    assert.throws(() => new FileNetStore(env({ FILENET_SERVICE_PASSWORD: '' })), /missing FILENET_SERVICE_PASSWORD/);
  });
  test('rejects root folder "/" and bad flag values', () => {
    assert.throws(() => new FileNetStore(env({ FILENET_ROOT_FOLDER: '/' })), /must not be "\/"/);
    assert.throws(() => new FileNetStore(env({ FILENET_SET_CUSTOM_PROPERTIES: 'maybe' })), /FILENET_SET_CUSTOM_PROPERTIES/);
    const s = new FileNetStore(env({ FILENET_ROOT_FOLDER: 'TenderFlow/' }));
    assert.equal(s.config.rootFolder, '/TenderFlow');
    assert.equal(s.config.docClass, 'Document');
    assert.equal(s.config.setCustomProperties, false);
  });
});

describe('ping', () => {
  test('queries objectStore(identifier:) with Basic auth and XSRF header + cookie', async () => {
    const s = new FileNetStore(env());
    const r = await s.ping();
    assert.equal(r.ok, true, r.detail);
    assert.match(r.detail, /OS1/);
    assert.match(r.detail, /Focus Corp/);
    const l = fake.graphqlOps('TfPing')[0];
    assert.equal(l.variables.os, 'OS1');
    assert.match(l.query!, /objectStore\(identifier: \$os\)/);
    assert.match(l.cookie, new RegExp(`ECM-CS-XSRF-Token=${l.xsrfHeader}`));
  });
  test('reports ok:false with the HTTP reason and no password on bad credentials', async () => {
    const s = new FileNetStore(env({ FILENET_SERVICE_PASSWORD: 'wrong' }));
    const r = await s.ping();
    assert.equal(r.ok, false);
    assert.match(r.detail, /HTTP 401/);
    assert.doesNotMatch(r.detail, /wrong|s3cr3t/);
  });
  test('reports ok:false when the server is unreachable', async () => {
    const s = new FileNetStore(env({ FILENET_GRAPHQL_URL: 'http://127.0.0.1:1/content-services-graphql/graphql', FILENET_TIMEOUT_MS: '3000' }));
    const r = await s.ping();
    assert.equal(r.ok, false);
    assert.match(r.detail, /cannot reach/);
  });
});

describe('put / get', () => {
  test('creates missing folders top-down, uploads multipart with graphql part first, round-trips bytes', async () => {
    const s = new FileNetStore(env());
    const bytes = Buffer.from('مناقصة رقم ٧ — Tender no. 7\n', 'utf8');
    const out = await s.put({ tenantId: 'kea', folderPath: '/kea/T-001/vendor', fileName: 'notes.txt', mimeType: 'text/plain; charset=utf-8', bytes, properties: { tenderId: 'T-001' } });
    assert.equal(out.storeType, 'filenet');
    assert.equal(out.byteSize, bytes.length);
    assert.match(out.storeRef, /^filenet:OS1:\{DOC-0001-/);

    // Folder creation order and parents.
    const creates = fake.graphqlOps('TfCreateFolder').map((l) => `${l.variables.parent}|${l.variables.name}`);
    assert.deepEqual(creates, ['/|TenderFlow', '/TenderFlow|kea', '/TenderFlow/kea|T-001', '/TenderFlow/kea/T-001|vendor']);
    // Existence is checked before each create.
    const checks = fake.graphqlOps('TfFolder').map((l) => l.variables.path);
    assert.deepEqual(checks, ['/TenderFlow', '/TenderFlow/kea', '/TenderFlow/kea/T-001', '/TenderFlow/kea/T-001/vendor']);

    // Multipart layout.
    const c = fake.graphqlOps('TfCreateDocument')[0];
    assert.deepEqual(c.multipart!.partOrder, ['graphql', 'contvar']);
    assert.equal(c.multipart!.fileField, 'contvar');
    assert.equal(c.multipart!.fileName, 'notes.txt');
    assert.equal(c.variables.contvar, null);
    assert.equal(c.variables.folder, '/TenderFlow/kea/T-001/vendor');
    assert.equal(c.variables.cls, 'Document');
    assert.equal(c.variables.name, 'notes.txt');
    assert.equal(c.variables.mime, 'text/plain; charset=utf-8');
    assert.doesNotMatch(c.query!, /properties:/, 'custom properties must not be sent unless enabled');
    assert.match(c.query!, /contentElements: \{ replace: \[\{ type: CONTENT_TRANSFER, contentType: \$mime, subContentTransfer: \{ content: \$contvar, retrievalName: \$name \} \}\] \}/);
    assert.match(c.cookie, /LtpaToken2=fake-ltpa/, 'session cookie from Set-Cookie must be sent back');

    // Download via downloadUrl with the same auth/cookies.
    const back = await s.get(out.storeRef);
    assert.equal(sha(back), sha(bytes));
    const dl = fake.log.filter((l) => l.kind === 'download');
    assert.equal(dl.length, 1);
    assert.match(dl[0].path, /^\/content-services-graphql\/content\?repositoryIdentifier=OS1&documentId=/);
    assert.match(dl[0].cookie, /LtpaToken2=fake-ltpa/);
    assert.match(dl[0].cookie, new RegExp(`ECM-CS-XSRF-Token=${dl[0].xsrfHeader}`));
  });

  test('caches known folders: second put to the same folder issues no folder calls', async () => {
    const s = new FileNetStore(env());
    await s.put({ tenantId: 'kea', folderPath: 'kea/T-1', fileName: 'a.bin', mimeType: 'application/octet-stream', bytes: randomBytes(10), properties: {} });
    const before = fake.graphqlOps().length;
    await s.put({ tenantId: 'kea', folderPath: 'kea/T-1', fileName: 'b.bin', mimeType: 'application/octet-stream', bytes: randomBytes(10), properties: {} });
    const ops = fake.graphqlOps().slice(before).map((l) => l.op);
    assert.deepEqual(ops, ['TfCreateDocument']);
  });

  test('concurrent puts to a new folder create each segment once', async () => {
    fake.folderCreateDelayMs = 30;
    const s = new FileNetStore(env());
    await Promise.all([1, 2, 3, 4].map((i) => s.put({ tenantId: 't', folderPath: '/t/x/y', fileName: `f${i}.txt`, mimeType: 'text/plain', bytes: Buffer.from(`f${i}`), properties: {} })));
    assert.equal(fake.graphqlOps('TfCreateFolder').length, 4);
    assert.equal(fake.docs.size, 4);
  });

  test('folder created concurrently by another process ("already exists") is accepted after re-check', async () => {
    const s = new FileNetStore(env());
    // Another client creates /TenderFlow between our existence check and our create.
    const origHas = fake.folders.has.bind(fake.folders);
    let calls = 0;
    fake.folders.has = (p: string) => { if (p === '/TenderFlow' && calls++ === 0) { fake.folders.add('/TenderFlow'); return false; } return origHas(p); };
    await s.ensureFolder('/TenderFlow');
    fake.folders.has = origHas;
    assert.equal(fake.graphqlOps('TfCreateFolder').length, 1);
    assert.ok(fake.folders.has('/TenderFlow'));
  });

  test('2 MB binary round-trip; fallback /content endpoint when downloadUrl is absent', async () => {
    const s = new FileNetStore(env());
    const bytes = randomBytes(2 * 1024 * 1024);
    const out = await s.put({ tenantId: 'kea', folderPath: '/kea/bin', fileName: 'big.bin', mimeType: 'application/octet-stream', bytes, properties: {} });
    fake.omitDownloadUrl = true;
    const back = await s.get(out.storeRef);
    assert.equal(back.length, bytes.length);
    assert.equal(sha(back), sha(bytes));
    const dl = fake.log.filter((l) => l.kind === 'download')[0];
    assert.match(dl.path, /^\/content-services-graphql\/content\?repositoryIdentifier=OS1&documentId=.*&elementSequenceNumber=0$/);
  });

  test('downloadUrl without the context root is resolved under it', async () => {
    const s = new FileNetStore(env());
    const out = await s.put({ tenantId: 'kea', folderPath: '/kea', fileName: 'x.txt', mimeType: 'text/plain', bytes: Buffer.from('x'), properties: {} });
    fake.downloadUrlWithoutContext = true;
    assert.equal((await s.get(out.storeRef)).toString(), 'x');
    assert.match(fake.log.filter((l) => l.kind === 'download')[0].path, /^\/content-services-graphql\/content\?/);
    assert.throws(() => s.resolveServerUrl('http://evil.example/content?x=1'), /different server/);
  });

  test('custom properties are sent only when enabled, as {Name: "value"} literals incl. SHA-256', async () => {
    fake.classes.add('TF_Document');
    const s = new FileNetStore(env({ FILENET_DOC_CLASS: 'TF_Document', FILENET_SET_CUSTOM_PROPERTIES: 'true' }));
    const bytes = Buffer.from('sealed "ciphertext"');
    const out = await s.put({ tenantId: 'kea', folderPath: '/kea/T-9/bids', fileName: 'bid.enc', mimeType: 'application/octet-stream', bytes, properties: { tenderId: 'T-9', vendorId: 'V-"7"', docType: 'BID_FINANCIAL', ignored: 'x' } });
    const c = fake.graphqlOps('TfCreateDocument')[0];
    assert.equal(c.variables.cls, 'TF_Document');
    const d = fake.docs.get(s.parseStoreRef(out.storeRef).id)!;
    assert.deepEqual(d.props, { TF_TenantId: 'kea', TF_TenderId: 'T-9', TF_VendorId: 'V-"7"', TF_DocType: 'BID_FINANCIAL', TF_Sha256: sha(bytes) });
    const info = await s.describeDocument(out.storeRef, ['TF_TenantId', 'TF_Sha256']);
    assert.equal(info.className, 'TF_Document');
    assert.equal(info.properties.TF_Sha256, sha(bytes));
    assert.deepEqual(info.folders, ['/TenderFlow/kea/T-9/bids']);
    await assert.rejects(s.put({ tenantId: 'kea', folderPath: '/kea', fileName: 'a', mimeType: 'text/plain', bytes, properties: { tenderId: 'x'.repeat(65) } }), /TF_TenderId value is longer than 64/);
  });

  test('duplicate file name in a folder is stored under a unique name (still a real document)', async () => {
    const s = new FileNetStore(env());
    const a = await s.put({ tenantId: 'k', folderPath: '/k', fileName: 'pack.pdf', mimeType: 'application/pdf', bytes: Buffer.from('1'), properties: {} });
    const b = await s.put({ tenantId: 'k', folderPath: '/k', fileName: 'pack.pdf', mimeType: 'application/pdf', bytes: Buffer.from('2'), properties: {} });
    assert.notEqual(a.storeRef, b.storeRef);
    const names = [...fake.docs.values()].map((d) => d.name);
    assert.equal(names[0], 'pack.pdf');
    assert.match(names[1], /^pack \[[0-9a-f]{8}\]\.pdf$/);
    assert.equal((await s.get(b.storeRef)).toString(), '2');
  });
});

describe('failure surfacing', () => {
  test('GraphQL errors on createDocument are thrown with the server text, without credentials', async () => {
    const s = new FileNetStore(env());
    fake.failCreateDocument = 'FNRCE0066E: E_ACCESS_DENIED: Access to object store OS1 was denied.';
    await assert.rejects(
      s.put({ tenantId: 'k', folderPath: '/k', fileName: 'a.txt', mimeType: 'text/plain', bytes: Buffer.from('a'), properties: {} }),
      (e: any) => e instanceof FileNetError && /E_ACCESS_DENIED/.test(e.message) && /path: createDocument/.test(e.message)
        && Array.isArray(e.graphqlErrors) && !e.message.includes(PASSWORD) && e.code === 'CONTENT_STORE_UNAVAILABLE',
    );
  });
  test('unknown document class surfaces as an error (no fallback to Document)', async () => {
    const s = new FileNetStore(env({ FILENET_DOC_CLASS: 'TF_Document' }));
    await assert.rejects(s.put({ tenantId: 'k', folderPath: '/k', fileName: 'a.txt', mimeType: 'text/plain', bytes: Buffer.from('a'), properties: {} }), /class TF_Document not found/);
    assert.equal(fake.docs.size, 0);
  });
  test('non-JSON HTTP 500 is thrown with status and body', async () => {
    const s = new FileNetStore(env());
    fake.http500Once = true;
    await assert.rejects(s.ensureFolder('/TenderFlow/x'), /HTTP 500.*SRVE0255E/);
  });
  test('get of a missing document throws', async () => {
    const s = new FileNetStore(env());
    await assert.rejects(s.get('filenet:OS1:{NOPE}'), /E_OBJECT_NOT_FOUND/);
  });
  test('storeRef validation', async () => {
    const s = new FileNetStore(env());
    await assert.rejects(s.get('fs:abc'), /invalid storeRef/);
    await assert.rejects(s.get('filenet:OS2:{X}'), /belongs to object store OS2/);
  });
  test('writes outside the root folder are refused', async () => {
    const s = new FileNetStore(env());
    await assert.rejects(s.ensureFolder('/Focus Corp/Other'), /outside FILENET_ROOT_FOLDER/);
    await assert.rejects(s.ensureFolder('/TenderFlowX'), /outside FILENET_ROOT_FOLDER/);
    await assert.rejects(s.put({ tenantId: 'k', folderPath: '../../etc', fileName: 'a', mimeType: 'text/plain', bytes: Buffer.from('a'), properties: {} }), /"\." and "\.\." are not allowed/);
    await assert.rejects(s.put({ tenantId: 'k', folderPath: '/k/a:b', fileName: 'a', mimeType: 'text/plain', bytes: Buffer.from('a'), properties: {} }), /does not allow/);
    assert.equal(fake.graphqlOps('TfCreateFolder').length, 0);
  });
  test('nested root whose parent is missing is not created', async () => {
    const s = new FileNetStore(env({ FILENET_ROOT_FOLDER: '/Shared/TenderFlow' }));
    await assert.rejects(s.ensureFolder('/Shared/TenderFlow/a'), /parent of root folder \(\/Shared\) does not exist/);
    assert.equal(fake.graphqlOps('TfCreateFolder').length, 0);
  });
});

describe('CLI tools against the fake server', () => {
  const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const toolPath = (name: string) => fileURLToPath(new URL(`../src/tools/${name}.${ext}`, import.meta.url));
  const runTool = (name: string, extraEnv: Record<string, string>) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun) => {
    const execArgv = process.execArgv.filter((a) => !a.startsWith('--test'));
    const child = spawn(process.execPath, [...execArgv, toolPath(name)], {
      env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tf-filenet-')); });

  const baseEnv = () => ({
    FILENET_GRAPHQL_URL: fake.url, FILENET_OBJECT_STORE: 'OS1', FILENET_SERVICE_USER: USER, FILENET_SERVICE_PASSWORD: PASSWORD,
    FILENET_DOC_CLASS: 'Document', FILENET_ROOT_FOLDER: '/TenderFlow', FILENET_SET_CUSTOM_PROPERTIES: 'false', TF_EVIDENCE_DIR: dir, TF_ENV_FILE: join(dir, 'no.env'),
  });

  test('verify-filenet passes end-to-end and writes a report without the password', async () => {
    const r = await runTool('verify-filenet', baseEnv());
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /✓ 1 ping object store/);
    assert.match(r.stdout, /✓ 4 download text and compare SHA-256/);
    assert.match(r.stdout, /✓ 5 download 2 MB binary/);
    assert.match(r.stdout, /Navigator path: OS1 > TenderFlow > _verify > verify-text-/);
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(PASSWORD.replace(/[$@]/g, '\\$&')));
    const files = readdirSync(dir).filter((f) => f.startsWith('filenet-verify-'));
    assert.equal(files.length, 1);
    const raw = readFileSync(join(dir, files[0]), 'utf8');
    assert.ok(!raw.includes(PASSWORD));
    const report = JSON.parse(raw);
    assert.equal(report.ok, true);
    assert.equal(report.documents.length, 2);
    assert.ok(fake.folders.has('/TenderFlow/_verify'));
    // Step 8: versioning proof (runs even with FILENET_VERSIONING=false so the flag can be enabled afterwards).
    assert.match(r.stdout, /✓ 8 versioning: create v1 — \{DOC-\d+.*\(version 1\.0\)/);
    assert.match(r.stdout, /✓ 8 versioning: check in v2 as the next major version \(checkout \+ checkin\) — \{RES-\d+.*\(version 2\.0\)/);
    assert.match(r.stdout, /✓ 8 versioning: read v1 and v2 back and compare SHA-256/);
    assert.match(r.stdout, /✓ 8 versioning: describe both versions \(same version series, v2 current\) — series \{VS-\d+.*: 1\.0 → 2\.0/);
    assert.match(r.stdout, /- 9 records declaration check skipped \(FILENET_RECORDS_MODE=none\)/);
    assert.equal(report.versioning.v1Version, '1.0');
    assert.equal(report.versioning.v2Version, '2.0');
    assert.equal(report.versioning.navigatorUrl, null, 'no Navigator URL unless FILENET_NAVIGATOR_URL is set');
  });

  test('verify-filenet proves records declaration (property mode) and prints a Navigator link when configured', async () => {
    fake.classes.add('TF_Document');
    fake.recordProperties = true;
    const r = await runTool('verify-filenet', { ...baseEnv(), FILENET_DOC_CLASS: 'TF_Document', FILENET_SET_CUSTOM_PROPERTIES: 'true', FILENET_RECORDS_MODE: 'property',
      FILENET_NAVIGATOR_URL: 'http://icn.example:9080/navigator' });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /✓ 9 records declaration \(FILENET_RECORDS_MODE=property\) — marked TF_RecordDeclared=true/);
    assert.match(r.stdout, /Navigator link \(format ASSUMED — open it to confirm\): http:\/\/icn\.example:9080\/navigator\/bookmark\.jsp\?desktop=ICN&repositoryId=OS1&repositoryType=p8&docid=TF_Document%2C%7B0E3A1C2B/);
  });

  test('verify-filenet stops at step 8 with the server error when check-in is refused', async () => {
    fake.failCheckin = 'FNRCE0066E: E_ACCESS_DENIED: checkin not permitted';
    const r = await runTool('verify-filenet', baseEnv());
    assert.equal(r.code, 1);
    assert.match(r.stdout, /✗ 8 versioning: check in v2/);
    assert.match(r.stdout, /E_ACCESS_DENIED: checkin not permitted/);
    assert.match(r.stdout, /reservation cancelled/);
  });

  test('verify-filenet with TF_Document + custom properties checks class and properties', async () => {
    fake.classes.add('TF_Document');
    const r = await runTool('verify-filenet', { ...baseEnv(), FILENET_DOC_CLASS: 'TF_Document', FILENET_SET_CUSTOM_PROPERTIES: 'true' });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /✓ 6 document class TF_Document exists/);
    assert.match(r.stdout, /✓ 6 custom TF_\* properties stored — all 5 match/);
  });

  test('verify-filenet exits 1 on first failure with the full GraphQL error', async () => {
    const r = await runTool('verify-filenet', { ...baseEnv(), FILENET_DOC_CLASS: 'TF_Document' });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /✗ 3 upload UTF-8 Arabic \+ English text/);
    assert.match(r.stdout, /FNRCE0051E: E_OBJECT_NOT_FOUND: class TF_Document not found/);
    const report = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8'));
    assert.equal(report.ok, false);
    assert.equal(report.steps.at(-1).ok, false);
  });

  test('verify-filenet exits 1 naming missing configuration', async () => {
    const r = await runTool('verify-filenet', { TF_EVIDENCE_DIR: dir, TF_ENV_FILE: join(dir, 'no.env'), FILENET_GRAPHQL_URL: fake.url });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /missing FILENET_OBJECT_STORE, FILENET_SERVICE_USER, FILENET_SERVICE_PASSWORD/);
  });

  test('filenet-introspect writes a schema dump', async () => {
    const r = await runTool('filenet-introspect', baseEnv());
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const files = readdirSync(dir).filter((f) => f.startsWith('filenet-schema-'));
    assert.equal(files.length, 1);
    const txt = readFileSync(join(dir, files[0]), 'utf8');
    assert.match(txt, /input DocumentPropertiesInput \{\n {2}name: String\n\}/);
    assert.match(txt, /createDocument\(repositoryIdentifier: String!\)/);
    assert.match(txt, /# ContentTransferType: NOT PRESENT/);
    assert.doesNotMatch(txt, /\bother\b/);
    assert.ok(!txt.includes(PASSWORD));
  });
});

test('sanitizeDocumentName replaces FileNet-invalid characters', () => {
  assert.equal(sanitizeDocumentName('a/b:c*?.pdf'), 'a_b_c__.pdf');
  assert.equal(sanitizeDocumentName(''), 'document');
  assert.equal(sanitizeDocumentName('عرض فني.pdf'), 'عرض فني.pdf');
  assert.equal(sanitizeDocumentName('x'.repeat(300) + '.pdf').length, 255);
});
