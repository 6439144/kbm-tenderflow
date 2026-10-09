// SEC content protection (MOI SEC-001/002, FR-023): protected viewer, original download refused for vendors,
// watermarked PDF download after purchase, deterrent events, precedence template → entity setting → profile.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { api, fileForm, login, makeTenant, makeUser, startApp, tenderBody, PASSWORD, type Running } from './helpers.js';
import { readFingerprint } from '../src/content/watermark.js';
import { clearSettingsCache } from '../src/features/security/settings.js';
import { sha256Hex } from '../src/util.js';

let run: Running;
let admin: string, officer: string, director: string;
let vPaid: string, vNot: string, vOther: string;
let tenderId: string, pdfId: string, mdId: string;
let pdfBytes: Buffer;

async function regVendor(tenant: string, username: string, officerToken: string) {
  const r = await api(run, 'POST', '/api/v1/public/vendors/register', { json: { tenantId: tenant, legalNameEn: `${username} Trading (fictitious)`, legalNameAr: `${username} للتجارة (وهمية)`,
    crNumber: `CR-${username}`, email: `${username}@x.example`, phone: '1', categories: ['IT'], username, password: PASSWORD } });
  assert.equal(r.status, 201, r.text);
  const d = await api(run, 'POST', `/api/v1/vendors/${r.body.vendor.id}/decision`, { token: officerToken, json: { decision: 'APPROVE', reason: 'ok' } });
  assert.equal(d.status, 200, d.text);
  return login(run, tenant, username);
}

