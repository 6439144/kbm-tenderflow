// Dedicated entity edition (docs/DEPLOYMENT-MODEL.md): strings used when the installation serves one government
// entity (GET /api/v1/public/deployment → mode 'dedicated'). Shared installations keep the original strings.
export const en = {
  'ded.brand.product': 'TenderFlow e-tendering',
  'ded.login.subtitle': 'Secure access to the e-tendering platform of {entity}',
  'ded.login.entity': 'Entity',
  'ded.notProvisioned': 'This installation is not set up yet: its administrator must create the entity first.',
  'ded.reg.subtitle': 'Register your company with {entity}. Its procurement team reviews your documents before you can bid.',
  'ded.reg.separate': 'This supplier account is for {entity} only. Each government entity runs its own tendering system, so suppliers register separately with each entity they want to work with.',
  'ded.reg.sharedNote': 'Your supplier account is for the selected entity only. To bid for another entity, register with that entity separately.',
  'ded.board.title': 'Public tenders of {entity}',
  'ded.board.subtitle': 'Open tenders published by {entity}. No sign-in needed.',
  'ded.board.note': 'Only tenders that {entity} has published and chosen to list publicly appear here. To buy documents or bid, register as a supplier with {entity} and sign in.',
  'ded.setting.hint': 'When on, the PUBLISHED tenders of this entity appear on its public tender board (/tenders) and RSS/JSON feeds: number, titles, category, activity codes, deadline, document price and official publication references only. Documents, bids and vendor data are never published. Turn it off if tenders may be shown only to eligible vendors.',
  'ded.pkg.intro': 'Export this entity’s process (cycle templates, forms, rules, integrations — never secrets) and import it into another TenderFlow installation, for example a test system. Imports arrive as drafts for review.',
  'ded.jobs.scope': 'this entity',
} as const;

export const ar: Record<keyof typeof en, string> = {
  'ded.brand.product': 'تندرفلو للمناقصات الإلكترونية',
  'ded.login.subtitle': 'دخول آمن إلى منصة المناقصات الإلكترونية لدى {entity}',
  'ded.login.entity': 'الجهة',
  'ded.notProvisioned': 'لم يكتمل إعداد هذا النظام بعد: يجب على مسؤول النظام إنشاء الجهة أولاً.',
  'ded.reg.subtitle': 'سجّل شركتك لدى {entity}. يراجع فريق المشتريات فيها مستنداتك قبل السماح لك بتقديم العطاءات.',
  'ded.reg.separate': 'هذا الحساب صالح لدى {entity} فقط. لكل جهة حكومية نظام مناقصات مستقل، لذا يسجّل المورد لدى كل جهة يرغب في التعامل معها على حدة.',
  'ded.reg.sharedNote': 'حساب المورد خاص بالجهة المختارة فقط. للتقدم إلى جهة أخرى سجّل لديها بشكل منفصل.',
  'ded.board.title': 'المناقصات العامة لدى {entity}',
  'ded.board.subtitle': 'المناقصات المفتوحة المنشورة من {entity}، دون الحاجة لتسجيل الدخول.',
  'ded.board.note': 'تظهر هنا فقط المناقصات التي نشرتها {entity} واختارت عرضها للعموم. لشراء الوثائق أو تقديم عطاء سجّل كمورد لدى {entity} ثم سجّل الدخول.',
  'ded.setting.hint': 'عند التفعيل تظهر المناقصات المنشورة لهذه الجهة في لوحة المناقصات العامة الخاصة بها (/tenders) وخلاصات RSS/JSON: الرقم والعناوين والفئة ورموز النشاط والموعد النهائي وسعر الوثائق ومراجع النشر الرسمية فقط. لا تُنشر المستندات أو العطاءات أو بيانات الموردين أبداً. أوقفه إذا كان يجب عرض المناقصات على الموردين المؤهلين فقط.',
  'ded.pkg.intro': 'صدّر إجراءات هذه الجهة (قوالب الدورة والنماذج والقواعد والتكاملات — دون أي أسرار) واستوردها في نظام تندرفلو آخر، مثل نظام الاختبار. تصل عمليات الاستيراد كمسودات للمراجعة.',
  'ded.jobs.scope': 'هذه الجهة',
};
