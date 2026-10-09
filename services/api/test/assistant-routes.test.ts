// API tests of the Orchestrate assistant routes (features/assistant.ts) against the seeded demo data and the local
// FAKE Orchestrate server (test/fakes/orchestrate.ts): access rules per role, ai_run recording (kind, subject_id,
// tender_id), not-configured → 503, chat context scoping (never sealed/opened bid contents, never other vendors' data),
// thread ownership, vendor ranking limited to eligible open tenders, committee narrative saved to the content store.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, fileForm, login, makeTenant, makeUser, startApp, type Running } from './helpers.js';
import { startFakeOrchestrate, type FakeCall, type FakeOrchestrate } from './fakes/orchestrate.js';

const DEMO_PASSWORD = 'Demo-Passw0rd!';
const J = (o: unknown) => JSON.stringify(o);
const markers = (p: string) => [...p.matchAll(/\[DOC ([^|\]]+?) \| [^|\]]*? \| ([^\]]+?)\]/g)].map((m) => ({ documentId: m[1].trim(), section: m[2].trim() }));

/** Valid, minimal agent replies built from the prompt TenderFlow sent (no numbers invented). */
function scripted(c: FakeCall): string {
  const p = c.prompt;
  switch (c.agentName) {
    case 'tenderflow_assistant':
      return J({ answer: 'Here is what the TenderFlow context says about your work.', notFound: false, citations: markers(p).slice(0, 1) });
    case 'tenderflow_request_classifier':
      return J({ tenderType: 'PUBLIC_TENDER', activityCodes: ['IT-01'], urgency: 'MEDIUM', estimatedBudget: 650000,
        summaryEn: 'The department requests a smart meter data management platform.', summaryAr: 'تطلب الإدارة منصة لإدارة بيانات العدادات الذكية.',
        citations: markers(p).slice(0, 1) });
    case 'tenderflow_notice_drafter': {
      const num = /Tender number: (\S+)/.exec(p)?.[1] ?? '';
      return J({ noticeAr: `تعلن الهيئة عن طرح المناقصة ${num}.`, noticeEn: `The Authority announces tender ${num}.`, citations: markers(p).slice(0, 1) });
    }
    case 'tenderflow_relevance_matcher': {
      const ids = [...p.matchAll(/^- id (\S+) — /gm)].map((m) => m[1]);
      return J({ ranked: ids.map((id, i) => ({ id, score: 90 - i * 10, reasonsEn: 'Matching activity code.', reasonsAr: 'رمز نشاط مطابق.' })) });
    }
    case 'tenderflow_evaluation_narrator':
      return J({ narrativeEn: 'The committee evaluated the opened bids against the published criteria.', narrativeAr: 'قيّمت اللجنة العطاءات المفتوحة وفق المعايير المعلنة.' });
    case 'tenderflow_grade_reviewer': {
      const keys = [...p.matchAll(/^- ([A-Z0-9_-]+) — /gm)].map((m) => m[1]);
      return J({ items: keys.map((k) => ({ requirement: k, status: 'MISSING', evidence: 'Not found in the uploaded text.', citation: null })) });
    }
    default:
      return '{}';
  }
}

// ------------------------------------------------------------------ not configured

test('not configured: chat and agents return 503 AI_NOT_CONFIGURED and the failed run is recorded', async () => {
  for (const k of Object.keys(process.env)) if (k.startsWith('WXO_')) delete process.env[k];
  const run = await startApp();
  try {
    await makeTenant(run, 'nc');
    await makeUser(run, 'nc', 'officer', ['PROCUREMENT_OFFICER']);
    const tok = await login(run, 'nc', 'officer');
    const st = await api(run, 'GET', '/api/v1/assistant/status', { token: tok });
    assert.equal(st.body.configured, false);
    const r = await api(run, 'POST', '/api/v1/assistant/chat', { token: tok, json: { message: 'What is waiting for me?' } });
    assert.equal(r.status, 503, r.text);
    assert.equal(r.body.code, 'AI_NOT_CONFIGURED');
    const rows = await run.handle.ctx.db.query<any>(`SELECT kind, status, tender_id FROM ai_runs WHERE tenant_id='nc'`);
    assert.deepEqual(rows.map((x) => [x.kind, x.status, x.tender_id]), [['ASSISTANT_CHAT', 'ERROR', null]]);
    const tasks = await api(run, 'GET', '/api/v1/assistant/my-tasks', { token: tok });
    assert.equal(tasks.status, 200, 'my-tasks needs no AI');
    assert.deepEqual(tasks.body, []);
    assert.equal((await api(run, 'POST', '/api/v1/assistant/chat', { json: { message: 'x' } })).status, 401);
  } finally { await run.stop(); }
});

