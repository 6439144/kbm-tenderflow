// Orchestrate is connected but the TenderFlow agents were never imported on the instance (the state a fresh
// TechZone instance is in before agents/import.ps1). The API must say exactly that — 503 AI_AGENT_NOT_IMPORTED
// naming the agent — never a generic failure and never a simulated reply; the task list still works without AI.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, login, makeTenant, makeUser, startApp } from './helpers.js';
import { AGENT_NAMES, startFakeOrchestrate } from './fakes/orchestrate.js';

const fake = await startFakeOrchestrate();
after(async () => { await fake.close(); for (const k of Object.keys(fake.env)) delete process.env[k]; });

test('agents not imported: status lists them, chat returns 503 AI_AGENT_NOT_IMPORTED, tasks still work', async () => {
  for (const n of AGENT_NAMES) fake.hidden.add(n);
  Object.assign(process.env, fake.env);
  const run = await startApp();
  try {
    await makeTenant(run, 'ni');
    await makeUser(run, 'ni', 'officer', ['PROCUREMENT_OFFICER']);
    const tok = await login(run, 'ni', 'officer');

    const st = await api(run, 'GET', '/api/v1/assistant/status', { token: tok });
    assert.equal(st.status, 200, st.text);
    assert.equal(st.body.configured, true);
    assert.equal(st.body.agents.checked, true);
    assert.ok(st.body.agents.missing.some((m: any) => m.role === 'assistant' && m.name === 'tenderflow_assistant'), st.text);
    assert.ok(!JSON.stringify(st.body).includes('SECRET'), 'no credentials in the status');

    const r = await api(run, 'POST', '/api/v1/assistant/chat', { token: tok, json: { message: 'What is waiting for me?' } });
    assert.equal(r.status, 503, r.text);
    assert.equal(r.body.code, 'AI_AGENT_NOT_IMPORTED');
    assert.match(r.body.message, /tenderflow_assistant/);
    assert.equal(fake.calls.length, 0, 'no run was started on the instance');

    const rows = await run.handle.ctx.db.query<any>(`SELECT kind, status FROM ai_runs WHERE tenant_id='ni'`);
    assert.deepEqual(rows.map((x) => [x.kind, x.status]), [['ASSISTANT_CHAT', 'ERROR']], 'the failed attempt is recorded');

    const tasks = await api(run, 'GET', '/api/v1/assistant/my-tasks', { token: tok });
    assert.equal(tasks.status, 200, 'my-tasks needs no AI');

    // Once the agent is imported, the same call goes through.
    fake.hidden.clear();
    fake.reply = () => JSON.stringify({ answer: 'Nothing is waiting for you.', notFound: false, citations: [] });
    const ok = await api(run, 'POST', '/api/v1/assistant/chat', { token: tok, json: { message: 'What is waiting for me?' } });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.body.agent, 'tenderflow_assistant');
  } finally {
    await run.stop();
  }
});
