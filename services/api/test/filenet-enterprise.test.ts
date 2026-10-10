// FileNet enterprise features against the local fake Content Services server: TF_* class model (class per owner type,
// property inheritance, fallback to FILENET_DOC_CLASS), document security (ACL at create, SEALED → COMMITTEE at the
// opening, retry job), CE SQL search (where-clause safety, TenderFlow access filter), evidence links into Navigator /
// ACCE (configured / derived / off / unreachable), vendor redaction, AI properties after classification.
// Nothing here is verified against a live Content Engine (the ASSUMED shapes are listed in docs/filenet/SHOWCASE.md).
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { api, fileForm, login, sleep, BID_MASTER_KEY, AUDIT_SIGNING_KEY, type Running } from './helpers.js';
import { FakeFileNet, OS_GUID, USER, defineTfModel } from './fakes/fake-filenet.js';
import { startFakeOrchestrate, type FakeOrchestrate } from './fakes/orchestrate.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { FileNetStore, FileNetConfigError } from '../src/content/filenet-store.js';
import { withTelemetry } from '../src/content/index.js';
import { buildSearchWhere, SearchInputError, subclassFor, confidentialityFor, aclEntriesFor, permissionsLiteral } from '../src/content/filenet-model.js';
import { resetNavigatorProbeCache, navigatorSettings, acceUrl } from '../src/content/navigator.js';
import { evidenceLinks, writeAiClassification } from '../src/features/filenet-showcase.js';
import { changeAccess, ACCESS_RETRY_JOB } from '../src/features/filenet-access.js';
import { runJob } from '../src/services/scheduler.js';

const fake = new FakeFileNet();
const DEMO_PASSWORD = 'Demo-Passw0rd!';
const GROUPS = { FILENET_GROUP_PUBLIC: 'TF Public', FILENET_GROUP_INTERNAL: 'TF Staff', FILENET_GROUP_COMMITTEE: 'TF Committee', FILENET_GROUP_AUDIT: 'TF Auditors' };
const MODEL_ENV = { FILENET_CLASS_MODEL: 'subclasses', FILENET_ACL_MODE: 'groups', ...GROUPS };

before(async () => { await fake.start(); });
after(async () => { await fake.stop(); });

const putAs = (s: FileNetStore, ownerType: string, extra: Record<string, string> = {}, fileName = 'a.txt') =>
  s.put({ tenantId: 'kea', folderPath: `/kea/KEA-1/${ownerType}`, fileName, mimeType: 'text/plain', bytes: Buffer.from(`${ownerType} ${Math.random()}`),
    properties: { TF_TenantId: 'kea', TF_OwnerType: ownerType, TF_DocType: ownerType, TF_TenderNumber: 'KEA-1', TF_VersionNo: '1', TF_UploadedBy: 'u-1', ...extra } });
const objOf = (s: FileNetStore, ref: string) => fake.docs.get(s.parseStoreRef(ref).id)!;

// ================================================================== store level

