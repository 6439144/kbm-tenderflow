// Document intelligence (watsonx Orchestrate agent tenderflow_document_intelligence) against the TEST-ONLY fake
// Orchestrate server: classification + cited extraction validated by TenderFlow, review, rule-based flags, the
// sealed-bid rule (no bid text leaves TenderFlow before the opening), access rules, applying accepted data and the
// FileNet properties written on acceptance (fake FileNet). Nothing here is verified against a live instance.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { api, fileForm, login, startApp, BID_MASTER_KEY, AUDIT_SIGNING_KEY, type Running } from './helpers.js';
import { startFakeOrchestrate, type FakeCall, type FakeOrchestrate } from './fakes/orchestrate.js';
import { FakeFileNet } from './fakes/fake-filenet.js';
import { queueIdle } from '../src/features/docintel/service.js';
import { loadConfig } from '../src/config.js';
import { createApp, type AppHandle } from '../src/app.js';
import { FileNetStore } from '../src/content/filenet-store.js';
import { withTelemetry } from '../src/content/index.js';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

const DEMO_PASSWORD = 'Demo-Passw0rd!';
const DI = 'tenderflow_document_intelligence';
const J = (o: unknown) => JSON.stringify(o);

let fake: FakeOrchestrate;
let run: Running;        // Orchestrate configured (fake), DOC_AI_AUTO=true, demo seed
let bare: Running;       // Orchestrate NOT configured
const tok: Record<string, string> = {};
const ids: Record<string, string> = {};
const q = <T = any>(sql: string, p: unknown[] = []) => run.handle.ctx.db.query<T>(sql, p);
const idle = () => queueIdle(run.handle.ctx);
const diCalls = () => fake.calls.filter((c) => c.agentName === DI);

// ------------------------------------------------------------------ fake agent behaviour (generic, reads the prompt)

interface Sec { id: string; title: string; section: string; text: string }
function sectionsOf(prompt: string): Sec[] {
  const out: Sec[] = [];
  const re = /\[DOC ([^|\]]+) \| ([^|\]]*) \| ([^\]]+)\]\n([\s\S]*?)(?=\n\n\[DOC |\nEND DOCUMENTS)/g;
  for (let m = re.exec(prompt); m; m = re.exec(prompt)) out.push({ id: m[1].trim(), title: m[2].trim(), section: m[3].trim(), text: m[4] });
  return out;
}
/** Finds "Label: value" in the document and returns a cited field. */
function labelled(secs: Sec[], key: string, label: RegExp) {
  for (const s of secs) for (const line of s.text.split('\n')) {
    const m = line.match(label);
    if (m) return { key, value: m[1].trim(), citation: { section: s.section, quote: line.trim() } };
  }
  return null;
}
const summary = { summaryEn: '[FAKE] Document read by the test fake.', summaryAr: '[FAKE] مستند قرأه الخادم التجريبي.' };
function diReply(call: FakeCall): string {
  const secs = sectionsOf(call.prompt);
  const all = secs.map((s) => `${s.section}\n${s.text}`).join('\n');
  const base = { language: /[؀-ۿ]/.test(all) ? 'mixed' : 'en', ...summary, citations: secs.slice(0, 1).map((s) => ({ documentId: s.id, section: s.section })) };
  if (/Commercial Registration Certificate/i.test(all)) {
    return J({ ...base, docType: 'COMMERCIAL_REGISTRATION', fields: [
      labelled(secs, 'crNumber', /^CR No:\s*(.+)$/), labelled(secs, 'companyName', /^Company:\s*(.+)$/),
      labelled(secs, 'issueDate', /^Issue date:\s*(.+)$/), labelled(secs, 'expiryDate', /^Expiry date:\s*(.+)$/),
      labelled(secs, 'activities', /^Activities:\s*(.+)$/)].filter(Boolean) });
  }
  if (/Classification Certificate/i.test(all)) {
    return J({ ...base, docType: 'MOCI_CLASSIFICATION_CERT', fields: [
      labelled(secs, 'activityCodes', /^Activity codes:\s*(.+)$/), labelled(secs, 'grade', /^Grade:\s*(.+)$/),
      labelled(secs, 'expiryDate', /^Valid until:\s*(.+)$/)].filter(Boolean) });
  }
  const total = labelled(secs, 'totalAmount', /Total bid value\**\s*\|[\s|]*\**([\d,.]+)\**/);
  if (total && /Financial/i.test(all)) return J({ ...base, docType: 'FINANCIAL_PROPOSAL', fields: [{ ...total, value: `${total.value} KWD` }] });
  if (/Technical/i.test(all)) return J({ ...base, docType: 'TECHNICAL_PROPOSAL', fields: [] });
  return J({ ...base, docType: 'OTHER', fields: [] });
}