// ------------------------------------------------------------------ configured (fake Orchestrate) + demo seed

let fake: FakeOrchestrate;
let run: Running;
const tok: Record<string, string> = {};
const ids: Record<string, string> = {};

before(async () => {
  fake = await startFakeOrchestrate();
  fake.reply = scripted;
});
after(async () => {
  if (run) await run.stop();
  await fake.close();
  for (const k of Object.keys(fake.env)) delete process.env[k];
});

const callsTo = (agent: string) => fake.calls.filter((c) => c.agentName === agent);
const lastPrompt = (agent: string) => callsTo(agent).at(-1)?.prompt ?? '';

test('seeded app with Orchestrate configured: logins and ids', async () => {
  Object.assign(process.env, fake.env); // createAiService() reads process.env when the app is created
  // Document intelligence auto-runs are covered by document-intelligence.test.ts; here they would consume scripted replies.
  run = await startApp(undefined, { SEED_DEMO: 'true', DEMO_PASSWORD, DOC_AI_AUTO: 'false' });
  for (const u of ['officer', 'director', 'chair', 'evaluator1', 'admin', 'auditor', 'vendor1', 'vendor2']) tok[u] = await login(run, 'kea', u, DEMO_PASSWORD);
  tok.gciaVendor3 = await login(run, 'gcia', 'vendor3', DEMO_PASSWORD);
  const list = await api(run, 'GET', '/api/v1/tenders', { token: tok.officer });
  for (const t of list.body) ids[t.tenderNumber] = t.id;
  assert.ok(ids['KEA-2026-101'] && ids['KEA-2026-102'] && ids['KEA-2026-088']);
  const reqs = await api(run, 'GET', '/api/v1/requests', { token: tok.officer });
  ids.request = reqs.body[0].id;
  const v = await run.handle.ctx.db.query<{ username: string; vendor_id: string }>(`SELECT username, vendor_id FROM users WHERE tenant_id='kea' AND vendor_id IS NOT NULL`);
  for (const x of v) ids[x.username] = x.vendor_id;
  const st = await api(run, 'GET', '/api/v1/assistant/status', { token: tok.vendor1 });
  assert.equal(st.body.configured, true);
});

test('my-tasks: computed per role from TenderFlow state', async () => {
  const kinds = async (u: string) => (await api(run, 'GET', '/api/v1/assistant/my-tasks', { token: tok[u] })).body.map((t: any) => `${t.kind}:${t.tenderNumber ?? ''}`);
  assert.ok((await kinds('officer')).includes('ANSWER_CLARIFICATIONS:KEA-2026-102'));
  assert.ok((await kinds('director')).includes('APPROVE_TENDER:KEA-2026-101'), 'director approves the draft with a pack');
  assert.ok(!(await kinds('officer')).includes('APPROVE_TENDER:KEA-2026-101'), 'the creator never gets the approval task');
  assert.ok((await kinds('chair')).includes('OPEN_BIDS:KEA-2026-088'));
  assert.ok(!(await kinds('vendor1')).some((k: string) => k.startsWith('OPEN_BIDS') || k.startsWith('APPROVE')));
});

