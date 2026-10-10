// HARDEN protected viewer: POST /documents/:id/view-grant (single use, 60 s, bound to user + document) →
// GET /documents/:id/view-bytes with X-Viewer-Grant → server-watermarked PDF, no-store, inline without file name;
// same read rules as download (sealed bids stay sealed); DOCUMENT_VIEWED audited.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { api, fileForm, login, makeTenant, makeUser, startApp, tenderBody, PASSWORD, type Running } from './helpers.js';
import { now, setClockOffset } from '../src/util.js';
import { verifyAudit } from '../src/services/audit.js';

let run: Running;
let admin: string, officer: string, director: string, chair: string, evaluator: string, vendor: string, vendor2: string, otherEntity: string;
let tenderId: string, pdfId: string, pngId: string, mdId: string;
let pdfBytes: Buffer;

/** A valid 2×2 RGB PNG built by hand (signature, IHDR, IDAT, IEND with CRCs). */
function tinyPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function makePdf(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText(text, { x: 50, y: 780, size: 14, font: f });
  doc.addPage([595, 842]).drawText('Page two', { x: 50, y: 780, size: 14, font: f });
  return Buffer.from(await doc.save());
}

async function regVendor(username: string) {
  const r = await api(run, 'POST', '/api/v1/public/vendors/register', { json: { tenantId: 'vw', legalNameEn: `${username} Trading (fictitious)`, legalNameAr: `${username} للتجارة (وهمية)`,
    crNumber: `CR-${username}`, email: `${username}@x.example`, phone: '1', categories: ['IT'], username, password: PASSWORD } });
  assert.equal(r.status, 201, r.text);
  assert.equal((await api(run, 'POST', `/api/v1/vendors/${r.body.vendor.id}/decision`, { token: officer, json: { decision: 'APPROVE', reason: 'ok' } })).status, 200);
  return login(run, 'vw', username);
}

before(async () => {
  run = await startApp();
  await makeTenant(run, 'vw');
  await makeTenant(run, 'vx');
  for (const [u, r] of [['admin', 'TENANT_ADMIN'], ['officer', 'PROCUREMENT_OFFICER'], ['director', 'DIRECTOR'], ['chair', 'COMMITTEE_CHAIR'], ['evaluator', 'EVALUATOR']] as const)
    await makeUser(run, 'vw', u, [r]);
  await makeUser(run, 'vx', 'officer', ['PROCUREMENT_OFFICER']);
  [admin, officer, director, chair, evaluator] = await Promise.all(['admin', 'officer', 'director', 'chair', 'evaluator'].map((u) => login(run, 'vw', u)));
  otherEntity = await login(run, 'vx', 'officer');
  vendor = await regVendor('vone');
  vendor2 = await regVendor('vtwo');

  const t = await api(run, 'POST', '/api/v1/tenders', { token: officer, json: tenderBody(3600_000) });
  assert.equal(t.status, 201, t.text);
  tenderId = t.body.id;
  pdfBytes = await makePdf('Scope of work: supply of 40 servers');
  const up = async (name: string, content: Buffer | string, type: string) => {
    const r = await api(run, 'POST', `/api/v1/tenders/${tenderId}/documents`, { token: officer, form: fileForm({ file: { name, content, type } }) });
    assert.equal(r.status, 201, r.text);
    return r.body.id as string;
  };
  pdfId = await up('pack.pdf', pdfBytes, 'application/pdf');
  pngId = await up('site-plan.png', tinyPng(), 'image/png');
  mdId = await up('annex.md', '# Annex\nText only.', 'text/markdown');
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${tenderId}/approve`, { token: director, json: { reason: 'ok' } })).status, 200);
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${tenderId}/publish`, { token: officer })).body.status, 'PUBLISHED');
});
after(async () => { setClockOffset(0); await run.stop(); });

const grantFor = (token: string, id: string) => api(run, 'POST', `/api/v1/documents/${id}/view-grant`, { token, json: {} });
async function bytes(token: string, id: string, grant?: string) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (grant !== undefined) headers['x-viewer-grant'] = grant;
  const res = await fetch(`${run.base}/api/v1/documents/${id}/view-bytes`, { headers });
  const buf = Buffer.from(await res.arrayBuffer());
  let body: any;
  try { body = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
  return { status: res.status, headers: res.headers, buf, body };
}

