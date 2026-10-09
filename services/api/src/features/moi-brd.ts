// Requirements catalogue the MOI reference configuration is annotated against: KBM's MOI Tender Platform BRD v0.1
// (2026-08-25, "DRAFT FOR MOI REVIEW"). Data only — the policies page shows, per setting, the BRD reference and
// whether MOI has confirmed it, it is a KBM proposal pending MOI approval, or it is an open MOI decision; plus the
// BRD section-15 open items and which setting (if any) absorbs each one. Nothing here changes behaviour.
export type DecisionStatus = 'CONFIRMED' | 'PROPOSED' | 'OPEN';
export interface Annotation { ref: string; status: DecisionStatus; en: string; ar: string }
export type OpenItemStatus = 'CONFIGURABLE' | 'AVAILABLE' | 'IMPLEMENTED' | 'NEEDS_MOI_INPUT';
export interface OpenItem {
  key: string; en: string; ar: string; status: OpenItemStatus;
  /** Setting keys on the policies page, or 'template:…' / 'profile:…' for Cycle Designer / entity profile fields. */
  absorbedBy: string[];
  noteEn: string; noteAr: string;
}

export const MOI_BRD_REFERENCE = 'MOI-BRD-v0.1';

const A = (ref: string, status: DecisionStatus, en: string, ar: string): Annotation => ({ ref, status, en, ar });

