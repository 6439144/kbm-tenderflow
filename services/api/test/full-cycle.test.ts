import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { api, fileForm, login, makeTenant, makeUser, sleep, startApp, tenderBody, walk, PASSWORD, type Running } from './helpers.js';

const TECH_MARKER = 'TECHNICAL-PLAINTEXT-MARKER-7f3a9 our proposed architecture';
const FIN_MARKER = 'FINANCIAL-PLAINTEXT-MARKER-91bc total price 123,456 KWD';

let run: Running;
after(async () => { if (run) await run.stop(); });

test('full tender cycle, sealed-bid protections, audit chain, restart persistence', async () => {
  run = await startApp();
  await makeTenant(run, 'kea');
  await makeUser(run, 'kea', 'officer', ['PROCUREMENT_OFFICER']);
  await makeUser(run, 'kea', 'director', ['DIRECTOR']);
  await makeUser(run, 'kea', 'chair', ['COMMITTEE_CHAIR']);
  await makeUser(run, 'kea', 'evaluator', ['EVALUATOR']);
  await makeUser(run, 'kea', 'auditor', ['AUDITOR']);

  // 1. Vendor registration (public) + vendor documents
  const reg = async (username: string, cr: string) => {
    const r = await api(run, 'POST', '/api/v1/public/vendors/register', { json: {
      tenantId: 'kea', legalNameEn: `${username} Co (fictitious)`, legalNameAr: `شركة ${username} (وهمية)`, crNumber: cr,
      email: `${username}@vendors.example`, phone: '+965 0000', categories: ['IT'], username, password: PASSWORD } });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.vendor.status, 'PENDING_REVIEW');
    return r.body.vendor.id as string;
  };
  const v1Id = await reg('vendor1', 'CR-1');
  const v2Id = await reg('vendor2', 'CR-2');
  const officer = await login(run, 'kea', 'officer');
  const director = await login(run, 'kea', 'director');
  const chair = await login(run, 'kea', 'chair');
  const evaluator = await login(run, 'kea', 'evaluator');
  const auditor = await login(run, 'kea', 'auditor');
  const vendor1 = await login(run, 'kea', 'vendor1');
  const vendor2 = await login(run, 'kea', 'vendor2');

  const vdoc = await api(run, 'POST', '/api/v1/vendors/me/documents', { token: vendor1, form: fileForm({ title: 'CR certificate', file: { name: 'cr.txt', content: 'Commercial registration CR-1' } }) });
  assert.equal(vdoc.status, 201, vdoc.text);
  // Unapproved vendor sees no tenders
  // 2. Officer approves both vendors
  for (const id of [v1Id, v2Id]) {
    const d = await api(run, 'POST', `/api/v1/vendors/${id}/decision`, { token: officer, json: { decision: 'APPROVE', reason: 'ok' } });
    assert.equal(d.status, 200, d.text);
    assert.equal(d.body.status, 'APPROVED');
  }

  // 3. Officer creates tender with short deadline and uploads the pack
  const DEADLINE_MS = 6000;
  const created = await api(run, 'POST', '/api/v1/tenders', { token: officer, json: tenderBody(DEADLINE_MS, { tenderNumber: 'KEA-T-1' }) });
  assert.equal(created.status, 201, created.text);
  const tid = created.body.id as string;
  const deadline = new Date(created.body.submissionDeadline).getTime();
  assert.equal(created.body.status, 'DRAFT');
  const pack = await api(run, 'POST', `/api/v1/tenders/${tid}/documents`, { token: officer, form: fileForm({ title: 'RFP pack',
    file: { name: 'pack.md', content: '# 1. Scope\nService desk.\n\n# 2. Required documents\nCR, bid bond.\n' } }) });
  assert.equal(pack.status, 201, pack.text);
  // Vendors cannot see a DRAFT tender
  assert.equal((await api(run, 'GET', `/api/v1/tenders/${tid}`, { token: vendor1 })).status, 404);

  // 5. Director (different user) approves; officer publishes
  const appr = await api(run, 'POST', `/api/v1/tenders/${tid}/approve`, { token: director, json: { reason: 'fine' } });
  assert.equal(appr.status, 200, appr.text);
  assert.equal(appr.body.status, 'APPROVED');
  const pubR = await api(run, 'POST', `/api/v1/tenders/${tid}/publish`, { token: officer });
  assert.equal(pubR.status, 200, pubR.text);
  assert.equal(pubR.body.status, 'PUBLISHED');

  // Vendor can now see it and download the pack
  const vt = await api(run, 'GET', `/api/v1/tenders/${tid}`, { token: vendor1 });
  assert.equal(vt.status, 200, vt.text);
  assert.equal(vt.body.documents.length, 1);
  const packDl = await api(run, 'GET', `/api/v1/documents/${vt.body.documents[0].id}`, { token: vendor1 });
  assert.equal(packDl.status, 200);
  assert.match(packDl.text, /Service desk/);

  // 7. Clarification asked and answered
  const q = await api(run, 'POST', `/api/v1/tenders/${tid}/clarifications`, { token: vendor1, json: { question: 'Is a bid bond required?' } });
  assert.equal(q.status, 201, q.text);
  const ans = await api(run, 'POST', `/api/v1/clarifications/${q.body.id}/answer`, { token: officer, json: { answer: 'Yes, see section 2.' } });
  assert.equal(ans.status, 200, ans.text);
  assert.equal(ans.body.status, 'ANSWERED');
  const v2view = await api(run, 'GET', `/api/v1/tenders/${tid}`, { token: vendor2 });
  assert.equal(v2view.body.clarifications.length, 1, 'answered clarification visible to all vendors');
  assert.equal(v2view.body.clarifications[0].vendorId, null, 'asking vendor identity hidden from competitors');

  // 8. Sealed bids
  const bidForm = (tech: string, fin: string) => fileForm({
    technical: { name: 'technical.txt', content: tech }, financial: { name: 'financial.txt', content: fin } });
  const bid1 = await api(run, 'POST', `/api/v1/tenders/${tid}/bids`, { token: vendor1, form: bidForm(TECH_MARKER, FIN_MARKER) });
  assert.equal(bid1.status, 201, bid1.text);
  assert.match(bid1.body.receiptSha256, /^[0-9a-f]{64}$/);
  assert.equal(bid1.body.files.length, 2);
  const bid2 = await api(run, 'POST', `/api/v1/tenders/${tid}/bids`, { token: vendor2, form: bidForm('vendor2 technical v1', 'vendor2 price 99') });
  assert.equal(bid2.status, 201, bid2.text);
  // Resubmission before deadline replaces the bid (same bid id, new receipt)
  const bid2b = await api(run, 'POST', `/api/v1/tenders/${tid}/bids`, { token: vendor2, form: bidForm('vendor2 technical v2', 'vendor2 price 98') });
  assert.equal(bid2b.status, 201, bid2b.text);
  assert.equal(bid2b.body.bidId, bid2.body.bidId);
  assert.notEqual(bid2b.body.receiptSha256, bid2.body.receiptSha256);

  // Owner can read their own files back (decrypted)
  const ownList = await api(run, 'GET', `/api/v1/tenders/${tid}/bids`, { token: vendor1 });
  assert.equal(ownList.status, 200);
  assert.equal(ownList.body.length, 1);
  const techDoc = ownList.body[0].files.find((f: any) => f.type === 'BID_TECHNICAL');
  const ownDl = await api(run, 'GET', `/api/v1/bids/${bid1.body.bidId}/documents/${techDoc.documentId}`, { token: vendor1 });
  assert.equal(ownDl.status, 200);
  assert.equal(ownDl.text, TECH_MARKER);

  // Competitor cannot read it: bids route 404, generic documents route 404
  assert.equal((await api(run, 'GET', `/api/v1/bids/${bid1.body.bidId}/documents/${techDoc.documentId}`, { token: vendor2 })).status, 404);
  assert.equal((await api(run, 'GET', `/api/v1/documents/${techDoc.documentId}`, { token: vendor2 })).status, 404);
  const v2list = await api(run, 'GET', `/api/v1/tenders/${tid}/bids`, { token: vendor2 });
  assert.equal(v2list.body.length, 1);
  assert.equal(v2list.body[0].bidId, bid2.body.bidId, 'vendor sees only own bid');

  // Officer/chair cannot read before opening
  for (const tok of [officer, chair]) {
    const r = await api(run, 'GET', `/api/v1/bids/${bid1.body.bidId}/documents/${techDoc.documentId}`, { token: tok });
    assert.equal(r.status, 403, r.text);
    assert.equal((await api(run, 'GET', `/api/v1/documents/${techDoc.documentId}`, { token: tok })).status, 404);
  }
  const staffList = await api(run, 'GET', `/api/v1/tenders/${tid}/bids`, { token: chair });
  assert.equal(staffList.body.length, 2);
  assert.ok(staffList.body.every((b: any) => b.documents === undefined), 'no file access listed before opening');

  // Opening before the deadline → 409
  const early = await api(run, 'POST', `/api/v1/tenders/${tid}/open`, { token: chair, json: { attendees: ['Chair'] } });
  assert.equal(early.status, 409, early.text);

  // Encryption proof: stored bid bytes are not the plaintext
  const contentFiles = walk(path.join(run.dataDir, 'content'));
  const encFiles = contentFiles.filter((f) => f.endsWith('.enc'));
  // vendor1: 2 files; vendor2: 2 original + 2 replacement (originals are crypto-shredded: their key was replaced)
  assert.equal(encFiles.length, 6);
  for (const f of encFiles) {
    const bytes = fs.readFileSync(f);
    assert.ok(!bytes.includes(Buffer.from('PLAINTEXT-MARKER')), `ciphertext leaked plaintext in ${f}`);
    assert.ok(!bytes.includes(Buffer.from('vendor2')), `ciphertext leaked plaintext in ${f}`);
  }
  assert.ok(!contentFiles.some((f) => fs.readFileSync(f).includes(Buffer.from('PLAINTEXT-MARKER'))), 'no plaintext bid anywhere in the content store');

  // 9. Wait for the deadline; bids after the deadline are rejected; tender closes automatically
  await sleep(Math.max(0, deadline - Date.now()) + 300);
  const late = await api(run, 'POST', `/api/v1/tenders/${tid}/bids`, { token: vendor1, form: bidForm('late', 'late') });
  assert.equal(late.status, 409, late.text);
  const closedT = await api(run, 'GET', `/api/v1/tenders/${tid}`, { token: officer });
  assert.equal(closedT.body.status, 'CLOSED');

  // 10. Only the chair opens
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${tid}/open`, { token: officer, json: { attendees: ['x'] } })).status, 403);
  const opened = await api(run, 'POST', `/api/v1/tenders/${tid}/open`, { token: chair, json: { attendees: ['Chair (test)', 'Member A (test)'], notes: 'All envelopes intact' } });
  assert.equal(opened.status, 200, opened.text);
  assert.ok(opened.body.recordDocumentId);
  assert.ok(opened.body.bids.every((b: any) => b.integrity === 'VERIFIED'));
  const record = await api(run, 'GET', `/api/v1/documents/${opened.body.recordDocumentId}`, { token: officer });
  assert.equal(record.status, 200);
  assert.match(record.text, /محضر فتح المظاريف/);
  assert.match(record.text, /Bid Opening Record/);
  assert.ok(record.text.includes(bid1.body.receiptSha256));
  assert.equal((await api(run, 'GET', `/api/v1/documents/${opened.body.recordDocumentId}`, { token: vendor1 })).status, 404);

  // After opening: chair/evaluator can read, officer still cannot, generic route never serves BID_*
  const chairDl = await api(run, 'GET', `/api/v1/bids/${bid1.body.bidId}/documents/${techDoc.documentId}`, { token: chair });
  assert.equal(chairDl.status, 200);
  assert.equal(chairDl.text, TECH_MARKER);
  assert.equal((await api(run, 'GET', `/api/v1/bids/${bid1.body.bidId}/documents/${techDoc.documentId}`, { token: officer })).status, 403);
  assert.equal((await api(run, 'GET', `/api/v1/documents/${techDoc.documentId}`, { token: chair })).status, 404);

  // 12. Evaluation
  for (const [bidId, tech, price] of [[bid1.body.bidId, 90, 70], [bid2.body.bidId, 60, 95]] as const) {
    const ev = await api(run, 'POST', `/api/v1/bids/${bidId}/evaluation`, { token: evaluator, json: { scores: [
      { criterion: 'technical', score: tech, comment: 'ok' }, { criterion: 'price', score: price, comment: 'ok' }] } });
    assert.equal(ev.status, 200, ev.text);
    assert.equal(ev.body.weightedTotal, Math.round((tech * 60 + price * 40) / 100 * 100) / 100);
  }
  const evals = await api(run, 'GET', `/api/v1/tenders/${tid}/evaluations`, { token: chair });
  assert.equal(evals.body.length, 2);

  // 13. Award: chair recommends, director approves (≠ chair)
  const rec = await api(run, 'POST', `/api/v1/tenders/${tid}/award/recommend`, { token: chair, json: { bidId: bid1.body.bidId, justification: 'Highest weighted score' } });
  assert.equal(rec.status, 200, rec.text);
  const awd = await api(run, 'POST', `/api/v1/tenders/${tid}/award/approve`, { token: director, json: { reason: 'Approved per committee' } });
  assert.equal(awd.status, 200, awd.text);
  assert.equal(awd.body.award.status, 'APPROVED');
  const report = await api(run, 'GET', `/api/v1/documents/${awd.body.reportDocumentId}`, { token: director });
  assert.equal(report.status, 200);
  assert.match(report.text, /تقرير لجنة التقييم والترسية/);
  assert.match(report.text, /Tender awarded to/);
  const final = await api(run, 'GET', `/api/v1/tenders/${tid}`, { token: officer });
  assert.equal(final.body.status, 'AWARDED');

  // 14. Audit chain valid and covers the cycle
  const ver = await api(run, 'GET', '/api/v1/audit/verify', { token: auditor });
  assert.equal(ver.status, 200);
  assert.equal(ver.body.valid, true, JSON.stringify(ver.body));
  const events = await api(run, 'GET', `/api/v1/audit?resourceId=${tid}&limit=1000`, { token: auditor });
  const actions = new Set(events.body.map((e: any) => e.action));
  for (const a of ['TENDER_CREATED', 'TENDER_APPROVED', 'TENDER_PUBLISHED', 'TENDER_CLOSED', 'TENDER_OPENED', 'AWARD_RECOMMENDED', 'AWARD_APPROVED'])
    assert.ok(actions.has(a), `audit has ${a}`);
  assert.equal(events.body.find((e: any) => e.action === 'TENDER_CLOSED').actorId, 'SYSTEM');

  // Restart with the same DATA_DIR → data (and signing key) persist
  const dataDir = run.dataDir;
  await run.stop();
  run = await startApp(dataDir);
  const again = await api(run, 'GET', `/api/v1/tenders/${tid}`, { token: officer });
  assert.equal(again.status, 200, 'token issued before restart still valid (key persisted)');
  assert.equal(again.body.status, 'AWARDED');
  const ver2 = await api(run, 'GET', '/api/v1/audit/verify', { token: await login(run, 'kea', 'auditor') });
  assert.equal(ver2.body.valid, true);
  assert.equal(ver2.body.count, ver.body.count + 1, 'only the new login event was added');
  const dl2 = await api(run, 'GET', `/api/v1/bids/${bid1.body.bidId}/documents/${techDoc.documentId}`, { token: chair });
  assert.equal(dl2.text, TECH_MARKER, 'bid still decrypts after restart');
});
