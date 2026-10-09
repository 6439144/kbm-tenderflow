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

export const SEED_FILES_DIR = path.join(REPO_ROOT, 'seed', 'files');

const STAFF = [
  { username: 'officer', displayName: 'Officer Noura Al-Fictitious', roles: ['PROCUREMENT_OFFICER'] },
  { username: 'director', displayName: 'Director Yousef Al-Sample', roles: ['DIRECTOR'] },
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

async function seedTenantUsers(ctx: Ctx, tenantId: string, password: string) {
  const users: Record<string, Actor> = {};
  for (const s of STAFF) users[s.username] = asActor(await createUser(ctx, SYSTEM_ACTOR, { tenantId, password, ...s }));
  for (const v of VENDORS) {
    const res = await registerVendor(ctx, {
      tenantId, legalNameEn: v.en, legalNameAr: v.ar, crNumber: v.cr, email: `${v.username}@vendors.example`, phone: '+965 0000 0000',
      categories: ['IT'], username: v.username, password,
    });
    users[v.username] = { id: res.user.id, tenantId, roles: ['VENDOR'], vendorId: res.vendor.id, username: v.username, issuer: 'local' };
    if (v.approve) await decideVendor(ctx, users.officer, res.vendor.id, { decision: 'APPROVE', reason: 'Documents verified (demo seed)' });
  }
  return users;
}

export async function seedDemo(ctx: Ctx): Promise<void> {
  const password = ctx.config.demoPassword!;
  console.log('[seed] creating demo tenants, users, vendors and tenders …');
  await createTenant(ctx, { id: 'kea', nameEn: 'Kuwait Energy Authority (fictitious)', nameAr: 'هيئة الطاقة الكويتية (وهمية)', primaryColor: '#0B4F6C' });
  await createTenant(ctx, { id: 'ministry_a', nameEn: 'Ministry A (fictitious)', nameAr: 'الوزارة أ (وهمية)', primaryColor: '#5B2A86' });
  const u = await seedTenantUsers(ctx, 'kea', password);
  await seedTenantUsers(ctx, 'ministry_a', password);

  // 1) DRAFT tender with pack files
  const draft = await tenders.createTender(ctx, u.officer, {
    tenderNumber: 'KEA-2026-101', titleEn: 'Enterprise Network Refresh', titleAr: 'تحديث الشبكة المؤسسية', category: 'IT',
    descriptionEn: 'Replacement of core and access network switches across head office and two substations.',
    descriptionAr: 'استبدال محولات الشبكة الرئيسية وشبكة الوصول في المقر الرئيسي ومحطتين فرعيتين.',
    estimatedBudget: 450000, currency: 'KWD', submissionDeadline: iso(21 * 24 * HOUR), criteria: CRITERIA, requiredDocuments: REQUIRED_DOCS,
  });
  await tenders.uploadTenderDocument(ctx, u.officer, draft.id, file('kea-network-refresh-pack.md'), { title: 'Network refresh — tender pack (EN/AR)' });

  // 2) PUBLISHED tender (deadline +2 days) with 2 clarifications
  const pub = await tenders.createTender(ctx, u.officer, {
    tenderNumber: 'KEA-2026-102', titleEn: 'Document Management System', titleAr: 'نظام إدارة الوثائق', category: 'IT',
    descriptionEn: 'Supply and implementation of an enterprise document management system with Arabic OCR.',
    descriptionAr: 'توريد وتنفيذ نظام مؤسسي لإدارة الوثائق مع التعرف الضوئي على النصوص العربية.',
    estimatedBudget: 300000, currency: 'KWD', submissionDeadline: iso(2 * 24 * HOUR), criteria: CRITERIA, requiredDocuments: REQUIRED_DOCS,
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
  await tenders.closeDueTenders(ctx);
  console.log('[seed] done: tenants kea, ministry_a; users officer/director/chair/evaluator1/evaluator2/admin/auditor/vendor1..4');
}
