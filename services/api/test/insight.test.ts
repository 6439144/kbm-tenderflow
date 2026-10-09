// Insight workstream: role dashboards, analytics, auditor evidence pack (contents, hashes, access, sealed bids) and the
// public tender board (only published tenders of entities on the board; no private fields). Runs on the demo seed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { api, login, makeTenant, makeUser, startApp, tenderBody, fileForm, PASSWORD, type Running } from './helpers.js';
import { buildZip, readZip } from '../src/features/insight/zip.js';
import { quantile, summarise } from '../src/features/insight/analytics.js';
import { publicBoardEnabled } from '../src/features/insight/public-board.js';

const DEMO_PASSWORD = 'Demo-Passw0rd!';
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let run: Running;
const tok: Record<string, string> = {};
const T = async (tenant: string, user: string) => (tok[`${tenant}/${user}`] ??= await login(run, tenant, user, DEMO_PASSWORD));
const tenderByNumber = async (tenant: string, num: string) => {
  const r = await api(run, 'GET', '/api/v1/tenders', { token: await T(tenant, 'officer') });
  const x = r.body.find((t: any) => t.tenderNumber === num);
  assert.ok(x, `${num} not found`);
  return x;
};
async function getBytes(path: string, token: string) {
  const res = await fetch(run.base + path, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
}

before(async () => {
  run = await startApp(undefined, { SEED_DEMO: 'true', DEMO_PASSWORD });
});
after(async () => { await run?.stop(); });

test('zip writer/reader round trip and quantiles', () => {
  const big = Buffer.from('تجربة '.repeat(5000), 'utf8');
  const z = buildZip([{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'dir/ملف.md', data: big }, { name: 'empty', data: Buffer.alloc(0) }]);
  const m = readZip(z);
  assert.equal(m.get('a.txt')!.toString(), 'hello');
  assert.ok(m.get('dir/ملف.md')!.equals(big));
  assert.equal(m.get('empty')!.length, 0);
  assert.throws(() => buildZip([{ name: '../x', data: Buffer.alloc(1) }]));
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(Math.round(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)! * 100) / 100, 9.1);
  assert.deepEqual(summarise([]).n, 0);
  assert.equal(publicBoardEnabled({}), true);
  assert.equal(publicBoardEnabled({ publicBoard: false }), false);
  assert.equal(publicBoardEnabled({ publicBoard: 'false' }), false);
  assert.equal(publicBoardEnabled(null), true);
});

