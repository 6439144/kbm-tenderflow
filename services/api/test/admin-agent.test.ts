// API tests of the AI admin builder (features/admin-agent*) against the seeded demo data and the local FAKE Orchestrate
// server (test/fakes/orchestrate.ts): not configured / agent not imported → 503 and no proposal; valid plans validated
// with bilingual sentences; invalid operations refused with reasons; apply creates DRAFTS only (nothing published
// changes) exactly once; roles; entity isolation (data and prompts); audit chain; refinement on the same thread; the
// structured tool path; invalid agent JSON after the repair turn.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, login, makeTenant, makeUser, startApp, type Running } from './helpers.js';
import { startFakeOrchestrate, type FakeOrchestrate } from './fakes/orchestrate.js';

const DEMO_PASSWORD = 'Demo-Passw0rd!';
const J = (o: unknown) => JSON.stringify(o);
const AGENT = 'tenderflow_admin_builder';

const reply = (operations: unknown[], extra: Record<string, unknown> = {}) => J({
  reply: { en: 'Here is the proposed change. Review it and create the drafts.', ar: 'هذا هو التغيير المقترح. راجعه ثم أنشئ المسودات.' },
  operations, questions: [], ...extra,
});

const RULE_1M = (amount = 1000000) => ({ op: 'ADD_RULE', rule: { id: 'undersecretary-over-limit', nameEn: `Undersecretary approval above ${amount} KWD`, nameAr: `اعتماد الوكيل فوق ${amount} د.ك`,
  trigger: 'TENDER_SUBMIT', when: { fact: 'tender.estimatedBudget', op: 'gt', value: amount },
  actions: [{ type: 'ADD_APPROVER', role: 'UNDERSECRETARY', labelEn: 'Undersecretary', labelAr: 'الوكيل' }] } });

const VALID_PLAN = [
  { op: 'CREATE_TEMPLATE', code: 'RFP_6040', nameEn: 'RFP 60/40 two envelopes', nameAr: 'طلب عروض 60/40 مظروفان', baseCode: 'RFP_TWO_ENVELOPE',
    changes: { envelopes: 'TWO', evaluation: { technicalPassMark: 70 } } },
  RULE_1M(),
  { op: 'ADD_FORM_FIELD', form: 'TENDER', field: { key: 'projectCode', type: 'text', labelEn: 'Project code', labelAr: 'رمز المشروع', required: true, requiredAt: 'SAVE', audience: 'INTERNAL', maxLength: 40 } },
  { op: 'ADD_RULE', rule: { id: 'deadline-72h', nameEn: 'Deadline in 72 hours', nameAr: 'الموعد النهائي خلال 72 ساعة', trigger: 'DEADLINE_APPROACHING', params: { hoursBefore: 72 }, when: null,
    actions: [{ type: 'NOTIFY', to: 'ROLE', role: 'PROCUREMENT_OFFICER', titleEn: 'Deadline within 72 hours: {{tender.number}}', titleAr: 'الموعد خلال 72 ساعة: {{tender.number}}' }] } },
  { op: 'ADD_RULE', rule: { id: 'strategic-risk-register', nameEn: 'Strategic projects upload a risk register', nameAr: 'المشاريع الاستراتيجية ترفع سجل المخاطر', trigger: 'TENDER_PUBLISH',
    when: { fact: 'tender.custom.strategicProject', op: 'isTrue' }, actions: [{ type: 'REQUIRE_DOCUMENTS', minCount: 1, titleContains: 'risk register' }] } },
  { op: 'ADD_DOCUMENT_TYPE', code: 'RISK_REGISTER', nameEn: 'Risk register', nameAr: 'سجل المخاطر', contexts: ['TENDER_PACK'],
    fields: [{ key: 'reviewDate', labelEn: 'Review date', labelAr: 'تاريخ المراجعة', type: 'date', required: false }] },
];

