// Low-code catalogue: the facts a rule may test, the triggers it may react to and the actions it may take.
// This file is the contract between the Process Studio UI and the server: anything not listed here is rejected.
// Sealed-bid content (prices, files, bidder identities before opening) is never a fact, so no rule, notification or
// webhook can leak it.

export type FactType = 'number' | 'string' | 'boolean' | 'enum' | 'list' | 'date';
export type Scope = 'TENDER' | 'AWARD' | 'VENDOR' | 'REQUEST' | 'DOCUMENT';
export interface Option { value: string; labelEn: string; labelAr: string }
export interface FactDef { key: string; labelEn: string; labelAr: string; type: FactType; scopes: Scope[]; options?: Option[]; unit?: string }

const o = (value: string, labelEn: string, labelAr: string): Option => ({ value, labelEn, labelAr });
const T: Scope[] = ['TENDER', 'AWARD'];

export const TENDER_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PUBLISHED', 'CLOSED', 'OPENED', 'EVALUATION', 'AWARDED', 'CANCELLED'];

export const FACTS: FactDef[] = [
  { key: 'tender.estimatedBudget', labelEn: 'Estimated budget', labelAr: 'الميزانية التقديرية', type: 'number', scopes: T, unit: 'currency' },
  { key: 'tender.category', labelEn: 'Category', labelAr: 'الفئة', type: 'string', scopes: T },
  { key: 'tender.currency', labelEn: 'Currency', labelAr: 'العملة', type: 'string', scopes: T },
  { key: 'tender.templateCode', labelEn: 'Cycle template', labelAr: 'نموذج الدورة', type: 'string', scopes: T },
  { key: 'tender.envelopes', labelEn: 'Envelopes', labelAr: 'المظاريف', type: 'enum', scopes: T, options: [o('ONE', 'One envelope', 'مظروف واحد'), o('TWO', 'Two envelopes', 'مظروفان')] },
  { key: 'tender.status', labelEn: 'Tender status', labelAr: 'حالة المناقصة', type: 'enum', scopes: T, options: TENDER_STATUSES.map((s) => o(s, s, s)) },
  { key: 'tender.deadlineDays', labelEn: 'Days until submission deadline', labelAr: 'الأيام المتبقية لموعد التقديم', type: 'number', scopes: T, unit: 'days' },
  { key: 'tender.packDocuments', labelEn: 'Tender pack documents', labelAr: 'عدد مستندات كراسة الشروط', type: 'number', scopes: T },
  { key: 'tender.addenda', labelEn: 'Addenda issued', labelAr: 'عدد الملاحق الصادرة', type: 'number', scopes: T },
  { key: 'tender.criteriaCount', labelEn: 'Evaluation criteria', labelAr: 'عدد معايير التقييم', type: 'number', scopes: T },
  { key: 'tender.minGrade', labelEn: 'Minimum vendor grade (1 = First)', labelAr: 'أدنى درجة تصنيف (1 = أولى)', type: 'number', scopes: T },
  { key: 'tender.fromRequest', labelEn: 'Created from a departmental request', labelAr: 'منشأة من طلب إدارة', type: 'boolean', scopes: T },
  { key: 'tender.clarifications', labelEn: 'Clarification questions', labelAr: 'عدد الاستفسارات', type: 'number', scopes: T },
  { key: 'award.bidCount', labelEn: 'Number of bids', labelAr: 'عدد العطاءات', type: 'number', scopes: ['AWARD'] },
  { key: 'award.recommendedScore', labelEn: 'Recommended bid — average score', labelAr: 'متوسط درجة العطاء الموصى به', type: 'number', scopes: ['AWARD'] },
  { key: 'award.recommendedRank', labelEn: 'Recommended bid — rank by score (1 = best)', labelAr: 'ترتيب العطاء الموصى به (1 = الأفضل)', type: 'number', scopes: ['AWARD'] },
  { key: 'vendor.status', labelEn: 'Vendor status', labelAr: 'حالة المورد', type: 'enum', scopes: ['VENDOR'],
    options: ['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED', 'BLOCKED'].map((s) => o(s, s, s)) },
  { key: 'vendor.categories', labelEn: 'Vendor activity categories', labelAr: 'أنشطة المورد', type: 'list', scopes: ['VENDOR'] },
  { key: 'vendor.grade', labelEn: 'Vendor company grade (1 = First)', labelAr: 'درجة تصنيف المورد (1 = أولى)', type: 'number', scopes: ['VENDOR'] },
  { key: 'request.estimatedBudget', labelEn: 'Request estimated budget', labelAr: 'الميزانية التقديرية للطلب', type: 'number', scopes: ['REQUEST'] },
  { key: 'request.department', labelEn: 'Requesting department', labelAr: 'الإدارة الطالبة', type: 'string', scopes: ['REQUEST'] },
  { key: 'request.source', labelEn: 'Request source', labelAr: 'مصدر الطلب', type: 'enum', scopes: ['REQUEST'], options: [o('RASLNI', 'Raslni', 'راسلني'), o('LETTER', 'Signed letter', 'كتاب موقع')] },
  { key: 'document.ownerType', labelEn: 'Document kind', labelAr: 'نوع المستند', type: 'enum', scopes: ['DOCUMENT'],
    options: ['TENDER_PACK', 'ADDENDUM', 'VENDOR', 'REQUEST_LETTER'].map((s) => o(s, s, s)) },
  { key: 'document.mimeType', labelEn: 'File type (MIME)', labelAr: 'نوع الملف', type: 'string', scopes: ['DOCUMENT'] },
  { key: 'document.sizeKb', labelEn: 'File size (KB)', labelAr: 'حجم الملف (ك.ب)', type: 'number', scopes: ['DOCUMENT'] },
  { key: 'actor.roles', labelEn: 'Roles of the user who acted', labelAr: 'أدوار المستخدم المنفذ', type: 'list', scopes: ['TENDER', 'AWARD', 'VENDOR', 'REQUEST', 'DOCUMENT'] },
];

