// TenderFlow web — typed client for the REST contract in docs/BUILD-SPEC.md §6.
// Every function here performs a real HTTP call against the API on the same origin.
// Nothing in this file fabricates data.

export type Role =
  | 'VENDOR'
  | 'PROCUREMENT_OFFICER'
  | 'DIRECTOR'
  | 'UNDERSECRETARY'
  | 'COMMITTEE_CHAIR'
  | 'EVALUATOR'
  | 'TENANT_ADMIN'
  | 'AUDITOR'
  | 'GRADING_AUTHORITY';

export const ALL_ROLES: Role[] = [
  'PROCUREMENT_OFFICER',
  'DIRECTOR',
  'UNDERSECRETARY',
  'COMMITTEE_CHAIR',
  'EVALUATOR',
  'TENANT_ADMIN',
  'AUDITOR',
  'GRADING_AUTHORITY',
  'VENDOR',
];

export type Category = 'IT' | 'WORKS' | 'SERVICES' | 'SUPPLIES';
export const CATEGORIES: Category[] = ['IT', 'WORKS', 'SERVICES', 'SUPPLIES'];

export type TenderStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'PUBLISHED'
  | 'CLOSED'
  | 'OPENED'
  | 'EVALUATION'
  | 'AWARDED'
  | 'CANCELLED';

export const LIFECYCLE: TenderStatus[] = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PUBLISHED', 'CLOSED', 'OPENED', 'EVALUATION', 'AWARDED'];
export const ALL_TENDER_STATUSES: TenderStatus[] = [...LIFECYCLE, 'CANCELLED'];

export type VendorStatus = 'PENDING_REVIEW' | 'PENDING' | 'APPROVED' | 'REJECTED';

export interface User {
  id: string;
  username: string;
  displayName: string;
  roles: Role[];
  tenantId: string;
  vendorId?: string | null;
  active?: boolean;
  createdAt?: string;
}

export interface Tenant {
  id: string;
  nameEn: string;
  nameAr: string;
  primaryColor?: string | null;
}

export type DocumentOwnerType =
  | 'VENDOR'
  | 'TENDER_PACK'
  | 'ADDENDUM'
  | 'BID_TECHNICAL'
  | 'BID_FINANCIAL'
  | 'OPENING_RECORD'
  | 'COMMITTEE_REPORT'
  | 'REQUEST_LETTER'
  | 'NOTICE'
  | 'EVALUATION_NARRATIVE';

export interface DocumentMeta {
  id: string;
  ownerType?: DocumentOwnerType;
  ownerId?: string;
  tenderId?: string | null;
  vendorId?: string | null;
  bidId?: string | null;
  title: string;
  mimeType?: string;
  byteSize?: number;
  sha256Plain?: string;
  storeType?: string;
  encrypted?: boolean;
  addendum?: boolean;
  uploadedBy?: string;
  createdAt?: string;
  versionNo?: number;
  supersedesId?: string | null;
  isRecord?: boolean;
  recordDeclaredAt?: string | null;
}

export interface Vendor {
  id: string;
  tenantId?: string;
  legalNameEn: string;
  legalNameAr: string;
  crNumber: string;
  email: string;
  phone: string;
  categories: string[];
  status: VendorStatus;
  decisionReason?: string | null;
  decidedBy?: string | null;
  createdAt?: string;
  decidedAt?: string | null;
  documents?: DocumentMeta[];
}

export interface Criterion {
  key: string;
  nameEn: string;
  nameAr: string;
  weight: number;
}

export interface RequiredDocument {
  key: string;
  nameEn: string;
  nameAr: string;
}

export interface Citation {
  documentId?: string;
  title?: string;
  section?: string;
  quote?: string;
}

export type AiKind = 'PACK_CHECK' | 'CLARIFICATION_DRAFT' | 'COMPLIANCE_SCREEN';

export interface AiRun {
  id: string;
  tenderId?: string;
  kind: AiKind;
  agent?: string;
  model?: string | null;
  request?: unknown;
  response?: unknown;
  citations?: Citation[] | null;
  status: 'OK' | 'ERROR';
  error?: string | null;
  requestedBy?: string;
  reviewedBy?: string | null;
  reviewDecision?: string | null;
  createdAt?: string;
}

