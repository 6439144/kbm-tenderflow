// Tests for FileNetStore against a local fake Content Services GraphQL server.
// The fake checks the request shapes (auth, XSRF header + cookie, multipart layout, folder order, download path)
// and answers with responses shaped like the published CS GraphQL schema.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileNetStore, FileNetError, FileNetConfigError, sanitizeDocumentName } from './filenet-store.js';

const USER = 'svc_tf';
const PASSWORD = 's3cr3t-P@ss';
const CTX = '/content-services-graphql';

interface FakeDoc { id: string; name: string; folder: string; cls: string; mime: string; bytes: Buffer; props: Record<string, string>; retrievalName: string }
interface Logged { kind: 'graphql' | 'download'; op: string; variables?: any; query?: string; multipart?: { partOrder: string[]; fileField?: string; fileName?: string; fileType?: string }; path: string; cookie: string; xsrfHeader: string }

class FakeFileNet {
  server = http.createServer((req, res) => { this.handle(req, res).catch((e) => { res.statusCode = 500; res.end(String(e?.stack ?? e)); }); });
  folders = new Set<string>(['/']);
  docs = new Map<string, FakeDoc>();
  log: Logged[] = [];
  classes = new Set<string>(['Document']);
  /** When set, the next createDocument returns this GraphQL error. */
  failCreateDocument: string | null = null;
  omitDownloadUrl = false;
  downloadUrlWithoutContext = false;
  folderCreateDelayMs = 0;
  http500Once = false;
  url = '';
  private seq = 0;

