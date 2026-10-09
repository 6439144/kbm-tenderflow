// Demo entity `moi`: the Ministry of Interior REFERENCE CONFIGURATION built from KBM's MOI BRD v0.1. Every tender,
// vendor, person, department and document here is fictitious and labelled so; there is no MOI logo or emblem.
// Open MOI decisions are entity policies showing their current (pending) value. Everything goes through the real
// services (content store, audit, notifications); the only clock trick is the one the main seed uses — the services
// run with the clock shifted so that one subscription genuinely ends in 5 days and one block ends next week.
import type { Ctx } from './ctx.js';
import type { Actor } from './auth/tokens.js';
import { setClockOffset } from './util.js';
import { createTenant, createUser, type UserRow } from './services/identity.js';
import { registerVendor, uploadVendorDocument } from './services/vendors.js';
import * as tenders from './services/tenders.js';
import type { UploadFile } from './services/documents.js';
import { SYSTEM_ACTOR } from './services/audit.js';
import { createTemplate, publishTemplate } from './services/templates.js';
import { upsertActivityCode } from './services/eligibility.js';
import { convertRequest, createRequest, decideRequest } from './services/requests.js';
import { installPolicies } from './services/entity-policies.js';
import * as life from './services/vendor-lifecycle.js';
import { MOI_BRD_REFERENCE } from './features/moi-brd.js';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const asActor = (u: UserRow): Actor => ({ id: u.id, tenantId: u.tenant_id, roles: u.roles, vendorId: u.vendor_id, username: u.username, issuer: 'local' });
const md = (name: string, text: string): UploadFile => {
  const buffer = Buffer.from(text, 'utf8');
  return { originalname: name, mimetype: 'text/markdown', buffer, size: buffer.length };
};

/** A one-page PDF placeholder for the scanned GM letter (Helvetica, ASCII text), clearly marked as a sample scan. */
export function sampleScanPdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '?');
  const body = lines.map((l, i) => `BT /F1 ${i === 0 ? 18 : 12} Tf 64 ${740 - i * 26} Td (${esc(l)}) Tj ET`).join('\n')
    + '\n0.8 0 0 RG 4 w 40 40 532 712 re S';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const STAFF = [
  { username: 'officer', displayName: 'Tender creator — Officer Bader Al-Fictitious', roles: ['PROCUREMENT_OFFICER'] },
  { username: 'tenderdept', displayName: 'Tender Department — Hessa Al-Sample (fictitious)', roles: ['PROCUREMENT_OFFICER'] },
  { username: 'grader', displayName: 'Grading authority — Khalid Al-Placeholder (fictitious)', roles: ['GRADING_AUTHORITY'] },
  { username: 'director', displayName: 'Director Tender Dept. — Fawzia Al-Demo (fictitious)', roles: ['DIRECTOR'] },
  { username: 'undersecretary', displayName: 'Asst. Undersecretary — Nasser Al-Example (fictitious)', roles: ['UNDERSECRETARY'] },
  { username: 'admin', displayName: 'MOI platform administrator (fictitious)', roles: ['TENANT_ADMIN'] },
  { username: 'auditor', displayName: 'Internal auditor — Dalal Al-Mockup (fictitious)', roles: ['AUDITOR'] },
];

const ACTIVITIES: [string, string, string][] = [
  ['SEC-101', 'Security and surveillance systems', 'أنظمة الأمن والمراقبة'],
  ['VEH-202', 'Vehicles and spare parts', 'المركبات وقطع الغيار'],
  ['ITE-303', 'IT equipment', 'معدات تقنية المعلومات'],
  ['CON-404', 'Construction works', 'أعمال الإنشاءات'],
  ['UNI-505', 'Uniforms and textiles', 'الملابس الموحدة والمنسوجات'],
  ['COM-606', 'Communications equipment', 'معدات الاتصالات'],
  ['FUR-707', 'Furniture and office supplies', 'الأثاث واللوازم المكتبية'],
];

const CRITERIA = [{ key: 'compliance', nameEn: 'Compliance with the specification', nameAr: 'المطابقة للمواصفات', weight: 100 }];
const CATS = ['SUPPLIES', 'WORKS', 'IT', 'SERVICES'];

const L = (role: string, labelEn: string, labelAr: string, dueHours: number) => ({ role, labelEn, labelAr, dueHours });

