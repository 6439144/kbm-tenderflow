// npm run verify:ai — live check of the watsonx Orchestrate integration.
// 1) config presence (no secret values printed) 2) IAM token 3) all eleven agents present 4) one real clarification
// on an embedded bilingual sample, printing the parsed answer and citations 5) one real turn of the supervisor
// tenderflow_assistant on a small role-scoped context 6) one real document-intelligence run on an embedded bilingual
// commercial registration (classification + cited fields, validated) 7) one real admin-builder turn (a plain-language
// admin request → a strictly validated change proposal containing an ADD_RULE). Exits non-zero on any failure.
// Per-agent quality for the other specialists: `npm run evals -- agents`.
import { loadRepoEnv, findRepoRoot } from '../ai/tools/env.js';
import { readAiConfig, missingSettings, type AgentRole } from '../ai/config.js';
import { OrchestrateClient } from '../ai/orchestrate-client.js';
import { createAiService } from '../ai/index.js';
import type { DocText, DocTypeDef } from '../ai/types.js';

const CR_SAMPLE: DocText = {
  documentId: 'verify-cr', title: 'Commercial registration (fictitious) / سجل تجاري (وهمي)',
  sections: [
    { section: 'Registration / بيانات السجل', text: 'Commercial registration No. CR-900001\nCompany: Verification Sample Trading W.L.L. (fictitious)\nرقم السجل التجاري: CR-900001' },
    { section: 'Validity / الصلاحية', text: 'Issue date: 01/02/2024\nExpiry date: 31/01/2029\nتاريخ الانتهاء: 31/01/2029' },
  ],
};
const CR_CATALOGUE: DocTypeDef[] = [
  { code: 'COMMERCIAL_REGISTRATION', nameEn: 'Commercial registration', nameAr: 'السجل التجاري', fields: [
    { key: 'crNumber', labelEn: 'CR number', labelAr: 'رقم السجل التجاري', type: 'text', required: true },
    { key: 'companyName', labelEn: 'Company name', labelAr: 'اسم الشركة', type: 'text', required: true },
    { key: 'expiryDate', labelEn: 'Expiry date', labelAr: 'تاريخ الانتهاء', type: 'date', required: true }] },
  { code: 'BANK_GUARANTEE', nameEn: 'Bank guarantee', nameAr: 'كفالة بنكية', fields: [
    { key: 'amount', labelEn: 'Amount', labelAr: 'المبلغ', type: 'amount', required: true }] },
  { code: 'OTHER', nameEn: 'Other document', nameAr: 'مستند آخر', fields: [] },
];

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
  const context: DocText[] = [{ documentId: 'verify-context', title: 'TenderFlow context (verification sample)', sections: [
    { section: 'Pending tasks / المهام المعلقة', text: 'Number of pending tasks: 1.\n1. Approve tender VER-2026-001 (approval level 1 of 2: Director) / اعتماد المناقصة VER-2026-001 (مستوى الاعتماد 1 من 2: مدير)' },
  ] }];
  const message = 'What is waiting for me?';
  console.log(`\nLive supervisor turn (tenderflow_assistant): ${message}`);
  const t1 = Date.now();
  try {
    const res = await ai.chat({ message, context });
    const meta = res.raw as { runId?: string; threadId?: string; repaired?: boolean } | undefined;
    line('agent / model', `${res.agent} / ${res.model ?? '(not reported)'}`);
    line('run id / thread id', `${meta?.runId ?? '-'} / ${meta?.threadId ?? '-'}`);
    line('elapsed', `${Date.now() - t1} ms`);
    line('structured JSON reply', String(res.output.structured));
    line('notFound', String(res.output.notFound));
    console.log(`answer: ${res.output.answer}`);
    for (const c of res.citations) console.log(`  - [${c.documentId} | ${c.section}]`);
    if (res.output.notFound || !/VER-2026-001/.test(res.output.answer)) { console.error('\nFAIL: the supervisor did not answer from the supplied context (expected the task on VER-2026-001).'); return 8; }
  } catch (e) {
    console.error(`\nFAIL: live supervisor turn failed: ${(e as Error).message}`);
    return 9;
  }
  console.log('\nLive document intelligence (tenderflow_document_intelligence) on a bilingual CR sample');
  const t2 = Date.now();
  try {
    const res = await ai.classifyDocument({ document: CR_SAMPLE, catalogue: CR_CATALOGUE, context: { ownerType: 'VENDOR', uploaderRole: 'VENDOR', slotTitle: 'Commercial registration' } });
    const meta = res.raw as { runId?: string; repaired?: boolean } | undefined;
    line('agent / model', `${res.agent} / ${res.model ?? '(not reported)'}`);
    line('run id', meta?.runId ?? '-');
    line('elapsed', `${Date.now() - t2} ms`);
    line('repair turn used', String(meta?.repaired ?? false));
    line('docType / language', `${res.output.docType} / ${res.output.language}`);
    for (const f of res.output.fields) console.log(`  - ${f.key} = ${JSON.stringify(f.value)}  [${f.citation.section}] "${f.citation.quote}"`);
    const exp = res.output.fields.find((f) => f.key === 'expiryDate')?.value;
    if (res.output.docType !== 'COMMERCIAL_REGISTRATION' || exp !== '2029-01-31') {
      console.error('\nFAIL: expected COMMERCIAL_REGISTRATION with expiryDate 2029-01-31 (validated by TenderFlow).'); return 10;
    }
  } catch (e) {
    console.error(`\nFAIL: live document intelligence failed: ${(e as Error).message}`);
    return 11;
  }
  const adminMsg = 'Tenders above 1,000,000 KWD need the Undersecretary';
  console.log(`\nLive admin builder (tenderflow_admin_builder): ${adminMsg}`);
  const t3 = Date.now();
  try {
    const res = await ai.buildAdminProposal({
      message: adminMsg, currentOperations: null, history: [], customFacts: [],
      state: [
        { section: 'Cycle templates of this entity', text: '- PUBLIC_TENDER — Public tender (one envelope) — published v1 (default) — one envelope; publication approvals: Procurement Director' },
        { section: 'Process rules', text: 'Rule set PROCESS: nothing published.' },
      ],
    });
    const meta = res.raw as { runId?: string; repaired?: boolean } | undefined;
    line('agent / model', `${res.agent} / ${res.model ?? '(not reported)'}`);
    line('run id', meta?.runId ?? '-');
    line('elapsed', `${Date.now() - t3} ms`);
    line('repair turn used', String(meta?.repaired ?? false));
    line('operations', res.output.operations.map((o) => o.op).join(', ') || '(none)');
    console.log(`reply (en): ${res.output.reply.en}\nreply (ar): ${res.output.reply.ar}`);
    if (!res.output.operations.some((o) => o.op === 'ADD_RULE')) { console.error('\nFAIL: expected an ADD_RULE operation (TenderFlow validates the rule itself when it is proposed in the app).'); return 12; }
  } catch (e) {
    console.error(`\nFAIL: live admin builder failed: ${(e as Error).message}`);
    return 13;
  }
  console.log('\nOK: watsonx Orchestrate integration verified.');
  return 0;
}

main().then((code) => { process.exitCode = code; }, (e) => { console.error(`FAIL: ${(e as Error).message}`); process.exitCode = 1; });
