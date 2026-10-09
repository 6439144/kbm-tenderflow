// Default notification templates installed for every entity (tenant): the MOI BRD set NOT-001..NOT-005 and the
// events TenderFlow already raised in-app. Admins edit the texts (EN + AR) and the channels per entity; codes are fixed.
//
// Placeholders are written {name}. A value can be language-specific: when rendering Arabic, {title} takes `titleAr`
// if the caller supplied it, otherwise `title`; English takes `titleEn`, otherwise `title`.

export type Channel = 'IN_APP' | 'EMAIL' | 'SMS';
export const CHANNELS: Channel[] = ['IN_APP', 'EMAIL', 'SMS'];
export const OPTIONAL_CHANNELS: Channel[] = ['EMAIL', 'SMS'];

export interface DefaultTemplate {
  code: string;
  audience: 'VENDOR' | 'STAFF';
  channels: Channel[];
  /** BRD = MOI notification requirement (NOT-00x); SYSTEM = TenderFlow event. */
  source: 'BRD' | 'SYSTEM';
  mandatory?: boolean;
  placeholders: string[];
  subjectEn: string; subjectAr: string; bodyEn: string; bodyAr: string;
}

/** Available in every template. */
export const COMMON_PLACEHOLDERS = ['entityName', 'recipientName', 'link', 'title'];