test('evidence pack before opening: contents, hashes, audit chain, sealed bids excluded, stored + audited', async () => {
  const auditor = await T('kea', 'auditor');
  const t = await tenderByNumber('kea', 'KEA-2026-088');
  assert.equal(t.status, 'CLOSED');
  const res = await api(run, 'POST', '/api/v1/audit/evidence-pack', { token: auditor, json: { tenderId: t.id } });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.tenderNumber, 'KEA-2026-088');
  assert.equal(res.body.storeType, 'filesystem');
  assert.equal(res.body.auditChain.valid, true);
  assert.equal(res.body.summary.sealedBidDocumentsExcluded, 6); // 3 bids × (technical + financial)

  const dl = await getBytes(res.body.downloadUrl, auditor);
  assert.equal(dl.status, 200);
  assert.equal(sha(dl.buf), res.body.sha256, 'downloaded pack = stored pack');
  assert.equal(dl.headers.get('x-document-sha256'), res.body.sha256);
  const files = readZip(dl.buf);
  for (const f of ['manifest.json', 'audit-events.json', 'approvals.json', 'tender.json', 'README.txt', 'SHA256SUMS']) assert.ok(files.has(f), `missing ${f}`);
  assert.ok(![...files.keys()].some((k) => k.startsWith('bids/')), 'no bid documents before the opening');

  // SHA256SUMS covers every other file and matches
  const sums = files.get('SHA256SUMS')!.toString().trim().split('\n').map((l) => l.split(/\s{2}/));
  assert.equal(sums.length, files.size - 1);
  for (const [h, p] of sums) assert.equal(sha(files.get(p)!), h, `hash of ${p}`);

  const manifest = JSON.parse(files.get('manifest.json')!.toString());
  assert.equal(manifest.format, 'tenderflow-evidence-pack/1');
  assert.equal(manifest.scope.tenderNumber, 'KEA-2026-088');
  assert.equal(manifest.entity.id, 'kea');
  assert.equal(manifest.generatedBy.username, 'auditor');
  const pack = manifest.documents.filter((d: any) => d.ownerType === 'TENDER_PACK');
  assert.equal(pack.length, 2);
  for (const d of pack) {
    assert.equal(d.included, true);
    assert.equal(sha(files.get(d.path)!), d.sha256, 'document bytes match the hash recorded at upload');
    assert.ok(d.storeRef);
    assert.equal(d.integrity, 'VERIFIED');
  }
  const bidDocs = manifest.documents.filter((d: any) => d.ownerType.startsWith('BID_'));
  assert.equal(bidDocs.length, 6);
  for (const d of bidDocs) { assert.equal(d.included, false); assert.equal(d.exclusionReason, 'SEALED_UNTIL_OPENING'); assert.equal(d.path, null); }
  // the GM request letter is not linked to this tender; nothing else is invented
  assert.ok(manifest.documents.every((d: any) => d.ownerType !== 'EVIDENCE_PACK'));

  const audit = JSON.parse(files.get('audit-events.json')!.toString());
  assert.equal(audit.chainVerification.valid, true);
  const actions = audit.events.map((e: any) => e.action);
  for (const a of ['TENDER_CREATED', 'TENDER_DOCUMENT_UPLOADED', 'TENDER_APPROVED', 'TENDER_PUBLISHED', 'BID_SUBMITTED', 'TENDER_CLOSED']) assert.ok(actions.includes(a), `slice has ${a}`);
  assert.ok(audit.events.every((e: any) => typeof e.hmac === 'string' && e.hmac.length === 64));
  const approvals = JSON.parse(files.get('approvals.json')!.toString());
  assert.ok(approvals.decisions.some((d: any) => d.gate === 'PUBLISH' && d.decision === 'APPROVED'));
  const tender = JSON.parse(files.get('tender.json')!.toString());
  assert.equal(tender.bids.length, 3);
  assert.ok(tender.bids.every((b: any) => b.status === 'SEALED' && /^[0-9a-f]{64}$/.test(b.receiptSha256)));
  // never any key material
  const allText = [...files.entries()].filter(([k]) => k.endsWith('.json')).map(([, v]) => v.toString()).join('\n');
  assert.doesNotMatch(allText, /wrapped_?key|wrappedKey|wrap_?iv|wrapIv|wrap_?tag|enc_?iv|encIv|BID_MASTER_KEY/i);

  // audited, listed, chain still valid
  const ev = await api(run, 'GET', `/api/v1/audit?resourceId=${t.id}&limit=5`, { token: auditor });
  const gen = ev.body.find((e: any) => e.action === 'EVIDENCE_PACK_GENERATED');
  assert.ok(gen, 'EVIDENCE_PACK_GENERATED audited');
  assert.equal(gen.details.sha256, res.body.sha256);
  assert.equal(gen.details.documentId, res.body.documentId);
  const list = await api(run, 'GET', '/api/v1/audit/evidence-packs', { token: auditor });
  assert.equal(list.status, 200);
  assert.ok(list.body.some((p: any) => p.documentId === res.body.documentId && p.tenderNumber === 'KEA-2026-088'));
  const v = await api(run, 'GET', '/api/v1/audit/verify', { token: auditor });
  assert.equal(v.body.valid, true);
  // the generic document route never serves an evidence pack
  assert.equal((await api(run, 'GET', `/api/v1/documents/${res.body.documentId}`, { token: await T('kea', 'officer') })).status, 404);
});

