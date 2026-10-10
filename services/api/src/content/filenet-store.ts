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
import { ContentStore, ContentStoreUnavailableError, FolderNode, RepositoryDescription, StoredObject } from './types.js';
import {
  ACCESS_MASK, aclEntriesFor, aclMatches, CONFIDENTIALITY_LEVELS, confidentialityFor, expectedProperties, GRANTEE_RE, modelPropertyValues,
  ownerTypesOf, PERMISSIONS_SELECTION, permissionsLiteral, planClass, subclassFor, TF_BASE_CLASS, TF_CLASSES,
  type AclConfig, type AclEntry, type ClassStatus, type Confidentiality, type ModelStatus, type ModelValue, type TfClassName,
} from './filenet-model.js';
import { acceUrl, navigatorSettings, probeNavigator, type NavigatorSettings, type ResolvedNavigator } from './navigator.js';

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

export type FileNetRecordsMode = 'none' | 'property' | 'retention';
export const RECORDS_MODES: FileNetRecordsMode[] = ['none', 'property', 'retention'];
/** Record-declaration properties (property mode; created in ACCE, see docs/filenet/ACCE-RUNBOOK.md §1b). */
export const TF_RECORD_PROPERTY_NAMES = ['TF_RecordDeclared', 'TF_RecordDeclaredAt'] as const;
/** Document-intelligence properties (FILENET_AI_PROPERTIES; created in ACCE, see docs/filenet/ACCE-RUNBOOK.md §1c). */
export const TF_AI_PROPERTY_NAMES = ['TF_DocType', 'TF_ExpiryDate', 'TF_AIReviewed'] as const;

export interface FileNetConfig {
  graphqlUrl: string;
  objectStore: string;
  user: string;
  password: string;
  docClass: string;
  rootFolder: string;
  setCustomProperties: boolean;
  timeoutMs: number;
  /** FILENET_VERSIONING: check addenda in as the next major version of the superseded document. */
  versioning: boolean;
  /** FILENET_RECORDS_MODE: how declareRecord() marks a document in the repository. */
  recordsMode: FileNetRecordsMode;
  /** FILENET_RETENTION_DAYS (retention mode): CmRetentionDate = now + days. */
  retentionDays: number | null;
  /** FILENET_AI_PROPERTIES: write TF_DocType / TF_ExpiryDate / TF_AIReviewed when a document insight is accepted. */
  aiProperties: boolean;
  /** FILENET_CLASS_MODEL: single = every document in FILENET_DOC_CLASS (rc3); subclasses = TF_* subclass per owner type. */
  classModel: 'single' | 'subclasses';
  /** FILENET_ACL_MODE + FILENET_GROUP_<LEVEL>: permission list written at create / changed at opening. */
  acl: AclConfig;
  /** Navigator candidates (configured or derived from the GraphQL origin); null when FILENET_NAVIGATOR_URL=off. */
  navigator: NavigatorSettings | null;
  /** ACCE base URL; null when FILENET_ACCE_URL=off. */
  acceUrl: string | null;
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

/** Fields selected on a created / checked-in document (all on the Document interface of the published schema). */
interface CreatedDocument { id: string; name: string | null; className: string; majorVersionNumber?: number | null; minorVersionNumber?: number | null; versionSeries?: { id: string } | null }
const CREATED_SELECTION = 'id name className majorVersionNumber minorVersionNumber versionSeries { id }';

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
  const setCustomProperties = parseBool(env, 'FILENET_SET_CUSTOM_PROPERTIES');
  const versioning = parseBool(env, 'FILENET_VERSIONING');
  const timeoutMs = env.FILENET_TIMEOUT_MS ? Number(env.FILENET_TIMEOUT_MS) : 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new FileNetConfigError('FILENET_TIMEOUT_MS must be a positive number');
  const recordsMode = (env.FILENET_RECORDS_MODE?.trim().toLowerCase() || 'none') as FileNetRecordsMode;
  if (!RECORDS_MODES.includes(recordsMode)) {
    throw new FileNetConfigError(`FILENET_RECORDS_MODE must be one of ${RECORDS_MODES.join(', ')} (got "${env.FILENET_RECORDS_MODE}")`);
  }
  let retentionDays: number | null = null;
  if (recordsMode === 'retention') {
    retentionDays = Number(env.FILENET_RETENTION_DAYS);
    if (!env.FILENET_RETENTION_DAYS?.trim() || !Number.isInteger(retentionDays) || retentionDays <= 0 || retentionDays > 36500) {
      throw new FileNetConfigError(`FILENET_RECORDS_MODE=retention requires FILENET_RETENTION_DAYS (whole number of days, 1-36500; got "${env.FILENET_RETENTION_DAYS ?? ''}")`);
    }
  }
  return {
    graphqlUrl,
    objectStore: String(env.FILENET_OBJECT_STORE).trim(),
    user: String(env.FILENET_SERVICE_USER),
    password: String(env.FILENET_SERVICE_PASSWORD),
    docClass: env.FILENET_DOC_CLASS?.trim() || 'Document',
    rootFolder,
    setCustomProperties,
    timeoutMs,
    versioning,
    recordsMode,
    retentionDays,
    aiProperties: parseBool(env, 'FILENET_AI_PROPERTIES'),
    classModel: parseEnum(env, 'FILENET_CLASS_MODEL', ['single', 'subclasses'] as const, 'single'),
    acl: loadAclConfig(env),
    navigator: navigatorSettings(env, graphqlUrl),
    acceUrl: acceUrl(env, graphqlUrl),
  };
}

function parseEnum<T extends string>(env: NodeJS.ProcessEnv, name: string, values: readonly T[], dflt: T): T {
  const raw = (env[name] ?? '').trim().toLowerCase();
  if (!raw) return dflt;
  if (!(values as readonly string[]).includes(raw)) throw new FileNetConfigError(`${name} must be one of ${values.join(', ')} (got "${env[name]}")`);
  return raw as T;
}