const CR = (o: { company?: string; expiry?: string } = {}) => `# Commercial Registration Certificate

## Registration
CR No: CR-100001
Company: ${o.company ?? 'Qamar Arcwave Systems W.L.L.'}

## Validity
Issue date: 01/02/2024
Expiry date: ${o.expiry ?? '15/03/2031'}

## Activities
Activities: IT services, Software development
`;
const ddmmyyyy = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;

async function upload(who: string, title: string, content: string | Buffer, name = 'doc.md', type = 'text/markdown') {
  const r = await api(run, 'POST', '/api/v1/vendors/me/documents', { token: tok[who], form: fileForm({ title, file: { name, content, type } }) });
  assert.equal(r.status, 201, r.text);
  return r.body.id as string;
}
const insight = async (docId: string, who: string) => api(run, 'GET', `/api/v1/documents/${docId}/insight`, { token: tok[who] });

before(async () => {
  bare = await startApp(undefined, { SEED_DEMO: 'true', DEMO_PASSWORD }); // created before the fake env exists → not configured
  fake = await startFakeOrchestrate();
  fake.reply = (c) => (c.agentName === DI ? diReply(c) : '{}');
  Object.assign(process.env, fake.env);
  run = await startApp(undefined, { SEED_DEMO: 'true', DEMO_PASSWORD, DOC_AI_AUTO: 'true', WXO_TIMEOUT_MS: '10000' });
  for (const u of ['officer', 'director', 'chair', 'evaluator1', 'evaluator2', 'admin', 'auditor', 'vendor1', 'vendor2']) tok[u] = await login(run, 'kea', u, DEMO_PASSWORD);
  for (const u of ['chair', 'evaluator1', 'officer']) tok[`g_${u}`] = await login(run, 'gcia', u, DEMO_PASSWORD);
  for (const x of await q<{ username: string; vendor_id: string }>(`SELECT username, vendor_id FROM users WHERE tenant_id='kea' AND vendor_id IS NOT NULL`)) ids[x.username] = x.vendor_id;
  for (const t of await q<{ tender_number: string; id: string; title_en: string }>(`SELECT tender_number, id, title_en FROM tenders`)) ids[t.tender_number ?? t.title_en] = t.id;
  ids.jetty = (await q<{ id: string }>(`SELECT id FROM tenders WHERE tenant_id='gcia' AND title_en='Marine Jetty Rehabilitation'`))[0].id;
});
after(async () => {
  await run?.stop(); await bare?.stop(); await fake?.close();
  for (const k of Object.keys(fake?.env ?? {})) delete process.env[k];
});

// ------------------------------------------------------------------ catalogue

test('catalogue: defaults installed per entity; admin edits; no personal ID fields; officer cannot edit', async () => {
  const r = await api(run, 'GET', '/api/v1/document-types', { token: tok.officer });
  assert.equal(r.status, 200, r.text);
  const codes = r.body.map((t: any) => t.code);
  for (const c of ['COMMERCIAL_REGISTRATION', 'MOCI_CLASSIFICATION_CERT', 'CHAMBER_OF_COMMERCE_CERT', 'BANK_GUARANTEE', 'ISO_CERTIFICATE', 'COMPANY_PROFILE',
    'TECHNICAL_PROPOSAL', 'FINANCIAL_PROPOSAL', 'TENDER_PACK', 'ADDENDUM', 'GM_LETTER', 'OTHER']) assert.ok(codes.includes(c), c);
  assert.ok(!JSON.stringify(r.body).match(/civil|passport/i), 'no personal identity fields in the defaults');
  const g = await api(run, 'GET', '/api/v1/document-types', { token: tok.g_officer });
  assert.equal(g.body.length, r.body.length, 'second entity has its own catalogue');

  const body = { code: 'MUNICIPALITY_LICENCE', nameEn: 'Municipality licence', nameAr: 'ترخيص البلدية', contexts: ['VENDOR'],
    fields: [{ key: 'licenceNumber', labelEn: 'Licence number', labelAr: 'رقم الترخيص', type: 'text', required: true }] };
  assert.equal((await api(run, 'POST', '/api/v1/document-types', { token: tok.officer, json: body })).status, 403);
  const bad = await api(run, 'POST', '/api/v1/document-types', { token: tok.admin, json: { ...body, fields: [{ key: 'civilId', labelEn: 'Civil ID', labelAr: 'الرقم المدني', type: 'text' }] } });
  assert.equal(bad.status, 400); assert.equal(bad.body.code, 'PERSONAL_DATA_FIELD');
  const c = await api(run, 'POST', '/api/v1/document-types', { token: tok.admin, json: body });
  assert.equal(c.status, 201, c.text);
  const p = await api(run, 'PATCH', `/api/v1/document-types/${c.body.id}`, { token: tok.admin, json: { active: false } });
  assert.equal(p.status, 200); assert.equal(p.body.active, false);
  const audit = await q(`SELECT action FROM audit_events WHERE resource_id=$1 ORDER BY seq`, [c.body.id]);
  assert.deepEqual(audit.map((a: any) => a.action), ['DOCUMENT_TYPE_CREATED', 'DOCUMENT_TYPE_UPDATED']);
});

