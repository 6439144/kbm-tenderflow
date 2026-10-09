// Outbound REST client for an IBM Cloud watsonx Orchestrate (SaaS) instance.
//
// Verified against (see agents/README.md for full notes):
//  - IAM token: POST https://iam.cloud.ibm.com/identity/token, form grant_type=urn:ibm:params:oauth:grant-type:apikey&apikey=...
//    The ADK maps instance URLs containing ".cloud.ibm.com" to auth type ibm_iam with exactly this token URL
//    (ibm_watsonx_orchestrate/cli/commands/server/types.py, AUTH_TYPE_DEFAULT_URL_MAPPING; IAMAuthenticator).
//  - Remote clients prefix every path with "{instance_url}/v1/orchestrate" (ibm_watsonx_orchestrate_clients/common/base_client.py, BaseWXOClient).
//  - GET  /v1/orchestrate/agents?names=<name>            → bare JSON array of agents ({id, name, llm, ...})
//  - POST /v1/orchestrate/runs  {message:{role,content}, agent_id} → {thread_id, run_id, task_id, message_id}
//  - GET  /v1/orchestrate/runs/{run_id}                  → {status: pending|running|completed|failed|cancelled|..., last_error, result}
//  - GET  /v1/orchestrate/threads/{thread_id}/messages   → messages; last role=assistant, content[] items with response_type "text" + "text"
//    (same sequence the ADK CLI uses in `orchestrate chat ask`: create_run → wait_for_run_completion → get_thread_messages).
//
// No secrets (API key, bearer token) are ever written to logs or error messages.

export class OrchestrateError extends Error {
  code = 'ORCHESTRATE_ERROR';
  constructor(message: string, public readonly status?: number, public readonly operation?: string) {
    super(message);
    this.name = 'OrchestrateError';
  }
}

export interface AgentSummary { id: string; name: string; displayName?: string; llm?: string }

export interface InvokeResult {
  text: string;
  agentId: string;
  agentName: string;
  model?: string;
  threadId: string;
  runId: string;
}

export interface OrchestrateClientOptions {
  instanceUrl: string;
  apiKey: string;
  iamUrl?: string;
  /** Overall deadline for one invokeAgent call, and the per-request timeout (default 60 s). */
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Base delay before the single retry on 429/5xx (default 1000 ms; Retry-After honoured up to 10 s). */
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_OK = new Set(['completed']);
const TERMINAL_FAIL = new Set(['failed', 'cancelled', 'expired', 'requires_input']);
const TOKEN_SAFETY_MS = 5 * 60 * 1000;

function normaliseIamUrl(u: string): string {
  const s = u.replace(/\/+$/, '');
  return /\/identity\/token$/.test(s) ? s : `${s}/identity/token`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class OrchestrateClient {
  private readonly base: string;
  private readonly iamUrl: string;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private token?: { value: string; refreshAt: number };
  private tokenInflight?: Promise<string>;
  private readonly agentCache = new Map<string, AgentSummary>();

  constructor(private readonly opts: OrchestrateClientOptions) {
    if (!opts.instanceUrl || !opts.apiKey) throw new OrchestrateError('Orchestrate client requires instanceUrl and apiKey');
    this.base = `${opts.instanceUrl.replace(/\/+$/, '')}/v1/orchestrate`;
    this.iamUrl = normaliseIamUrl(opts.iamUrl || 'https://iam.cloud.ibm.com/identity/token');
    this.timeoutMs = opts.timeoutMs ?? 60000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1500;
    this.retryDelayMs = opts.retryDelayMs ?? 1000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** Removes anything that could be a credential from text that may end up in an error message. */
  private redact(s: string): string {
    let out = s;
    if (this.opts.apiKey) out = out.split(this.opts.apiKey).join('[REDACTED]');
    if (this.token?.value) out = out.split(this.token.value).join('[REDACTED]');
    return out.replace(/(access_token|refresh_token|apikey)"?\s*[:=]\s*"?[^",&\s]+/gi, '$1=[REDACTED]');
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, operation: string): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(Math.max(1, timeoutMs)) });
    } catch (e) {
      const err = e as Error;
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new OrchestrateError(`Orchestrate ${operation} timed out after ${timeoutMs} ms`, undefined, operation);
      }
      throw new OrchestrateError(`Orchestrate ${operation} network error: ${this.redact(err.message)}`, undefined, operation);
    }
  }