export const MOI_ANNOTATIONS: Record<string, Annotation> = {
  visibility: A('FR-020 · SEC-006 · BR-007', 'CONFIRMED', 'A vendor sees only tenders matching activity AND grade, enforced on every access (list, detail, documents).',
    'يرى المورد المناقصات المطابقة للنشاط والدرجة فقط، ويُطبق ذلك على كل وصول (القائمة والتفاصيل والمستندات).'),
  gradeMatch: A('BR-007 · open item (section 15: vendor grading semantics)', 'OPEN', 'Does a tender grade level mean "that grade only" or "that grade and above"?',
    'هل تعني درجة المناقصة "تلك الدرجة فقط" أم "تلك الدرجة وما فوقها"؟'),
  gradeScope: A('BR-007 · open item (section 15: vendor grading semantics)', 'OPEN', 'Is the vendor grade company-wide or per activity?',
    'هل درجة المورد على مستوى الشركة أم لكل نشاط؟'),
  subscriptionRequired: A('BR-008 (proposed)', 'PROPOSED', 'Without a valid subscription a vendor cannot view or purchase tenders.',
    'بدون اشتراك ساري لا يمكن للمورد عرض المناقصات أو شراؤها.'),
  subscriptionFee: A('FR-017 · open item (section 15: pricing)', 'OPEN', 'Subscription price is not defined in the BRD; the value here is illustrative.',
    'لم يحدد المستند قيمة الاشتراك؛ القيمة هنا توضيحية.'),
  subscriptionCurrency: A('FR-017 · open item (section 15: pricing)', 'OPEN', 'Currency of the subscription fee.', 'عملة رسوم الاشتراك.'),
  subscriptionTermMonths: A('FR-017', 'CONFIRMED', 'On approval the vendor subscribes for one year.', 'عند الموافقة يشترك المورد لمدة سنة.'),
  subscriptionStart: A('BR-009 (proposed)', 'PROPOSED', 'The subscription year runs from the payment date.', 'تبدأ سنة الاشتراك من تاريخ الدفع.'),
  retainPurchasedAfterExpiry: A('BR-010 (proposed)', 'PROPOSED', 'After expiry the vendor keeps access to tenders it already purchased.',
    'بعد انتهاء الاشتراك يحتفظ المورد بالوصول إلى المناقصات التي اشتراها.'),
  renewalReminderDays: A('NOT-001 (mandatory) · timing open', 'OPEN', 'A renewal reminder before expiry is mandatory; when it is sent is not defined.',
    'التذكير بالتجديد قبل الانتهاء إلزامي؛ توقيت الإرسال غير محدد.'),
  exemptionMode: A('FR-018 · open item (section 15: fee exemption)', 'OPEN', 'Is exemption a per-vendor flag or a vendor category?',
    'هل الإعفاء علامة لكل مورد أم فئة موردين؟'),
  exemptionWaives: A('FR-018 · open item (section 15: fee exemption)', 'OPEN', 'What does the exemption waive: tender purchase only, or the subscription too?',
    'ما الذي يعفي منه: شراء المناقصة فقط أم الاشتراك أيضاً؟'),
  blockRoles: A('FR-013 · open item (section 15: vendor blocking)', 'OPEN', 'Who authorises a block (ACT-006 MOI administrator is the confirmed function).',
    'من يعتمد الإيقاف (الوظيفة المؤكدة: مسؤول الوزارة ACT-006).'),
  blockEffectOnSubscription: A('FR-013 · open item (section 15: vendor blocking)', 'OPEN', 'Effect of a block on a paid subscription: pause (days added back) or continue.',
    'أثر الإيقاف على الاشتراك المدفوع: تعليق (إضافة الأيام) أو استمرار.'),
  blockGrounds: A('FR-013 · open item (section 15: vendor blocking)', 'OPEN', 'Grounds for blocking are not defined; the list here is illustrative.',
    'أسباب الإيقاف غير محددة؛ القائمة هنا توضيحية.'),
  gradingRoles: A('ACT-005 · open item (section 15: MOI roles)', 'OPEN', '"The grading authority … are confirmed functions, not confirmed job titles": which roles perform grading.',
    '"جهة التصنيف … وظائف مؤكدة وليست مسميات وظيفية مؤكدة": أي الأدوار تقوم بالتصنيف.'),
  contentProtection: A('SEC-001/002 · FR-023 (proposed) · open item (section 15: content protection)', 'OPEN',
    'Screenshot restriction is required; view-only vs watermarked download (FR-023) is open. Stored here; enforced by the content-protection feature.',
    'منع لقطات الشاشة مطلوب؛ العرض فقط أو التنزيل بعلامة مائية (FR-023) قيد القرار. يُحفظ هنا ويُطبق في ميزة حماية المحتوى.'),
  registrationDocuments: A('FR-015 · open item (section 15: registration documents)', 'OPEN', 'Which documents a vendor uploads with the application.',
    'المستندات التي يرفعها المورد مع طلب التسجيل.'),
  activityCodeSource: A('open item (section 15: activity code sourcing)', 'OPEN', 'Activity codes from the MoC API, a file, or maintained manually.',
    'رموز النشاط من واجهة وزارة التجارة أو ملف أو إدخال يدوي.'),
  accountProvisioning: A('INT-004 · DEP-005 · open item (section 15: MOI account provisioning)', 'OPEN',
    'MOI staff accounts created by the administrator, or derived from Active Directory groups.',
    'حسابات موظفي الوزارة يُنشئها المسؤول أو تُشتق من مجموعات Active Directory.'),
};

const O = (key: string, en: string, ar: string, status: OpenItemStatus, absorbedBy: string[], noteEn: string, noteAr: string): OpenItem =>
  ({ key, en, ar, status, absorbedBy, noteEn, noteAr });

