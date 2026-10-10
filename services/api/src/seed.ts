// Demo seed (docs/BUILD-SPEC.md §7). Runs once on first start when SEED_DEMO=true and no tenants exist.
// Everything goes through the real services: files land in the configured content store and bids are
// really encrypted. All organisations and people are fictitious.
import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from './ctx.js';
import type { Actor } from './auth/tokens.js';
import { REPO_ROOT } from './config.js';
import { setClockOffset } from './util.js';
import { createTenant, createUser, type UserRow } from './services/identity.js';
import { registerVendor, decideVendor } from './services/vendors.js';
import * as tenders from './services/tenders.js';
import { submitBid } from './services/bids.js';
import type { UploadFile } from './services/documents.js';
import { SYSTEM_ACTOR } from './services/audit.js';
import { installStarterTemplates } from './services/templates.js';
import { installDemoLowcode } from './lowcode/seed-content.js';
import { setClassification, upsertActivityCode, purchaseDocuments } from './services/eligibility.js';
import { createRequest } from './services/requests.js';
import { seedMoi } from './seed-moi.js';

export const SEED_FILES_DIR = path.join(REPO_ROOT, 'seed', 'files');

const STAFF = [
  { username: 'officer', displayName: 'Officer Noura Al-Fictitious', roles: ['PROCUREMENT_OFFICER'] },
  { username: 'director', displayName: 'Director Yousef Al-Sample', roles: ['DIRECTOR'] },
  { username: 'undersecretary', displayName: 'Undersecretary Sara Al-Placeholder', roles: ['UNDERSECRETARY'] },
  { username: 'chair', displayName: 'Chair Mariam Al-Demo', roles: ['COMMITTEE_CHAIR'] },
  { username: 'evaluator1', displayName: 'Evaluator Hamad Testa', roles: ['EVALUATOR'] },
  { username: 'evaluator2', displayName: 'Evaluator Lulwa Exampli', roles: ['EVALUATOR'] },
  { username: 'admin', displayName: 'Tenant Admin', roles: ['TENANT_ADMIN'] },
  { username: 'auditor', displayName: 'Auditor Fahad Mockery', roles: ['AUDITOR'] },
];

const VENDORS = [
  { username: 'vendor1', en: 'Qamar Arcwave Systems W.L.L. (fictitious)', ar: 'قمر آركويف للأنظمة ذ.م.م (وهمية)', cr: 'CR-100001', approve: true },
  { username: 'vendor2', en: 'Nakheel Bitforge Technologies (fictitious)', ar: 'نخيل بت فورج للتقنية (وهمية)', cr: 'CR-100002', approve: true },
  { username: 'vendor3', en: 'Sadu Logic Solutions (fictitious)', ar: 'سدو لوجك للحلول (وهمية)', cr: 'CR-100003', approve: true },
  { username: 'vendor4', en: 'Dana Byteworks Consulting (fictitious)', ar: 'دانة بايت ووركس للاستشارات (وهمية)', cr: 'CR-100004', approve: false },
];

const CRITERIA = [
  { key: 'technical', nameEn: 'Technical solution', nameAr: 'الحل الفني', weight: 50 },
  { key: 'experience', nameEn: 'Experience & team', nameAr: 'الخبرة وفريق العمل', weight: 20 },
  { key: 'price', nameEn: 'Price', nameAr: 'السعر', weight: 30 },
];
const REQUIRED_DOCS = [
  { key: 'CR', nameEn: 'Commercial registration certificate', nameAr: 'شهادة السجل التجاري' },
  { key: 'BID_BOND', nameEn: 'Bid bond (2% of bid value)', nameAr: 'كفالة العطاء الابتدائية (2٪ من قيمة العطاء)' },
  { key: 'ISO27001', nameEn: 'ISO/IEC 27001 certificate', nameAr: 'شهادة ISO/IEC 27001' },
  { key: 'TECH_PROPOSAL', nameEn: 'Technical proposal', nameAr: 'العرض الفني' },
  { key: 'FIN_PROPOSAL', nameEn: 'Financial proposal (priced BOQ)', nameAr: 'العرض المالي (جدول الكميات المسعّر)' },
];