export async function seedMoi(ctx: Ctx, password: string) {
  console.log('[seed] creating moi — Ministry of Interior reference configuration (fictitious demo data) …');
  await createTenant(ctx, { id: 'moi', nameEn: 'Ministry of Interior (MOI) — reference configuration · demo data',
    nameAr: 'وزارة الداخلية — إعداد مرجعي · بيانات تجريبية', primaryColor: '#25534A' });
  await ctx.db.query(`UPDATE tenants SET profile=$1::jsonb WHERE id='moi'`, [JSON.stringify({
    numberingPattern: 'MOI-T-{YYYY}-{SEQ3}', receiptPattern: 'MOI-RCPT-{YYYY}-{SEQ6}', identityProvider: 'LOCAL',
    channels: { knet: false, gazette: false, capt: false }, fiscalYearStartMonth: 4, logoText: 'MOI', sector: 'Government — reference configuration (demo data)' })]);

  const u: Record<string, Actor> = {};
  for (const s of STAFF) u[s.username] = asActor(await createUser(ctx, SYSTEM_ACTOR, { tenantId: 'moi', password, ...s }));
  for (const [code, nameEn, nameAr] of ACTIVITIES) await upsertActivityCode(ctx, u.admin, { code, nameEn, nameAr });

  // Entity policies = the BRD's open decisions as switches, at their current (pending) values.
  await ctx.db.tx((q) => installPolicies(ctx, q, u.admin, 'moi', {
    visibility: 'ELIGIBLE_ONLY', gradeMatch: 'AT_LEAST', gradeScope: 'PER_ACTIVITY',
    subscriptionRequired: true, subscriptionFee: 100, subscriptionCurrency: 'KWD', subscriptionTermMonths: 12, subscriptionStart: 'PAYMENT_DATE',
    retainPurchasedAfterExpiry: true, renewalReminderDays: [30, 7, 1],
    exemptionMode: 'PER_VENDOR', exemptionWaives: 'TENDER_DOCUMENTS',
    blockRoles: ['TENANT_ADMIN'], blockEffectOnSubscription: 'CONTINUE',
    gradingRoles: ['GRADING_AUTHORITY'], contentProtection: 'VIEW_ONLY',
    registrationDocuments: [
      { code: 'CR', en: 'Commercial registration certificate', ar: 'شهادة السجل التجاري' },
      { code: 'LICENCE', en: 'Commercial licence', ar: 'الرخصة التجارية' },
      { code: 'SIGNATORY', en: 'Authorised signatory letter', ar: 'كتاب المفوض بالتوقيع' },
      { code: 'MOC_ACTIVITIES', en: 'Ministry of Commerce activity extract', ar: 'مستخرج الأنشطة من وزارة التجارة' },
    ],
    activityCodeSource: 'MANUAL', accountProvisioning: 'ADMIN_CREATED',
  }, MOI_BRD_REFERENCE));

  // The MOI Phase 1 cycle: request → internal approval → tender (activities + grade) → eligible vendors buy the documents.
  const tpl = await createTemplate(ctx, u.admin, {
    code: 'MOI_PHASE1', nameEn: 'MOI Phase 1 — request to purchase', nameAr: 'وزارة الداخلية المرحلة 1 — من الطلب إلى الشراء',
    description: 'Request intake (Raslni or scanned GM letter), internal approval, tender creation by activity and grade, eligibility-filtered viewing, '
      + 'document purchase (TEST gateway until the KNET merchant exists). Bidding, opening, evaluation and award are outside Phase 1. '
      + 'The two-level internal approval is illustrative — MOI to confirm (DEP-001).',
    config: {
      scope: 'PUBLICATION_AND_SALE',
      stages: { requestIntake: true, documentPurchase: true, gazette: false, capt: false, complianceScreening: false, recordsLock: false },
      approvals: {
        request: [L('DIRECTOR', 'Director, Tender Department (illustrative — MOI to confirm, DEP-001)', 'مدير إدارة المناقصات (توضيحي — بانتظار تأكيد الوزارة)', 48),
          L('UNDERSECRETARY', 'Assistant Undersecretary (illustrative — MOI to confirm, DEP-001)', 'الوكيل المساعد (توضيحي — بانتظار تأكيد الوزارة)', 72)],
        publish: [L('DIRECTOR', 'Director, Tender Department (illustrative — MOI to confirm, DEP-001)', 'مدير إدارة المناقصات (توضيحي — بانتظار تأكيد الوزارة)', 48)],
        award: [{ role: 'DIRECTOR', labelEn: 'Director (not used in Phase 1)', labelAr: 'المدير (غير مستخدم في المرحلة 1)' }],
      },
      envelopes: 'ONE',
      eligibility: { activityCodes: [], minGrade: null },
      fees: { documentPrice: 25, currency: 'KWD', exemptionAllowed: true },
    },
  });
  await publishTemplate(ctx, u.admin, tpl.id, { makeDefault: true });

  // ---------------- vendors (all fictitious)
  const reg = async (username: string, en: string, ar: string, cr: string) => {
    const r = await registerVendor(ctx, { tenantId: 'moi', legalNameEn: en, legalNameAr: ar, crNumber: cr, email: `${username}@vendors.example`,
      phone: '+965 0000 0000', categories: CATS, username, password });
    u[username] = { id: r.user.id, tenantId: 'moi', roles: ['VENDOR'], vendorId: r.vendor.id, username, issuer: 'local' };
    await uploadVendorDocument(ctx, u[username], md('commercial-registration.md',
      `# Commercial registration (SAMPLE — fictitious)\n\nCompany: ${en}\nCR number: ${cr}\nValid until: 2027-12-31\n\nThis is demo data, not a real certificate.`), 'Commercial registration (sample)');
    return r.vendor.id as string;
  };
  const grade = (id: string, activities: { activityCode: string; grade: number }[]) =>
    life.gradeVendor(ctx, u.grader, id, { decision: 'APPROVE', reason: 'Documents verified (demo seed)', activities });
  const pay = async (username: string, g: { subscription?: { payLink?: string } | null }) => {
    const link = new URLSearchParams(String(g.subscription?.payLink ?? '').split('?')[1] ?? '').get('link');
    if (!link) throw new Error('seed: no subscription link');
    return life.paySubscription(ctx, u[username], { link, gateway: 'TEST' });
  };

  // vendor1 — active, First grade security (+ Second grade communications)
  const v1 = await reg('vendor1', 'Burj Al-Aman Security Systems Co. (fictitious)', 'شركة برج الأمان لأنظمة الأمن (وهمية)', 'MOI-CR-200101');
  await pay('vendor1', await grade(v1, [{ activityCode: 'SEC-101', grade: 1 }, { activityCode: 'COM-606', grade: 2 }]));

  // vendor2 — Second grade vehicles; its year was paid 360 days ago, so it ends in 5 days (NOT-001 reminder due)
  const v2 = await reg('vendor2', 'Rimal Fleet Vehicles Trading (fictitious)', 'رمال لتجارة المركبات (وهمية)', 'MOI-CR-200202');
  setClockOffset(-360 * DAY);
  try { await pay('vendor2', await grade(v2, [{ activityCode: 'VEH-202', grade: 2 }])); } finally { setClockOffset(0); }
  await life.createUpgradeRequest(ctx, u.vendor2, { activityCode: 'VEH-202', requestedGrade: 1, justification: 'Fleet and workshop capacity doubled (sample statement).' },
    [md('fleet-capacity-statement.md', '# Fleet capacity statement (SAMPLE — fictitious)\n\n1. Vehicles in service: 85\n2. Workshops: 2 (Shuwaikh, Sabhan)\n3. Annual turnover: 4.1 M KWD\n\nDemo data, not a real statement.')]);

  // vendor3 — application waiting in the grading queue
  const v3 = await reg('vendor3', 'Najm Uniforms and Textiles (fictitious)', 'نجم للملابس الموحدة والمنسوجات (وهمية)', 'MOI-CR-200303');
  await uploadVendorDocument(ctx, u.vendor3, md('commercial-licence.md', '# Commercial licence (SAMPLE — fictitious)\n\nActivity: uniforms and textiles\nLicence no.: L-55120\n\nDemo data.'), 'Commercial licence (sample)');
  void v3;

  // vendor4 — construction, active subscription, blocked until next week (automatic reinstatement at the end date)
  const v4 = await reg('vendor4', 'Wadi Construction Works (fictitious)', 'وادي لأعمال الإنشاءات (وهمية)', 'MOI-CR-200404');
  await pay('vendor4', await grade(v4, [{ activityCode: 'CON-404', grade: 2 }, { activityCode: 'SEC-101', grade: 2 }]));
  await life.blockVendor(ctx, u.admin, v4, { mode: 'DATE_RANGE', to: new Date(Date.now() + 7 * DAY).toISOString(), ground: 'DOCUMENTS_EXPIRED',
    reason: 'Commercial licence expired; suspended until the renewed licence is verified (demo data).' });

  // vendor5 — IT equipment + security, exempt from document fees (per-vendor flag)
  const v5 = await reg('vendor5', 'Al-Fanar IT Equipment (fictitious)', 'الفنار لمعدات تقنية المعلومات (وهمية)', 'MOI-CR-200505');
  await pay('vendor5', await grade(v5, [{ activityCode: 'ITE-303', grade: 1 }, { activityCode: 'SEC-101', grade: 2 }]));
  await life.setVendorExemption(ctx, u.admin, v5, { feeExempt: true, reason: 'Government-owned supplier — exempt from tender document fees (illustrative, FR-018 open).' });

  // ---------------- requests: one from Raslni, one by GM letter (sample scan)
  const raslni = await createRequest(ctx, u.tenderdept, {
    source: 'RASLNI', sourceReference: 'RASLNI-2026-004512 (fictitious)', department: 'Border Security Department (fictitious)',
    subject: 'Perimeter CCTV upgrade for three border posts', estimatedBudget: 380000,
    description: 'Replace analogue cameras with IP cameras, add thermal cameras at gates and a central recording server (demo data).',
  }, undefined);
  await decideRequest(ctx, u.director, raslni.id, { decision: 'APPROVE', reason: 'Level 1 — budget available (demo)' });
  await decideRequest(ctx, u.undersecretary, raslni.id, { decision: 'APPROVE', reason: 'Level 2 — approved (demo)' });
  const pub = await convertRequest(ctx, u.officer, raslni.id, {
    titleEn: 'Perimeter CCTV upgrade for border posts (fictitious)', titleAr: 'تطوير كاميرات المراقبة المحيطية للمنافذ الحدودية (وهمية)',
    descriptionEn: 'Supply and installation of IP and thermal cameras and a central recording server at three border posts. Demo data.',
    descriptionAr: 'توريد وتركيب كاميرات IP وحرارية وخادم تسجيل مركزي في ثلاثة منافذ حدودية. بيانات تجريبية.',
    category: 'SUPPLIES', currency: 'KWD', submissionDeadline: iso(14 * DAY), criteria: CRITERIA, requiredDocuments: [],
    eligibility: { activityCodes: ['SEC-101', 'COM-606'], minGrade: 2 },
  });
  await tenders.uploadTenderDocument(ctx, u.officer, pub.id, md('cctv-tender-documents.md',
    '# 1. Scope (SAMPLE — fictitious)\nSupply and install 120 IP cameras, 18 thermal cameras and one recording server at three border posts.\n\n'
    + '# 2. Eligibility\nActivity SEC-101 or COM-606, Second grade and above.\n\n# 3. Price of documents\n25 KWD (illustrative).\n\nDemo data, not a real tender.'),
  { title: 'Tender documents — CCTV upgrade (sample)' });
  await tenders.approveTender(ctx, u.director, pub.id, { reason: 'Specification complete (demo)' });
  await tenders.publishTender(ctx, u.officer, pub.id);

  await createRequest(ctx, u.tenderdept, {
    source: 'LETTER', department: 'General Department of Traffic (fictitious)', subject: 'Supply of 40 patrol vehicles',
    description: 'Request received as a signed GM letter; the scan is attached (sample scan, demo data).', estimatedBudget: 920000,
    letterTitle: 'GM letter — patrol vehicles (sample scan)',
  }, { originalname: 'gm-letter-patrol-vehicles-sample-scan.pdf', mimetype: 'application/pdf', ...(() => {
    const buffer = sampleScanPdf(['SAMPLE SCAN - fictitious demo document', 'Ministry of Interior (reference configuration demo)',
      'From: General Manager, General Department of Traffic (fictitious)', 'To: Tender Department', 'Subject: Supply of 40 patrol vehicles',
      'Estimated budget: 920,000 KWD', 'This is not a real letter. Generated by the TenderFlow demo seed.']);
    return { buffer, size: buffer.length };
  })() });

  // DRAFT tender awaiting approval
  const draft = await tenders.createTender(ctx, u.officer, {
    titleEn: 'Supply of patrol vehicle spare parts (fictitious)', titleAr: 'توريد قطع غيار مركبات الدوريات (وهمية)',
    descriptionEn: 'Two-year supply of spare parts for the patrol fleet. Demo data.', descriptionAr: 'توريد قطع غيار أسطول الدوريات لمدة سنتين. بيانات تجريبية.',
    category: 'SUPPLIES', estimatedBudget: 210000, currency: 'KWD', submissionDeadline: iso(21 * DAY), criteria: CRITERIA, requiredDocuments: [],
    eligibility: { activityCodes: ['VEH-202'], minGrade: 2 },
  });
  await tenders.uploadTenderDocument(ctx, u.officer, draft.id, md('spare-parts-tender-documents.md',
    '# 1. Scope (SAMPLE — fictitious)\nSpare parts for 300 patrol vehicles over two years.\n\n# 2. Eligibility\nActivity VEH-202, Second grade and above.\n\nDemo data.'),
  { title: 'Tender documents — spare parts (sample)' });
  console.log('[seed] done: moi (reference configuration): officer/tenderdept/grader/director/undersecretary/admin/auditor, vendor1..vendor5');
}