// ------------------------------------------------------------------ not configured

test('not configured: classify → 503 with no insight row; upload still succeeds; insight says not connected', async () => {
  const t = await login(bare, 'kea', 'vendor1', DEMO_PASSWORD);
  const up = await api(bare, 'POST', '/api/v1/vendors/me/documents', { token: t, form: fileForm({ title: 'CR', file: { name: 'cr.md', content: CR() } }) });
  assert.equal(up.status, 201, up.text);
  const c = await api(bare, 'POST', `/api/v1/documents/${up.body.id}/ai/classify`, { token: t });
  assert.equal(c.status, 503); assert.equal(c.body.code, 'AI_NOT_CONFIGURED');
  const g = await api(bare, 'GET', `/api/v1/documents/${up.body.id}/insight`, { token: t });
  assert.equal(g.status, 200);
  assert.equal(g.body.configured, false); assert.equal(g.body.insight, null); assert.equal(g.body.queued, false);
  assert.equal((await bare.handle.ctx.db.query('SELECT 1 FROM document_insights')).length, 0, 'no insight row, no fake output');
});

// ------------------------------------------------------------------ happy path + validation

test('auto-queue after a vendor upload: classified with validated fields and citations', async () => {
  const n = diCalls().length;
  const docId = await upload('vendor1', 'Commercial registration', CR());
  await idle();
  assert.equal(diCalls().length, n + 1, 'one agent call');
  const prompt = diCalls().at(-1)!.prompt;
  assert.match(prompt, /CR-100001/); assert.match(prompt, /COMMERCIAL_REGISTRATION/); assert.match(prompt, /Uploaded as: VENDOR/);
  assert.ok(!/FINANCIAL_PROPOSAL —/.test(prompt), 'only the types of the VENDOR context are offered');
  const r = await insight(docId, 'vendor1');
  assert.equal(r.status, 200, r.text);
  const i = r.body.insight;
  assert.equal(i.status, 'PENDING_REVIEW'); assert.equal(i.trigger, 'UPLOAD'); assert.equal(i.docType, 'COMMERCIAL_REGISTRATION');
  const f = Object.fromEntries(i.fields.map((x: any) => [x.key, x]));
  assert.equal(f.expiryDate.value, '2031-03-15', 'dates normalised to ISO');
  assert.equal(f.issueDate.value, '2024-02-01');
  assert.deepEqual(f.activities.value, ['IT services', 'Software development']);
  assert.equal(f.crNumber.citation.section, 'Registration');
  assert.equal(f.crNumber.citation.quote, 'CR No: CR-100001');
  assert.equal(i.agent, DI); assert.ok(i.aiRunId); assert.ok(i.orchestrateRunId);
  assert.deepEqual(i.flags, [], 'valid, matching, not expiring');
  const run_ = await q(`SELECT kind, status, subject_id FROM ai_runs WHERE id=$1`, [i.aiRunId]);
  assert.equal(run_[0].kind, 'DOCUMENT_INTELLIGENCE'); assert.equal(run_[0].subject_id, docId);
  ids.crDoc = docId; ids.crInsight = i.id;
});

test('invalid output is repaired once: unknown field key → repair turn → accepted', async () => {
  const docId = await upload('vendor1', 'CR copy', CR());
  await idle();
  const good = diReply({ prompt: diCalls().at(-1)!.prompt } as FakeCall);
  const bad = J({ ...JSON.parse(good), fields: [{ key: 'civilId', value: '123', citation: { section: 'Registration', quote: 'CR No: CR-100001' } }] });
  fake.queue.push(bad, good);
  const r = await api(run, 'POST', `/api/v1/documents/${docId}/ai/classify`, { token: tok.officer });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.repaired, true); assert.equal(r.body.trigger, 'MANUAL');
  const repair = diCalls().at(-1)!;
  assert.equal(repair.continued, true); assert.match(repair.prompt, /civilId.*not defined/);
});