describe('class model (FILENET_CLASS_MODEL=subclasses)', () => {
  beforeEach(() => { fake.reset(); resetNavigatorProbeCache(); });

  test('subclassFor and confidentiality cover every owner type', () => {
    assert.equal(subclassFor('TENDER_PACK'), 'TF_TenderDocument');
    assert.equal(subclassFor('ADDENDUM'), 'TF_TenderDocument');
    assert.equal(subclassFor('BID_FINANCIAL'), 'TF_BidEnvelope');
    assert.equal(subclassFor('VENDOR'), 'TF_VendorDocument');
    assert.equal(subclassFor('COMMITTEE_REPORT'), 'TF_CommitteeRecord');
    assert.equal(subclassFor('EVIDENCE_PACK'), 'TF_EvidencePack');
    assert.equal(subclassFor('SOMETHING_NEW'), 'TF_Document');
    assert.deepEqual(['TENDER_PACK', 'VENDOR', 'BID_TECHNICAL', 'OPENING_RECORD', 'EVIDENCE_PACK'].map(confidentialityFor), ['PUBLIC', 'INTERNAL', 'SEALED', 'COMMITTEE', 'AUDIT']);
  });

  test('each owner type is stored in its subclass; subclasses inherit the TF_Document properties; TF_BidId only on TF_BidEnvelope', async () => {
    defineTfModel(fake);
    fake.strictProperties = true; // the fake refuses any property the class does not define, like the Content Engine
    const s = new FileNetStore(fake.env({ FILENET_CLASS_MODEL: 'subclasses' }));
    const pack = await putAs(s, 'TENDER_PACK', { TF_BidId: 'should-not-be-written' });
    const bid = await putAs(s, 'BID_TECHNICAL', { TF_BidId: 'b-1', TF_VendorId: 'v-1' });
    const vend = await putAs(s, 'VENDOR');
    const rec = await putAs(s, 'OPENING_RECORD');
    const ev = await putAs(s, 'EVIDENCE_PACK');
    assert.deepEqual([pack, bid, vend, rec, ev].map((o) => objOf(s, o.storeRef).cls), ['TF_TenderDocument', 'TF_BidEnvelope', 'TF_VendorDocument', 'TF_CommitteeRecord', 'TF_EvidencePack']);
    const p = objOf(s, pack.storeRef).props;
    assert.equal(p.TF_TenantId, 'kea'); assert.equal(p.TF_OwnerType, 'TENDER_PACK'); assert.equal(p.TF_TenderNumber, 'KEA-1');
    assert.equal(p.TF_Confidentiality, 'PUBLIC'); assert.equal(p.TF_VersionNo, 1); assert.equal(p.TF_UploadedBy, 'u-1');
    assert.equal(p.TF_DocumentType, 'TENDER_PACK'); assert.match(String(p.TF_Sha256), /^[0-9a-f]{64}$/);
    assert.equal('TF_BidId' in p, false, 'subclass-only property is not written on another class');
    const b = objOf(s, bid.storeRef).props;
    assert.equal(b.TF_BidId, 'b-1'); assert.equal(b.TF_Confidentiality, 'SEALED'); assert.equal(b.TF_VendorId, 'v-1');
    assert.deepEqual(pack.meta?.classModel, { mode: 'subclasses', requested: 'TF_TenderDocument', used: 'TF_TenderDocument' });
    assert.ok((pack.meta?.propertiesWritten as string[]).includes('TF_Confidentiality'));
    // describe() asks only for properties the class reports, so evidence shows the model properties
    const d = await s.describe(bid.storeRef, { className: 'TF_BidEnvelope' });
    assert.equal(d.properties?.TF_BidId, 'b-1');
    assert.equal(d.properties?.TF_OwnerType, 'BID_TECHNICAL');
    const st = await s.modelStatus();
    assert.equal(st.ready, true);
    assert.ok(st.classes.find((c) => c.name === 'TF_VendorDocument')!.present!.includes('TF_TenantId'), 'inherited properties are reported on the subclass');
    assert.equal(fake.graphqlOps('TfClassModel').length, 6, 'one classDescription per class, then cached');
    await putAs(s, 'NOTICE');
    assert.equal(fake.graphqlOps('TfClassModel').length, 6);
  });

  test('a missing subclass falls back to TF_Document, a missing model to FILENET_DOC_CLASS — uploads never break', async () => {
    defineTfModel(fake);
    fake.classes.delete('TF_EvidencePack');
    const s = new FileNetStore(fake.env({ FILENET_CLASS_MODEL: 'subclasses' }));
    const ev = await putAs(s, 'EVIDENCE_PACK');
    assert.equal(objOf(s, ev.storeRef).cls, 'TF_Document');
    assert.match(String((ev.meta?.classModel as any).fallback), /TF_EvidencePack does not exist/);

    fake.reset();
    const bare = new FileNetStore(fake.env({ FILENET_CLASS_MODEL: 'subclasses' }));
    const out = await putAs(bare, 'TENDER_PACK');
    assert.equal(objOf(bare, out.storeRef).cls, 'Document');
    assert.deepEqual(objOf(bare, out.storeRef).props, {}, 'the base Document class gets no TF_* properties (FILENET_SET_CUSTOM_PROPERTIES=false)');
    assert.match(String((out.meta?.classModel as any).fallback), /TF_TenderDocument does not exist; TF_Document does not exist → FILENET_DOC_CLASS Document/);
  });

  test('a property the class lacks is not written; a refused create falls back to FILENET_DOC_CLASS', async () => {
    defineTfModel(fake);
    fake.classProps.set('TF_Document', fake.classProps.get('TF_Document')!.filter((p) => p !== 'TF_UploadedBy'));
    fake.strictProperties = true;
    const s = new FileNetStore(fake.env({ FILENET_CLASS_MODEL: 'subclasses' }));
    const a = await putAs(s, 'VENDOR');
    assert.equal(objOf(s, a.storeRef).cls, 'TF_VendorDocument');
    assert.equal('TF_UploadedBy' in objOf(s, a.storeRef).props, false);
    assert.equal(fake.graphqlOps('TfCreateDocument').length, 1, 'no refused attempt: the property list was known');

    // The schema does not expose propertyDescriptions: class existence is checked, properties are attempted, and the
    // Content Engine's refusal falls back to FILENET_DOC_CLASS (the upload still succeeds).
    fake.noPropertyDescriptions = true;
    const s2 = new FileNetStore(fake.env({ FILENET_CLASS_MODEL: 'subclasses' }));
    const st = await s2.modelStatus();
    assert.equal(st.classes[0].exists, true);
    assert.equal(st.classes[0].present, null);
    assert.match(String(st.classes[0].error), /property list not available/);
    assert.equal(st.ready, false);
    const b = await putAs(s2, 'VENDOR');
    assert.equal(objOf(s2, b.storeRef).cls, 'Document');
    assert.match(String((b.meta?.classModel as any).refused[0]), /property TF_UploadedBy not found in class TF_VendorDocument/);
    assert.equal((b.meta?.classModel as any).used, 'Document');
  });

  test('single mode (default) is unchanged: FILENET_DOC_CLASS, rc3 properties, no class-model metadata', async () => {
    fake.classes.add('TF_Document');
    const s = new FileNetStore(fake.env({ FILENET_DOC_CLASS: 'TF_Document', FILENET_SET_CUSTOM_PROPERTIES: 'true' }));
    const out = await putAs(s, 'BID_TECHNICAL', { TF_BidId: 'b-1' });
    const o = objOf(s, out.storeRef);
    assert.equal(o.cls, 'TF_Document');
    assert.deepEqual(Object.keys(o.props).sort(), ['TF_DocType', 'TF_Sha256', 'TF_TenantId']);
    assert.equal(out.meta?.classModel, undefined);
    assert.equal(out.meta?.acl, undefined);
    assert.equal(fake.graphqlOps('TfClassModel').length, 0, 'single mode never queries the class model at upload');
  });

  test('configuration is validated', () => {
    assert.throws(() => new FileNetStore(fake.env({ FILENET_CLASS_MODEL: 'tree' })), (e: any) => e instanceof FileNetConfigError && /FILENET_CLASS_MODEL must be one of single, subclasses/.test(e.message));
    assert.throws(() => new FileNetStore(fake.env({ FILENET_ACL_MODE: 'groups' })), /needs at least one FILENET_GROUP_/);
    assert.throws(() => new FileNetStore(fake.env({ FILENET_ACL_MODE: 'groups', FILENET_GROUP_COMMITTEE: 'x"} } ] } evil' })), /FILENET_GROUP_COMMITTEE is not a valid grantee name/);
    assert.throws(() => new FileNetStore(fake.env({ FILENET_ACL_MODE: 'groups', FILENET_GROUP_AUDIT: 'a\nb' })), /FILENET_GROUP_AUDIT/);
    assert.throws(() => new FileNetStore(fake.env({ FILENET_ACL_MODE: 'everyone' })), /FILENET_ACL_MODE must be one of off, groups/);
    const ok = new FileNetStore(fake.env({ FILENET_ACL_MODE: 'groups', FILENET_GROUP_COMMITTEE: 'cn=TF Committee,ou=groups,dc=kbm,dc=test' }));
    assert.equal(ok.config.acl.groups.COMMITTEE, 'cn=TF Committee,ou=groups,dc=kbm,dc=test');
    assert.equal(ok.config.acl.serviceGrantee, USER);
  });
});

