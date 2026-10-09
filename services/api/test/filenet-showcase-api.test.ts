// FileNet showcase, API level (real app, filesystem store, demo seed): evidence route access rules,
// evidence content (version chain, sealed-bid note, repository description) and the FileNet health route.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { api, fileForm, login, startApp, type Running } from './helpers.js';

const DEMO_PASSWORD = 'Demo-Passw0rd!';
let run: Running;
const tok: Record<string, string> = {};
let packDocId: string;
let bid1DocId: string; // vendor1's sealed technical envelope on the CLOSED tender
let evidenceDir: string;

const q = async <T = any>(sql: string, params: unknown[] = []) => run.handle.ctx.db.query<T>(sql, params);

before(async () => {
  run = await startApp(undefined, { SEED_DEMO: 'true', DEMO_PASSWORD });
  for (const u of ['officer', 'chair', 'evaluator1', 'admin', 'auditor', 'vendor1', 'vendor2', 'vendor4']) tok[u] = await login(run, 'kea', u, DEMO_PASSWORD);
  tok.gciaAdmin = await login(run, 'gcia', 'admin', DEMO_PASSWORD);
  packDocId = (await q<{ id: string }>(`SELECT d.id FROM documents d JOIN tenders t ON t.id=d.tender_id
    WHERE t.tenant_id='kea' AND t.tender_number='KEA-2026-102' AND d.owner_type='TENDER_PACK' ORDER BY d.created_at LIMIT 1`))[0].id;
  bid1DocId = (await q<{ id: string }>(`SELECT d.id FROM documents d JOIN bids b ON b.id=d.bid_id JOIN users u ON u.vendor_id=b.vendor_id
    JOIN tenders t ON t.id=b.tender_id WHERE t.tender_number='KEA-2026-088' AND u.tenant_id='kea' AND u.username='vendor1' AND d.owner_type='BID_TECHNICAL'`))[0].id;
  evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-evidence-'));
  process.env.TF_EVIDENCE_DIR = evidenceDir;
});
after(async () => { delete process.env.TF_EVIDENCE_DIR; await run.stop(); });

const evidence = (id: string, who: string) => api(run, 'GET', `/api/v1/documents/${id}/evidence`, { token: tok[who] });

test('evidence of a tender pack document: staff and eligible vendors yes, pending vendor and other tenants no', async () => {
  const r = await evidence(packDocId, 'officer');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.documentId, packDocId);
  assert.equal(r.body.storeType, 'filesystem');
  assert.equal(r.body.objectId, null);
  assert.equal(r.body.navigatorUrl, null);
  assert.equal(r.body.encrypted, false);
  assert.equal(r.body.encryptionNote, null);
  assert.equal(r.body.repository.type, 'filesystem');
  assert.equal(r.body.repository.storedSha256, r.body.sha256, 'plain document: stored bytes hash = document hash');
  assert.match(r.body.folderPath, /^\/kea\/KEA-2026-102\/TENDER_PACK$/);
  assert.equal(r.body.versions.length, 1);
  assert.equal(r.body.versions[0].isThis, true);
  assert.equal(JSON.stringify(r.body.repository).includes(run.dataDir), false, 'no absolute server paths');

  assert.equal((await evidence(packDocId, 'vendor1')).status, 200, 'approved vendor in the category, tender published');
  assert.equal((await evidence(packDocId, 'vendor4')).status, 404, 'pending vendor: same rule as the download route');
  assert.equal((await api(run, 'GET', `/api/v1/documents/${packDocId}/evidence`, { token: tok.gciaAdmin })).status, 404, 'other tenant');
  assert.equal((await api(run, 'GET', `/api/v1/documents/not-a-uuid/evidence`, { token: tok.officer })).status, 404);
  assert.equal((await api(run, 'GET', `/api/v1/documents/${packDocId}/evidence`)).status, 401);
});

test('evidence of a sealed bid document: owner vendor only until opening', async () => {
  const own = await evidence(bid1DocId, 'vendor1');
  assert.equal(own.status, 200, own.text);
  assert.equal(own.body.encrypted, true);
  assert.equal(own.body.encryptionNote, 'ciphertext in FileNet; key held by TenderFlow');
  assert.notEqual(own.body.repository.storedSha256, own.body.sha256, 'the store holds ciphertext, not the plaintext');
  // Another vendor cannot see that this bid document exists.
  assert.equal((await evidence(bid1DocId, 'vendor2')).status, 404);
  // Staff: the committee may not look before the opening; other staff never.
  const chair = await evidence(bid1DocId, 'chair');
  assert.equal(chair.status, 403);
  assert.equal(chair.body.code, 'BID_SEALED');
  assert.equal((await evidence(bid1DocId, 'evaluator1')).status, 403);
  assert.equal((await evidence(bid1DocId, 'officer')).status, 403);
  assert.equal((await evidence(bid1DocId, 'admin')).status, 403);
  // Same answers as the download route.
  const bidId = (await q<{ bid_id: string }>('SELECT bid_id FROM documents WHERE id=$1', [bid1DocId]))[0].bid_id;
  assert.equal((await api(run, 'GET', `/api/v1/bids/${bidId}/documents/${bid1DocId}`, { token: tok.vendor2 })).status, 404);
  assert.equal((await api(run, 'GET', `/api/v1/bids/${bidId}/documents/${bid1DocId}`, { token: tok.chair })).status, 403);
});

