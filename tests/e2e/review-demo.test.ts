import { test } from 'node:test';
import assert from 'node:assert';
import app from '../../services/api/dist/server.js';
import * as http from 'http';

test('E2E Review Demo Script (docs/review-demo.md Automated Runner)', async (t) => {
  let server: http.Server;
  let baseUrl: string;

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  baseUrl = `http://127.0.0.1:${port}`;

  async function callApi(path: string, options: any = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': 'kea',
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = (await res.json().catch(() => ({}))) as any;
    return { status: res.status, body: data };
  }

  console.log('>>> Commencing Automated Execution of docs/review-demo.md 10-Step Demo...');

  // Step 1: Provisioning
  const s1 = await callApi('/api/v1/tenants/kea');
  assert.strictEqual(s1.status, 200);

  // Step 2: Vendor registration & approval
  const s2Reg = await callApi('/api/v1/vendors/register', {
    method: 'POST',
    body: {
      legalNameEn: 'Gulf Infrastructure Consortium',
      legalNameAr: 'تحالف الخليج للبنية التحتية',
      crNumber: 'CR-984210',
      contactEmail: 'tenders@gulf-infra.example.com'
    }
  });
  const vendorId = s2Reg.body.id;
  const s2App = await callApi(`/api/v1/vendors/${vendorId}/approve`, {
    method: 'POST',
    body: { reason: 'Compliant registration' }
  });
  assert.strictEqual(s2App.status, 200);

  // Step 3: Tender preparation
  const s3 = await callApi('/api/v1/tenders', {
    method: 'POST',
    body: {
      tenderNumber: 'KEA-TND-2026-088',
      titleEn: 'Enterprise Data Center Modernization & Network',
      titleAr: 'تحديث مركز البيانات والمحفظة الشبكية',
      category: 'IT',
      estimatedBudget: 250000,
      submissionDeadline: '2026-10-14T12:00:00Z',
      documentIds: ['doc_dossier_001']
    }
  });
  const tenderId = s3.body.id;

  // Step 4: AI Review & Director Approval
  const s4AI = await callApi('/api/v1/ai/advisory/tender-completeness-check', {
    method: 'POST',
    body: { tenderId }
  });
  assert.strictEqual(s4AI.body.recommendation, 'RECOMMENDED_FOR_APPROVAL');
  const s4App = await callApi(`/api/v1/tenders/${tenderId}/approve-publish`, {
    method: 'POST',
    body: { reason: 'Authorized by Director', aiAdvisoryRef: 'ai_088' }
  });
  assert.strictEqual(s4App.status, 200);

  // Step 5: Publication
  const s5 = await callApi(`/api/v1/tenders/${tenderId}/publish`, { method: 'POST' });
  assert.strictEqual(s5.body.status, 'PUBLISHED');

  // Step 6: Clarifications & Addendum
  const s6Q = await callApi(`/api/v1/tenders/${tenderId}/clarifications`, {
    method: 'POST',
    body: { question: 'Is dual-feed power mandatory?' }
  });
  const s6Ans = await callApi(`/api/v1/tenders/${tenderId}/clarifications/${s6Q.body.id}/respond`, {
    method: 'POST',
    body: { answer: 'Confirmed, redundant A+B feeds are mandatory.' }
  });
  assert.strictEqual(s6Ans.status, 200);

  // Step 7: Sealed Bid Submission & Cryptographic Proof
  const s7Bid = await callApi(`/api/v1/tenders/${tenderId}/bids`, {
    method: 'POST',
    body: {
      vendorId,
      vendorName: 'Gulf Infrastructure Consortium',
      technicalProposalDocId: 'doc_tech_001',
      financialProposalDocId: 'doc_fin_001',
      hashDigest: 'sha256_mock_digest_001'
    }
  });
  const bidId = s7Bid.body.id;

  // Proof Rule 1
  const s7Check = await callApi(`/api/v1/tenders/${tenderId}/bids/${bidId}/content`);
  assert.strictEqual(s7Check.status, 403);

  // Step 8: Opening Ceremony
  const s8 = await callApi(`/api/v1/tenders/${tenderId}/bids/opening-ceremony`, {
    method: 'POST',
    body: {
      committeeChair: 'chair@kea.gov.kw',
      attendees: ['chair@kea.gov.kw', 'officer@kea.gov.kw']
    }
  });
  assert.strictEqual(s8.status, 200);

  // Unsealed content accessible now
  const s8Unseal = await callApi(`/api/v1/tenders/${tenderId}/bids/${bidId}/content`);
  assert.strictEqual(s8Unseal.status, 200);

  // Step 9: Evaluation
  const s9 = await callApi(`/api/v1/tenders/${tenderId}/evaluations/scorecard`, {
    method: 'POST',
    body: {
      bidId,
      evaluatorId: 'eval_chair',
      technicalScore: 94,
      financialScore: 95,
      comments: 'Recommended for award'
    }
  });
  assert.strictEqual(s9.status, 201);

  // Step 10: Award & Audit Log
  const s10 = await callApi(`/api/v1/tenders/${tenderId}/evaluations/award`, {
    method: 'POST',
    body: {
      winningVendorId: vendorId,
      awardValue: 245000,
      justification: 'Best value compliant proposal'
    }
  });
  assert.strictEqual(s10.body.tender.status, 'AWARDED');

  const s10Audit = await callApi('/api/v1/audit-logs/verify-integrity');
  assert.strictEqual(s10Audit.body.chainIntegrityValid, true);

  console.log('>>> docs/review-demo.md 10-Step Demo PASSED in its entirety!');

  server.close();
});