function file(name: string): UploadFile {
  const buffer = fs.readFileSync(path.join(SEED_FILES_DIR, name));
  return { originalname: name, mimetype: name.endsWith('.md') ? 'text/markdown' : 'text/plain', buffer, size: buffer.length };
}
const asActor = (u: UserRow): Actor => ({ id: u.id, tenantId: u.tenant_id, roles: u.roles, vendorId: u.vendor_id, username: u.username, issuer: 'local' });
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const HOUR = 3600_000;

async function seedTenantUsers(ctx: Ctx, tenantId: string, password: string, categories = ['IT']) {
  const users: Record<string, Actor> = {};
  for (const s of STAFF) users[s.username] = asActor(await createUser(ctx, SYSTEM_ACTOR, { tenantId, password, ...s }));
  for (const v of VENDORS) {
    const res = await registerVendor(ctx, {
      tenantId, legalNameEn: v.en, legalNameAr: v.ar, crNumber: v.cr, email: `${v.username}@vendors.example`, phone: '+965 0000 0000',
      categories, username: v.username, password,
    });
    users[v.username] = { id: res.user.id, tenantId, roles: ['VENDOR'], vendorId: res.vendor.id, username: v.username, issuer: 'local' };
    if (v.approve) await decideVendor(ctx, users.officer, res.vendor.id, { decision: 'APPROVE', reason: 'Documents verified (demo seed)' });
  }
  return users;
}

async function codes(ctx: Ctx, admin: Actor, list: [string, string, string][]) {
  for (const [code, nameEn, nameAr] of list) await upsertActivityCode(ctx, admin, { code, nameEn, nameAr });
}

