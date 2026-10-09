process.env.NODE_ENV = 'test';
process.env.BID_MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { test } from 'node:test';
import assert from 'node:assert';
import app from '../../services/api/dist/server.js';
import { createTestToken } from '../../services/api/dist/middleware/auth.js';
import * as http from 'http';

test('Security Penetration & Authorization Tests (Agent A6 / Tasks G1-b, G1-c, G1-e)', async (t) => {
  let server: http.Server;
  let baseUrl: string;

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  baseUrl = `http://127.0.0.1:${port}`;

  // Mint cryptographically verified tokens for testing roles
  const officerToken = await createTestToken({
    sub: 'officer_sec_1',
    role: 'PROCUREMENT_OFFICER',
    tenantId: 'kea'
  });

  const directorToken = await createTestToken({
    sub: 'director_sec_1',
    role: 'DIRECTOR',
    tenantId: 'kea'
  });

  const vendorToken = await createTestToken({
    sub: 'vnd_attacker_007',
    role: 'VENDOR',
    tenantId: 'kea',
    vendorId: 'vnd_attacker_007'
  });

  const competitorVendorToken = await createTestToken({
    sub: 'vnd_competitor_888',
    role: 'VENDOR',
    tenantId: 'kea',
    vendorId: 'vnd_competitor_888'
  });

  const adminToken = await createTestToken({
    sub: 'admin_sec_1',
    role: 'SUPER_ADMIN',
    tenantId: 'kea'
  });

  const chairToken = await createTestToken({
    sub: 'chair_sec_1',
    role: 'COMMITTEE_CHAIR',
    tenantId: 'kea'
  });

  async function request(path: string, options: any = {}) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Tenant-ID': options.tenantId || 'kea',
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
    return { status: res.status, body: data };
  }

  // Setup: create and publish a valid tender with deadline 2s in future
  const deadline = new Date(Date.now() + 2500).toISOString();
  const tenderRes = await request('/api/v1/tenders', {
    method: 'POST',
    token: officerToken,
    body: {
      tenderNumber: 'SEC-A6-TEST-001',
      titleEn: 'Platform Security Assessment Tender',
      titleAr: 'مناقصة تقييم أمان المنصة',
      category: 'IT',
      estimatedBudget: 150000,
      submissionDeadline: deadline
    }
  });
  const tenderId = tenderRes.body.id;
  await request(`/api/v1/tenders/${tenderId}/approve-publish`, { method: 'POST', token: directorToken });
  await request(`/api/v1/tenders/${tenderId}/publish`, { method: 'POST', token: officerToken });

  // Submit sealed bid
  const bidRes = await request(`/api/v1/tenders/${tenderId}/bids`, {
    method: 'POST',
    token: vendorToken,
    body: {
      vendorName: 'Suspicious Vendor Corp',
      technicalProposalDocId: 'doc_secret_tech_payload',
      financialProposalDocId: 'doc_secret_fin_payload',
      hashDigest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    }
  });
  const bidId = bidRes.body.id;

  await t.test('RULE 1: Nobody (AI tools included) reads a sealed bid before opening', async () => {
    // 1. Direct API read attempt by anonymous -> 401
    const rAnon = await request(`/api/v1/tenders/${tenderId}/bids/${bidId}/content`);
    assert.strictEqual(rAnon.status, 401);

    // 2. Direct API read attempt by VENDOR -> 403
    const rVendor = await request(`/api/v1/tenders/${tenderId}/bids/${bidId}/content`, { token: vendorToken });
    assert.strictEqual(rVendor.status, 403);
    assert.strictEqual(rVendor.body.code, 'BIDS_SEALED_UNTIL_OPENING_EVENT');

    // 3. Direct API read attempt by PROCUREMENT_OFFICER -> 403
    const rOfficer = await request(`/api/v1/tenders/${tenderId}/bids/${bidId}/content`, { token: officerToken });
    assert.strictEqual(rOfficer.status, 403);
    assert.strictEqual(rOfficer.body.code, 'BIDS_SEALED_UNTIL_OPENING_EVENT');

    // 4. Direct API read attempt by SUPER_ADMIN -> 403
    const rAdmin = await request(`/api/v1/tenders/${tenderId}/bids/${bidId}/content`, { token: adminToken });
    assert.strictEqual(rAdmin.status, 403);
    assert.strictEqual(rAdmin.body.code, 'BIDS_SEALED_UNTIL_OPENING_EVENT');

    // 5. Direct document download via /documents/:id before opening -> 403
    const rDoc = await request(`/api/v1/documents/doc_secret_tech_payload`, { token: adminToken });
    assert.strictEqual(rDoc.status, 403);
    assert.strictEqual(rDoc.body.code, 'BIDS_SEALED_UNTIL_OPENING_EVENT');

    // 6. AI Tool endpoint attempt to evaluate sealed bid compliance before opening -> 403
    const rAI = await request('/api/v1/ai/advisory/evaluate-bid-compliance', {
      method: 'POST',
      token: chairToken,
      body: { bidId, vendorName: 'Suspicious Vendor Corp' }
    });
    assert.strictEqual(rAI.status, 403);
    assert.strictEqual(rAI.body.code, 'BIDS_SEALED_UNTIL_OPENING_EVENT');
  });

  await t.test('RULE 1 / R1b-3: Uploaded proposal documents are shielded from competitor before bid submission (deny by default)', async () => {
    // Vendor A uploads a financial proposal document
    const uploadRes = await request('/api/v1/documents/upload', {
      method: 'POST',
      token: vendorToken,
      body: {
        title: 'Confidential Financial Proposal',
        docType: 'FINANCIAL_PROPOSAL',
        contentBase64: Buffer.from('SECRET PRICE 9999').toString('base64'),
        tenderId
      }
    });
    assert.strictEqual(uploadRes.status, 201);
    const uploadedDocId = uploadRes.body.id;

    // Competitor Vendor attempts to download it via /documents/:id -> MUST RETURN 403
    const compDownload = await request(`/api/v1/documents/${uploadedDocId}`, {
      token: competitorVendorToken
    });
    assert.strictEqual(compDownload.status, 403);

    // Vendor A can download their own uploaded document
    const ownDownload = await request(`/api/v1/documents/${uploadedDocId}`, {
      token: vendorToken
    });
    assert.strictEqual(ownDownload.status, 200);

    // Unregistered / unknown document ID -> MUST RETURN 404 (deny by default)
    const unknownDownload = await request('/api/v1/documents/doc_non_existent_fake_id', {
      token: vendorToken
    });
    assert.strictEqual(unknownDownload.status, 404);
  });

  await t.test('R1b-2: Tokens without tenant_id claim are rejected with HTTP 401', async () => {
    const noTenantToken = await createTestToken({
      sub: 'forged_officer',
      role: 'PROCUREMENT_OFFICER'
    });
    const rNoTenant = await request('/api/v1/tenders', {
      method: 'POST',
      token: noTenantToken,
      body: { tenderNumber: 'FORGED-01' }
    });
    assert.strictEqual(rNoTenant.status, 401);
  });

  await t.test('RULE 1: Opening before deadline is rejected with HTTP 409 Conflict', async () => {
    // Attempting to open before deadline has elapsed
    const rEarlyOpen = await request(`/api/v1/tenders/${tenderId}/bids/opening-ceremony`, {
      method: 'POST',
      token: chairToken,
      body: {
        committeeChair: 'chair_sec_1',
        attendees: ['chair_sec_1']
      }
    });
    assert.strictEqual(rEarlyOpen.status, 409);
    assert.strictEqual(rEarlyOpen.body.code, 'OPENING_BEFORE_DEADLINE');
  });

  await t.test('RULE 3 & RBAC: Vendor cannot call procurement endpoints', async () => {
    // 1. Vendor cannot draft a tender
    const rDraft = await request('/api/v1/tenders', {
      method: 'POST',
      token: vendorToken,
      body: {
        tenderNumber: 'UNAUTHORIZED-001',
        titleEn: 'Illegal Tender',
        titleAr: 'مناقصة غير مصرح بها',
        category: 'IT',
        estimatedBudget: 50000,
        submissionDeadline: '2026-10-15T12:00:00Z'
      }
    });
    assert.strictEqual(rDraft.status, 403);
    assert.strictEqual(rDraft.body.code, 'FORBIDDEN_ROLE');

    // 2. Vendor cannot approve tender publication
    const rApprove = await request(`/api/v1/tenders/${tenderId}/approve-publish`, {
      method: 'POST',
      token: vendorToken,
      body: { reason: 'Unauthorized approval' }
    });
    assert.strictEqual(rApprove.status, 403);
    assert.strictEqual(rApprove.body.code, 'FORBIDDEN_ROLE');

    // 3. Vendor cannot publish a tender
    const rPub = await request(`/api/v1/tenders/${tenderId}/publish`, {
      method: 'POST',
      token: vendorToken
    });
    assert.strictEqual(rPub.status, 403);
    assert.strictEqual(rPub.body.code, 'FORBIDDEN_ROLE');

    // 4. Vendor cannot convene bid opening ceremony
    const rOpen = await request(`/api/v1/tenders/${tenderId}/bids/opening-ceremony`, {
      method: 'POST',
      token: vendorToken,
      body: {
        committeeChair: 'Hacker',
        attendees: ['Hacker 1', 'Hacker 2']
      }
    });
    assert.strictEqual(rOpen.status, 403);
    assert.strictEqual(rOpen.body.code, 'FORBIDDEN_ROLE');

    // 5. Vendor cannot submit evaluation scorecard
    const rScore = await request(`/api/v1/tenders/${tenderId}/evaluations/scorecard`, {
      method: 'POST',
      token: vendorToken,
      body: {
        bidId,
        technicalScore: 100,
        financialScore: 100
      }
    });
    assert.strictEqual(rScore.status, 403);
    assert.strictEqual(rScore.body.code, 'FORBIDDEN_ROLE');

    // 6. Vendor cannot make award decision
    const rAward = await request(`/api/v1/tenders/${tenderId}/evaluations/award`, {
      method: 'POST',
      token: vendorToken,
      body: {
        winningVendorId: 'vnd_attacker_007',
        awardValue: 999999
      }
    });
    assert.strictEqual(rAward.status, 403);
    assert.strictEqual(rAward.body.code, 'FORBIDDEN_ROLE');
  });

  await t.test('RULE 1: Competitor vendor cannot inspect competing bids after opening', async () => {
    // Wait for deadline to elapse
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Open bids with committee chair
    const rOpen = await request(`/api/v1/tenders/${tenderId}/bids/opening-ceremony`, {
      method: 'POST',
      token: chairToken,
      body: {
        committeeChair: 'chair_sec_1',
        attendees: ['chair_sec_1']
      }
    });
    assert.strictEqual(rOpen.status, 200);

    // Submitting vendor can view own bid content
    const rOwnBid = await request(`/api/v1/tenders/${tenderId}/bids/${bidId}/content`, { token: vendorToken });
    assert.strictEqual(rOwnBid.status, 200);

    // Competitor vendor is strictly forbidden from viewing another vendor's bid content (403)
    const rCompetitor = await request(`/api/v1/tenders/${tenderId}/bids/${bidId}/content`, { token: competitorVendorToken });
    assert.strictEqual(rCompetitor.status, 403);
    assert.strictEqual(rCompetitor.body.code, 'FORBIDDEN_COMPETITOR_ACCESS');
  });

  await t.test('RULE 3: Cross-tenant data isolation is strictly enforced', async () => {
    // Cross-tenant retrieval by tender ID returns 404 (strictly segregated)
    const rCrossGet = await request(`/api/v1/tenders/${tenderId}`, {
      token: officerToken,
      tenantId: 'ministry_b'
    });
    // Header doesn't match token tenant 'kea' -> 403 TENANT_MISMATCH
    assert.strictEqual(rCrossGet.status, 403);
    assert.strictEqual(rCrossGet.body.code, 'TENANT_MISMATCH');
  });

  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  server.unref();
});