test('unknown docType and a quote that is not in the text are rejected (FAILED insight, 502)', async () => {
  const docId = await upload('vendor1', 'Registration', CR());
  await idle();
  const good = JSON.parse(diReply({ prompt: diCalls().at(-1)!.prompt } as FakeCall));
  fake.queue.push(J({ ...good, docType: 'PASSPORT' }), J({ ...good, docType: 'PASSPORT' }));
  const r1 = await api(run, 'POST', `/api/v1/documents/${docId}/ai/classify`, { token: tok.officer });
  assert.equal(r1.status, 502, r1.text); assert.match(r1.body.message, /docType/);
  const invented = { ...good, fields: [{ key: 'crNumber', value: 'CR-999999', citation: { section: 'Registration', quote: 'CR No: CR-999999' } }] };
  fake.queue.push(J(invented), J(invented));
  const r2 = await api(run, 'POST', `/api/v1/documents/${docId}/ai/classify`, { token: tok.officer });
  assert.equal(r2.status, 502); assert.match(r2.body.message, /quote does not appear/);
  const rows = await q(`SELECT status, error FROM document_insights WHERE document_id=$1 ORDER BY created_at`, [docId]);
  assert.deepEqual(rows.map((x: any) => x.status), ['PENDING_REVIEW', 'FAILED', 'FAILED']);
  const g = await insight(docId, 'officer');
  assert.equal(g.body.insight.status, 'FAILED');
});

test('scanned image → NOT_EXTRACTABLE with a bilingual message, no agent call', async () => {
  const n = diCalls().length;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  const docId = await upload('vendor1', 'Scanned CR', png, 'scan.png', 'image/png');
  await idle();
  assert.equal(diCalls().length, n, 'nothing sent to Orchestrate');
  const r = await insight(docId, 'vendor1');
  assert.equal(r.body.insight.status, 'NOT_EXTRACTABLE');
  assert.match(r.body.insight.notExtractable.en, /OCR is not enabled.*Datacap/);
  assert.match(r.body.insight.notExtractable.ar, /Datacap/);
  assert.deepEqual(r.body.insight.fields, []);
});

// ------------------------------------------------------------------ access

test('access: vendors see only their own insights, never review; vendor may classify own documents only', async () => {
  assert.equal((await insight(ids.crDoc, 'vendor2')).status, 404, 'another vendor');
  assert.equal((await api(run, 'POST', `/api/v1/documents/${ids.crDoc}/ai/classify`, { token: tok.vendor2 })).status, 404);
  const lat = await api(run, 'GET', `/api/v1/document-insights/latest?documentIds=${ids.crDoc}`, { token: tok.vendor2 });
  assert.deepEqual(lat.body.items, {}, 'batch lookup leaves unreadable documents out');
  assert.equal((await api(run, 'POST', `/api/v1/document-insights/${ids.crInsight}/review`, { token: tok.vendor2, json: { decision: 'ACCEPT' } })).status, 404);
  assert.equal((await api(run, 'POST', `/api/v1/document-insights/${ids.crInsight}/review`, { token: tok.vendor1, json: { decision: 'ACCEPT' } })).status, 403);
  assert.equal((await api(run, 'POST', `/api/v1/document-insights/${ids.crInsight}/review`, { token: tok.director, json: { decision: 'ACCEPT' } })).status, 403);
  assert.equal((await api(run, 'GET', '/api/v1/document-insights', { token: tok.vendor1 })).status, 403, 'staff queue');
  const own = await api(run, 'POST', `/api/v1/documents/${ids.crDoc}/ai/classify`, { token: tok.vendor1 });
  assert.equal(own.status, 201, own.text);
  const gcia = await api(run, 'GET', `/api/v1/documents/${ids.crDoc}/insight`, { token: tok.g_officer });
  assert.equal(gcia.status, 404, 'other tenant');
});

// ------------------------------------------------------------------ review + flags + effects