test('chat: role-scoped context, thread continuity and thread ownership', async () => {
  const r = await api(run, 'POST', '/api/v1/assistant/chat', { token: tok.officer, json: { message: 'What is waiting for me?', page: '/procurement' } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.agent, 'tenderflow_assistant');
  assert.ok(r.body.answer && r.body.threadId && r.body.runId);
  assert.equal(r.body.citations.length, 1);
  const p = lastPrompt('tenderflow_assistant');
  assert.match(p, /Answer 1 open clarification question\(s\) on KEA-2026-102/);
  assert.match(p, /Role\(s\): PROCUREMENT_OFFICER/);
  const run1 = (await run.handle.ctx.db.query<any>('SELECT * FROM ai_runs WHERE id=$1', [r.body.runId]))[0];
  assert.equal(run1.kind, 'ASSISTANT_CHAT');
  assert.equal(run1.tender_id, null);

  const f = await api(run, 'POST', '/api/v1/assistant/chat', { token: tok.officer, json: { message: 'ما المطلوب مني اليوم؟', threadId: r.body.threadId } });
  assert.equal(f.status, 201, f.text);
  assert.equal(callsTo('tenderflow_assistant').at(-1)!.continued, true);
  assert.equal(f.body.threadId, r.body.threadId);

  const stolen = await api(run, 'POST', '/api/v1/assistant/chat', { token: tok.director, json: { message: 'continue', threadId: r.body.threadId } });
  assert.equal(stolen.status, 404, 'another user cannot continue the officer\'s thread');
  assert.equal(stolen.body.code, 'THREAD_NOT_FOUND');
  assert.equal((await api(run, 'POST', '/api/v1/assistant/chat', { token: tok.officer, json: {} })).status, 400);
});

// Strings that exist only inside the sealed bid files of KEA-2026-088 (seed/files/vendor*-proposal.md).
const SEALED = ['123,500.000', 'BB-QA-5521', 'ISMS-88213', 'BB-NB-1093', 'ISMS-55102', 'BB-SL-7740'];

test('chat: sealed bid contents and other vendors\' data never reach the agent', async () => {
  const chair = await api(run, 'POST', '/api/v1/assistant/chat', { token: tok.chair, json: { message: 'Summarise this tender', tenderId: ids['KEA-2026-088'] } });
  assert.equal(chair.status, 201, chair.text);
  let p = lastPrompt('tenderflow_assistant');
  assert.match(p, /KEA-2026-088/);
  assert.match(p, /Bids received: 3 \(bid contents are sealed or restricted/);
  for (const s of SEALED) assert.ok(!p.includes(s), `chair context leaked "${s}"`);

  const v1 = await api(run, 'POST', '/api/v1/assistant/chat', { token: tok.vendor1, json: { message: 'What did the other bidders offer?', tenderId: ids['KEA-2026-088'] } });
  assert.equal(v1.status, 201, v1.text);
  p = lastPrompt('tenderflow_assistant');
  assert.match(p, /Your bid: submitted/);
  for (const s of [...SEALED, 'Nakheel Bitforge', 'Sadu Logic', 'Bids received']) assert.ok(!p.includes(s), `vendor context leaked "${s}"`);

  const draft = await api(run, 'POST', '/api/v1/assistant/chat', { token: tok.vendor1, json: { message: 'x', tenderId: ids['KEA-2026-101'] } });
  assert.equal(draft.status, 404, 'a vendor cannot ask about a DRAFT tender');
  const bad = await api(run, 'POST', '/api/v1/assistant/chat', { token: tok.vendor1, json: { message: 'x', tenderId: 'not-a-uuid' } });
  assert.equal(bad.status, 400);

  // Paid documents (gcia RFP): only the vendor who bought them gets the pack text in the context.
  const [g1, g2] = [await login(run, 'gcia', 'vendor1', DEMO_PASSWORD), await login(run, 'gcia', 'vendor2', DEMO_PASSWORD)];
  const bw = (await api(run, 'GET', '/api/v1/tenders', { token: g2 })).body.find((x: any) => x.titleEn === 'Fishing Harbour Breakwater Repair');
  await api(run, 'POST', '/api/v1/assistant/chat', { token: g2, json: { message: 'What is the scope?', tenderId: bw.id } });
  assert.ok(!lastPrompt('tenderflow_assistant').includes('Breakwater RFP pack'), 'pack text withheld until purchase');
  assert.match(lastPrompt('tenderflow_assistant'), /not included until you buy them/);
  await api(run, 'POST', '/api/v1/assistant/chat', { token: g1, json: { message: 'What is the scope?', tenderId: bw.id } });
  assert.match(lastPrompt('tenderflow_assistant'), /Breakwater RFP pack/);
});

test('request classification: staff only, letter text from the content store, run keyed by subject_id', async () => {
  assert.equal((await api(run, 'POST', `/api/v1/requests/${ids.request}/ai/classify`, { token: tok.vendor1 })).status, 403);
  assert.equal((await api(run, 'POST', `/api/v1/requests/${ids.request}/ai/classify`, { token: tok.evaluator1 })).status, 403);
  const r = await api(run, 'POST', `/api/v1/requests/${ids.request}/ai/classify`, { token: tok.officer });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.kind, 'REQUEST_CLASSIFY');
  assert.equal(r.body.subjectId, ids.request);
  assert.equal(r.body.tenderId, null);
  assert.equal(r.body.response.tenderType, 'PUBLIC_TENDER');
  assert.equal(r.body.response.estimatedBudget, 650000);
  assert.equal(r.body.request.letterExtracted, true);
  assert.match(lastPrompt('tenderflow_request_classifier'), /120,000 smart electricity meters/);
  const rev = await api(run, 'POST', `/api/v1/ai-runs/${r.body.id}/review`, { token: tok.officer, json: { decision: 'ACCEPTED' } });
  assert.equal(rev.status, 200, rev.text);
});

test('gazette notice: officer only; the draft is saved as a DRAFT notice by a separate human action', async () => {
  const t = ids['KEA-2026-102'];
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${t}/ai/notice`, { token: tok.director, json: { channel: 'KUWAIT_ALYOUM' } })).status, 403);
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${t}/ai/notice`, { token: tok.officer, json: { channel: 'TWITTER' } })).status, 400);
  const r = await api(run, 'POST', `/api/v1/tenders/${t}/ai/notice`, { token: tok.officer, json: { channel: 'KUWAIT_ALYOUM' } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.kind, 'GAZETTE_NOTICE');
  assert.equal(r.body.tenderId, t);
  assert.match(r.body.response.noticeAr, /KEA-2026-102/);
  assert.match(lastPrompt('tenderflow_notice_drafter'), /Kuwait Al-Youm/);
  const pubsBefore = await run.handle.ctx.db.query(`SELECT 1 FROM publications WHERE tender_id=$1 AND channel='KUWAIT_ALYOUM'`, [t]);
  assert.equal(pubsBefore.length, 0, 'the AI run itself saves nothing');
  const saved = await api(run, 'POST', `/api/v1/tenders/${t}/notices`, { token: tok.officer,
    json: { channel: 'KUWAIT_ALYOUM', noticeEn: r.body.response.noticeEn, noticeAr: r.body.response.noticeAr, aiRunId: r.body.id } });
  assert.equal(saved.status, 201, saved.text);
  assert.equal(saved.body.status, 'DRAFT');
  assert.equal(saved.body.aiRunId, r.body.id);
});