describe('document security (FILENET_ACL_MODE=groups)', () => {
  beforeEach(() => { fake.reset(); });

  test('permission list per level: service user full control (998903) + the level\'s groups view content (131201)', () => {
    const cfg = new FileNetStore(fake.env(MODEL_ENV)).config.acl;
    const names = (l: any) => aclEntriesFor(cfg, l).map((e) => `${e.granteeName}:${e.accessMask}`);
    assert.deepEqual(names('SEALED'), ['svc_tf:998903']);
    assert.deepEqual(names('COMMITTEE'), ['svc_tf:998903', 'TF Committee:131201', 'TF Auditors:131201']);
    assert.deepEqual(names('PUBLIC'), ['svc_tf:998903', 'TF Public:131201', 'TF Staff:131201', 'TF Committee:131201', 'TF Auditors:131201']);
    assert.deepEqual(names('INTERNAL'), ['svc_tf:998903', 'TF Staff:131201', 'TF Auditors:131201']);
    assert.deepEqual(names('AUDIT'), ['svc_tf:998903', 'TF Auditors:131201']);
    assert.throws(() => permissionsLiteral([{ granteeName: 'a" } ] }', access: 'VIEW_CONTENT', accessMask: 131201 }]), /invalid grantee/);
  });

  test('written at create (documentProperties.permissions.replace) and read back; a refused list never breaks the upload', async () => {
    defineTfModel(fake);
    const s = new FileNetStore(fake.env(MODEL_ENV));
    const bid = await putAs(s, 'BID_FINANCIAL', { TF_BidId: 'b-9' });
    assert.deepEqual(objOf(s, bid.storeRef).acl, [{ granteeName: 'svc_tf', accessMask: 998903 }]);
    assert.match(fake.graphqlOps('TfCreateDocument')[0].query!, /permissions: \{ replace: \[\{ type: ACCESS_PERMISSION, subAccessPermission: \{ accessType: ALLOW, inheritableDepth: 0, accessMask: 998903, granteeName: "svc_tf" \} \}\] \}/);
    assert.equal((bid.meta?.acl as any).status, 'APPLIED');
    assert.equal((bid.meta?.acl as any).level, 'SEALED');
    assert.equal(fake.graphqlOps('TfPermissions').length, 1, 'read back after create');

    fake.knownGrantees = new Set(['svc_tf', 'TF Staff']); // "TF Auditors" does not exist in the directory
    const v = await putAs(s, 'VENDOR');
    assert.equal(objOf(s, v.storeRef).cls, 'TF_VendorDocument', 'class kept: only the permission list was dropped');
    assert.equal(objOf(s, v.storeRef).acl, null);
    assert.equal((v.meta?.acl as any).status, 'FAILED');
    assert.match((v.meta?.acl as any).error, /E_BAD_SECURITY_PRINCIPAL: grantee TF Auditors/);

    fake.knownGrantees = null;
    const r = await s.setAccess(v.storeRef, 'INTERNAL');
    assert.equal(r.ok, true);
    assert.deepEqual(objOf(s, v.storeRef).acl!.map((x) => x.granteeName), ['svc_tf', 'TF Staff', 'TF Auditors']);
  });

  test('ACL mode off: no permission list is written', async () => {
    const s = new FileNetStore(fake.env());
    const out = await putAs(s, 'BID_TECHNICAL');
    assert.equal(objOf(s, out.storeRef).acl, null);
    assert.doesNotMatch(fake.graphqlOps('TfCreateDocument')[0].query!, /permissions:/);
    assert.deepEqual(await s.setAccess(out.storeRef, 'COMMITTEE'), { ok: false, detail: 'FILENET_ACL_MODE=off' });
  });
});

describe('search where-clause (CE SQL)', () => {
  test('always tenant + current version first; values from whitelists only', () => {
    assert.equal(buildSearchWhere({ tenantId: 'kea' }, 'model'), "TF_TenantId = 'kea' AND IsCurrentVersion = TRUE");
    assert.equal(buildSearchWhere({ tenantId: 'kea', q: 'rfp pack', tenderNumber: 'KEA-2026-102', ownerType: 'TENDER_PACK' }, 'model'),
      "TF_TenantId = 'kea' AND IsCurrentVersion = TRUE AND TF_TenderNumber = 'KEA-2026-102' AND TF_OwnerType = 'TENDER_PACK' AND DocumentTitle LIKE '%rfp pack%'");
    assert.equal(buildSearchWhere({ tenantId: 'kea', tenderNumber: 'KEA-2026-102', tenderId: '0F6B5E1A-1111-4222-8333-944445555666', ownerType: 'VENDOR' }, 'legacy'),
      "TF_TenantId = 'kea' AND IsCurrentVersion = TRUE AND TF_TenderId = '0f6b5e1a-1111-4222-8333-944445555666' AND TF_DocType = 'VENDOR'");
    assert.equal(buildSearchWhere({ tenantId: 'kea', q: 'كراسة الشروط' }, 'model'), "TF_TenantId = 'kea' AND IsCurrentVersion = TRUE AND DocumentTitle LIKE '%كراسة الشروط%'");
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ q: "x' OR '1'='1" }, /q may contain only/], [{ q: 'a%' }, /q may contain only/], [{ q: 'a\\b' }, /q may contain only/], [{ q: 'x'.repeat(65) }, /q may contain only/],
      [{ tenderNumber: "KEA' OR TF_TenantId <> 'x" }, /tenderNumber/], [{ tenderNumber: 'A B' }, /tenderNumber/], [{ ownerType: 'TENDER_PACK OR 1=1' }, /documentType must be one of/],
      [{ tenantId: "kea' OR '1'='1" }, /invalid tenant/], [{ tenderNumber: 'KEA--1' }, /unsafe/],
    ];
    for (const [c, re] of bad) assert.throws(() => buildSearchWhere({ tenantId: 'kea', ...c } as any, 'model'), (e: any) => e instanceof SearchInputError && re.test(e.message), JSON.stringify(c));
    assert.throws(() => buildSearchWhere({ tenantId: 'kea', tenderNumber: 'KEA-1', tenderId: "x' OR 1=1" }, 'legacy'), /unknown tender number/);
  });
});

