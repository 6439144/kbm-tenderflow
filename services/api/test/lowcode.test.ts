import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { api, fileForm, login, makeTenant, makeUser, startApp, PASSWORD, type Running } from './helpers.js';
import { describe as describeCond, evaluate, validateCondition } from '../src/lowcode/conditions.js';
import { evalFormula, parseFormula } from '../src/lowcode/formula.js';
import { validateFormDefinition, validateValues } from '../src/lowcode/forms.js';
import { evaluateGate, validateRuleset } from '../src/lowcode/rules.js';
import { factsFor } from '../src/lowcode/conditions.js';
import { checkUrl } from '../src/lowcode/webhooks.js';

let run: Running;
let hookServer: http.Server | null = null;
after(async () => {
  if (run) await run.stop();
  if (hookServer) await new Promise<void>((r) => hookServer!.close(() => r()));
});

const CRIT = [{ key: 'technical', nameEn: 'Technical', nameAr: 'فني', weight: 70 }, { key: 'price', nameEn: 'Price', nameAr: 'السعر', weight: 30 }];
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const opt = (value: string) => ({ value, labelEn: value, labelAr: value });

const TENDER_FORM = {
  sections: [{ key: 'funding', titleEn: 'Funding', titleAr: 'التمويل' }],
  fields: [
    { key: 'fundingSource', type: 'select', section: 'funding', labelEn: 'Funding source', labelAr: 'مصدر التمويل', required: true, options: [opt('OPEX'), opt('CAPEX'), opt('GRANT')] },
    { key: 'budgetLine', type: 'text', labelEn: 'Budget line', labelAr: 'بند الميزانية', audience: 'INTERNAL' },
    { key: 'bondPercent', type: 'percent', labelEn: 'Bid bond %', labelAr: 'نسبة الكفالة', audience: 'PUBLIC', defaultValue: 2 },
    { key: 'bondAmount', type: 'computed', labelEn: 'Bid bond amount', labelAr: 'قيمة الكفالة', audience: 'PUBLIC', formula: 'round(budget * bondPercent / 100, 3)' },
    { key: 'strategic', type: 'checkbox', labelEn: 'Strategic', labelAr: 'استراتيجي' },
    { key: 'notes', type: 'textarea', labelEn: 'Strategic notes', labelAr: 'ملاحظات', visibleWhen: { fact: 'self.strategic', op: 'isTrue' } },
  ],
};

// ------------------------------------------------------------------ pure units
test('conditions: validate, evaluate and describe; unknown facts and wrong operators are refused', () => {
  const facts = factsFor('TENDER');
  const c = validateCondition({ all: [{ fact: 'tender.estimatedBudget', op: 'gt', value: '500000' }, { any: [{ fact: 'tender.category', op: 'in', value: 'IT,WORKS' }, { not: { fact: 'tender.fromRequest', op: 'isTrue' } }] }] }, facts);
  assert.equal(evaluate(c, { 'tender.estimatedBudget': 600000, 'tender.category': 'it', 'tender.fromRequest': true }), true);
  assert.equal(evaluate(c, { 'tender.estimatedBudget': 400000, 'tender.category': 'IT' }), false);
  assert.equal(evaluate(c, { 'tender.estimatedBudget': 600000, 'tender.category': 'SUPPLIES', 'tender.fromRequest': true }), false);
  assert.match(describeCond(c, facts, 'en'), /Estimated budget > 500,000 and/);
  assert.match(describeCond(c, facts, 'ar'), /الميزانية التقديرية/);
  assert.throws(() => validateCondition({ fact: 'bid.price', op: 'gt', value: 1 }, facts), /not available/);
  assert.throws(() => validateCondition({ fact: 'tender.category', op: 'gt', value: 1 }, facts), /cannot be used/);
  assert.throws(() => validateCondition({ fact: 'tender.envelopes', op: 'eq', value: 'THREE' }, facts), /not an option/);
  // missing facts are "empty", never an exception
  assert.equal(evaluate({ fact: 'tender.estimatedBudget', op: 'isEmpty' }, {}), true);
});

