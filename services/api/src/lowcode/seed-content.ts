// Demo low-code content (fictitious): what an entity typically configures in the Process Studio without code.
import type { Ctx } from '../ctx.js';
import type { Queryable } from '../db.js';
import { installPublished, RULESET_CODE } from './definitions.js';

type A = { id: string; roles: string[] };

const opt = (value: string, labelEn: string, labelAr: string) => ({ value, labelEn, labelAr });

export const KEA_TENDER_FORM = {
  sections: [
    { key: 'funding', titleEn: 'Funding', titleAr: 'التمويل' },
    { key: 'guarantees', titleEn: 'Guarantees and local content', titleAr: 'الضمانات والمحتوى المحلي' },
    { key: 'site', titleEn: 'Site access', titleAr: 'دخول الموقع' },
  ],
  fields: [
    { key: 'fundingSource', type: 'select', section: 'funding', labelEn: 'Funding source', labelAr: 'مصدر التمويل', required: true, requiredAt: 'SUBMIT', audience: 'INTERNAL',
      options: [opt('OPEX', 'Operating budget', 'الميزانية التشغيلية'), opt('CAPEX', 'Capital projects budget', 'ميزانية المشاريع الرأسمالية'), opt('GRANT', 'External grant', 'منحة خارجية')] },
    { key: 'budgetLine', type: 'text', section: 'funding', labelEn: 'Budget line', labelAr: 'بند الميزانية', required: true, requiredAt: 'SUBMIT', audience: 'INTERNAL', maxLength: 40,
      helpEn: 'As in the approved annual budget, e.g. CAP-2026-114', helpAr: 'كما في الميزانية السنوية المعتمدة، مثل CAP-2026-114' },
    { key: 'strategicProject', type: 'checkbox', section: 'funding', labelEn: 'Strategic project', labelAr: 'مشروع استراتيجي', audience: 'INTERNAL' },
    { key: 'bidBondPercent', type: 'percent', section: 'guarantees', labelEn: 'Bid bond (% of budget)', labelAr: 'الكفالة الأولية (% من الميزانية)', audience: 'PUBLIC', defaultValue: 2, min: 0, max: 10, decimals: 2 },
    { key: 'bidBondAmount', type: 'computed', section: 'guarantees', labelEn: 'Bid bond amount (KWD)', labelAr: 'قيمة الكفالة الأولية (د.ك)', audience: 'PUBLIC',
      formula: 'round(budget * bidBondPercent / 100, 3)', decimals: 3 },
    { key: 'localContentPercent', type: 'percent', section: 'guarantees', labelEn: 'Minimum local content (%)', labelAr: 'الحد الأدنى للمحتوى المحلي (%)', audience: 'PUBLIC', min: 0, max: 100 },
    { key: 'securityClearance', type: 'checkbox', section: 'site', labelEn: 'Site visits need security clearance', labelAr: 'زيارة الموقع تتطلب تصريحاً أمنياً', audience: 'PUBLIC' },
    { key: 'clearanceNotes', type: 'textarea', section: 'site', labelEn: 'Clearance instructions for bidders', labelAr: 'تعليمات التصريح للمتقدمين', audience: 'PUBLIC', maxLength: 1000,
      visibleWhen: { fact: 'self.securityClearance', op: 'isTrue' } },
  ],
};

export const KEA_VENDOR_FORM = {
  sections: [{ key: 'company', titleEn: 'Company details', titleAr: 'بيانات الشركة' }, { key: 'internal', titleEn: 'Internal assessment', titleAr: 'تقييم داخلي' }],
  fields: [
    { key: 'iban', type: 'text', section: 'company', labelEn: 'Bank account (IBAN)', labelAr: 'الحساب البنكي (IBAN)', audience: 'PUBLIC', format: 'iban', maxLength: 34 },
    { key: 'kuwaitiStaffPercent', type: 'percent', section: 'company', labelEn: 'Kuwaiti staff (%)', labelAr: 'نسبة العمالة الوطنية (%)', audience: 'PUBLIC' },
    { key: 'isoCertified', type: 'checkbox', section: 'company', labelEn: 'ISO 9001 certified', labelAr: 'حاصلة على ISO 9001', audience: 'PUBLIC' },
    { key: 'riskRating', type: 'select', section: 'internal', labelEn: 'Risk rating', labelAr: 'تصنيف المخاطر', audience: 'INTERNAL',
      options: [opt('LOW', 'Low', 'منخفض'), opt('MEDIUM', 'Medium', 'متوسط'), opt('HIGH', 'High', 'مرتفع')] },
  ],
};

