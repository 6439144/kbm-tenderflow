// Tests for the Orchestrate client and AiService against a LOCAL FAKE HTTP server (test-only, Rule 9).
// The fake emulates IBM Cloud IAM (/identity/token) and the instance endpoints the client uses:
// GET /v1/orchestrate/agents, POST /v1/orchestrate/runs, GET /v1/orchestrate/runs/{id},
// GET /v1/orchestrate/threads/{thread_id}/messages.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createAiService, AiNotConfiguredError, type DocText } from './index.js';
import { OrchestrateClient, OrchestrateError } from './orchestrate-client.js';
import { AiOutputError } from './parse.js';

const API_KEY = 'test-api-key-SECRET-123';
const AGENT_IDS: Record<string, string> = {
  tenderflow_pack_checker: '11111111-1111-4111-8111-111111111111',
  tenderflow_clarification_assistant: '22222222-2222-4222-8222-222222222222',
  tenderflow_compliance_screener: '33333333-3333-4333-8333-333333333333',
  tenderflow_request_classifier: '44444444-4444-4444-8444-444444444444',
  tenderflow_notice_drafter: '55555555-5555-4555-8555-555555555555',
  tenderflow_relevance_matcher: '66666666-6666-4666-8666-666666666666',
  tenderflow_evaluation_narrator: '77777777-7777-4777-8777-777777777777',
  tenderflow_grade_reviewer: '88888888-8888-4888-8888-888888888888',
  tenderflow_assistant: '99999999-9999-4999-8999-999999999999',
};

type Reply = string | { status: 'failed'; error: string } | { hang: true };

interface FakeState {
  iamCalls: number;
  iamBodies: string[];
  expiresIn: number;
  agentListCalls: number;
  agentListQueries: string[];
  runBodies: any[];
  replies: Reply[];
  pendingPolls: number; // how many "running" polls before completion
  fail: Record<string, number[]>; // route key → status codes to return first
  hangRuns: boolean;
  authHeaders: string[];
}

let server: Server;
let base = '';
let S: FakeState;
const runs = new Map<string, { thread: string; polls: number; reply: Reply }>();
const threads = new Map<string, any[]>();

function reset(): void {
  S = { iamCalls: 0, iamBodies: [], expiresIn: 3600, agentListCalls: 0, agentListQueries: [], runBodies: [], replies: [], pendingPolls: 1, fail: {}, hangRuns: false, authHeaders: [] };
  runs.clear(); threads.clear();
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
}
function json(res: ServerResponse, status: number, obj: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj));
}
function maybeFail(key: string, res: ServerResponse): boolean {
  const q = S.fail[key];
  if (q && q.length) { const code = q.shift()!; json(res, code, { detail: `fake ${code} for ${key}`, echoed_apikey: API_KEY }); return true; }
  return false;
}

