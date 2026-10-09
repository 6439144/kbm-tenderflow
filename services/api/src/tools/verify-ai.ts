// npm run verify:ai — live check of the watsonx Orchestrate integration.
// 1) config presence (no secret values printed) 2) IAM token 3) agents present 4) one real clarification
// on an embedded bilingual sample, printing the parsed answer and citations. Exits non-zero on any failure.
import { loadRepoEnv, findRepoRoot } from '../ai/tools/env.js';
import { readAiConfig, missingSettings, type AgentRole } from '../ai/config.js';
import { OrchestrateClient } from '../ai/orchestrate-client.js';
import { createAiService } from '../ai/index.js';
import type { DocText } from '../ai/types.js';

const SAMPLE: DocText = {
  documentId: 'verify-sample',
  title: 'Verification Sample Tender (fictitious) / مناقصة تحقق تجريبية (خيالية)',
  sections: [
    { section: 'Submission / تقديم العطاءات', text: 'Bids must be submitted through the portal no later than 12 November 2026 at 13:00 Kuwait time.\nيجب تقديم العطاءات عبر البوابة في موعد أقصاه 12 نوفمبر 2026 الساعة 13:00 بتوقيت الكويت.' },
    { section: 'Bid Security / ضمان العطاء', text: 'A bid security of 2% of the bid value, valid for 120 days, is required.\nيلزم تقديم ضمان عطاء بنسبة 2% من قيمة العطاء وساري لمدة 120 يوماً.' },
    { section: 'Warranty / الضمان', text: 'The supplier shall provide a warranty of 24 months from acceptance.\nيلتزم المورد بتقديم ضمان لمدة 24 شهراً من تاريخ الاستلام.' },
  ],
};

function line(label: string, value: string) { console.log(`${label.padEnd(38)} ${value}`); }

async function main(): Promise<number> {
  const root = findRepoRoot();
  const envPath = loadRepoEnv(root);
  console.log('TenderFlow AI verification (watsonx Orchestrate)');
  line('.env', envPath ?? '(not found — using process environment only)');
  const cfg = readAiConfig();
  let host = '(missing)';
  try { if (cfg.instanceUrl) host = new URL(cfg.instanceUrl).host; } catch { host = '(invalid URL)'; }
  line('WXO_INSTANCE_URL', cfg.instanceUrl ? `set (host ${host})` : 'MISSING');
  line('WXO_API_KEY', cfg.apiKey ? 'set' : 'MISSING');
  line('WXO_IAM_URL', cfg.iamUrl);
  for (const r of Object.keys(cfg.agents) as AgentRole[]) line(`agent ${r}`, cfg.agents[r]);
  const missing = missingSettings(cfg);
  if (missing.length) { console.error(`\nFAIL: missing settings: ${missing.join(', ')} (set them in ${root}/.env)`); return 2; }

  const client = new OrchestrateClient({ instanceUrl: cfg.instanceUrl, apiKey: cfg.apiKey, iamUrl: cfg.iamUrl, timeoutMs: cfg.timeoutMs });
  try { await client.getToken(); line('IAM token', 'OK'); } catch (e) { line('IAM token', 'FAIL'); console.error((e as Error).message); return 3; }

  let ok = true;
  try {
    const agents = await client.listAgents();
    line('agents on instance', String(agents.length));
    for (const r of Object.keys(cfg.agents) as AgentRole[]) {
      const ref = cfg.agents[r];
      const a = agents.find((x) => x.name === ref || x.id === ref);
      line(`  ${ref}`, a ? `found (id ${a.id}${a.llm ? `, llm ${a.llm}` : ''})` : 'MISSING');
      if (!a) ok = false;
    }
  } catch (e) { console.error(`List agents FAIL: ${(e as Error).message}`); return 4; }
  if (!ok) { console.error('\nFAIL: one or more agents are missing. Run agents/import.ps1 (Windows) or agents/import.sh.'); return 5; }

  const ai = createAiService();
  const question = 'ما هي مدة سريان ضمان العطاء المطلوب؟';
  console.log(`\nLive clarification (Arabic question): ${question}`);
  const t0 = Date.now();
  try {
    const res = await ai.draftClarification({ tender: { titleEn: 'Verification Sample Tender', titleAr: 'مناقصة تحقق تجريبية' }, question, documents: [SAMPLE], priorAnswers: [] });
    const meta = res.raw as { runId?: string; repaired?: boolean; droppedCitations?: number } | undefined;
    line('agent / model', `${res.agent} / ${res.model ?? '(not reported)'}`);
    line('run id', meta?.runId ?? '-');
    line('elapsed', `${Date.now() - t0} ms`);
    line('repair turn used', String(meta?.repaired ?? false));
    line('language', res.output.language);
    line('notFound', String(res.output.notFound));
    console.log(`answer: ${res.output.answer}`);
    console.log('citations:');
    for (const c of res.citations) console.log(`  - [${c.documentId} | ${c.section}]${c.quote ? ` "${c.quote}"` : ''}`);
    if (meta?.droppedCitations) console.log(`  (${meta.droppedCitations} citation(s) dropped: did not match a provided section)`);
    if (res.output.notFound || res.citations.length === 0) { console.error('\nFAIL: the agent did not return a cited answer for a question the sample text answers (expected: 120 days).'); return 6; }
  } catch (e) {
    console.error(`\nFAIL: live clarification failed: ${(e as Error).message}`);
    return 7;
  }
  console.log('\nOK: watsonx Orchestrate integration verified.');
  return 0;
}

main().then((code) => { process.exitCode = code; }, (e) => { console.error(`FAIL: ${(e as Error).message}`); process.exitCode = 1; });