test('review: correct (keeps AI and corrected values), accept, reject — all audited; vendor sees verified data', async () => {
  const latest = (await insight(ids.crDoc, 'officer')).body.insight;
  assert.equal(latest.canReview, true);
  const noReason = await api(run, 'POST', `/api/v1/document-insights/${latest.id}/review`, { token: tok.officer, json: { decision: 'REJECT' } });
  assert.equal(noReason.status, 400);
  const bad = await api(run, 'POST', `/api/v1/document-insights/${latest.id}/review`, { token: tok.officer, json: { decision: 'CORRECT', fields: [{ key: 'expiryDate', value: 'soon' }] } });
  assert.equal(bad.status, 400);
  const c = await api(run, 'POST', `/api/v1/document-insights/${latest.id}/review`, { token: tok.officer,
    json: { decision: 'CORRECT', fields: [{ key: 'expiryDate', value: '2031-03-16' }], reason: 'Checked against the original' } });
  assert.equal(c.status, 200, c.text);
  assert.equal(c.body.status, 'CORRECTED');
  const e = c.body.fields.find((f: any) => f.key === 'expiryDate');
  assert.equal(e.value, '2031-03-16'); assert.equal(e.corrected, true); assert.equal(e.aiValue, '2031-03-15');
  assert.ok(c.body.aiFields.some((f: any) => f.key === 'expiryDate' && f.value === '2031-03-15'), 'AI values kept');
  assert.equal(c.body.filenet.status, 'SKIPPED', 'FILENET_AI_PROPERTIES not enabled in this app');
  assert.equal((await api(run, 'POST', `/api/v1/document-insights/${latest.id}/review`, { token: tok.officer, json: { decision: 'ACCEPT' } })).status, 409);

  const audit = await q(`SELECT new_state, details FROM audit_events WHERE action='DOCUMENT_INSIGHT_REVIEWED' AND resource_id=$1`, [ids.crDoc]);
  assert.equal(audit.length, 1); assert.equal(audit[0].new_state, 'CORRECTED'); assert.deepEqual(audit[0].details.changed, ['expiryDate']);

  const v = await api(run, 'GET', '/api/v1/vendor/me/verified-documents', { token: tok.vendor1 });
  assert.equal(v.status, 200, v.text);
  const item = v.body.items.find((x: any) => x.documentId === ids.crDoc);
  assert.equal(item.verified.status, 'CORRECTED');
  const staffView = await api(run, 'GET', `/api/v1/vendors/${ids.vendor1}/verified-documents`, { token: tok.officer });
  assert.ok(staffView.body.items.some((x: any) => x.verified?.docType === 'COMMERCIAL_REGISTRATION'));
  assert.equal((await api(run, 'GET', `/api/v1/vendors/${ids.vendor1}/verified-documents`, { token: tok.vendor2 })).status, 403);

  // Reject another result
  const other = await upload('vendor1', 'Another CR', CR());
  await idle();
  const oi = (await insight(other, 'officer')).body.insight;
  const rj = await api(run, 'POST', `/api/v1/document-insights/${oi.id}/review`, { token: tok.admin, json: { decision: 'REJECT', reason: 'Duplicate upload' } });
  assert.equal(rj.status, 200); assert.equal(rj.body.status, 'REJECTED');
  const queue = await api(run, 'GET', '/api/v1/document-insights?status=REJECTED', { token: tok.officer });
  assert.ok(queue.body.items.some((x: any) => x.documentId === other && x.owner.kind === 'VENDOR'));
  assert.ok(queue.body.counts.CORRECTED >= 1);
});

test('rule-based flags: expired, expiring, name mismatch, type mismatch; vendor notified on acceptance of an expired document', async () => {
  const expired = await upload('vendor1', 'Commercial registration', CR({ expiry: '10/01/2020' }));
  const soon = await upload('vendor1', 'Commercial registration', CR({ expiry: ddmmyyyy(new Date(Date.now() + 10 * 86_400_000)) }));
  const other = await upload('vendor1', 'ISO certificate', CR({ company: 'Totally Different Trading Co.' }));
  await idle();
  const codes = async (d: string) => (await insight(d, 'officer')).body.insight.flags.map((f: any) => f.code);
  assert.deepEqual(await codes(expired), ['EXPIRED']);
  assert.deepEqual(await codes(soon), ['EXPIRING_SOON']);
  assert.deepEqual((await codes(other)).sort(), ['NAME_MISMATCH', 'TYPE_MISMATCH'], 'company differs; uploaded as ISO certificate but is a CR');
  const ei = (await insight(expired, 'officer')).body.insight;
  const acc = await api(run, 'POST', `/api/v1/document-insights/${ei.id}/review`, { token: tok.officer, json: { decision: 'ACCEPT' } });
  assert.equal(acc.status, 200, acc.text);
  const notes = await api(run, 'GET', '/api/v1/notifications', { token: tok.vendor1 });
  assert.ok(notes.body.some((n: any) => n.kind === 'DOCUMENT_EXPIRED' && n.body.documentId === expired), 'vendor notified in-app');
  assert.equal((await q(`SELECT 1 FROM audit_events WHERE action='DOCUMENT_EXPIRY_NOTIFIED' AND resource_id=$1`, [expired])).length, 1);
});