describe('Navigator / ACCE link routing', () => {
  let probeServer: http.Server; let probeOrigin = ''; const seen: { method: string; auth: boolean; cookie: boolean }[] = [];
  before(async () => {
    probeServer = http.createServer((req, res) => {
      seen.push({ method: String(req.method), auth: !!req.headers.authorization, cookie: !!req.headers.cookie });
      if (req.url?.startsWith('/navigator')) { res.statusCode = req.method === 'HEAD' ? 405 : 200; res.end('icn'); return; } // HEAD refused → GET
      res.statusCode = 404; res.end();
    });
    probeServer.listen(0, '127.0.0.1'); await once(probeServer, 'listening');
    probeOrigin = `http://127.0.0.1:${(probeServer.address() as AddressInfo).port}`;
  });
  after(async () => { await new Promise<void>((r) => probeServer.close(() => r())); });
  beforeEach(() => { fake.reset(); resetNavigatorProbeCache(); });

  const staff = { id: 'u', username: 'officer', roles: ['PROCUREMENT_OFFICER'], tenantId: 'kea' } as any;
  const vendor = { id: 'v', username: 'vendor1', roles: ['VENDOR'], tenantId: 'kea', vendorId: 'vend-1' } as any;
  const row = (s: FileNetStore, ref: string, cls: string) => ({ store_type: 'filenet', store_ref: ref, store_meta: { objectId: s.parseStoreRef(ref).id, className: cls, versionSeriesId: '{VS-1}', folderPath: '/TenderFlow/kea/T/TENDER_PACK' } }) as any;

  test('settings: configured, derived from the GraphQL origin, off; ACCE derived / configured / off', () => {
    assert.deepEqual(navigatorSettings({ FILENET_NAVIGATOR_URL: 'https://icn.kbm.test/navigator/' }, 'https://cpe.kbm.test:9443/content-services-graphql/graphql')?.candidates, ['https://icn.kbm.test/navigator']);
    const d = navigatorSettings({ FILENET_OBJECT_STORE: 'OS1' }, 'https://cpe.kbm.test:9443/content-services-graphql/graphql')!;
    assert.equal(d.mode, 'derived');
    assert.deepEqual(d.candidates, ['https://cpe.kbm.test:9443/navigator', 'https://cpe.kbm.test:9443/icn/navigator']);
    assert.equal(navigatorSettings({ FILENET_NAVIGATOR_URL: 'off' }, 'https://cpe/graphql'), null);
    assert.equal(navigatorSettings({ FILENET_NAVIGATOR_URL: 'http://u:p@icn/navigator' }, 'https://cpe/graphql'), null, 'no credentials in URLs');
    assert.equal(acceUrl({}, 'https://cpe.kbm.test:9443/content-services-graphql/graphql'), 'https://cpe.kbm.test:9443/acce');
    assert.equal(acceUrl({ FILENET_ACCE_URL: 'https://acce.kbm.test/acce/' }, 'https://cpe/graphql'), 'https://acce.kbm.test/acce');
    assert.equal(acceUrl({ FILENET_ACCE_URL: 'off' }, 'https://cpe/graphql'), null);
  });

  test('derived: the first candidate that answers is used; links open the exact version; the probe sends no credentials and is cached', async () => {
    fake.probeStatus.set('/icn/navigator/', 302); // /navigator answers 404, /icn/navigator redirects to its login
    const s = new FileNetStore(fake.env());
    const out = await putAs(s, 'TENDER_PACK');
    const links = await evidenceLinks({ store: withTelemetry(s) } as any, staff, row(s, out.storeRef, 'Document'), null);
    const origin = new URL(fake.url).origin;
    assert.equal(links.navigator?.source, 'derived');
    assert.equal(links.navigator?.reachable, true);
    const u = new URL(links.navigator!.url);
    assert.equal(`${u.origin}${u.pathname}`, `${origin}/icn/navigator/bookmark.jsp`);
    assert.equal(u.searchParams.get('docid'), `Document,${OS_GUID},${s.parseStoreRef(out.storeRef).id}`);
    assert.equal(u.searchParams.get('repositoryId'), 'OS1');
    assert.equal(links.acce?.url, `${origin}/acce`);
    assert.equal(links.objectId, s.parseStoreRef(out.storeRef).id);
    assert.ok(fake.probes.length >= 2 && fake.probes.every((p) => !p.authorization && !p.cookie), JSON.stringify(fake.probes));
    const n = fake.probes.length;
    await evidenceLinks({ store: s } as any, staff, row(s, out.storeRef, 'Document'), null);
    assert.equal(fake.probes.length, n, 'cached for 5 minutes');
  });

  test('configured: HEAD refused → GET; vendors get the object id only', async () => {
    const s = new FileNetStore(fake.env({ FILENET_NAVIGATOR_URL: `${probeOrigin}/navigator`, FILENET_NAVIGATOR_DESKTOP: 'TenderFlow', FILENET_ACCE_URL: 'off' }));
    const out = await putAs(s, 'TENDER_PACK');
    const links = await evidenceLinks({ store: s } as any, staff, row(s, out.storeRef, 'TF_TenderDocument'), null);
    assert.equal(links.navigator?.source, 'configured');
    assert.equal(links.navigator?.reachable, true);
    assert.ok(links.navigator!.url.startsWith(`${probeOrigin}/navigator/bookmark.jsp?desktop=TenderFlow&`));
    assert.equal(links.acce, undefined, 'FILENET_ACCE_URL=off');
    assert.deepEqual(seen.slice(-2).map((x) => x.method), ['HEAD', 'GET']);
    assert.ok(seen.every((x) => !x.auth && !x.cookie));
    const v = await evidenceLinks({ store: s } as any, vendor, row(s, out.storeRef, 'TF_TenderDocument'), null);
    assert.deepEqual(Object.keys(v).sort(), ['objectId', 'path', 'versionSeriesId']);
  });

  test('unreachable: the link is still given, flagged reachable:false, with ACCE; off: no Navigator link', async () => {
    const s = new FileNetStore(fake.env()); // nothing answers on /navigator or /icn/navigator (404)
    const out = await putAs(s, 'TENDER_PACK');
    const links = await evidenceLinks({ store: s } as any, staff, row(s, out.storeRef, 'Document'), null);
    assert.equal(links.navigator?.reachable, false);
    assert.ok(links.navigator!.url.startsWith(`${new URL(fake.url).origin}/navigator/bookmark.jsp?`), 'first candidate');
    assert.ok(links.acce?.url);
    const nav = await s.resolveNavigator();
    assert.deepEqual(nav!.tried.map((t) => t.status), [404, 404]);

    const off = new FileNetStore(fake.env({ FILENET_NAVIGATOR_URL: 'off' }));
    const l2 = await evidenceLinks({ store: off } as any, staff, row(off, out.storeRef, 'Document'), null);
    assert.equal(l2.navigator, undefined);
    assert.ok(l2.acce?.url, 'ACCE stays available');
    assert.equal(l2.objectId, s.parseStoreRef(out.storeRef).id);
  });

  test('a configured Navigator that is down (connection refused) is reported, never presented as working', async () => {
    const s = new FileNetStore(fake.env({ FILENET_NAVIGATOR_URL: 'http://127.0.0.1:9/navigator' }));
    const nav = await s.resolveNavigator();
    assert.equal(nav?.reachable, false);
    assert.equal(nav?.status, null);
    assert.ok(nav?.tried[0].error);
  });
});

describe('AI properties on the model class', () => {
  beforeEach(() => fake.reset());
  test('written and read back when the class has them; skipped (not thrown) when it does not', async () => {
    defineTfModel(fake);
    fake.strictProperties = true;
    const s = new FileNetStore(fake.env({ FILENET_CLASS_MODEL: 'subclasses' }));
    const out = await putAs(s, 'VENDOR');
    const r = await s.setModelProperties(out.storeRef, 'TF_VendorDocument', { TF_AiClassification: 'COMMERCIAL_REGISTRATION', TF_AiConfidence: 0.75 });
    assert.equal(r.ok, true, r.detail);
    assert.equal(objOf(s, out.storeRef).props.TF_AiClassification, 'COMMERCIAL_REGISTRATION');
    assert.equal(objOf(s, out.storeRef).props.TF_AiConfidence, 0.75);
    assert.match(fake.graphqlOps('TfSetModelProperties')[0].query!, /\{TF_AiClassification: "COMMERCIAL_REGISTRATION"\} \{TF_AiConfidence: 0\.75\}/);

    fake.classProps.set('TF_Document', fake.classProps.get('TF_Document')!.filter((p) => !p.startsWith('TF_Ai')));
    const s2 = new FileNetStore(fake.env({ FILENET_CLASS_MODEL: 'subclasses' }));
    const r2 = await s2.setModelProperties(out.storeRef, 'TF_VendorDocument', { TF_AiClassification: 'X', TF_AiConfidence: 0.1 });
    assert.equal(r2.ok, false);
    assert.match(r2.detail, /has none of TF_AiClassification, TF_AiConfidence/);
    const r3 = await s2.setModelProperties(out.storeRef, 'Document', { TF_AiClassification: 'X' });
    assert.equal(r3.ok, false);
  });
});

// ================================================================== API level: real app + fake FileNet + fake Orchestrate