/** Custom-field facts: `<object>.custom.<key>` for each field of the entity's published form. */
export const CUSTOM_FACT_PREFIX: Record<string, Scope[]> = { 'tender.custom.': T, 'vendor.custom.': ['VENDOR'], 'request.custom.': ['REQUEST'] };

export const OPS: Record<FactType, string[]> = {
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'isEmpty', 'isNotEmpty'],
  string: ['eq', 'ne', 'in', 'notIn', 'contains', 'startsWith', 'isEmpty', 'isNotEmpty'],
  enum: ['eq', 'ne', 'in', 'notIn', 'isEmpty', 'isNotEmpty'],
  boolean: ['isTrue', 'isFalse'],
  list: ['includes', 'excludes', 'isEmpty', 'isNotEmpty'],
  date: ['before', 'after', 'withinDays', 'isEmpty', 'isNotEmpty'],
};
export const OP_LABELS: Record<string, { en: string; ar: string }> = {
  eq: { en: 'is', ar: 'يساوي' }, ne: { en: 'is not', ar: 'لا يساوي' }, gt: { en: '>', ar: 'أكبر من' }, gte: { en: '≥', ar: 'أكبر من أو يساوي' },
  lt: { en: '<', ar: 'أقل من' }, lte: { en: '≤', ar: 'أقل من أو يساوي' }, between: { en: 'is between', ar: 'بين' }, in: { en: 'is one of', ar: 'أحد' },
  notIn: { en: 'is none of', ar: 'ليس أياً من' }, contains: { en: 'contains', ar: 'يحتوي' }, startsWith: { en: 'starts with', ar: 'يبدأ بـ' },
  isEmpty: { en: 'is empty', ar: 'فارغ' }, isNotEmpty: { en: 'is filled in', ar: 'مُعبأ' }, isTrue: { en: 'is yes', ar: 'نعم' },
  isFalse: { en: 'is no', ar: 'لا' }, includes: { en: 'includes', ar: 'يتضمن' }, excludes: { en: 'does not include', ar: 'لا يتضمن' },
  before: { en: 'is before', ar: 'قبل' }, after: { en: 'is after', ar: 'بعد' }, withinDays: { en: 'is within (days)', ar: 'خلال (أيام)' },
};

export type TriggerKind = 'GATE' | 'EVENT' | 'SCHEDULE';
export interface TriggerDef { key: string; kind: TriggerKind; scope: Scope; labelEn: string; labelAr: string; stage: string; auditActions?: string[] }