test('MOCI certificate: classification created only when the officer confirms (existing eligibility service)', async () => {
  const cert = `# Classification Certificate\n\n## Classification\nActivity codes: IT-01, IT-02\nGrade: First grade\n\n## Validity\nValid until: 31/12/2030\n`;
  const docId = await upload('vendor2', 'Classification certificate', cert);
  await idle();
  tok.vendor2 = tok.vendor2 ?? await login(run, 'kea', 'vendor2', DEMO_PASSWORD);
  const ins = (await insight(docId, 'officer')).body.insight;
  assert.equal(ins.docType, 'MOCI_CLASSIFICATION_CERT');
  assert.equal(ins.classificationSuggestion, null, 'nothing offered before acceptance');
  assert.equal((await api(run, 'POST', `/api/v1/document-insights/${ins.id}/apply-classification`, { token: tok.officer, json: { confirm: true, activityCode: 'IT-01', grade: 1 } })).status, 409);
  const acc = await api(run, 'POST', `/api/v1/document-insights/${ins.id}/review`, { token: tok.officer, json: { decision: 'ACCEPT' } });
  assert.deepEqual(acc.body.classificationSuggestion, { activityCodes: ['IT-01', 'IT-02'], unmatched: [], grade: 1, validUntil: '2030-12-31' });
  const before = await api(run, 'GET', `/api/v1/vendors/${ids.vendor2}/classifications`, { token: tok.officer });
  const path_ = `/api/v1/document-insights/${ins.id}/apply-classification`;
  assert.equal((await api(run, 'POST', path_, { token: tok.vendor2, json: { confirm: true, activityCode: 'IT-01', grade: 1 } })).status, 403);
  assert.equal((await api(run, 'POST', path_, { token: tok.officer, json: { activityCode: 'IT-01', grade: 1 } })).status, 400, 'confirmation required');
  const ap = await api(run, 'POST', path_, { token: tok.officer, json: { confirm: true, activityCode: 'IT-02', grade: 1, validUntil: '2030-12-31' } });
  assert.equal(ap.status, 201, ap.text);
  const after_ = await api(run, 'GET', `/api/v1/vendors/${ids.vendor2}/classifications`, { token: tok.officer });
  assert.equal(after_.body.length, before.body.filter((c: any) => c.activityCode !== 'IT-02').length + 1);
  assert.ok(after_.body.some((c: any) => c.activityCode === 'IT-02' && c.grade === 1));
  const actions = (await q(`SELECT action FROM audit_events WHERE resource_id IN ($1,$2) ORDER BY seq`, [docId, ids.vendor2])).map((a: any) => a.action);
  assert.ok(actions.includes('VENDOR_CLASSIFICATION_SET') && actions.includes('DOCUMENT_INSIGHT_APPLIED'));
});

// ------------------------------------------------------------------ sealed bids

const KEA_TECH = 'BB-QA-5521'; const KEA_FIN = '159,500.000';
const G_TECH = 'jack-up barge'; const G_FIN = '2,125,000.000';
const leaked = (s: string) => fake.calls.some((c) => c.prompt.includes(s));

