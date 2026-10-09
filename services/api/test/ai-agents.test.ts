// Unit tests of the Phase 1 Orchestrate agents (AiService methods) against the local FAKE Orchestrate server
// (test/fakes/orchestrate.ts). Each method: valid output, repair turn, invalid output rejected, not configured → error.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAiService, AiNotConfiguredError, type DocText, type NarrateEvaluationInput } from '../src/ai/index.js';
import { AiOutputError, numbersIn, numbersNotInInput } from '../src/ai/parse.js';
import { gradeCriteria, DEFAULT_GRADE_CRITERIA } from '../src/ai/grade-criteria.js';
import { startFakeOrchestrate, type FakeOrchestrate } from './fakes/orchestrate.js';

let fake: FakeOrchestrate;
before(async () => { fake = await startFakeOrchestrate(); });
after(async () => { await fake.close(); });
beforeEach(() => { fake.calls.length = 0; fake.queue.length = 0; fake.reply = () => '{}'; });

const svc = () => createAiService({ env: fake.env, pollIntervalMs: 2, retryDelayMs: 2 });
const J = (o: unknown) => JSON.stringify(o);

const LETTER: DocText = { documentId: 'doc-letter', title: 'GM letter', sections: [
  { section: 'Request', text: 'The Distribution Operations Department requests a meter data management platform for 120,000 smart meters. Estimated budget 650,000 KWD. Required before the summer peak.' },
  { section: 'الطلب', text: 'تطلب إدارة عمليات التوزيع منصة لإدارة بيانات العدادات الذكية لعدد 120,000 عداد.' },
] };
const REQ = { requestNumber: 'KEA-REQ-2026-0001', department: 'Distribution Operations Department', subject: 'Smart meter data platform', source: 'LETTER', sourceReference: null };
const CLASSIFY_IN = {
  request: REQ, documents: [LETTER],
  activityCodes: [{ code: 'IT-01', nameEn: 'Software and systems integration', nameAr: 'البرمجيات وتكامل الأنظمة' }, { code: 'ENG-03', nameEn: 'Electrical works', nameAr: 'الأعمال الكهربائية' }],
  templates: [{ code: 'PUBLIC_TENDER', nameEn: 'Public tender', nameAr: 'مناقصة عامة' }, { code: 'RFP_TWO_ENVELOPE', nameEn: 'RFP', nameAr: 'طلب عروض' }],
};
const GOOD_CLASSIFY = { tenderType: 'PUBLIC_TENDER', activityCodes: ['it-01'], urgency: 'HIGH', estimatedBudget: 650000,
  summaryEn: 'A meter data management platform for 120,000 smart meters.', summaryAr: 'منصة لإدارة بيانات 120,000 عداد ذكي.',
  citations: [{ documentId: 'doc-letter', section: 'Request', quote: 'Estimated budget 650,000 KWD' }] };

describe('numbers that must come from the input', () => {
  test('normalises Arabic-Indic digits, thousands separators and trailing zeros', () => {
    assert.deepEqual(numbersIn('١٢٠٬٠٠٠ and 650,000 KWD, 85.50%, 13:00'), ['120000', '650000', '85.5', '13', '0']);
    assert.deepEqual(numbersNotInInput('Score 72.5 of 100, rank 1', 'weighted total 72.50; 100; rank 1'), []);
    assert.deepEqual(numbersNotInInput('Score 73 (rounded)', 'weighted total 72.5'), ['73']);
  });
});

