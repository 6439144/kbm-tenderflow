import { test } from 'node:test';
import assert from 'node:assert';
import app from '../../services/api/dist/server.js';
import * as http from 'http';

test('E2E Automated Verification: Demo Steps 5 to 8 (Task T18)', async (t) => {
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

  // Setup: create and approve tender
  const tndRes = await callApi('/api/v1/tenders', {
    method: 'POST',
    body: {
      tenderNumber: 'KEA-TND-2026-093',
      titleEn: 'Campus Optical Backbone Upgrade',
      titleAr: 'ترقية الشبكة الضوئية للمجمع الحكومي',
      category: 'WORKS',
      estimatedBudget: 450000,
      submissionDeadline: '2026-10-14T12:00:00Z',
      documentIds: ['doc_specs_093']
    }
  });
  const tenderId = tndRes.body.id;
  await callApi(`/api/v1/tenders/${tenderId}/approve-publish`, { method: 'POST', body: { reason: 'Director approved' } });

  // Step 5: Tender publication to Vendor Portal
  await t.test('Step 5: Tender publication to Vendor Portal', async () => {
    const pubRes = await callApi(`/api/v1/tenders/${tenderId}/publish`, { method: 'POST' });
    assert.strictEqual(pubRes.status, 200);
    assert.strictEqual(pubRes.body.status, 'PUBLISHED');
  });

  // Step 6: Clarifications & Addendum #1
  await t.test('Step 6: Clarifications & AI-drafted reply', async () => {
    const qRes = await callApi(`/api/v1/tenders/${tenderId}/clarifications`, {
      method: 'POST',
      body: { question: 'What is the required fiber optic cable rating?' }
    });
    assert.strictEqual(qRes.status, 201);
    const qId = qRes.body.id;

    // AI drafts reply
    const draftRes = await callApi('/api/v1/ai/advisory/draft-clarification-reply', {
      method: 'POST',
      body: { question: 'What is the required fiber optic cable rating?' }
    });
    assert.strictEqual(draftRes.status, 200);
    assert.ok(draftRes.body.draftAnswerEn);

    // Officer publishes official clarification answer
    const ansRes = await callApi(`/api/v1/tenders/${tenderId}/clarifications/${qId}/respond`, {
      method: 'POST',
      body: { answer: 'Single-mode OS2 optical fiber cable is mandatory.' }
    });
    assert.strictEqual(ansRes.status, 200);
    assert.strictEqual(ansRes.body.status, 'ANSWERED');
  });

  // Step 7: Sealed Bid Submission & Rule 1 Lock
  let bidId = '';
  await t.test('Step 7: Sealed Bid submission & RULE 1 ENFORCEMENT', async () => {
    const bidRes = await callApi(`/api/v1/tenders/${tenderId}/bids`, {
      method: 'POST',
      body: {
        vendorId: 'vnd_gulf_telecom',
        vendorName: 'Gulf Telecommunications Consortium',
        technicalProposalDocId: 'doc_fiber_tech_093',
        financialProposalDocId: 'doc_fiber_fin_093',
        hashDigest: '7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069'
      }
    });
    assert.strictEqual(bidRes.status, 201);
    assert.strictEqual(bidRes.body.status, 'SEALED');
    bidId = bidRes.body.id;

    // RULE 1: Attempt to read bid content before opening MUST fail with 403
    const readAttempt = await callApi(`/api/v1/tenders/${tenderId}/bids/${bidId}/content`);
    assert.strictEqual(readAttempt.status, 403);
    assert.strictEqual(readAttempt.body.code, 'BIDS_SEALED_UNTIL_OPENING_EVENT');
  });

  // Step 8: Bid Opening Ceremony
  await t.test('Step 8: Bid Opening Ceremony unseals bids (Rule 1 & 2)', async () => {
    const openRes = await callApi(`/api/v1/tenders/${tenderId}/bids/opening-ceremony`, {
      method: 'POST',
      body: {
        committeeChair: 'Eng. Tareq Al-Failakawi',
        attendees: ['Mona Al-Enezi', 'Fahad Al-Mutawa', 'Ali Al-Husseini'],
        minutesNotes: 'Opening session convened at 10:00 AM. 1 sealed envelope received and verified.'
      }
    });
    assert.strictEqual(openRes.status, 200);
    assert.strictEqual(openRes.body.openedBidsCount, 1);

    // Now bid content CAN be accessed
    const readAfterOpen = await callApi(`/api/v1/tenders/${tenderId}/bids/${bidId}/content`);
    assert.strictEqual(readAfterOpen.status, 200);
    assert.strictEqual(readAfterOpen.body.technicalProposalDocId, 'doc_fiber_tech_093');
  });

  server.close();
});
