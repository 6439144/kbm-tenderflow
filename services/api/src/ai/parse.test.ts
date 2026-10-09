// Pure-function tests: JSON extraction, citation mapping, prompt budgeting, bilingual normalisation, eval scoring, .env parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonObject, resolveCitation, AiOutputError } from './parse.js';
import { renderDocuments, buildClarificationPrompt } from './prompts.js';
import { normalizeText, detectLanguage, keyTerms } from './text-utils.js';
import { scoreAnswer } from './tools/evals.js';
import { parseDotEnv } from './tools/env.js';
import { markdownToDocText } from './tools/markdown-doc.js';
import type { DocText } from './types.js';

test('extractJsonObject handles plain, fenced, prose-wrapped and brace-in-string JSON', () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJsonObject('Sure!\n```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJsonObject('Result: {"a":"x } y","b":{"c":[1,2]}} done'), { a: 'x } y', b: { c: [1, 2] } });
  assert.deepEqual(extractJsonObject('note {not json} then {"ok":true}'), { ok: true });
  assert.throws(() => extractJsonObject('no json here'), AiOutputError);
  assert.throws(() => extractJsonObject('[1,2,3]'), AiOutputError);
});

const DOCS: DocText[] = [{ documentId: 'd1', title: 'Pack', sections: [
  { section: '4. Bid Security / ضمان العطاء', text: 'A bid security of 2%. ضمان عطاء بنسبة 2%.' },
  { section: 'Annex A', text: 'Forms.' },
] }];

test('resolveCitation maps exact, normalised and marker-string citations; drops invented ones', () => {
  assert.equal(resolveCitation({ documentId: 'd1', section: '4. Bid Security / ضمان العطاء' }, DOCS)?.section, '4. Bid Security / ضمان العطاء');
  assert.equal(resolveCitation({ documentId: 'd1', section: '4 bid security ضمان العطاء' }, DOCS)?.section, '4. Bid Security / ضمان العطاء');
  assert.equal(resolveCitation({ documentId: 'wrong', title: 'Pack', section: 'Annex A' }, DOCS)?.documentId, 'd1');
  assert.equal(resolveCitation('[DOC d1 | Pack | Annex A]', DOCS)?.section, 'Annex A');
  assert.equal(resolveCitation({ documentId: 'd1', section: 'Annex B' }, DOCS), undefined);
  assert.equal(resolveCitation({ documentId: 'd2', section: 'Annex A' }, DOCS), undefined);
  assert.equal(resolveCitation({ documentId: 'd1', section: '' }, DOCS), undefined);
  assert.equal(resolveCitation({ documentId: 'd1', section: 'Annex A', quote: 'Forms.' }, DOCS)?.quote, 'Forms.');
});

test('renderDocuments keeps everything under budget and prefers key-term sections when over', () => {
  const big: DocText[] = [{ documentId: 'big', title: 'Big', sections: [
    { section: 'Intro', text: 'lorem '.repeat(500) },
    { section: 'Penalties', text: 'Delay penalty 0.5% per week. ' + 'x'.repeat(1500) },
    { section: 'Other', text: 'ipsum '.repeat(500) },
  ] }];
  const all = renderDocuments(big, [], 100000);
  assert.equal(all.included, 3); assert.equal(all.omitted, 0);
  const small = renderDocuments(big, keyTerms('What is the delay penalty?'), 2200);
  assert.match(small.text, /\[DOC big \| Big \| Penalties\]/);
  assert.ok(small.text.length <= 2300, `rendered ${small.text.length} chars`);
  assert.ok(small.omitted >= 1);
  const order = ['Intro', 'Penalties', 'Other'].map((s) => small.text.indexOf(`| ${s}]`)).filter((i) => i >= 0);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'document order preserved');
});

test('clarification prompt contains task, markers, language rule, notFound rule and schema', () => {
  const p = buildClarificationPrompt({ tender: { titleEn: 'T', titleAr: 'ت' }, question: 'ما قيمة الضمان؟', documents: DOCS, priorAnswers: [{ question: 'q1', answer: 'a1' }] }, 'ar', 24000);
  for (const re of [/CLARIFICATION DRAFT/, /\[DOC d1 \| Pack \| 4\. Bid Security/, /"notFound": true/, /Never approve, reject, award/, /"language" must be "ar"/, /PREVIOUSLY PUBLISHED ANSWERS/, /BEGIN DOCUMENTS/]) assert.match(p, re);
});

test('normalizeText / detectLanguage handle Arabic variants and digits', () => {
  assert.equal(normalizeText('الضَّمانُ  أكتوبر ١٥٠ ٪ 1,000'), 'الضمان اكتوبر 150 ٪ 1000');
  assert.equal(normalizeText('Café'), 'cafe');
  assert.equal(detectLanguage('ما هو الموعد؟'), 'ar');
  assert.equal(detectLanguage('What is the ISO 27001 deadline?'), 'en');
});

test('scoreAnswer: keywords with alternatives, citation section, notFound', () => {
  const q = { id: 'x', language: 'ar' as const, question: 'q', expectedKeywords: ['2%|2٪', 'كفاله|ضمان'], expectedSections: ['4. Bid Security / ضمان العطاء'] };
  const cit = [{ documentId: 'd1', title: 'Pack', section: '4. Bid Security / ضمان العطاء' }];
  assert.equal(scoreAnswer(q, { answer: 'نسبة الضمان ٢٪ من قيمة العطاء', language: 'ar', notFound: false, citations: cit }).pass, true);
  const wrongSec = scoreAnswer(q, { answer: 'ضمان 2%', language: 'ar', notFound: false, citations: [{ ...cit[0], section: 'Annex A' }] });
  assert.equal(wrongSec.pass, false); assert.equal(wrongSec.factMatch, true); assert.equal(wrongSec.citationMatch, false);
  const nf = { id: 'n', language: 'en' as const, question: 'q', expectNotFound: true };
  assert.equal(scoreAnswer(nf, { answer: 'Not in the documents', language: 'en', notFound: true, citations: [] }).pass, true);
  assert.equal(scoreAnswer(nf, { answer: '100 KWD', language: 'en', notFound: false, citations: cit }).pass, false);
});

test('parseDotEnv and markdownToDocText', () => {
  assert.deepEqual(parseDotEnv('# c\nA=1\nexport B="two words"\nC=x # tail\nbad line\nD=\n'), { A: '1', B: 'two words', C: 'x', D: '' });
  const d = markdownToDocText('m', '# Title\npre\n## S1\nhello\n## S2\n\nworld\n');
  assert.deepEqual(d, { documentId: 'm', title: 'Title', sections: [{ section: 'S1', text: 'hello' }, { section: 'S2', text: 'world' }] });
});