describe('request classifier', () => {
  test('valid output: template and codes from the lists, budget from the text, citation resolved', async () => {
    fake.queue.push(J(GOOD_CLASSIFY));
    const r = await svc().classifyRequest(CLASSIFY_IN);
    assert.equal(fake.calls[0].agentName, 'tenderflow_request_classifier');
    assert.match(fake.calls[0].prompt, /PUBLIC_TENDER — Public tender/);
    assert.match(fake.calls[0].prompt, /\[DOC doc-letter \| GM letter \| Request\]/);
    assert.equal(r.output.tenderType, 'PUBLIC_TENDER');
    assert.deepEqual(r.output.activityCodes, ['IT-01']);
    assert.equal(r.output.estimatedBudget, 650000);
    assert.equal(r.citations[0].quote, 'Estimated budget 650,000 KWD');
    assert.equal((r.raw as any).repaired, false);
  });

  test('unknown activity code → one repair turn on the same thread', async () => {
    fake.queue.push(J({ ...GOOD_CLASSIFY, activityCodes: ['IT-99'] }), J(GOOD_CLASSIFY));
    const r = await svc().classifyRequest(CLASSIFY_IN);
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[1].continued, true);
    assert.equal(fake.calls[1].threadId, fake.calls[0].threadId);
    assert.match(fake.calls[1].prompt, /activity code "IT-99" is not one of the supplied codes/);
    assert.equal((r.raw as any).repaired, true);
  });

  test('a budget that is not in the input is rejected', async () => {
    const bad = J({ ...GOOD_CLASSIFY, estimatedBudget: 700000 });
    fake.queue.push(bad, bad);
    await assert.rejects(svc().classifyRequest(CLASSIFY_IN), (e: Error) => e instanceof AiOutputError && /700000 does not appear in the input/.test(e.message));
  });
});

const PACK: DocText = { documentId: 'doc-pack', title: 'DMS pack', sections: [
  { section: '1. Scope', text: 'Supply of a document management system with Arabic OCR.' },
  { section: '2. Dates', text: 'Bids are due on 2026-11-05 at 13:00 Kuwait time.' },
] };
const FACTS = [
  { label: 'Tender number', value: 'KEA-2026-102' }, { label: 'Submission deadline (Kuwait time)', value: '2026-11-05 13:00' },
  { label: 'Tender documents', value: 'Sold through the TenderFlow portal at 50 KWD' },
];
const GOOD_NOTICE = {
  noticeAr: 'تعلن الهيئة عن طرح المناقصة رقم KEA-2026-102 لتوريد نظام إدارة الوثائق. آخر موعد لتقديم العطاءات 2026-11-05 الساعة 13:00. ثمن الوثائق 50 د.ك.',
  noticeEn: 'The Authority invites bids for tender KEA-2026-102. Bids are due by 2026-11-05 at 13:00 Kuwait time. Documents cost 50 KWD.',
  citations: [{ documentId: 'doc-pack', section: '2. Dates' }],
};

describe('notice drafter', () => {
  test('valid bilingual notice with citations', async () => {
    fake.queue.push(J(GOOD_NOTICE));
    const r = await svc().draftNotice({ channel: 'KUWAIT_ALYOUM', facts: FACTS, documents: [PACK] });
    assert.equal(fake.calls[0].agentName, 'tenderflow_notice_drafter');
    assert.match(fake.calls[0].prompt, /Kuwait Al-Youm/);
    assert.match(r.output.noticeAr, /KEA-2026-102/);
    assert.equal(r.citations[0].section, '2. Dates');
  });

  test('an invented Hijri date triggers a repair; still invented → rejected', async () => {
    const hijri = J({ ...GOOD_NOTICE, noticeAr: `${GOOD_NOTICE.noticeAr} الموافق 4 جمادى الأولى 1448هـ` });
    fake.queue.push(hijri, J(GOOD_NOTICE));
    const ok = await svc().draftNotice({ channel: 'CAPT', facts: FACTS, documents: [PACK] });
    assert.match(fake.calls[1].prompt, /number\(s\) that do not appear in the input: 4, 1448/);
    assert.equal((ok.raw as any).repaired, true);
    fake.queue.push(hijri, hijri);
    await assert.rejects(svc().draftNotice({ channel: 'CAPT', facts: FACTS, documents: [PACK] }), AiOutputError);
  });

  test('English text in the Arabic field is rejected', async () => {
    const bad = J({ ...GOOD_NOTICE, noticeAr: GOOD_NOTICE.noticeEn });
    fake.queue.push(bad, bad);
    await assert.rejects(svc().draftNotice({ channel: 'CAPT', facts: FACTS, documents: [PACK] }), /must be written in Arabic/);
  });
});