describe('API with FileNet (class model, ACLs, search, evidence, opening)', () => {
  let run: Running;
  let orch: FakeOrchestrate;
  const tok: Record<string, string> = {};
  const q = <T = any>(sql: string, p: unknown[] = []) => run.handle.ctx.db.query<T>(sql, p);
  const docOf = async (id: string) => (await q<any>('SELECT * FROM documents WHERE id=$1', [id]))[0];
  const fakeObj = async (id: string) => fake.docs.get((await docOf(id)).store_meta.objectId)!;
  let packId: string; let bidDocIds: string[]; let tenderId: string;

  before(async () => {
    fake.reset();
    resetNavigatorProbeCache();
    defineTfModel(fake);
    fake.strictProperties = true;
    fake.probeStatus.set('/navigator/', 302);
    orch = await startFakeOrchestrate();
    orch.reply = (c) => (c.agentName === 'tenderflow_document_intelligence' ? crReply(c.prompt) : '{}');
    Object.assign(process.env, orch.env);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-fn-ent-'));
    const config = loadConfig({ BID_MASTER_KEY, AUDIT_SIGNING_KEY, DATA_DIR: dataDir, SEED_DEMO: 'true', DEMO_PASSWORD, CONTENT_STORE_TYPE: 'filenet',
      PUBLIC_BASE_URL: 'http://tenderflow.test', LOGIN_RATE_LIMIT_PER_MIN: '1000', WEB_DIST_DIR: path.join(dataDir, 'no-web'), DOC_AI_AUTO: 'false', WXO_TIMEOUT_MS: '10000', TENANCY_MODE: 'shared' }); // several demo entities
    const store = withTelemetry(new FileNetStore(fake.env(MODEL_ENV)));
    const handle = await createApp(config, { store });
    const server = handle.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    run = { handle, dataDir, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, stop: async () => { await new Promise<void>((r) => server.close(() => r())); await handle.close(); } };
    for (const u of ['officer', 'chair', 'evaluator1', 'director', 'admin', 'auditor', 'vendor1', 'vendor2', 'vendor4']) tok[u] = await login(run, 'kea', u, DEMO_PASSWORD);
    tok.gciaOfficer = await login(run, 'gcia', 'officer', DEMO_PASSWORD);
    packId = (await q<{ id: string }>(`SELECT d.id FROM documents d JOIN tenders t ON t.id=d.tender_id WHERE t.tenant_id='kea' AND t.tender_number='KEA-2026-102' AND d.owner_type='TENDER_PACK' ORDER BY d.created_at LIMIT 1`))[0].id;
    tenderId = (await q<{ id: string }>(`SELECT id FROM tenders WHERE tenant_id='kea' AND tender_number='KEA-2026-088'`))[0].id;
    bidDocIds = (await q<{ id: string }>(`SELECT id FROM documents WHERE tender_id=$1 AND owner_type LIKE 'BID_%' ORDER BY created_at`, [tenderId])).map((r) => r.id);
  });
  after(async () => {
    await run?.stop(); await orch?.close();
    for (const k of Object.keys(orch?.env ?? {})) delete process.env[k];
  });

  test('seeded documents are in their subclasses, with model properties and the permission list of their level', async () => {
    const pack = await fakeObj(packId);
    assert.equal(pack.cls, 'TF_TenderDocument');
    assert.equal(pack.props.TF_OwnerType, 'TENDER_PACK');
    assert.equal(pack.props.TF_TenderNumber, 'KEA-2026-102');
    assert.equal(pack.props.TF_Confidentiality, 'PUBLIC');
    assert.equal(pack.props.TF_TenantId, 'kea');
    assert.deepEqual(pack.acl!.map((a) => a.granteeName), ['svc_tf', 'TF Public', 'TF Staff', 'TF Committee', 'TF Auditors']);
    assert.ok(bidDocIds.length >= 3);
    for (const id of bidDocIds) {
      const o = await fakeObj(id);
      assert.equal(o.cls, 'TF_BidEnvelope');
      assert.equal(o.props.TF_Confidentiality, 'SEALED');
      assert.ok(o.props.TF_BidId);
      assert.deepEqual(o.acl, [{ granteeName: 'svc_tf', accessMask: 998903 }], 'sealed: nobody but the service user');
      assert.equal((await docOf(id)).store_meta.acl.status, 'APPLIED');
    }
  });

  test('evidence (staff): class, model properties, security and a derived Navigator link + ACCE', async () => {
    const r = await api(run, 'GET', `/api/v1/documents/${packId}/evidence`, { token: tok.officer });
    assert.equal(r.status, 200, r.text);
    const e = r.body;
    assert.equal(e.className, 'TF_TenderDocument');
    assert.equal(e.repository.properties.TF_OwnerType, 'TENDER_PACK');
    assert.equal(e.repository.properties.TF_Confidentiality, 'PUBLIC');
    assert.equal(e.access.mode, 'groups');
    assert.equal(e.access.level, 'PUBLIC');
    assert.equal(e.access.status, 'APPLIED');
    assert.ok(e.access.grantees.some((g: any) => g.name === 'TF Public' && g.access === 'VIEW_CONTENT'));
    const origin = new URL(fake.url).origin;
    assert.equal(e.links.navigator.reachable, true);
    assert.equal(e.links.navigator.source, 'derived');
    assert.ok(e.links.navigator.url.startsWith(`${origin}/navigator/bookmark.jsp?`));
    assert.ok(e.links.navigator.url.includes(encodeURIComponent(`TF_TenderDocument,${OS_GUID},${e.objectId}`)));
    assert.equal(e.navigatorUrl, e.links.navigator.url);
    assert.equal(e.links.acce.url, `${origin}/acce`);
    assert.equal(e.links.objectId, e.objectId);
    assert.equal(e.objectStore, 'OS1');
  });

  test('evidence (vendor): no repository internals — no object store, ACL groups, service account or links', async () => {
    const r = await api(run, 'GET', `/api/v1/documents/${packId}/evidence`, { token: tok.vendor1 });
    assert.equal(r.status, 200, r.text);
    const e = r.body;
    assert.equal(e.objectStore, null);
    assert.equal(e.storeRef, null);
    assert.equal(e.classModel, null);
    assert.equal(e.repository.objectStoreId, undefined);
    assert.equal(e.repository.properties, undefined);
    assert.equal(e.repository.creator, undefined);
    assert.equal(e.access.grantees, undefined);
    assert.equal(e.access.level, 'PUBLIC');
    assert.deepEqual(Object.keys(e.links).sort(), ['objectId', 'path', 'versionSeriesId']);
    assert.equal(e.navigatorUrl, null);
    const text = JSON.stringify(e);
    for (const secret of ['TF Public', 'TF Staff', 'svc_tf', OS_GUID, '"OS1"', 'filenet:OS1']) assert.equal(text.includes(secret), false, secret);
    // a vendor's own sealed bid: still nothing internal
    const own = (await q<{ id: string }>(`SELECT d.id FROM documents d JOIN users u ON u.vendor_id=d.vendor_id WHERE d.tender_id=$1 AND u.tenant_id='kea' AND u.username='vendor1' AND d.owner_type='BID_TECHNICAL'`, [tenderId]))[0].id;
    const b = await api(run, 'GET', `/api/v1/documents/${own}/evidence`, { token: tok.vendor1 });
    assert.equal(b.status, 200, b.text);
    assert.equal(b.body.access.level, 'SEALED');
    assert.equal(JSON.stringify(b.body).includes('svc_tf'), false);
  });

  test('POST /documents/:id/filenet-opened audits who opened which object; same access rule as the evidence', async () => {
    const r = await api(run, 'POST', `/api/v1/documents/${packId}/filenet-opened`, { token: tok.officer, json: { target: 'navigator' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.recorded, true);
    const a = await q<any>(`SELECT actor_id, details FROM audit_events WHERE action='FILENET_LINK_OPENED' AND resource_id=$1 ORDER BY seq DESC LIMIT 1`, [packId]);
    assert.equal(a[0].details.target, 'navigator');
    assert.equal(a[0].details.objectId, (await docOf(packId)).store_meta.objectId);
    assert.equal((await api(run, 'POST', `/api/v1/documents/${packId}/filenet-opened`, { token: tok.officer, json: { target: 'ftp' } })).status, 400);
    assert.equal((await api(run, 'POST', `/api/v1/documents/${packId}/filenet-opened`, { token: tok.vendor4, json: { target: 'copy' } })).status, 404, 'pending vendor cannot see the pack');
    assert.equal((await api(run, 'POST', `/api/v1/documents/${bidDocIds[0]}/filenet-opened`, { token: tok.chair, json: { target: 'acce' } })).status, 403, 'sealed bid before the opening');
  });

  test('model and navigator endpoints: admin / auditor only', async () => {
    assert.equal((await api(run, 'GET', '/api/v1/filenet/model', { token: tok.officer })).status, 403);
    assert.equal((await api(run, 'GET', '/api/v1/filenet/navigator', { token: tok.vendor1 })).status, 403);
    const m = await api(run, 'GET', '/api/v1/filenet/model', { token: tok.admin });
    assert.equal(m.status, 200, m.text);
    assert.equal(m.body.mode, 'subclasses');
    assert.equal(m.body.status.ready, true);
    assert.equal(m.body.status.classes.length, 6);
    assert.equal(m.body.acl.mode, 'groups');
    assert.equal(m.body.acl.groups.COMMITTEE, 'TF Committee');
    assert.ok(m.body.spec.classes.find((c: any) => c.name === 'TF_BidEnvelope').properties.some((p: any) => p.name === 'TF_BidId'));
    const n = await api(run, 'GET', '/api/v1/filenet/navigator?refresh=true', { token: tok.auditor });
    assert.equal(n.status, 200, n.text);
    assert.equal(n.body.mode, 'derived');
    assert.equal(n.body.navigator.reachable, true);
    assert.equal(n.body.navigator.status, 302);
    assert.equal(n.body.acce.url, `${new URL(fake.url).origin}/acce`);
    const h = await api(run, 'GET', '/api/v1/filenet/health', { token: tok.admin });
    assert.equal(h.status, 200);
    assert.equal(h.body.config.classModel, 'subclasses');
    assert.equal(h.body.config.aclMode, 'groups');
    assert.equal(h.body.config.navigator.mode, 'derived');
  });

  test('search: staff only, CE SQL scoped to the tenant, sealed bids never shown, unsafe input never reaches FileNet', async () => {
    assert.equal((await api(run, 'GET', '/api/v1/filenet/search', { token: tok.vendor1 })).status, 403);
    const r = await api(run, 'GET', '/api/v1/filenet/search?tenderNumber=KEA-2026-102&documentType=TENDER_PACK', { token: tok.officer });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.from, 'TF_Document');
    assert.equal(r.body.where, "TF_TenantId = 'kea' AND IsCurrentVersion = TRUE AND TF_TenderNumber = 'KEA-2026-102' AND TF_OwnerType = 'TENDER_PACK'");
    assert.ok(r.body.results.some((x: any) => x.documentId === packId && x.className === 'TF_TenderDocument' && x.tenderNumber === 'KEA-2026-102'));
    assert.ok(r.body.results.every((x: any) => x.ownerType === 'TENDER_PACK'));
    const title = (await docOf(packId)).store_meta.name as string;
    const byTitle = await api(run, 'GET', `/api/v1/filenet/search?q=${encodeURIComponent(title.slice(0, 40).replace(/[^\p{L}\p{N} ._-]/gu, ''))}`, { token: tok.officer });
    assert.equal(byTitle.status, 200, byTitle.text);
    assert.ok(byTitle.body.results.some((x: any) => x.documentId === packId));

    // Sealed envelopes exist in FileNet, but nobody sees them through the search before the opening.
    for (const who of ['officer', 'chair']) {
      const b = await api(run, 'GET', '/api/v1/filenet/search?tenderNumber=KEA-2026-088&documentType=BID_TECHNICAL', { token: tok[who] });
      assert.equal(b.status, 200, b.text);
      assert.ok(b.body.repositoryHits >= 3, who);
      assert.equal(b.body.results.length, 0, who);
      assert.equal(b.body.hidden, b.body.repositoryHits);
    }
    // Another entity: its own tenant in the WHERE, never kea's documents.
    const g = await api(run, 'GET', '/api/v1/filenet/search?documentType=TENDER_PACK', { token: tok.gciaOfficer });
    assert.equal(g.status, 200, g.text);
    assert.ok(g.body.where.startsWith("TF_TenantId = 'gcia' AND IsCurrentVersion = TRUE"));
    assert.ok(g.body.results.every((x: any) => x.documentId !== packId));

    const before = fake.graphqlOps('TfSearch').length;
    for (const qs of [`q=${encodeURIComponent("x' OR '1'='1")}`, `tenderNumber=${encodeURIComponent("KEA' OR 1=1 --")}`, 'documentType=EVERYTHING', 'q=a&q=b', `q=${encodeURIComponent('50%')}`]) {
      const bad = await api(run, 'GET', `/api/v1/filenet/search?${qs}`, { token: tok.officer });
      assert.equal(bad.status, 400, `${qs}: ${bad.text}`);
    }
    assert.equal(fake.graphqlOps('TfSearch').length, before, 'rejected input never reaches FileNet');
  });

  test('opening: SEALED → COMMITTEE in FileNet for every opened envelope, requested + changed + audited; the committee then finds them', async () => {
    const o = await api(run, 'POST', `/api/v1/tenders/${tenderId}/open`, { token: tok.chair, json: { attendees: ['Chair (test)', 'Evaluator (test)'], notes: 'test' } });
    assert.equal(o.status, 200, o.text);
    for (let i = 0; i < 100; i++) {
      const rows = await Promise.all(bidDocIds.map(docOf));
      if (rows.every((d) => d.store_meta.acl?.status === 'APPLIED' && d.store_meta.acl?.level === 'COMMITTEE')) break;
      await sleep(50);
    }
    for (const id of bidDocIds) {
      const d = await docOf(id);
      assert.equal(d.store_meta.acl.level, 'COMMITTEE', JSON.stringify(d.store_meta.acl));
      assert.equal(d.store_meta.acl.status, 'APPLIED');
      assert.deepEqual((await fakeObj(id)).acl!.map((a) => a.granteeName), ['svc_tf', 'TF Committee', 'TF Auditors']);
      const audit = await q<any>(`SELECT action, actor_id, prev_state, new_state FROM audit_events WHERE resource_id=$1 AND action LIKE 'FILENET_ACCESS_%' ORDER BY seq`, [id]);
      assert.deepEqual(audit.map((x) => x.action), ['FILENET_ACCESS_CHANGE_REQUESTED', 'FILENET_ACCESS_CHANGED']);
      assert.deepEqual([audit[1].prev_state, audit[1].new_state], ['SEALED', 'COMMITTEE']);
    }
    const chairId = (await q<{ id: string }>(`SELECT id FROM users WHERE tenant_id='kea' AND username='chair'`))[0].id;
    assert.ok((await q<any>(`SELECT actor_id FROM audit_events WHERE action='FILENET_ACCESS_CHANGED' AND resource_id=$1`, [bidDocIds[0]])).every((a) => a.actor_id === chairId));
    const ev = await api(run, 'GET', `/api/v1/documents/${bidDocIds[0]}/evidence`, { token: tok.chair });
    assert.equal(ev.status, 200, ev.text);
    assert.equal(ev.body.access.level, 'COMMITTEE');
    assert.equal(ev.body.access.status, 'APPLIED');
    const s = await api(run, 'GET', '/api/v1/filenet/search?tenderNumber=KEA-2026-088&documentType=BID_TECHNICAL', { token: tok.chair });
    assert.ok(s.body.results.length >= 3, 'opened envelopes are visible to the committee');
    const off = await api(run, 'GET', '/api/v1/filenet/search?tenderNumber=KEA-2026-088&documentType=BID_TECHNICAL', { token: tok.officer });
    assert.equal(off.body.results.length, 0, 'the officer still cannot read bids');
  });

  test('two envelopes: technical envelopes open at the opening; financial ones only for bids that passed', async () => {
    const gt: Record<string, string> = {};
    for (const u of ['chair', 'evaluator1']) gt[u] = await login(run, 'gcia', u, DEMO_PASSWORD);
    const jetty = (await q<{ id: string }>(`SELECT id FROM tenders WHERE tenant_id='gcia' AND title_en='Marine Jetty Rehabilitation'`))[0].id;
    const docs = async () => q<any>(`SELECT d.id, d.owner_type, d.bid_id, d.store_meta FROM documents d WHERE d.tender_id=$1 AND d.owner_type LIKE 'BID_%' ORDER BY d.created_at`, [jetty]);
    const settle = async (pred: (rows: any[]) => boolean) => { for (let i = 0; i < 100; i++) { if (pred(await docs())) return; await sleep(50); } };
    const o = await api(run, 'POST', `/api/v1/tenders/${jetty}/open`, { token: gt.chair, json: { attendees: ['Chair (test)'] } });
    assert.equal(o.status, 200, o.text);
    await settle((rows) => rows.filter((d) => d.owner_type === 'BID_TECHNICAL').every((d) => d.store_meta.acl?.status === 'APPLIED' && d.store_meta.acl.level === 'COMMITTEE'));
    let rows = await docs();
    assert.ok(rows.filter((d) => d.owner_type === 'BID_TECHNICAL').every((d) => d.store_meta.acl.level === 'COMMITTEE'));
    assert.ok(rows.filter((d) => d.owner_type === 'BID_FINANCIAL').every((d) => d.store_meta.acl.level === 'SEALED'), 'financial envelopes stay sealed');
    for (const d of rows.filter((x) => x.owner_type === 'BID_FINANCIAL')) assert.deepEqual((await fakeObj(d.id)).acl!.map((a) => a.granteeName), ['svc_tf']);

    const bidIds = [...new Set(rows.map((d) => d.bid_id as string))];
    const scores = (n: number) => ({ scores: [{ criterion: 'technical', score: n, comment: 't' }, { criterion: 'experience', score: n, comment: 'e' }] });
    assert.equal((await api(run, 'POST', `/api/v1/bids/${bidIds[0]}/evaluation`, { token: gt.evaluator1, json: scores(90) })).status, 200);
    assert.equal((await api(run, 'POST', `/api/v1/bids/${bidIds[1]}/evaluation`, { token: gt.evaluator1, json: scores(20) })).status, 200);
    const f = await api(run, 'POST', `/api/v1/tenders/${jetty}/open-financial`, { token: gt.chair, json: {} });
    assert.equal(f.status, 200, f.text);
    await settle((r) => r.some((d) => d.owner_type === 'BID_FINANCIAL' && d.store_meta.acl.level === 'COMMITTEE' && d.store_meta.acl.status === 'APPLIED'));
    rows = await docs();
    const fin = (bid: string) => rows.find((d) => d.owner_type === 'BID_FINANCIAL' && d.bid_id === bid)!;
    assert.deepEqual([fin(bidIds[0]).store_meta.acl.level, fin(bidIds[0]).store_meta.acl.status], ['COMMITTEE', 'APPLIED'], 'passed: financial envelope opened in FileNet');
    assert.equal(fin(bidIds[1]).store_meta.acl.level, 'SEALED', 'failed the technical stage: stays sealed in FileNet');
    assert.deepEqual((await fakeObj(fin(bidIds[1]).id)).acl!.map((a) => a.granteeName), ['svc_tf']);
  });

  test('failures are recorded and retried by the filenet-access-retry job; uploads succeed meanwhile', async () => {
    fake.failPermissions = 'FNRCE0003E: E_ACCESS_DENIED: the user does not have WRITE_ACL on this object';
    const up = await api(run, 'POST', '/api/v1/vendors/me/documents', { token: tok.vendor2, form: fileForm({ title: 'Profile', file: { name: 'profile.md', content: '# Company profile\nFictitious.' } }) });
    assert.equal(up.status, 201, up.text);
    let d = await docOf(up.body.id);
    assert.equal(d.store_meta.acl.status, 'FAILED');
    assert.equal(d.store_meta.acl.level, 'INTERNAL');
    assert.match(d.store_meta.acl.error, /WRITE_ACL/);
    assert.equal((await fakeObj(up.body.id)).cls, 'TF_VendorDocument', 'the document itself was stored');

    const sys = { id: (await q<{ id: string }>(`SELECT id FROM users WHERE tenant_id='kea' AND username='admin'`))[0].id, roles: ['TENANT_ADMIN'] };
    assert.equal(await changeAccess(run.handle.ctx, sys, d, 'AUDIT', 'TEST'), false);
    d = await docOf(up.body.id);
    assert.deepEqual([d.store_meta.acl.level, d.store_meta.acl.status, d.store_meta.acl.attempts], ['AUDIT', 'FAILED', 1]);
    const r1 = await runJob(run.handle.ctx, ACCESS_RETRY_JOB, { trigger: 'MANUAL', tenantId: 'kea' });
    assert.equal(r1.status, 'OK');
    assert.ok((r1.result as any).failed >= 1);
    assert.equal((await docOf(up.body.id)).store_meta.acl.attempts, 2);

    fake.failPermissions = null;
    const r2 = await runJob(run.handle.ctx, ACCESS_RETRY_JOB, { trigger: 'MANUAL', tenantId: 'kea' });
    assert.equal(r2.status, 'OK', r2.error);
    assert.ok((r2.result as any).applied >= 1);
    d = await docOf(up.body.id);
    assert.deepEqual([d.store_meta.acl.level, d.store_meta.acl.status], ['AUDIT', 'APPLIED']);
    assert.deepEqual((await fakeObj(up.body.id)).acl!.map((a) => a.granteeName), ['svc_tf', 'TF Auditors']);
    const audit = await q<any>(`SELECT action, actor_id FROM audit_events WHERE resource_id=$1 AND action LIKE 'FILENET_ACCESS_%' ORDER BY seq`, [up.body.id]);
    assert.deepEqual(audit.map((x) => x.action), ['FILENET_ACCESS_CHANGE_REQUESTED', 'FILENET_ACCESS_CHANGE_FAILED', 'FILENET_ACCESS_CHANGE_FAILED', 'FILENET_ACCESS_CHANGED']);
    assert.equal(audit[3].actor_id, 'SYSTEM');
    // nothing left to retry; a document past the attempt limit is reported, not retried forever
    await q(`UPDATE documents SET store_meta = jsonb_set(store_meta, '{acl}', (store_meta->'acl') || '{"status":"FAILED","attempts":10}'::jsonb) WHERE id=$1`, [up.body.id]);
    const r3 = await runJob(run.handle.ctx, ACCESS_RETRY_JOB, { trigger: 'MANUAL', tenantId: 'kea' });
    assert.deepEqual([(r3.result as any).checked, (r3.result as any).gaveUp], [0, 1]);
    const jobs = await api(run, 'GET', '/api/v1/admin/jobs', { token: tok.admin });
    if (jobs.status === 200) assert.ok(JSON.stringify(jobs.body).includes(ACCESS_RETRY_JOB));
  });

  test('classification writes TF_AiClassification / TF_AiConfidence on the FileNet object (before review), audited', async () => {
    const up = await api(run, 'POST', '/api/v1/vendors/me/documents', { token: tok.vendor1, form: fileForm({ title: 'CR', file: { name: 'cr.md', content: CR_TEXT } }) });
    assert.equal(up.status, 201, up.text);
    const c = await api(run, 'POST', `/api/v1/documents/${up.body.id}/ai/classify`, { token: tok.officer });
    assert.equal(c.status, 201, c.text);
    const o = await fakeObj(up.body.id);
    assert.equal(o.props.TF_AiClassification, 'COMMERCIAL_REGISTRATION');
    assert.equal(typeof o.props.TF_AiConfidence, 'number');
    const meta = (await docOf(up.body.id)).store_meta.aiClassification;
    assert.equal(meta.status, 'WRITTEN');
    assert.equal(meta.confidence, o.props.TF_AiConfidence);
    assert.ok(meta.confidence > 0 && meta.confidence <= 1);
    const audit = await q<any>(`SELECT details FROM audit_events WHERE resource_id=$1 AND action='FILENET_AI_PROPERTIES_WRITTEN'`, [up.body.id]);
    assert.equal(audit.length, 1);
    // evidence shows it to staff; a direct call on a document of another store type is a no-op
    const ev = await api(run, 'GET', `/api/v1/documents/${up.body.id}/evidence`, { token: tok.officer });
    assert.equal(ev.body.repository.properties.TF_AiClassification, 'COMMERCIAL_REGISTRATION');
    assert.equal(ev.body.aiClassification.status, 'WRITTEN');
    assert.equal(await writeAiClassification(run.handle.ctx, { id: 'SYSTEM', roles: ['SYSTEM'] }, { ...(await docOf(up.body.id)), store_type: 'filesystem' }, 'X', [], []), null);
  });

  test('auditor evidence pack: stored as TF_EvidencePack (AUDIT level); its evidence opens in FileNet for auditors only', async () => {
    const g = await api(run, 'POST', '/api/v1/audit/evidence-pack', { token: tok.auditor, json: { tenderId } });
    assert.equal(g.status, 201, g.text);
    const o = await fakeObj(g.body.documentId);
    assert.equal(o.cls, 'TF_EvidencePack');
    assert.equal(o.props.TF_Confidentiality, 'AUDIT');
    assert.deepEqual(o.acl!.map((a) => a.granteeName), ['svc_tf', 'TF Auditors']);
    const e = await api(run, 'GET', `/api/v1/documents/${g.body.documentId}/evidence`, { token: tok.auditor });
    assert.equal(e.status, 200, e.text);
    assert.ok(e.body.links.navigator.url.includes(encodeURIComponent(`TF_EvidencePack,${OS_GUID},`)));
    assert.equal((await api(run, 'GET', `/api/v1/documents/${g.body.documentId}/evidence`, { token: tok.officer })).status, 404);
  });

  test('audit chain stays valid', async () => {
    const r = await api(run, 'GET', '/api/v1/audit/verify', { token: tok.auditor });
    assert.equal(r.status, 200);
    assert.equal(r.body.valid, true);
  });
});

const CR_TEXT = `# Commercial Registration Certificate

## Registration
CR No: CR-100001
Company: Qamar Arcwave Systems W.L.L.

## Validity
Issue date: 01/02/2024
Expiry date: 15/03/2031
`;

/** Minimal fake document-intelligence reply: a cited CR number and expiry date from the prompt. */
function crReply(prompt: string): string {
  const m = /\[DOC ([^|\]]+) \| ([^|\]]*) \| ([^\]]+)\]\n([\s\S]*?)(?=\n\n\[DOC |\nEND DOCUMENTS)/g;
  const secs: { id: string; section: string; text: string }[] = [];
  for (let x = m.exec(prompt); x; x = m.exec(prompt)) secs.push({ id: x[1].trim(), section: x[3].trim(), text: x[4] });
  const field = (key: string, re: RegExp) => {
    for (const s of secs) for (const line of s.text.split('\n')) { const g = line.match(re); if (g) return { key, value: g[1].trim(), citation: { section: s.section, quote: line.trim() } }; }
    return null;
  };
  return JSON.stringify({
    docType: 'COMMERCIAL_REGISTRATION', language: 'en', summaryEn: '[FAKE] CR.', summaryAr: '[FAKE] سجل تجاري.',
    citations: secs.slice(0, 1).map((s) => ({ documentId: s.id, section: s.section })),
    fields: [field('crNumber', /^CR No:\s*(.+)$/), field('expiryDate', /^Expiry date:\s*(.+)$/)].filter(Boolean),
  });
}

test('Windows: scripts/windows/filenet-check.cmd runs the build-free verify with CRLF line endings', () => {
  const root = path.resolve(import.meta.dirname, '../../..');
  const raw = fs.readFileSync(path.join(root, 'scripts/windows/filenet-check.cmd'), 'utf8');
  assert.ok(raw.split('\n').slice(0, -1).every((l) => l.endsWith('\r')), 'every line ends with CRLF');
  assert.match(raw, /node --import tsx services\\api\\src\\tools\\verify-filenet\.ts/);
  assert.ok(fs.existsSync(path.join(root, 'services/api/src/tools/verify-filenet.ts')));
  assert.match(fs.readFileSync(path.join(root, '.gitattributes'), 'utf8'), /^\*\.cmd text eol=crlf$/m);
});
