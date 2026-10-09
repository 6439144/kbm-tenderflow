// TEST-ONLY fake of IBM Cloud IAM + the watsonx Orchestrate instance endpoints the client uses (AGENTS.md rule 9:
// fakes live only under test/). Replies are scripted per call by the test through `reply`.
// Endpoints: POST /identity/token, GET /v1/orchestrate/agents, POST /v1/orchestrate/runs,
// GET /v1/orchestrate/runs/{id}, GET /v1/orchestrate/threads/{thread_id}/messages.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

export const FAKE_API_KEY = 'fake-api-key-SECRET-xyz';

export const AGENT_NAMES = [
  'tenderflow_pack_checker', 'tenderflow_clarification_assistant', 'tenderflow_compliance_screener', 'tenderflow_request_classifier',
  'tenderflow_notice_drafter', 'tenderflow_relevance_matcher', 'tenderflow_evaluation_narrator', 'tenderflow_grade_reviewer', 'tenderflow_document_intelligence', 'tenderflow_assistant',
];

export interface FakeCall { agentName: string; agentId: string; prompt: string; threadId: string; continued: boolean }
export type FakeReply = string | { status: 'failed'; error: string };

export interface FakeOrchestrate {
  base: string;
  env: Record<string, string>;
  calls: FakeCall[];
  /** Called for every run; return the assistant text. Default: '{}' (invalid for every task). */
  reply: (call: FakeCall) => FakeReply;
  /** Queue of replies used before `reply` (shifted per run). */
  queue: FakeReply[];
  close(): Promise<void>;
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
}
function json(res: ServerResponse, status: number, obj: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj));
}

export async function startFakeOrchestrate(): Promise<FakeOrchestrate> {
  const ids = new Map(AGENT_NAMES.map((n) => [n, randomUUID()]));
  const byId = new Map([...ids].map(([n, id]) => [id, n]));
  const runs = new Map<string, { thread: string; reply: FakeReply }>();
  const threads = new Map<string, any[]>();
  let fake: FakeOrchestrate;
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    const b = await body(req);
    if (url.pathname === '/identity/token' && req.method === 'POST') {
      const p = new URLSearchParams(b);
      if (p.get('apikey') !== FAKE_API_KEY) return json(res, 400, { errorMessage: 'bad apikey' });
      return json(res, 200, { access_token: `tok-${randomUUID()}`, expires_in: 3600, expiration: Math.floor(Date.now() / 1000) + 3600 });
    }
    if (!String(req.headers.authorization ?? '').startsWith('Bearer tok-')) return json(res, 401, { detail: 'unauthorized' });
    if (url.pathname === '/v1/orchestrate/agents' && req.method === 'GET') {
      const names = url.searchParams.getAll('names');
      const all = AGENT_NAMES.map((name) => ({ id: ids.get(name), name, llm: 'watsonx/meta-llama/llama-3-3-70b-instruct' }));
      return json(res, 200, names.length ? all.filter((a) => names.includes(a.name)) : all);
    }
    if (url.pathname === '/v1/orchestrate/runs' && req.method === 'POST') {
      const parsed = JSON.parse(b);
      const continued = Boolean(parsed.thread_id);
      const thread = parsed.thread_id ?? randomUUID();
      const call: FakeCall = { agentName: byId.get(parsed.agent_id) ?? 'unknown', agentId: parsed.agent_id, prompt: parsed.message.content, threadId: thread, continued };
      fake.calls.push(call);
      const reply = fake.queue.length ? fake.queue.shift()! : fake.reply(call);
      const runId = randomUUID();
      runs.set(runId, { thread, reply });
      const msgs = threads.get(thread) ?? [];
      msgs.push({ role: 'user', content: [{ response_type: 'text', text: parsed.message.content }], created_on: new Date(Date.now() + msgs.length).toISOString() });
      if (typeof reply === 'string') msgs.push({ role: 'assistant', content: [{ response_type: 'text', text: reply }], created_on: new Date(Date.now() + msgs.length + 1).toISOString() });
      threads.set(thread, msgs);
      return json(res, 200, { thread_id: thread, run_id: runId, task_id: randomUUID(), message_id: randomUUID() });
    }
    const runM = url.pathname.match(/^\/v1\/orchestrate\/runs\/([^/]+)$/);
    if (runM && req.method === 'GET') {
      const r = runs.get(runM[1]);
      if (!r) return json(res, 404, { detail: 'no run' });
      if (typeof r.reply === 'object') return json(res, 200, { id: runM[1], status: 'failed', last_error: r.reply.error });
      return json(res, 200, { id: runM[1], thread_id: r.thread, status: 'completed' });
    }
    const thM = url.pathname.match(/^\/v1\/orchestrate\/threads\/([^/]+)\/messages$/);
    if (thM && req.method === 'GET') return json(res, 200, threads.get(thM[1]) ?? []);
    json(res, 404, { detail: `no route ${req.method} ${url.pathname}` });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake = {
    base, calls: [], queue: [], reply: () => '{}',
    env: { WXO_INSTANCE_URL: base, WXO_API_KEY: FAKE_API_KEY, WXO_IAM_URL: `${base}/identity/token` },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
  return fake;
}