test('evidence pack access rules', async () => {
  const t = await tenderByNumber('kea', 'KEA-2026-088');
  for (const u of ['officer', 'director', 'chair', 'vendor1']) {
    const r = await api(run, 'POST', '/api/v1/audit/evidence-pack', { token: await T('kea', u), json: { tenderId: t.id } });
    assert.equal(r.status, 403, `${u}: ${r.text}`);
  }
  const admin = await api(run, 'POST', '/api/v1/audit/evidence-pack', { token: await T('kea', 'admin'), json: { tenderId: t.id } });
  assert.equal(admin.status, 201, admin.text);
  // other entity: tender and pack are not found
  const other = await T('gcia', 'auditor');
  assert.equal((await api(run, 'POST', '/api/v1/audit/evidence-pack', { token: other, json: { tenderId: t.id } })).status, 404);
  assert.equal((await getBytes(admin.body.downloadUrl, other)).status, 404);
  assert.equal((await getBytes(admin.body.downloadUrl, await T('kea', 'officer'))).status, 403);
  assert.equal((await api(run, 'GET', '/api/v1/audit/evidence-packs', { token: other })).body.length, 0);
  assert.equal((await api(run, 'POST', '/api/v1/audit/evidence-pack', { token: other, json: {} })).status, 400);
  assert.equal((await api(run, 'POST', '/api/v1/audit/evidence-pack', { token: other, json: { from: '2026-02-01', to: '2025-01-01' } })).status, 400);
});