before(async () => {
  run = await startApp();
  await makeTenant(run, 'ca');
  await makeTenant(run, 'cb');
  for (const [u, r] of [['admin', 'TENANT_ADMIN'], ['officer', 'PROCUREMENT_OFFICER'], ['director', 'DIRECTOR']] as const) await makeUser(run, 'ca', u, [r]);
  await makeUser(run, 'cb', 'officer', ['PROCUREMENT_OFFICER']);
  [admin, officer, director] = await Promise.all(['admin', 'officer', 'director'].map((u) => login(run, 'ca', u)));
  const officerB = await login(run, 'cb', 'officer');
  vPaid = await regVendor('ca', 'vpaid', officer);
  vNot = await regVendor('ca', 'vnot', officer);
  vOther = await regVendor('cb', 'vother', officerB);

  // Template with paid documents.
  const tpl = await api(run, 'POST', '/api/v1/templates', { token: admin, json: { code: 'PAID_DOCS', nameEn: 'Paid documents', nameAr: 'وثائق مدفوعة',
    config: { stages: { documentPurchase: true }, fees: { documentPrice: 5, currency: 'KWD' } } } });
  assert.equal(tpl.status, 201, tpl.text);
  assert.equal((await api(run, 'POST', `/api/v1/templates/${tpl.body.id}/publish`, { token: admin, json: {} })).status, 200);
  const t = await api(run, 'POST', '/api/v1/tenders', { token: officer, json: tenderBody(3600_000, { templateId: tpl.body.id }) });
  assert.equal(t.status, 201, t.text);
  tenderId = t.body.id;

  const doc = await PDFDocument.create();
  const f = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText('Scope of work: supply of 40 servers', { x: 50, y: 780, size: 14, font: f });
  doc.addPage([595, 842]).drawText('Terms: delivery in 90 days', { x: 50, y: 780, size: 14, font: f });
  pdfBytes = Buffer.from(await doc.save());
  const up1 = await api(run, 'POST', `/api/v1/tenders/${tenderId}/documents`, { token: officer, form: fileForm({ file: { name: 'pack.pdf', content: pdfBytes, type: 'application/pdf' } }) });
  assert.equal(up1.status, 201, up1.text);
  pdfId = up1.body.id;
  const words = Array.from({ length: 60 }, (_, i) => `term${i}`).join(' ');
  const up2 = await api(run, 'POST', `/api/v1/tenders/${tenderId}/documents`, { token: officer, form: fileForm({ file: { name: 'annex.md', content: `# 1. Annex\n${words}\n\n# 2. ملحق\nنطاق العمل والتوريد` } }) });
  assert.equal(up2.status, 201, up2.text);
  mdId = up2.body.id;
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${tenderId}/approve`, { token: director, json: { reason: 'ok' } })).status, 200);
  const pub = await api(run, 'POST', `/api/v1/tenders/${tenderId}/publish`, { token: officer });
  assert.equal(pub.body.status, 'PUBLISHED', pub.text);
});
after(async () => { await run.stop(); });

const setMode = async (contentProtection: string | null) => {
  const r = await api(run, 'PUT', '/api/v1/security/settings', { token: admin, json: { contentProtection } });
  assert.equal(r.status, 200, r.text);
};

test('mode OFF (default): vendors download the original as before', async () => {
  const st = await api(run, 'GET', `/api/v1/security/content/documents?ids=${pdfId},${mdId}`, { token: vNot });
  assert.equal(st.status, 200);
  assert.deepEqual(st.body.map((x: any) => [x.mode, x.download, x.viewer]), [['OFF', 'ORIGINAL', false], ['OFF', 'ORIGINAL', false]]);
  const d = await api(run, 'GET', `/api/v1/documents/${pdfId}`, { token: vNot });
  assert.equal(d.status, 200);
});

test('VIEW_ONLY: vendor original download refused (403 CONTENT_PROTECTED), staff unaffected; viewer works before purchase and is audited', async () => {
  await setMode('VIEW_ONLY');
  const d = await api(run, 'GET', `/api/v1/documents/${pdfId}`, { token: vNot });
  assert.equal(d.status, 403);
  assert.equal(d.body.code, 'CONTENT_PROTECTED');
  assert.equal((await api(run, 'GET', `/api/v1/documents/${pdfId}`, { token: officer })).status, 200, 'staff see originals');
  const st = await api(run, 'GET', `/api/v1/security/content/documents?ids=${pdfId}`, { token: vNot });
  assert.equal(st.body[0].download, 'NONE');
  assert.equal(st.body[0].viewer, true);
  const v = await api(run, 'POST', `/api/v1/security/content/documents/${pdfId}/view`, { token: vNot });
  assert.equal(v.status, 200, v.text);
  assert.equal(v.headers.get('cache-control'), 'no-store');
  assert.equal(v.body.pages.length, 2);
  assert.equal(v.body.pages[0].kind, 'text');
  assert.match(v.body.pages[0].text.replace(/[​⁠]/g, ''), /Scope of work: supply of 40 servers/);
  assert.equal(readFingerprint(v.body.pages[0].text), v.body.viewId.slice(0, 8), 'text carries the view fingerprint');
  assert.equal(v.body.watermark.lines[0], 'vnot Trading (fictitious)');
  assert.match(v.body.watermark.lines.join(' '), /CR CR-vnot/);
  assert.match(v.body.watermark.lines.join(' '), /user vnot/);
  assert.match(v.body.watermark.lines.join(' '), new RegExp(`ref ${v.body.viewId.slice(0, 8)}`));
  assert.equal(v.body.watermark.linesAr[0], 'vnot للتجارة (وهمية)');
  const md = await api(run, 'POST', `/api/v1/security/content/documents/${mdId}/view`, { token: vNot });
  assert.equal(md.status, 200);
  assert.match(md.body.pages.map((p: any) => p.text.replace(/[\u200B\u2060]/g, '')).join('\n'), /نطاق العمل/);
  const dl = await api(run, 'GET', `/api/v1/security/content/documents/${pdfId}/download`, { token: vNot });
  assert.equal(dl.status, 403);
  const audit = await run.handle.ctx.db.query<any>(`SELECT actor_id, details FROM audit_events WHERE tenant_id='ca' AND action='TENDER_DOCUMENT_VIEWED' AND resource_id=$1`, [pdfId]);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.viewId, v.body.viewId);
  assert.ok(audit[0].details.vendorId);
});

test('viewer deterrent events are audited (rate-limited per view); only the viewer\'s own view; other tenant cannot view', async () => {
  const v = await api(run, 'POST', `/api/v1/security/content/documents/${mdId}/view`, { token: vNot });
  const e = await api(run, 'POST', `/api/v1/security/content/views/${v.body.viewId}/events`, { token: vNot, json: { type: 'PRINTSCREEN_KEY' } });
  assert.equal(e.status, 200);
  assert.equal(e.body.recorded, true);
  assert.equal((await api(run, 'POST', `/api/v1/security/content/views/${v.body.viewId}/events`, { token: vNot, json: { type: 'HACK' } })).status, 400);
  assert.equal((await api(run, 'POST', `/api/v1/security/content/views/${v.body.viewId}/events`, { token: vPaid, json: { type: 'PRINT_ATTEMPT' } })).status, 404);
  for (let i = 0; i < 30; i++) await api(run, 'POST', `/api/v1/security/content/views/${v.body.viewId}/events`, { token: vNot, json: { type: 'COPY_ATTEMPT' } });
  const capped = await api(run, 'POST', `/api/v1/security/content/views/${v.body.viewId}/events`, { token: vNot, json: { type: 'COPY_ATTEMPT' } });
  assert.equal(capped.body.recorded, false);
  const n = await run.handle.ctx.db.query<any>(`SELECT count(*)::int AS n FROM audit_events WHERE action='CONTENT_PROTECTION_EVENT' AND details->>'viewId'=$1`, [v.body.viewId]);
  assert.equal(n[0].n, 30);
  // Vendor of another entity: the document does not exist for them.
  assert.equal((await api(run, 'POST', `/api/v1/security/content/documents/${pdfId}/view`, { token: vOther })).status, 404);
  assert.equal((await api(run, 'GET', `/api/v1/security/content/documents/${pdfId}/download`, { token: vOther })).status, 404);
  assert.deepEqual((await api(run, 'GET', `/api/v1/security/content/documents?ids=${pdfId}`, { token: vOther })).body, []);
});

test('WATERMARKED_DOWNLOAD: purchase required → 402 until purchased; stamped PDF with vendor, ID, timestamp, receipt; original unchanged; non-PDF view-only', async () => {
  await setMode('WATERMARKED_DOWNLOAD');
  const before = await api(run, 'GET', `/api/v1/security/content/documents/${pdfId}/download`, { token: vPaid });
  assert.equal(before.status, 402);
  assert.equal(before.body.code, 'PURCHASE_REQUIRED');
  assert.equal((await api(run, 'GET', `/api/v1/security/content/documents?ids=${pdfId}`, { token: vPaid })).body[0].download, 'PURCHASE_REQUIRED');
  const p = await api(run, 'POST', `/api/v1/tenders/${tenderId}/purchase`, { token: vPaid, json: { gateway: 'TEST' } });
  assert.equal(p.status, 201, p.text);
  const receipt = p.body.receiptNumber;
  assert.ok(receipt);
  assert.equal((await api(run, 'GET', `/api/v1/security/content/documents?ids=${pdfId},${mdId}`, { token: vPaid })).body.map((x: any) => x.download).join(), 'WATERMARKED,VIEW_ONLY_FORMAT');
  assert.equal((await api(run, 'GET', `/api/v1/documents/${pdfId}`, { token: vPaid })).body.code, 'CONTENT_PROTECTED', 'still no original');
  const res = await fetch(`${run.base}/api/v1/security/content/documents/${pdfId}/download`, { headers: { authorization: `Bearer ${vPaid}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition') ?? '', /watermarked/);
  const stamped = Buffer.from(await res.arrayBuffer());
  assert.notEqual(sha256Hex(stamped), sha256Hex(pdfBytes));
  const { extractText, getDocumentProxy } = await import('unpdf');
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(stamped)), { mergePages: false });
  assert.equal(text.length, 2);
  for (const pageText of text) {
    assert.match(pageText, /vpaid Trading \(fictitious\)/);
    assert.match(pageText, /CR CR-vpaid/);
    assert.match(pageText, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
    assert.match(pageText, new RegExp(`receipt ${receipt}`));
  }
  assert.match(text[0], /Scope of work/);
  const orig = await fetch(`${run.base}/api/v1/documents/${pdfId}`, { headers: { authorization: `Bearer ${officer}` } });
  assert.equal(sha256Hex(Buffer.from(await orig.arrayBuffer())), sha256Hex(pdfBytes), 'stored original never modified');
  const md = await api(run, 'GET', `/api/v1/security/content/documents/${mdId}/download`, { token: vPaid });
  assert.equal(md.status, 409);
  assert.equal(md.body.code, 'VIEW_ONLY_FORMAT');
  assert.equal((await api(run, 'GET', `/api/v1/security/content/documents/${pdfId}/download`, { token: vNot })).status, 402, 'vendor who did not purchase');
  assert.equal((await api(run, 'GET', `/api/v1/security/content/documents/${pdfId}/download`, { token: officer })).status, 403, 'staff use the original');
  const audit = await run.handle.ctx.db.query<any>(`SELECT details FROM audit_events WHERE tenant_id='ca' AND action='TENDER_DOCUMENT_DOWNLOADED_WATERMARKED'`);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.receipt, receipt);
  assert.equal(audit[0].details.watermarkedSha256, sha256Hex(stamped));
});