let fake: FakeOrchestrate;
let run: Running;
const tok: Record<string, string> = {};
const callsTo = () => fake.calls.filter((c) => c.agentName === AGENT);
const hasArabic = (s: string) => /[؀-ۿ]/.test(s);

/** Everything published for the entity (templates + low-code definitions), to prove apply never changes it. */
async function publishedSnapshot(tenantId: string) {
  const t = await run.handle.ctx.db.query(`SELECT id, version, status, config FROM cycle_templates WHERE tenant_id=$1 AND status='PUBLISHED' ORDER BY id`, [tenantId]);
  const d = await run.handle.ctx.db.query(`SELECT id, version, status, definition FROM lowcode_definitions WHERE tenant_id=$1 AND status='PUBLISHED' ORDER BY id`, [tenantId]);
  const dt = await run.handle.ctx.db.query(`SELECT id, active FROM document_types WHERE tenant_id=$1 AND active ORDER BY id`, [tenantId]);
  return JSON.stringify({ t, d, dt });
}
const proposalCount = async (tenantId: string) => Number((await run.handle.ctx.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM admin_proposals WHERE tenant_id=$1`, [tenantId]))[0].n);

// ------------------------------------------------------------------ not configured

test('not configured: 503 AI_NOT_CONFIGURED, the failed run is recorded and no proposal is stored', async () => {
  for (const k of Object.keys(process.env)) if (k.startsWith('WXO_')) delete process.env[k];
  const r0 = await startApp();
  try {
    await makeTenant(r0, 'nc');
    await makeUser(r0, 'nc', 'admin', ['TENANT_ADMIN']);
    const t = await login(r0, 'nc', 'admin');
    const st = await api(r0, 'GET', '/api/v1/admin-agent/status', { token: t });
    assert.equal(st.status, 200, st.text);
    assert.equal(st.body.configured, false);
    const r = await api(r0, 'POST', '/api/v1/admin-agent/chat', { token: t, json: { message: 'Tenders above 1,000,000 KWD need the Undersecretary' } });
    assert.equal(r.status, 503, r.text);
    assert.equal(r.body.code, 'AI_NOT_CONFIGURED');
    const rows = await r0.handle.ctx.db.query<any>(`SELECT kind, status FROM ai_runs WHERE tenant_id='nc'`);
    assert.deepEqual(rows.map((x) => [x.kind, x.status]), [['ADMIN_BUILDER', 'ERROR']]);
    assert.equal((await r0.handle.ctx.db.query(`SELECT 1 FROM admin_proposals`)).length, 0, 'no proposal without a real agent answer');
  } finally { await r0.stop(); }
});

// ------------------------------------------------------------------ configured (fake Orchestrate) + demo seed

before(async () => {
  fake = await startFakeOrchestrate();
  Object.assign(process.env, fake.env);
  run = await startApp(undefined, { SEED_DEMO: 'true', DEMO_PASSWORD, DOC_AI_AUTO: 'false' });
  for (const u of ['admin', 'auditor', 'officer', 'director']) tok[u] = await login(run, 'kea', u, DEMO_PASSWORD);
  await makeTenant(run, 'tb');
  await makeUser(run, 'tb', 'admin', ['TENANT_ADMIN']);
  tok.bAdmin = await login(run, 'tb', 'admin');
});
after(async () => {
  if (run) await run.stop();
  await fake.close();
  for (const k of Object.keys(fake.env)) delete process.env[k];
});

test('agent not imported: status says so and chat returns 503 AI_AGENT_NOT_IMPORTED without starting a run', async () => {
  fake.hidden.add(AGENT);
  try {
    const st = await api(run, 'GET', '/api/v1/admin-agent/status', { token: tok.admin });
    assert.equal(st.body.configured, true);
    assert.equal(st.body.agent.name, AGENT);
    assert.equal(st.body.agent.imported, false);
    const before = await proposalCount('kea');
    const r = await api(run, 'POST', '/api/v1/admin-agent/chat', { token: tok.admin, json: { message: 'Remind officers 72 hours before the deadline' } });
    assert.equal(r.status, 503, r.text);
    assert.equal(r.body.code, 'AI_AGENT_NOT_IMPORTED');
    assert.match(r.body.message, /tenderflow_admin_builder/);
    assert.equal(callsTo().length, 0, 'no run was started');
    assert.equal(await proposalCount('kea'), before);
  } finally { fake.hidden.clear(); }
  // agentStatus is cached ~60 s; the chat route resolves the agent itself, so it works as soon as it is imported.
});

let validId = '';
let validThread = '';

test('valid plan: proposal with every operation validated, bilingual sentences, diffs and draft targets', async () => {
  fake.queue.push(reply(VALID_PLAN));
  const pub0 = await publishedSnapshot('kea');
  const r = await api(run, 'POST', '/api/v1/admin-agent/chat', { token: tok.admin, json: { message: 'Create a two-envelope RFP template with a 60/40 split and a pass mark of 70; tenders above 1,000,000 KWD need the Undersecretary; add a required Project code; remind officers 72 hours before the deadline; strategic projects must upload a risk register before publication' } });
  assert.equal(r.status, 201, r.text);
  const p = r.body;
  validId = p.id; validThread = p.threadId;
  assert.equal(p.status, 'PROPOSED');
  assert.equal(p.source, 'CHAT');
  assert.ok(p.threadId && p.aiRunId);
  assert.equal(p.validation.valid, true, J(p.validation));
  assert.equal(p.validation.results.length, VALID_PLAN.length);
  for (const res of p.validation.results) {
    assert.equal(res.status, 'ok', J(res));
    assert.ok(res.summary.en.length > 10 && hasArabic(res.summary.ar), J(res.summary));
    assert.ok(res.target && res.diff.length > 0, J(res));
  }
  const byOp = (i: number) => p.validation.results[i];
  assert.equal(byOp(0).target.type, 'TEMPLATE');
  assert.equal(byOp(0).target.action, 'CREATE_DRAFT');
  assert.match(byOp(0).summary.en, /two envelopes \(technical pass mark 70/);
  assert.match(byOp(1).summary.en, /Estimated budget > 1,000,000/);
  assert.match(byOp(1).summary.en, /Undersecretary/);
  assert.equal(byOp(5).target.action, 'CREATE_INACTIVE');
  assert.ok(p.validation.notes.some((n: any) => /Nothing is live/.test(n.en)));
  assert.ok(hasArabic(p.reply.ar) && p.reply.en);
  // The prompt: own entity's configuration, the catalogue and the contract — and the request.
  const prompt = callsTo().at(-1)!.prompt;
  assert.match(prompt, /high-value-approval/, 'current KEA rules are in the context');
  assert.match(prompt, /tender\.custom\.strategicProject/, 'custom-field facts are in the catalogue');
  assert.match(prompt, /OPERATION CATALOGUE/);
  assert.match(prompt, /pass mark of 70/);
  assert.match(prompt, /Identity & access/);
  assert.equal(await publishedSnapshot('kea'), pub0, 'proposing writes nothing to the configuration');
  const run1 = (await run.handle.ctx.db.query<any>('SELECT kind, status, agent FROM ai_runs WHERE id=$1', [p.aiRunId]))[0];
  assert.deepEqual([run1.kind, run1.status, run1.agent], ['ADMIN_BUILDER', 'OK', AGENT]);
});

test('invalid operations are refused with reasons and the proposal cannot be applied', async () => {
  const six = Array.from({ length: 6 }, () => ({ role: 'DIRECTOR' }));
  fake.queue.push(reply([
    { op: 'ADD_RULE', rule: { id: 'bad-fact', nameEn: 'Bad fact', nameAr: 'حقيقة خاطئة', trigger: 'TENDER_SUBMIT', when: { fact: 'tender.bidPrices', op: 'gt', value: 1 },
      actions: [{ type: 'BLOCK', messageEn: 'x', messageAr: 'س' }] } },
    { op: 'NEW_TEMPLATE_VERSION', code: 'PUBLIC_TENDER', changes: { approvals: { publish: six } } },
    { op: 'ADD_FORM_FIELD', form: 'TENDER', field: { key: 'project_code', type: 'text', labelEn: 'Project code', labelAr: 'رمز المشروع' } },
    { op: 'ADD_RULE', rule: { id: 'open-early', nameEn: 'Open bids early', nameAr: 'فتح العطاءات مبكراً', trigger: 'TENDER_CLOSED', when: null, actions: [{ type: 'OPEN_BIDS' }] } },
    { op: 'ADD_RULE', rule: { id: 'event-approver', nameEn: 'Event approver', nameAr: 'معتمد حدث', trigger: 'TENDER_PUBLISHED', when: null,
      actions: [{ type: 'ADD_APPROVER', role: 'DIRECTOR', labelEn: 'Director', labelAr: 'المدير' }] } },
    { op: 'NEW_TEMPLATE_VERSION', code: 'PUBLIC_TENDER', changes: { integrity: { sealedBids: false } } },
    { op: 'UPDATE_RULE', ruleId: 'high-value-approval', changes: { actions: [] } },
  ]));
  const r = await api(run, 'POST', '/api/v1/admin-agent/chat', { token: tok.admin, json: { message: 'Do several risky things' } });
  assert.equal(r.status, 201, r.text);
  const v = r.body.validation;
  assert.equal(v.valid, false);
  const e = (i: number) => v.results[i].errors.map((x: any) => x.en).join(' | ');
  assert.ok(v.results.every((x: any) => x.status === 'error'), J(v.results.map((x: any) => [x.op, x.status])));
  assert.match(e(0), /tender\.bidPrices' is not available/);
  assert.match(e(1), /at most 5 levels/);
  assert.match(e(2), /camelCase/);
  assert.match(e(3), /type must be one of/);
  assert.match(e(3), /Locked integrity controls/);
  assert.match(e(4), /events cannot block or add approvers/);
  assert.match(e(5), /Unknown key\(s\) in template changes: integrity/);
  assert.match(e(6), /at least one action/);
  for (const x of v.results) assert.ok(x.errors.every((m: any) => hasArabic(m.ar)), 'every reason in Arabic too');
  const pub0 = await publishedSnapshot('kea');
  const a = await api(run, 'POST', `/api/v1/admin-agent/proposals/${r.body.id}/apply`, { token: tok.admin });
  assert.equal(a.status, 409, a.text);
  assert.equal(a.body.code, 'PROPOSAL_INVALID');
  assert.equal(await publishedSnapshot('kea'), pub0);
  assert.equal((await api(run, 'GET', `/api/v1/admin-agent/proposals/${r.body.id}`, { token: tok.admin })).body.status, 'PROPOSED');
  assert.equal((await api(run, 'POST', `/api/v1/admin-agent/proposals/${r.body.id}/discard`, { token: tok.admin, json: { reason: 'unsafe' } })).status, 200);
});

test('roles: officers and directors cannot use the builder; auditors read but cannot chat, apply or discard', async () => {
  for (const u of ['officer', 'director']) {
    assert.equal((await api(run, 'POST', '/api/v1/admin-agent/chat', { token: tok[u], json: { message: 'x' } })).status, 403);
    assert.equal((await api(run, 'GET', '/api/v1/admin-agent/proposals', { token: tok[u] })).status, 403);
    assert.equal((await api(run, 'POST', `/api/v1/admin-agent/proposals/${validId}/apply`, { token: tok[u] })).status, 403);
  }
  assert.equal((await api(run, 'GET', '/api/v1/admin-agent/proposals', { token: tok.auditor })).status, 200);
  const g = await api(run, 'GET', `/api/v1/admin-agent/proposals/${validId}`, { token: tok.auditor });
  assert.equal(g.status, 200);
  assert.equal(g.body.validation.valid, true);
  const st = await api(run, 'GET', '/api/v1/admin-agent/status', { token: tok.auditor });
  assert.equal(st.body.canApply, false);
  assert.equal((await api(run, 'POST', '/api/v1/admin-agent/chat', { token: tok.auditor, json: { message: 'x' } })).status, 403);
  assert.equal((await api(run, 'POST', `/api/v1/admin-agent/proposals/${validId}/apply`, { token: tok.auditor })).status, 403);
  assert.equal((await api(run, 'POST', `/api/v1/admin-agent/proposals/${validId}/discard`, { token: tok.auditor })).status, 403);
  assert.equal((await api(run, 'POST', '/api/v1/admin-agent/proposals', { token: tok.auditor, json: { operations: [RULE_1M()] } })).status, 403);
  assert.equal((await api(run, 'GET', '/api/v1/admin-agent/proposals')).status, 401);
});

test('entity isolation: another entity cannot see or apply the proposal, and its prompt holds only its own data', async () => {
  assert.equal((await api(run, 'GET', `/api/v1/admin-agent/proposals/${validId}`, { token: tok.bAdmin })).status, 404);
  assert.equal((await api(run, 'POST', `/api/v1/admin-agent/proposals/${validId}/apply`, { token: tok.bAdmin })).status, 404);
  assert.equal((await api(run, 'POST', `/api/v1/admin-agent/proposals/${validId}/discard`, { token: tok.bAdmin })).status, 404);
  const list = await api(run, 'GET', '/api/v1/admin-agent/proposals', { token: tok.bAdmin });
  assert.deepEqual(list.body, []);
  // Entity B cannot continue entity A's Orchestrate thread or refine its proposal.
  assert.equal((await api(run, 'POST', '/api/v1/admin-agent/chat', { token: tok.bAdmin, json: { message: 'continue', threadId: validThread } })).status, 404);
  assert.equal((await api(run, 'POST', '/api/v1/admin-agent/chat', { token: tok.bAdmin, json: { message: 'continue', proposalId: validId } })).status, 404);
  fake.queue.push(reply([RULE_1M()]));
  const r = await api(run, 'POST', '/api/v1/admin-agent/chat', { token: tok.bAdmin, json: { message: 'Tenders above 1,000,000 KWD need the Undersecretary' } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.validation.valid, true, J(r.body.validation));
  assert.equal(r.body.validation.results[0].target.action, 'CREATE_DRAFT', 'entity B has no rule set yet: a first draft');
  const prompt = callsTo().at(-1)!.prompt;
  for (const leak of ['Kuwait Energy', 'هيئة الطاقة', 'high-value-approval', 'strategicProject', 'fundingSource', 'RFP_6040', 'undersecretary-over-limit']) {
    assert.ok(!prompt.includes(leak), `entity B prompt must not contain ${leak}`);
  }
  assert.equal(r.body.threadId === validThread, false);
});

test('refinement: a follow-up on the same thread updates the same proposal', async () => {
  fake.queue.push(reply([RULE_1M()]));
  const first = await api(run, 'POST', '/api/v1/admin-agent/chat', { token: tok.admin, json: { message: 'Tenders above 1,000,000 KWD need the Undersecretary' } });
  assert.equal(first.status, 201, first.text);
  assert.equal(callsTo().at(-1)!.continued, false);
  fake.queue.push(reply([RULE_1M(2000000)]));
  const second = await api(run, 'POST', '/api/v1/admin-agent/chat', { token: tok.admin, json: { message: 'make it 2 million instead', proposalId: first.body.id } });
  assert.equal(second.status, 201, second.text);
  const last = callsTo().at(-1)!;
  assert.equal(last.continued, true, 'same Orchestrate thread');
  assert.equal(last.threadId, first.body.threadId);
  assert.match(last.prompt, /CURRENT PROPOSAL \(being revised/);
  assert.match(last.prompt, /"value":1000000/);
  assert.match(last.prompt, /make it 2 million instead/);
  assert.equal(second.body.id, first.body.id);
  assert.equal(second.body.revision, 2);
  assert.equal(second.body.operations[0].rule.when.value, 2000000);
  assert.match(second.body.validation.results[0].summary.en, /2,000,000/);
  assert.equal(second.body.messages.length, 4);
  // Continuing by thread id also refines the open proposal of that conversation.
  fake.queue.push(reply([RULE_1M(1500000)]));
  const third = await api(run, 'POST', '/api/v1/admin-agent/chat', { token: tok.admin, json: { message: '1.5 million', threadId: first.body.threadId } });
  assert.equal(third.status, 201, third.text);
  assert.equal(third.body.id, first.body.id);
  assert.equal(third.body.revision, 3);
  // Another administrator of the same entity cannot take over this conversation.
  await makeUser(run, 'kea', 'admin2', ['TENANT_ADMIN']);
  const t2 = await login(run, 'kea', 'admin2');
  assert.equal((await api(run, 'POST', '/api/v1/admin-agent/chat', { token: t2, json: { message: 'x', proposalId: first.body.id } })).status, 404);
  await api(run, 'POST', `/api/v1/admin-agent/proposals/${first.body.id}/discard`, { token: tok.admin });
});

test('apply creates DRAFTS only, nothing published changes, and a second apply is refused', async () => {
  const pub0 = await publishedSnapshot('kea');
  const a = await api(run, 'POST', `/api/v1/admin-agent/proposals/${validId}/apply`, { token: tok.admin });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.body.status, 'APPLIED');
  const refs = a.body.appliedRefs as any[];
  assert.deepEqual(refs.map((x) => x.type).sort(), ['DOCUMENT_TYPE', 'FORM', 'RULESET', 'TEMPLATE']);
  assert.equal(await publishedSnapshot('kea'), pub0, 'no published template, form, rule set or active document type changed');
  const db = run.handle.ctx.db;
  const tpl = (await db.query<any>(`SELECT * FROM cycle_templates WHERE tenant_id='kea' AND code='RFP_6040'`));
  assert.equal(tpl.length, 1);
  assert.equal(tpl[0].status, 'DRAFT');
  assert.equal(tpl[0].config.envelopes, 'TWO');
  assert.equal(tpl[0].config.evaluation.technicalPassMark, 70);
  assert.equal(refs.find((x) => x.type === 'TEMPLATE').link, `/admin/cycle?template=${tpl[0].id}`);
  const rs = (await db.query<any>(`SELECT * FROM lowcode_definitions WHERE tenant_id='kea' AND kind='RULESET' AND status='DRAFT'`));
  assert.equal(rs.length, 1);
  const ids = rs[0].definition.rules.map((x: any) => x.id);
  for (const id of ['high-value-approval', 'undersecretary-over-limit', 'deadline-72h', 'strategic-risk-register']) assert.ok(ids.includes(id), id);
  const form = (await db.query<any>(`SELECT * FROM lowcode_definitions WHERE tenant_id='kea' AND kind='FORM' AND code='TENDER' AND status='DRAFT'`));
  assert.equal(form.length, 1);
  assert.ok(form[0].definition.fields.some((f: any) => f.key === 'projectCode' && f.required));
  const dt = (await db.query<any>(`SELECT active FROM document_types WHERE tenant_id='kea' AND code='RISK_REGISTER'`));
  assert.deepEqual(dt.map((x) => x.active), [false], 'document type created switched off');
  // The drafts are normal drafts: the Studio sees them and publishing stays a separate, human step.
  const drafts = await api(run, 'GET', '/api/v1/lowcode/definitions?kind=RULESET', { token: tok.admin });
  assert.ok(drafts.body.some((d: any) => d.status === 'DRAFT'));

  const again = await api(run, 'POST', `/api/v1/admin-agent/proposals/${validId}/apply`, { token: tok.admin });
  assert.equal(again.status, 409, again.text);
  assert.equal(again.body.code, 'PROPOSAL_ALREADY_APPLIED');
  assert.equal((await db.query(`SELECT 1 FROM cycle_templates WHERE tenant_id='kea' AND code='RFP_6040'`)).length, 1, 'no second draft');
  assert.equal((await api(run, 'POST', `/api/v1/admin-agent/proposals/${validId}/discard`, { token: tok.admin })).status, 409);
  assert.equal((await api(run, 'POST', '/api/v1/admin-agent/chat', { token: tok.admin, json: { message: 'more', proposalId: validId } })).status, 409);
});

test('a later proposal goes into the open drafts (one draft per definition)', async () => {
  fake.queue.push(reply([{ op: 'SET_RULE_ENABLED', ruleId: 'deadline-48h', enabled: false },
    { op: 'NEW_TEMPLATE_VERSION', code: 'RFP_6040', changes: { fees: { documentPrice: 75 } } }]));
  const r = await api(run, 'POST', '/api/v1/admin-agent/chat', { token: tok.admin, json: { message: 'Switch off the 48-hour reminder and make RFP documents cost 75 KWD' } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.validation.valid, true, J(r.body.validation));
  assert.equal(r.body.validation.results[0].target.action, 'UPDATE_DRAFT');
  assert.equal(r.body.validation.results[1].target.action, 'UPDATE_DRAFT');
  assert.ok(r.body.validation.results[1].warnings.some((w: any) => /already open/.test(w.en)));
  const a = await api(run, 'POST', `/api/v1/admin-agent/proposals/${r.body.id}/apply`, { token: tok.admin });
  assert.equal(a.status, 200, a.text);
  const db = run.handle.ctx.db;
  assert.equal((await db.query(`SELECT 1 FROM lowcode_definitions WHERE tenant_id='kea' AND kind='RULESET' AND status='DRAFT'`)).length, 1);
  const tpl = await db.query<any>(`SELECT config FROM cycle_templates WHERE tenant_id='kea' AND code='RFP_6040'`);
  assert.equal(tpl.length, 1);
  assert.equal(tpl[0].config.fees.documentPrice, 75);
});

test('tool path: a structured plan is validated without AI, stored as a proposal and never applied', async () => {
  const calls = fake.calls.length;
  const bad = await api(run, 'POST', '/api/v1/admin-agent/proposals', { token: tok.admin, json: { operations: [{ op: 'CREATE_USER', username: 'x' }] } });
  assert.equal(bad.status, 400, bad.text);
  assert.match(bad.text, /CREATE_USER/);
  const extra = await api(run, 'POST', '/api/v1/admin-agent/proposals', { token: tok.admin, json: { operations: [{ ...RULE_1M(), publish: true }] } });
  assert.equal(extra.status, 400, extra.text);
  assert.match(extra.body.message, /unknown key "publish"/);
  const pub0 = await publishedSnapshot('kea');
  const drafts0 = await run.handle.ctx.db.query(`SELECT id, definition FROM lowcode_definitions WHERE tenant_id='kea' AND status='DRAFT' ORDER BY id`);
  const r = await api(run, 'POST', '/api/v1/admin-agent/proposals', { token: tok.admin, json: {
    request: 'Add a vendor field for the chamber of commerce number', operations: [
      { op: 'ADD_FORM_FIELD', form: 'VENDOR', field: { key: 'chamberNumber', type: 'text', labelEn: 'Chamber of commerce number', labelAr: 'رقم غرفة التجارة', audience: 'PUBLIC' } }] } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.source, 'TOOL');
  assert.equal(r.body.status, 'PROPOSED');
  assert.equal(r.body.applied, false);
  assert.equal(r.body.validation.valid, true, J(r.body.validation));
  assert.match(r.body.reviewPath, new RegExp(`/admin/builder\\?proposal=${r.body.id}`));
  assert.ok(hasArabic(r.body.next.ar));
  assert.equal(fake.calls.length, calls, 'no AI call on the tool path');
  assert.equal(await publishedSnapshot('kea'), pub0);
  assert.deepEqual(await run.handle.ctx.db.query(`SELECT id, definition FROM lowcode_definitions WHERE tenant_id='kea' AND status='DRAFT' ORDER BY id`), drafts0, 'nothing written');
});

test('agent output that is not valid JSON after the repair turn: clear error, nothing stored', async () => {
  const before = await proposalCount('kea');
  const calls = callsTo().length;
  fake.queue.push('Sure! I created the template for you.', 'Done — everything is saved.');
  const r = await api(run, 'POST', '/api/v1/admin-agent/chat', { token: tok.admin, json: { message: 'Create a template' } });
  assert.equal(r.status, 502, r.text);
  assert.equal(r.body.code, 'AI_ERROR');
  assert.match(r.body.message, /not valid for this task after one repair attempt/);
  assert.equal(callsTo().length, calls + 2, 'one turn + one repair turn');
  assert.equal(callsTo().at(-1)!.continued, true, 'the repair turn is on the same thread');
  assert.equal(await proposalCount('kea'), before, 'no proposal stored');
  // A reply missing the Arabic text is invalid too (bilingual is mandatory).
  fake.queue.push(J({ reply: { en: 'Only English' }, operations: [] }), J({ reply: { en: 'Still only English' }, operations: [] }));
  const r2 = await api(run, 'POST', '/api/v1/admin-agent/chat', { token: tok.admin, json: { message: 'Create a template' } });
  assert.equal(r2.status, 502, r2.text);
  assert.equal(await proposalCount('kea'), before);
});

test('out-of-scope request: no operations, the bilingual explanation is shown and nothing can be applied', async () => {
  fake.queue.push(J({ reply: { en: 'User accounts and roles are managed in Admin → Identity & access, not by the AI builder.', ar: 'تُدار حسابات المستخدمين والأدوار من الإدارة ← الهوية والوصول، وليس عبر المنشئ الذكي.' }, operations: [] }));
  const r = await api(run, 'POST', '/api/v1/admin-agent/chat', { token: tok.admin, json: { message: 'Give Ahmed the director role' } });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.body.operations, []);
  assert.equal(r.body.validation.valid, false);
  assert.match(r.body.reply.en, /Identity & access/);
  assert.equal((await api(run, 'POST', `/api/v1/admin-agent/proposals/${r.body.id}/apply`, { token: tok.admin })).status, 409);
});

test('audit: proposed, applied and discarded events are in the chain and it verifies', async () => {
  const db = run.handle.ctx.db;
  const ev = await db.query<any>(`SELECT action, resource_id, details FROM audit_events WHERE tenant_id='kea' AND action LIKE 'ADMIN_AGENT_%' ORDER BY seq`);
  const actions = new Set(ev.map((x) => x.action));
  for (const a of ['ADMIN_AGENT_PROPOSED', 'ADMIN_AGENT_APPLIED', 'ADMIN_AGENT_DISCARDED']) assert.ok(actions.has(a), a);
  const applied = ev.find((x) => x.action === 'ADMIN_AGENT_APPLIED' && x.resource_id === validId);
  assert.ok(applied.details.drafts.length === 4 && applied.details.drafts.every((d: any) => d.status === 'DRAFT' || d.status === 'INACTIVE'));
  const viaAgent = await db.query<any>(`SELECT action FROM audit_events WHERE tenant_id='kea' AND details->>'proposalId'=$1 ORDER BY seq`, [validId]);
  assert.deepEqual([...new Set(viaAgent.map((x) => x.action))].sort(), ['DOCUMENT_TYPE_CREATED', 'LOWCODE_DRAFT_CREATED', 'TEMPLATE_CREATED']);
  assert.equal((await db.query(`SELECT 1 FROM audit_events WHERE tenant_id='tb' AND action LIKE 'ADMIN_AGENT_%' AND resource_id=$1`, [validId])).length, 0);
  const v = await api(run, 'GET', '/api/v1/audit/verify', { token: tok.auditor });
  assert.equal(v.status, 200, v.text);
  assert.equal(v.body.valid, true, v.text);
});