test('evidence pack after opening includes the opened bids (two-envelope: financial stays sealed)', async () => {
  // one envelope: KEA-2026-088
  const t = await tenderByNumber('kea', 'KEA-2026-088');
  const open = await api(run, 'POST', `/api/v1/tenders/${t.id}/open`, { token: await T('kea', 'chair'), json: { attendees: ['Chair', 'Auditor'] } });
  assert.equal(open.status, 200, open.text);
  const res = await api(run, 'POST', '/api/v1/audit/evidence-pack', { token: await T('kea', 'auditor'), json: { tenderId: t.id } });
  assert.equal(res.status, 201, res.text);
  const files = readZip((await getBytes(res.body.downloadUrl, await T('kea', 'auditor'))).buf);
  const manifest = JSON.parse(files.get('manifest.json')!.toString());
  const bidDocs = manifest.documents.filter((d: any) => d.ownerType.startsWith('BID_'));
  assert.equal(bidDocs.length, 6);
  for (const d of bidDocs) {
    assert.equal(d.included, true, d.exclusionReason);
    assert.ok(d.path.startsWith('bids/'));
    assert.equal(sha(files.get(d.path)!), d.sha256, 'decrypted bid matches the hash in the vendor receipt');
    assert.equal(d.encryptedAtRest, true);
  }
  const rec = manifest.documents.find((d: any) => d.ownerType === 'OPENING_RECORD');
  assert.ok(rec?.included && files.has(rec.path), 'opening record included');

  // two envelopes: gcia Marine Jetty (CLOSED, 2 bids)
  const j = await tenderByNumber('gcia', (await api(run, 'GET', '/api/v1/tenders?status=CLOSED', { token: await T('gcia', 'officer') })).body[0].tenderNumber);
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${j.id}/open`, { token: await T('gcia', 'chair'), json: { attendees: ['Chair'] } })).status, 200);
  const r2 = await api(run, 'POST', '/api/v1/audit/evidence-pack', { token: await T('gcia', 'auditor'), json: { tenderId: j.id } });
  assert.equal(r2.status, 201, r2.text);
  const f2 = readZip((await getBytes(r2.body.downloadUrl, await T('gcia', 'auditor'))).buf);
  const m2 = JSON.parse(f2.get('manifest.json')!.toString());
  const tech = m2.documents.filter((d: any) => d.ownerType === 'BID_TECHNICAL');
  const fin = m2.documents.filter((d: any) => d.ownerType === 'BID_FINANCIAL');
  assert.equal(tech.length, 2); assert.equal(fin.length, 2);
  assert.ok(tech.every((d: any) => d.included && sha(f2.get(d.path)!) === d.sha256));
  assert.ok(fin.every((d: any) => !d.included && d.exclusionReason === 'FINANCIAL_ENVELOPE_SEALED'));
  const purchases = JSON.parse(f2.get('tender.json')!.toString()).purchases;
  assert.ok(purchases.length >= 2 && purchases.every((p: any) => p.gateway === 'TEST' && p.testPayment === true));
});

test('evidence pack for a date range', async () => {
  const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  const r = await api(run, 'POST', '/api/v1/audit/evidence-pack', { token: await T('kea', 'auditor'), json: { from: today, to: today } });
  assert.equal(r.status, 201, r.text);
  const files = readZip((await getBytes(r.body.downloadUrl, await T('kea', 'auditor'))).buf);
  const m = JSON.parse(files.get('manifest.json')!.toString());
  assert.equal(m.scope.type, 'RANGE');
  assert.ok(m.scope.tenders.includes('KEA-2026-102'));
  assert.ok(files.has('tenders.json'));
  assert.ok(m.documents.every((d: any) => d.tenderId === null || typeof d.tenderId === 'string'));
  for (const d of m.documents.filter((x: any) => x.included)) assert.equal(sha(files.get(d.path)!), d.sha256);
});

test('role dashboards: one section per role, tenant-scoped, real numbers', async () => {
  const off = await api(run, 'GET', '/api/v1/insight/dashboard', { token: await T('kea', 'officer') });
  assert.equal(off.status, 200, off.text);
  assert.ok(off.body.officer && !off.body.auditor && !off.body.admin && !off.body.vendor && !off.body.approver);
  assert.ok(off.body.officer.myDrafts.some((d: any) => d.tenderNumber === 'KEA-2026-101'));
  assert.equal(off.body.officer.clarificationsWaiting.total, 1);
  assert.ok(off.body.officer.upcomingDeadlines.some((d: any) => d.tenderNumber === 'KEA-2026-102'));

  const aud = await api(run, 'GET', '/api/v1/insight/dashboard', { token: await T('kea', 'auditor') });
  assert.equal(aud.body.auditor.auditChain.valid, true);
  assert.equal(aud.body.auditor.eventsPerDay.length, 30);
  assert.ok(aud.body.auditor.eventsPerDay.reduce((a: number, d: any) => a + d.count, 0) > 0);
  assert.ok(aud.body.auditor.evidencePacks.length >= 1);
  assert.ok(!aud.body.officer);

  const gu = await api(run, 'GET', '/api/v1/insight/dashboard', { token: await T('gcia', 'undersecretary') });
  assert.ok(gu.body.approver.waiting.some((w: any) => w.kind === 'TENDER' && w.titleEn === 'Coastal Road Drainage Upgrade' && w.level === 2 && w.of === 2));
  const gd = await api(run, 'GET', '/api/v1/insight/dashboard', { token: await T('gcia', 'director') });
  assert.ok(!gd.body.approver.waiting.some((w: any) => w.titleEn === 'Coastal Road Drainage Upgrade'), 'level 2 is not the director\'s');
  assert.ok(gd.body.approver.publishedThisMonth.count >= 2);

  const kd = await api(run, 'GET', '/api/v1/insight/dashboard', { token: await T('kea', 'director') });
  assert.ok(kd.body.approver.waiting.some((w: any) => w.number === 'KEA-2026-101' && w.level === 1), 'draft with pack waits for the director');

  const adm = await api(run, 'GET', '/api/v1/insight/dashboard', { token: await T('kea', 'admin') });
  assert.ok(adm.body.admin.usersByRole.some((r: any) => r.role === 'VENDOR' && r.active === 4));
  assert.equal(adm.body.admin.fileNet.storeType, 'filesystem');
  assert.equal(adm.body.admin.orchestrate.configured, false);
  assert.ok(adm.body.admin.templates.length >= 1);

  const ven = await api(run, 'GET', '/api/v1/insight/dashboard', { token: await T('kea', 'vendor1') });
  assert.ok(ven.body.vendor && !ven.body.officer);
  assert.ok(ven.body.vendor.eligibleOpenTenders.some((x: any) => x.tenderNumber === 'KEA-2026-102' && x.eligible));
  assert.ok(ven.body.vendor.bids.some((b: any) => b.tenderNumber === 'KEA-2026-088'));
  const gv = await api(run, 'GET', '/api/v1/insight/dashboard', { token: await T('gcia', 'vendor1') });
  assert.ok(gv.body.vendor.purchases.every((p: any) => p.testPayment === true && p.gateway === 'TEST'));
  assert.ok(gv.body.vendor.purchases.length >= 2);
  const gv3 = await api(run, 'GET', '/api/v1/insight/dashboard', { token: await T('gcia', 'vendor3') });
  assert.ok(gv3.body.vendor.eligibleOpenTenders.every((x: any) => x.eligible === false), 'Third grade is not eligible in gcia');

  const chair = await api(run, 'GET', '/api/v1/insight/dashboard', { token: await T('kea', 'chair') });
  assert.ok(Array.isArray(chair.body.committee.openingsDue));
  assert.ok(chair.body.committee.evaluations.some((e: any) => e.tenderNumber === 'KEA-2026-088' && e.openedBids === 3));
  const ev1 = await api(run, 'GET', '/api/v1/insight/dashboard', { token: await T('kea', 'evaluator1') });
  assert.equal(ev1.body.committee.openingsDue, null);
  assert.equal(ev1.body.committee.myScoring.remaining, 3);
});

test('analytics: roles, cycle times from the audit log, revenue labelled TEST, date range validation', async () => {
  assert.equal((await api(run, 'GET', '/api/v1/insight/analytics', { token: await T('kea', 'officer') })).status, 403);
  assert.equal((await api(run, 'GET', '/api/v1/insight/analytics', { token: await T('kea', 'vendor1') })).status, 403);
  const a = await api(run, 'GET', '/api/v1/insight/analytics', { token: await T('kea', 'director') });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.body.cycleTimes.length, 5);
  const ca = a.body.cycleTimes.find((c: any) => c.stage === 'CREATED_TO_APPROVED');
  assert.equal(ca.n, 2); // KEA-2026-102 and KEA-2026-088
  assert.ok(ca.medianDays >= 0 && ca.p90Days >= ca.medianDays);
  assert.equal(a.body.cycleTimes.find((c: any) => c.stage === 'OPENED_TO_AWARDED').n, 0);
  assert.ok(a.body.tendersByStatus.some((s: any) => s.status === 'DRAFT' && s.count === 1));
  assert.equal(a.body.participation.summary.tenders, 2);
  assert.equal(a.body.participation.summary.uniqueBidders, 3);
  assert.equal(a.body.participation.funnel.purchased, null, 'KEA cycle has no document purchase');
  assert.ok(a.body.approvalTurnaround.some((x: any) => x.gate === 'PUBLISH' && x.level === 1 && x.n === 2));
  assert.deepEqual(a.body.revenue, []);

  const g = await api(run, 'GET', '/api/v1/insight/analytics', { token: await T('gcia', 'auditor') });
  assert.equal(g.status, 200);
  const rev = g.body.revenue.find((r: any) => r.gateway === 'TEST');
  assert.equal(rev.testPayment, true);
  assert.equal(rev.purchases, 3);
  assert.equal(rev.amount, 150);
  assert.ok(g.body.approvalTurnaround.some((x: any) => x.gate === 'PUBLISH' && x.level === 2 && x.role === 'UNDERSECRETARY'));
  assert.equal(g.body.participation.funnel.purchased, 3);

  const past = await api(run, 'GET', '/api/v1/insight/analytics?from=2020-01-01&to=2020-12-31', { token: await T('kea', 'admin') });
  assert.equal(past.status, 200);
  assert.equal(past.body.participation.summary.tenders, 0);
  assert.ok(past.body.cycleTimes.every((c: any) => c.n === 0 && c.medianDays === null));
  assert.equal((await api(run, 'GET', '/api/v1/insight/analytics?from=yesterday', { token: await T('kea', 'admin') })).status, 400);
});

test('public board: only PUBLISHED tenders of entities on the board, only public fields, feeds, filters', async () => {
  // a third entity with the board on but nothing published, and a published tender in an entity with the board OFF
  await makeTenant(run, 'priv');
  await run.handle.ctx.db.query(`UPDATE tenants SET profile='{"publicBoard": false}'::jsonb WHERE id='priv'`);
  await makeUser(run, 'priv', 'officer', ['PROCUREMENT_OFFICER']);
  await makeUser(run, 'priv', 'director', ['DIRECTOR']);
  const po = await login(run, 'priv', 'officer', PASSWORD);
  const pd = await login(run, 'priv', 'director', PASSWORD);
  const pt = await api(run, 'POST', '/api/v1/tenders', { token: po, json: tenderBody(3 * 86_400_000, { tenderNumber: 'PRIV-SECRET-1', titleEn: 'Secret works' }) });
  await api(run, 'POST', `/api/v1/tenders/${pt.body.id}/documents`, { token: po, form: fileForm({ file: { name: 'pack.txt', content: 'pack' } }) });
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${pt.body.id}/approve`, { token: pd, json: {} })).status, 200);
  assert.equal((await api(run, 'POST', `/api/v1/tenders/${pt.body.id}/publish`, { token: po })).status, 200);

  const r = await api(run, 'GET', '/api/v1/public/tenders');
  assert.equal(r.status, 200, r.text);
  const nums = r.body.tenders.map((t: any) => t.tenderNumber);
  assert.ok(nums.includes('KEA-2026-102'), nums.join());
  assert.ok(r.body.tenders.some((t: any) => t.entity.id === 'gcia' && t.titleEn === 'Fishing Harbour Breakwater Repair'));
  for (const hidden of ['KEA-2026-101', 'KEA-2026-088', 'PRIV-SECRET-1']) assert.ok(!nums.includes(hidden), `${hidden} must not be public`);
  assert.ok(!r.body.tenders.some((t: any) => t.titleEn === 'Coastal Road Drainage Upgrade' || t.titleEn === 'Marine Jetty Rehabilitation'));
  assert.ok(!r.body.entities.some((e: any) => e.id === 'priv'));
  // only public fields
  const allowed = new Set(['entity', 'tenderNumber', 'titleEn', 'titleAr', 'category', 'activityCodes', 'submissionDeadline', 'publishedAt', 'documentPrice', 'publications', 'url']);
  for (const t of r.body.tenders) assert.deepEqual(Object.keys(t).filter((k) => !allowed.has(k)), []);
  assert.doesNotMatch(r.text, UUID_RE, 'no internal ids');
  assert.doesNotMatch(r.text, /description|budget|vendor|bid|receipt|storeRef|sha256|createdBy/i);
  const br = r.body.tenders.find((t: any) => t.titleEn === 'Fishing Harbour Breakwater Repair');
  assert.deepEqual(br.documentPrice, { amount: 50, currency: 'KWD' });
  assert.ok(br.activityCodes.some((a: any) => a.code === 'ENG-01' && a.nameEn === 'Civil works'));
  assert.equal(r.body.tenders.find((t: any) => t.tenderNumber === 'KEA-2026-102').documentPrice, null);

  // filters
  const fe = await api(run, 'GET', '/api/v1/public/tenders?entity=gcia');
  assert.ok(fe.body.tenders.length >= 1 && fe.body.tenders.every((t: any) => t.entity.id === 'gcia'));
  const fa = await api(run, 'GET', '/api/v1/public/tenders?activity=IT-01');
  assert.deepEqual(fa.body.tenders.map((t: any) => t.tenderNumber), ['KEA-2026-102']);
  const fq = await api(run, 'GET', `/api/v1/public/tenders?q=${encodeURIComponent('الوثائق')}`);
  assert.deepEqual(fq.body.tenders.map((t: any) => t.tenderNumber), ['KEA-2026-102']);
  assert.equal((await api(run, 'GET', '/api/v1/public/tenders?entity=priv')).body.tenders.length, 0);
  assert.equal((await api(run, 'GET', `/api/v1/public/tenders?q=${encodeURIComponent('%')}`)).body.tenders.length, 0);

  // RSS + JSON feed
  const rss = await api(run, 'GET', '/api/v1/public/tenders.rss');
  assert.equal(rss.status, 200);
  assert.match(rss.headers.get('content-type') ?? '', /application\/rss\+xml/);
  assert.match(rss.text, /^<\?xml version="1.0" encoding="UTF-8"\?>\s*<rss version="2.0"/);
  assert.ok(rss.text.includes('KEA-2026-102'));
  assert.ok(!rss.text.includes('KEA-2026-101') && !rss.text.includes('PRIV-SECRET-1'));
  assert.doesNotMatch(rss.text, UUID_RE);
  const jf = await api(run, 'GET', '/api/v1/public/tenders.json');
  assert.equal(jf.status, 200);
  assert.equal(jf.body.version, 'https://jsonfeed.org/version/1.1');
  assert.ok(jf.body.items.some((i: any) => i.id === 'tenderflow:kea:KEA-2026-102'));

  // entity admin turns the board off; a later profile save without the field keeps it off
  const admin = await T('kea', 'admin');
  const prof = (await api(run, 'GET', '/api/v1/entity/profile', { token: admin })).body;
  const off = await api(run, 'PUT', '/api/v1/entity/profile', { token: admin, json: { ...prof, publicBoard: false } });
  assert.equal(off.status, 200, off.text);
  assert.equal(off.body.publicBoard, false);
  const again = await api(run, 'PUT', '/api/v1/entity/profile', { token: admin, json: { nameEn: prof.nameEn, nameAr: prof.nameAr } });
  assert.equal(again.body.publicBoard, false, 'a save without publicBoard keeps the current setting');
  const r2 = await api(run, 'GET', '/api/v1/public/tenders');
  assert.ok(!r2.body.tenders.some((t: any) => t.entity.id === 'kea'));
  assert.ok(r2.body.tenders.some((t: any) => t.entity.id === 'gcia'));
  assert.equal((await api(run, 'PUT', '/api/v1/entity/profile', { token: admin, json: { ...prof, publicBoard: true } })).body.publicBoard, true);
  assert.ok((await api(run, 'GET', '/api/v1/public/tenders')).body.tenders.some((t: any) => t.entity.id === 'kea'));
});

test('public board is rate-limited', async () => {
  const r2 = await startApp(undefined, { PUBLIC_BOARD_RATE_LIMIT_PER_MIN: '2' });
  try {
    assert.equal((await api(r2, 'GET', '/api/v1/public/tenders')).status, 200);
    assert.equal((await api(r2, 'GET', '/api/v1/public/tenders.rss')).status, 200);
    const third = await api(r2, 'GET', '/api/v1/public/tenders');
    assert.equal(third.status, 429);
    assert.equal(third.body.code, 'RATE_LIMITED');
  } finally { await r2.stop(); }
});