before(async () => {
  reset();
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    const b = await body(req);
    if (url.pathname === '/identity/token' && req.method === 'POST') {
      S.iamCalls++; S.iamBodies.push(b);
      if (maybeFail('iam', res)) return;
      const p = new URLSearchParams(b);
      if (p.get('grant_type') !== 'urn:ibm:params:oauth:grant-type:apikey' || p.get('apikey') !== API_KEY) return json(res, 400, { errorMessage: 'bad apikey' });
      return json(res, 200, { access_token: `tok-${S.iamCalls}`, token_type: 'Bearer', expires_in: S.expiresIn, expiration: Math.floor(Date.now() / 1000) + S.expiresIn });
    }
    const auth = req.headers.authorization ?? '';
    S.authHeaders.push(auth);
    if (!auth.startsWith('Bearer tok-')) return json(res, 401, { detail: 'unauthorized' });
    if (url.pathname === '/v1/orchestrate/agents' && req.method === 'GET') {
      S.agentListCalls++; S.agentListQueries.push(url.search);
      if (maybeFail('agents', res)) return;
      const names = url.searchParams.getAll('names');
      const all = Object.entries(AGENT_IDS).map(([name, id]) => ({ id, name, llm: 'watsonx/meta-llama/llama-3-3-70b-instruct', description: 'x', style: 'default' }));
      return json(res, 200, names.length ? all.filter((a) => names.includes(a.name)) : all);
    }
    if (url.pathname === '/v1/orchestrate/runs' && req.method === 'POST') {
      if (maybeFail('runs', res)) return;
      const parsed = JSON.parse(b); S.runBodies.push(parsed);
      const thread = parsed.thread_id ?? randomUUID();
      const runId = randomUUID();
      const reply = S.replies.shift() ?? '{}';
      runs.set(runId, { thread, polls: 0, reply });
      const msgs = threads.get(thread) ?? [];
      msgs.push({ id: randomUUID(), role: 'user', content: [{ response_type: 'text', text: parsed.message.content }], created_on: new Date(Date.now() + msgs.length).toISOString() });
      threads.set(thread, msgs);
      return json(res, 200, { thread_id: thread, run_id: runId, task_id: randomUUID(), message_id: randomUUID() });
    }
    const runM = url.pathname.match(/^\/v1\/orchestrate\/runs\/([^/]+)$/);
    if (runM && req.method === 'GET') {
      const r = runs.get(runM[1]);
      if (!r) return json(res, 404, { detail: 'no run' });
      if (typeof r.reply === 'object' && 'hang' in r.reply) return json(res, 200, { id: runM[1], thread_id: r.thread, status: 'running' });
      if (typeof r.reply === 'object' && r.reply.status === 'failed') return json(res, 200, { id: runM[1], thread_id: r.thread, status: 'failed', last_error: r.reply.error });
      if (r.polls++ < S.pendingPolls) return json(res, 200, { id: runM[1], thread_id: r.thread, status: 'running' });
      const msgs = threads.get(r.thread)!;
      if (!msgs.some((m) => m.run === runM[1])) msgs.push({ id: randomUUID(), run: runM[1], role: 'assistant', content: [{ response_type: 'text', text: r.reply }], created_on: new Date(Date.now() + msgs.length).toISOString() });
      return json(res, 200, { id: runM[1], thread_id: r.thread, status: 'completed' });
    }
    const thM = url.pathname.match(/^\/v1\/orchestrate\/threads\/([^/]+)\/messages$/);
    if (thM && req.method === 'GET') return json(res, 200, threads.get(thM[1]) ?? []);
    json(res, 404, { detail: `no route ${req.method} ${url.pathname}` });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(reset);

const env = (extra: Record<string, string> = {}) => ({ WXO_INSTANCE_URL: base, WXO_API_KEY: API_KEY, WXO_IAM_URL: `${base}/identity/token`, ...extra });
const svc = (extra: Record<string, string> = {}) => createAiService({ env: env(extra), pollIntervalMs: 5, retryDelayMs: 5 });

const DOCS: DocText[] = [{
  documentId: 'doc-1', title: 'Tender Pack', sections: [
    { section: '3. Key Dates', text: 'The bid submission deadline is 5 November 2026 at 13:00 Kuwait time.' },
    { section: '4. Bid Security / ضمان العطاء', text: 'A bid security of 2% valid for 150 days. ضمان عطاء بنسبة 2% ساري لمدة 150 يوماً.' },
  ],
}];
const TENDER = { titleEn: 'Monitoring Platform', titleAr: 'منصة المراقبة' };

describe('IAM token', () => {
  test('fetches with the IBM apikey grant and caches until 5 min before expiry', async () => {
    const c = new OrchestrateClient({ instanceUrl: base, apiKey: API_KEY, iamUrl: `${base}/identity/token` });
    assert.equal(await c.getToken(), 'tok-1');
    assert.equal(await c.getToken(), 'tok-1');
    assert.equal(S.iamCalls, 1);
    const form = new URLSearchParams(S.iamBodies[0]);
    assert.equal(form.get('grant_type'), 'urn:ibm:params:oauth:grant-type:apikey');
  });

  test('refreshes when the token is within 5 minutes of expiry', async () => {
    S.expiresIn = 200; // < 300 s safety window → never cached
    const c = new OrchestrateClient({ instanceUrl: base, apiKey: API_KEY, iamUrl: `${base}/identity/token` });
    await c.getToken(); await c.getToken();
    assert.equal(S.iamCalls, 2);
  });

  test('accepts an IAM base URL and appends /identity/token', async () => {
    const c = new OrchestrateClient({ instanceUrl: base, apiKey: API_KEY, iamUrl: base });
    assert.equal(await c.getToken(), 'tok-1');
  });

  test('IAM error includes HTTP status but never the API key', async () => {
    S.fail.iam = [400, 400];
    const c = new OrchestrateClient({ instanceUrl: base, apiKey: API_KEY, iamUrl: `${base}/identity/token`, retryDelayMs: 1 });
    await assert.rejects(c.getToken(), (e: Error) => {
      assert.ok(e instanceof OrchestrateError);
      assert.match(e.message, /HTTP 400/);
      assert.ok(!e.message.includes(API_KEY), 'api key leaked into error');
      return true;
    });
  });
});

describe('agent resolution and invocation', () => {
  test('resolves agent name → id once (cached) and sends agent_id on the run', async () => {
    S.replies = ['{"answer":"5 November 2026 at 13:00.","language":"en","notFound":false,"citations":[{"documentId":"doc-1","section":"3. Key Dates","quote":"5 November 2026 at 13:00"}]}',
      '{"answer":"5 November 2026 at 13:00.","language":"en","notFound":false,"citations":[{"documentId":"doc-1","section":"3. Key Dates"}]}'];
    const ai = svc();
    const r1 = await ai.draftClarification({ tender: TENDER, question: 'When is the deadline?', documents: DOCS, priorAnswers: [] });
    await ai.draftClarification({ tender: TENDER, question: 'When is the deadline?', documents: DOCS, priorAnswers: [] });
    assert.equal(S.agentListCalls, 1);
    assert.match(S.agentListQueries[0], /names=tenderflow_clarification_assistant/);
    assert.equal(S.runBodies[0].agent_id, AGENT_IDS.tenderflow_clarification_assistant);
    assert.equal(S.runBodies[0].message.role, 'user');
    assert.equal(S.iamCalls, 1, 'token reused across calls');
    assert.equal(r1.agent, 'tenderflow_clarification_assistant');
    assert.equal(r1.model, 'watsonx/meta-llama/llama-3-3-70b-instruct');
    assert.equal(r1.output.notFound, false);
    assert.equal(r1.output.language, 'en');
    assert.deepEqual(r1.citations, [{ documentId: 'doc-1', title: 'Tender Pack', section: '3. Key Dates', quote: '5 November 2026 at 13:00' }]);
    // prompt carries DOC markers and the strict rules
    const prompt: string = S.runBodies[0].message.content;
    assert.match(prompt, /\[DOC doc-1 \| Tender Pack \| 3\. Key Dates\]/);
    assert.match(prompt, /Return ONLY one JSON object/);
  });

  test('accepts an agent id (UUID) directly', async () => {
    S.replies = ['{"answer":"x","language":"en","notFound":true,"citations":[]}'];
    const ai = svc({ WXO_AGENT_CLARIFICATION: AGENT_IDS.tenderflow_clarification_assistant });
    const r = await ai.draftClarification({ tender: TENDER, question: 'Budget?', documents: DOCS, priorAnswers: [] });
    assert.equal(S.runBodies[0].agent_id, AGENT_IDS.tenderflow_clarification_assistant);
    assert.equal(r.output.notFound, true);
    assert.deepEqual(r.output.citations, []);
  });

  test('missing agent name gives a clear error', async () => {
    const ai = svc({ WXO_AGENT_CLARIFICATION: 'no_such_agent' });
    await assert.rejects(ai.draftClarification({ tender: TENDER, question: 'q?', documents: DOCS, priorAnswers: [] }), /agent "no_such_agent" was not found/);
  });

  test('parses fenced JSON with leading prose', async () => {
    S.replies = ['Here is the result:\n```json\n{"answer":"2% for 150 days","language":"en","notFound":false,"citations":[{"documentId":"doc-1","section":"4. Bid Security / ضمان العطاء"}]}\n```\nThanks.'];
    const r = await svc().draftClarification({ tender: TENDER, question: 'Bid security?', documents: DOCS, priorAnswers: [] });
    assert.equal(r.output.answer, '2% for 150 days');
    assert.equal((r.raw as any).repaired, false);
  });

  test('one repair turn on invalid JSON, sent on the same thread', async () => {
    S.replies = ['The deadline is 5 November.', '{"answer":"5 November 2026","language":"en","notFound":false,"citations":[{"documentId":"doc-1","section":"3. Key Dates"}]}'];
    const r = await svc().draftClarification({ tender: TENDER, question: 'Deadline?', documents: DOCS, priorAnswers: [] });
    assert.equal(S.runBodies.length, 2);
    assert.ok(S.runBodies[1].thread_id, 'repair continues the same thread');
    assert.match(S.runBodies[1].message.content, /could not be accepted/);
    assert.equal((r.raw as any).repaired, true);
    assert.equal(r.output.answer, '5 November 2026');
  });

  test('throws AiOutputError when output is still invalid after the repair', async () => {
    S.replies = ['not json', 'still not json'];
    await assert.rejects(svc().draftClarification({ tender: TENDER, question: 'Deadline?', documents: DOCS, priorAnswers: [] }), (e: Error) => e instanceof AiOutputError);
    assert.equal(S.runBodies.length, 2);
  });

  test('drops invented citations and unverifiable quotes', async () => {
    S.replies = [JSON.stringify({
      answer: 'The deadline is 5 November 2026.', language: 'en', notFound: false,
      citations: [
        { documentId: 'doc-1', section: '3. Key Dates', quote: 'this sentence is not in the document' },
        { documentId: 'doc-404', section: '3. Key Dates' },
        { documentId: 'doc-1', section: '9. Imaginary Section' },
        'DOC doc-1 | Tender Pack | 4. Bid Security / ضمان العطاء',
      ],
    })];
    const r = await svc().draftClarification({ tender: TENDER, question: 'Deadline?', documents: DOCS, priorAnswers: [] });
    assert.deepEqual(r.output.citations.map((c) => c.section), ['3. Key Dates', '4. Bid Security / ضمان العطاء']);
    assert.equal(r.output.citations[0].quote, undefined, 'unverifiable quote removed');
    assert.equal((r.raw as any).droppedCitations, 2);
  });

  test('answer whose citations are all invented is rejected (repair, then error)', async () => {
    const bad = JSON.stringify({ answer: 'x', language: 'en', notFound: false, citations: [{ documentId: 'zzz', section: 'nope' }] });
    S.replies = [bad, bad];
    await assert.rejects(svc().draftClarification({ tender: TENDER, question: 'q?', documents: DOCS, priorAnswers: [] }), /none of the citations matched/);
  });

  test('Arabic question → language ar', async () => {
    S.replies = ['{"answer":"150 يوماً","language":"ar","notFound":false,"citations":[{"documentId":"doc-1","section":"4. Bid Security / ضمان العطاء","quote":"ساري لمدة 150 يوماً"}]}'];
    const r = await svc().draftClarification({ tender: TENDER, question: 'ما مدة سريان ضمان العطاء؟', documents: DOCS, priorAnswers: [] });
    assert.equal(r.output.language, 'ar');
    assert.equal(r.citations[0].quote, 'ساري لمدة 150 يوماً');
    assert.match(S.runBodies[0].message.content, /"language" must be "ar"/);
  });

  test('failed run surfaces last_error', async () => {
    S.replies = [{ status: 'failed', error: 'model quota exceeded' }];
    await assert.rejects(svc().draftClarification({ tender: TENDER, question: 'q?', documents: DOCS, priorAnswers: [] }), /status "failed": model quota exceeded/);
  });
});

describe('timeouts and retries', () => {
  test('a run that never completes times out', async () => {
    S.replies = [{ hang: true }];
    const ai = svc({ WXO_TIMEOUT_MS: '300' });
    const t0 = Date.now();
    await assert.rejects(ai.draftClarification({ tender: TENDER, question: 'q?', documents: DOCS, priorAnswers: [] }), /did not complete within 300 ms|timed out/);
    assert.ok(Date.now() - t0 < 3000);
  });

  test('a hanging HTTP request times out', async () => {
    const hang = createServer(() => { /* never responds */ });
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(hang.address() as AddressInfo).port}`;
    try {
      const c = new OrchestrateClient({ instanceUrl: url, apiKey: API_KEY, iamUrl: `${url}/identity/token`, timeoutMs: 200 });
      await assert.rejects(c.getToken(), /timed out after 200 ms/);
    } finally { hang.closeAllConnections(); hang.close(); }
  });

  test('retries once on 503 / 429 then succeeds', async () => {
    S.fail.agents = [503];
    S.fail.runs = [429];
    S.replies = ['{"answer":"ok","language":"en","notFound":false,"citations":[{"documentId":"doc-1","section":"3. Key Dates"}]}'];
    const r = await svc().draftClarification({ tender: TENDER, question: 'q?', documents: DOCS, priorAnswers: [] });
    assert.equal(r.output.answer, 'ok');
    assert.equal(S.agentListCalls, 2);
  });

  test('gives up after one retry with status and IBM error body, no secrets', async () => {
    S.fail.agents = [500, 500];
    await assert.rejects(svc().draftClarification({ tender: TENDER, question: 'q?', documents: DOCS, priorAnswers: [] }), (e: Error) => {
      assert.ok(e instanceof OrchestrateError);
      assert.equal((e as OrchestrateError).status, 500);
      assert.match(e.message, /list agents failed: HTTP 500/);
      assert.match(e.message, /fake 500 for agents/);
      assert.ok(!e.message.includes(API_KEY));
      assert.ok(!/tok-\d/.test(e.message));
      return true;
    });
    assert.equal(S.agentListCalls, 2);
  });
});

describe('configuration', () => {
  test('not configured → isConfigured false, ping not ok, methods throw AiNotConfiguredError', async () => {
    const ai = createAiService({ env: {} });
    assert.equal(ai.isConfigured(), false);
    const p = await ai.ping();
    assert.equal(p.ok, false);
    assert.match(p.detail, /WXO_INSTANCE_URL/);
    for (const call of [
      () => ai.draftClarification({ tender: TENDER, question: 'q', documents: DOCS, priorAnswers: [] }),
      () => ai.checkTenderPack({ tender: { ...TENDER, category: 'IT', deadline: '2026-11-05', criteria: [], requiredDocuments: [] }, documents: DOCS, language: 'en' }),
      () => ai.screenCompliance({ requiredDocuments: [], bid: { bidId: 'b', vendorName: 'v', documents: DOCS } }),
    ]) {
      await assert.rejects(call(), (e: Error) => e instanceof AiNotConfiguredError && (e as AiNotConfiguredError).code === 'AI_NOT_CONFIGURED');
    }
    assert.equal(S.iamCalls, 0);
  });

  test('API key alone is not enough', () => {
    assert.equal(createAiService({ env: { WXO_API_KEY: 'k' } }).isConfigured(), false);
    assert.equal(createAiService({ env: env() }).isConfigured(), true);
  });

  test('ping reports token OK and which agents exist', async () => {
    const p = await svc({ WXO_AGENT_COMPLIANCE: 'missing_agent' }).ping();
    assert.equal(p.ok, false);
    assert.match(p.detail, /IAM token OK/);
    assert.match(p.detail, /tenderflow_pack_checker=found/);
    assert.match(p.detail, /missing_agent=MISSING/);
    const ok = await svc().ping();
    assert.equal(ok.ok, true);
  });
});

describe('pack check and compliance', () => {
  test('pack check validates findings and keeps only real citations', async () => {
    S.replies = [JSON.stringify({ summary: 'Mostly complete.', findings: [
      { severity: 'high', item: 'No evaluation method', detail: 'The pack has no evaluation section.', citation: null },
      { severity: 'LOW', item: 'Time zone', detail: 'Deadline time zone stated.', citation: { documentId: 'doc-1', section: '3. Key Dates' } },
      { severity: 'MEDIUM', item: 'Made-up', detail: 'x', citation: { documentId: 'doc-1', section: 'Annex Z' } },
    ] })];
    const r = await svc().checkTenderPack({ tender: { ...TENDER, category: 'IT', deadline: '2026-11-05T13:00:00+03:00', criteria: [{ key: 'tech', weight: 70 }], requiredDocuments: [] }, documents: DOCS, language: 'en' });
    assert.equal(r.agent, 'tenderflow_pack_checker');
    assert.equal(r.output.findings.length, 3);
    assert.equal(r.output.findings[0].severity, 'HIGH');
    assert.equal(r.output.findings[1].citation?.section, '3. Key Dates');
    assert.equal(r.output.findings[2].citation, undefined);
    assert.equal(r.citations.length, 1);
  });

  test('compliance: one item per requirement, PRESENT/MISSING/UNCLEAR only, repair when incomplete', async () => {
    const req = [{ key: 'bid_security', nameEn: 'Bid security', nameAr: 'ضمان العطاء' }, { key: 'cr_copy', nameEn: 'CR copy', nameAr: 'السجل التجاري' }];
    S.replies = [
      JSON.stringify({ items: [{ requirement: 'bid_security', status: 'PRESENT', evidence: 'found', citation: { documentId: 'doc-1', section: '4. Bid Security / ضمان العطاء' } }] }),
      JSON.stringify({ items: [
        { requirement: 'bid_security', status: 'PRESENT', evidence: 'found', citation: { documentId: 'doc-1', section: '4. Bid Security / ضمان العطاء' } },
        { requirement: 'cr_copy', status: 'MISSING', evidence: 'no CR', citation: null },
        { requirement: 'invented_req', status: 'PRESENT', evidence: 'x', citation: null },
      ] }),
    ];
    const r = await svc().screenCompliance({ requiredDocuments: req, bid: { bidId: 'bid-1', vendorName: 'Vendor X', documents: DOCS } });
    assert.match(S.runBodies[1].message.content, /no item returned for requirement key\(s\): cr_copy/);
    assert.deepEqual(r.output.items.map((i) => [i.requirement, i.status]), [['bid_security', 'PRESENT'], ['cr_copy', 'MISSING']]);
    assert.ok(!('score' in r.output.items[0]));
  });

  test('compliance rejects scores/other statuses', async () => {
    const bad = JSON.stringify({ items: [{ requirement: 'cr_copy', status: 'COMPLIANT', score: 90 }] });
    S.replies = [bad, bad];
    await assert.rejects(svc().screenCompliance({ requiredDocuments: [{ key: 'cr_copy', nameEn: 'CR', nameAr: 'س' }], bid: { bidId: 'b', vendorName: 'v', documents: DOCS } }), /PRESENT, MISSING or UNCLEAR/);
  });
});
