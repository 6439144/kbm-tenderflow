import { test, before, after } from 'node:test';
import assert from 'node:assert';
import * as http from 'http';
import app from './server.js';
import { createTestToken } from './middleware/auth.js';

let server: http.Server;
let baseUrl: string;

let officerToken: string;
let directorToken: string;
let vendorToken: string;
let chairToken: string;
let evaluatorToken: string;

before(async () => {
  process.env.NODE_ENV = 'test';
  server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as any;
  baseUrl = `http://127.0.0.1:${address.port}`;

  // Mint cryptographically verified tokens with jose (G1-b)
  officerToken = await createTestToken({
    sub: 'officer_1',
    username: 'procurement_officer',
    role: 'PROCUREMENT_OFFICER',
    tenantId: 'kea'
  });

  directorToken = await createTestToken({
    sub: 'director_1',
    username: 'procurement_director',
    role: 'DIRECTOR',
    tenantId: 'kea'
  });

  vendorToken = await createTestToken({
    sub: 'vnd_gulf_infra',
    username: 'gulf_vendor',
    role: 'VENDOR',
    tenantId: 'kea',
    vendorId: 'vnd_gulf_infra'
  });

  chairToken = await createTestToken({
    sub: 'chair_1',
    username: 'committee_chair',
    role: 'COMMITTEE_CHAIR',
    tenantId: 'kea'
  });

  evaluatorToken = await createTestToken({
    sub: 'evaluator_1',
    username: 'evaluator',
    role: 'EVALUATOR',
    tenantId: 'kea'
  });
});

after(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

async function request(path: string, options: {
  method?: string;
  headers?: Record<string, string>;
  token?: string;
  body?: any;
} = {}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Tenant-ID': 'kea',
    ...(options.headers || {})
  };
  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }

  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = (await res.json().catch(() => ({}))) as any;
  return { status: res.status, body: data as any };
}