export interface PackFinding {
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  item: string;
  detail: string;
  citation?: Citation;
}

export interface ClarificationDraft {
  answer: string;
  language?: 'ar' | 'en';
  citations: Citation[];
  notFound?: boolean;
}

export interface ComplianceItem {
  requirement: string;
  status: 'PRESENT' | 'MISSING' | 'UNCLEAR';
  evidence?: string;
  citation?: Citation;
}

export interface Clarification {
  id: string;
  tenderId?: string;
  vendorId?: string;
  question: string;
  language?: string;
  answer?: string | null;
  answeredBy?: string | null;
  status: 'OPEN' | 'ANSWERED';
  aiRunId?: string | null;
  createdAt?: string;
  answeredAt?: string | null;
}

export interface Opening {
  id: string;
  tenderId: string;
  chairId?: string;
  attendees?: string[];
  notes?: string;
  recordDocumentId?: string | null;
  openedAt?: string;
}

export interface Award {
  id: string;
  tenderId: string;
  bidId: string;
  recommendedBy?: string;
  justification?: string;
  approvedBy?: string | null;
  status: 'RECOMMENDED' | 'APPROVED';
  reportDocumentId?: string | null;
  vendorName?: string;
  createdAt?: string;
  approvedAt?: string | null;
}

export interface Tender {
  id: string;
  tenantId?: string;
  tenderNumber?: string;
  titleEn: string;
  titleAr: string;
  descriptionEn?: string | null;
  descriptionAr?: string | null;
  category: string;
  estimatedBudget?: number | string | null;
  currency?: string;
  submissionDeadline: string;
  criteria?: Criterion[];
  requiredDocuments?: RequiredDocument[];
  status: TenderStatus;
  createdBy?: string;
  approvedBy?: string | null;
  publishedAt?: string | null;
  closedAt?: string | null;
  openedAt?: string | null;
  awardedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  template?: { id: string; code: string; version: number; nameEn: string; nameAr: string } | null;
  cycle?: import('./api-platform').CycleConfig;
  requestId?: string | null;
  eligibility?: { activityCodes?: string[]; minGrade?: number | null };
  financialOpenedAt?: string | null;
  recordsLockedAt?: string | null;
}

/** GET /tenders/:id — documents and clarifications visible to the caller, bid count, ai runs for staff.
 *  `opening` and `award` are read when the API includes them. */
export interface TenderDetail extends Tender {
  documents?: DocumentMeta[];
  clarifications?: Clarification[];
  bidCount?: number;
  aiRuns?: AiRun[];
  opening?: Opening | null;
  award?: Award | null;
  stages?: import('./api-platform').StageInfo[];
  eligibilityRule?: { activityCodes: string[]; minGrade: number | null };
  publications?: import('./api-platform').Publication[];
  approvalChain?: import('./api-platform').ChainStep[];
  awardChain?: import('./api-platform').ChainStep[] | null;
  purchaseCount?: number;
  request?: { id: string; requestNumber: string; department: string; subject: string; source: string; sourceReference: string | null; letterDocumentId: string | null; status: string } | null;
  myEligibility?: import('./api-platform').Eligibility;
  myPurchase?: import('./api-platform').Purchase | null;
}

export interface TenderInput {
  tenderNumber?: string;
  titleEn: string;
  titleAr: string;
  descriptionEn: string;
  descriptionAr: string;
  category: string;
  estimatedBudget: number;
  currency: string;
  submissionDeadline: string;
  criteria: Criterion[];
  requiredDocuments: RequiredDocument[];
  /** Low-code: values of the entity's custom tender fields (validated by the server). */
  customFields?: Record<string, unknown>;
}

export interface BidReceipt {
  bidId: string;
  submittedAt: string;
  receiptSha256: string;
  files: { title: string; sha256: string }[];
}

export interface Bid {
  id: string;
  tenderId?: string;
  vendorId?: string;
  vendorName?: string;
  vendorNameEn?: string;
  vendorNameAr?: string;
  status: 'SEALED' | 'OPENED';
  receiptSha256?: string;
  submittedAt?: string;
  openedAt?: string | null;
  documents?: DocumentMeta[];
  files?: { title: string; sha256: string }[];
}

export interface Score {
  criterion: string;
  score: number;
  comment: string;
}