test('precedence: tender template setting overrides the entity; entity profile contentProtection is used when the security setting is unset', async () => {
  await setMode('VIEW_ONLY');
  await run.handle.ctx.db.query(`UPDATE tenders SET template_snapshot = jsonb_set(template_snapshot, '{config,contentProtection}', '"OFF"') WHERE id=$1`, [tenderId]);
  assert.equal((await api(run, 'GET', `/api/v1/documents/${pdfId}`, { token: vNot })).status, 200, 'template OFF wins');
  const st = await api(run, 'GET', `/api/v1/security/content/documents?ids=${pdfId}`, { token: vNot });
  assert.equal(st.body[0].source, 'TEMPLATE');
  await run.handle.ctx.db.query(`UPDATE tenders SET template_snapshot = template_snapshot #- '{config,contentProtection}' WHERE id=$1`, [tenderId]);
  await setMode(null);
  await run.handle.ctx.db.query(`UPDATE tenants SET profile = COALESCE(profile,'{}'::jsonb) || '{"contentProtection":"VIEW_ONLY"}' WHERE id='ca'`);
  clearSettingsCache(run.handle.ctx);
  const st2 = await api(run, 'GET', `/api/v1/security/content/documents?ids=${pdfId}`, { token: vNot });
  assert.equal(st2.body[0].mode, 'VIEW_ONLY');
  assert.equal(st2.body[0].source, 'ENTITY_PROFILE');
  assert.equal((await api(run, 'GET', `/api/v1/documents/${pdfId}`, { token: vNot })).status, 403);
});