export const DEFAULT_TEMPLATES: DefaultTemplate[] = [
  // ------------------------------------------------------------------ MOI BRD
  {
    code: 'NOT-001_SUBSCRIPTION_RENEWAL', audience: 'VENDOR', channels: ['IN_APP', 'EMAIL', 'SMS'], source: 'BRD', mandatory: true,
    placeholders: ['vendorName', 'expiryDate', 'daysLeft', 'renewalLink'],
    subjectEn: 'Subscription renewal due: {vendorName}',
    subjectAr: 'تذكير بتجديد الاشتراك: {vendorName}',
    bodyEn: 'Dear {vendorName}, your supplier subscription with {entityName} expires on {expiryDate} ({daysLeft} days left). Renew it to keep receiving and bidding on tenders: {renewalLink}',
    bodyAr: 'السادة {vendorName}، ينتهي اشتراككم كمورد لدى {entityName} بتاريخ {expiryDate} (متبقٍ {daysLeft} يومًا). يرجى التجديد للاستمرار في استلام المناقصات وتقديم العطاءات: {renewalLink}',
  },
  {
    code: 'NOT-002_NEW_VENDOR_APPLICATION', audience: 'STAFF', channels: ['IN_APP', 'EMAIL'], source: 'BRD',
    placeholders: ['vendorName', 'crNumber'],
    subjectEn: 'New vendor application: {vendorName}',
    subjectAr: 'طلب تسجيل مورد جديد: {vendorName}',
    bodyEn: '{vendorName} (commercial registration {crNumber}) applied to register as a supplier with {entityName}. Review the application: {link}',
    bodyAr: 'تقدّم {vendorName} (السجل التجاري {crNumber}) بطلب تسجيل كمورد لدى {entityName}. لمراجعة الطلب: {link}',
  },
  {
    code: 'NOT-003_GRADE_UPGRADE_APPROVED', audience: 'VENDOR', channels: ['IN_APP', 'EMAIL'], source: 'BRD',
    placeholders: ['vendorName', 'activityCode', 'grade'],
    subjectEn: 'Grade upgrade approved: {activityCode}',
    subjectAr: 'تمت الموافقة على ترقية الدرجة: {activityCode}',
    bodyEn: 'Dear {vendorName}, {entityName} approved your grade upgrade. Your classification for activity {activityCode} is now grade {grade}.',
    bodyAr: 'السادة {vendorName}، وافقت {entityName} على ترقية درجتكم. أصبح تصنيفكم في النشاط {activityCode} من الدرجة {grade}.',
  },
  {
    code: 'NOT-004_REGISTRATION_APPROVED', audience: 'VENDOR', channels: ['IN_APP', 'EMAIL', 'SMS'], source: 'BRD',
    placeholders: ['vendorName', 'knetLink'],
    subjectEn: 'Registration approved: complete your subscription',
    subjectAr: 'تمت الموافقة على التسجيل: يرجى إكمال الاشتراك',
    bodyEn: 'Dear {vendorName}, your registration with {entityName} has been approved. Pay the subscription through KNET to activate your supplier account: {knetLink}',
    bodyAr: 'السادة {vendorName}، تمت الموافقة على تسجيلكم لدى {entityName}. يرجى سداد الاشتراك عبر كي نت لتفعيل حسابكم كمورد: {knetLink}',
  },
  {
    code: 'NOT-005_VENDOR_BLOCKED', audience: 'VENDOR', channels: ['IN_APP', 'EMAIL', 'SMS'], source: 'BRD',
    placeholders: ['vendorName', 'action', 'reason', 'until'],
    subjectEn: 'Supplier account {action}: {vendorName}',
    subjectAr: 'تم {action} حساب المورد: {vendorName}',
    bodyEn: 'Dear {vendorName}, your supplier account with {entityName} has been {action}.\nReason: {reason}\nUntil: {until}\nContact the procurement department for details.',
    bodyAr: 'السادة {vendorName}، تم {action} حسابكم كمورد لدى {entityName}.\nالسبب: {reason}\nحتى: {until}\nيرجى التواصل مع إدارة المشتريات للتفاصيل.',
  },

  // ------------------------------------------------------------------ TenderFlow events
  {
    code: 'APPROVAL_WAITING', audience: 'STAFF', channels: ['IN_APP'], source: 'SYSTEM',
    placeholders: ['reference', 'subjectTitle'],
    subjectEn: '{title}', subjectAr: '{title}',
    bodyEn: '{reference} — {subjectTitle} is waiting for your approval decision: {link}',
    bodyAr: '{reference} — {subjectTitle} بانتظار قرار الاعتماد منكم: {link}',
  },
  {
    code: 'TENDER_PUBLISHED', audience: 'VENDOR', channels: ['IN_APP'], source: 'SYSTEM',
    placeholders: ['tenderNumber', 'tenderTitle', 'deadline'],
    subjectEn: '{title}', subjectAr: '{title}',
    bodyEn: '{entityName} published tender {tenderNumber} — {tenderTitle}, which matches your activity. Submission deadline: {deadline}. {link}',
    bodyAr: 'طرحت {entityName} المناقصة {tenderNumber} — {tenderTitle} ضمن نشاطكم. آخر موعد لتقديم العطاءات: {deadline}. {link}',
  },
  {
    code: 'CLARIFICATION_ANSWERED', audience: 'VENDOR', channels: ['IN_APP'], source: 'SYSTEM',
    placeholders: ['tenderNumber', 'tenderTitle'],
    subjectEn: 'Your clarification on {tenderNumber} was answered',
    subjectAr: 'تمت الإجابة على استفساركم بشأن {tenderNumber}',
    bodyEn: 'The procurement team answered your clarification on {tenderNumber} — {tenderTitle}. Read the answer: {link}',
    bodyAr: 'أجاب فريق المشتريات على استفساركم بشأن {tenderNumber} — {tenderTitle}. للاطلاع على الإجابة: {link}',
  },
  {
    code: 'BIDS_OPENED', audience: 'VENDOR', channels: ['IN_APP'], source: 'SYSTEM',
    placeholders: ['tenderNumber', 'tenderTitle'],
    subjectEn: 'Bids opened: {tenderNumber}',
    subjectAr: 'تم فتح العطاءات: {tenderNumber}',
    bodyEn: 'The tender committee opened the bids of {tenderNumber} — {tenderTitle}. Your bid is now under evaluation. {link}',
    bodyAr: 'فتحت لجنة المناقصات عطاءات {tenderNumber} — {tenderTitle}. عطاؤكم الآن قيد التقييم. {link}',
  },
  {
    code: 'AWARD_APPROVED', audience: 'STAFF', channels: ['IN_APP'], source: 'SYSTEM',
    placeholders: ['tenderNumber', 'tenderTitle'],
    subjectEn: 'Award approved: {tenderNumber}',
    subjectAr: 'تم اعتماد الترسية: {tenderNumber}',
    bodyEn: 'The award of {tenderNumber} — {tenderTitle} was approved at the final level. The committee report is attached to the tender: {link}',
    bodyAr: 'تم اعتماد ترسية {tenderNumber} — {tenderTitle} في المستوى الأخير. تقرير اللجنة مرفق بالمناقصة: {link}',
  },
  {
    code: 'DOCUMENT_EXPIRING', audience: 'VENDOR', channels: ['IN_APP', 'EMAIL'], source: 'SYSTEM',
    placeholders: ['documentTitle', 'date'],
    subjectEn: '{title}', subjectAr: '{title}',
    bodyEn: 'Your document "{documentTitle}" expires on {date}. Upload a renewed copy to stay eligible: {link}',
    bodyAr: 'تنتهي صلاحية مستندكم "{documentTitle}" بتاريخ {date}. يرجى رفع نسخة مجددة للحفاظ على الأهلية: {link}',
  },
  {
    code: 'DOCUMENT_EXPIRED', audience: 'VENDOR', channels: ['IN_APP', 'EMAIL'], source: 'SYSTEM',
    placeholders: ['documentTitle', 'date'],
    subjectEn: '{title}', subjectAr: '{title}',
    bodyEn: 'Your document "{documentTitle}" expired on {date}. Upload a valid copy: {link}',
    bodyAr: 'انتهت صلاحية مستندكم "{documentTitle}" بتاريخ {date}. يرجى رفع نسخة سارية: {link}',
  },
  {
    code: 'DOCUMENT_INSIGHT_READY', audience: 'STAFF', channels: ['IN_APP'], source: 'SYSTEM',
    placeholders: ['documentTitle', 'docType'],
    subjectEn: 'Document data ready for review: {documentTitle}',
    subjectAr: 'بيانات مستند جاهزة للمراجعة: {documentTitle}',
    bodyEn: 'IBM watsonx Orchestrate classified "{documentTitle}" as {docType}. A person must review the extracted data before it is used: {link}',
    bodyAr: 'صنّف IBM watsonx Orchestrate المستند "{documentTitle}" على أنه {docType}. يجب أن يراجع شخص البيانات المستخرجة قبل استخدامها: {link}',
  },
  {
    code: 'APPROVAL_REMINDER', audience: 'STAFF', channels: ['IN_APP', 'EMAIL'], source: 'SYSTEM',
    placeholders: ['reference', 'subjectTitle', 'gate', 'level', 'dueAt'],
    subjectEn: 'Reminder: approval of {reference} is due {dueAt}',
    subjectAr: 'تذكير: موعد اعتماد {reference} هو {dueAt}',
    bodyEn: 'Level {level} of the {gate} approval of {reference} — {subjectTitle} is due on {dueAt}. {link}',
    bodyAr: 'المستوى {level} من {gate} للبند {reference} — {subjectTitle} مستحق بتاريخ {dueAt}. {link}',
  },
  {
    code: 'APPROVAL_ESCALATED', audience: 'STAFF', channels: ['IN_APP', 'EMAIL'], source: 'SYSTEM',
    placeholders: ['reference', 'subjectTitle', 'gate', 'level', 'role', 'dueAt', 'overdue'],
    subjectEn: 'Escalation: approval of {reference} is overdue',
    subjectAr: 'تصعيد: تأخر اعتماد {reference}',
    bodyEn: 'Level {level} ({role}) of the {gate} approval of {reference} — {subjectTitle} was due on {dueAt} and is overdue by {overdue}. It is escalated to you for follow-up; the approval itself is unchanged and still needs a decision. {link}',
    bodyAr: 'المستوى {level} ({role}) من {gate} للبند {reference} — {subjectTitle} كان مستحقًا بتاريخ {dueAt} ومتأخر بمقدار {overdue}. تم تصعيده إليكم للمتابعة؛ ولم يتغير الاعتماد نفسه وما زال بانتظار القرار. {link}',
  },
  {
    code: 'TENDER_REJECTED', audience: 'STAFF', channels: ['IN_APP'], source: 'SYSTEM',
    placeholders: ['tenderNumber', 'tenderTitle', 'level', 'reason'],
    subjectEn: 'Tender rejected: {tenderNumber}',
    subjectAr: 'تم رفض المناقصة: {tenderNumber}',
    bodyEn: '{tenderNumber} — {tenderTitle} was rejected at approval level {level} and is cancelled.\nReason: {reason}\n{link}',
    bodyAr: 'تم رفض {tenderNumber} — {tenderTitle} في مستوى الاعتماد {level} وإلغاؤها.\nالسبب: {reason}\n{link}',
  },
];