/** FILENET_ACL_MODE=off|groups, FILENET_GROUP_<LEVEL> group names, FILENET_ACL_SERVICE_GRANTEE (default: the service user). */
function loadAclConfig(env: NodeJS.ProcessEnv): AclConfig {
  const mode = parseEnum(env, 'FILENET_ACL_MODE', ['off', 'groups'] as const, 'off');
  const groups = {} as Record<Confidentiality, string | null>;
  for (const level of CONFIDENTIALITY_LEVELS) {
    const v = env[`FILENET_GROUP_${level}`]?.trim() || null;
    if (v && !GRANTEE_RE.test(v)) throw new FileNetConfigError(`FILENET_GROUP_${level} is not a valid grantee name (letters, digits, space and . _ @ = , ( ) # - only)`);
    groups[level] = v;
  }
  const serviceGrantee = env.FILENET_ACL_SERVICE_GRANTEE?.trim() || String(env.FILENET_SERVICE_USER ?? '').trim();
  if (mode === 'groups') {
    if (!GRANTEE_RE.test(serviceGrantee)) throw new FileNetConfigError('FILENET_ACL_MODE=groups: FILENET_ACL_SERVICE_GRANTEE (or FILENET_SERVICE_USER) is not a valid grantee name');
    if (!Object.values(groups).some(Boolean)) throw new FileNetConfigError('FILENET_ACL_MODE=groups needs at least one FILENET_GROUP_<PUBLIC|INTERNAL|SEALED|COMMITTEE|AUDIT> group name');
  }
  return { mode, serviceGrantee, groups };
}