test('evidence shows the version chain of an addendum that supersedes a pack document', async () => {
  const tenderId = (await q<{ id: string }>(`SELECT id FROM tenders WHERE tenant_id='kea' AND tender_number='KEA-2026-102'`))[0].id;
  const up = await api(run, 'POST', `/api/v1/tenders/${tenderId}/documents`, { token: tok.officer,
    form: fileForm({ addendum: 'true', supersedesId: packDocId, title: 'Addendum 1', file: { name: 'addendum-1.md', content: '# 1. Change\nDeadline moved.' } }) });
  assert.equal(up.status, 201, up.text);
  assert.equal(up.body.versionNo, 2);
  const r = await evidence(up.body.id, 'officer');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.versionNo, 2);
  assert.equal(r.body.supersedesId, packDocId);
  assert.deepEqual(r.body.versions.map((v: any) => [v.id, v.versionNo, v.isThis, v.isLatest]), [[packDocId, 1, false, false], [up.body.id, 2, true, true]]);
  // Viewed from v1 the chain is the same.
  const r1 = await evidence(packDocId, 'officer');
  assert.deepEqual(r1.body.versions.map((v: any) => v.id), [packDocId, up.body.id]);
  assert.equal(r1.body.versions[0].isThis, true);
  assert.equal(r1.body.repositoryVersioning, false, 'filesystem store: the chain is kept by TenderFlow, not by repository versioning');
});

test('health route: admins and auditors only; reports store, tree, counts, tenant-scoped operations and the verify report', async () => {
  assert.equal((await api(run, 'GET', '/api/v1/filenet/health', { token: tok.officer })).status, 403);
  assert.equal((await api(run, 'GET', '/api/v1/filenet/health', { token: tok.vendor1 })).status, 403);
  fs.writeFileSync(path.join(evidenceDir, 'filenet-verify-2026-10-01T10-00-00-000Z.json'), JSON.stringify({ startedAt: 'old', ok: false, steps: [] }));
  fs.writeFileSync(path.join(evidenceDir, 'filenet-verify-2026-10-08T10-00-00-000Z.json'), JSON.stringify({
    tool: 'verify-filenet', startedAt: '2026-10-08T10:00:00.000Z', finishedAt: '2026-10-08T10:00:09.000Z', ok: true,
    config: { FILENET_OBJECT_STORE: 'OS1', FILENET_SERVICE_PASSWORD: '(set, not shown)' },
    steps: [{ step: 1, name: 'ping object store', ok: true, ms: 120 }], documents: [{ label: 'text', id: '{X}', className: 'Document', version: '1.0', byteSize: 10, sha256: 'ab' }],
  }));

  const r = await api(run, 'GET', '/api/v1/filenet/health', { token: tok.admin });
  assert.equal(r.status, 200, r.text);
  const b = r.body;
  assert.equal(b.storeType, 'filesystem');
  assert.equal(b.config.type, 'filesystem');
  assert.equal(b.ping.ok, true);
  assert.equal(b.tfClass.applicable, false);
  assert.equal(b.folders.root, '/kea');
  assert.ok(b.folders.tree.children.some((c: any) => c.name === 'KEA-2026-102'), JSON.stringify(b.folders.tree));
  assert.ok(b.counts.total > 0);
  assert.ok(b.counts.byOwnerType.some((x: any) => x.ownerType === 'BID_TECHNICAL'));
  assert.ok(b.counts.encrypted > 0);
  assert.ok(b.operations.length > 0 && b.operations.length <= 50);
  assert.ok(b.operations.some((o: any) => o.op === 'put' && o.ok));
  assert.ok(b.operations.every((o: any) => (o.folder ?? '').startsWith('/kea/') || (o.ref ?? '').startsWith('kea/')), 'only this tenant\'s operations');
  assert.equal(b.verifyReport.file, 'filenet-verify-2026-10-08T10-00-00-000Z.json');
  assert.equal(b.verifyReport.ok, true);
  assert.equal(b.verifyReport.config.FILENET_SERVICE_PASSWORD, undefined);
  assert.equal(b.verifyReport.steps[0].name, 'ping object store');

  const audit = await api(run, 'GET', '/api/v1/filenet/health', { token: tok.auditor });
  assert.equal(audit.status, 200);
  const g = await api(run, 'GET', '/api/v1/filenet/health', { token: tok.gciaAdmin });
  assert.equal(g.status, 200);
  assert.ok(g.body.operations.every((o: any) => (o.folder ?? '').startsWith('/gcia/') || (o.ref ?? '').startsWith('gcia/')));
});

test('telemetry holds no document contents', async () => {
  const ops = run.handle.ctx.store.telemetry!();
  const sample = fs.readFileSync(path.resolve(import.meta.dirname, '../../../seed/files/kea-it-rfp-pack.md'), 'utf8').slice(0, 40);
  assert.equal(JSON.stringify(ops).includes(sample), false);
  assert.ok(createHash('sha256'));
});