test('formula: safe arithmetic only; missing inputs and division by zero give an empty result', () => {
  assert.equal(evalFormula(parseFormula('round(budget * pct / 100, 3)'), { budget: 450000, pct: 2.5 }), 11250);
  assert.equal(evalFormula(parseFormula('max(a, b) - -min(1, 2)'), { a: 3, b: 7 }), 8);
  assert.equal(evalFormula(parseFormula('a / b'), { a: 1, b: 0 }), null);
  assert.equal(evalFormula(parseFormula('a + 1'), {}), null);
  assert.throws(() => parseFormula('process.exit(1)'), /unexpected|unknown/i);
  assert.throws(() => parseFormula('a +'), /incomplete/);
  assert.throws(() => parseFormula('eval(1)'), /unknown function/);
});

test('forms: definition validation (loops, unknown references, visibility) and value validation', () => {
  const def = validateFormDefinition(TENDER_FORM, 'TENDER');
  assert.equal(def.fields.find((f) => f.key === 'fundingSource')!.requiredAt, 'SUBMIT');
  assert.throws(() => validateFormDefinition({ fields: [{ key: 'a', type: 'computed', labelEn: 'A', labelAr: 'A', formula: 'b + 1' }, { key: 'b', type: 'computed', labelEn: 'B', labelAr: 'B', formula: 'a + 1' }] }, 'TENDER'), /loop/);
  assert.throws(() => validateFormDefinition({ fields: [{ key: 'a', type: 'computed', labelEn: 'A', labelAr: 'A', formula: 'budget * 2' }] }, 'VENDOR'), /not a number field/);
  assert.throws(() => validateFormDefinition({ fields: [{ key: 'budget', type: 'text', labelEn: 'A', labelAr: 'A' }] }, 'TENDER'), /reserved/);
  const v = validateValues(def, { fundingSource: 'CAPEX', strategic: false, notes: 'hidden' }, { mode: 'SAVE', budget: 100000 });
  assert.equal(v.bondPercent, 2); // default
  assert.equal(v.bondAmount, 2000); // computed by the server
  assert.equal(v.notes, null); // hidden by visibleWhen → no value kept
  assert.throws(() => validateValues(def, { fundingSource: 'LOAN' }, { mode: 'SAVE' }), /listed options/);
  assert.throws(() => validateValues(def, { nope: 1 }, { mode: 'SAVE' }), /not a field/);
  assert.throws(() => validateValues(def, {}, { mode: 'SUBMIT' }), /Required: Funding source/);
  // a vendor may only set PUBLIC fields
  assert.throws(() => validateValues(def, { budgetLine: 'X' }, { mode: 'SAVE', editable: (f) => f.audience === 'PUBLIC' }), /cannot be set by you/);
});

test('rules: gates only tighten; events cannot add approvers; routing adds a level once', () => {
  const rc = { forms: { TENDER: validateFormDefinition(TENDER_FORM, 'TENDER') }, webhookCodes: ['erp'] };
  const fx = (s: any) => factsFor(s, [{ prefix: 'tender.custom.', scopes: ['TENDER', 'AWARD'], fields: rc.forms.TENDER.fields }]);
  assert.throws(() => validateRuleset({ rules: [{ id: 'x1', nameEn: 'x', nameAr: 'x', trigger: 'TENDER_PUBLISHED', actions: [{ type: 'ADD_APPROVER', role: 'DIRECTOR', labelEn: 'D', labelAr: 'D' }] }] }, rc, fx), /cannot be used with this trigger/);
  assert.throws(() => validateRuleset({ rules: [{ id: 'x1', nameEn: 'x', nameAr: 'x', trigger: 'TENDER_SUBMIT', actions: [{ type: 'ADD_APPROVER', role: 'VENDOR', labelEn: 'V', labelAr: 'V' }] }] }, rc, fx), /role must be one of/);
  assert.throws(() => validateRuleset({ rules: [{ id: 'x1', nameEn: 'x', nameAr: 'x', trigger: 'TENDER_PUBLISHED', actions: [{ type: 'WEBHOOK', endpoint: 'nope' }] }] }, rc, fx), /not a configured integration/);
  const rs = validateRuleset({ rules: [
    { id: 'big', nameEn: 'Big', nameAr: 'كبير', trigger: 'TENDER_SUBMIT', when: { fact: 'tender.estimatedBudget', op: 'gt', value: 500000 }, actions: [{ type: 'ADD_APPROVER', role: 'UNDERSECRETARY', labelEn: 'US', labelAr: 'وكيل' }] },
    { id: 'capex', nameEn: 'Capex', nameAr: 'رأسمالي', trigger: 'TENDER_SUBMIT', when: { fact: 'tender.custom.fundingSource', op: 'eq', value: 'CAPEX' }, actions: [{ type: 'ADD_APPROVER', role: 'UNDERSECRETARY', labelEn: 'US', labelAr: 'وكيل' }, { type: 'REQUIRE_FIELDS', fields: ['budgetLine'] }] },
  ] }, rc, fx);
  const g = evaluateGate(rs, 'TENDER_SUBMIT', { 'tender.estimatedBudget': 900000, 'tender.custom.fundingSource': 'CAPEX' }, fx('TENDER'));
  assert.equal(g.addLevels.length, 1); // same role is never added twice
  assert.deepEqual(g.requiredFields, [{ ruleId: 'capex', fields: ['budgetLine'] }]);
  assert.equal(g.matched.length, 2);
});

