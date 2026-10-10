// Local fake of the IBM Content Services GraphQL API, for unit tests only (AGENTS.md rule 9: fakes live under
// test/fakes/). It checks request shapes (Basic auth, XSRF header + cookie, multipart layout, folder order,
// download path, check-out/check-in sequence) and answers with responses shaped like the published schema
// (github.com/ibm-ecm/ibm-content-platform-engine-samples, CS-GraphQL-Schema/csgraphql_schema.graphqls).
import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { TF_BASE_PROPERTIES, TF_SUBCLASSES, TF_SUBCLASS_PROPERTIES } from '../../src/content/filenet-model.js';

export const USER = 'svc_tf';
export const PASSWORD = 's3cr3t-P@ss';
export const CTX = '/content-services-graphql';
export const OS_GUID = '{0E3A1C2B-0000-0000-0000-000000000001}';

export interface FakeDoc {
  id: string; name: string; folder: string; cls: string; mime: string; bytes: Buffer; props: Record<string, unknown>; retrievalName: string;
  versionSeriesId: string; major: number; minor: number; isCurrent: boolean; isReserved: boolean; reservation: boolean;
  dateCreated: string; retention: string | null;
  /** Permission list (documentProperties.permissions.replace), null = class default security. */
  acl?: { granteeName: string; accessMask: number }[] | null;
}
export interface Logged { kind: 'graphql' | 'download'; op: string; variables?: any; query?: string; multipart?: { partOrder: string[]; fileField?: string; fileName?: string; fileType?: string }; path: string; cookie: string; xsrfHeader: string }