export const KEA_REQUEST_FORM = {
  sections: [],
  fields: [
    { key: 'costCentre', type: 'text', labelEn: 'Cost centre', labelAr: 'مركز التكلفة', audience: 'INTERNAL', maxLength: 20 },
    { key: 'urgency', type: 'select', labelEn: 'Urgency', labelAr: 'درجة الاستعجال', audience: 'INTERNAL', defaultValue: 'NORMAL',
      options: [opt('NORMAL', 'Normal', 'عادي'), opt('URGENT', 'Urgent', 'عاجل')] },
  ],
};

export const KEA_RULES = {
  rules: [
    { id: 'high-value-approval', nameEn: 'High-value tender: Undersecretary approval', nameAr: 'مناقصة عالية القيمة: اعتماد الوكيل', trigger: 'TENDER_SUBMIT',
      when: { fact: 'tender.estimatedBudget', op: 'gt', value: 500000 },
      actions: [{ type: 'ADD_APPROVER', role: 'UNDERSECRETARY', labelEn: 'Undersecretary (value above 500,000 KWD)', labelAr: 'الوكيل (قيمة تتجاوز 500,000 د.ك)', dueHours: 72 }] },
    { id: 'strategic-local-content', nameEn: 'Strategic projects state local content', nameAr: 'المشاريع الاستراتيجية تحدد المحتوى المحلي', trigger: 'TENDER_SUBMIT',
      when: { fact: 'tender.custom.strategicProject', op: 'isTrue' },
      actions: [{ type: 'REQUIRE_FIELDS', fields: ['localContentPercent'] }] },
    { id: 'grant-bidding-period', nameEn: 'Grant-funded: at least 14 days to bid', nameAr: 'المنح: 14 يوماً على الأقل للتقديم', trigger: 'TENDER_PUBLISH',
      when: { all: [{ fact: 'tender.custom.fundingSource', op: 'eq', value: 'GRANT' }, { fact: 'tender.deadlineDays', op: 'lt', value: 14 }] },
      actions: [{ type: 'BLOCK', messageEn: 'Grant-funded tenders must give bidders at least 14 days. Return the tender and extend the deadline.',
        messageAr: 'يجب منح المتقدمين 14 يوماً على الأقل في المناقصات الممولة بمنح. أعد المناقصة ومدد الموعد.' }] },
    { id: 'clearance-list', nameEn: 'Security clearance list before award', nameAr: 'قائمة التصاريح الأمنية قبل الترسية', trigger: 'TENDER_PUBLISHED',
      when: { fact: 'tender.custom.securityClearance', op: 'isTrue' },
      actions: [{ type: 'CREATE_TASK', role: 'COMMITTEE_CHAIR', titleEn: 'Confirm the site-visit clearance list for {{tender.number}}', titleAr: 'تأكيد قائمة تصاريح زيارة الموقع للمناقصة {{tender.number}}',
        dueHours: 72, blocksGate: 'AWARD_RECOMMEND' }] },
    { id: 'not-top-ranked', nameEn: 'Recommending a bid that is not top-scored', nameAr: 'التوصية بعطاء ليس الأعلى درجة', trigger: 'AWARD_RECOMMEND',
      when: { fact: 'award.recommendedRank', op: 'gt', value: 1 },
      actions: [{ type: 'ADD_APPROVER', role: 'UNDERSECRETARY', labelEn: 'Undersecretary (not the top-scored bid)', labelAr: 'الوكيل (ليس العطاء الأعلى درجة)' }] },
    { id: 'clarification-alert', nameEn: 'Clarification on a large tender: tell the director', nameAr: 'استفسار على مناقصة كبيرة: إبلاغ المدير', trigger: 'CLARIFICATION_ASKED',
      when: { fact: 'tender.estimatedBudget', op: 'gte', value: 250000 },
      actions: [{ type: 'NOTIFY', to: 'ROLE', role: 'DIRECTOR', titleEn: 'New clarification on {{tender.number}} — {{tender.title}}', titleAr: 'استفسار جديد على {{tender.number}} — {{tender.titleAr}}' }] },
    { id: 'review-new-vendor', nameEn: 'Review every new vendor within 2 days', nameAr: 'مراجعة كل مورد جديد خلال يومين', trigger: 'VENDOR_REGISTERED', when: null,
      actions: [{ type: 'CREATE_TASK', role: 'PROCUREMENT_OFFICER', titleEn: 'Review the registration of {{vendor.name}}', titleAr: 'مراجعة تسجيل {{vendor.nameAr}}', dueHours: 48 }] },
    { id: 'deadline-48h', nameEn: 'Deadline in 48 hours', nameAr: 'الموعد النهائي خلال 48 ساعة', trigger: 'DEADLINE_APPROACHING', params: { hoursBefore: 48 }, when: null,
      actions: [{ type: 'NOTIFY', to: 'ROLE', role: 'PROCUREMENT_OFFICER', titleEn: 'Submission deadline within 48 hours: {{tender.number}} ({{tender.deadline}} UTC)',
        titleAr: 'موعد التقديم خلال 48 ساعة: {{tender.number}} ({{tender.deadline}} UTC)' }] },
  ],
};

