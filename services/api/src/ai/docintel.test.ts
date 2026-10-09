// Unit tests of the document-intelligence validation layer (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currencyIn, normaliseDate, validateDocumentInsight } from './parse.js';
import { buildDocumentIntelligencePrompt } from './prompts.js';
import type { DocText, DocTypeDef } from './types.js';

const DOC: DocText = { documentId: 'd1', title: 'شهادة', sections: [
  { section: 'البيانات', text: 'رقم السجل: CR-100001\nتاريخ الانتهاء: ١٥/٠٣/٢٠٣١\nالاسم: شركة قمر للأنظمة' },
  { section: 'Guarantee', text: 'Amount: KWD 3,190.000 valid until 30 June 2027' },
] };
const CAT: DocTypeDef[] = [
  { code: 'COMMERCIAL_REGISTRATION', nameEn: 'Commercial registration', nameAr: 'السجل التجاري', fields: [
    { key: 'crNumber', labelEn: 'CR', labelAr: 'رقم', type: 'text', required: true },
    { key: 'expiryDate', labelEn: 'Expiry', labelAr: 'انتهاء', type: 'date', required: true }] },
  { code: 'BANK_GUARANTEE', nameEn: 'Bank guarantee', nameAr: 'كفالة', fields: [
    { key: 'amount', labelEn: 'Amount', labelAr: 'المبلغ', type: 'amount', required: true },
    { key: 'validUntil', labelEn: 'Valid until', labelAr: 'سارية حتى', type: 'date', required: true }] },
  { code: 'OTHER', nameEn: 'Other', nameAr: 'آخر', fields: [] },
];
const base = { language: 'mixed', summaryEn: 'A registration.', summaryAr: 'شهادة سجل.' };

test('normaliseDate: ISO, day-first, month names, Arabic-Indic digits; Hijri/garbage → null', () => {
  assert.equal(normaliseDate('2027-06-30'), '2027-06-30');
  assert.equal(normaliseDate('30/06/2027'), '2027-06-30');
  assert.equal(normaliseDate('30 June 2027'), '2027-06-30');
  assert.equal(normaliseDate('June 30, 2027'), '2027-06-30');
  assert.equal(normaliseDate('١٥/٠٣/٢٠٣١'), '2031-03-15');
  assert.equal(normaliseDate('15 مارس 2031'), '2031-03-15');
  assert.equal(normaliseDate('31/02/2027'), null, 'impossible date');
  assert.equal(normaliseDate('1448/05/12 هـ'), null, 'Hijri is never converted');
  assert.equal(normaliseDate('soon'), null);
});

test('currencyIn', () => {
  assert.equal(currencyIn('KWD 3,190.000'), 'KWD');
  assert.equal(currencyIn('٣١٩٠ د.ك'), 'KWD');
  assert.equal(currencyIn('دينار بحريني'), 'BHD');
  assert.equal(currencyIn('USD 10'), 'USD');
  assert.equal(currencyIn('3190'), null);
});

test('validateDocumentInsight: valid output normalised (ISO date, numeric amount + currency)', () => {
  const v = validateDocumentInsight({ ...base, docType: 'COMMERCIAL_REGISTRATION', fields: [
    { key: 'crNumber', value: 'CR-100001', citation: { section: 'البيانات', quote: 'رقم السجل: CR-100001' } },
    { key: 'expiryDate', value: '١٥/٠٣/٢٠٣١', citation: { section: 'البيانات', quote: 'تاريخ الانتهاء: ١٥/٠٣/٢٠٣١' } }] }, DOC, CAT);
  assert.deepEqual(v.problems, []);
  assert.equal(v.value!.fields.find((f) => f.key === 'expiryDate')!.value, '2031-03-15');
  const g = validateDocumentInsight({ ...base, docType: 'bank_guarantee', fields: [
    { key: 'amount', value: 'KWD 3,190.000', citation: { section: 'Guarantee', quote: 'Amount: KWD 3,190.000' } },
    { key: 'validUntil', value: '30 June 2027', citation: { section: 'guarantee', quote: 'valid until 30 June 2027' } }] }, DOC, CAT);
  assert.deepEqual(g.problems, []);
  assert.equal(g.value!.docType, 'BANK_GUARANTEE');
  assert.deepEqual(g.value!.fields[0].value, { amount: 3190, currency: 'KWD' });
});

test('validateDocumentInsight: rejects unknown type, undefined keys, invented values, quotes not in the text, OTHER with fields', () => {
  const p = (o: object) => validateDocumentInsight({ ...base, ...o }, DOC, CAT).problems.join(' | ');
  assert.match(p({ docType: 'PASSPORT', fields: [] }), /docType/);
  assert.match(p({ docType: 'COMMERCIAL_REGISTRATION', fields: [{ key: 'civilId', value: '1', citation: { section: 'البيانات', quote: 'CR-100001' } }] }), /not defined/);
  assert.match(p({ docType: 'COMMERCIAL_REGISTRATION', fields: [{ key: 'crNumber', value: 'CR-999', citation: { section: 'البيانات', quote: 'رقم السجل: CR-999' } }] }), /quote does not appear/);
  assert.match(p({ docType: 'COMMERCIAL_REGISTRATION', fields: [{ key: 'crNumber', value: 'CR-777', citation: { section: 'البيانات', quote: 'CR-100001' } }] }), /does not appear in the cited section/);
  assert.match(p({ docType: 'COMMERCIAL_REGISTRATION', fields: [{ key: 'crNumber', value: 'CR-100001', citation: { section: 'Annex Z', quote: 'CR-100001' } }] }), /not a section/);
  assert.match(p({ docType: 'BANK_GUARANTEE', fields: [{ key: 'amount', value: '9,999', citation: { section: 'Guarantee', quote: 'Amount: KWD 3,190.000' } }] }), /does not appear in the quoted text/);
  assert.match(p({ docType: 'OTHER', fields: [{ key: 'crNumber', value: 'CR-100001', citation: { section: 'البيانات', quote: 'CR-100001' } }] }), /OTHER has no fields/);
  assert.match(p({ docType: 'OTHER', fields: [], summaryEn: 'Expires in 2099.' }), /2099/);
  assert.match(p({ docType: 'OTHER', fields: [], summaryAr: 'English only' }), /Arabic/);
});

test('prompt: catalogue, upload context, markers, no personal-ID extraction', () => {
  const pr = buildDocumentIntelligencePrompt({ document: DOC, catalogue: CAT, context: { ownerType: 'VENDOR', uploaderRole: 'VENDOR', slotTitle: 'My CR' } }, 24000);
  assert.match(pr, /\[DOC d1 \| شهادة \| البيانات\]/);
  assert.match(pr, /- BANK_GUARANTEE — Bank guarantee — كفالة/);
  assert.match(pr, /amount \(amount with currency/);
  assert.match(pr, /Title \/ slot given by the uploader: My CR/);
  assert.match(pr, /Never extract personal identity numbers/);
});