export interface Evaluation {
  id: string;
  tenderId?: string;
  bidId: string;
  evaluatorId: string;
  evaluatorName?: string;
  scores: Score[];
  weightedTotal: number | string;
  submittedAt?: string;
}

export interface AuditEvent {
  seq?: number | string;
  id: string;
  tenantId?: string;
  actorId?: string | null;
  actorRoles?: string[] | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  prevState?: string | null;
  newState?: string | null;
  reason?: string | null;
  details?: unknown;
  at: string;
  hmac?: string;
}

export interface AuditVerify {
  valid: boolean;
  count: number;
  brokenAt?: number | string | null;
}

export type Dashboard = Record<string, unknown>;
export type ReadyReport = Record<string, unknown>;

export interface VendorRegistration {
  tenantId: string;
  legalNameEn: string;
  legalNameAr: string;
  crNumber: string;
  email: string;
  phone: string;
  categories: string[];
  username: string;
  password: string;
  /** Low-code: public fields of the entity's vendor form. */
  customFields?: Record<string, unknown>;
}

// ---------------------------------------------------------------- session

const TOKEN_KEY = 'tf.token';
const USER_KEY = 'tf.user';
const TENANT_KEY = 'tf.tenant';

export interface Session {
  token: string;
  user: User;
  tenant: Tenant | null;
}

function ssGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function loadSession(): Session | null {
  const token = ssGet(TOKEN_KEY);
  const userRaw = ssGet(USER_KEY);
  if (!token || !userRaw) return null;
  try {
    const user = JSON.parse(userRaw) as User;
    const tenantRaw = ssGet(TENANT_KEY);
    const tenant = tenantRaw ? (JSON.parse(tenantRaw) as Tenant) : null;
    return { token, user, tenant };
  } catch {
    return null;
  }
}

export function saveSession(s: Session): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, s.token);
    sessionStorage.setItem(USER_KEY, JSON.stringify(s.user));
    if (s.tenant) sessionStorage.setItem(TENANT_KEY, JSON.stringify(s.tenant));
  } catch {
    /* storage unavailable: session lives only in memory for this tab */
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
    sessionStorage.removeItem(TENANT_KEY);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- core

export class ApiError extends Error {
  status: number;
  code: string;
  /** Extra fields of the error body (e.g. the bilingual reasons of PROCESS_RULE_BLOCKED). */
  details?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const isAiNotConfigured = (e: unknown): boolean =>
  e instanceof ApiError && e.code !== 'AI_AGENT_NOT_IMPORTED' && (e.code === 'AI_NOT_CONFIGURED' || (e.status === 503 && /AI/i.test(e.code)));

/** Orchestrate is connected but the named TenderFlow agent has not been imported on the instance yet. */
export const isAgentNotImported = (e: unknown): boolean => e instanceof ApiError && e.code === 'AI_AGENT_NOT_IMPORTED';
/** The model behind an agent returned an empty reply twice (Orchestrate: "LLM has responded with empty message"). */
export const isEmptyAiReply = (e: unknown): boolean => e instanceof ApiError && e.code === 'AI_EMPTY_REPLY';
export const agentNameOf = (e: unknown): string => (e instanceof Error ? /agent "([^"]+)"/.exec(e.message)?.[1] : undefined) ?? 'tenderflow_*';

export const UNAUTHORIZED_EVENT = 'tf:unauthorized';

const BASE = '/api/v1';

/** Accept either camelCase or snake_case from the API: normalise keys to camelCase. */
function camelKey(k: string): string {
  return k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}
export function camelize<T>(v: unknown): T {
  if (Array.isArray(v)) return v.map((x) => camelize(x)) as T;
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[camelKey(k)] = camelize(val);
    return out as T;
  }
  return v as T;
}

