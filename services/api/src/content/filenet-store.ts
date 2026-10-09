// FileNet Content Services GraphQL content store.
//
// Every GraphQL shape used here is taken from the published schema
// (github.com/ibm-ecm/ibm-content-platform-engine-samples/CS-GraphQL-Schema/csgraphql_schema.graphqls),
// IBM's CS-GraphQL-javascript-samples, the IBM community article on content upload/download, and the live
// mutation list in docs/evidence/G2-b/mutations.txt. The few points that are NOT confirmed by those sources
// are isolated in the FILENET_PROTOCOL constant below so they can be changed in one place; the verify CLI
// (src/tools/verify-filenet.ts) prints the server's exact error text when one of them is wrong.
//
// Rules: no silent fallbacks, no fake success. Every failure throws (ping() reports ok:false with the reason).
// Writes are confined to FILENET_ROOT_FOLDER (default /TenderFlow) in the shared object store.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ContentStore, ContentStoreUnavailableError, StoredObject } from './types.js';

/** Protocol details. Items marked ASSUMED are not stated by the published schema/docs. */
export const FILENET_PROTOCOL = {
  /** Multipart form part carrying {query, variables} (IBM community article: `-F graphql='...'`). */
  multipartQueryPart: 'graphql',
  /** GraphQL variable (and multipart file part name) holding content (IBM article uses `contvar`). */
  contentVariable: 'contvar',
  /** XSRF header and cookie name (IBM article + samples). Same random value sent as header and cookie. */
  xsrfName: 'ECM-CS-XSRF-Token',
  /** Fallback download endpoint, relative to the GraphQL context root (IBM article). */
  contentEndpointPath: '/content',
  /** ASSUMED: error text that means "object does not exist" (CE: FNRCE0051E E_OBJECT_NOT_FOUND). */
  notFoundPattern: /FNRCE0051|E_OBJECT_NOT_FOUND|not\s+found|does\s+not\s+exist|could\s+not\s+be\s+found/i,
  /** ASSUMED: error text that means "name already used in this folder" (CE: FNRCE0022E E_NOT_UNIQUE). */
  notUniquePattern: /FNRCE0022|E_NOT_UNIQUE|uniqueness requirement|already exists|not unique/i,
} as const;

/** Custom property symbolic names (created in ACCE, see docs/filenet/ACCE-RUNBOOK.md). */
export const TF_PROPERTY_NAMES = ['TF_TenantId', 'TF_TenderId', 'TF_VendorId', 'TF_DocType', 'TF_Sha256'] as const;
export type TfPropertyName = (typeof TF_PROPERTY_NAMES)[number];
const TF_PROPERTY_MAX_LENGTH = 64;