  private async errorFrom(res: Response, operation: string): Promise<OrchestrateError> {
    let body = '';
    try { body = await res.text(); } catch { /* ignore */ }
    body = this.redact(body).slice(0, 800);
    return new OrchestrateError(`Orchestrate ${operation} failed: HTTP ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`, res.status, operation);
  }

  /** IBM Cloud IAM bearer token, cached until 5 minutes before expiry. */
  async getToken(): Promise<string> {
    if (this.token && this.now() < this.token.refreshAt) return this.token.value;
    if (this.tokenInflight) return this.tokenInflight;
    this.tokenInflight = this.fetchToken().finally(() => { this.tokenInflight = undefined; });
    return this.tokenInflight;
  }

  private async fetchToken(): Promise<string> {
    const op = 'IAM token request';
    const body = new URLSearchParams({ grant_type: 'urn:ibm:params:oauth:grant-type:apikey', apikey: this.opts.apiKey });
    const send = () => this.fetchWithTimeout(this.iamUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    }, this.timeoutMs, op);
    let res = await send();
    if (res.status === 429 || res.status >= 500) { await this.backoff(res); res = await send(); }
    if (!res.ok) throw await this.errorFrom(res, op);
    const json = (await res.json()) as { access_token?: string; expires_in?: number; expiration?: number };
    if (!json.access_token) throw new OrchestrateError(`${op} returned no access_token`, res.status, op);
    const nowMs = this.now();
    const expMs = typeof json.expiration === 'number' ? json.expiration * 1000
      : nowMs + (typeof json.expires_in === 'number' ? json.expires_in : 3600) * 1000;
    this.token = { value: json.access_token, refreshAt: Math.max(nowMs, expMs - TOKEN_SAFETY_MS) };
    return json.access_token;
  }

  private async backoff(res?: Response): Promise<void> {
    const ra = res?.headers.get('retry-after');
    const raMs = ra && /^\d+$/.test(ra) ? Math.min(Number(ra) * 1000, 10000) : undefined;
    await sleep(raMs ?? this.retryDelayMs);
  }

  /** Authenticated JSON request against {instance}/v1/orchestrate. One retry on 429/5xx; token refresh on 401. */
  private async api<T>(method: 'GET' | 'POST', path: string, operation: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const url = `${this.base}${path}`;
    const send = async () => {
      const token = await this.getToken();
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      return this.fetchWithTimeout(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, timeoutMs, operation);
    };
    let res = await send();
    if (res.status === 401) { this.token = undefined; res = await send(); }
    else if (res.status === 429 || res.status >= 500) { await this.backoff(res); res = await send(); }
    if (!res.ok) throw await this.errorFrom(res, operation);
    const text = await res.text();
    if (!text) return {} as T;
    try { return JSON.parse(text) as T; } catch {
      throw new OrchestrateError(`Orchestrate ${operation} returned non-JSON body (HTTP ${res.status})`, res.status, operation);
    }
  }

  /** GET /v1/orchestrate/agents (optionally filtered by names). */
  async listAgents(names?: string[]): Promise<AgentSummary[]> {
    const qs = new URLSearchParams();
    for (const n of names ?? []) qs.append('names', n);
    const q = qs.toString();
    const raw = await this.api<unknown>('GET', `/agents${q ? `?${q}` : ''}`, 'list agents');
    const arr = Array.isArray(raw) ? raw : Array.isArray((raw as { data?: unknown })?.data) ? (raw as { data: unknown[] }).data : null;
    if (!arr) throw new OrchestrateError('Orchestrate list agents returned an unexpected body (expected an array)', undefined, 'list agents');
    return arr
      .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && typeof (a as { id?: unknown }).id === 'string')
      .map((a) => ({
        id: a.id as string,
        name: String(a.name ?? ''),
        displayName: typeof a.display_name === 'string' ? a.display_name : undefined,
        llm: typeof a.llm === 'string' ? a.llm : undefined,
      }));
  }

  /** Resolves an agent name (or id) to an agent record; cached for the life of the client. */
  async resolveAgent(ref: string): Promise<AgentSummary> {
    const cached = this.agentCache.get(ref);
    if (cached) return cached;
    let agent: AgentSummary | undefined;
    if (UUID_RE.test(ref)) {
      const all = await this.listAgents();
      agent = all.find((a) => a.id === ref) ?? { id: ref, name: ref };
    } else {
      const found = await this.listAgents([ref]);
      agent = found.find((a) => a.name === ref);
      if (!agent) {
        throw new OrchestrateError(`Orchestrate agent "${ref}" was not found on the instance. Import it with agents/import.ps1 (or import.sh) and check the WXO_AGENT_* settings.`, 404, 'resolve agent');
      }
    }
    this.agentCache.set(ref, agent);
    return agent;
  }

  /**
   * Sends one user message to an agent and returns its final text answer.
   * POST /runs → poll GET /runs/{id} → GET /threads/{thread}/messages (last assistant message).
   * Pass threadId to continue the same conversation (used for the JSON repair turn).
   */
  async invokeAgent(agentRef: string, message: string, options: { timeoutMs?: number; threadId?: string } = {}): Promise<InvokeResult> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const deadline = this.now() + timeoutMs;
    const remaining = () => deadline - this.now();
    const agent = await this.resolveAgent(agentRef);

    const payload: Record<string, unknown> = { message: { role: 'user', content: message }, agent_id: agent.id };
    if (options.threadId) payload.thread_id = options.threadId;
    const run = await this.api<{ thread_id?: string; run_id?: string }>('POST', '/runs', 'create run', payload, Math.max(1, remaining()));
    if (!run.run_id || !run.thread_id) throw new OrchestrateError('Orchestrate create run returned no run_id/thread_id', undefined, 'create run');

    let status: { status?: string; last_error?: string | null; result?: unknown } = {};
    for (;;) {
      if (remaining() <= 0) throw new OrchestrateError(`Orchestrate run ${run.run_id} did not complete within ${timeoutMs} ms (last status: ${status.status ?? 'unknown'})`, undefined, 'wait for run');
      status = await this.api('GET', `/runs/${encodeURIComponent(run.run_id)}`, 'get run', undefined, Math.max(1, remaining()));
      const s = String(status.status ?? '').toLowerCase();
      if (TERMINAL_OK.has(s)) break;
      if (TERMINAL_FAIL.has(s)) {
        throw new OrchestrateError(`Orchestrate run ${run.run_id} ended with status "${s}"${status.last_error ? `: ${this.redact(String(status.last_error)).slice(0, 500)}` : ''}`, undefined, 'wait for run');
      }
      await sleep(Math.min(this.pollIntervalMs, Math.max(0, remaining())));
    }

    let text = '';
    const msgs = await this.api<unknown>('GET', `/threads/${encodeURIComponent(run.thread_id)}/messages`, 'get thread messages', undefined, Math.max(1, remaining()));
    const list = Array.isArray(msgs) ? msgs : Array.isArray((msgs as { data?: unknown })?.data) ? (msgs as { data: unknown[] }).data : [];
    const assistant = lastAssistantMessage(list);
    if (assistant) text = contentToText(assistant.content);
    if (!text) {
      const resultMsg = (status.result as { data?: { message?: { content?: unknown } } } | undefined)?.data?.message;
      if (resultMsg) text = contentToText(resultMsg.content);
    }
    if (!text.trim()) throw new OrchestrateError(`Orchestrate run ${run.run_id} completed but no assistant text was found`, undefined, 'read answer');
    return { text, agentId: agent.id, agentName: agent.name, model: agent.llm, threadId: run.thread_id, runId: run.run_id };
  }
}

interface ThreadMessage { role?: string; content?: unknown; created_on?: string }

function lastAssistantMessage(list: unknown[]): ThreadMessage | undefined {
  const msgs = list.filter((m): m is ThreadMessage => !!m && typeof m === 'object');
  const allDated = msgs.length > 0 && msgs.every((m) => typeof m.created_on === 'string' && !Number.isNaN(Date.parse(m.created_on)));
  const ordered = allDated ? [...msgs].sort((a, b) => Date.parse(a.created_on!) - Date.parse(b.created_on!)) : msgs;
  for (let i = ordered.length - 1; i >= 0; i--) if (ordered[i].role === 'assistant') return ordered[i];
  return undefined;
}

/** Text from a message content: a string, or an array of items with response_type "text" and a "text" field. */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') parts.push(item);
    else if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
      const rt = (item as { response_type?: unknown }).response_type;
      if (rt === undefined || rt === 'text' || rt === 'conversational_search') parts.push((item as { text: string }).text);
    }
  }
  return parts.join('\n');
}