export async function seedDemo(ctx: Ctx): Promise<void> {
  const password = ctx.config.demoPassword!;
  console.log('[seed] creating demo entities, cycle templates, users, vendors, requests and tenders …');

  // ---------------- Entity 1: Kuwait Energy Authority (fictitious) — public tender, one envelope ----------------
  await createTenant(ctx, { id: 'kea', nameEn: 'Kuwait Energy Authority (fictitious)', nameAr: 'هيئة الطاقة الكويتية (وهمية)', primaryColor: '#0B4F6C' });
  await ctx.db.query(`UPDATE tenants SET profile=$1::jsonb WHERE id='kea'`, [JSON.stringify({
    numberingPattern: 'KEA-{YYYY}-{SEQ3}', receiptPattern: 'KEA-R-{YYYY}-{SEQ5}', identityProvider: 'LOCAL',
    channels: { knet: false, gazette: true, capt: false }, fiscalYearStartMonth: 4, logoText: 'KEA', sector: 'Energy and utilities' })]);
  const u = await seedTenantUsers(ctx, 'kea', password);
  await installStarterTemplates(ctx, { ...u.admin, tenantId: 'kea' }, 'PUBLIC_TENDER');
  // Low-code Process Studio content: custom tender / vendor / request fields and process rules (docs/LOW-CODE-STUDIO.md)
  await ctx.db.tx((q) => installDemoLowcode(ctx, q, u.admin, 'kea'));
  await codes(ctx, u.admin, [
    ['IT-01', 'Software and systems integration', 'البرمجيات وتكامل الأنظمة'],
    ['IT-02', 'Networks and telecommunications', 'الشبكات والاتصالات'],
    ['ENG-03', 'Electrical works', 'الأعمال الكهربائية'],
    ['CONS-01', 'IT consulting', 'استشارات تقنية المعلومات'],
  ]);
  const kv = async (n: number) => (await ctx.db.query<{ id: string }>(`SELECT v.id FROM vendors v JOIN users x ON x.vendor_id=v.id WHERE x.tenant_id=$1 AND x.username=$2`, ['kea', `vendor${n}`]))[0].id;
  await setClassification(ctx, u.officer, await kv(1), { activityCode: 'IT-01', grade: 1 });
  await setClassification(ctx, u.officer, await kv(1), { activityCode: 'IT-02', grade: 2 });
  await setClassification(ctx, u.officer, await kv(2), { activityCode: 'IT-01', grade: 2 });
  await setClassification(ctx, u.officer, await kv(3), { activityCode: 'IT-01', grade: 3 });
  await setClassification(ctx, u.officer, await kv(3), { activityCode: 'CONS-01', grade: 1 });

  // Departmental request with the scanned GM letter (stored in the content store → FileNet)
  await createRequest(ctx, u.officer, {
    source: 'LETTER', department: 'Distribution Operations Department', subject: 'Smart meter data management platform',
    description: 'Meter data management platform for 120,000 smart meters with head-end integration, billing interface and an outage dashboard.',
    estimatedBudget: 650000, letterTitle: 'GM letter — smart meter platform (scan)',
  }, file('kea-gm-letter-smart-meters.md'));

  // 1) DRAFT tender with pack files
  const draft = await tenders.createTender(ctx, u.officer, {
    tenderNumber: 'KEA-2026-101', titleEn: 'Enterprise Network Refresh', titleAr: 'تحديث الشبكة المؤسسية', category: 'IT',
    descriptionEn: 'Replacement of core and access network switches across head office and two substations.',
    descriptionAr: 'استبدال محولات الشبكة الرئيسية وشبكة الوصول في المقر الرئيسي ومحطتين فرعيتين.',
    estimatedBudget: 450000, currency: 'KWD', submissionDeadline: iso(21 * 24 * HOUR), criteria: CRITERIA, requiredDocuments: REQUIRED_DOCS,
    eligibility: { activityCodes: ['IT-02'], minGrade: 2 },
    customFields: { fundingSource: 'CAPEX', strategicProject: true, bidBondPercent: 2, securityClearance: true,
      clearanceNotes: 'Substation visits need a security pass: send names and civil ID copies 5 working days before the visit (demo).' },
  });
  await tenders.uploadTenderDocument(ctx, u.officer, draft.id, file('kea-network-refresh-pack.md'), { title: 'Network refresh — tender pack (EN/AR)' });

  // 2) PUBLISHED tender (deadline +2 days) with 2 clarifications
  const pub = await tenders.createTender(ctx, u.officer, {
    tenderNumber: 'KEA-2026-102', titleEn: 'Document Management System', titleAr: 'نظام إدارة الوثائق', category: 'IT',
    descriptionEn: 'Supply and implementation of an enterprise document management system with Arabic OCR.',
    descriptionAr: 'توريد وتنفيذ نظام مؤسسي لإدارة الوثائق مع التعرف الضوئي على النصوص العربية.',
    estimatedBudget: 300000, currency: 'KWD', submissionDeadline: iso(2 * 24 * HOUR), criteria: CRITERIA, requiredDocuments: REQUIRED_DOCS,
    eligibility: { activityCodes: ['IT-01'], minGrade: null },
    customFields: { fundingSource: 'OPEX', budgetLine: 'OPX-2026-031', bidBondPercent: 2, localContentPercent: 30 },
  });
  await tenders.uploadTenderDocument(ctx, u.officer, pub.id, file('kea-dms-rfp-pack.md'), { title: 'DMS RFP pack (EN)' });
  await tenders.uploadTenderDocument(ctx, u.officer, pub.id, file('kea-dms-rfp-pack-ar.md'), { title: 'كراسة شروط نظام إدارة الوثائق (AR)' });
  await tenders.approveTender(ctx, u.director, pub.id, { reason: 'Pack complete' });
  await tenders.publishTender(ctx, u.officer, pub.id);
  const c1 = await tenders.askClarification(ctx, u.vendor1, pub.id, { question: 'Is an on-premises deployment mandatory, or is a private cloud hosted in Kuwait acceptable?' });
  await tenders.answerClarification(ctx, u.officer, c1.id, { answer: 'Section 3.1 of the pack requires on-premises deployment in the Authority data centre. Private cloud is not accepted.' });
  await tenders.askClarification(ctx, u.vendor2, pub.id, { question: 'هل يجب أن تدعم واجهة النظام اللغة العربية بالكامل من اليمين إلى اليسار؟' });

  // 3) CLOSED tender (deadline −1 hour) with 3 sealed bids. The real services are run with the clock
  //    shifted 2 hours back, so the bids are genuinely submitted before the deadline and encrypted.
  setClockOffset(-2 * HOUR);
  try {
    const closed = await tenders.createTender(ctx, u.officer, {
      tenderNumber: 'KEA-2026-088', titleEn: 'IT Service Desk Platform', titleAr: 'منصة مكتب خدمة تقنية المعلومات', category: 'IT',
      descriptionEn: 'Supply, implementation and 3-year support of an ITIL-aligned service desk platform.',
      descriptionAr: 'توريد وتنفيذ ودعم لمدة 3 سنوات لمنصة مكتب خدمة متوافقة مع ITIL.',
      estimatedBudget: 180000, currency: 'KWD', submissionDeadline: iso(-1 * HOUR), criteria: CRITERIA, requiredDocuments: REQUIRED_DOCS,
      eligibility: { activityCodes: ['IT-01'], minGrade: null },
      customFields: { fundingSource: 'OPEX', budgetLine: 'OPX-2026-017', bidBondPercent: 1.5 },
    });
    await tenders.uploadTenderDocument(ctx, u.officer, closed.id, file('kea-it-rfp-pack.md'), { title: 'IT Service Desk RFP pack (EN)' });
    await tenders.uploadTenderDocument(ctx, u.officer, closed.id, file('kea-it-rfp-pack-ar.md'), { title: 'كراسة شروط منصة مكتب الخدمة (AR)' });
    await tenders.approveTender(ctx, u.director, closed.id, {});
    await tenders.publishTender(ctx, u.officer, closed.id);
    for (const n of [1, 2, 3]) {
      await submitBid(ctx, u[`vendor${n}`], closed.id, {
        technical: file(`vendor${n}-technical-proposal.md`), financial: file(`vendor${n}-financial-proposal.md`),
      });
    }
  } finally {
    setClockOffset(0);
  }

  // ---------------- Entity 2: Gulf Coast Infrastructure Authority (fictitious) — RFP, two envelopes ----------------
  await createTenant(ctx, { id: 'gcia', nameEn: 'Gulf Coast Infrastructure Authority (fictitious)', nameAr: 'هيئة البنية التحتية الساحلية (وهمية)', primaryColor: '#7A4B0B' });
  await ctx.db.query(`UPDATE tenants SET profile=$1::jsonb WHERE id='gcia'`, [JSON.stringify({
    numberingPattern: 'GCIA-RFP-{YYYY}-{SEQ3}', receiptPattern: 'GCIA-R-{YYYY}-{SEQ5}', identityProvider: 'LOCAL',
    channels: { knet: true, gazette: true, capt: true }, fiscalYearStartMonth: 4, logoText: 'GCIA', sector: 'Infrastructure and works' })]);
  const g = await seedTenantUsers(ctx, 'gcia', password, ['WORKS']);
  await installStarterTemplates(ctx, { ...g.admin, tenantId: 'gcia' }, 'RFP_TWO_ENVELOPE');
  await codes(ctx, g.admin, [
    ['ENG-01', 'Civil works', 'الأعمال المدنية'],
    ['ENG-02', 'Marine works', 'الأعمال البحرية'],
    ['ENG-04', 'Roads and bridges', 'الطرق والجسور'],
  ]);
  const gv = async (n: number) => (await ctx.db.query<{ id: string }>(`SELECT v.id FROM vendors v JOIN users x ON x.vendor_id=v.id WHERE x.tenant_id=$1 AND x.username=$2`, ['gcia', `vendor${n}`]))[0].id;
  await setClassification(ctx, g.officer, await gv(1), { activityCode: 'ENG-02', grade: 1 });
  await setClassification(ctx, g.officer, await gv(2), { activityCode: 'ENG-01', grade: 2 });
  await setClassification(ctx, g.officer, await gv(3), { activityCode: 'ENG-01', grade: 3 }); // below the Second-grade minimum
  const JETTY = { category: 'WORKS', currency: 'KWD', criteria: CRITERIA, requiredDocuments: REQUIRED_DOCS, eligibility: { activityCodes: ['ENG-01', 'ENG-02'], minGrade: 2 } };

  // a) waiting for level 2 (undersecretary) of the publication chain
  const pend = await tenders.createTender(ctx, g.officer, { ...JETTY, titleEn: 'Coastal Road Drainage Upgrade', titleAr: 'تطوير تصريف مياه الطريق الساحلي',
    descriptionEn: 'Storm-water drainage upgrade along 6 km of the coastal road.', descriptionAr: 'تطوير شبكة تصريف مياه الأمطار على امتداد 6 كم من الطريق الساحلي.',
    estimatedBudget: 900000, submissionDeadline: iso(30 * 24 * HOUR), eligibility: { activityCodes: ['ENG-01', 'ENG-04'], minGrade: 2 } });
  await tenders.uploadTenderDocument(ctx, g.officer, pend.id, file('gcia-jetty-rfp-pack.md'), { title: 'Drainage RFP pack (EN)' });
  await tenders.approveTender(ctx, g.director, pend.id, { reason: 'Level 1: technically complete' });

  // b) PUBLISHED two-envelope RFP; vendor1 has bought the documents (TEST gateway)
  const open = await tenders.createTender(ctx, g.officer, { ...JETTY, titleEn: 'Fishing Harbour Breakwater Repair', titleAr: 'إصلاح حاجز الأمواج في ميناء الصيد',
    descriptionEn: 'Repair of 400 m of rock-armour breakwater and access ramp.', descriptionAr: 'إصلاح 400 م من حاجز الأمواج الصخري ومنحدر الوصول.',
    estimatedBudget: 1200000, submissionDeadline: iso(3 * 24 * HOUR) });
  await tenders.uploadTenderDocument(ctx, g.officer, open.id, file('gcia-jetty-rfp-pack.md'), { title: 'Breakwater RFP pack (EN)' });
  await tenders.approveTender(ctx, g.director, open.id, { reason: 'Level 1' });
  await tenders.approveTender(ctx, g.undersecretary, open.id, { reason: 'Level 2' });
  await tenders.publishTender(ctx, g.officer, open.id);
  await purchaseDocuments(ctx, g.vendor1, (await ctx.db.query<any>('SELECT * FROM tenders WHERE id=$1', [open.id]))[0], { gateway: 'TEST' });

  // c) CLOSED two-envelope RFP with 2 sealed bids, ready for the technical opening
  setClockOffset(-2 * HOUR);
  try {
    const jetty = await tenders.createTender(ctx, g.officer, { ...JETTY, titleEn: 'Marine Jetty Rehabilitation', titleAr: 'إعادة تأهيل الرصيف البحري',
      descriptionEn: 'Rehabilitation of the 240 m service jetty at the Northern Harbour.', descriptionAr: 'إعادة تأهيل رصيف الخدمة بطول 240 م في الميناء الشمالي.',
      estimatedBudget: 2400000, submissionDeadline: iso(-1 * HOUR) });
    await tenders.uploadTenderDocument(ctx, g.officer, jetty.id, file('gcia-jetty-rfp-pack.md'), { title: 'Jetty RFP pack (EN)' });
    await tenders.approveTender(ctx, g.director, jetty.id, {});
    await tenders.approveTender(ctx, g.undersecretary, jetty.id, {});
    await tenders.publishTender(ctx, g.officer, jetty.id);
    const row = async () => (await ctx.db.query<any>('SELECT * FROM tenders WHERE id=$1', [jetty.id]))[0];
    for (const n of [1, 2]) {
      await purchaseDocuments(ctx, g[`vendor${n}`], await row(), { gateway: 'TEST' });
      await submitBid(ctx, g[`vendor${n}`], jetty.id, { technical: file(`gcia-vendor${n}-technical.md`), financial: file(`gcia-vendor${n}-financial.md`) });
    }
  } finally {
    setClockOffset(0);
  }
  await tenders.closeDueTenders(ctx);
  await seedMoi(ctx, password); // entity 3: MOI reference configuration (fictitious demo data)
  await (await import('./features/notify.js')).seedNotifications(ctx); // NOTIFY: notification templates + sample approval SLA
  console.log('[seed] done: entities kea (public tender) and gcia (two-envelope RFP); users officer/director/undersecretary/chair/evaluator1/evaluator2/admin/auditor/vendor1..4');
}