test('relevance: staff ranks only rule-eligible vendors; vendors rank only their eligible open tenders', async () => {
  const t = ids['KEA-2026-102'];
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${t}/ai/relevance`, { token: tok.vendor1 })).status, 403);
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${ids['KEA-2026-101']}/ai/relevance`, { token: tok.officer })).status, 409, 'PUBLISHED only');
  const r = await api(run, 'POST', `/api/v1/tenders/${t}/ai/relevance`, { token: tok.officer });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.kind, 'RELEVANCE_MATCH');
  const ranked = r.body.response.ranked.map((x: any) => x.id).sort();
  assert.deepEqual(ranked, [ids.vendor1, ids.vendor2, ids.vendor3].sort(), 'vendor4 (pending) is never a candidate');
  assert.ok(!lastPrompt('tenderflow_relevance_matcher').includes('Dana Byteworks'));
  assert.ok(r.body.response.ranked[0].nameEn, 'display names added by TenderFlow');

  assert.equal((await api(run, 'GET', '/api/v1/vendor/ai/tenders-for-me', { token: tok.officer })).status, 403);
  const before = await api(run, 'GET', '/api/v1/vendor/ai/tenders-for-me', { token: tok.vendor1 });
  assert.equal(before.status, 200, before.text);
  assert.equal(before.body.run, null);
  const mine = await api(run, 'POST', '/api/v1/vendor/ai/tenders-for-me', { token: tok.vendor1 });
  assert.equal(mine.status, 201, mine.text);
  assert.deepEqual(mine.body.ranked.map((x: any) => x.tenderNumber), ['KEA-2026-102'], 'only open tenders the vendor is eligible for');
  assert.ok(mine.body.ranked[0].reasonsEn && mine.body.ranked[0].reasonsAr);
  const stored = (await run.handle.ctx.db.query<any>('SELECT subject_id, tender_id FROM ai_runs WHERE id=$1', [mine.body.run.id]))[0];
  assert.deepEqual([stored.subject_id, stored.tender_id], [ids.vendor1, null]);
  const after = await api(run, 'GET', '/api/v1/vendor/ai/tenders-for-me', { token: tok.vendor1 });
  assert.equal(after.body.run.id, mine.body.run.id);
  const v2 = await api(run, 'GET', '/api/v1/vendor/ai/tenders-for-me', { token: tok.vendor2 });
  assert.equal(v2.body.run, null, 'a vendor never sees another vendor\'s ranking');

  const n = fake.calls.length;
  const g3 = await api(run, 'POST', '/api/v1/vendor/ai/tenders-for-me', { token: tok.gciaVendor3 });
  assert.equal(g3.status, 201, g3.text);
  assert.equal(g3.body.eligibleOpenCount, 0, 'Third grade vendor is not eligible for the Second-grade RFP');
  assert.equal(fake.calls.length, n, 'no agent call when nothing is eligible');
});

