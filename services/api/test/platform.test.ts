import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, fileForm, login, makeTenant, makeUser, sleep, startApp, PASSWORD, type Running } from './helpers.js';

let run: Running;
after(async () => { if (run) await run.stop(); });

const CRIT = [
  { key: 'technical', nameEn: 'Technical', nameAr: 'فني', weight: 70 },
  { key: 'price', nameEn: 'Price', nameAr: 'السعر', weight: 30 },
];

test('cycle templates: N-level approvals, eligibility, paid documents, two envelopes, award chain, records lock, requests, notices', async () => {
  run = await startApp();
  await makeTenant(run, 'ent');
  for (const [u, r] of [['officer', 'PROCUREMENT_OFFICER'], ['director', 'DIRECTOR'], ['under', 'UNDERSECRETARY'], ['chair', 'COMMITTEE_CHAIR'],
    ['eval1', 'EVALUATOR'], ['admin', 'TENANT_ADMIN'], ['auditor', 'AUDITOR']] as const) await makeUser(run, 'ent', u, [r]);
  const [officer, director, under, chair, eval1, admin, auditor] = await Promise.all(
    ['officer', 'director', 'under', 'chair', 'eval1', 'admin', 'auditor'].map((u) => login(run, 'ent', u)));

  // --- templates: validation rejects a two-envelope template without a pass mark
  const bad = await api(run, 'POST', '/api/v1/templates/validate', { token: officer, json: { config: { envelopes: 'TWO' } } });
  assert.equal(bad.body.valid, false);
  const inst = await api(run, 'POST', '/api/v1/templates/install-starters', { token: admin });
  assert.equal(inst.status, 201, inst.text);
  assert.equal(inst.body.length, 3);
  const rfp = inst.body.find((t: any) => t.code === 'RFP_TWO_ENVELOPE');
  assert.equal(rfp.config.envelopes, 'TWO');
  // new version of a template is a DRAFT and does not affect running tenders
  const v2 = await api(run, 'POST', '/api/v1/templates', { token: admin, json: { code: 'RFP_TWO_ENVELOPE', nameEn: 'RFP v2', nameAr: 'طلب عروض 2', config: { ...rfp.config, evaluation: { technicalPassMark: 80, financialCriteria: ['price'] } } } });
  assert.equal(v2.status, 201, v2.text);
  assert.equal(v2.body.version, 2);
  assert.equal(v2.body.status, 'DRAFT');

  // --- activity codes, vendors and grades
  await api(run, 'POST', '/api/v1/activity-codes', { token: admin, json: { code: 'ENG-02', nameEn: 'Marine works', nameAr: 'أعمال بحرية' } });
  const reg = async (username: string, cr: string) => {
    const r = await api(run, 'POST', '/api/v1/public/vendors/register', { json: { tenantId: 'ent', legalNameEn: `${username} (fictitious)`, legalNameAr: `${username} (وهمية)`,
      crNumber: cr, email: `${username}@x.example`, phone: '1', categories: ['WORKS'], username, password: PASSWORD } });
    assert.equal(r.status, 201, r.text);
    await api(run, 'POST', `/api/v1/vendors/${r.body.vendor.id}/decision`, { token: officer, json: { decision: 'APPROVE', reason: 'ok' } });
    return r.body.vendor.id as string;
  };
  const vA = await reg('vena', 'CR-A'); const vB = await reg('venb', 'CR-B'); const vC = await reg('venc', 'CR-C');
  for (const [v, g] of [[vA, 1], [vB, 2], [vC, 3]] as const) {
    const c = await api(run, 'POST', `/api/v1/vendors/${v}/classifications`, { token: officer, json: { activityCode: 'ENG-02', grade: g } });
    assert.equal(c.status, 200, c.text);
  }
  const [va, vb, vc] = await Promise.all(['vena', 'venb', 'venc'].map((u) => login(run, 'ent', u)));

  // --- tender on the two-envelope template: needs a financial and a technical criterion
  const DEADLINE = 7000;
  const mk = await api(run, 'POST', '/api/v1/tenders', { token: officer, json: {
    templateId: rfp.id, titleEn: 'Jetty', titleAr: 'رصيف', category: 'WORKS', estimatedBudget: 1, currency: 'KWD',
    submissionDeadline: new Date(Date.now() + DEADLINE).toISOString(), criteria: CRIT, requiredDocuments: [], eligibility: { activityCodes: ['ENG-02'], minGrade: 2 } } });
  assert.equal(mk.status, 201, mk.text);
  const tid = mk.body.id;
  assert.equal(mk.body.template.code, 'RFP_TWO_ENVELOPE');
  await api(run, 'POST', `/api/v1/tenders/${tid}/documents`, { token: officer, form: fileForm({ file: { name: 'pack.md', content: '# 1. Scope\nJetty.\n\n# 2. Terms\nTwo envelopes.' } }) });

  // --- approval chain: director (level 1) → undersecretary (level 2); wrong order and double approval refused
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${tid}/approve`, { token: under, json: {} })).status, 403, 'level 1 is the director');
  const l1 = await api(run, 'POST', `/api/v1/tenders/${tid}/approve`, { token: director, json: { reason: 'L1' } });
  assert.equal(l1.body.status, 'PENDING_APPROVAL', l1.text);
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${tid}/approve`, { token: director, json: {} })).status, 403, 'same person cannot approve two levels');
  const l2 = await api(run, 'POST', `/api/v1/tenders/${tid}/approve`, { token: under, json: { reason: 'L2' } });
  assert.equal(l2.body.status, 'APPROVED', l2.text);
  const pubd = await api(run, 'POST', `/api/v1/tenders/${tid}/publish`, { token: officer });
  assert.equal(pubd.body.status, 'PUBLISHED', pubd.text);
  const det = await api(run, 'GET', `/api/v1/tenders/${tid}`, { token: officer });
  assert.deepEqual(det.body.approvalChain.map((x: any) => x.decision), ['APPROVED', 'APPROVED']);
  assert.ok(det.body.publications.some((p: any) => p.channel === 'PORTAL' && p.status === 'PUBLISHED'));

  // --- notices: gazette draft → approve (not by author) → record (stored as NOTICE document)
  const n1 = await api(run, 'POST', `/api/v1/tenders/${tid}/notices`, { token: officer, json: { channel: 'KUWAIT_ALYOUM', noticeEn: 'Notice EN', noticeAr: 'إعلان' } });
  assert.equal(n1.status, 201, n1.text);
  assert.equal((await api(run, 'POST', `/api/v1/publications/${n1.body.id}/approve`, { token: director })).body.status, 'APPROVED');
  const rec = await api(run, 'POST', `/api/v1/publications/${n1.body.id}/record`, { token: officer, json: { reference: 'KA-1234', publishedOn: '2026-10-10' } });
  assert.equal(rec.body.status, 'PUBLISHED', rec.text);
  assert.ok(rec.body.documentId);

  // --- vendors: notified by rule; vc (Third grade) is not eligible; vb must buy documents first
  const nA = await api(run, 'GET', '/api/v1/notifications', { token: va });
  assert.ok(nA.body.some((n: any) => n.kind === 'TENDER_PUBLISHED'));
  const nC = await api(run, 'GET', '/api/v1/notifications', { token: vc });
  assert.equal(nC.body.length, 0, 'ineligible vendor not alerted');
  const bid = (tok: string, who: string) => api(run, 'POST', `/api/v1/tenders/${tid}/bids`, { token: tok, form: fileForm({
    technical: { name: 'tech.md', content: `technical of ${who}` }, financial: { name: 'fin.md', content: `PRICE-SECRET-${who}` } }) });
  const elC = await api(run, 'GET', `/api/v1/tenders/${tid}/eligibility`, { token: vc });
  assert.equal(elC.body.eligible, false);
  assert.equal((await bid(vc, 'C')).body.code, 'NOT_ELIGIBLE');
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${tid}/purchase`, { token: vc, json: {} })).status, 403);
  assert.equal((await bid(vb, 'B')).status, 402, 'purchase required');
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${tid}/purchase`, { token: vb, json: { gateway: 'KNET' } })).body.code, 'KNET_NOT_CONFIGURED');
  for (const tok of [va, vb]) {
    const p = await api(run, 'POST', `/api/v1/tenders/${tid}/purchase`, { token: tok, json: { gateway: 'TEST' } });
    assert.equal(p.status, 201, p.text);
    assert.equal(p.body.gateway, 'TEST');
  }
  assert.equal((await bid(va, 'A')).status, 201);
  assert.equal((await bid(vb, 'B')).status, 201);

  // --- two envelopes: technical opening; financial stays sealed; only technical criteria can be scored
  await sleep(Math.max(0, new Date(mk.body.submissionDeadline).getTime() - Date.now() + 300));
  const op = await api(run, 'POST', `/api/v1/tenders/${tid}/open`, { token: chair, json: { attendees: ['Chair'] } });
  assert.equal(op.status, 200, op.text);
  const bl = await api(run, 'GET', `/api/v1/tenders/${tid}/bids`, { token: chair });
  assert.ok(bl.body.every((b: any) => b.financialSealed && b.documents.every((d: any) => d.type !== 'BID_FINANCIAL')));
  const bidA = bl.body.find((b: any) => b.vendorId === vA); const bidB = bl.body.find((b: any) => b.vendorId === vB);
  assert.equal((await api(run, 'POST', `/api/v1/bids/${bidA.id}/evaluation`, { token: eval1, json: { scores: [{ criterion: 'technical', score: 90 }, { criterion: 'price', score: 80 }] } })).body.code, 'FINANCIAL_SEALED');
  assert.equal((await api(run, 'POST', `/api/v1/bids/${bidA.id}/evaluation`, { token: eval1, json: { scores: [{ criterion: 'technical', score: 90 }] } })).status, 200);
  assert.equal((await api(run, 'POST', `/api/v1/bids/${bidB.id}/evaluation`, { token: eval1, json: { scores: [{ criterion: 'technical', score: 50 }] } })).status, 200);
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${tid}/award/recommend`, { token: chair, json: { bidId: bidA.id, justification: 'x' } })).body.code, 'FINANCIAL_SEALED');
  const fo = await api(run, 'POST', `/api/v1/tenders/${tid}/open-financial`, { token: chair, json: {} });
  assert.equal(fo.status, 200, fo.text);
  assert.deepEqual(Object.fromEntries(fo.body.results.map((r: any) => [r.bidId, r.result])), { [bidA.id]: 'PASSED', [bidB.id]: 'FAILED' });
  const bl2 = await api(run, 'GET', `/api/v1/tenders/${tid}/bids`, { token: chair });
  assert.ok(bl2.body.find((b: any) => b.id === bidA.id).documents.some((d: any) => d.type === 'BID_FINANCIAL'));
  const finB = (await api(run, 'GET', `/api/v1/tenders/${tid}/bids`, { token: chair })).body.find((b: any) => b.id === bidB.id);
  assert.ok(finB.financialSealed, 'failed bid keeps its financial envelope sealed');
  assert.equal((await api(run, 'POST', `/api/v1/bids/${bidB.id}/evaluation`, { token: eval1, json: { scores: [{ criterion: 'technical', score: 50 }, { criterion: 'price', score: 99 }] } })).body.code, 'TECHNICAL_FAILED');
  assert.equal((await api(run, 'POST', `/api/v1/bids/${bidA.id}/evaluation`, { token: eval1, json: { scores: [{ criterion: 'technical', score: 90 }, { criterion: 'price', score: 80 }] } })).status, 200);

  // --- award chain (director → undersecretary), then records lock
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${tid}/award/recommend`, { token: chair, json: { bidId: bidA.id, justification: 'Best value' } })).status, 200);
  const a1 = await api(run, 'POST', `/api/v1/tenders/${tid}/award/approve`, { token: director, json: {} });
  assert.equal(a1.body.final, false, a1.text);
  const a2 = await api(run, 'POST', `/api/v1/tenders/${tid}/award/approve`, { token: under, json: {} });
  assert.equal(a2.body.final, true, a2.text);
  assert.ok(a2.body.records.documents > 0);
  const fin = await api(run, 'GET', `/api/v1/tenders/${tid}`, { token: director });
  assert.equal(fin.body.status, 'AWARDED');
  assert.ok(fin.body.recordsLockedAt);
  assert.ok(fin.body.documents.every((d: any) => d.isRecord));

  // --- request intake: letter mandatory; chain from the default template (PUBLIC_TENDER: director); convert → tender
  assert.equal((await api(run, 'POST', '/api/v1/requests', { token: officer, form: fileForm({ department: 'Ops', subject: 'Meters', source: 'LETTER' }) })).status, 400);
  const rq = await api(run, 'POST', '/api/v1/requests', { token: officer, form: fileForm({ department: 'Ops', subject: 'Meters', source: 'LETTER',
    letter: { name: 'letter.md', content: '# Letter\nPlease procure meters.' } }) });
  assert.equal(rq.status, 201, rq.text);
  assert.equal((await api(run, 'POST', `/api/v1/requests/${rq.body.id}/decision`, { token: director, json: { decision: 'APPROVE' } })).body.status, 'APPROVED');
  const conv = await api(run, 'POST', `/api/v1/requests/${rq.body.id}/convert`, { token: officer, json: {
    submissionDeadline: new Date(Date.now() + 86400000).toISOString(), category: 'WORKS', criteria: CRIT } });
  assert.equal(conv.status, 201, conv.text);
  assert.equal(conv.body.requestId, rq.body.id);
  assert.equal(conv.body.template.code, 'PUBLIC_TENDER', 'default template applied');

  // --- audit chain still valid
  assert.equal((await api(run, 'GET', '/api/v1/audit/verify', { token: auditor })).body.valid, true);
});