export const defaultTemplate = (code: string) => DEFAULT_TEMPLATES.find((d) => d.code === code);

/** Sample values for the admin live preview and "send test to me" (clearly fictitious). */
export const SAMPLE_VALUES: Record<string, string> = {
  entityNameEn: 'Ministry of Interior (sample)', entityNameAr: 'وزارة الداخلية (مثال)',
  recipientNameEn: 'Sample Recipient', recipientNameAr: 'مستلم تجريبي',
  link: 'https://tenderflow.example/procurement',
  titleEn: 'Approval level 2 waiting: MOI-2026-014', titleAr: 'بانتظار اعتماد المستوى 2: MOI-2026-014',
  vendorNameEn: 'Al-Sample Trading Co. (fictitious)', vendorNameAr: 'شركة النموذج للتجارة (وهمية)',
  expiryDate: '2026-11-30', daysLeft: '30', renewalLink: 'https://tenderflow.example/vendor/subscription',
  crNumber: 'CR-000000', activityCode: 'IT-01', grade: '1', knetLink: 'https://tenderflow.example/vendor/subscription/pay',
  actionEn: 'suspended', actionAr: 'إيقاف', reasonEn: 'expired commercial registration', reasonAr: 'انتهاء السجل التجاري', until: '2026-12-31',
  reference: 'MOI-2026-014', subjectTitleEn: 'Network equipment supply', subjectTitleAr: 'توريد معدات شبكات',
  tenderNumber: 'MOI-2026-014', tenderTitleEn: 'Network equipment supply', tenderTitleAr: 'توريد معدات شبكات',
  deadline: '2026-11-15 12:00', documentTitle: 'Commercial registration.pdf', date: '2026-11-30',
  docTypeEn: 'Commercial registration', docTypeAr: 'سجل تجاري',
  gateEn: 'publication', gateAr: 'اعتماد الطرح', level: '2', roleEn: 'Undersecretary', roleAr: 'الوكيل',
  dueAt: '2026-10-12 09:00', overdueEn: '5 h', overdueAr: '5 ساعات',
};