/** Characters FileNet does not allow in folder names / containment names. */
const INVALID_NAME_CHARS = /[\\/:*?"<>|]/;
const INVALID_NAME_CHARS_GLOBAL = /[\\/:*?"<>|]/g;

export class FileNetError extends ContentStoreUnavailableError {
  constructor(message: string, readonly graphqlErrors?: unknown[], readonly httpStatus?: number) {
    super(message);
    this.name = 'FileNetError';
  }
}

export class FileNetConfigError extends Error {
  code = 'FILENET_CONFIG';
  constructor(message: string) { super(message); this.name = 'FileNetConfigError'; }
}

export interface FileNetConfig {
  graphqlUrl: string;
  objectStore: string;
  user: string;
  password: string;
  docClass: string;
  rootFolder: string;
  setCustomProperties: boolean;
  timeoutMs: number;
}

export interface FileNetDocumentInfo {
  id: string;
  name: string | null;
  className: string;
  majorVersionNumber: number | null;
  minorVersionNumber: number | null;
  folders: string[];
  contentElements: { contentType: string; elementSequenceNumber: number; contentSize?: number | null; retrievalName?: string | null; downloadUrl?: string | null }[];
  properties: Record<string, unknown>;
}

interface GraphQLResponse { data?: Record<string, any> | null; errors?: any[] }

const REQUIRED_ENV = ['FILENET_GRAPHQL_URL', 'FILENET_OBJECT_STORE', 'FILENET_SERVICE_USER', 'FILENET_SERVICE_PASSWORD'] as const;

/** Reads and validates FileNet configuration. Throws FileNetConfigError naming every missing/invalid variable. */
export function loadFileNetConfig(env: NodeJS.ProcessEnv = process.env): FileNetConfig {
  const missing = REQUIRED_ENV.filter((k) => !env[k] || !String(env[k]).trim());
  if (missing.length) {
    throw new FileNetConfigError(`FileNet content store is not configured: missing ${missing.join(', ')}`);
  }
  const graphqlUrl = String(env.FILENET_GRAPHQL_URL).trim();
  let parsed: URL;
  try { parsed = new URL(graphqlUrl); } catch {
    throw new FileNetConfigError(`FILENET_GRAPHQL_URL is not a valid URL: ${graphqlUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new FileNetConfigError(`FILENET_GRAPHQL_URL must be http(s): ${graphqlUrl}`);
  }
  if (parsed.username || parsed.password) {
    throw new FileNetConfigError('FILENET_GRAPHQL_URL must not contain credentials; use FILENET_SERVICE_USER / FILENET_SERVICE_PASSWORD');
  }
  const rootFolder = normalizeAbsolutePath(env.FILENET_ROOT_FOLDER?.trim() || '/TenderFlow', 'FILENET_ROOT_FOLDER');
  if (rootFolder === '/') throw new FileNetConfigError('FILENET_ROOT_FOLDER must not be "/" (the object store is shared)');
  const spRaw = (env.FILENET_SET_CUSTOM_PROPERTIES ?? 'false').trim().toLowerCase();
  if (!['true', 'false', '1', '0', 'yes', 'no', ''].includes(spRaw)) {
    throw new FileNetConfigError(`FILENET_SET_CUSTOM_PROPERTIES must be true or false (got "${env.FILENET_SET_CUSTOM_PROPERTIES}")`);
  }
  const timeoutMs = env.FILENET_TIMEOUT_MS ? Number(env.FILENET_TIMEOUT_MS) : 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new FileNetConfigError('FILENET_TIMEOUT_MS must be a positive number');
  return {
    graphqlUrl,
    objectStore: String(env.FILENET_OBJECT_STORE).trim(),
    user: String(env.FILENET_SERVICE_USER),
    password: String(env.FILENET_SERVICE_PASSWORD),
    docClass: env.FILENET_DOC_CLASS?.trim() || 'Document',
    rootFolder,
    setCustomProperties: ['true', '1', 'yes'].includes(spRaw),
    timeoutMs,
  };
}

function normalizeAbsolutePath(p: string, label: string): string {
  const segs = splitSegments(p, label);
  return '/' + segs.join('/');
}

function splitSegments(p: string, label: string): string[] {
  const segs = p.split('/').map((s) => s.trim()).filter((s) => s.length > 0);
  for (const s of segs) {
    if (s === '.' || s === '..') throw new FileNetConfigError(`${label}: "." and ".." are not allowed in folder paths (${p})`);
    if (INVALID_NAME_CHARS.test(s)) throw new FileNetConfigError(`${label}: folder name "${s}" contains a character FileNet does not allow (\\ / : * ? " < > |)`);
  }
  return segs;
}

/** GraphQL string literal (JSON string syntax is valid GraphQL string syntax). */
const gqlString = (v: string) => JSON.stringify(v);

export class FileNetStore implements ContentStore {
  type = 'filenet' as const;
  readonly config: FileNetConfig;
  private readonly authHeader: string;
  private readonly xsrfToken = randomUUID();
  private readonly cookieJar = new Map<string, string>();
  private readonly knownFolders = new Set<string>();
  private readonly folderInFlight = new Map<string, Promise<void>>();

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.config = loadFileNetConfig(env);
    this.authHeader = 'Basic ' + Buffer.from(`${this.config.user}:${this.config.password}`, 'utf8').toString('base64');
  }

  // ---------------------------------------------------------------- HTTP plumbing

  private cookieHeader(): string {
    const parts = [`${FILENET_PROTOCOL.xsrfName}=${this.xsrfToken}`];
    for (const [k, v] of this.cookieJar) if (k !== FILENET_PROTOCOL.xsrfName) parts.push(`${k}=${v}`);
    return parts.join('; ');
  }

  private baseHeaders(): Record<string, string> {
    return {
      Authorization: this.authHeader,
      [FILENET_PROTOCOL.xsrfName]: this.xsrfToken,
      Cookie: this.cookieHeader(),
    };
  }

  private captureCookies(res: Response): void {
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    let lines: string[] = [];
    if (typeof h.getSetCookie === 'function') lines = h.getSetCookie();
    else {
      const raw = res.headers.get('set-cookie');
      if (raw) lines = raw.split(/,(?=\s*[A-Za-z0-9_\-.]+=)/);
    }
    for (const line of lines) {
      const first = line.split(';')[0];
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (name === FILENET_PROTOCOL.xsrfName) continue; // we own the XSRF value
      if (/max-age=0\b/i.test(line) || value === '') this.cookieJar.delete(name);
      else this.cookieJar.set(name, value);
    }
  }

  private async send(url: string, init: RequestInit, what: string): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(this.config.timeoutMs) });
    } catch (e: any) {
      const cause = e?.cause?.code || e?.cause?.message || e?.name || '';
      throw new FileNetError(`FileNet ${what}: cannot reach ${new URL(url).origin} (${e?.message ?? e}${cause ? `; ${cause}` : ''})`);
    }
    this.captureCookies(res);
    return res;
  }

  private async readErrorBody(res: Response): Promise<string> {
    try { return (await res.text()).slice(0, 2000); } catch { return ''; }
  }

  /**
   * Executes a GraphQL operation. With `upload`, sends a multipart form: part `graphql` first
   * (JSON {query, variables}), then the file part named after the content variable.
   * Throws FileNetError with the server's full error text on HTTP or GraphQL errors.
   */
  async graphql<T = any>(query: string, variables: Record<string, unknown> = {}, upload?: { bytes: Buffer; fileName: string; mimeType: string }): Promise<T> {
    const what = (query.match(/^\s*(query|mutation)\s+(\w+)/)?.[2]) ?? 'request';
    let res: Response;
    if (upload) {
      const form = new FormData();
      const cv = FILENET_PROTOCOL.contentVariable;
      form.append(FILENET_PROTOCOL.multipartQueryPart, JSON.stringify({ query, variables: { ...variables, [cv]: null } }));
      form.append(cv, new Blob([upload.bytes], { type: upload.mimeType || 'application/octet-stream' }), upload.fileName);
      res = await this.send(this.config.graphqlUrl, { method: 'POST', headers: { ...this.baseHeaders(), Accept: 'application/json' }, body: form }, what);
    } else {
      res = await this.send(this.config.graphqlUrl, {
        method: 'POST',
        headers: { ...this.baseHeaders(), 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
      }, what);
    }
    if (res.status >= 300 && res.status < 400) {
      throw new FileNetError(`FileNet ${what}: HTTP ${res.status} redirect to ${res.headers.get('location') ?? '?'} (check FILENET_GRAPHQL_URL; authentication may be redirecting to a login page)`, undefined, res.status);
    }
    let text: string;
    try { text = await res.text(); } catch (e: any) {
      throw new FileNetError(`FileNet ${what}: failed reading response (${e?.message ?? e})`, undefined, res.status);
    }
    if (!res.ok) {
      // GraphQL servers may answer 4xx/5xx with a JSON errors body; surface it verbatim.
      let detail = text.slice(0, 4000);
      let gqlErrors: unknown[] | undefined;
      try { const j = JSON.parse(text); if (Array.isArray(j?.errors)) { gqlErrors = j.errors; detail = formatGraphQLErrors(j.errors); } } catch { /* not JSON */ }
      throw new FileNetError(`FileNet ${what}: HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`, gqlErrors, res.status);
    }
    return this.parseGraphQL<T>(text, what);
  }

  private parseGraphQL<T>(text: string, what: string): T {
    let json: GraphQLResponse;
    try { json = JSON.parse(text); } catch {
      throw new FileNetError(`FileNet ${what}: response is not JSON: ${text.slice(0, 500)}`);
    }
    if (json.errors && json.errors.length) {
      throw new FileNetError(`FileNet ${what}: GraphQL error: ${formatGraphQLErrors(json.errors)}`, json.errors);
    }
    if (!json.data) throw new FileNetError(`FileNet ${what}: response has no data`);
    return json.data as T;
  }

  // ---------------------------------------------------------------- ContentStore

  async ping(): Promise<{ ok: boolean; detail: string }> {
    try {
      const data = await this.graphql<{ objectStore: { id: string; displayName: string | null; symbolicName: string | null } | null }>(
        `query TfPing($os: String!) { objectStore(identifier: $os) { id displayName symbolicName } }`,
        { os: this.config.objectStore },
      );
      const os = data.objectStore;
      if (!os) return { ok: false, detail: `FileNet object store ${this.config.objectStore} not returned by ${this.endpointLabel()}` };
      return { ok: true, detail: `FileNet object store ${os.symbolicName ?? this.config.objectStore} ("${os.displayName ?? ''}", id ${os.id}) at ${this.endpointLabel()}` };
    } catch (e: any) {
      return { ok: false, detail: e?.message ?? String(e) };
    }
  }

  async put(input: { tenantId: string; folderPath: string; fileName: string; mimeType: string; bytes: Buffer; properties: Record<string, string> }): Promise<StoredObject> {
    if (!Buffer.isBuffer(input.bytes)) throw new FileNetError('FileNet put: bytes must be a Buffer');
    const folder = this.resolveFolder(input.folderPath);
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const props = this.config.setCustomProperties ? this.buildCustomProperties(input.tenantId, input.properties ?? {}, sha256) : null;
    await this.ensureFolder(folder);

    const name = sanitizeDocumentName(input.fileName);
    let created: { id: string };
    try {
      created = await this.createDocument(folder, name, input, props);
    } catch (e: any) {
      // Same containment name already filed in this folder: store under a unique name (the document is real;
      // TenderFlow references it by id, never by name).
      if (!(e instanceof FileNetError) || !FILENET_PROTOCOL.notUniquePattern.test(e.message)) throw e;
      created = await this.createDocument(folder, uniquifyName(name), input, props);
    }
    return { storeRef: `filenet:${this.config.objectStore}:${created.id}`, storeType: 'filenet', byteSize: input.bytes.length };
  }

  async get(storeRef: string): Promise<Buffer> {
    const { id } = this.parseStoreRef(storeRef);
    const data = await this.graphql<{ document: { id: string; contentElements: any[] | null } | null }>(
      `query TfGetContent($os: String!, $id: String!) {
        document(repositoryIdentifier: $os, identifier: $id) {
          id
          contentElements { className contentType elementSequenceNumber ... on ContentTransfer { contentSize retrievalName downloadUrl } }
        }
      }`,
      { os: this.config.objectStore, id },
    );
    if (!data.document) throw new FileNetError(`FileNet get: document ${id} not found in ${this.config.objectStore}`);
    const elements = data.document.contentElements ?? [];
    if (!elements.length) throw new FileNetError(`FileNet get: document ${id} has no content elements`);
    const el = elements.find((e) => e.elementSequenceNumber === 0) ?? elements[0];
    const url = el.downloadUrl
      ? this.resolveServerUrl(el.downloadUrl)
      : this.contentEndpointUrl(id, el.elementSequenceNumber ?? 0);
    const res = await this.send(url, { method: 'GET', headers: { ...this.baseHeaders(), Accept: '*/*' } }, 'download');
    if (!res.ok) {
      throw new FileNetError(`FileNet download of ${id}: HTTP ${res.status} ${res.statusText} from ${new URL(url).pathname} — ${await this.readErrorBody(res)}`, undefined, res.status);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (typeof el.contentSize === 'number' && el.contentSize !== buf.length) {
      throw new FileNetError(`FileNet download of ${id}: got ${buf.length} bytes but content element reports ${el.contentSize}`);
    }
    return buf;
  }

  // ---------------------------------------------------------------- folders

  /** Absolute FileNet folder for a TenderFlow-relative folder path (always under the root folder). */
  resolveFolder(folderPath: string): string {
    const segs = splitSegments(folderPath ?? '', 'folderPath');
    return segs.length ? `${this.config.rootFolder}/${segs.join('/')}` : this.config.rootFolder;
  }

  /**
   * Ensures an absolute folder path under FILENET_ROOT_FOLDER exists, creating missing segments top-down.
   * The root folder itself may be created (under its parent, which must already exist); nothing above it is.
   */
  async ensureFolder(path: string): Promise<void> {
    const abs = normalizeAbsolutePath(path, 'ensureFolder');
    const root = this.config.rootFolder;
    if (abs !== root && !abs.startsWith(root + '/')) {
      throw new FileNetError(`FileNet ensureFolder: ${abs} is outside FILENET_ROOT_FOLDER ${root}; refusing to write there`);
    }
    if (this.knownFolders.has(abs)) return;
    const rootSegs = root.split('/').filter(Boolean);
    const segs = abs.split('/').filter(Boolean);
    let parent = '/' + rootSegs.slice(0, -1).join('/');
    if (parent !== '/' && !this.knownFolders.has(parent)) {
      if (!(await this.folderExists(parent))) {
        throw new FileNetError(`FileNet ensureFolder: parent of root folder (${parent}) does not exist; create ${root} in ACCE first`);
      }
      this.knownFolders.add(parent);
    }
    for (let i = rootSegs.length - 1; i < segs.length; i++) {
      const current = '/' + segs.slice(0, i + 1).join('/');
      await this.ensureOne(parent, segs[i], current);
      parent = current;
    }
  }

  private ensureOne(parent: string, name: string, full: string): Promise<void> {
    if (this.knownFolders.has(full)) return Promise.resolve();
    const pending = this.folderInFlight.get(full);
    if (pending) return pending;
    const p = (async () => {
      if (await this.folderExists(full)) { this.knownFolders.add(full); return; }
      try {
        await this.graphql(
          `mutation TfCreateFolder($os: String!, $name: String!, $parent: String!) {
            createFolder(repositoryIdentifier: $os, folderProperties: { name: $name, parent: { identifier: $parent } }) { id pathName }
          }`,
          { os: this.config.objectStore, name, parent },
        );
      } catch (e: any) {
        // Created concurrently by another process: accept only if it now really exists.
        if (!(e instanceof FileNetError) || !FILENET_PROTOCOL.notUniquePattern.test(e.message) || !(await this.folderExists(full))) throw e;
      }
      this.knownFolders.add(full);
    })().finally(() => this.folderInFlight.delete(full));
    this.folderInFlight.set(full, p);
    return p;
  }

  async folderExists(path: string): Promise<boolean> {
    try {
      const data = await this.graphql<{ folder: { id: string; pathName: string | null } | null }>(
        `query TfFolder($os: String!, $path: String!) { folder(repositoryIdentifier: $os, identifier: $path) { id pathName } }`,
        { os: this.config.objectStore, path },
      );
      return !!data.folder;
    } catch (e: any) {
      if (e instanceof FileNetError && e.graphqlErrors && FILENET_PROTOCOL.notFoundPattern.test(e.message)) return false;
      throw e;
    }
  }

  // ---------------------------------------------------------------- documents

  private async createDocument(
    folder: string,
    name: string,
    input: { fileName: string; mimeType: string; bytes: Buffer },
    props: Record<TfPropertyName, string> | null,
  ): Promise<{ id: string }> {
    const cv = FILENET_PROTOCOL.contentVariable;
    // PropertyIdentifierAndScalarValue is a custom scalar written as {SymbolicName: value} (IBM samples);
    // inlined as literals exactly like IBM's samples, values escaped as GraphQL strings.
    const propsLiteral = props
      ? `properties: [${Object.entries(props).map(([k, v]) => `{${k}: ${gqlString(v)}}`).join(' ')}]`
      : '';
    const query = `mutation TfCreateDocument($os: String!, $cls: String!, $folder: String!, $name: String!, $mime: String!, $${cv}: String) {
      createDocument(
        repositoryIdentifier: $os
        classIdentifier: $cls
        fileInFolderIdentifier: $folder
        checkinAction: {}
        documentProperties: {
          name: $name
          ${propsLiteral}
          contentElements: { replace: [{ type: CONTENT_TRANSFER, contentType: $mime, subContentTransfer: { content: $${cv}, retrievalName: $name } }] }
        }
      ) { id name className }
    }`;
    const data = await this.graphql<{ createDocument: { id: string; name: string | null; className: string } | null }>(
      query,
      { os: this.config.objectStore, cls: this.config.docClass, folder, name, mime: input.mimeType || 'application/octet-stream' },
      { bytes: input.bytes, fileName: name, mimeType: input.mimeType },
    );
    if (!data.createDocument?.id) throw new FileNetError('FileNet createDocument: server returned no document id');
    return { id: data.createDocument.id };
  }

  private buildCustomProperties(tenantId: string, p: Record<string, string>, sha256: string): Record<TfPropertyName, string> {
    const pick = (...keys: string[]) => keys.map((k) => p[k]).find((v) => v !== undefined && v !== null && String(v) !== '');
    const out: Partial<Record<TfPropertyName, string>> = {
      TF_TenantId: pick('TF_TenantId') ?? tenantId,
      TF_TenderId: pick('TF_TenderId', 'tenderId'),
      TF_VendorId: pick('TF_VendorId', 'vendorId'),
      TF_DocType: pick('TF_DocType', 'docType'),
      TF_Sha256: sha256,
    };
    const result: Record<string, string> = {};
    for (const k of TF_PROPERTY_NAMES) {
      const v = out[k];
      if (v === undefined || v === null || String(v) === '') continue;
      const s = String(v);
      if (s.length > TF_PROPERTY_MAX_LENGTH) throw new FileNetError(`FileNet put: ${k} value is longer than ${TF_PROPERTY_MAX_LENGTH} characters`);
      result[k] = s;
    }
    return result as Record<TfPropertyName, string>;
  }

  /** Reads document metadata (used by the verify CLI). */
  async describeDocument(storeRefOrId: string, propertyNames: string[] = []): Promise<FileNetDocumentInfo> {
    const id = storeRefOrId.startsWith('filenet:') ? this.parseStoreRef(storeRefOrId).id : storeRefOrId;
    const data = await this.graphql<{ document: any }>(
      `query TfDescribe($os: String!, $id: String!, $props: [String!]) {
        document(repositoryIdentifier: $os, identifier: $id) {
          id name className majorVersionNumber minorVersionNumber
          foldersFiledIn { folders { pathName } }
          contentElements { contentType elementSequenceNumber ... on ContentTransfer { contentSize retrievalName downloadUrl } }
          properties(includes: $props) { id value }
        }
      }`,
      { os: this.config.objectStore, id, props: propertyNames.length ? propertyNames : ['DocumentTitle'] },
    );
    const d = data.document;
    if (!d) throw new FileNetError(`FileNet describeDocument: ${id} not found`);
    const properties: Record<string, unknown> = {};
    for (const p of d.properties ?? []) properties[p.id] = p.value;
    return {
      id: d.id, name: d.name ?? null, className: d.className,
      majorVersionNumber: d.majorVersionNumber ?? null, minorVersionNumber: d.minorVersionNumber ?? null,
      folders: (d.foldersFiledIn?.folders ?? []).map((f: any) => f.pathName).filter(Boolean),
      contentElements: d.contentElements ?? [],
      properties,
    };
  }

  /** True if the document class exists in the object store (classDescription query). */
  async classExists(symbolicName: string): Promise<boolean> {
    try {
      const data = await this.graphql<{ classDescription: { symbolicName: string } | null }>(
        `query TfClass($os: String!, $cls: String!) { classDescription(repositoryIdentifier: $os, identifier: $cls) { symbolicName displayName } }`,
        { os: this.config.objectStore, cls: symbolicName },
      );
      return !!data.classDescription;
    } catch (e: any) {
      if (e instanceof FileNetError && e.graphqlErrors && FILENET_PROTOCOL.notFoundPattern.test(e.message)) return false;
      throw e;
    }
  }

  // ---------------------------------------------------------------- helpers

  parseStoreRef(storeRef: string): { objectStore: string; id: string } {
    const m = /^filenet:([^:]+):(.+)$/.exec(storeRef ?? '');
    if (!m) throw new FileNetError(`FileNet: invalid storeRef "${storeRef}" (expected filenet:<objectStore>:<documentId>)`);
    if (m[1] !== this.config.objectStore) {
      throw new FileNetError(`FileNet: storeRef ${storeRef} belongs to object store ${m[1]}, but this store is configured for ${this.config.objectStore}`);
    }
    return { objectStore: m[1], id: m[2] };
  }

  /** Context root of the GraphQL app, e.g. "/content-services-graphql". */
  private contextRoot(): string {
    const p = new URL(this.config.graphqlUrl).pathname.replace(/\/+$/, '');
    return p.replace(/\/graphql$/, '');
  }

  /** Resolves a server-relative downloadUrl. If it lacks the context root, the context root is prefixed. */
  resolveServerUrl(downloadUrl: string): string {
    if (/^https?:\/\//i.test(downloadUrl)) {
      const u = new URL(downloadUrl);
      const base = new URL(this.config.graphqlUrl);
      if (u.origin !== base.origin) throw new FileNetError(`FileNet: downloadUrl points to a different server (${u.origin}); refusing to send credentials there`);
      return u.toString();
    }
    const ctx = this.contextRoot();
    let path = downloadUrl.startsWith('/') ? downloadUrl : '/' + downloadUrl;
    if (ctx && !(path === ctx || path.startsWith(ctx + '/') || path.startsWith(ctx + '?'))) path = ctx + path;
    return new URL(path, this.config.graphqlUrl).toString();
  }

  contentEndpointUrl(documentId: string, elementSequenceNumber = 0): string {
    const q = new URLSearchParams({ repositoryIdentifier: this.config.objectStore, documentId, elementSequenceNumber: String(elementSequenceNumber) });
    return new URL(`${this.contextRoot()}${FILENET_PROTOCOL.contentEndpointPath}?${q}`, this.config.graphqlUrl).toString();
  }

  private endpointLabel(): string {
    const u = new URL(this.config.graphqlUrl);
    return `${u.origin}${u.pathname}`;
  }
}

export function formatGraphQLErrors(errors: any[]): string {
  return errors.map((e) => {
    const msg = typeof e?.message === 'string' ? e.message : JSON.stringify(e);
    const ext = e?.extensions ? ` ${JSON.stringify(e.extensions)}` : '';
    const path = Array.isArray(e?.path) ? ` (path: ${e.path.join('.')})` : '';
    return `${msg}${path}${ext}`;
  }).join(' | ');
}

/** Document title / retrieval name: FileNet-invalid characters replaced with "_", max 255 chars. */
export function sanitizeDocumentName(fileName: string): string {
  let n = String(fileName ?? '').replace(INVALID_NAME_CHARS_GLOBAL, '_').replace(/[\u0000-\u001f]/g, '').trim();
  if (!n || n === '.' || n === '..') n = 'document';
  if (n.length > 255) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 16 ? n.slice(dot) : '';
    n = n.slice(0, 255 - ext.length) + ext;
  }
  return n;
}

function uniquifyName(name: string): string {
  const tag = randomBytes(4).toString('hex');
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  return sanitizeDocumentName(`${base.slice(0, 255 - ext.length - 11)} [${tag}]${ext}`);
}