test('TenderFlow 10-Step Acceptance Verification & Security Rules (v1.0 Hardened)', async (t) => {
  await t.test('Step 1: Tenant exists and can be queried (public endpoint)', async () => {
    const res = await request('/api/v1/tenants/kea');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.id, 'kea');
    assert.strictEqual(res.body.status, 'ACTIVE');
  });

  await t.test('G1-b: Anonymous caller rejected on protected routes (HTTP 401)', async () => {
    const res = await request('/api/v1/tenders', {
      method: 'POST',
      body: { titleEn: 'Unauthorized Tender' }
    });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.code, 'UNAUTHORIZED');
  });

  let vendorId = '';
  await t.test('Step 2: Vendor registration and verification', async () => {
    const regRes = await request('/api/v1/vendors/register', {
      method: 'POST',
      body: {
        legalNameEn: 'Gulf Infrastructure Consortium',
        legalNameAr: 'تحالف الخليج للبنية التحتية',
        crNumber: 'CR-984210',
        contactEmail: 'tenders@gulf-infra.example.com',
        contactPhone: '+965 2200 1100'
      }
    });
    assert.strictEqual(regRes.status, 201);
    vendorId = regRes.body.id;
    assert.strictEqual(regRes.body.status, 'PENDING_REVIEW');

    // Vendor trying to approve registration -> 403 Forbidden
    const forbiddenApprove = await request(`/api/v1/vendors/${vendorId}/approve`, {
      method: 'POST',
      token: vendorToken,
      body: { reason: 'Vendor self-approving' }
    });
    assert.strictEqual(forbiddenApprove.status, 403);

    // Procurement Officer approving -> 200 OK
    const appRes = await request(`/api/v1/vendors/${vendorId}/approve`, {
      method: 'POST',
      token: officerToken,
      body: { reason: 'Compliant commercial registration and tax certificate' }
    });
    assert.strictEqual(appRes.status, 200);
    assert.strictEqual(appRes.body.status, 'APPROVED');
  });

  let tenderId = '';
  await t.test('Step 3: Tender preparation in DRAFT', async () => {
    // Vendor drafting tender -> 403 Forbidden
    const vendorDraft = await request('/api/v1/tenders', {
      method: 'POST',
      token: vendorToken,
      body: { tenderNumber: 'KEA-VND-FAIL' }
    });
    assert.strictEqual(vendorDraft.status, 403);

    // Submission deadline set 2 seconds in future for testing opening gates
    const deadline = new Date(Date.now() + 2000).toISOString();

    const res = await request('/api/v1/tenders', {
      method: 'POST',
      token: officerToken,
      body: {
        tenderNumber: 'KEA-TND-2026-088',
        titleEn: 'Enterprise Data Center Modernization & Network',
        titleAr: 'تحديث مركز البيانات والمحفظة الشبكية',
        category: 'IT',
        estimatedBudget: 250000,
        submissionDeadline: deadline,
        documentIds: ['doc_dossier_001']
      }
    });
    assert.strictEqual(res.status, 201);
    tenderId = res.body.id;
    assert.strictEqual(res.body.status, 'DRAFT');
    assert.strictEqual(res.body.createdBy, 'officer_1');
  });

  await t.test('Step 4: AI Completeness check & Segregation of Duties (Creator != Approver)', async () => {
    // Advisory check by procurement officer
    const aiRes = await request('/api/v1/ai/advisory/tender-completeness-check', {
      method: 'POST',
      token: officerToken,
      body: { tenderId }
    });
    assert.strictEqual(aiRes.status, 200);
    assert.strictEqual(aiRes.body.recommendation, 'RECOMMENDED_FOR_APPROVAL');

    // Segregation of Duties: Creator (officer_1) CANNOT approve their own tender! (HTTP 403)
    const selfApprove = await request(`/api/v1/tenders/${tenderId}/approve-publish`, {
      method: 'POST',
      token: officerToken,
      body: { reason: 'Self approving' }
    });
    assert.strictEqual(selfApprove.status, 403);

    // Distinct Director (director_1) approves
    const appRes = await request(`/api/v1/tenders/${tenderId}/approve-publish`, {
      method: 'POST',
      token: directorToken,
      body: { reason: 'Director sign-off approving publication', aiAdvisoryRef: 'ai_chk_088' }
    });
    assert.strictEqual(appRes.status, 200);
    assert.strictEqual(appRes.body.status, 'APPROVED_FOR_PUBLICATION');
  });

  await t.test('Step 5: Tender publication to Vendor Portal', async () => {
    const pubRes = await request(`/api/v1/tenders/${tenderId}/publish`, {
      method: 'POST',
      token: officerToken
    });
    assert.strictEqual(pubRes.status, 200);
    assert.strictEqual(pubRes.body.status, 'PUBLISHED');
  });

  await t.test('Step 6: Clarifications & AI-drafted reply', async () => {
    const clarRes = await request(`/api/v1/tenders/${tenderId}/clarifications`, {
      method: 'POST',
      token: vendorToken,
      body: { question: 'Is redundant dual-power feed mandatory?' }
    });
    assert.strictEqual(clarRes.status, 201);
    const clarId = clarRes.body.id;

    // AI drafts reply
    const aiDraft = await request('/api/v1/ai/advisory/draft-clarification-reply', {
      method: 'POST',
      token: officerToken,
      body: { question: 'Is redundant dual-power feed mandatory?' }
    });
    assert.strictEqual(aiDraft.status, 200);
    assert.ok(aiDraft.body.draftAnswerEn.length > 0);

    // Officer responds
    const respRes = await request(`/api/v1/tenders/${tenderId}/clarifications/${clarId}/respond`, {
      method: 'POST',
      token: officerToken,
      body: { answer: aiDraft.body.draftAnswerEn }
    });
    assert.strictEqual(respRes.status, 200);
    assert.strictEqual(respRes.body.status, 'ANSWERED');
  });

  let bid1Id = '';
  await t.test('Step 7: Sealed Bid submission & RULE 1 ENFORCEMENT', async () => {
    const bidRes = await request(`/api/v1/tenders/${tenderId}/bids`, {
      method: 'POST',
      token: vendorToken,
      body: {
        vendorName: 'Gulf Infrastructure Consortium',
        technicalProposalDocId: 'doc_tech_gulf_001',
        financialProposalDocId: 'doc_fin_gulf_001',
        hashDigest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      }
    });
    assert.strictEqual(bidRes.status, 201);
    bid1Id = bidRes.body.id;
    assert.strictEqual(bidRes.body.status, 'SEALED');

    // === NON-NEGOTIABLE RULE 1 PROOF ===
    // 1. Reading bid payload prior to opening ceremony MUST FAIL with HTTP 403
    const forbiddenRes = await request(`/api/v1/tenders/${tenderId}/bids/${bid1Id}/content`, {
      token: chairToken
    });
    assert.strictEqual(forbiddenRes.status, 403);
    assert.strictEqual(forbiddenRes.body.code, 'BIDS_SEALED_UNTIL_OPENING_EVENT');

    // 2. Reading document via /documents/:id before opening ceremony MUST ALSO FAIL with HTTP 403
    const forbiddenDocRes = await request(`/api/v1/documents/doc_tech_gulf_001`, {
      token: chairToken
    });
    assert.strictEqual(forbiddenDocRes.status, 403);
    assert.strictEqual(forbiddenDocRes.body.code, 'BIDS_SEALED_UNTIL_OPENING_EVENT');
  });

  await t.test('Step 8: Bid Opening Ceremony unseals bids (Rule 1 & 2)', async () => {
    // Wait for the 2-second deadline to elapse
    await new Promise((resolve) => setTimeout(resolve, 2200));

    const openRes = await request(`/api/v1/tenders/${tenderId}/bids/opening-ceremony`, {
      method: 'POST',
      token: chairToken,
      body: {
        committeeChair: 'chair@kea.gov.kw',
        attendees: ['chair@kea.gov.kw', 'officer@kea.gov.kw', 'auditor@kea.gov.kw'],
        minutesNotes: 'Opening ceremony convened. All bids confirmed sealed and intact.'
      }
    });
    assert.strictEqual(openRes.status, 200);
    assert.strictEqual(openRes.body.openedBidsCount, 1);

    // NOW that ceremony is recorded, committee chair bid content retrieval succeeds
    const unsealedRes = await request(`/api/v1/tenders/${tenderId}/bids/${bid1Id}/content`, {
      token: chairToken
    });
    assert.strictEqual(unsealedRes.status, 200);
    assert.strictEqual(unsealedRes.body.technicalProposalDocId, 'doc_tech_gulf_001');
    assert.ok(unsealedRes.body.unsealedAt);
  });

  await t.test('Step 9: Technical & Financial Evaluation Scorecard', async () => {
    const scoreRes = await request(`/api/v1/tenders/${tenderId}/evaluations/scorecard`, {
      method: 'POST',
      token: evaluatorToken,
      body: {
        bidId: bid1Id,
        evaluatorId: 'evaluator_1',
        technicalScore: 92,
        financialScore: 96,
        comments: 'Outstanding architecture and pricing schedule.'
      }
    });
    assert.strictEqual(scoreRes.status, 201);
    assert.strictEqual(scoreRes.body.compositeScore, 93.2);
  });

  await t.test('Step 10: Award Decision & Immutable Audit Ledger Integrity (Rule 2)', async () => {
    const awardRes = await request(`/api/v1/tenders/${tenderId}/evaluations/award`, {
      method: 'POST',
      token: directorToken,
      body: {
        winningVendorId: vendorId,
        awardValue: 242000,
        justification: 'Highest composite score in technical and commercial evaluation.'
      }
    });
    assert.strictEqual(awardRes.status, 200);
    assert.strictEqual(awardRes.body.tender.status, 'AWARDED');
    assert.strictEqual(awardRes.body.tender.awardedVendorId, vendorId);

    // Verify tamper-evident HMAC chain on audit logs
    const auditRes = await request('/api/v1/audit-logs/verify-integrity', {
      token: directorToken
    });
    assert.strictEqual(auditRes.status, 200);
    assert.strictEqual(auditRes.body.chainIntegrityValid, true);
    assert.ok(auditRes.body.totalEventsVerified >= 8);
  });
});