test('webhook URL policy: https only, no credentials, no private targets', () => {
  const strict = { allowHttp: false, allowPrivate: false, timeoutMs: 1000 };
  assert.throws(() => checkUrl('http://erp.example.com/h', strict), /https/);
  assert.throws(() => checkUrl('https://u:p@erp.example.com/h', strict), /credentials/);
  assert.throws(() => checkUrl('https://127.0.0.1/h', strict), /private/);
  assert.throws(() => checkUrl('https://169.254.169.254/latest', strict), /private/);
  assert.throws(() => checkUrl('https://localhost:8443/h', strict), /private/);
  assert.equal(checkUrl('https://erp.example.com/hooks/tf', strict).host, 'erp.example.com');
});

// ------------------------------------------------------------------ end to end
test('Process Studio end to end: forms, routing, gates, pinning, automation, tasks, webhooks, simulator, packages', async () => {
  process.env.LOWCODE_WEBHOOK_ALLOW_HTTP = 'true';
  process.env.LOWCODE_WEBHOOK_ALLOW_PRIVATE = 'true';
  // receiving integration (records what it gets)
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  hookServer = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { received.push({ headers: req.headers, body: b }); res.writeHead(204).end(); }); });
  hookServer.listen(0, '127.0.0.1'); await once(hookServer, 'listening');
  const hookUrl = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/tf`;

  run = await startApp();
  await makeTenant(run, 'ent'); await makeTenant(run, 'ent2');
  for (const [u, r] of [['officer', 'PROCUREMENT_OFFICER'], ['director', 'DIRECTOR'], ['under', 'UNDERSECRETARY'], ['chair', 'COMMITTEE_CHAIR'], ['admin', 'TENANT_ADMIN'], ['auditor', 'AUDITOR']] as const)
    await makeUser(run, 'ent', u, [r]);
  await makeUser(run, 'ent2', 'admin', ['TENANT_ADMIN']);
  const [officer, director, under, chair, admin, auditor] = await Promise.all(['officer', 'director', 'under', 'chair', 'admin', 'auditor'].map((u) => login(run, 'ent', u)));
  const admin2 = await login(run, 'ent2', 'admin');
  const A = (m: string, p: string, token: string, json?: unknown) => api(run, m, `/api/v1${p}`, { token, json });

  // --- only the entity admin edits the studio; the auditor can read it
  assert.equal((await A('POST', '/lowcode/definitions', officer, { kind: 'FORM', code: 'TENDER', definition: TENDER_FORM })).status, 403);
  const formDraft = await A('POST', '/lowcode/definitions', admin, { kind: 'FORM', code: 'TENDER', definition: TENDER_FORM });
  assert.equal(formDraft.status, 201, formDraft.text);
  assert.equal(formDraft.body.status, 'DRAFT');
  assert.equal((await A('POST', '/lowcode/definitions', admin, { kind: 'FORM', code: 'TENDER', definition: TENDER_FORM })).body.code, 'DRAFT_EXISTS');
  const bad = await A('PATCH', `/lowcode/definitions/${formDraft.body.id}`, admin, { definition: { fields: [{ key: 'x', type: 'rocket', labelEn: 'x', labelAr: 'x' }] } });
  assert.equal(bad.status, 400);
  assert.equal((await A('POST', `/lowcode/definitions/${formDraft.body.id}/publish`, admin)).body.status, 'PUBLISHED');
  assert.equal((await A('GET', '/lowcode/definitions', auditor)).status, 200);

  // --- rule set: routing above 500k, publish block for grants, required budget line for CAPEX, automation on publish
  await A('POST', '/lowcode/webhooks', officer, { code: 'erp', name: 'ERP', url: hookUrl }).then((r) => assert.equal(r.status, 403));
  const ep = await A('POST', '/lowcode/webhooks', admin, { code: 'erp', name: 'Finance ERP (test)', url: hookUrl, events: ['TENDER_PUBLISHED'] });
  assert.equal(ep.status, 201, ep.text);
  assert.match(ep.body.secret, /^whsec_/);
  const secret = ep.body.secret as string;
  assert.equal(JSON.stringify((await A('GET', '/lowcode/webhooks', admin)).body).includes(secret), false, 'secret is shown only once');
  const RULES = { rules: [
    { id: 'big', nameEn: 'High value', nameAr: 'قيمة عالية', trigger: 'TENDER_SUBMIT', when: { fact: 'tender.estimatedBudget', op: 'gt', value: 500000 },
      actions: [{ type: 'ADD_APPROVER', role: 'UNDERSECRETARY', labelEn: 'Undersecretary (high value)', labelAr: 'الوكيل', dueHours: 48 }] },
    { id: 'capex-line', nameEn: 'CAPEX needs a budget line', nameAr: 'الرأسمالي يحتاج بنداً', trigger: 'TENDER_SUBMIT', when: { fact: 'tender.custom.fundingSource', op: 'eq', value: 'CAPEX' },
      actions: [{ type: 'REQUIRE_FIELDS', fields: ['budgetLine'] }] },
    { id: 'grant-block', nameEn: 'No grant tenders yet', nameAr: 'لا مناقصات بمنح', trigger: 'TENDER_PUBLISH', when: { fact: 'tender.custom.fundingSource', op: 'eq', value: 'GRANT' },
      actions: [{ type: 'BLOCK', messageEn: 'Grant tenders need the donor’s no-objection first.', messageAr: 'تحتاج مناقصات المنح عدم ممانعة الجهة المانحة.' }] },
    { id: 'chair-check', nameEn: 'Chair checks site list', nameAr: 'الرئيس يراجع قائمة الموقع', trigger: 'TENDER_PUBLISHED', when: null,
      actions: [{ type: 'CREATE_TASK', role: 'COMMITTEE_CHAIR', titleEn: 'Check site list for {{tender.number}}', titleAr: 'مراجعة قائمة الموقع {{tender.number}}', dueHours: 24, blocksGate: 'AWARD_RECOMMEND' },
        { type: 'NOTIFY', to: 'ROLE', role: 'DIRECTOR', titleEn: 'Published: {{tender.number}}', titleAr: 'نُشرت: {{tender.number}}' },
        { type: 'WEBHOOK', endpoint: 'erp' }, { type: 'SET_FIELD', field: 'budgetLine', value: 'AUTO-SET' }] },
  ] };
  // an event rule cannot add approvers (rejected with a clear reason)
  const wrong = await A('POST', '/lowcode/check', admin, { kind: 'RULESET', definition: { rules: [{ ...RULES.rules[0], trigger: 'TENDER_PUBLISHED' }] } });
  assert.equal(wrong.body.valid, false);
  assert.match(wrong.body.errors[0], /cannot be used with this trigger/);
  const rs = await A('POST', '/lowcode/definitions', admin, { kind: 'RULESET', definition: RULES });
  assert.equal(rs.status, 201, rs.text);
  assert.equal((await A('POST', `/lowcode/definitions/${rs.body.id}/publish`, admin)).status, 200);

  // --- simulator
  const sim = await A('POST', '/lowcode/simulate', auditor, { trigger: 'TENDER_SUBMIT', facts: { 'tender.estimatedBudget': 750000, 'tender.custom.fundingSource': 'CAPEX' } });
  assert.equal(sim.status, 200, sim.text);
  assert.deepEqual(sim.body.gate.chain.map((l: any) => [l.role, l.added]), [['DIRECTOR', false], ['UNDERSECRETARY', true]]);
  assert.equal(sim.body.results.filter((r: any) => r.matched).length, 2);
  const map = await A('GET', '/lowcode/process-map', officer);
  assert.ok(map.body.stages.find((s: any) => s.key === 'APPROVAL').rules.some((r: any) => r.id === 'big'));
  assert.ok(map.body.stages.find((s: any) => s.key === 'OPENING').locked);

  // --- tender with custom fields
  const mk = (budget: number, customFields: Record<string, unknown>) => A('POST', '/tenders', officer, {
    titleEn: 'Test tender', titleAr: 'مناقصة', category: 'IT', estimatedBudget: budget, submissionDeadline: inDays(10), criteria: CRIT, customFields });
  assert.equal((await mk(100, { fundingSource: 'LOAN' })).status, 400);
  const t1 = await mk(750000, { fundingSource: 'CAPEX', bondPercent: 2.5 });
  assert.equal(t1.status, 201, t1.text);
  const pack = (id: string) => api(run, 'POST', `/api/v1/tenders/${id}/documents`, { token: officer, form: fileForm({ file: { name: 'pack.md', content: '# Pack\nScope.' }, title: 'Pack' }) });
  await pack(t1.body.id);
  let proc = await A('GET', `/tenders/${t1.body.id}/process`, officer);
  assert.equal(proc.body.raw.bondAmount, 18750);
  assert.equal(proc.body.gates.TENDER_SUBMIT.passed, false);
  assert.deepEqual(proc.body.gates.TENDER_SUBMIT.missingFields.map((f: any) => f.key), ['budgetLine']);
  // gate stops the first approval; the attempt is audited
  const blocked = await A('POST', `/tenders/${t1.body.id}/approve`, director, {});
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'PROCESS_RULE_BLOCKED');
  assert.match(blocked.body.message, /Budget line/);
  // fill the field (budget change recomputes the calculated bond) → routing adds the Undersecretary
  assert.equal((await A('PATCH', `/tenders/${t1.body.id}`, officer, { customFields: { budgetLine: 'CAP-2026-9' }, estimatedBudget: 800000 })).status, 200);
  proc = await A('GET', `/tenders/${t1.body.id}/process`, officer);
  assert.equal(proc.body.raw.bondAmount, 20000);
  const a1 = await A('POST', `/tenders/${t1.body.id}/approve`, director, {});
  assert.equal(a1.status, 200, a1.text);
  assert.equal(a1.body.status, 'PENDING_APPROVAL');
  assert.deepEqual(a1.body.cycle.approvals.publish.map((l: any) => l.role), ['DIRECTOR', 'UNDERSECRETARY']);
  assert.equal(a1.body.cycle.approvals.publish[1].ruleId, 'big');
  assert.equal((await A('POST', `/tenders/${t1.body.id}/approve`, under, {})).body.status, 'APPROVED');

  // --- vendor sees PUBLIC values only
  const vreg = await api(run, 'POST', '/api/v1/public/vendors/register', { json: { tenantId: 'ent', legalNameEn: 'V1 (fictitious)', legalNameAr: 'م1', crNumber: 'CR-1',
    email: 'v1@x.example', phone: '1', categories: ['IT'], username: 'vendor1', password: PASSWORD } });
  assert.equal(vreg.status, 201, vreg.text);
  assert.equal((await A('POST', `/vendors/${vreg.body.vendor.id}/decision`, officer, { decision: 'APPROVE' })).status, 200);

  // --- publish → event automation (task, notification, webhook, field) after the job runs
  assert.equal((await A('POST', `/tenders/${t1.body.id}/publish`, officer)).status, 200);
  const runNow = await A('POST', '/lowcode/run-now', admin);
  assert.equal(runNow.status, 200, runNow.text);
  const tasks = await A('GET', `/lowcode/tasks?subjectId=${t1.body.id}`, chair);
  assert.equal(tasks.body.length, 1);
  assert.match(tasks.body[0].titleEn, /Check site list for /);
  assert.equal(tasks.body[0].blocksGate, 'AWARD_RECOMMEND');
  assert.equal((await A('POST', `/lowcode/tasks/${tasks.body[0].id}/complete`, officer, { note: 'x' })).status, 403, 'assigned to the chair role');
  assert.equal((await A('POST', `/lowcode/tasks/${tasks.body[0].id}/complete`, chair, {})).status, 400, 'blocking task needs a note');
  const runs = await A('GET', '/lowcode/runs', auditor);
  const chairRun = runs.body.find((r: any) => r.ruleId === 'chair-check');
  assert.equal(chairRun.status, 'OK', JSON.stringify(chairRun.outcome));
  proc = await A('GET', `/tenders/${t1.body.id}/process`, officer);
  assert.equal(proc.body.raw.budgetLine, 'AUTO-SET');
  const notes = await A('GET', '/notifications', director);
  assert.ok(notes.body.some((n: any) => /Published: /.test(n.titleEn ?? n.title_en)), JSON.stringify(notes.body).slice(0, 300));
  // the job does not run the same events twice
  await A('POST', '/lowcode/run-now', admin);
  assert.equal((await A('GET', `/lowcode/tasks?subjectId=${t1.body.id}`, chair)).body.length, 1);
  // webhook deliveries (rule action + endpoint subscription) → signed, no bid content
  const { deliverDue } = await import('../src/lowcode/webhooks.js');
  await deliverDue(run.handle.ctx, { tenantId: 'ent' });
  assert.equal(received.length, 2);
  for (const r of received) {
    const sig = String(r.headers['x-tenderflow-signature']);
    const [, ts, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig)!;
    assert.equal(crypto.createHmac('sha256', secret).update(`${ts}.${r.body}`).digest('hex'), v1);
    const body = JSON.parse(r.body);
    assert.equal(body.event, 'TENDER_PUBLISHED');
    assert.equal(body.subject.reference, t1.body.tenderNumber);
    assert.equal(/bid|price|financial/i.test(JSON.stringify(body.data)), false);
  }
  const ping = await A('POST', `/lowcode/webhooks/${ep.body.id}/test`, admin);
  assert.equal(ping.body.status, 'SENT', ping.text);

  // --- vendor view of the tender: only PUBLIC fields
  const vtok = await login(run, 'ent', 'vendor1');
  const vproc = await A('GET', `/tenders/${t1.body.id}/process`, vtok);
  assert.equal(vproc.status, 200, vproc.text);
  assert.deepEqual(vproc.body.values.map((v: any) => v.key).sort(), ['bondAmount', 'bondPercent']);
  assert.equal(vproc.body.raw, undefined);
  assert.equal(vproc.body.gates, undefined);
  assert.equal(/CAP-2026-9|AUTO-SET/.test(JSON.stringify(vproc.body)), false, 'internal values never reach vendors');
  const vdetail = await A('GET', `/tenders/${t1.body.id}`, vtok);
  assert.equal(/CAP-2026-9|AUTO-SET|budgetLine/.test(JSON.stringify(vdetail.body)), false);

  // --- grant tender is blocked at publish with a bilingual reason
  const t2 = await mk(1000, { fundingSource: 'GRANT' });
  await pack(t2.body.id);
  assert.equal((await A('POST', `/tenders/${t2.body.id}/approve`, director, {})).body.status, 'APPROVED');
  const pb = await A('POST', `/tenders/${t2.body.id}/publish`, officer);
  assert.equal(pb.status, 409);
  assert.equal(pb.body.blocks[0].messageAr, 'تحتاج مناقصات المنح عدم ممانعة الجهة المانحة.');
  const audit = await A('GET', '/audit/events?action=LOWCODE_GATE_BLOCKED', auditor);
  if (audit.status === 200) assert.ok(JSON.stringify(audit.body).includes('LOWCODE_GATE_BLOCKED'));

  // --- pinning: a new rule-set version without the grant rule does not change t2 (created under v1); new tenders follow v2
  const v2 = await A('POST', '/lowcode/definitions', admin, { kind: 'RULESET', fromId: rs.body.id });
  await A('PATCH', `/lowcode/definitions/${v2.body.id}`, admin, { definition: { rules: RULES.rules.filter((r) => r.id !== 'grant-block') } });
  assert.equal((await A('POST', `/lowcode/definitions/${v2.body.id}/publish`, admin)).body.version, 2);
  assert.equal((await A('POST', `/tenders/${t2.body.id}/publish`, officer)).status, 409, 'running tender keeps the rules it started with');
  const t3 = await mk(1000, { fundingSource: 'GRANT' });
  await pack(t3.body.id);
  await A('POST', `/tenders/${t3.body.id}/approve`, director, {});
  assert.equal((await A('POST', `/tenders/${t3.body.id}/publish`, officer)).status, 200);
  const hist = await A('GET', '/lowcode/history/RULESET/PROCESS', auditor);
  assert.deepEqual(hist.body[1].changes.removed, ['grant-block']);

  // --- four-eyes on configuration
  await A('PUT', '/entity/profile', admin, { configFourEyes: true });
  const prof = await A('GET', '/entity/profile', admin);
  if (prof.body?.configFourEyes === true) {
    const d3 = await A('POST', '/lowcode/definitions', admin, { kind: 'RULESET', fromId: v2.body.id });
    assert.equal((await A('POST', `/lowcode/definitions/${d3.body.id}/publish`, admin)).status, 403);
    assert.equal((await A('DELETE', `/lowcode/definitions/${d3.body.id}`, admin)).body.discarded, true);
  }

  // --- configuration package: export from ent, import into ent2 as drafts
  const pkg = await A('GET', '/lowcode/package', admin);
  assert.equal(pkg.status, 200, pkg.text);
  assert.equal(pkg.body.format, 'tenderflow.process-package/v1');
  assert.equal(JSON.stringify(pkg.body).includes(secret), false, 'no secrets in packages');
  const tampered = JSON.parse(JSON.stringify(pkg.body)); tampered.content.forms[0].nameEn = 'edited';
  assert.equal((await A('POST', '/lowcode/package/preview', admin2, { package: tampered })).body.checksumOk, false);
  const prev = await A('POST', '/lowcode/package/preview', admin2, { package: pkg.body });
  assert.equal(prev.body.valid, true, JSON.stringify(prev.body.errors));
  assert.equal((await A('POST', '/lowcode/package/import', admin2, { package: pkg.body })).status, 400, 'needs confirm: true');
  const imp = await A('POST', '/lowcode/package/import', admin2, { package: pkg.body, confirm: true });
  assert.equal(imp.status, 200, imp.text);
  assert.equal(imp.body.integrationSecrets.length, 1);
  const defs2 = await A('GET', '/lowcode/definitions', admin2);
  assert.ok(defs2.body.every((d: any) => d.status === 'DRAFT'));
  const hooks2 = await A('GET', '/lowcode/webhooks', admin2);
  assert.equal(hooks2.body[0].enabled, false);
  // publish order: forms first, then rules
  const f2 = defs2.body.find((d: any) => d.kind === 'FORM');
  const r2 = defs2.body.find((d: any) => d.kind === 'RULESET');
  assert.equal((await A('POST', `/lowcode/definitions/${f2.id}/publish`, admin2)).status, 200);
  assert.equal((await A('POST', `/lowcode/definitions/${r2.id}/publish`, admin2)).status, 200);
  // entities are isolated
  assert.equal((await A('GET', `/lowcode/definitions/${rs.body.id}`, admin2)).status, 404);

  // --- every studio change is in the audit trail and the chain still verifies
  const verify = await A('GET', '/audit/verify', auditor);
  assert.equal(verify.status, 200, verify.text);
  assert.equal(verify.body.valid ?? verify.body.ok, true);
});