/** Gates run synchronously inside the transition: they can block it or add approval levels. */
export const TRIGGERS: TriggerDef[] = [
  { key: 'TENDER_SUBMIT', kind: 'GATE', scope: 'TENDER', stage: 'APPROVAL', labelEn: 'Tender is submitted for approval (first approval)', labelAr: 'عند رفع المناقصة للاعتماد (الاعتماد الأول)' },
  { key: 'TENDER_PUBLISH', kind: 'GATE', scope: 'TENDER', stage: 'PUBLISH', labelEn: 'Tender is about to be published', labelAr: 'قبل نشر المناقصة' },
  { key: 'AWARD_RECOMMEND', kind: 'GATE', scope: 'AWARD', stage: 'AWARD_APPROVAL', labelEn: 'Award is recommended', labelAr: 'عند التوصية بالترسية' },
  // Events: read from the committed audit trail (durable, after the fact; never slow down or fail the user's action).
  { key: 'TENDER_CREATED', kind: 'EVENT', scope: 'TENDER', stage: 'DRAFT', labelEn: 'Tender created', labelAr: 'إنشاء مناقصة', auditActions: ['TENDER_CREATED'] },
  { key: 'TENDER_APPROVED', kind: 'EVENT', scope: 'TENDER', stage: 'APPROVAL', labelEn: 'Tender fully approved', labelAr: 'اعتماد المناقصة نهائياً', auditActions: ['TENDER_APPROVED'] },
  { key: 'TENDER_RETURNED', kind: 'EVENT', scope: 'TENDER', stage: 'APPROVAL', labelEn: 'Tender returned / rejected', labelAr: 'إعادة / رفض المناقصة', auditActions: ['TENDER_RETURNED', 'TENDER_REJECTED'] },
  { key: 'TENDER_PUBLISHED', kind: 'EVENT', scope: 'TENDER', stage: 'PUBLISH', labelEn: 'Tender published', labelAr: 'نشر المناقصة', auditActions: ['TENDER_PUBLISHED'] },
  { key: 'ADDENDUM_ISSUED', kind: 'EVENT', scope: 'TENDER', stage: 'CLARIFICATIONS', labelEn: 'Addendum issued', labelAr: 'إصدار ملحق', auditActions: ['ADDENDUM_ISSUED'] },
  { key: 'CLARIFICATION_ASKED', kind: 'EVENT', scope: 'TENDER', stage: 'CLARIFICATIONS', labelEn: 'Clarification question received', labelAr: 'ورود استفسار', auditActions: ['CLARIFICATION_ASKED'] },
  { key: 'TENDER_CLOSED', kind: 'EVENT', scope: 'TENDER', stage: 'CLOSE', labelEn: 'Submission closed', labelAr: 'إغلاق التقديم', auditActions: ['TENDER_CLOSED'] },
  { key: 'BIDS_OPENED', kind: 'EVENT', scope: 'TENDER', stage: 'OPENING', labelEn: 'Bids opened', labelAr: 'فتح العطاءات', auditActions: ['TENDER_OPENED', 'FINANCIAL_ENVELOPES_OPENED'] },
  { key: 'AWARD_RECOMMENDED', kind: 'EVENT', scope: 'AWARD', stage: 'AWARD_APPROVAL', labelEn: 'Award recommended', labelAr: 'التوصية بالترسية', auditActions: ['AWARD_RECOMMENDED'] },
  { key: 'AWARD_APPROVED', kind: 'EVENT', scope: 'AWARD', stage: 'AWARD_APPROVAL', labelEn: 'Award approved', labelAr: 'اعتماد الترسية', auditActions: ['AWARD_APPROVED'] },
  { key: 'TENDER_CANCELLED', kind: 'EVENT', scope: 'TENDER', stage: 'DRAFT', labelEn: 'Tender cancelled', labelAr: 'إلغاء المناقصة', auditActions: ['TENDER_CANCELLED'] },
  { key: 'TENDER_DOCUMENT_UPLOADED', kind: 'EVENT', scope: 'TENDER', stage: 'DRAFT', labelEn: 'Tender pack document uploaded', labelAr: 'رفع مستند لكراسة الشروط', auditActions: ['TENDER_DOCUMENT_UPLOADED'] },
  { key: 'VENDOR_REGISTERED', kind: 'EVENT', scope: 'VENDOR', stage: 'VENDORS', labelEn: 'Vendor registered', labelAr: 'تسجيل مورد', auditActions: ['VENDOR_REGISTERED'] },
  { key: 'VENDOR_DECIDED', kind: 'EVENT', scope: 'VENDOR', stage: 'VENDORS', labelEn: 'Vendor approved / rejected', labelAr: 'قبول / رفض مورد', auditActions: ['VENDOR_APPROVED', 'VENDOR_REJECTED'] },
  { key: 'VENDOR_DOCUMENT_UPLOADED', kind: 'EVENT', scope: 'DOCUMENT', stage: 'VENDORS', labelEn: 'Vendor uploaded a document', labelAr: 'رفع مورد لمستند', auditActions: ['VENDOR_DOCUMENT_UPLOADED'] },
  { key: 'REQUEST_SUBMITTED', kind: 'EVENT', scope: 'REQUEST', stage: 'REQUEST_INTAKE', labelEn: 'Departmental request submitted', labelAr: 'تقديم طلب إدارة', auditActions: ['REQUEST_SUBMITTED'] },
  // Schedules: evaluated by the automation job; fire once per tender.
  { key: 'DEADLINE_APPROACHING', kind: 'SCHEDULE', scope: 'TENDER', stage: 'SEALED_BIDS', labelEn: 'Submission deadline approaching', labelAr: 'اقتراب موعد التقديم' },
];
export const triggerDef = (k: string) => TRIGGERS.find((t) => t.key === k);