/** BRD section 15 open items, in BRD order. */
export const MOI_OPEN_ITEMS: OpenItem[] = [
  O('grading', 'Vendor grading semantics', 'دلالات تصنيف الموردين', 'CONFIGURABLE', ['gradeMatch', 'gradeScope'],
    'Both interpretations are implemented and enforced on every tender access.', 'التفسيران منفذان ويُطبقان على كل وصول للمناقصة.'),
  O('approval', 'Approval process (DEP-001)', 'إجراءات الاعتماد (DEP-001)', 'CONFIGURABLE', ['template:approvals.request', 'template:approvals.publish'],
    'Steps, roles and service levels are template settings in the Cycle Designer; the 2-level chain in the demo is illustrative.',
    'الخطوات والأدوار ومستويات الخدمة إعدادات في مصمم الدورة؛ السلسلة ذات المستويين في العرض توضيحية.'),
  O('roles', 'MOI roles', 'أدوار الوزارة', 'CONFIGURABLE', ['gradingRoles', 'blockRoles'],
    'Functions map to roles by policy; users are created with any combination of roles.', 'تُربط الوظائف بالأدوار عبر السياسة؛ ويُنشأ المستخدمون بأي مجموعة أدوار.'),
  O('network', 'Network boundary (SEC-003)', 'حدود الشبكة (SEC-003)', 'NEEDS_MOI_INPUT', [],
    'Deployment decision (internal system only from MOI premises), not an application setting.', 'قرار نشر (النظام الداخلي من مقار الوزارة فقط) وليس إعداداً في التطبيق.'),
  O('portal', 'Portal boundary (SEC-008)', 'حدود البوابة (SEC-008)', 'NEEDS_MOI_INPUT', [],
    'Push-only from the internal zone to the vendor zone is an architecture decision for MOI.', 'الدفع فقط من المنطقة الداخلية إلى منطقة الموردين قرار معماري للوزارة.'),
  O('content', 'Content protection', 'حماية المحتوى', 'CONFIGURABLE', ['contentProtection'],
    'Mode is a setting (default view-only, pending decision).', 'النمط إعداد (الافتراضي عرض فقط، بانتظار القرار).'),
  O('nfr', 'Non-functional requirements', 'المتطلبات غير الوظيفية', 'NEEDS_MOI_INPUT', [],
    'Volumes, availability and response targets must come from MOI.', 'الأحجام والتوافر وأزمنة الاستجابة يجب أن تحددها الوزارة.'),
  O('exemption', 'Fee exemption', 'الإعفاء من الرسوم', 'CONFIGURABLE', ['exemptionMode', 'exemptionWaives'],
    'Per-vendor flag or vendor category; waives documents only or the subscription too.', 'علامة لكل مورد أو فئة؛ يعفي من المستندات فقط أو من الاشتراك أيضاً.'),
  O('blocking', 'Vendor blocking', 'إيقاف الموردين', 'CONFIGURABLE', ['blockRoles', 'blockGrounds', 'blockEffectOnSubscription'],
    'Date range or permanent, automatic reinstatement, audited.', 'لفترة محددة أو دائم، مع إعادة تفعيل تلقائية، ومُدقق.'),
  O('subscription', 'Subscription scope', 'نطاق الاشتراك', 'CONFIGURABLE', ['subscriptionRequired', 'subscriptionTermMonths', 'subscriptionStart', 'retainPurchasedAfterExpiry'],
    'BR-008/009/010 are switches.', 'BR-008/009/010 مفاتيح تشغيل.'),
  O('receipts', 'Receipts and finance', 'الإيصالات والمالية', 'CONFIGURABLE', ['profile:receiptPattern'],
    'MOI number series and the gateway transaction id on every receipt; finance-system integration needs MOI input.',
    'سلسلة أرقام الوزارة ورقم عملية البوابة على كل إيصال؛ التكامل مع النظام المالي يحتاج مدخلات الوزارة.'),
  O('refunds', 'Refunds', 'الاسترداد', 'NEEDS_MOI_INPUT', [], 'No refund flow is built; MOI must define the rule.', 'لا يوجد مسار استرداد؛ يجب أن تحدد الوزارة القاعدة.'),
  O('failedPayments', 'Failed payments', 'المدفوعات الفاشلة', 'NEEDS_MOI_INPUT', [],
    'An unpaid link stays open for retry; KNET failure handling needs the KNET merchant spec (DEP-004).', 'يبقى الرابط غير المدفوع متاحاً لإعادة المحاولة؛ معالجة فشل KNET تحتاج مواصفات التاجر (DEP-004).'),
  O('pricing', 'Pricing', 'التسعير', 'CONFIGURABLE', ['subscriptionFee', 'template:fees.documentPrice'],
    'Subscription fee here; tender document price per cycle template.', 'رسوم الاشتراك هنا؛ وسعر الكراسة في قالب الدورة.'),
  O('gradeCriteria', 'Grade criteria', 'معايير التصنيف', 'NEEDS_MOI_INPUT', [],
    'The grading authority decides; the Orchestrate grade reviewer checklist is advisory and needs MOI\'s criteria.', 'جهة التصنيف تقرر؛ قائمة مراجع التصنيف في Orchestrate استشارية وتحتاج معايير الوزارة.'),
  O('rejection', 'Rejection handling', 'معالجة الرفض', 'AVAILABLE', [],
    'Return / reject with a mandatory reason exists for requests, applications and upgrades; MOI to confirm which paths apply.',
    'الإرجاع / الرفض مع سبب إلزامي متاح للطلبات والتسجيل والترقية؛ على الوزارة تأكيد المسارات المطبقة.'),
  O('registrationDocs', 'Registration documents', 'مستندات التسجيل', 'CONFIGURABLE', ['registrationDocuments'], 'List shown to vendors and to the grading authority.', 'قائمة تُعرض للموردين ولجهة التصنيف.'),
  O('activityCodes', 'Activity code sourcing (MoC API / file / manual)', 'مصدر رموز النشاط (واجهة / ملف / يدوي)', 'CONFIGURABLE', ['activityCodeSource'],
    'Manual and file import work today; the MoC API needs its specification.', 'الإدخال اليدوي واستيراد الملف يعملان؛ واجهة وزارة التجارة تحتاج مواصفاتها.'),
  O('screenshots', 'Screenshot restriction', 'منع لقطات الشاشة', 'CONFIGURABLE', ['contentProtection'],
    'Browsers cannot fully prevent screenshots; view-only and watermarking reduce and trace leakage.', 'لا تستطيع المتصفحات منع لقطات الشاشة تماماً؛ العرض فقط والعلامة المائية يحدّان من التسريب ويتتبعانه.'),
  O('adminPowers', 'Administrator powers', 'صلاحيات المسؤول', 'CONFIGURABLE', ['blockRoles'],
    'Policies, exemptions, blocking and users are administrator functions; blocking roles are a setting.', 'السياسات والإعفاءات والإيقاف والمستخدمون وظائف المسؤول؛ أدوار الإيقاف إعداد.'),
  O('configAudit', 'Configuration audit', 'تدقيق الإعدادات', 'IMPLEMENTED', [],
    'Every policy, template and profile change is in the append-only, HMAC-chained audit log.', 'كل تغيير في السياسات والقوالب والملف التعريفي مسجل في سجل التدقيق غير القابل للتعديل.'),
  O('dashboards', 'Dashboards', 'لوحات المعلومات', 'NEEDS_MOI_INPUT', [], 'Role dashboards exist; MOI to define the KPIs per user group.', 'لوحات الأدوار موجودة؛ على الوزارة تحديد المؤشرات لكل فئة.'),
  O('devEnv', 'Development environment', 'بيئة التطوير', 'NEEDS_MOI_INPUT', [], 'Hosting decision for MOI.', 'قرار استضافة للوزارة.'),
  O('release', 'Release promotion', 'ترقية الإصدارات', 'NEEDS_MOI_INPUT', [], 'Dev → prod promotion process to be agreed with MOI IT.', 'آلية الترقية من التطوير إلى الإنتاج تُتفق مع تقنية المعلومات بالوزارة.'),
  O('provisioning', 'MOI account provisioning', 'إنشاء حسابات الوزارة', 'CONFIGURABLE', ['accountProvisioning'],
    'Administrator-created accounts work today; AD group mapping needs DEP-005.', 'الحسابات التي ينشئها المسؤول تعمل؛ ربط مجموعات AD يحتاج DEP-005.'),
];

export function catalogueFor(reference: string | null) {
  if (reference !== MOI_BRD_REFERENCE) return null;
  return {
    reference, titleEn: 'MOI Tender Platform BRD v0.1 (2026-08-25, draft for MOI review)', titleAr: 'وثيقة متطلبات منصة مناقصات وزارة الداخلية v0.1 (2026-08-25، مسودة للمراجعة)',
    annotations: MOI_ANNOTATIONS, openItems: MOI_OPEN_ITEMS,
  };
}
