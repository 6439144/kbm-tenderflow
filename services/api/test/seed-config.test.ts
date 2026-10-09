import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { api, login, startApp, walk, BID_MASTER_KEY, AUDIT_SIGNING_KEY } from './helpers.js';
import { loadConfig, ConfigError } from '../src/config.js';
import { extractText } from '../src/content/extract.js';

test('config fails fast naming missing variables', () => {
  assert.throws(() => loadConfig({}), (e: unknown) => e instanceof ConfigError && /BID_MASTER_KEY/.test(e.message) && /AUDIT_SIGNING_KEY/.test(e.message));
  assert.throws(() => loadConfig({ BID_MASTER_KEY: Buffer.alloc(16).toString('base64'), AUDIT_SIGNING_KEY: AUDIT_SIGNING_KEY }), /32 bytes/);
  assert.throws(() => loadConfig({ BID_MASTER_KEY, AUDIT_SIGNING_KEY, SEED_DEMO: 'true' }), /DEMO_PASSWORD/);
  assert.equal(loadConfig({ BID_MASTER_KEY, AUDIT_SIGNING_KEY }).contentStoreType, 'filesystem');
});

test('text extraction splits markdown packs by numbered headings', async () => {
  const buf = fs.readFileSync(path.resolve(import.meta.dirname, '../../../seed/files/kea-it-rfp-pack.md'));
  const d = await extractText({ documentId: 'x', title: 'pack', mimeType: 'text/markdown' }, buf);
  const names = d.sections.map((s) => s.section);
  assert.ok(names.some((n) => /Required documents/.test(n)), names.join(' | '));
  assert.ok(d.sections.find((s) => /Required documents/.test(s.section))!.text.includes('ISO/IEC 27001'));
});

function minimalPdf(pages: string[]): Buffer {
  const objs: string[] = [];
  const n = pages.length;
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${n} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((p, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${p}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('PDF extraction yields one section per page', async () => {
  const d = await extractText({ documentId: 'p', title: 'pdf', mimeType: 'application/pdf' }, minimalPdf(['Scope of work page one', 'Evaluation criteria page two']));
  assert.deepEqual(d.sections.map((s) => s.section), ['page 1', 'page 2']);
  assert.match(d.sections[1].text, /Evaluation criteria/);
});

test('serves the built web app with SPA fallback, API 404s stay JSON', async () => {
  const web = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-web-'));
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>TF</title><div id=root></div>');
  const run = await startApp(undefined, { WEB_DIST_DIR: web });
  try {
    const page = await api(run, 'GET', '/procurement/tenders/123');
    assert.equal(page.status, 200);
    assert.match(page.text, /id=root/);
    const missing = await api(run, 'GET', '/api/v1/does-not-exist');
    assert.equal(missing.status, 401, 'unknown API routes are behind auth, never the SPA');
    assert.equal(missing.body.code, 'UNAUTHORIZED');
  } finally { await run.stop(); }
});

test('demo seed runs through the real services (SEED_DEMO=true)', async () => {
  const run = await startApp(undefined, { SEED_DEMO: 'true', DEMO_PASSWORD: 'Demo-Passw0rd!' });
  try {
    const tenants = await api(run, 'GET', '/api/v1/public/tenants');
    assert.deepEqual(tenants.body.map((t: any) => t.id), ['gcia', 'kea']);
    const officer = await login(run, 'kea', 'officer', 'Demo-Passw0rd!');
    const list = await api(run, 'GET', '/api/v1/tenders', { token: officer });
    const byNum = Object.fromEntries(list.body.map((t: any) => [t.tenderNumber, t]));
    assert.equal(byNum['KEA-2026-101'].status, 'DRAFT');
    assert.equal(byNum['KEA-2026-102'].status, 'PUBLISHED');
    assert.equal(byNum['KEA-2026-088'].status, 'CLOSED');
    const pub = await api(run, 'GET', `/api/v1/tenders/${byNum['KEA-2026-102'].id}`, { token: officer });
    assert.equal(pub.body.clarifications.length, 2);
    const bids = await api(run, 'GET', `/api/v1/tenders/${byNum['KEA-2026-088'].id}/bids`, { token: officer });
    assert.equal(bids.body.length, 3);
    assert.ok(bids.body.every((b: any) => b.status === 'SEALED'));
    // sealed bid files really encrypted in the store
    const enc = walk(path.join(run.dataDir, 'content')).filter((f) => f.endsWith('.enc'));
    assert.equal(enc.length, 10); // kea: 3 bids x 2 files, gcia: 2 bids x 2 files
    assert.ok(enc.every((f) => !fs.readFileSync(f).includes(Buffer.from('Technical Proposal'))));
    // vendor4 pending → sees nothing; vendor1 approved → sees published + closed IT tenders
    const v4 = await api(run, 'GET', '/api/v1/tenders', { token: await login(run, 'kea', 'vendor4', 'Demo-Passw0rd!') });
    assert.equal(v4.body.length, 0);
    const v1 = await api(run, 'GET', '/api/v1/tenders', { token: await login(run, 'kea', 'vendor1', 'Demo-Passw0rd!') });
    assert.equal(v1.body.length, 2);
    // the closed demo tender can be opened by the chair right away
    const chair = await login(run, 'kea', 'chair', 'Demo-Passw0rd!');
    const opened = await api(run, 'POST', `/api/v1/tenders/${byNum['KEA-2026-088'].id}/open`, { token: chair, json: { attendees: ['Chair'] } });
    assert.equal(opened.status, 200, opened.text);
    assert.ok(opened.body.bids.every((b: any) => b.integrity === 'VERIFIED'));
    const auditor = await login(run, 'kea', 'auditor', 'Demo-Passw0rd!');
    assert.equal((await api(run, 'GET', '/api/v1/audit/verify', { token: auditor })).body.valid, true);
  } finally {
    await run.stop();
  }
});