export class FakeFileNet {
  server = http.createServer((req, res) => { this.handle(req, res).catch((e) => { res.statusCode = 500; res.end(String(e?.stack ?? e)); }); });
  folders = new Set<string>(['/']);
  docs = new Map<string, FakeDoc>();
  log: Logged[] = [];
  classes = new Set<string>(['Document']);
  /** Property templates added to TF_Document by the ACCE runbook §1b (record declaration). */
  recordProperties = false;
  /** Property templates TF_ExpiryDate / TF_AIReviewed added to TF_Document (ACCE runbook §1c, document intelligence). */
  aiProperties = false;
  /** When set, the next createDocument returns this GraphQL error. */
  failCreateDocument: string | null = null;
  /** When set, the next checkinDocument returns this GraphQL error. */
  failCheckin: string | null = null;
  /** Class hierarchy (child → parent) and own property templates, for classDescription.propertyDescriptions. */
  classParents = new Map<string, string>();
  classProps = new Map<string, string[]>();
  /** When true, createDocument / updateDocument refuse properties the class does not define (like the Content Engine). */
  strictProperties = false;
  /** When true, classDescription refuses the propertyDescriptions selection (schema without it). */
  noPropertyDescriptions = false;
  /** When set, createDocument / updateDocument with a permission list fail with this message. */
  failPermissions: string | null = null;
  /** When set, only these grantee names exist in the directory. */
  knownGrantees: Set<string> | null = null;
  /** Status answered for Navigator / ACCE probes, by path (e.g. '/navigator/'); unknown paths answer 404. */
  probeStatus = new Map<string, number>();
  probes: { method: string; path: string; authorization: boolean; cookie: boolean }[] = [];
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
    this.folders = new Set(['/']); this.docs.clear(); this.log = []; this.classes = new Set(['Document']); this.recordProperties = false; this.aiProperties = false;
    this.classParents = new Map(); this.classProps = new Map(); this.strictProperties = false; this.noPropertyDescriptions = false;
    this.failPermissions = null; this.knownGrantees = null; this.probeStatus = new Map(); this.probes = [];
    this.failCreateDocument = null; this.failCheckin = null; this.omitDownloadUrl = false; this.downloadUrlWithoutContext = false; this.folderCreateDelayMs = 0; this.http500Once = false;
  }
  graphqlOps(op?: string) { return this.log.filter((l) => l.kind === 'graphql' && (!op || l.op === op)); }
  env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { FILENET_GRAPHQL_URL: this.url, FILENET_OBJECT_STORE: 'OS1', FILENET_SERVICE_USER: USER, FILENET_SERVICE_PASSWORD: PASSWORD, ...extra };
  }

  private json(res: http.ServerResponse, status: number, body: unknown) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  }
  private newId(kind = 'DOC') { return `{${kind}-${String(++this.seq).padStart(4, '0')}-0000-0000-0000-000000000000}`; }
  private series(vsId: string) { return [...this.docs.values()].filter((d) => d.versionSeriesId === vsId && !d.reservation); }
  private created(d: FakeDoc) {
    return { id: d.id, name: d.name, className: d.cls, majorVersionNumber: d.major, minorVersionNumber: d.minor, versionSeries: { id: d.versionSeriesId } };
  }
  private parseProps(q: string): Record<string, unknown> {
    const props: Record<string, unknown> = {};
    const block = /properties: \[([^\]]*)\]/.exec(q)?.[1];
    if (block) for (const m of block.matchAll(/\{(\w+): ("(?:[^"\\]|\\.)*"|true|false|-?\d+(?:\.\d+)?)\}/g)) props[m[1]] = JSON.parse(m[2]);
    return props;
  }
  /** TF_Document-style test model: base class with properties, subclasses inheriting them (+ own). */
  defineClass(name: string, parent: string, ownProps: string[] = []) {
    this.classes.add(name); this.classParents.set(name, parent); this.classProps.set(name, ownProps);
  }
  /** Properties of a class: system + own + inherited. */
  propertiesOf(cls: string): string[] {
    const out = ['DocumentTitle', 'Id', 'Creator', 'DateCreated', 'IsCurrentVersion'];
    for (let c: string | undefined = cls, i = 0; c && i < 10; c = this.classParents.get(c), i++) out.push(...(this.classProps.get(c) ?? []));
    return [...new Set(out)];
  }
  isA(cls: string, ancestor: string): boolean {
    for (let c: string | undefined = cls, i = 0; c && i < 10; c = this.classParents.get(c), i++) if (c === ancestor) return true;
    return ancestor === 'Document';
  }
  /** Permission list from documentProperties.permissions.replace (null when absent). */
  private parsePerms(q: string): { granteeName: string; accessMask: number }[] | null {
    const block = /permissions: \{ replace: \[(.*?)\] \}/s.exec(q)?.[1];
    if (block === undefined) return null;
    const out: { granteeName: string; accessMask: number }[] = [];
    for (const m of block.matchAll(/\{ type: ACCESS_PERMISSION, subAccessPermission: \{ accessType: ALLOW, inheritableDepth: 0, accessMask: (\d+), granteeName: ("(?:[^"\\]|\\.)*") \} \}/g)) {
      out.push({ accessMask: Number(m[1]), granteeName: JSON.parse(m[2]) });
    }
    return out;
  }
  /** Error text for a write the Content Engine would refuse (unknown property / grantee), or null. */
  private refuseWrite(cls: string, props: Record<string, unknown>, perms: { granteeName: string }[] | null): string | null {
    if (this.strictProperties) {
      const known = this.propertiesOf(cls);
      const bad = Object.keys(props).find((k) => !known.includes(k));
      if (bad) return `FNRCE0051E: E_OBJECT_NOT_FOUND: property ${bad} not found in class ${cls}`;
    }
    if (perms) {
      if (this.failPermissions) return this.failPermissions;
      const bad = this.knownGrantees ? perms.find((p) => !this.knownGrantees!.has(p.granteeName)) : undefined;
      if (bad) return `FNRCE0201E: E_BAD_SECURITY_PRINCIPAL: grantee ${bad.granteeName} not found in the directory`;
    }
    return null;
  }
  private contentPart(q: string, v: any, multipart: Logged['multipart'], file: File | null): string | null {
    if (!multipart || !file) return 'request without multipart content';
    if (multipart.partOrder[0] !== 'graphql') return 'skipped stream: graphql part must be first';
    const contentVar = /subContentTransfer: \{ content: \$(\w+)/.exec(q)?.[1];
    if (!contentVar || contentVar !== multipart.fileField || !(contentVar in v) || v[contentVar] !== null) {
      return `content variable ${contentVar} does not match a form part (${multipart.partOrder.join(',')})`;
    }
    if (!/type: CONTENT_TRANSFER/.test(q)) return 'unexpected content element shape';
    return null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const cookie = String(req.headers.cookie ?? '');
    const xsrfHeader = String(req.headers['ecm-cs-xsrf-token'] ?? '');

    const probePath = new URL(req.url ?? '/', 'http://x').pathname;
    if (/^\/(?:navigator|icn\/navigator|acce)(?:\/|$)/.test(probePath)) {
      this.probes.push({ method: String(req.method), path: probePath, authorization: !!req.headers.authorization, cookie: !!req.headers.cookie });
      const st = this.probeStatus.get(probePath) ?? 404;
      res.statusCode = st;
      if (st >= 300 && st < 400) res.setHeader('Location', '/navigator/login');
      res.end(req.method === 'HEAD' ? undefined : `probe ${st}`);
      return;
    }
    const expected = 'Basic ' + Buffer.from(`${USER}:${PASSWORD}`).toString('base64');
    if (req.headers.authorization !== expected) { res.statusCode = 401; res.setHeader('WWW-Authenticate', 'Basic realm="fn"'); res.end('Unauthorized'); return; }
    const cookieXsrf = /(?:^|;\s*)ECM-CS-XSRF-Token=([^;]+)/.exec(cookie)?.[1];
    if (!xsrfHeader || cookieXsrf !== xsrfHeader) { this.json(res, 403, { errors: [{ message: 'XSRF token missing or mismatched' }] }); return; }
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
    const notFound = (what: string, field: string) => this.json(res, 200, { data: { [field]: null }, errors: [{ message: `FNRCE0051E: E_OBJECT_NOT_FOUND: Requested item not found. ${what}`, path: [field] }] });

    if (q.includes('objectStore(identifier: $os)')) {
      if (v.os !== 'OS1') return this.json(res, 200, { data: { objectStore: null }, errors: [{ message: `FNRCE0051E: E_OBJECT_NOT_FOUND: Requested item not found. Object store ${v.os}` }] });
      return this.json(res, 200, { data: { objectStore: { id: OS_GUID, displayName: 'Focus Corp', symbolicName: 'OS1' } } });
    }
    if (q.includes('folder(repositoryIdentifier: $os, identifier: $root)')) {
      if (!this.folders.has(v.root)) return notFound(`Path ${v.root}`, 'folder');
      const node = (p: string): any => {
        const kids = [...this.folders].filter((f) => f !== p && f.startsWith(p === '/' ? '/' : p + '/') && !f.slice(p.length + 1).includes('/')).sort();
        return {
          name: p.split('/').pop(), pathName: p,
          containedDocuments: { documents: [...this.docs.values()].filter((d) => d.folder === p && d.isCurrent && !d.reservation).map((d) => ({ id: d.id })), pageInfo: { token: null } },
          subFolders: { folders: kids.map(node), pageInfo: { token: null } },
        };
      };
      return this.json(res, 200, { data: { folder: node(v.root) } });
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
      const bad = this.contentPart(q, v, multipart, file);
      if (bad) return this.json(res, 200, { errors: [{ message: bad }] });
      if (!/fileInFolderIdentifier: \$folder/.test(q) || !/checkinAction: \{\}/.test(q)) return this.json(res, 200, { errors: [{ message: 'unexpected createDocument shape' }] });
      if (this.failCreateDocument) { const m = this.failCreateDocument; this.failCreateDocument = null; return this.json(res, 200, { data: { createDocument: null }, errors: [{ message: m, path: ['createDocument'] }] }); }
      if (!this.classes.has(v.cls)) return this.json(res, 200, { data: { createDocument: null }, errors: [{ message: `FNRCE0051E: E_OBJECT_NOT_FOUND: class ${v.cls} not found` }] });
      if (!this.folders.has(v.folder)) return this.json(res, 200, { data: { createDocument: null }, errors: [{ message: `FNRCE0051E: folder ${v.folder} not found` }] });
      const newPerms = this.parsePerms(q);
      const refused = this.refuseWrite(v.cls, this.parseProps(q), newPerms);
      if (refused) return this.json(res, 200, { data: { createDocument: null }, errors: [{ message: refused, path: ['createDocument'] }] });
      for (const d of this.docs.values()) if (d.folder === v.folder && d.name === v.name && d.isCurrent) {
        return this.json(res, 200, { data: { createDocument: null }, errors: [{ message: 'FNRCE0022E: E_NOT_UNIQUE: A uniqueness requirement has been violated. ContainmentName' }] });
      }
      const id = this.newId();
      const d: FakeDoc = {
        id, name: v.name, folder: v.folder, cls: v.cls, mime: v.mime, bytes: Buffer.from(await file!.arrayBuffer()), props: this.parseProps(q), retrievalName: v.name,
        versionSeriesId: this.newId('VS'), major: 1, minor: 0, isCurrent: true, isReserved: false, reservation: false, dateCreated: new Date().toISOString(), retention: null,
        acl: newPerms,
      };
      this.docs.set(id, d);
      return this.json(res, 200, { data: { createDocument: this.created(d) } });
    }
    if (q.includes('checkoutDocument(')) {
      assert.match(q, /checkoutDocument\(repositoryIdentifier: \$os, identifier: \$id\)/);
      const src = this.docs.get(v.id);
      if (!src) return notFound(v.id, 'checkoutDocument');
      if (!src.isCurrent) return this.json(res, 200, { data: { checkoutDocument: null }, errors: [{ message: 'FNRCE0076E: E_NOT_CURRENT_VERSION: the document is not the current version' }] });
      if (src.isReserved) return this.json(res, 200, { data: { checkoutDocument: null }, errors: [{ message: 'FNRCE0062E: E_RESERVATION_EXISTS: the document is already checked out' }] });
      const rid = this.newId('RES');
      this.docs.set(rid, { ...src, id: rid, bytes: Buffer.alloc(0), reservation: true, isCurrent: false, props: { ...src.props }, dateCreated: new Date().toISOString(), retention: null });
      src.isReserved = true;
      return this.json(res, 200, { data: { checkoutDocument: { id: src.id, reservation: { id: rid } } } });
    }
    if (q.includes('checkinDocument(')) {
      const bad = this.contentPart(q, v, multipart, file);
      if (bad) return this.json(res, 200, { errors: [{ message: bad }] });
      if (!/checkinAction: \{ checkinMinorVersion: false \}/.test(q)) return this.json(res, 200, { errors: [{ message: 'expected a major check-in' }] });
      const r = this.docs.get(v.id);
      if (!r || !r.reservation) return notFound(`reservation ${v.id}`, 'checkinDocument');
      if (this.failCheckin) { const m = this.failCheckin; this.failCheckin = null; return this.json(res, 200, { data: { checkinDocument: null }, errors: [{ message: m, path: ['checkinDocument'] }] }); }
      const versions = this.series(r.versionSeriesId);
      const prev = versions.find((d) => d.isCurrent)!;
      prev.isCurrent = false; prev.isReserved = false;
      Object.assign(r, {
        reservation: false, isCurrent: true, isReserved: false, name: v.name, retrievalName: v.name, mime: v.mime,
        bytes: Buffer.from(await file!.arrayBuffer()), props: { ...r.props, ...this.parseProps(q) },
        major: Math.max(...versions.map((d) => d.major)) + 1, minor: 0, dateCreated: new Date().toISOString(),
      });
      return this.json(res, 200, { data: { checkinDocument: this.created(r) } });
    }
    if (q.includes('cancelDocumentCheckout(')) {
      const r = this.docs.get(v.id);
      if (!r || !r.reservation) return notFound(`reservation ${v.id}`, 'cancelDocumentCheckout');
      this.docs.delete(r.id);
      for (const d of this.series(r.versionSeriesId)) d.isReserved = false;
      return this.json(res, 200, { data: { cancelDocumentCheckout: { id: r.id } } });
    }
    if (q.includes('updateDocument(')) {
      const d = this.docs.get(v.id);
      if (!d) return notFound(v.id, 'updateDocument');
      if (q.includes('cmRetentionDate: $until')) {
        if (d.retention && d.retention > v.until) return this.json(res, 200, { data: { updateDocument: null }, errors: [{ message: 'FNRCE0066E: retention date cannot be shortened' }] });
        d.retention = v.until;
        return this.json(res, 200, { data: { updateDocument: { id: d.id, cmRetentionDate: d.retention } } });
      }
      const props = this.parseProps(q);
      const perms = this.parsePerms(q);
      const refused = this.refuseWrite(d.cls, props, perms);
      if (refused) return this.json(res, 200, { data: { updateDocument: null }, errors: [{ message: refused, path: ['updateDocument'] }] });
      if (perms) { d.acl = perms; if (!Object.keys(props).length) return this.json(res, 200, { data: { updateDocument: { id: d.id } } }); }
      if ('TF_RecordDeclared' in props && !(this.recordProperties && this.isA(d.cls, 'TF_Document') && d.cls !== 'Document')) {
        return this.json(res, 200, { data: { updateDocument: null }, errors: [{ message: `FNRCE0051E: E_OBJECT_NOT_FOUND: property TF_RecordDeclared not found in class ${d.cls}` }] });
      }
      // Document-intelligence properties (ACCE runbook §1c): only on TF_Document once the templates exist.
      const ai = Object.keys(props).filter((k) => ['TF_ExpiryDate', 'TF_AIReviewed'].includes(k));
      if (ai.length && !(this.aiProperties && this.isA(d.cls, 'TF_Document') && d.cls !== 'Document')) {
        return this.json(res, 200, { data: { updateDocument: null }, errors: [{ message: `FNRCE0051E: E_OBJECT_NOT_FOUND: property ${ai[0]} not found in class ${d.cls}` }] });
      }
      Object.assign(d.props, props);
      const back = /properties\(includes: \[([^\]]*)\]\)/.exec(q)?.[1]?.match(/"(\w+)"/g)?.map((x) => x.slice(1, -1)) ?? ['TF_RecordDeclared', 'TF_RecordDeclaredAt'];
      return this.json(res, 200, { data: { updateDocument: { id: d.id, properties: back.map((p) => ({ id: p, value: d.props[p] ?? null })) } } });
    }
    if (q.includes('documents(repositoryIdentifier: $os, from: $from, where: $where, pageSize: $n)')) {
      const conds = String(v.where).split(' AND ');
      const ok = (d: FakeDoc) => conds.every((c) => {
        let m = /^(\w+) = '([^']*)'$/.exec(c);
        if (m) return String(m[1] === 'DocumentTitle' ? d.name : d.props[m[1]] ?? '') === m[2];
        m = /^(\w+) = (TRUE|FALSE)$/.exec(c);
        if (m) return m[1] === 'IsCurrentVersion' ? d.isCurrent === (m[2] === 'TRUE') : d.props[m[1]] === (m[2] === 'TRUE');
        m = /^DocumentTitle LIKE '%([^']*)%'$/.exec(c);
        if (m) return d.name.toLowerCase().includes(m[1].toLowerCase());
        throw new Error(`fake CE SQL: unsupported condition ${c}`);
      });
      let hits: FakeDoc[];
      try { hits = [...this.docs.values()].filter((d) => !d.reservation && this.isA(d.cls, v.from) && ok(d)); }
      catch (e: any) { return this.json(res, 200, { data: { documents: null }, errors: [{ message: `FNRCE0002E: E_BAD_SQL: ${e.message}` }] }); }
      const page = hits.slice(0, v.n);
      return this.json(res, 200, { data: { documents: {
        documents: page.map((d) => ({ id: d.id, name: d.name, className: d.cls, majorVersionNumber: d.major, minorVersionNumber: d.minor, dateCreated: d.dateCreated,
          properties: (v.props as string[]).map((p) => ({ id: p, value: p === 'DocumentTitle' ? d.name : d.props[p] ?? null })) })),
        pageInfo: { token: hits.length > page.length ? 'more' : null },
      } } });
    }
    if (q.includes('document(repositoryIdentifier: $os, identifier: $id)')) {
      const d = this.docs.get(v.id);
      if (!d) return this.json(res, 200, { data: { document: null }, errors: [{ message: `FNRCE0051E: E_OBJECT_NOT_FOUND: ${v.id}` }] });
      const ctxPrefix = this.downloadUrlWithoutContext ? '' : CTX;
      const downloadUrl = this.omitDownloadUrl ? null : `${ctxPrefix}/content?repositoryIdentifier=OS1&documentId=${encodeURIComponent(d.id)}&elementSequenceNumber=0`;
      const el = { className: 'ContentTransfer', contentType: d.mime, elementSequenceNumber: 0, contentSize: d.bytes.length, retrievalName: d.retrievalName, downloadUrl };
      const props = (v.props as string[] | undefined)?.map((p) => ({ id: p, value: p === 'DocumentTitle' ? d.name : d.props[p] ?? null })) ?? [];
      const versions = this.series(d.versionSeriesId).sort((a, b) => b.major - a.major)
        .map((x) => ({ id: x.id, majorVersionNumber: x.major, minorVersionNumber: x.minor, isCurrentVersion: x.isCurrent, dateCheckedIn: x.dateCreated }));
      return this.json(res, 200, { data: { document: {
        id: d.id, name: d.name, className: d.cls, majorVersionNumber: d.major, minorVersionNumber: d.minor,
        isCurrentVersion: d.isCurrent, versionStatus: d.isCurrent ? 'RELEASED' : 'SUPERSEDED', isReserved: d.isReserved,
        dateCreated: d.dateCreated, dateCheckedIn: d.dateCreated, creator: USER, mimeType: d.mime,
        ...(q.includes('cmRetentionDate') ? { cmRetentionDate: d.retention } : {}),
        versionSeries: { id: d.versionSeriesId },
        foldersFiledIn: { folders: [{ pathName: d.folder }] }, contentElements: [el], properties: props,
        ...(q.includes('permissions {') ? { permissions: (d.acl ?? [{ granteeName: '#AUTHENTICATED-USERS', accessMask: 131201 }]).map((p) => ({ ...p, accessType: 'ALLOW', permissionSource: d.acl ? 'SOURCE_DIRECT' : 'SOURCE_DEFAULT' })) } : {}),
        versions: { documents: versions },
      } } });
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
      if (q.includes('propertyDescriptions')) {
        if (this.noPropertyDescriptions) return this.json(res, 400, { errors: [{ message: "Validation error of type FieldUndefined: Field 'propertyDescriptions' in type 'ClassDescription' is undefined" }] });
        return this.json(res, 200, { data: { classDescription: { symbolicName: v.cls, propertyDescriptions: this.propertiesOf(v.cls).map((p) => ({ symbolicName: p })) } } });
      }
      return this.json(res, 200, { data: { classDescription: { symbolicName: v.cls, displayName: v.cls } } });
    }
    return this.json(res, 200, { errors: [{ message: `fake server: unhandled operation ${op}` }] });
  }
}

/** Creates the TenderFlow class model of docs/filenet/ACCE-RUNBOOK.md §6 in the fake (base class + five subclasses). */
export function defineTfModel(fake: FakeFileNet, opts: { withOptional?: boolean } = {}) {
  const base = TF_BASE_PROPERTIES.map((p) => p.name);
  const optional = opts.withOptional === false ? [] : ['TF_RecordDeclared', 'TF_RecordDeclaredAt', 'TF_ExpiryDate', 'TF_AIReviewed'];
  fake.defineClass('TF_Document', 'Document', [...base, ...optional]);
  for (const c of TF_SUBCLASSES) fake.defineClass(c, 'TF_Document', (TF_SUBCLASS_PROPERTIES[c] ?? []).map((p) => p.name));
}