export const MOI_REQUEST_FORM = {
  sections: [{ key: 'security', titleEn: 'Security classification', titleAr: 'التصنيف الأمني' }],
  fields: [
    { key: 'sector', type: 'select', section: 'security', labelEn: 'Requesting sector', labelAr: 'القطاع الطالب', audience: 'INTERNAL',
      options: [opt('ADMIN', 'Administrative affairs', 'الشؤون الإدارية'), opt('TRAFFIC', 'Traffic', 'المرور'), opt('CIVIL_DEF', 'Civil defence', 'الدفاع المدني'), opt('IT', 'Information systems', 'نظم المعلومات')] },
    { key: 'classified', type: 'checkbox', section: 'security', labelEn: 'Classified procurement', labelAr: 'مشتريات سرية', audience: 'INTERNAL' },
  ],
};
export const MOI_TENDER_FORM = {
  sections: [],
  fields: [
    { key: 'classified', type: 'checkbox', labelEn: 'Classified tender (restricted pack)', labelAr: 'مناقصة سرية (كراسة مقيدة)', audience: 'INTERNAL' },
    { key: 'deliveryWeeks', type: 'number', labelEn: 'Delivery period (weeks)', labelAr: 'مدة التوريد (أسابيع)', audience: 'PUBLIC', min: 1, max: 260 },
  ],
};
export const MOI_RULES = {
  rules: [
    { id: 'classified-undersecretary', nameEn: 'Classified tenders: Undersecretary approval', nameAr: 'المناقصات السرية: اعتماد الوكيل', trigger: 'TENDER_SUBMIT',
      when: { fact: 'tender.custom.classified', op: 'isTrue' },
      actions: [{ type: 'ADD_APPROVER', role: 'UNDERSECRETARY', labelEn: 'Undersecretary (classified)', labelAr: 'الوكيل (سري)' }] },
    { id: 'request-it-review', nameEn: 'IT requests: technical review task', nameAr: 'طلبات نظم المعلومات: مهمة مراجعة فنية', trigger: 'REQUEST_SUBMITTED',
      when: { fact: 'request.custom.sector', op: 'eq', value: 'IT' },
      actions: [{ type: 'CREATE_TASK', role: 'PROCUREMENT_OFFICER', titleEn: 'Technical review of request {{request.number}}', titleAr: 'مراجعة فنية للطلب {{request.number}}', dueHours: 48 }] },
  ],
};

export async function installDemoLowcode(ctx: Ctx, q: Queryable, admin: A, tenantId: 'kea' | 'moi') {
  if (tenantId === 'kea') {
    await installPublished(ctx, q, admin, tenantId, 'FORM', 'TENDER', 'Tender form', 'نموذج المناقصة', KEA_TENDER_FORM);
    await installPublished(ctx, q, admin, tenantId, 'FORM', 'VENDOR', 'Vendor form', 'نموذج المورد', KEA_VENDOR_FORM);
    await installPublished(ctx, q, admin, tenantId, 'FORM', 'REQUEST', 'Request form', 'نموذج الطلب', KEA_REQUEST_FORM);
    await installPublished(ctx, q, admin, tenantId, 'RULESET', RULESET_CODE, 'Process rules', 'قواعد الإجراءات', KEA_RULES);
  } else {
    await installPublished(ctx, q, admin, tenantId, 'FORM', 'REQUEST', 'Request form', 'نموذج الطلب', MOI_REQUEST_FORM);
    await installPublished(ctx, q, admin, tenantId, 'FORM', 'TENDER', 'Tender form', 'نموذج المناقصة', MOI_TENDER_FORM);
    await installPublished(ctx, q, admin, tenantId, 'RULESET', RULESET_CODE, 'Process rules', 'قواعد الإجراءات', MOI_RULES);
  }
}