function authHeaders(): Record<string, string> {
  const token = ssGet(TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function toApiError(res: Response): Promise<ApiError> {
  let code = `HTTP_${res.status}`;
  let message = res.statusText || 'Request failed';
  let details: Record<string, unknown> | undefined;
  try {
    const text = await res.text();
    if (text) {
      try {
        const body = JSON.parse(text) as { code?: string; message?: string; error?: string };
        code = body.code ?? code;
        message = body.message ?? body.error ?? message;
        details = camelize<Record<string, unknown>>(body);
      } catch {
        message = text.slice(0, 300);
      }
    }
  } catch {
    /* ignore */
  }
  return new ApiError(res.status, code, message, details);
}

async function send(path: string, init: RequestInit = {}): Promise<Response> {
  const hadToken = Boolean(ssGet(TOKEN_KEY));
  let res: Response;
  try {
    res = await fetch(path.startsWith('/') && !path.startsWith(BASE) && !path.startsWith('/ready') && !path.startsWith('/health') ? BASE + path : path, {
      ...init,
      headers: { Accept: 'application/json', ...authHeaders(), ...(init.headers as Record<string, string> | undefined) },
    });
  } catch (e) {
    throw new ApiError(0, 'NETWORK_ERROR', e instanceof Error ? e.message : 'Network error');
  }
  if (res.status === 401 && hadToken) {
    clearSession();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  if (!res.ok) throw await toApiError(res);
  return res;
}

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await send(path, init);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return camelize<T>(JSON.parse(text));
}

const get = <T>(path: string) => json<T>(path);
const post = <T>(path: string, body?: unknown) =>
  json<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? '{}' : JSON.stringify(body),
  });
