// UI strings of the HARDEN workstream (sign-in lockout, protected pdf.js viewer). Every key exists in both languages.
export const en = {
  'harden.viewer.view': 'View',
  'harden.viewer.viewHint': 'Open in the protected viewer: watermarked with your name, the time and the entity; the view is recorded',
  'harden.viewer.watermarked': 'Watermarked',
  'harden.viewer.pages': 'Pages: {n}',
  'harden.viewer.honestStaff': 'Every page carries your username, the entity and the time. A browser cannot technically prevent screenshots or photos of the screen; the watermark makes any copy traceable to you.',

  'harden.lock.column': 'Sign-in lock',
  'harden.lock.lockedUntil': 'Locked until {time}',
  'harden.lock.failures': '{n} failed sign-in attempts',
  'harden.lock.unlock': 'Unlock',
  'harden.lock.unlocked': 'Sign-in unlocked for {user}',

  'security.err.ACCOUNT_LOCKED': 'Too many failed sign-in attempts. Sign-in is locked for a few minutes — try again later or ask your entity administrator to unlock the account.',
  'security.err.VIEW_GRANT_INVALID': 'This viewing link is not valid for you or this document. Close the viewer and open the document again.',
  'security.err.VIEW_GRANT_USED': 'This viewing link was already used. Close the viewer and open the document again.',
  'security.err.VIEW_GRANT_EXPIRED': 'This viewing link expired. Close the viewer and open the document again.',
  'security.err.VIEWER_FORMAT_UNSUPPORTED': 'This file type cannot be shown in the protected PDF viewer.',
  'security.err.IMAGE_UNREADABLE': 'This image could not be read for the protected viewer.',
  'security.err.BID_SEALED': 'This bid is sealed until the opening ceremony.',
  'security.err.FINANCIAL_SEALED': 'The financial envelope stays sealed until the committee chair opens it.',
  'security.err.SSO_BROWSER_MISMATCH': 'This sign-in was not started in this browser, or its cookie expired or was blocked. Start the directory sign-in again.',
};

export const ar: Record<keyof typeof en, string> = {
  'harden.viewer.view': 'عرض',
  'harden.viewer.viewHint': 'فتح في العارض المحمي: يحمل علامة مائية باسمك والوقت والجهة، ويُسجَّل العرض',
  'harden.viewer.watermarked': 'بعلامة مائية',
  'harden.viewer.pages': 'عدد الصفحات: {n}',
  'harden.viewer.honestStaff': 'تحمل كل صفحة اسم المستخدم والجهة والوقت. لا يستطيع المتصفح تقنيًا منع لقطات الشاشة أو تصويرها؛ والعلامة المائية تجعل أي نسخة قابلة للتتبع إليك.',

  'harden.lock.column': 'قفل الدخول',
  'harden.lock.lockedUntil': 'مقفل حتى {time}',
  'harden.lock.failures': '{n} محاولات دخول فاشلة',
  'harden.lock.unlock': 'فتح القفل',
  'harden.lock.unlocked': 'تم فتح قفل الدخول للمستخدم {user}',

  'security.err.ACCOUNT_LOCKED': 'محاولات دخول فاشلة كثيرة. الدخول مقفل لبضع دقائق — أعد المحاولة لاحقًا أو اطلب من مسؤول جهتك فتح القفل.',
  'security.err.VIEW_GRANT_INVALID': 'رابط العرض هذا غير صالح لك أو لهذا المستند. أغلق العارض وافتح المستند مرة أخرى.',
  'security.err.VIEW_GRANT_USED': 'استُخدم رابط العرض هذا من قبل. أغلق العارض وافتح المستند مرة أخرى.',
  'security.err.VIEW_GRANT_EXPIRED': 'انتهت صلاحية رابط العرض. أغلق العارض وافتح المستند مرة أخرى.',
  'security.err.VIEWER_FORMAT_UNSUPPORTED': 'لا يمكن عرض نوع هذا الملف في عارض PDF المحمي.',
  'security.err.IMAGE_UNREADABLE': 'تعذّرت قراءة هذه الصورة لعرضها في العارض المحمي.',
  'security.err.BID_SEALED': 'هذا العطاء مختوم حتى جلسة فتح المظاريف.',
  'security.err.FINANCIAL_SEALED': 'يبقى المظروف المالي مختومًا حتى يفتحه رئيس اللجنة.',
  'security.err.SSO_BROWSER_MISMATCH': 'لم يبدأ تسجيل الدخول هذا في هذا المتصفح، أو انتهت صلاحية ملف تعريف الارتباط أو حُظر. ابدأ الدخول عبر الدليل من جديد.',
};