test('sealed bids: no bid text reaches Orchestrate before opening; technical + financial queued at a one-envelope opening', async () => {
  const t = ids['KEA-2026-088'];
  await idle();
  for (const s of [KEA_TECH, KEA_FIN, G_TECH, G_FIN]) assert.ok(!leaked(s), `bid text "${s}" sent before opening`);
  const bidDoc = (await q<{ id: string }>(`SELECT d.id FROM documents d WHERE d.tender_id=$1 AND d.owner_type='BID_TECHNICAL' LIMIT 1`, [t]))[0].id;
  const pre = await api(run, 'POST', `/api/v1/documents/${bidDoc}/ai/classify`, { token: tok.chair });
  assert.equal(pre.status, 403); assert.equal(pre.body.code, 'BID_SEALED');
  assert.equal((await insight(bidDoc, 'chair')).status, 403);
  assert.ok(!leaked(KEA_TECH));

  const opened = await api(run, 'POST', `/api/v1/tenders/${t}/open`, { token: tok.chair, json: { attendees: ['Chair (test)'] } });
  assert.equal(opened.status, 200, opened.text);
  await idle();
  assert.ok(leaked(KEA_TECH) && leaked(KEA_FIN), 'technical and financial envelopes classified after a one-envelope opening');
  const rows = await q<{ owner_type: string; status: string; trigger: string }>(
    `SELECT d.owner_type, i.status, i.trigger FROM document_insights i JOIN documents d ON d.id=i.document_id WHERE d.tender_id=$1`, [t]);
  assert.equal(rows.length, 6);
  assert.ok(rows.every((r) => r.trigger === 'OPENING' && r.status === 'PENDING_REVIEW'));
  const totals = await api(run, 'GET', `/api/v1/tenders/${t}/extracted-totals`, { token: tok.evaluator1 });
  assert.equal(totals.status, 200, totals.text);
  const first = totals.body.items.find((x: any) => x.insight?.totalAmount?.amount === 159500);
  assert.ok(first, 'extracted total of the vendor1 bid'); assert.equal(first.insight.totalAmount.currency, 'KWD');
  assert.equal((await api(run, 'GET', `/api/v1/tenders/${t}/extracted-totals`, { token: tok.officer })).status, 403);
  // Bid documents: committee reviews, the officer and vendors cannot see them.
  const fin = (await q<{ id: string }>(`SELECT id FROM documents WHERE tender_id=$1 AND owner_type='BID_FINANCIAL' LIMIT 1`, [t]))[0].id;
  assert.equal((await insight(fin, 'officer')).status, 403);
  assert.equal((await insight(fin, 'vendor1')).status, 404);
  const fi = (await insight(fin, 'chair')).body.insight;
  assert.equal(fi.canReview, true);
  const ok = await api(run, 'POST', `/api/v1/document-insights/${fi.id}/review`, { token: tok.evaluator1, json: { decision: 'ACCEPT' } });
  assert.equal(ok.status, 200, ok.text);
});

test('two envelopes: financial text only after the financial opening', async () => {
  const t = ids.jetty;
  const opened = await api(run, 'POST', `/api/v1/tenders/${t}/open`, { token: tok.g_chair, json: { attendees: ['Chair (test)'] } });
  assert.equal(opened.status, 200, opened.text);
  await idle();
  assert.ok(leaked(G_TECH), 'technical envelopes classified at opening');
  assert.ok(!leaked(G_FIN), 'financial envelope NOT sent at the technical opening');
  const fin = (await q<{ id: string }>(`SELECT id FROM documents WHERE tender_id=$1 AND owner_type='BID_FINANCIAL' LIMIT 1`, [t]))[0].id;
  const pre = await api(run, 'POST', `/api/v1/documents/${fin}/ai/classify`, { token: tok.g_chair });
  assert.equal(pre.status, 403); assert.equal(pre.body.code, 'FINANCIAL_SEALED');
  const totals = await api(run, 'GET', `/api/v1/tenders/${t}/extracted-totals`, { token: tok.g_chair });
  assert.ok(totals.body.items.every((x: any) => x.sealed === true));

  const bids = await api(run, 'GET', `/api/v1/tenders/${t}/bids`, { token: tok.g_chair });
  for (const b of bids.body) {
    const ev = await api(run, 'POST', `/api/v1/bids/${b.id}/evaluation`, { token: tok.g_evaluator1, json: { scores: [
      { criterion: 'technical', score: 85, comment: 'ok' }, { criterion: 'experience', score: 80, comment: 'ok' }] } });
    assert.equal(ev.status, 200, ev.text);
  }
  const fo = await api(run, 'POST', `/api/v1/tenders/${t}/open-financial`, { token: tok.g_chair, json: {} });
  assert.equal(fo.status, 200, fo.text);
  await idle();
  assert.ok(leaked(G_FIN), 'financial envelope classified after the financial opening');
  const rows = await q<{ trigger: string }>(`SELECT i.trigger FROM document_insights i JOIN documents d ON d.id=i.document_id WHERE d.tender_id=$1 AND d.owner_type='BID_FINANCIAL'`, [t]);
  assert.ok(rows.length >= 1 && rows.every((r) => r.trigger === 'FINANCIAL_OPENING'));
  const after_ = await api(run, 'GET', `/api/v1/tenders/${t}/extracted-totals`, { token: tok.g_chair });
  assert.ok(after_.body.items.some((x: any) => x.insight?.totalAmount?.amount === 2125000));
});

