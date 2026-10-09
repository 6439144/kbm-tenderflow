import { test } from 'node:test';
import assert from 'node:assert';
import app from '../../services/api/dist/server.js';
import * as http from 'http';

test('Security Penetration & Authorization Tests (Agent A6 / Task T13)', async (t) => {
  let server: http.Server;
  let baseUrl: string;

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  baseUrl = `http://127.0.0.1:${port}`;

  async function request(path: string, options: any = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': options.tenantId || 'kea',
        'X-Actor-Role': options.role || 'PUBLIC',
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = (await res.json().catch(() => ({}))) as any;
    return { status: res.status, body: data };
  }

  // Setup: create and publish a valid tender
  const tenderRes = await request('/api/v1/tenders', {
    method: 'POST',
    role: 'PROCUREMENT_OFFICER',
    body: {
      tenderNumber: 'SEC-A6-TEST-001',
      titleEn: 'Platform Security Assessment Tender',
      titleAr: 'مناقصة تقييم أمان المنصة',
      category: 'IT',
      estimatedBudget: 150000,
      submissionDeadline: '2026-10-14T12:00:00Z'
    }
  });
  const tenderId = tenderRes.body.id;
  await request(`/api/v1/tenders/${tenderId}/approve-publish`, { method: 'POST', role: 'DIRECTOR' });
  await request(`/api/v1/tenders/${tenderId}/publish`, { method: 'POST', role: 'PROCUREMENT_OFFICER' });

  // Submit sealed bid
  const bidRes = await request(`/api/v1/tenders/${tenderId}/bids`, {
    method: 'POST',
    role: 'VENDOR',
    body: {
      vendorId: 'vnd_attacker_007',
      vendorName: 'Suspicious Vendor Corp',
      technicalProposalDocId: 'doc_secret_tech_payload',
      financialProposalDocId: 'doc_secret_fin_payload',
      hashDigest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    }
  });
  const bidId = bidRes.body.id;

  await t.test('RULE 1: Nobody (AI tools included) reads a sealed bid before opening', async () => {
    // 1. Direct API read attempt by PUBLIC
    const rPublic = await request(`/api/v1/tenders/${tenderId}/bids/${bidId}/content`, { role: 'PUBLIC' });
    assert.strictEqual(rPublic.status, 403);
    assert.strictEqual(rPublic.body.code, 'BIDS_SEALED_UNTIL_OPENING_EVENT');

    // 2. Direct API read attempt by VENDOR
    const rVendor = await request(`/api/v1/tenders/${tenderId}/bids/${bidId}/content`, { role: 'VENDOR' });
    assert.strictEqual(rVendor.status, 403);
    assert.strictEqual(rVendor.body.code, 'BIDS_SEALED_UNTIL_OPENING_EVENT');

    // 3. Direct API read attempt by PROCUREMENT_OFFICER
    const rOfficer = await request(`/api/v1/tenders/${tenderId}/bids/${bidId}/content`, { role: 'PROCUREMENT_OFFICER' });
    assert.strictEqual(rOfficer.status, 403);
    assert.strictEqual(rOfficer.body.code, 'BIDS_SEALED_UNTIL_OPENING_EVENT');

    // 4. Direct API read attempt by SUPER_ADMIN
    const rAdmin = await request(`/api/v1/tenders/${tenderId}/bids/${bidId}/content`, { role: 'SUPER_ADMIN' });
    assert.strictEqual(rAdmin.status, 403);
    assert.strictEqual(rAdmin.body.code, 'BIDS_SEALED_UNTIL_OPENING_EVENT');

    // 5. AI Tool endpoint attempt to evaluate sealed bid compliance before opening
    const rAI = await request('/api/v1/ai/advisory/evaluate-bid-compliance', {
      method: 'POST',
      role: 'PROCUREMENT_OFFICER',
      body: { bidId, vendorName: 'Suspicious Vendor Corp' }
    });
    assert.strictEqual(rAI.status, 403);
    assert.strictEqual(rAI.body.code, 'BIDS_SEALED_UNTIL_OPENING_EVENT');
  });

  await t.test('RULE 3 & RBAC: Vendor cannot call procurement endpoints', async () => {
    // 1. Vendor cannot draft a tender
    const rDraft = await request('/api/v1/tenders', {
      method: 'POST',
      role: 'VENDOR',
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
      role: 'VENDOR',
      body: { reason: 'Unauthorized approval' }
    });
    assert.strictEqual(rApprove.status, 403);
    assert.strictEqual(rApprove.body.code, 'FORBIDDEN_ROLE');

    // 3. Vendor cannot publish a tender
    const rPub = await request(`/api/v1/tenders/${tenderId}/publish`, {
      method: 'POST',
      role: 'VENDOR'
    });
    assert.strictEqual(rPub.status, 403);
    assert.strictEqual(rPub.body.code, 'FORBIDDEN_ROLE');

    // 4. Vendor cannot convene bid opening ceremony
    const rOpen = await request(`/api/v1/tenders/${tenderId}/bids/opening-ceremony`, {
      method: 'POST',
      role: 'VENDOR',
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
      role: 'VENDOR',
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
      role: 'VENDOR',
      body: {
        winningVendorId: 'vnd_attacker_007',
        awardValue: 999999
      }
    });
    assert.strictEqual(rAward.status, 403);
    assert.strictEqual(rAward.body.code, 'FORBIDDEN_ROLE');

    // 7. Vendor cannot approve vendor accounts
    const rApproveVnd = await request('/api/v1/vendors/vnd_attacker_007/approve', {
      method: 'POST',
      role: 'VENDOR',
      body: { reason: 'Self approval' }
    });
    assert.strictEqual(rApproveVnd.status, 403);
    assert.strictEqual(rApproveVnd.body.code, 'FORBIDDEN_ROLE');
  });

  await t.test('RULE 3: Cross-tenant data isolation is strictly enforced', async () => {
    // 1. Cross-tenant retrieval by tender ID returns 404 (strictly segregated)
    const rCrossGet = await request(`/api/v1/tenders/${tenderId}`, {
      tenantId: 'ministry_b'
    });
    assert.strictEqual(rCrossGet.status, 404);

    // 2. Cross-tenant tender list query returns only tenders belonging to that tenant
    const rCrossList = await request('/api/v1/tenders', {
      tenantId: 'ministry_b'
    });
    assert.strictEqual(rCrossList.status, 200);
    const tenders = rCrossList.body as any[];
    assert.ok(tenders.every((t: any) => t.tenantId === 'ministry_b'));
  });

  server.close();
});