function parseBool(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = (env[name] ?? 'false').trim().toLowerCase();
  if (!['true', 'false', '1', '0', 'yes', 'no', ''].includes(raw)) {
    throw new FileNetConfigError(`${name} must be true or false (got "${env[name]}")`);
  }
  return ['true', '1', 'yes'].includes(raw);
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
  private objectStoreGuid: string | null = null;

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
      this.objectStoreGuid = os.id ?? null;
      return { ok: true, detail: `FileNet object store ${os.symbolicName ?? this.config.objectStore} ("${os.displayName ?? ''}", id ${os.id}) at ${this.endpointLabel()}` };
    } catch (e: any) {
      return { ok: false, detail: e?.message ?? String(e) };
    }
  }

  async put(input: { tenantId: string; folderPath: string; fileName: string; mimeType: string; bytes: Buffer; properties: Record<string, string>; supersedesRef?: string }): Promise<StoredObject> {
    if (!Buffer.isBuffer(input.bytes)) throw new FileNetError('FileNet put: bytes must be a Buffer');
    const folder = this.resolveFolder(input.folderPath);
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const legacyProps = this.config.setCustomProperties ? this.buildCustomProperties(input.tenantId, input.properties ?? {}, sha256) : null;
    const name = sanitizeDocumentName(input.fileName);
    const p = input.properties ?? {};
    const ownerType = p.TF_OwnerType || p.TF_DocType || p.docType || null;

    // Versioning: the new content becomes the next MAJOR version of the superseded document. No fallback:
    // when versioning is enabled and the check-in fails, the upload fails with the server's error text.
    if (input.supersedesRef && this.config.versioning) {
      const prev = this.parseStoreRef(input.supersedesRef);
      // The version series keeps its class: model properties are written only when that class has them.
      const checkinProps = this.config.classModel === 'subclasses' ? await this.checkinModelProps(prev.id, input.tenantId, p, sha256, legacyProps) : legacyProps;
      const v = await this.checkInNewVersion(prev.id, name, input, checkinProps);
      const acl = this.config.acl.mode === 'groups' ? { mode: 'groups', level: confidentialityFor(ownerType), status: 'INHERITED', detail: 'a checked-in version keeps the security of its version series', at: new Date().toISOString() } : undefined;
      return {
        storeRef: `filenet:${this.config.objectStore}:${v.id}`, storeType: 'filenet', byteSize: input.bytes.length,
        // A checked-in version stays filed where its version series is filed (not in input.folderPath), so the
        // folder is not recorded here; the evidence view reads the real folders from the repository (describe()).
        meta: this.metaOf(v, null, v.name ?? name, { repositoryVersioning: true, supersedesObjectId: prev.id, propertiesWritten: Object.keys(checkinProps ?? {}), ...(acl ? { acl } : {}) }),
      };
    }

    await this.ensureFolder(folder);
    const plan = await this.uploadPlan(input.tenantId, ownerType, p, sha256, legacyProps);
    const { created, attempt, errors } = await this.createWithFallbacks(folder, name, input, plan);
    const extra: Record<string, unknown> = { repositoryVersioning: false, propertiesWritten: Object.keys(attempt.props ?? {}) };
    if (this.config.classModel === 'subclasses' || errors.length) {
      extra.classModel = {
        mode: this.config.classModel, requested: plan.requestedClass, used: created.className ?? attempt.className,
        ...(plan.fallback ? { fallback: plan.fallback } : {}), ...(errors.length ? { refused: errors.map((e) => e.slice(0, 500)) } : {}),
      };
    }
    if (plan.acl) extra.acl = await this.aclOutcome(created.id, plan.acl.level, plan.acl.entries, attempt.perms ? null : (errors[errors.length - 1] ?? 'permissions not written'));
    return {
      storeRef: `filenet:${this.config.objectStore}:${created.id}`, storeType: 'filenet', byteSize: input.bytes.length,
      meta: this.metaOf(created, folder, created.name ?? name, extra),
    };
  }

  /** Class, properties and permissions for a new document (see content/filenet-model.ts). */
  private async uploadPlan(tenantId: string, ownerType: string | null, p: Record<string, string>, sha256: string, legacyProps: Record<string, string> | null): Promise<UploadPlan> {
    const acl = this.config.acl.mode === 'groups'
      ? { level: confidentialityFor(ownerType), entries: aclEntriesFor(this.config.acl, confidentialityFor(ownerType)) }
      : null;
    const fallbackAttempt = { className: this.config.docClass, props: legacyProps };
    if (this.config.classModel !== 'subclasses') {
      return { requestedClass: this.config.docClass, primary: fallbackAttempt, fallbackAttempt, model: false, acl };
    }
    const status = await this.modelStatus();
    const planned = planClass(status, ownerType);
    const requestedClass = subclassFor(ownerType);
    if (!planned.model) return { requestedClass, primary: fallbackAttempt, fallbackAttempt, model: false, fallback: planned.fallback, acl };
    let values: Record<string, ModelValue>;
    try { values = modelPropertyValues(planned.className as TfClassName, tenantId, p, sha256); } catch (e: any) {
      throw new FileNetError(`FileNet put: ${e?.message ?? e}`);
    }
    const props = planned.writable === 'all' || planned.writable === null
      ? values
      : Object.fromEntries(Object.entries(values).filter(([k]) => (planned.writable as Set<string>).has(k)));
    return { requestedClass, primary: { className: planned.className, props }, fallbackAttempt, model: true, fallback: planned.fallback, acl };
  }

  /**
   * Creates the document; never breaks an upload because of the class model or the permission list: a refused
   * permission list is retried without it (recorded, re-applied by the filenet-access-retry job), a refused class or
   * property falls back to FILENET_DOC_CLASS with the rc3 properties. Transport errors are thrown unchanged.
   */
  private async createWithFallbacks(folder: string, name: string, input: { fileName: string; mimeType: string; bytes: Buffer }, plan: UploadPlan): Promise<{ created: CreatedDocument; attempt: CreateAttempt; errors: string[] }> {
    const perms = plan.acl?.entries ?? null;
    const first: CreateAttempt = { ...plan.primary, perms };
    const errors: string[] = [];
    try {
      return { created: await this.createOnce(folder, name, input, first), attempt: first, errors };
    } catch (e: any) {
      if (!(e instanceof FileNetError) || !e.graphqlErrors) throw e;
      errors.push(e.message);
      const permsLikely = !!perms && /permission|grantee|security|access|acl|\bsid\b|principal/i.test(e.message);
      if (plan.model && !permsLikely) this.modelCache = null; // re-check the classes on the next upload
      const next: CreateAttempt[] = permsLikely
        ? [{ ...plan.primary, perms: null }, ...(plan.model ? [{ ...plan.fallbackAttempt, perms: null }] : [])]
        : [...(plan.model ? [{ ...plan.fallbackAttempt, perms }] : []), ...(perms ? [{ ...(plan.model ? plan.fallbackAttempt : plan.primary), perms: null }] : [])];
      if (!next.length) throw e; // nothing to fall back to: the server's error, unchanged (rc3 behaviour)
      for (const a of next) {
        try {
          return { created: await this.createOnce(folder, name, input, a), attempt: a, errors };
        } catch (e2: any) {
          if (!(e2 instanceof FileNetError) || !e2.graphqlErrors) throw e2;
          errors.push(e2.message);
        }
      }
      throw new FileNetError(`FileNet createDocument failed (${errors.length} attempt${errors.length > 1 ? 's' : ''}): ${errors.join(' || ')}`, e.graphqlErrors, e.httpStatus);
    }
  }

  /** One createDocument; a containment-name clash is retried once under a unique name. */
  private async createOnce(folder: string, name: string, input: { fileName: string; mimeType: string; bytes: Buffer }, a: CreateAttempt): Promise<CreatedDocument> {
    try {
      return await this.createDocument(folder, name, input, a.props, a.className, a.perms);
    } catch (e: any) {
      // Same containment name already filed in this folder: store under a unique name (the document is real;
      // TenderFlow references it by id, never by name).
      if (!(e instanceof FileNetError) || !FILENET_PROTOCOL.notUniquePattern.test(e.message)) throw e;
      return this.createDocument(folder, uniquifyName(name), input, a.props, a.className, a.perms);
    }
  }

  /** ACL state after create: read back and compared, or the reason it was not written. */
  private async aclOutcome(id: string, level: Confidentiality, entries: AclEntry[], notWritten: string | null): Promise<Record<string, unknown>> {
    const base = { mode: 'groups', level, grantees: entries.map((e) => ({ name: e.granteeName, access: e.access })), at: new Date().toISOString() };
    if (notWritten) return { ...base, status: 'FAILED', attempts: 1, error: notWritten.slice(0, 500) };
    try {
      const back = await this.readPermissions(id);
      const m = aclMatches(entries, back);
      return m.ok
        ? { ...base, status: 'APPLIED', appliedLevel: level, readBack: back.length }
        : { ...base, status: 'FAILED', attempts: 1, error: `read-back is missing ${m.missing.join(', ')}` };
    } catch (e: any) {
      return { ...base, status: 'UNVERIFIED', attempts: 1, error: `written, but the read-back failed: ${String(e?.message ?? e).slice(0, 400)}` };
    }
  }

  /** Model properties for a check-in, limited to what the version series' class has. */
  private async checkinModelProps(prevId: string, tenantId: string, p: Record<string, string>, sha256: string, legacyProps: Record<string, string> | null): Promise<Record<string, ModelValue> | null> {
    const d = await this.graphql<{ document: { className: string } | null }>(
      `query TfClassOf($os: String!, $id: String!) { document(repositoryIdentifier: $os, identifier: $id) { id className } }`,
      { os: this.config.objectStore, id: prevId },
    );
    const cls = d.document?.className;
    if (!cls || !(TF_CLASSES as string[]).includes(cls)) return legacyProps;
    const c = (await this.modelStatus()).classes.find((x) => x.name === cls);
    if (!c?.exists) return legacyProps;
    const values = modelPropertyValues(cls as TfClassName, tenantId, p, sha256);
    return c.present ? Object.fromEntries(Object.entries(values).filter(([k]) => c.present!.includes(k))) : values;
  }

  /** store_meta for a created / checked-in document (no secrets, no content). */
  private metaOf(d: CreatedDocument, folder: string | null, name: string, extra: Record<string, unknown>): Record<string, unknown> {
    const label = typeof d.majorVersionNumber === 'number' ? `${d.majorVersionNumber}.${d.minorVersionNumber ?? 0}` : null;
    return {
      objectStore: this.config.objectStore, objectId: d.id, className: d.className ?? this.config.docClass,
      folderPath: folder, name, versionLabel: label, versionSeriesId: d.versionSeries?.id ?? null, ...extra,
    };
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
    props: Record<string, ModelValue> | null,
    className: string = this.config.docClass,
    perms: AclEntry[] | null = null,
  ): Promise<CreatedDocument> {
    const cv = FILENET_PROTOCOL.contentVariable;
    // PropertyIdentifierAndScalarValue is a custom scalar written as {SymbolicName: value} (IBM samples);
    // inlined as literals exactly like IBM's samples, values escaped as GraphQL strings.
    const propsLiteral = this.propsLiteral(props);
    const permsLiteral = perms && perms.length ? permissionsLiteral(perms) : '';
    const query = `mutation TfCreateDocument($os: String!, $cls: String!, $folder: String!, $name: String!, $mime: String!, $${cv}: String) {
      createDocument(
        repositoryIdentifier: $os
        classIdentifier: $cls
        fileInFolderIdentifier: $folder
        checkinAction: {}
        documentProperties: {
          name: $name
          ${propsLiteral}
          ${permsLiteral}
          contentElements: { replace: [{ type: CONTENT_TRANSFER, contentType: $mime, subContentTransfer: { content: $${cv}, retrievalName: $name } }] }
        }
      ) { ${CREATED_SELECTION} }
    }`;
    const data = await this.graphql<{ createDocument: CreatedDocument | null }>(
      query,
      { os: this.config.objectStore, cls: className, folder, name, mime: input.mimeType || 'application/octet-stream' },
      { bytes: input.bytes, fileName: name, mimeType: input.mimeType },
    );
    if (!data.createDocument?.id) throw new FileNetError('FileNet createDocument: server returned no document id');
    return data.createDocument;
  }

  /** documentProperties.properties literal: custom scalar written as {SymbolicName: value}, as in IBM's samples. */
  private propsLiteral(props: Record<string, ModelValue> | null): string {
    return props && Object.keys(props).length ? `properties: [${Object.entries(props).map(([k, v]) => `{${k}: ${scalarLiteral(v)}}`).join(' ')}]` : '';
  }

  /**
   * Check-in of new content as the next major version of `sourceId`. Published schema: checkoutDocument returns
   * the source document with its `reservation`; checkinDocument(identifier: <reservation>, checkinAction:
   * { checkinMinorVersion: false }, documentProperties: { contentElements … }) with the content streamed as a
   * multipart part, exactly like createDocument. On a failed check-in the reservation is cancelled (best effort)
   * and the error is thrown with the server's text — never a silent fallback to a new document.
   */
  private async checkInNewVersion(sourceId: string, name: string, input: { mimeType: string; bytes: Buffer }, props: Record<string, ModelValue> | null): Promise<CreatedDocument> {
    let reservationId: string;
    try {
      const out = await this.graphql<{ checkoutDocument: { id: string; reservation: { id: string } | null } | null }>(
        `mutation TfCheckout($os: String!, $id: String!) {
          checkoutDocument(repositoryIdentifier: $os, identifier: $id) { id reservation { id } }
        }`,
        { os: this.config.objectStore, id: sourceId },
      );
      const rid = out.checkoutDocument?.reservation?.id;
      if (!rid) throw new FileNetError(`checkoutDocument returned no reservation for ${sourceId}`);
      reservationId = rid;
    } catch (e: any) {
      throw new FileNetError(`FileNet versioning (FILENET_VERSIONING=true): checkout of ${sourceId} failed — ${e?.message ?? e}`, e?.graphqlErrors, e?.httpStatus);
    }
    const cv = FILENET_PROTOCOL.contentVariable;
    const query = `mutation TfCheckin($os: String!, $id: String!, $name: String!, $mime: String!, $${cv}: String) {
      checkinDocument(
        repositoryIdentifier: $os
        identifier: $id
        checkinAction: { checkinMinorVersion: false }
        documentProperties: {
          name: $name
          ${this.propsLiteral(props)}
          contentElements: { replace: [{ type: CONTENT_TRANSFER, contentType: $mime, subContentTransfer: { content: $${cv}, retrievalName: $name } }] }
        }
      ) { ${CREATED_SELECTION} }
    }`;
    try {
      const data = await this.graphql<{ checkinDocument: CreatedDocument | null }>(
        query,
        { os: this.config.objectStore, id: reservationId, name, mime: input.mimeType || 'application/octet-stream' },
        { bytes: input.bytes, fileName: name, mimeType: input.mimeType },
      );
      const d = data.checkinDocument;
      if (!d?.id) throw new FileNetError('checkinDocument returned no document');
      if (typeof d.minorVersionNumber === 'number' && d.minorVersionNumber !== 0) {
        throw new FileNetError(`checkinDocument: expected a major version, server reports ${d.majorVersionNumber}.${d.minorVersionNumber}`);
      }
      return d;
    } catch (e: any) {
      let cancel = 'reservation cancelled';
      try {
        await this.graphql(
          `mutation TfCancelCheckout($os: String!, $id: String!) { cancelDocumentCheckout(repositoryIdentifier: $os, identifier: $id) { id } }`,
          { os: this.config.objectStore, id: reservationId },
        );
      } catch (c: any) { cancel = `cancelling the reservation also failed: ${c?.message ?? c}`; }
      throw new FileNetError(`FileNet versioning (FILENET_VERSIONING=true): check-in of a new major version of ${sourceId} failed — ${e?.message ?? e} (${cancel})`, e?.graphqlErrors, e?.httpStatus);
    }
  }

  // ---------------------------------------------------------------- describe / records / folder tree (showcase)

  /** GUID of the object store (used for Navigator links); cached after the first ping/describe. */
  async objectStoreId(): Promise<string | null> {
    if (this.objectStoreGuid) return this.objectStoreGuid;
    const data = await this.graphql<{ objectStore: { id: string } | null }>(
      `query TfObjectStoreId($os: String!) { objectStore(identifier: $os) { id } }`, { os: this.config.objectStore });
    this.objectStoreGuid = data.objectStore?.id ?? null;
    return this.objectStoreGuid;
  }

  /** Property names TenderFlow asks for: only names the ACCE runbook defines, and only when that feature is enabled. */
  describePropertyNames(model?: ClassStatus | null): string[] {
    const names: string[] = ['DocumentTitle'];
    const add = (n: string) => { if (!names.includes(n)) names.push(n); };
    if (this.config.setCustomProperties) TF_PROPERTY_NAMES.forEach(add);
    if (this.config.recordsMode === 'property') TF_RECORD_PROPERTY_NAMES.forEach(add);
    if (this.config.aiProperties) TF_AI_PROPERTY_NAMES.forEach(add);
    // A TF_* model class: every model property the repository reports on that class (never a name it does not have).
    if (model?.exists && model.present) for (const p of expectedProperties(model.name)) if (model.present.includes(p.name)) add(p.name);
    return names;
  }

  /** Repository view of one document: class, id, version, version series, folders, content elements, properties. */
  async describe(storeRef: string, opts: { className?: string | null } = {}): Promise<RepositoryDescription> {
    const { id } = this.parseStoreRef(storeRef);
    let model: ClassStatus | null = null;
    if (this.config.classModel === 'subclasses' && opts.className && (TF_CLASSES as string[]).includes(opts.className)) {
      try { model = (await this.modelStatus()).classes.find((c) => c.name === opts.className) ?? null; } catch { model = null; }
    }
    const retention = this.config.recordsMode === 'retention' ? 'cmRetentionDate' : '';
    const data = await this.graphql<{ document: any }>(
      `query TfDescribeFull($os: String!, $id: String!, $props: [String!]) {
        document(repositoryIdentifier: $os, identifier: $id) {
          id name className majorVersionNumber minorVersionNumber isCurrentVersion versionStatus isReserved
          dateCreated dateCheckedIn creator mimeType ${retention}
          versionSeries { id }
          foldersFiledIn { folders { pathName } }
          contentElements { contentType elementSequenceNumber ... on ContentTransfer { contentSize retrievalName } }
          properties(includes: $props) { id value }
          versions { documents { id majorVersionNumber minorVersionNumber isCurrentVersion dateCheckedIn } }
        }
      }`,
      { os: this.config.objectStore, id, props: this.describePropertyNames(model) },
    );
    const d = data.document;
    if (!d) throw new FileNetError(`FileNet describe: ${id} not found in ${this.config.objectStore}`);
    const properties: Record<string, unknown> = {};
    for (const p of d.properties ?? []) properties[p.id] = p.value;
    let osId: string | null = null;
    try { osId = await this.objectStoreId(); } catch { /* reported as null; the document description stands */ }
    const num = (v: unknown) => (typeof v === 'number' ? v : null);
    return {
      type: 'filenet', objectStore: this.config.objectStore, objectStoreId: osId,
      id: d.id, name: d.name ?? null, className: d.className,
      majorVersionNumber: num(d.majorVersionNumber), minorVersionNumber: num(d.minorVersionNumber),
      isCurrentVersion: d.isCurrentVersion ?? null, versionStatus: d.versionStatus ?? null, isReserved: d.isReserved ?? null,
      versionSeriesId: d.versionSeries?.id ?? null,
      dateCreated: d.dateCreated ?? null, dateCheckedIn: d.dateCheckedIn ?? null, creator: d.creator ?? null, mimeType: d.mimeType ?? null,
      ...(retention ? { cmRetentionDate: d.cmRetentionDate ?? null } : {}),
      byteSize: num((d.contentElements ?? []).find((c: any) => c.elementSequenceNumber === 0)?.contentSize),
      folders: (d.foldersFiledIn?.folders ?? []).map((f: any) => f.pathName).filter(Boolean),
      contentElements: (d.contentElements ?? []).map((c: any) => ({
        contentType: c.contentType ?? null, elementSequenceNumber: c.elementSequenceNumber ?? null, contentSize: c.contentSize ?? null, retrievalName: c.retrievalName ?? null,
      })),
      properties,
      versions: (d.versions?.documents ?? [])
        .map((v: any) => ({ id: v.id, majorVersionNumber: num(v.majorVersionNumber), minorVersionNumber: num(v.minorVersionNumber), isCurrentVersion: v.isCurrentVersion ?? null, dateCheckedIn: v.dateCheckedIn ?? null }))
        .sort((a: any, b: any) => (a.majorVersionNumber ?? 0) - (b.majorVersionNumber ?? 0) || (a.minorVersionNumber ?? 0) - (b.minorVersionNumber ?? 0)),
    };
  }

  /**
   * Declares a document a record in the repository according to FILENET_RECORDS_MODE. The outcome is read back
   * from the server; anything else throws (callers report the document as not declared in the repository).
   */
  async declareRecord(storeRef: string, _info: { reason: string }): Promise<{ ok: boolean; detail: string }> {
    const mode = this.config.recordsMode;
    if (mode === 'none') return { ok: false, detail: 'records declaration not configured (FILENET_RECORDS_MODE=none)' };
    const { id } = this.parseStoreRef(storeRef);
    const at = new Date();
    if (mode === 'property') {
      const data = await this.graphql<{ updateDocument: { id: string; properties: { id: string; value: unknown }[] } | null }>(
        `mutation TfDeclareRecord($os: String!, $id: String!) {
          updateDocument(
            repositoryIdentifier: $os
            identifier: $id
            documentProperties: { properties: [{TF_RecordDeclared: true} {TF_RecordDeclaredAt: ${gqlString(at.toISOString())}}] }
          ) { id properties(includes: ["TF_RecordDeclared", "TF_RecordDeclaredAt"]) { id value } }
        }`,
        { os: this.config.objectStore, id },
      );
      const back = Object.fromEntries((data.updateDocument?.properties ?? []).map((p) => [p.id, p.value]));
      if (back.TF_RecordDeclared !== true && String(back.TF_RecordDeclared).toLowerCase() !== 'true') {
        throw new FileNetError(`FileNet declareRecord: TF_RecordDeclared on ${id} reads back as ${JSON.stringify(back.TF_RecordDeclared ?? null)}`);
      }
      return { ok: true, detail: `marked TF_RecordDeclared=true (${at.toISOString()}) on ${id} — immutability requires IBM Enterprise Records or a retention policy` };
    }
    // retention (ASSUMED: CmRetentionDate is settable through documentProperties.cmRetentionDate; not verified live)
    const until = new Date(at.getTime() + (this.config.retentionDays ?? 0) * 86_400_000).toISOString();
    const data = await this.graphql<{ updateDocument: { id: string; cmRetentionDate: string | null } | null }>(
      `mutation TfRetain($os: String!, $id: String!, $until: DateTime!) {
        updateDocument(repositoryIdentifier: $os, identifier: $id, documentProperties: { cmRetentionDate: $until }) { id cmRetentionDate }
      }`,
      { os: this.config.objectStore, id, until },
    );
    const got = data.updateDocument?.cmRetentionDate;
    if (!got) throw new FileNetError(`FileNet declareRecord: CmRetentionDate on ${id} reads back empty after the update`);
    return { ok: true, detail: `CmRetentionDate set to ${got} on ${id} (${this.config.retentionDays} days) — the Content Engine refuses deletion before that date` };
  }

  /**
   * Writes custom properties on an existing document (document intelligence: TF_DocType string, TF_ExpiryDate DateTime,
   * TF_AIReviewed Boolean) with updateDocument, the same mutation the records `property` mode uses, and reads them back.
   * Only when FILENET_AI_PROPERTIES=true and FILENET_DOC_CLASS=TF_Document (the templates exist only on that class).
   * NOT verified against a live Content Engine (TechZone not reachable from the build sandbox).
   */
  async setProperties(storeRef: string, props: Record<string, string | boolean>): Promise<{ ok: boolean; detail: string; readBack?: Record<string, unknown> }> {
    if (!this.config.aiProperties) return { ok: false, detail: 'FILENET_AI_PROPERTIES is not enabled' };
    if (this.config.docClass !== 'TF_Document' && this.config.classModel !== 'subclasses') return { ok: false, detail: `FILENET_DOC_CLASS is ${this.config.docClass}; TF_DocType / TF_ExpiryDate / TF_AIReviewed exist only on TF_Document and its subclasses` };
    const entries = Object.entries(props).filter(([k]) => /^TF_[A-Za-z0-9]{1,60}$/.test(k));
    if (!entries.length) return { ok: false, detail: 'no properties to write' };
    const { id } = this.parseStoreRef(storeRef);
    const literal = entries.map(([k, v]) => `{${k}: ${typeof v === 'boolean' ? String(v) : gqlString(String(v).slice(0, TF_PROPERTY_MAX_LENGTH))}}`).join(' ');
    const names = entries.map(([k]) => gqlString(k)).join(', ');
    const data = await this.graphql<{ updateDocument: { id: string; properties: { id: string; value: unknown }[] } | null }>(
      `mutation TfSetProperties($os: String!, $id: String!) {
        updateDocument(
          repositoryIdentifier: $os
          identifier: $id
          documentProperties: { properties: [${literal}] }
        ) { id properties(includes: [${names}]) { id value } }
      }`,
      { os: this.config.objectStore, id },
    );
    const readBack = Object.fromEntries((data.updateDocument?.properties ?? []).map((p) => [p.id, p.value]));
    for (const [k, v] of entries) {
      const got = readBack[k];
      const same = typeof v === 'boolean' ? got === v || String(got).toLowerCase() === String(v) : got !== null && got !== undefined && String(got).startsWith(String(v).slice(0, 10));
      if (!same) throw new FileNetError(`FileNet setProperties: ${k} on ${id} reads back as ${JSON.stringify(got ?? null)}`);
    }
    return { ok: true, detail: `wrote ${entries.map(([k]) => k).join(', ')} on ${id}`, readBack };
  }

  /** Folder tree under a TenderFlow-relative folder (0–2 levels below it), with per-folder document counts. */
  async folderTree(folderPath: string, depth: number): Promise<FolderNode | null> {
    const abs = this.resolveFolder(folderPath);
    const levels = Math.max(0, Math.min(depth, 2));
    const docs = 'containedDocuments { documents { id } pageInfo { token } }';
    let sub = '';
    for (let i = 0; i < levels; i++) sub = `subFolders { folders { name pathName ${docs} ${sub} } pageInfo { token } }`;
    let data: { folder: any };
    try {
      data = await this.graphql<{ folder: any }>(
        `query TfFolderTree($os: String!, $root: String!) { folder(repositoryIdentifier: $os, identifier: $root) { name pathName ${docs} ${sub} } }`,
        { os: this.config.objectStore, root: abs },
      );
    } catch (e: any) {
      if (e instanceof FileNetError && e.graphqlErrors && FILENET_PROTOCOL.notFoundPattern.test(e.message)) return null;
      throw e;
    }
    if (!data.folder) return null;
    const toNode = (f: any, left: number): FolderNode => ({
      name: f.name ?? String(f.pathName ?? '').split('/').pop() ?? '',
      path: f.pathName ?? '',
      documentCount: Array.isArray(f.containedDocuments?.documents) ? f.containedDocuments.documents.length : null,
      more: f.containedDocuments?.pageInfo?.token ? true : undefined,
      children: left > 0
        ? (f.subFolders?.folders ?? []).map((c: any) => toNode(c, left - 1)).sort((a: FolderNode, b: FolderNode) => a.name.localeCompare(b.name))
        : [],
    });
    return toNode(data.folder, levels);
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

  // ---------------------------------------------------------------- class model (classDescription)

  private modelCache: { at: number; ttl: number; value: Promise<ModelStatus> } | null = null;
  static readonly MODEL_CACHE_MS = 5 * 60_000;
  /** A status with classes that could not be checked (repository unreachable) is kept only briefly. */
  static readonly MODEL_RETRY_MS = 30_000;

  /**
   * Which TF_* classes and properties exist in the object store (classDescription), cached for 5 minutes.
   * ASSUMED (not verified live): ClassDescription.propertyDescriptions { symbolicName }. When the server refuses that
   * selection, class existence is still checked and the property list is reported as unknown.
   */
  modelStatus(opts: { force?: boolean } = {}): Promise<ModelStatus> {
    if (this.modelCache && !opts.force && Date.now() - this.modelCache.at < this.modelCache.ttl) return this.modelCache.value;
    const entry = { at: Date.now(), ttl: FileNetStore.MODEL_CACHE_MS, value: null as unknown as Promise<ModelStatus> };
    const value = (async (): Promise<ModelStatus> => {
      const classes = await Promise.all(TF_CLASSES.map((c) => this.classStatus(c)));
      if (classes.some((c) => c.exists === null)) entry.ttl = FileNetStore.MODEL_RETRY_MS;
      return {
        mode: this.config.classModel, checkedAt: new Date().toISOString(), fallbackClass: this.config.docClass, classes,
        ready: classes.every((c) => c.exists === true && c.present !== null && c.missing.length === 0),
      };
    })();
    entry.value = value;
    this.modelCache = entry;
    value.catch(() => { if (this.modelCache === entry) this.modelCache = null; });
    return value;
  }

  private async classStatus(name: TfClassName): Promise<ClassStatus> {
    const base: ClassStatus = { name, parent: name === TF_BASE_CLASS ? 'Document' : TF_BASE_CLASS, ownerTypes: name === TF_BASE_CLASS ? [] : ownerTypesOf(name), exists: null, present: null, missing: [] };
    const expected = expectedProperties(name).map((p) => p.name);
    try {
      const data = await this.graphql<{ classDescription: { symbolicName: string; propertyDescriptions?: { symbolicName: string }[] | null } | null }>(
        `query TfClassModel($os: String!, $cls: String!) { classDescription(repositoryIdentifier: $os, identifier: $cls) { symbolicName propertyDescriptions { symbolicName } } }`,
        { os: this.config.objectStore, cls: name },
      );
      if (!data.classDescription) return { ...base, exists: false, missing: expected };
      const present = (data.classDescription.propertyDescriptions ?? []).map((p) => p.symbolicName).filter(Boolean);
      return { ...base, exists: true, present, missing: expected.filter((p) => !present.includes(p)) };
    } catch (e: any) {
      if (e instanceof FileNetError && e.graphqlErrors && FILENET_PROTOCOL.notFoundPattern.test(e.message)) return { ...base, exists: false, missing: expected };
      if (!(e instanceof FileNetError) || !e.graphqlErrors) return { ...base, error: String(e?.message ?? e).slice(0, 500) };
      // The property list selection was refused: check the class alone.
      try {
        const exists = await this.classExists(name);
        return { ...base, exists, missing: exists ? [] : expected, error: exists ? `property list not available: ${String(e.message).slice(0, 300)}` : undefined };
      } catch (e2: any) {
        return { ...base, error: String(e2?.message ?? e2).slice(0, 500) };
      }
    }
  }

  // ---------------------------------------------------------------- security (permission list)

  /** Permission list of a document, read back from the repository (ASSUMED selection, see filenet-model.ts). */
  async readPermissions(idOrRef: string): Promise<{ granteeName: string | null; accessMask: number | null; accessType: string | null; permissionSource: string | null }[]> {
    const id = idOrRef.startsWith('filenet:') ? this.parseStoreRef(idOrRef).id : idOrRef;
    const data = await this.graphql<{ document: { id: string; permissions?: any[] | null } | null }>(
      `query TfPermissions($os: String!, $id: String!) { document(repositoryIdentifier: $os, identifier: $id) { id ${PERMISSIONS_SELECTION} } }`,
      { os: this.config.objectStore, id },
    );
    if (!data.document) throw new FileNetError(`FileNet readPermissions: ${id} not found`);
    return (data.document.permissions ?? []).map((p: any) => ({
      granteeName: p?.granteeName ?? null, accessMask: typeof p?.accessMask === 'number' ? p.accessMask : null,
      accessType: p?.accessType ?? null, permissionSource: p?.permissionSource ?? null,
    }));
  }

  /** Grantees and masks a confidentiality level maps to (FILENET_ACL_MODE=groups), or null when ACLs are off. */
  aclFor(level: Confidentiality): AclEntry[] | null {
    return this.config.acl.mode === 'groups' ? aclEntriesFor(this.config.acl, level) : null;
  }

  /** Replaces the document's permission list for `level` and reads it back. Throws when the server refuses or the read-back differs. */
  async setAccess(storeRef: string, level: Confidentiality): Promise<{ ok: boolean; detail: string; entries?: AclEntry[]; readBack?: unknown[] }> {
    const entries = this.aclFor(level);
    if (!entries) return { ok: false, detail: 'FILENET_ACL_MODE=off' };
    const { id } = this.parseStoreRef(storeRef);
    await this.graphql(
      `mutation TfSetAccess($os: String!, $id: String!) {
        updateDocument(repositoryIdentifier: $os, identifier: $id, documentProperties: { ${permissionsLiteral(entries)} }) { id }
      }`,
      { os: this.config.objectStore, id },
    );
    const back = await this.readPermissions(id);
    const m = aclMatches(entries, back);
    if (!m.ok) throw new FileNetError(`FileNet setAccess: read-back of ${id} is missing ${m.missing.join(', ')}`);
    return { ok: true, detail: `${level}: ${entries.map((e) => `${e.granteeName} ${e.access === 'FULL_CONTROL' ? ACCESS_MASK.FULL_CONTROL : ACCESS_MASK.VIEW_CONTENT}`).join(', ')} on ${id}`, entries, readBack: back };
  }

  // ---------------------------------------------------------------- search (CE SQL)

  /**
   * CE SQL search through documents(repositoryIdentifier, from, where, pageSize). `where` must come from
   * filenet-model.ts buildSearchWhere (whitelisted values); `from` must be a TF class or FILENET_DOC_CLASS.
   */
  async search(from: string, where: string, pageSize: number, propertyNames: string[]): Promise<{ documents: { id: string; name: string | null; className: string; majorVersionNumber: number | null; minorVersionNumber: number | null; dateCreated: string | null; properties: Record<string, unknown> }[]; more: boolean }> {
    if (!(TF_CLASSES as string[]).includes(from) && from !== this.config.docClass) throw new FileNetError(`FileNet search: class ${from} is not searchable`);
    if (!where.startsWith("TF_TenantId = '")) throw new FileNetError('FileNet search: the condition must start with the tenant');
    const n = Math.max(1, Math.min(50, Math.trunc(pageSize) || 25));
    const data = await this.graphql<{ documents: { documents: any[] | null; pageInfo?: { token: string | null } | null } | null }>(
      `query TfSearch($os: String!, $from: String!, $where: String!, $n: Int!, $props: [String!]) {
        documents(repositoryIdentifier: $os, from: $from, where: $where, pageSize: $n) {
          documents { id name className majorVersionNumber minorVersionNumber dateCreated properties(includes: $props) { id value } }
          pageInfo { token }
        }
      }`,
      { os: this.config.objectStore, from, where, n, props: propertyNames.length ? propertyNames : ['DocumentTitle'] },
    );
    const docs = data.documents?.documents ?? [];
    return {
      documents: docs.map((d: any) => ({
        id: d.id, name: d.name ?? null, className: d.className, majorVersionNumber: d.majorVersionNumber ?? null, minorVersionNumber: d.minorVersionNumber ?? null,
        dateCreated: d.dateCreated ?? null, properties: Object.fromEntries((d.properties ?? []).map((p: any) => [p.id, p.value])),
      })),
      more: !!data.documents?.pageInfo?.token,
    };
  }

  // ---------------------------------------------------------------- model properties after upload (AI classification)

  /**
   * Writes model properties (e.g. TF_AiClassification / TF_AiConfidence) on a stored document, only those the
   * document's class has according to modelStatus(), and reads them back. ok:false (never thrown) when the class has none.
   */
  async setModelProperties(storeRef: string, className: string | null | undefined, props: Record<string, ModelValue>): Promise<{ ok: boolean; detail: string; written?: Record<string, ModelValue>; readBack?: Record<string, unknown> }> {
    const { id } = this.parseStoreRef(storeRef);
    let cls = className ?? null;
    if (!cls) {
      const d = await this.graphql<{ document: { className: string } | null }>(
        `query TfClassOf($os: String!, $id: String!) { document(repositoryIdentifier: $os, identifier: $id) { id className } }`, { os: this.config.objectStore, id });
      cls = d.document?.className ?? null;
    }
    if (!cls || !(TF_CLASSES as string[]).includes(cls)) return { ok: false, detail: `class ${cls ?? '?'} is not a TenderFlow model class (FILENET_CLASS_MODEL=${this.config.classModel})` };
    const status = (await this.modelStatus()).classes.find((c) => c.name === cls);
    if (!status?.exists) return { ok: false, detail: `class ${cls} is not available in ${this.config.objectStore}` };
    const entries = Object.entries(props).filter(([k, v]) => /^TF_[A-Za-z0-9]{1,60}$/.test(k) && v !== undefined && v !== null && (!status.present || status.present.includes(k)));
    if (!entries.length) return { ok: false, detail: `class ${cls} has none of ${Object.keys(props).join(', ')}` };
    const literal = entries.map(([k, v]) => `{${k}: ${scalarLiteral(v)}}`).join(' ');
    const names = entries.map(([k]) => gqlString(k)).join(', ');
    const data = await this.graphql<{ updateDocument: { id: string; properties: { id: string; value: unknown }[] } | null }>(
      `mutation TfSetModelProperties($os: String!, $id: String!) {
        updateDocument(repositoryIdentifier: $os, identifier: $id, documentProperties: { properties: [${literal}] }) { id properties(includes: [${names}]) { id value } }
      }`,
      { os: this.config.objectStore, id },
    );
    const readBack = Object.fromEntries((data.updateDocument?.properties ?? []).map((p) => [p.id, p.value]));
    for (const [k, v] of entries) {
      const got = readBack[k];
      const same = typeof v === 'number' ? typeof got === 'number' ? Math.abs(got - v) < 1e-9 : Math.abs(Number(got) - v) < 1e-9 : String(got) === String(v);
      if (!same) throw new FileNetError(`FileNet setModelProperties: ${k} on ${id} reads back as ${JSON.stringify(got ?? null)}`);
    }
    return { ok: true, detail: `wrote ${entries.map(([k]) => k).join(', ')} on ${id} (${cls})`, written: Object.fromEntries(entries), readBack };
  }

  // ---------------------------------------------------------------- Navigator / ACCE

  /** Navigator for evidence links (probe cached 5 minutes); null when FILENET_NAVIGATOR_URL=off. */
  resolveNavigator(opts: { force?: boolean } = {}): Promise<ResolvedNavigator | null> {
    return this.config.navigator ? probeNavigator(this.config.navigator, opts) : Promise.resolve(null);
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

interface CreateAttempt { className: string; props: Record<string, ModelValue> | null; perms?: AclEntry[] | null }
interface UploadPlan {
  requestedClass: string;
  primary: CreateAttempt;
  fallbackAttempt: CreateAttempt;
  /** True when primary uses a TF_* model class (FILENET_CLASS_MODEL=subclasses and the class exists). */
  model: boolean;
  fallback?: string;
  acl: { level: Confidentiality; entries: AclEntry[] } | null;
}

/** GraphQL literal of a property value: string (JSON-escaped), boolean, or finite number. */
function scalarLiteral(v: ModelValue): string {
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new FileNetError('FileNet: property value must be a finite number');
    return String(v);
  }
  return gqlString(String(v));
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