  async start() {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}${CTX}/graphql`;
  }
  async stop() { await new Promise<void>((r) => this.server.close(() => r())); }
  reset() {
    this.folders = new Set(['/']); this.docs.clear(); this.log = []; this.classes = new Set(['Document']);
    this.failCreateDocument = null; this.omitDownloadUrl = false; this.downloadUrlWithoutContext = false; this.folderCreateDelayMs = 0; this.http500Once = false;
  }
  graphqlOps(op?: string) { return this.log.filter((l) => l.kind === 'graphql' && (!op || l.op === op)); }

  private json(res: http.ServerResponse, status: number, body: unknown) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const cookie = String(req.headers.cookie ?? '');
    const xsrfHeader = String(req.headers['ecm-cs-xsrf-token'] ?? '');

    // Auth: Basic only.
    const expected = 'Basic ' + Buffer.from(`${USER}:${PASSWORD}`).toString('base64');
    if (req.headers.authorization !== expected) { res.statusCode = 401; res.setHeader('WWW-Authenticate', 'Basic realm="fn"'); res.end('Unauthorized'); return; }
    // XSRF: header must be present and equal to the cookie of the same name.
    const cookieXsrf = /(?:^|;\s*)ECM-CS-XSRF-Token=([^;]+)/.exec(cookie)?.[1];
    if (!xsrfHeader || cookieXsrf !== xsrfHeader) { this.json(res, 403, { errors: [{ message: 'XSRF token missing or mismatched' }] }); return; }
    // Session cookie handed out on first request; must be echoed afterwards.
    if (!/LtpaToken2=fake-ltpa/.test(cookie)) res.setHeader('Set-Cookie', ['LtpaToken2=fake-ltpa; Path=/; HttpOnly']);

    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && url.pathname === `${CTX}/content`) {
      this.log.push({ kind: 'download', op: 'content', path: req.url ?? '', cookie, xsrfHeader });
      if (url.searchParams.get('repositoryIdentifier') !== 'OS1') { res.statusCode = 404; res.end('bad repo'); return; }
      const doc = this.docs.get(url.searchParams.get('documentId') ?? '');
      if (!doc || url.searchParams.get('elementSequenceNumber') !== '0') { res.statusCode = 404; res.end('no such content'); return; }
      res.statusCode = 200; res.setHeader('Content-Type', doc.mime); res.end(doc.bytes); return;
    }
    if (req.method !== 'POST' || url.pathname !== `${CTX}/graphql`) { res.statusCode = 404; res.end('not found'); return; }
    if (this.http500Once) { this.http500Once = false; res.statusCode = 500; res.end('<html>Internal Server Error: SRVE0255E</html>'); return; }

    const ct = String(req.headers['content-type'] ?? '');
    let body: { query: string; variables: any };
    let file: File | null = null;
    let multipart: Logged['multipart'];
    if (ct.startsWith('multipart/form-data')) {
      // Order of parts as they appear on the wire.
      const partOrder = [...raw.toString('latin1').matchAll(/Content-Disposition: form-data; name="([^"]+)"/g)].map((m) => m[1]);
      const fd = await new Request('http://x', { method: 'POST', headers: { 'content-type': ct }, body: raw }).formData();
      body = JSON.parse(String(fd.get('graphql')));
      const fileField = partOrder[1];
      const f = fd.get(fileField);
      file = f instanceof File ? f : null;
      multipart = { partOrder, fileField, fileName: file?.name, fileType: file?.type };
    } else if (ct.startsWith('application/json')) {
      body = JSON.parse(raw.toString('utf8'));
    } else { this.json(res, 400, { errors: [{ message: `unsupported content type ${ct}` }] }); return; }

    const op = /^\s*(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? 'anonymous';
    this.log.push({ kind: 'graphql', op, variables: body.variables, query: body.query, multipart, path: req.url ?? '', cookie, xsrfHeader });
    const v = body.variables ?? {};
    const q = body.query;

    if (q.includes('objectStore(identifier: $os)')) {
      if (v.os !== 'OS1') return this.json(res, 200, { data: { objectStore: null }, errors: [{ message: `FNRCE0051E: E_OBJECT_NOT_FOUND: Requested item not found. Object store ${v.os}` }] });
      return this.json(res, 200, { data: { objectStore: { id: '{0E3A1C2B-0000-0000-0000-000000000001}', displayName: 'Focus Corp', symbolicName: 'OS1' } } });
    }
    if (q.includes('folder(repositoryIdentifier: $os, identifier: $path)')) {
      if (!this.folders.has(v.path)) return this.json(res, 200, { data: { folder: null }, errors: [{ message: `FNRCE0051E: E_OBJECT_NOT_FOUND: Requested item not found. Path ${v.path}`, path: ['folder'], extensions: { classification: 'DataFetchingException' } }] });
      return this.json(res, 200, { data: { folder: { id: `{F-${v.path}}`, pathName: v.path } } });
    }
    if (q.includes('createFolder(')) {
      assert.match(q, /folderProperties: \{ name: \$name, parent: \{ identifier: \$parent \} \}/);
      if (this.folderCreateDelayMs) await new Promise((r) => setTimeout(r, this.folderCreateDelayMs));
      if (!this.folders.has(v.parent)) return this.json(res, 200, { data: { createFolder: null }, errors: [{ message: `FNRCE0051E: E_OBJECT_NOT_FOUND: parent ${v.parent}` }] });
      const full = (v.parent === '/' ? '' : v.parent) + '/' + v.name;
      if (this.folders.has(full)) return this.json(res, 200, { data: { createFolder: null }, errors: [{ message: 'FNRCE0022E: E_NOT_UNIQUE: A uniqueness requirement has been violated.' }] });
      this.folders.add(full);
      return this.json(res, 200, { data: { createFolder: { id: `{F-${full}}`, pathName: full } } });
    }
    if (q.includes('createDocument(')) {
      if (!multipart || !file) return this.json(res, 200, { errors: [{ message: 'createDocument without multipart content' }] });
      if (multipart.partOrder[0] !== 'graphql') return this.json(res, 200, { errors: [{ message: 'skipped stream: graphql part must be first' }] });
      const contentVar = /subContentTransfer: \{ content: \$(\w+)/.exec(q)?.[1];
      if (!contentVar || contentVar !== multipart.fileField || !(contentVar in v) || v[contentVar] !== null) {
        return this.json(res, 200, { errors: [{ message: `content variable ${contentVar} does not match a form part (${multipart.partOrder.join(',')})` }] });
      }
      if (!/type: CONTENT_TRANSFER/.test(q) || !/fileInFolderIdentifier: \$folder/.test(q) || !/checkinAction: \{\}/.test(q)) {
        return this.json(res, 200, { errors: [{ message: 'unexpected createDocument shape' }] });
      }
      if (this.failCreateDocument) { const m = this.failCreateDocument; this.failCreateDocument = null; return this.json(res, 200, { data: { createDocument: null }, errors: [{ message: m, path: ['createDocument'] }] }); }
      if (!this.classes.has(v.cls)) return this.json(res, 200, { data: { createDocument: null }, errors: [{ message: `FNRCE0051E: E_OBJECT_NOT_FOUND: class ${v.cls} not found` }] });
      if (!this.folders.has(v.folder)) return this.json(res, 200, { data: { createDocument: null }, errors: [{ message: `FNRCE0051E: folder ${v.folder} not found` }] });
      for (const d of this.docs.values()) if (d.folder === v.folder && d.name === v.name) {
        return this.json(res, 200, { data: { createDocument: null }, errors: [{ message: 'FNRCE0022E: E_NOT_UNIQUE: A uniqueness requirement has been violated. ContainmentName' }] });
      }
      const props: Record<string, string> = {};
      const propsBlock = /properties: \[([^\]]*)\]/.exec(q)?.[1];
      if (propsBlock) for (const m of propsBlock.matchAll(/\{(\w+): ("(?:[^"\\]|\\.)*")\}/g)) props[m[1]] = JSON.parse(m[2]);
      const id = `{DOC-${String(++this.seq).padStart(4, '0')}-0000-0000-0000-000000000000}`;
      this.docs.set(id, { id, name: v.name, folder: v.folder, cls: v.cls, mime: v.mime, bytes: Buffer.from(await file.arrayBuffer()), props, retrievalName: v.name });
      return this.json(res, 200, { data: { createDocument: { id, name: v.name, className: v.cls } } });
    }
    if (q.includes('document(repositoryIdentifier: $os, identifier: $id)')) {
      const d = this.docs.get(v.id);
      if (!d) return this.json(res, 200, { data: { document: null }, errors: [{ message: `FNRCE0051E: E_OBJECT_NOT_FOUND: ${v.id}` }] });
      const ctxPrefix = this.downloadUrlWithoutContext ? '' : CTX;
      const downloadUrl = this.omitDownloadUrl ? null : `${ctxPrefix}/content?repositoryIdentifier=OS1&documentId=${encodeURIComponent(d.id)}&elementSequenceNumber=0`;
      const el = { className: 'ContentTransfer', contentType: d.mime, elementSequenceNumber: 0, contentSize: d.bytes.length, retrievalName: d.retrievalName, downloadUrl };
      const props = (v.props as string[] | undefined)?.map((p) => ({ id: p, value: p === 'DocumentTitle' ? d.name : d.props[p] ?? null })) ?? [];
      return this.json(res, 200, { data: { document: { id: d.id, name: d.name, className: d.cls, majorVersionNumber: 1, minorVersionNumber: 0, foldersFiledIn: { folders: [{ pathName: d.folder }] }, contentElements: [el], properties: props } } });
    }
    if (q.includes('__type(name: $name)')) {
      const S = (name: string) => ({ kind: 'SCALAR', name, ofType: null });
      const NN = (t: any) => ({ kind: 'NON_NULL', name: null, ofType: t });
      if (v.name === 'Query' || v.name === 'Mutation') {
        const names = v.name === 'Query' ? ['objectStore', 'folder', 'document', 'classDescription', '_apiInfo', 'other'] : ['createDocument', 'createFolder', 'fileDocument'];
        return this.json(res, 200, { data: { __type: { kind: 'OBJECT', name: v.name, description: null, inputFields: null, enumValues: null, possibleTypes: null, interfaces: [],
          fields: names.map((n) => ({ name: n, args: [{ name: 'repositoryIdentifier', type: NN(S('String')) }], type: { kind: 'OBJECT', name: 'X', ofType: null } })) } } });
      }
      if (v.name === 'ContentTransferType') return this.json(res, 200, { data: { __type: null } });
      return this.json(res, 200, { data: { __type: { kind: 'INPUT_OBJECT', name: v.name, description: 'd', inputFields: [{ name: 'name', type: S('String'), defaultValue: null }], fields: null, enumValues: null, possibleTypes: null, interfaces: null } } });
    }
    if (q.includes('_apiInfo(')) return this.json(res, 200, { data: { _apiInfo: { productVersion: '5.6.0', implementationVersion: 'fake', buildNumber: '1', buildDate: 'today' } } });
    if (q.includes('classDescription(')) {
      if (!this.classes.has(v.cls)) return this.json(res, 200, { data: { classDescription: null }, errors: [{ message: `FNRCE0051E: E_OBJECT_NOT_FOUND: class ${v.cls}` }] });
      return this.json(res, 200, { data: { classDescription: { symbolicName: v.cls, displayName: v.cls } } });
    }
    return this.json(res, 200, { errors: [{ message: `fake server: unhandled operation ${op}` }] });
  }
}

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
  const toolPath = (name: string) => fileURLToPath(new URL(`../tools/${name}.${ext}`, import.meta.url));
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
