import { test } from 'node:test';
import assert from 'node:assert';
import app from '../../services/api/dist/server.js';
import * as http from 'http';

test('E2E Automated Verification: Demo Steps 1 to 4 (Task T13)', async (t) => {
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

  // Step 1: Tenant Provisioning Verification
  await t.test('Step 1: Tenant exists and can be provisioned', async () => {
    const res = await callApi('/api/v1/tenants/kea');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.id, 'kea');
    assert.strictEqual(res.body.defaultCurrency, 'KWD');
  });

  // Step 2: Vendor Registration & Approval
  let vendorId = '';
  await t.test('Step 2: Vendor registration and verification', async () => {
    const regRes = await callApi('/api/v1/vendors/register', {
      method: 'POST',
      body: {
        legalNameEn: 'Al-Bahar Technology Solutions',
        legalNameAr: 'شركة البحر للحلول التقنية',
        crNumber: 'CR-104928',
        contactEmail: 'tenders@albahar.example.com'
      }
    });
    assert.strictEqual(regRes.status, 201);
    assert.strictEqual(regRes.body.status, 'PENDING_REVIEW');
    vendorId = regRes.body.id;

    // Director/Officer approves vendor
    const appRes = await callApi(`/api/v1/vendors/${vendorId}/approve`, {
      method: 'POST',
      body: { reason: 'Commercial license and compliance verified' }
    });
    assert.strictEqual(appRes.status, 200);
    assert.strictEqual(appRes.body.status, 'APPROVED');
  });

  // Step 3: Tender Preparation in DRAFT
  let tenderId = '';
  await t.test('Step 3: Tender preparation in DRAFT', async () => {
    const tndRes = await callApi('/api/v1/tenders', {
      method: 'POST',
      body: {
        tenderNumber: 'KEA-TND-2026-092',
        titleEn: 'Data Center Core Network Refresh',
        titleAr: 'تحديث الشبكة الأساسية لمركز البيانات',
        category: 'IT',
        estimatedBudget: 320000,
        submissionDeadline: '2026-10-14T12:00:00Z',
        documentIds: ['doc_specs_092', 'doc_terms_092']
      }
    });
    assert.strictEqual(tndRes.status, 201);
    assert.strictEqual(tndRes.body.status, 'DRAFT');
    tenderId = tndRes.body.id;
  });

  // Step 4: AI Completeness Review & Director Sign-Off (Rule 7)
  await t.test('Step 4: AI Completeness check & Director approval (Rule 7)', async () => {
    const aiRes = await callApi('/api/v1/ai/advisory/tender-completeness-check', {
      method: 'POST',
      body: { tenderId }
    });
    assert.strictEqual(aiRes.status, 200);
    assert.strictEqual(aiRes.body.recommendation, 'RECOMMENDED_FOR_APPROVAL');

    // Director formally signs off
    const appRes = await callApi(`/api/v1/tenders/${tenderId}/approve-publish`, {
      method: 'POST',
      body: { reason: 'Approved by Procurement Director', aiAdvisoryRef: 'ai_ref_092' }
    });
    assert.strictEqual(appRes.status, 200);
    assert.strictEqual(appRes.body.status, 'APPROVED_FOR_PUBLICATION');
  });

  server.close();
});