test('grant → bytes: watermarked PDF with no-store, inline without file name; DOCUMENT_VIEWED audited', async () => {
  const g = await grantFor(officer, pdfId);
  assert.equal(g.status, 201, g.text);
  assert.match(g.body.grant, /^[A-Za-z0-9_-]{43}$/);
  const ttl = new Date(g.body.expiresAt).getTime() - now().getTime();
  assert.ok(ttl > 55_000 && ttl <= 60_000, `60-second grant (${ttl})`);
  assert.equal(g.body.mimeType, 'application/pdf');
  assert.equal(g.headers.get('cache-control'), 'no-store');
  // Only the hash is stored.
  assert.equal((await run.handle.ctx.db.query('SELECT 1 FROM view_grants WHERE grant_hash=$1', [g.body.grant])).length, 0);

  const r = await bytes(officer, pdfId, g.body.grant);
  assert.equal(r.status, 200, r.body?.message);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.equal(r.headers.get('content-disposition'), 'inline');
  assert.match(r.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(r.headers.get('pragma'), 'no-cache');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal(r.headers.get('x-document-sha256'), null);
  assert.equal(r.buf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(!r.buf.equals(pdfBytes), 'never the stored original');
  const doc = await PDFDocument.load(r.buf);
  assert.equal(doc.getPageCount(), 2);
  const subject = doc.getSubject() ?? '';
  assert.match(subject, /staff officer/, 'user in the watermark');
  assert.match(subject, /entity vw/, 'entity in the watermark');
  assert.match(subject, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/, 'time in the watermark');

  const ev = await run.handle.ctx.db.query<any>(`SELECT actor_id, details FROM audit_events WHERE tenant_id='vw' AND action='DOCUMENT_VIEWED' AND resource_id=$1`, [pdfId]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].details.viewer, 'PDFJS');
  assert.match(subject, new RegExp(ev[0].details.viewId), 'watermark reference = audited view id');
  // The view id is a viewer session: deterrent events can be recorded against it.
  const e = await api(run, 'POST', `/api/v1/security/content/views/${ev[0].details.viewId}/events`, { token: officer, json: { type: 'CONTEXT_MENU' } });
  assert.equal(e.status, 200, e.text);
  assert.equal(e.body.recorded, true);
});

test('grant is single use', async () => {
  const g = await grantFor(officer, pdfId);
  assert.equal((await bytes(officer, pdfId, g.body.grant)).status, 200);
  const again = await bytes(officer, pdfId, g.body.grant);
  assert.equal(again.status, 410);
  assert.equal(again.body.code, 'VIEW_GRANT_USED');
});

test('grant expires after 60 seconds', async () => {
  const g = await grantFor(officer, pdfId);
  try {
    setClockOffset(61_000);
    const r = await bytes(officer, pdfId, g.body.grant);
    assert.equal(r.status, 410);
    assert.equal(r.body.code, 'VIEW_GRANT_EXPIRED');
  } finally { setClockOffset(0); }
});

test('grant is bound to the user and the document; missing / garbage grant refused; another user cannot consume it', async () => {
  const g = await grantFor(officer, pdfId);
  for (const [tok, id, grant] of [[director, pdfId, g.body.grant], [officer, pngId, g.body.grant], [officer, pdfId, undefined], [officer, pdfId, 'x'.repeat(43)], [officer, pdfId, 'bad grant!']] as const) {
    const r = await bytes(tok, id, grant);
    assert.equal(r.status, 403, `${id} ${grant}`);
    assert.equal(r.body.code, 'VIEW_GRANT_INVALID');
  }
  const other = await bytes(otherEntity, pdfId, g.body.grant);
  assert.ok([403, 404].includes(other.status), 'another entity: refused');
  // Unaffected by the refused attempts: the owner can still use it once.
  assert.equal((await bytes(officer, pdfId, g.body.grant)).status, 200);
  // No token at all.
  assert.equal((await fetch(`${run.base}/api/v1/documents/${pdfId}/view-bytes`, { headers: { 'x-viewer-grant': g.body.grant } })).status, 401);
  assert.equal((await api(run, 'POST', `/api/v1/documents/${pdfId}/view-grant`, { json: {} })).status, 401);
});

test('read rules: other entity 404; unsupported format 415; images become a stamped one-page PDF', async () => {
  assert.equal((await grantFor(otherEntity, pdfId)).status, 404);
  const md = await grantFor(officer, mdId);
  assert.equal(md.status, 415);
  assert.equal(md.body.code, 'VIEWER_FORMAT_UNSUPPORTED');
  const g = await grantFor(officer, pngId);
  assert.equal(g.status, 201, g.text);
  const r = await bytes(officer, pngId, g.body.grant);
  assert.equal(r.status, 200);
  const doc = await PDFDocument.load(r.buf);
  assert.equal(doc.getPageCount(), 1);
  assert.match(doc.getSubject() ?? '', /staff officer/);
});

test('entity policy VIEW_ONLY: vendor original download refused, viewer allowed (download NONE) with the vendor identity stamped', async () => {
  const set = await api(run, 'PUT', '/api/v1/security/settings', { token: admin, json: { contentProtection: 'VIEW_ONLY' } });
  assert.equal(set.status, 200, set.text);
  try {
    const orig = await api(run, 'GET', `/api/v1/documents/${pdfId}`, { token: vendor });
    assert.equal(orig.status, 403);
    assert.equal(orig.body.code, 'CONTENT_PROTECTED');
    const g = await grantFor(vendor, pdfId);
    assert.equal(g.status, 201, g.text);
    assert.equal(g.body.mode, 'VIEW_ONLY');
    assert.equal(g.body.download, 'NONE');
    const r = await bytes(vendor, pdfId, g.body.grant);
    assert.equal(r.status, 200);
    const subject = (await PDFDocument.load(r.buf)).getSubject() ?? '';
    assert.match(subject, /vone Trading \(fictitious\)/);
    assert.match(subject, /user vone/);
    // Staff are not restricted by the vendor policy.
    assert.equal((await grantFor(officer, pdfId)).body.download, 'ORIGINAL');
  } finally {
    await api(run, 'PUT', '/api/v1/security/settings', { token: admin, json: { contentProtection: null } });
  }
});

test('sealed bids stay sealed in the viewer; after the opening ceremony the committee can view them', async () => {
  const tech = await makePdf('Technical proposal of vone (fictitious)');
  const form = fileForm({ technical: { name: 'technical.pdf', content: tech, type: 'application/pdf' }, financial: { name: 'financial.txt', content: 'price 100' } });
  const b = await api(run, 'POST', `/api/v1/tenders/${tenderId}/bids`, { token: vendor, form });
  assert.equal(b.status, 201, b.text);
  const own = await api(run, 'GET', `/api/v1/tenders/${tenderId}/bids`, { token: vendor });
  const techDocId = own.body[0].files.find((f: any) => f.type === 'BID_TECHNICAL').documentId;

  const sealed = await grantFor(chair, techDocId);
  assert.equal(sealed.status, 403);
  assert.equal(sealed.body.code, 'BID_SEALED');
  assert.equal((await grantFor(evaluator, techDocId)).status, 403);
  assert.equal((await grantFor(officer, techDocId)).status, 403, 'officer is not a bid reader');
  assert.equal((await grantFor(vendor2, techDocId)).status, 404, 'competitor sees nothing');
  assert.equal((await grantFor(otherEntity, techDocId)).status, 404);
  const mine = await grantFor(vendor, techDocId);
  assert.equal(mine.status, 201, 'the bidder may view its own submission');

  // A grant obtained by the owner cannot be used by the chair to read the sealed bid.
  const steal = await bytes(chair, techDocId, mine.body.grant);
  assert.equal(steal.status, 403);

  try {
    setClockOffset(3600_000 + 60_000); // past the deadline
    const opened = await api(run, 'POST', `/api/v1/tenders/${tenderId}/open`, { token: chair, json: { attendees: ['Chair (test)'] } });
    assert.equal(opened.status, 200, opened.text);
    const g = await grantFor(chair, techDocId);
    assert.equal(g.status, 201, g.text);
    const r = await bytes(chair, techDocId, g.body.grant);
    assert.equal(r.status, 200);
    assert.match((await PDFDocument.load(r.buf)).getSubject() ?? '', /staff chair/);
    const ev = await run.handle.ctx.db.query<any>(`SELECT details FROM audit_events WHERE tenant_id='vw' AND action='DOCUMENT_VIEWED' AND resource_id=$1`, [techDocId]);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].details.ownerType, 'BID_TECHNICAL');
    assert.ok(ev[0].details.bidId);
  } finally { setClockOffset(0); }
  assert.equal((await verifyAudit(run.handle.ctx.db, run.handle.ctx.config.auditSigningKey, 'vw')).valid, true);
});