test('evaluation narrative: chair only, numbers checked, saved to the content store by the chair', async () => {
  const t = ids['KEA-2026-088'];
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${t}/ai/narrative`, { token: tok.chair })).status, 409, 'not before evaluation');
  const opened = await api(run, 'POST', `/api/v1/tenders/${t}/open`, { token: tok.chair, json: { attendees: ['Chair (demo)'] } });
  assert.equal(opened.status, 200, opened.text);
  const bids = await api(run, 'GET', `/api/v1/tenders/${t}/bids`, { token: tok.chair });
  for (const [i, b] of bids.body.entries()) {
    const ev = await api(run, 'POST', `/api/v1/bids/${b.id}/evaluation`, { token: tok.evaluator1, json: { scores: [
      { criterion: 'technical', score: 80 - i, comment: 'ok' }, { criterion: 'experience', score: 70, comment: '' }, { criterion: 'price', score: 60 + i, comment: '' }] } });
    assert.equal(ev.status, 200, ev.text);
  }
  // After opening, the assistant context still carries no bid contents.
  await api(run, 'POST', '/api/v1/assistant/chat', { token: tok.chair, json: { message: 'Summarise this tender', tenderId: t } });
  for (const s of SEALED) assert.ok(!lastPrompt('tenderflow_assistant').includes(s), `opened-bid content leaked "${s}"`);

  assert.equal((await api(run, 'POST', `/api/v1/tenders/${t}/ai/narrative`, { token: tok.evaluator1 })).status, 403);
  const r = await api(run, 'POST', `/api/v1/tenders/${t}/ai/narrative`, { token: tok.chair });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.kind, 'EVALUATION_NARRATIVE');
  const np = lastPrompt('tenderflow_evaluation_narrator');
  assert.match(np, /"weightedTotal"/);
  for (const s of SEALED) assert.ok(!np.includes(s));

  // A narrative that changes a score is rejected (after one repair turn) and recorded as an ERROR run.
  const bad = J({ narrativeEn: 'The winning bid scored 99.9.', narrativeAr: 'حصل العطاء على 99.9.' });
  fake.queue.push(bad, bad);
  const rej = await api(run, 'POST', `/api/v1/tenders/${t}/ai/narrative`, { token: tok.chair });
  assert.equal(rej.status, 502, rej.text);
  assert.match(rej.body.message, /99\.9/);

  assert.equal((await api(run, 'POST', `/api/v1/ai-runs/${r.body.id}/save-narrative`, { token: tok.evaluator1, json: {} })).status, 403);
  const saved = await api(run, 'POST', `/api/v1/ai-runs/${r.body.id}/save-narrative`, { token: tok.chair, json: { narrativeEn: `${r.body.response.narrativeEn} Edited by the chair.` } });
  assert.equal(saved.status, 201, saved.text);
  assert.equal(saved.body.reviewDecision, 'EDITED');
  assert.equal(saved.body.document.ownerType, 'EVALUATION_NARRATIVE');
  assert.equal((await api(run, 'POST', `/api/v1/ai-runs/${r.body.id}/save-narrative`, { token: tok.chair, json: {} })).status, 409);
  const list = await api(run, 'GET', `/api/v1/tenders/${t}/narratives`, { token: tok.director });
  assert.equal(list.body.length, 1);
  const doc = await api(run, 'GET', `/api/v1/documents/${list.body[0].id}`, { token: tok.director });
  assert.equal(doc.status, 200);
  assert.match(doc.text, /Edited by the chair/);
  const audit = await run.handle.ctx.db.query(`SELECT 1 FROM audit_events WHERE action='EVALUATION_NARRATIVE_SAVED' AND resource_id=$1`, [t]);
  assert.equal(audit.length, 1);
});

test('grade review: officer/admin only; checklist from the configurable list', async () => {
  const up = await api(run, 'POST', '/api/v1/vendors/me/documents', { token: tok.vendor1, form: fileForm({
    title: 'Company file', file: { name: 'company.md', content: '# Commercial registration\nCR-100001 valid until 2028.\n\n# Staff\nTwo engineers.' } }) });
  assert.equal(up.status, 201, up.text);
  const path = `/api/v1/vendors/${ids.vendor1}/ai/grade-review`;
  assert.equal((await api(run, 'POST', path, { token: tok.vendor1, json: { grade: 1 } })).status, 403);
  assert.equal((await api(run, 'POST', path, { token: tok.director, json: { grade: 1 } })).status, 403);
  assert.equal((await api(run, 'POST', path, { token: tok.officer, json: { grade: 7 } })).status, 400);
  const r = await api(run, 'POST', path, { token: tok.officer, json: { grade: 2 } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.kind, 'GRADE_REVIEW');
  assert.equal(r.body.subjectId, ids.vendor1);
  assert.equal(r.body.response.items.length, 6);
  assert.match(lastPrompt('tenderflow_grade_reviewer'), /CR-100001 valid until 2028/);
  const hist = await api(run, 'GET', path, { token: tok.admin });
  assert.equal(hist.body.runs[0].id, r.body.id);
});

test('insights: admin and auditor only, computed from recorded runs', async () => {
  assert.equal((await api(run, 'GET', '/api/v1/assistant/insights', { token: tok.officer })).status, 403);
  assert.equal((await api(run, 'GET', '/api/v1/assistant/insights', { token: tok.vendor1 })).status, 403);
  const r = await api(run, 'GET', '/api/v1/assistant/insights', { token: tok.auditor });
  assert.equal(r.status, 200, r.text);
  const rows = await run.handle.ctx.db.query<any>(`SELECT status FROM ai_runs WHERE tenant_id='kea'`);
  assert.equal(r.body.totals.runs, rows.length);
  assert.equal(r.body.totals.error, rows.filter((x) => x.status === 'ERROR').length);
  const chat = r.body.byKind.find((k: any) => k.kind === 'ASSISTANT_CHAT');
  assert.ok(chat.ok >= 5);
  assert.ok(chat.medianDurationMs !== null);
  assert.equal(r.body.adoption.noticesSavedFromDraft, 1);
  assert.equal(r.body.adoption.narrativesSaved, 1);
  const kinds = r.body.byKind.find((k: any) => k.kind === 'REQUEST_CLASSIFY');
  assert.equal(kinds.accepted, 1);
});