test('template toggle off: no automatic run for that tender; DOC_AI_AUTO=false app never auto-classifies', async () => {
  const n = diCalls().length;
  const t = ids['KEA-2026-101'];
  await q(`UPDATE tenders SET template_snapshot = jsonb_set(template_snapshot, '{config,ai,documentIntelligence}', 'false') WHERE id=$1`, [t]);
  const up = await api(run, 'POST', `/api/v1/tenders/${t}/documents`, { token: tok.officer, form: fileForm({ title: 'Annex', file: { name: 'annex.md', content: '# Annex\n\n## Scope\nNothing.\n\n## Notes\nNone.' } }) });
  assert.equal(up.status, 201, up.text);
  await idle();
  assert.equal(diCalls().length, n);
  const g = await insight(up.body.id, 'officer');
  assert.equal(g.body.insight, null); assert.equal(g.body.canClassify, true, 'manual run still available');
});

// ------------------------------------------------------------------ FileNet properties (fake FileNet)

test('FileNet: TF_DocType / TF_ExpiryDate / TF_AIReviewed written on acceptance; a refusal is recorded, review still succeeds', async () => {
  const fn = new FakeFileNet();
  await fn.start();
  fn.classes.add('TF_Document');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-di-fn-'));
  const config = loadConfig({ BID_MASTER_KEY, AUDIT_SIGNING_KEY, DATA_DIR: dataDir, SEED_DEMO: 'true', DEMO_PASSWORD, CONTENT_STORE_TYPE: 'filenet',
    PUBLIC_BASE_URL: 'http://tenderflow.test', LOGIN_RATE_LIMIT_PER_MIN: '1000', WEB_DIST_DIR: path.join(dataDir, 'no-web'),
    DOC_AI_AUTO: 'true', FILENET_AI_PROPERTIES: 'true' });
  const store = withTelemetry(new FileNetStore(fn.env({ FILENET_DOC_CLASS: 'TF_Document', FILENET_AI_PROPERTIES: 'true' })));
  const handle: AppHandle = await createApp(config, { store });
  const server = handle.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const r2: Running = { handle, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dataDir, stop: async () => { server.close(); await handle.close(); } };
  try {
    const v1 = await login(r2, 'kea', 'vendor1', DEMO_PASSWORD);
    const off = await login(r2, 'kea', 'officer', DEMO_PASSWORD);
    const up = async (title: string) => (await api(r2, 'POST', '/api/v1/vendors/me/documents', { token: v1, form: fileForm({ title, file: { name: 'cr.md', content: CR() } }) })).body.id as string;
    const a = await up('Commercial registration');
    const b = await up('Commercial registration (copy)');
    await queueIdle(handle.ctx);
    const ins = async (d: string) => (await api(r2, 'GET', `/api/v1/documents/${d}/insight`, { token: off })).body.insight;

    fn.aiProperties = true;
    const ra = await api(r2, 'POST', `/api/v1/document-insights/${(await ins(a)).id}/review`, { token: off, json: { decision: 'ACCEPT' } });
    assert.equal(ra.status, 200, ra.text);
    assert.equal(ra.body.filenet.status, 'WRITTEN', JSON.stringify(ra.body.filenet));
    const objectId = (await handle.ctx.db.query<{ store_meta: any }>('SELECT store_meta FROM documents WHERE id=$1', [a]))[0].store_meta.objectId;
    const fdoc = fn.docs.get(objectId)!;
    assert.equal(fdoc.props.TF_DocType, 'COMMERCIAL_REGISTRATION');
    assert.equal(fdoc.props.TF_AIReviewed, true);
    assert.match(String(fdoc.props.TF_ExpiryDate), /^2031-03-15/);
    assert.ok(fn.graphqlOps('TfSetProperties').length >= 1);

    fn.aiProperties = false; // property templates missing in ACCE → the Content Engine refuses
    const rb = await api(r2, 'POST', `/api/v1/document-insights/${(await ins(b)).id}/review`, { token: off, json: { decision: 'ACCEPT' } });
    assert.equal(rb.status, 200, 'the review never fails because FileNet refused');
    assert.equal(rb.body.status, 'ACCEPTED');
    assert.equal(rb.body.filenet.status, 'FAILED'); assert.match(rb.body.filenet.detail, /TF_ExpiryDate|TF_AIReviewed/);
    const audit = await handle.ctx.db.query(`SELECT action FROM audit_events WHERE resource_id=$1 AND action LIKE 'DOCUMENT_PROPERTIES_%'`, [b]);
    assert.deepEqual(audit.map((x: any) => x.action), ['DOCUMENT_PROPERTIES_FAILED']);
  } finally {
    await r2.stop(); await fn.stop();
  }
});

test('audit chain stays valid after document-intelligence activity', async () => {
  const r = await api(run, 'GET', '/api/v1/audit/verify', { token: tok.auditor });
  assert.equal(r.status, 200); assert.equal(r.body.valid, true);
});
