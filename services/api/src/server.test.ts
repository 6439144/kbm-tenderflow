import { test, before, after } from 'node:test';
import assert from 'node:assert';
import * as http from 'http';
import app from './server.js';

let server: http.Server;
let baseUrl: string;

before(async () => {
  process.env.NODE_ENV = 'test';
  server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as any;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

async function request(path: string, options: {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
} = {}) {
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
  return { status: res.status, body: data as any };
}

test('TenderFlow 10-Step Acceptance Verification & Security Rules', async (t) => {
  await t.test('Step 1: Tenant exists and can be provisioned', async () => {
    const res = await request('/api/v1/tenants/kea');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.id, 'kea');
    assert.strictEqual(res.body.status, 'ACTIVE');
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

    const appRes = await request(`/api/v1/vendors/${vendorId}/approve`, {
      method: 'POST',
      body: { reason: 'Compliant commercial registration and tax certificate' }
    });
    assert.strictEqual(appRes.status, 200);
    assert.strictEqual(appRes.body.status, 'APPROVED');
  });

  let tenderId = '';
  await t.test('Step 3: Tender preparation in DRAFT', async () => {
    const res = await request('/api/v1/tenders', {
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
    assert.strictEqual(res.status, 201);
    tenderId = res.body.id;
    assert.strictEqual(res.body.status, 'DRAFT');
  });

  await t.test('Step 4: AI Completeness check & Director approval (Rule 7)', async () => {
    // Advisory check
    const aiRes = await request('/api/v1/ai/advisory/tender-completeness-check', {
      method: 'POST',
      body: { tenderId }
    });
    assert.strictEqual(aiRes.status, 200);
    assert.strictEqual(aiRes.body.recommendation, 'RECOMMENDED_FOR_APPROVAL');

    // Rule 7: AI cannot publish; requires human Director sign-off
    const appRes = await request(`/api/v1/tenders/${tenderId}/approve-publish`, {
      method: 'POST',
      body: { reason: 'Director sign-off approving publication', aiAdvisoryRef: 'ai_chk_088' }
    });
    assert.strictEqual(appRes.status, 200);
    assert.strictEqual(appRes.body.status, 'APPROVED_FOR_PUBLICATION');
  });

  await t.test('Step 5: Tender publication to Vendor Portal', async () => {
    const pubRes = await request(`/api/v1/tenders/${tenderId}/publish`, { method: 'POST' });
    assert.strictEqual(pubRes.status, 200);
    assert.strictEqual(pubRes.body.status, 'PUBLISHED');
  });

  await t.test('Step 6: Clarifications & AI-drafted reply', async () => {
    const clarRes = await request(`/api/v1/tenders/${tenderId}/clarifications`, {
      method: 'POST',
      body: { question: 'Is redundant dual-power feed mandatory?' }
    });
    assert.strictEqual(clarRes.status, 201);
    const clarId = clarRes.body.id;

    // AI drafts reply
    const aiDraft = await request('/api/v1/ai/advisory/draft-clarification-reply', {
      method: 'POST',
      body: { question: 'Is redundant dual-power feed mandatory?' }
    });
    assert.strictEqual(aiDraft.status, 200);
    assert.ok(aiDraft.body.draftAnswerEn.length > 0);

    // Human officer approves & responds
    const respRes = await request(`/api/v1/tenders/${tenderId}/clarifications/${clarId}/respond`, {
      method: 'POST',
      body: { answer: aiDraft.body.draftAnswerEn }
    });
    assert.strictEqual(respRes.status, 200);
    assert.strictEqual(respRes.body.status, 'ANSWERED');
  });

  let bid1Id = '';
  await t.test('Step 7: Sealed Bid submission & RULE 1 ENFORCEMENT', async () => {
    const bidRes = await request(`/api/v1/tenders/${tenderId}/bids`, {
      method: 'POST',
      body: {
        vendorId,
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
    // Attempting to read bid payload prior to opening ceremony MUST FAIL with HTTP 403
    const forbiddenRes = await request(`/api/v1/tenders/${tenderId}/bids/${bid1Id}/content`);
    assert.strictEqual(forbiddenRes.status, 403);
    assert.strictEqual(forbiddenRes.body.code, 'BIDS_SEALED_UNTIL_OPENING_EVENT');
  });

  await t.test('Step 8: Bid Opening Ceremony unseals bids (Rule 1 & 2)', async () => {
    const openRes = await request(`/api/v1/tenders/${tenderId}/bids/opening-ceremony`, {
      method: 'POST',
      body: {
        committeeChair: 'chair@kea.gov.kw',
        attendees: ['chair@kea.gov.kw', 'officer@kea.gov.kw', 'auditor@kea.gov.kw'],
        minutesNotes: 'Opening ceremony convened. All bids confirmed sealed and intact.'
      }
    });
    assert.strictEqual(openRes.status, 200);
    assert.strictEqual(openRes.body.openedBidsCount, 1);

    // NOW that ceremony is recorded, bid payload retrieval succeeds
    const unsealedRes = await request(`/api/v1/tenders/${tenderId}/bids/${bid1Id}/content`);
    assert.strictEqual(unsealedRes.status, 200);
    assert.strictEqual(unsealedRes.body.technicalProposalDocId, 'doc_tech_gulf_001');
    assert.ok(unsealedRes.body.unsealedAt);
  });

  await t.test('Step 9: Technical & Financial Evaluation Scorecard', async () => {
    const scoreRes = await request(`/api/v1/tenders/${tenderId}/evaluations/scorecard`, {
      method: 'POST',
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
    const auditRes = await request('/api/v1/audit-logs/verify-integrity');
    assert.strictEqual(auditRes.status, 200);
    assert.strictEqual(auditRes.body.chainIntegrityValid, true);
    assert.ok(auditRes.body.totalEventsVerified >= 8);
  });
});
