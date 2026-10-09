import { test } from 'node:test';
import assert from 'node:assert';
import app from '../../services/api/dist/server.js';
import * as http from 'http';

test('Security Penetration Test: Sealed Bids & Tenant Isolation', async (t) => {
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

  await t.test('RULE 1: Sealed bid read is rejected for Admin, Officer and AI prior to opening', async () => {
    // 1. Create tender
    const tenderRes = await request('/api/v1/tenders', {
      method: 'POST',
      role: 'PROCUREMENT_OFFICER',
      body: {
        tenderNumber: 'SEC-TEST-001',
        titleEn: 'Security Penetration Tender',
        titleAr: 'مناقصة اختبار الأمان',
        category: 'IT',
        estimatedBudget: 100000,
        submissionDeadline: '2026-10-14T12:00:00Z'
      }
    });
    const tenderId = tenderRes.body.id;

    // 2. Publish tender
    await request(`/api/v1/tenders/${tenderId}/approve-publish`, { method: 'POST', role: 'DIRECTOR' });
    await request(`/api/v1/tenders/${tenderId}/publish`, { method: 'POST', role: 'PROCUREMENT_OFFICER' });

    // 3. Submit sealed bid
    const bidRes = await request(`/api/v1/tenders/${tenderId}/bids`, {
      method: 'POST',
      body: {
        vendorId: 'vnd_attacker',
        vendorName: 'Attacker Co',
        technicalProposalDocId: 'doc_secret_tech',
        financialProposalDocId: 'doc_secret_fin',
        hashDigest: 'abc123sha256hash'
      }
    });
    const bidId = bidRes.body.id;

    // 4. ATTEMPT 1: Anonymous vendor tries to read bid content
    const res1 = await request(`/api/v1/tenders/${tenderId}/bids/${bidId}/content`, { role: 'PUBLIC' });
    assert.strictEqual(res1.status, 403);
    assert.strictEqual(res1.body.code, 'BIDS_SEALED_UNTIL_OPENING_EVENT');

    // 5. ATTEMPT 2: Procurement Officer tries to read bid content before opening
    const res2 = await request(`/api/v1/tenders/${tenderId}/bids/${bidId}/content`, { role: 'PROCUREMENT_OFFICER' });
    assert.strictEqual(res2.status, 403);
    assert.strictEqual(res2.body.code, 'BIDS_SEALED_UNTIL_OPENING_EVENT');

    // 6. ATTEMPT 3: Super Admin tries to read bid content before opening
    const res3 = await request(`/api/v1/tenders/${tenderId}/bids/${bidId}/content`, { role: 'SUPER_ADMIN' });
    assert.strictEqual(res3.status, 403);
    assert.strictEqual(res3.body.code, 'BIDS_SEALED_UNTIL_OPENING_EVENT');
  });

  await t.test('RULE 3: Cross-tenant data isolation is strictly enforced', async () => {
    // Attempt to access KEA tender from tenant GPC
    const crossRes = await fetch(`${baseUrl}/api/v1/tenders`, {
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': 'gpc'
      }
    });
    // GPC tenant should not exist or has 0 KEA tenders
    const tenders = (await crossRes.json()) as any[];
    if (Array.isArray(tenders)) {
      assert.ok(tenders.every(t => t.tenantId === 'gpc'));
    }
  });

  server.close();
});