const CANDS = [
  { id: 'v-1', label: 'Gulf Tech', profile: { activityCodes: ['IT-01'], pastBidsCount: 4 } },
  { id: 'v-2', label: 'Desert Data', profile: { activityCodes: ['IT-01'], pastBidsCount: 1 } },
];
const RANK_IN = { mode: 'VENDORS_FOR_TENDER' as const, subject: { id: 't-1', label: 'KEA-2026-102', profile: { category: 'IT' } }, candidates: CANDS };

describe('relevance matcher', () => {
  test('ranks only the given (already eligible) candidates, sorted by score', async () => {
    fake.queue.push(J({ ranked: [
      { id: 'v-2', score: 55, reasonsEn: 'Same activity code, one prior bid.', reasonsAr: 'نفس رمز النشاط.' },
      { id: 'v-1', score: 81.4, reasonsEn: 'Same activity code and four prior bids.', reasonsAr: 'نفس رمز النشاط وأربعة عطاءات سابقة.' },
    ] }));
    const r = await svc().rankRelevance(RANK_IN);
    assert.equal(fake.calls[0].agentName, 'tenderflow_relevance_matcher');
    assert.match(fake.calls[0].prompt, /ALREADY passed TenderFlow's rule-based eligibility/);
    assert.deepEqual(r.output.ranked.map((x) => [x.id, x.score]), [['v-1', 81], ['v-2', 55]]);
  });

  test('an invented candidate or a missing one is rejected', async () => {
    const bad = J({ ranked: [{ id: 'v-1', score: 80, reasonsEn: 'x', reasonsAr: 'س' }, { id: 'v-999', score: 90, reasonsEn: 'x', reasonsAr: 'س' }] });
    fake.queue.push(bad, bad);
    await assert.rejects(svc().rankRelevance(RANK_IN), (e: Error) => /"v-999" is not one of the candidate ids/.test(e.message) && /missing: v-2/.test(e.message));
  });
});

const NARR_IN: NarrateEvaluationInput = {
  tender: { tenderNumber: 'KEA-2026-088', titleEn: 'IT Service Desk', titleAr: 'مكتب الخدمة', envelopes: 'ONE', technicalPassMark: null },
  criteria: [{ key: 'technical', nameEn: 'Technical', nameAr: 'فني', weight: 60 }, { key: 'price', nameEn: 'Price', nameAr: 'السعر', weight: 40 }],
  bids: [
    { bidRef: 'BID-1', vendorNameEn: 'Gulf Tech', vendorNameAr: 'الخليج للتقنية', technicalResult: null, averageWeightedTotal: 82.4, compliance: null,
      evaluations: [{ evaluator: 'Evaluator One', weightedTotal: 82.4, scores: [{ criterion: 'technical', score: 85, comment: 'Strong ITIL coverage' }, { criterion: 'price', score: 78.5, comment: '' }] }] },
    { bidRef: 'BID-2', vendorNameEn: 'Desert Data', vendorNameAr: 'الصحراء للبيانات', technicalResult: null, averageWeightedTotal: 70, compliance: [{ requirement: 'CR', status: 'PRESENT' }],
      evaluations: [{ evaluator: 'Evaluator One', weightedTotal: 70, scores: [{ criterion: 'technical', score: 70, comment: '' }, { criterion: 'price', score: 70, comment: '' }] }] },
  ],
  recommendedBidRef: 'BID-1', recommendationJustification: 'Highest weighted total.',
};
const GOOD_NARR = {
  narrativeEn: 'The committee evaluated 2 bids against Technical (60%) and Price (40%). Gulf Tech (BID-1) obtained 82.4 and Desert Data (BID-2) 70. The chair recommended BID-1: highest weighted total.',
  narrativeAr: 'قيّمت اللجنة عطاءين وفق المعيار الفني (60%) والسعر (40%). حصل عطاء الخليج للتقنية (BID-1) على 82.4 وعطاء الصحراء للبيانات (BID-2) على 70.',
};

describe('evaluation narrator', () => {
  test('valid narrative quoting only numbers from the input', async () => {
    fake.queue.push(J(GOOD_NARR));
    const r = await svc().narrateEvaluation(NARR_IN);
    assert.equal(fake.calls[0].agentName, 'tenderflow_evaluation_narrator');
    assert.match(fake.calls[0].prompt, /"averageWeightedTotal": 82.4/);
    assert.equal(r.output.narrativeEn, GOOD_NARR.narrativeEn);
  });

  test('a changed score (82.4 → 83) is rejected after the repair turn', async () => {
    const bad = J({ ...GOOD_NARR, narrativeEn: GOOD_NARR.narrativeEn.replace('82.4', '83') });
    fake.queue.push(bad, bad);
    await assert.rejects(svc().narrateEvaluation(NARR_IN), (e: Error) => e instanceof AiOutputError && /do not appear in the input: 83/.test(e.message));
    assert.match(fake.calls[1].prompt, /narrativeEn" contains number\(s\) that do not appear in the input: 83/);
  });

  test('an invented count is repaired when the agent corrects it', async () => {
    fake.queue.push(J({ ...GOOD_NARR, narrativeAr: `${GOOD_NARR.narrativeAr} شارك 3 مقيمين.` }), J(GOOD_NARR));
    const r = await svc().narrateEvaluation(NARR_IN);
    assert.equal((r.raw as any).repaired, true);
  });
});

const VENDOR_DOC: DocText = { documentId: 'doc-v', title: 'Company file', sections: [
  { section: 'Commercial registration', text: 'Commercial registration No. 556677, valid until 2027-03-01.' },
  { section: 'Financials', text: 'Audited financial statements for 2025 are attached.' },
] };

describe('grade reviewer', () => {
  test('checklist from the configurable default; PRESENT needs a citation', async () => {
    const criteria = DEFAULT_GRADE_CRITERIA.slice(0, 2);
    fake.queue.push(J({ items: [
      { requirement: 'COMMERCIAL_REGISTRATION', status: 'PRESENT', evidence: 'CR found', citation: { documentId: 'doc-v', section: 'Commercial registration' } },
      { requirement: 'CHAMBER_CERTIFICATE', status: 'MISSING', evidence: 'No chamber certificate', citation: null },
    ] }));
    const r = await svc().reviewGrade({ vendor: { nameEn: 'Gulf Tech', nameAr: 'الخليج', crNumber: 'CR-1' }, grade: 2, criteria, documents: [VENDOR_DOC] });
    assert.equal(fake.calls[0].agentName, 'tenderflow_grade_reviewer');
    assert.match(fake.calls[0].prompt, /Second grade/);
    assert.deepEqual(r.output.items.map((i) => i.status), ['PRESENT', 'MISSING']);
  });

  test('a grade decision or score instead of a status is rejected', async () => {
    const bad = J({ items: [{ requirement: 'COMMERCIAL_REGISTRATION', status: 'GRADE_GRANTED', score: 90 }] });
    fake.queue.push(bad, bad);
    await assert.rejects(svc().reviewGrade({ vendor: { nameEn: 'x', nameAr: 'س', crNumber: '1' }, grade: 1, criteria: DEFAULT_GRADE_CRITERIA.slice(0, 1), documents: [VENDOR_DOC] }),
      /PRESENT, MISSING or UNCLEAR/);
  });

  test('WXO_GRADE_CRITERIA overrides the checklist per grade; invalid JSON is an error', () => {
    const env = { WXO_GRADE_CRITERIA: J({ 1: [{ key: 'ISO', nameEn: 'ISO certificate', nameAr: 'شهادة ايزو' }] }) };
    assert.deepEqual(gradeCriteria(1, env).map((c) => c.key), ['ISO']);
    assert.throws(() => gradeCriteria(2, env), /no valid checklist for grade 2/);
    assert.throws(() => gradeCriteria(1, { WXO_GRADE_CRITERIA: '{oops' }), /not valid JSON/);
  });
});

const CONTEXT: DocText[] = [{ documentId: 'tenderflow-context', title: 'TenderFlow context', sections: [
  { section: 'Pending tasks', text: 'Number of pending tasks: 2.\n1. Approve tender KEA-2026-101\n2. Answer 1 open clarification question(s) on KEA-2026-102' },
] }];

describe('assistant (supervisor)', () => {
  test('structured answer with citations; follow-up continues the same Orchestrate thread', async () => {
    fake.queue.push(J({ answer: 'You have 2 tasks: approve KEA-2026-101 and answer 1 clarification.', notFound: false, citations: [{ documentId: 'tenderflow-context', section: 'Pending tasks' }] }));
    const ai = svc();
    const r = await ai.chat({ message: 'What is waiting for me?', context: CONTEXT });
    assert.equal(fake.calls[0].agentName, 'tenderflow_assistant');
    assert.equal(fake.calls[0].continued, false);
    assert.equal(r.output.structured, true);
    assert.equal(r.citations[0].section, 'Pending tasks');
    const thread = (r.raw as any).threadId;
    fake.queue.push('لديك مهمتان.');
    const r2 = await ai.chat({ message: 'ما المطلوب مني اليوم؟', threadId: thread, context: CONTEXT });
    assert.equal(fake.calls[1].threadId, thread);
    assert.equal(fake.calls[1].continued, true);
    assert.match(fake.calls[1].prompt, /language: Arabic/);
    assert.equal(r2.output.structured, false, 'plain text accepted as the answer');
    assert.equal(r2.output.answer, 'لديك مهمتان.');
  });

  test('a number that is not in the context is repaired, then rejected', async () => {
    fake.queue.push(J({ answer: 'You have 5 tasks.', notFound: false, citations: [] }), J({ answer: 'You have 2 tasks.', notFound: false, citations: [] }));
    const r = await svc().chat({ message: 'How many tasks?', context: CONTEXT });
    assert.match(fake.calls[1].prompt, /do not appear in the input: 5/);
    assert.equal(r.output.answer, 'You have 2 tasks.');
    const bad = J({ answer: 'The budget is 999999 KWD.', notFound: false, citations: [] });
    fake.queue.push(bad, bad);
    await assert.rejects(svc().chat({ message: 'Budget?', context: CONTEXT }), AiOutputError);
  });
});

describe('configuration', () => {
  test('not configured → every new method throws AI_NOT_CONFIGURED without calling out', async () => {
    const ai = createAiService({ env: {} });
    const calls = [
      () => ai.classifyRequest(CLASSIFY_IN), () => ai.draftNotice({ channel: 'CAPT', facts: FACTS, documents: [PACK] }), () => ai.rankRelevance(RANK_IN),
      () => ai.narrateEvaluation(NARR_IN), () => ai.reviewGrade({ vendor: { nameEn: 'x', nameAr: 'س', crNumber: '1' }, grade: 1, criteria: DEFAULT_GRADE_CRITERIA, documents: [VENDOR_DOC] }),
      () => ai.chat({ message: 'hi', context: CONTEXT }),
    ];
    for (const c of calls) await assert.rejects(c(), (e: Error) => e instanceof AiNotConfiguredError && (e as AiNotConfiguredError).code === 'AI_NOT_CONFIGURED');
    assert.equal(fake.calls.length, 0);
  });

  test('ping checks all nine agents and WXO_AGENT_* overrides', async () => {
    const ok = await svc().ping();
    assert.equal(ok.ok, true, ok.detail);
    assert.match(ok.detail, /tenderflow_assistant=found/);
    assert.match(ok.detail, /tenderflow_evaluation_narrator=found/);
    const missing = await createAiService({ env: { ...fake.env, WXO_AGENT_ASSISTANT: 'my_supervisor' }, pollIntervalMs: 2 }).ping();
    assert.equal(missing.ok, false);
    assert.match(missing.detail, /my_supervisor=MISSING/);
  });
});

describe('Phase 1 agent eval set (agents/evals/agents)', () => {
  test('every case validates, runs through the production service and is scored', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { validateAgentEvalFile, runAgentCase, scoreAgentCase } = await import('../src/ai/tools/agent-evals.js');
    const dir = join(process.cwd(), '..', '..', 'agents', 'evals', 'agents');
    const files = readdirSync(dir).filter((f: string) => f.endsWith('.json'));
    assert.ok(files.length >= 1);
    const ai = svc();
    let n = 0;
    const langs = new Set<string>(); const agents = new Set<string>();
    for (const f of files) {
      const set = validateAgentEvalFile(JSON.parse(readFileSync(join(dir, f), 'utf8')), f);
      for (const c of set.cases) {
        n++; langs.add(c.language); agents.add(c.agent);
        // An "ideal" reply derived from the expectations: proves the case input is accepted by the prompt builder and
        // validator, and that the scorer passes a correct answer (live quality is measured by `npm run evals`).
        fake.reply = (call) => {
          const m = [...call.prompt.matchAll(/\[DOC ([^|\]]+?) \| [^|\]]*? \| ([^\]]+?)\]/g)].map((x) => ({ documentId: x[1].trim(), section: x[2].trim() }));
          const e = c.expect; const inp = c.input as any;
          switch (c.agent) {
            case 'requestClassifier': return J({ tenderType: e.tenderType?.[0] ?? inp.templates[0].code, activityCodes: e.activityCodesInclude ?? [], urgency: e.urgency ?? 'MEDIUM',
              estimatedBudget: e.estimatedBudget ?? null, summaryEn: 'Summary.', summaryAr: 'ملخص.', citations: m.slice(0, 1) });
            case 'noticeDrafter': return J({ noticeAr: `إعلان ${(e.arContains ?? []).join(' ')}`, noticeEn: `Notice ${(e.enContains ?? []).join(' ')}`, citations: m.slice(0, 1) });
            case 'relevanceMatcher': return J({ ranked: inp.candidates.map((x: any) => ({ id: x.id, score: x.id === e.topId ? 90 : 40, reasonsEn: 'r', reasonsAr: 'س' })) });
            case 'evaluationNarrator': return J({ narrativeEn: `Narrative ${(e.enContains ?? []).join(' ')}`, narrativeAr: `سرد ${(e.arContains ?? []).join(' ')}` });
            case 'gradeReviewer': return J({ items: inp.criteria.map((k: any) => {
              const st = e.status?.[k.key] ?? 'MISSING';
              return { requirement: k.key, status: st, evidence: 'e', citation: st === 'PRESENT' ? m[0] : null };
            }) });
            case 'assistant': return J({ answer: e.notFound ? 'Not in the context.' : (e.contains ?? []).map((k) => k.split('|')[0]).join(' '), notFound: e.notFound ?? false, citations: e.notFound ? [] : m.slice(0, 1) });
          }
        };
        const res = await runAgentCase(ai, c);
        const score = scoreAgentCase(c, res.output);
        assert.ok(score.pass, `${c.id}: ${JSON.stringify(score.checks.filter((x) => !x.ok))}`);
      }
    }
    assert.ok(n >= 12);
    assert.deepEqual([...agents].sort(), ['assistant', 'evaluationNarrator', 'gradeReviewer', 'noticeDrafter', 'relevanceMatcher', 'requestClassifier']);
    assert.ok(langs.has('ar') && langs.has('en'));
  });

  test('the scorer fails a wrong answer', async () => {
    const { scoreAgentCase } = await import('../src/ai/tools/agent-evals.js');
    const c = { id: 'x', agent: 'relevanceMatcher' as const, language: 'en', input: {}, expect: { topId: 'a' } };
    assert.equal(scoreAgentCase(c, { ranked: [{ id: 'b' }, { id: 'a' }] }).pass, false);
  });
});
