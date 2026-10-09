export type Locale = 'ar' | 'en';

export interface TranslationDictionary {
  brandName: string;
  tagline: string;
  tenders: string;
  vendors: string;
  controlPanel: string;
  procurement: string;
  vendorPortal: string;
  sealedBids: string;
  bidOpening: string;
  evaluation: string;
  award: string;
  status: string;
  published: string;
  draft: string;
  closed: string;
  awarded: string;
  budget: string;
  deadline: string;
  submitBid: string;
  clarifications: string;
  askQuestion: string;
  switchLanguage: string;
  auditTrail: string;
  aiAdvisor: string;
  aiAdvisoryNotice: string;
}

export const translations: Record<Locale, TranslationDictionary> = {
  ar: {
    brandName: 'تندر فلو',
    tagline: 'منصة إدارة المناقصات والمظاريف المغلقة الذكية',
    tenders: 'المناقصات',
    vendors: 'الموردون',
    controlPanel: 'لوحة التحكم',
    procurement: 'إدارة المشتريات',
    vendorPortal: 'بوابة الموردين',
    sealedBids: 'المظاريف المغلقة',
    bidOpening: 'فتح المظاريف',
    evaluation: 'التقييم الفني والمالي',
    award: 'الترسية النهائية',
    status: 'الحالة',
    published: 'منشورة',
    draft: 'مسودة',
    closed: 'مغلقة',
    awarded: 'تمت الترسية',
    budget: 'الميزانية التقديرية',
    deadline: 'الموعد النهائي للتقديم',
    submitBid: 'تقديم العطاء المغلق',
    clarifications: 'الاستفسارات والتوضيحات',
    askQuestion: 'تقديم استفسار',
    switchLanguage: 'English',
    auditTrail: 'سجل التدقيق الرقمي',
    aiAdvisor: 'المستشار الذكي للمشتريات',
    aiAdvisoryNotice: 'ملاحظة استشارية: توصيات الذكاء الاصطناعي استشارية وتتطلب اعتماداً بشرياً رسمياً.'
  },
  en: {
    brandName: 'TenderFlow',
    tagline: 'Enterprise Digital Tendering & Sealed Bids Platform',
    tenders: 'Tenders',
    vendors: 'Vendors',
    controlPanel: 'Control Panel',
    procurement: 'Procurement Operations',
    vendorPortal: 'Vendor Portal',
    sealedBids: 'Sealed Bids',
    bidOpening: 'Bid Opening Ceremony',
    evaluation: 'Evaluation & Scoring',
    award: 'Contract Award',
    status: 'Status',
    published: 'Published',
    draft: 'Draft',
    closed: 'Closed',
    awarded: 'Awarded',
    budget: 'Estimated Budget',
    deadline: 'Submission Deadline',
    submitBid: 'Submit Sealed Bid',
    clarifications: 'Clarifications & Q&A',
    askQuestion: 'Submit Clarification',
    switchLanguage: 'العربية',
    auditTrail: 'Audit Trail Ledger',
    aiAdvisor: 'Procurement AI Advisor',
    aiAdvisoryNotice: 'Advisory Notice: AI outputs are recommendations only and require human approval.'
  }
};