const patch = <T>(path: string, body: unknown) =>
  json<T>(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const postForm = <T>(path: string, form: FormData) => json<T>(path, { method: 'POST', body: form });
const put = <T>(path: string, body: unknown) =>
  json<T>(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** Low-level typed HTTP helpers for feature clients (api-*.ts). Same auth, errors and camelCase handling. */
const del = <T>(path: string) => json<T>(path, { method: 'DELETE' });
export const http = { get, post, patch, put, postForm, del };

function qs(params: Record<string, string | number | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

/** Some list endpoints may wrap results ({items:[...]}) — accept both. */
function asList<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === 'object') {
    for (const k of ['items', 'data', 'results', 'events', 'users', 'vendors', 'tenders', 'bids', 'evaluations']) {
      const x = (v as Record<string, unknown>)[k];
      if (Array.isArray(x)) return x as T[];
    }
  }
  return [];
}

// ---------------------------------------------------------------- downloads

function filenameFrom(res: Response, fallback: string): string {
  const cd = res.headers.get('Content-Disposition') ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain ? plain[1] : fallback;
}

/** Fetch a protected file with the Authorization header and save it as a download. */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const res = await send(path);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filenameFrom(res, fallbackName);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** HARDEN: fetch a protected file as bytes for the in-page protected viewer (extra headers such as X-Viewer-Grant). */
export async function fetchBytes(path: string, headers: Record<string, string> = {}): Promise<ArrayBuffer> {
  const res = await send(path, { headers: { Accept: 'application/pdf', ...headers }, cache: 'no-store' });
  return res.arrayBuffer();
}

/** Fetch a protected file and open it in a new tab (used for HTML reports). */
export async function openFile(path: string): Promise<void> {
  const res = await send(path);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

// ---------------------------------------------------------------- endpoints (§6)

export const api = {
  // Auth & meta
  login: (tenantId: string, username: string, password: string) =>
    post<{ token: string; user: User }>('/auth/login', { tenantId, username, password }),
  me: () => get<User>('/auth/me'),
  tenants: async () => asList<Tenant>(await get<unknown>('/public/tenants')),
  /** GET /ready returns 503 with a body when a dependency is down — the body is still the report. */
  ready: async (): Promise<{ httpStatus: number; report: ReadyReport }> => {
    let res: Response;
    try {
      res = await fetch('/ready', { headers: { Accept: 'application/json', ...authHeaders() } });
    } catch (e) {
      throw new ApiError(0, 'NETWORK_ERROR', e instanceof Error ? e.message : 'Network error');
    }
    const text = await res.text();
    let report: ReadyReport = {};
    try {
      report = camelize<ReadyReport>(JSON.parse(text));
    } catch {
      throw new ApiError(res.status, `HTTP_${res.status}`, text.slice(0, 300) || res.statusText);
    }
    return { httpStatus: res.status, report };
  },

  // Vendors
  registerVendor: (body: VendorRegistration) => post<Vendor>('/public/vendors/register', body),
  myVendor: () => get<Vendor>('/vendors/me'),
  uploadVendorDocument: (file: File, title: string) => {
    const f = new FormData();
    f.append('file', file);
    f.append('title', title);
    return postForm<DocumentMeta>('/vendors/me/documents', f);
  },
  vendors: async (status?: string) => asList<Vendor>(await get<unknown>(`/vendors${qs({ status })}`)),
  vendor: (id: string) => get<Vendor>(`/vendors/${encodeURIComponent(id)}`),
  decideVendor: (id: string, decision: 'APPROVE' | 'REJECT', reason: string) =>
    post<Vendor>(`/vendors/${encodeURIComponent(id)}/decision`, { decision, reason }),

  // Tenders
  tenders: async (status?: string) => asList<Tender>(await get<unknown>(`/tenders${qs({ status })}`)),
  tender: (id: string) => get<TenderDetail>(`/tenders/${encodeURIComponent(id)}`),
  createTender: (body: TenderInput) => post<Tender>('/tenders', withAliases(body)),
  updateTender: (id: string, body: TenderInput) => patch<Tender>(`/tenders/${encodeURIComponent(id)}`, withAliases(body)),
  uploadTenderDocument: (id: string, file: File, title: string, addendum: boolean) => {
    const f = new FormData();
    f.append('file', file);
    f.append('title', title);
    if (addendum) f.append('addendum', 'true');
    return postForm<DocumentMeta>(`/tenders/${encodeURIComponent(id)}/documents`, f);
  },
  packCheck: (id: string) => post<AiRun>(`/tenders/${encodeURIComponent(id)}/ai/pack-check`),
  reviewAiRun: (runId: string, decision: 'ACCEPTED' | 'IGNORED' | 'EDITED', note: string, findingIndex?: number) =>
    post<AiRun>(`/ai-runs/${encodeURIComponent(runId)}/review`, { decision, note, findingIndex }),
  approveTender: (id: string, reason: string) => post<Tender>(`/tenders/${encodeURIComponent(id)}/approve`, { reason }),
  returnTender: (id: string, reason: string) => post<Tender>(`/tenders/${encodeURIComponent(id)}/return`, { reason }),
  publishTender: (id: string) => post<Tender>(`/tenders/${encodeURIComponent(id)}/publish`),
  cancelTender: (id: string, reason: string) => post<Tender>(`/tenders/${encodeURIComponent(id)}/cancel`, { reason }),

  // Clarifications
  askClarification: (tenderId: string, question: string) =>
    post<Clarification>(`/tenders/${encodeURIComponent(tenderId)}/clarifications`, { question }),
  draftClarification: (id: string) => post<AiRun>(`/clarifications/${encodeURIComponent(id)}/ai-draft`),
  answerClarification: (id: string, answer: string) =>
    post<Clarification>(`/clarifications/${encodeURIComponent(id)}/answer`, { answer }),

  // Bids
  submitBid: (tenderId: string, technical: File, financial: File) => {
    const f = new FormData();
    f.append('technical', technical);
    f.append('financial', financial);
    return postForm<BidReceipt>(`/tenders/${encodeURIComponent(tenderId)}/bids`, f);
  },
  bids: async (tenderId: string) => {
    const v = await get<unknown>(`/tenders/${encodeURIComponent(tenderId)}/bids`);
    if (v && !Array.isArray(v) && typeof v === 'object' && ('bidId' in v || 'id' in v) && !('items' in v))
      return [normaliseBid(v as Record<string, unknown>)];
    return asList<Record<string, unknown>>(v).map(normaliseBid);
  },
  bidDocumentPath: (bidId: string, docId: string) =>
    `${BASE}/bids/${encodeURIComponent(bidId)}/documents/${encodeURIComponent(docId)}`,

  // Opening, screening, evaluation, award
  openBids: (tenderId: string, attendees: string[], notes: string) =>
    post<Opening & { recordDocument?: DocumentMeta }>(`/tenders/${encodeURIComponent(tenderId)}/open`, { attendees, notes }),
  complianceScreen: (tenderId: string) =>
    post<AiRun | AiRun[]>(`/tenders/${encodeURIComponent(tenderId)}/ai/compliance-screen`),
  submitEvaluation: (bidId: string, scores: Score[]) =>
    post<Evaluation>(`/bids/${encodeURIComponent(bidId)}/evaluation`, { scores }),
  evaluations: async (tenderId: string) =>
    asList<Evaluation>(await get<unknown>(`/tenders/${encodeURIComponent(tenderId)}/evaluations`)),
  recommendAward: (tenderId: string, bidId: string, justification: string) =>
    post<Award>(`/tenders/${encodeURIComponent(tenderId)}/award/recommend`, { bidId, justification }),
  approveAward: (tenderId: string, reason: string) =>
    post<Award & { reportDocument?: DocumentMeta }>(`/tenders/${encodeURIComponent(tenderId)}/award/approve`, { reason }),

  // Documents
  documentPath: (id: string) => `${BASE}/documents/${encodeURIComponent(id)}`,

  // Admin & audit
  users: async () => asList<User>(await get<unknown>('/admin/users')),
  createUser: (body: { username: string; displayName: string; roles: Role[]; password: string }) =>
    post<User>('/admin/users', body),
  audit: async (params: { resourceId?: string; limit?: number }) =>
    asList<AuditEvent>(await get<unknown>(`/audit${qs(params)}`)),
  verifyAudit: () => get<AuditVerify>('/audit/verify'),
  dashboard: () => get<Dashboard>('/dashboard'),
};

/** Criteria / required documents are stored as jsonb; §5 names their fields name_en/name_ar while the
 *  JSON API is camelCase. Send both spellings so either backend reading works. */
function withAliases(b: TenderInput) {
  return {
    ...b,
    criteria: b.criteria.map((c) => ({ ...c, name_en: c.nameEn, name_ar: c.nameAr })),
    requiredDocuments: b.requiredDocuments.map((d) => ({ ...d, name_en: d.nameEn, name_ar: d.nameAr })),
  };
}

function normaliseBid(b: Record<string, unknown>): Bid {
  const id = (b.id ?? b.bidId) as string;
  return { ...(b as unknown as Bid), id, status: ((b.status as string) ?? 'SEALED') as Bid['status'] };
}

// ---------------------------------------------------------------- AI response readers
// The run's `response` is whatever the agent returned through the API; we only read it.

export function packFindings(run: AiRun): { findings: PackFinding[]; summary?: string } {
  const r = run.response as { findings?: PackFinding[]; summary?: string; output?: { findings?: PackFinding[]; summary?: string } } | null;
  const src = r?.findings ? r : r?.output;
  return { findings: Array.isArray(src?.findings) ? src!.findings : [], summary: src?.summary };
}

export function clarificationDraft(run: AiRun): ClarificationDraft | null {
  const r = run.response as (ClarificationDraft & { output?: ClarificationDraft }) | null;
  const d = r && typeof r.answer === 'string' ? r : r?.output;
  if (!d || typeof d.answer !== 'string') return null;
  return { ...d, citations: d.citations ?? run.citations ?? [] };
}

export interface ComplianceResult {
  bidId?: string;
  vendorName?: string;
  items: ComplianceItem[];
  error?: string;
}

export function complianceResults(run: AiRun | AiRun[]): ComplianceResult[] {
  const runs = Array.isArray(run) ? run : [run];
  const out: ComplianceResult[] = [];
  for (const r of runs) {
    const resp = r.response as Record<string, unknown> | unknown[] | null;
    const req = (r.request ?? {}) as Record<string, unknown>;
    const pushOne = (x: Record<string, unknown>) => {
      const items = (Array.isArray(x.items) ? x.items : (x.output as Record<string, unknown> | undefined)?.items) as
        | ComplianceItem[]
        | undefined;
      out.push({
        bidId: (x.bidId ?? (x.bid as Record<string, unknown> | undefined)?.bidId ?? req.bidId) as string | undefined,
        vendorName: (x.vendorName ?? (x.bid as Record<string, unknown> | undefined)?.vendorName) as string | undefined,
        items: Array.isArray(items) ? items : [],
        error: (x.error as string | undefined) ?? undefined,
      });
    };
    if (Array.isArray(resp)) resp.forEach((x) => pushOne(x as Record<string, unknown>));
    else if (resp && typeof resp === 'object') {
      const list = (resp.bids ?? resp.results) as unknown;
      if (Array.isArray(list)) list.forEach((x) => pushOne(x as Record<string, unknown>));
      else pushOne(resp);
    }
  }
  return out;
}