export type ActionType = 'ADD_APPROVER' | 'BLOCK' | 'REQUIRE_FIELDS' | 'REQUIRE_DOCUMENTS' | 'NOTIFY' | 'CREATE_TASK' | 'WEBHOOK' | 'SET_FIELD';
export interface ActionDef { type: ActionType; kinds: TriggerKind[]; labelEn: string; labelAr: string; scopes?: Scope[] }
export const ACTIONS: ActionDef[] = [
  { type: 'ADD_APPROVER', kinds: ['GATE'], labelEn: 'Add an approval level', labelAr: 'إضافة مستوى اعتماد' },
  { type: 'BLOCK', kinds: ['GATE'], labelEn: 'Stop with a message', labelAr: 'إيقاف مع رسالة' },
  { type: 'REQUIRE_FIELDS', kinds: ['GATE'], labelEn: 'Require custom fields', labelAr: 'اشتراط حقول مخصصة', scopes: ['TENDER', 'AWARD'] },
  { type: 'REQUIRE_DOCUMENTS', kinds: ['GATE'], labelEn: 'Require pack documents', labelAr: 'اشتراط مستندات في الكراسة', scopes: ['TENDER', 'AWARD'] },
  { type: 'NOTIFY', kinds: ['EVENT', 'SCHEDULE'], labelEn: 'Send a notification', labelAr: 'إرسال إشعار' },
  { type: 'CREATE_TASK', kinds: ['EVENT', 'SCHEDULE'], labelEn: 'Create a task', labelAr: 'إنشاء مهمة' },
  { type: 'WEBHOOK', kinds: ['EVENT', 'SCHEDULE'], labelEn: 'Call an integration (webhook)', labelAr: 'استدعاء تكامل (Webhook)' },
  { type: 'SET_FIELD', kinds: ['EVENT', 'SCHEDULE'], labelEn: 'Set a custom field', labelAr: 'تعيين حقل مخصص', scopes: ['TENDER', 'AWARD', 'VENDOR', 'REQUEST'] },
];

/** Roles a rule may add as an approval level (same set as the Cycle Designer). */
export const APPROVER_ROLES = ['DIRECTOR', 'UNDERSECRETARY', 'COMMITTEE_CHAIR', 'TENANT_ADMIN'];
/** Roles a rule may notify or assign a task to. */
export const STAFF_TARGET_ROLES = ['PROCUREMENT_OFFICER', 'DIRECTOR', 'UNDERSECRETARY', 'COMMITTEE_CHAIR', 'EVALUATOR', 'TENANT_ADMIN', 'AUDITOR', 'GRADING_AUTHORITY'];
/** Which gate a task may block. */
export const BLOCKABLE_GATES = ['TENDER_PUBLISH', 'AWARD_RECOMMEND'];

/** The stages that never change, shown locked in the Process Studio. */
export const LOCKED_CONTROLS = [
  { key: 'SEALED_BIDS', en: 'Bids are encrypted (AES-256-GCM) until the opening', ar: 'العطاءات مشفرة حتى جلسة الفتح' },
  { key: 'OPENING', en: 'Only the committee chair opens, only after the deadline', ar: 'رئيس اللجنة فقط يفتح وبعد الموعد فقط' },
  { key: 'APPROVAL', en: 'The creator can never approve; one person, one level', ar: 'المنشئ لا يعتمد أبداً؛ شخص واحد لكل مستوى' },
  { key: 'AWARD_APPROVAL', en: 'The recommender can never approve the award', ar: 'صاحب التوصية لا يعتمد الترسية' },
  { key: 'AUDIT', en: 'Every action is in the HMAC-chained, append-only audit trail', ar: 'كل إجراء في سجل تدقيق متسلسل غير قابل للتعديل' },
];
