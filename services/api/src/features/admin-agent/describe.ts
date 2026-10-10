// Plain-language (English + Arabic) sentences for admin-builder operations, cycle-template settings and rule actions.
// Everything here is computed from the validated configuration — never from the agent's own wording — so what the
// administrator reads is exactly what TenderFlow will save.
import type { Bilingual } from '../../ai/index.js';
import { canonicalJson } from '../../util.js';
import { describe, type Condition } from '../../lowcode/conditions.js';
import { triggerDef, type FactDef } from '../../lowcode/catalog.js';
import type { Action, Rule } from '../../lowcode/rules.js';
import type { FormField } from '../../lowcode/forms.js';
import type { ApprovalLevel, CycleConfig } from '../../services/templates.js';

export const ROLE_LABELS: Record<string, Bilingual> = {
  PROCUREMENT_OFFICER: { en: 'Procurement officer', ar: 'موظف المشتريات' },
  DIRECTOR: { en: 'Procurement Director', ar: 'مدير المشتريات' },
  UNDERSECRETARY: { en: 'Undersecretary', ar: 'الوكيل' },
  COMMITTEE_CHAIR: { en: 'Committee chair', ar: 'رئيس اللجنة' },
  EVALUATOR: { en: 'Evaluator', ar: 'المقيّم' },
  TENANT_ADMIN: { en: 'Entity administrator', ar: 'مسؤول النظام' },
  AUDITOR: { en: 'Auditor', ar: 'المدقق' },
  GRADING_AUTHORITY: { en: 'Grading authority', ar: 'جهة التصنيف' },
};
export const roleLabel = (role: string): Bilingual => ROLE_LABELS[role] ?? { en: role, ar: role };

export const FORM_LABELS: Record<string, Bilingual> = {
  TENDER: { en: 'tender form', ar: 'نموذج المناقصة' },
  REQUEST: { en: 'departmental request form', ar: 'نموذج طلب الإدارة' },
  VENDOR: { en: 'vendor registration form', ar: 'نموذج تسجيل المورد' },
};

const FIELD_TYPE_LABELS: Record<string, Bilingual> = {
  text: { en: 'text', ar: 'نص' }, textarea: { en: 'long text', ar: 'نص طويل' }, number: { en: 'number', ar: 'رقم' },
  money: { en: 'amount', ar: 'مبلغ' }, percent: { en: 'percentage', ar: 'نسبة مئوية' }, date: { en: 'date', ar: 'تاريخ' },
  select: { en: 'choice', ar: 'اختيار' }, multiselect: { en: 'multiple choice', ar: 'اختيار متعدد' }, checkbox: { en: 'yes/no', ar: 'نعم/لا' },
  email: { en: 'e-mail', ar: 'بريد إلكتروني' }, phone: { en: 'phone', ar: 'هاتف' }, url: { en: 'web address', ar: 'عنوان ويب' },
  computed: { en: 'calculated', ar: 'محسوب' },
};

const GRADE: Record<number, Bilingual> = { 1: { en: 'First', ar: 'الأولى' }, 2: { en: 'Second', ar: 'الثانية' }, 3: { en: 'Third', ar: 'الثالثة' } };

/** Labels of template settings (paths of CycleConfig) for change lists. */
const SETTING_LABELS: Record<string, Bilingual> = {
  scope: { en: 'cycle scope', ar: 'نطاق الدورة' },
  envelopes: { en: 'envelopes', ar: 'المظاريف' },
  'evaluation.technicalPassMark': { en: 'technical pass mark', ar: 'درجة النجاح الفنية' },
  'evaluation.financialCriteria': { en: 'financial criteria', ar: 'المعايير المالية' },
  'approvals.request': { en: 'request approvals', ar: 'اعتمادات الطلب' },
  'approvals.publish': { en: 'publication approvals', ar: 'اعتمادات النشر' },
  'approvals.award': { en: 'award approvals', ar: 'اعتمادات الترسية' },
  'stages.requestIntake': { en: 'departmental request stage', ar: 'مرحلة طلب الإدارة' },
  'stages.documentPurchase': { en: 'paid tender documents', ar: 'بيع وثائق المناقصة' },
  'stages.gazette': { en: 'Kuwait Al-Youm notice', ar: 'إعلان الكويت اليوم' },
  'stages.capt': { en: 'CAPT notice', ar: 'إعلان الجهاز المركزي للمناقصات' },
  'stages.complianceScreening': { en: 'compliance screening', ar: 'فحص المطابقة' },
  'stages.recordsLock': { en: 'records lock at award', ar: 'قفل السجلات عند الترسية' },
  'fees.documentPrice': { en: 'document price', ar: 'سعر الوثائق' },
  'fees.currency': { en: 'currency', ar: 'العملة' },
  'fees.exemptionAllowed': { en: 'fee exemptions', ar: 'الإعفاء من الرسوم' },
  'eligibility.minGrade': { en: 'minimum vendor grade', ar: 'أدنى درجة تصنيف' },
  'eligibility.activityCodes': { en: 'activity codes', ar: 'رموز الأنشطة' },
};
export const settingLabel = (path: string): Bilingual =>
  SETTING_LABELS[path] ?? (path.startsWith('ai.') ? { en: `AI: ${path.slice(3)}`, ar: `الذكاء الاصطناعي: ${path.slice(3)}` } : { en: path, ar: path });

const chain = (levels: ApprovalLevel[], lang: 'en' | 'ar') =>
  levels.map((l) => (lang === 'ar' ? l.labelAr || roleLabel(l.role).ar : l.labelEn || roleLabel(l.role).en)).join(lang === 'ar' ? ' ← ' : ' → ');

/** Short bilingual description of a cycle-template configuration. */
export function configSummary(c: CycleConfig): Bilingual {
  const two = c.envelopes === 'TWO';
  const en = [
    two ? `two envelopes (technical pass mark ${c.evaluation.technicalPassMark}; financial criteria: ${c.evaluation.financialCriteria.join(', ')})` : 'one envelope',
    `publication approvals: ${chain(c.approvals.publish, 'en')}`,
    `award approvals: ${chain(c.approvals.award, 'en')}`,
    c.stages.documentPurchase ? `paid documents (${c.fees.documentPrice} ${c.fees.currency})` : 'free documents',
    c.eligibility.minGrade ? `minimum grade ${GRADE[c.eligibility.minGrade].en}` : 'no minimum grade',
  ];
  const ar = [
    two ? `مظروفان (درجة النجاح الفنية ${c.evaluation.technicalPassMark}؛ المعايير المالية: ${c.evaluation.financialCriteria.join('، ')})` : 'مظروف واحد',
    `اعتمادات النشر: ${chain(c.approvals.publish, 'ar')}`,
    `اعتمادات الترسية: ${chain(c.approvals.award, 'ar')}`,
    c.stages.documentPurchase ? `وثائق مدفوعة (${c.fees.documentPrice} ${c.fees.currency})` : 'وثائق مجانية',
    c.eligibility.minGrade ? `أدنى درجة ${GRADE[c.eligibility.minGrade].ar}` : 'بدون حد أدنى للدرجة',
  ];
  return { en: en.join('; '), ar: ar.join('؛ ') };
}

export function fieldSentence(f: FormField, form: string, sectionTitle: Bilingual | null, verb: 'add' | 'update'): Bilingual {
  const t = FIELD_TYPE_LABELS[f.type] ?? { en: f.type, ar: f.type };
  const fl = FORM_LABELS[form] ?? { en: form, ar: form };
  const req = f.required ? { en: f.requiredAt === 'SUBMIT' ? 'required before submission' : 'required', ar: f.requiredAt === 'SUBMIT' ? 'إلزامي قبل الرفع للاعتماد' : 'إلزامي' } : { en: 'optional', ar: 'اختياري' };
  const aud = f.audience === 'PUBLIC' ? { en: 'visible to vendors', ar: 'يظهر للموردين' } : { en: 'internal', ar: 'داخلي' };
  const sec = sectionTitle ? { en: ` in section “${sectionTitle.en}”`, ar: ` في قسم «${sectionTitle.ar}»` } : { en: '', ar: '' };
  return verb === 'add'
    ? { en: `Add the field “${f.labelEn}” (${f.key}; ${t.en}; ${req.en}; ${aud.en}) to the ${fl.en}${sec.en}.`,
        ar: `إضافة الحقل «${f.labelAr}» (${f.key}؛ ${t.ar}؛ ${req.ar}؛ ${aud.ar}) إلى ${fl.ar}${sec.ar}.` }
    : { en: `Change the field “${f.labelEn}” (${f.key}) of the ${fl.en}: now ${t.en}, ${req.en}, ${aud.en}${sec.en}.`,
        ar: `تعديل الحقل «${f.labelAr}» (${f.key}) في ${fl.ar}: ${t.ar}، ${req.ar}، ${aud.ar}${sec.ar}.` };
}

function actionText(a: Action, lang: 'en' | 'ar', fieldLabel: (k: string) => Bilingual): string {
  const ar = lang === 'ar';
  switch (a.type) {
    case 'ADD_APPROVER': return ar ? `إضافة مستوى اعتماد: ${a.labelAr}` : `add an approval level: ${a.labelEn} (${a.role})`;
    case 'BLOCK': return ar ? `إيقاف الخطوة برسالة «${a.messageAr}»` : `stop the step with the message “${a.messageEn}”`;
    case 'REQUIRE_FIELDS': return ar ? `اشتراط تعبئة: ${a.fields.map((k) => fieldLabel(k).ar).join('، ')}` : `require: ${a.fields.map((k) => fieldLabel(k).en).join(', ')}`;
    case 'REQUIRE_DOCUMENTS': return ar
      ? `اشتراط ${a.minCount} مستند على الأقل في الكراسة${a.titleContains ? ` يتضمن عنوانه «${a.titleContains}»` : ''}`
      : `require at least ${a.minCount} pack document(s)${a.titleContains ? ` whose title contains “${a.titleContains}”` : ''}`;
    case 'NOTIFY': {
      const who = a.to === 'ROLE' ? roleLabel(a.role!)[lang] : a.to === 'CREATOR' ? (ar ? 'منشئ المناقصة' : 'the creator') : (ar ? 'المورد المعني' : 'the vendor');
      return ar ? `إشعار ${who}: «${a.titleAr}»` : `notify ${who}: “${a.titleEn}”`;
    }
    case 'CREATE_TASK': {
      const due = a.dueHours ? (ar ? ` (خلال ${a.dueHours} ساعة)` : ` (due in ${a.dueHours} h)`) : '';
      const blocks = a.blocksGate ? (ar ? `، ويجب إنجازها قبل ${triggerDef(a.blocksGate)?.labelAr ?? a.blocksGate}` : `, to be done before: ${triggerDef(a.blocksGate)?.labelEn ?? a.blocksGate}`) : '';
      return ar ? `إنشاء مهمة لـ${roleLabel(a.role).ar}: «${a.titleAr}»${due}${blocks}` : `create a task for ${roleLabel(a.role).en}: “${a.titleEn}”${due}${blocks}`;
    }
    case 'WEBHOOK': return ar ? `استدعاء التكامل ${a.endpoint}` : `call the integration ${a.endpoint}`;
    case 'SET_FIELD': return ar ? `تعيين ${fieldLabel(a.field).ar} إلى ${JSON.stringify(a.value)}` : `set ${fieldLabel(a.field).en} to ${JSON.stringify(a.value)}`;
  }
}

/** "When <trigger>, if <condition>, then <actions>." in both languages. */
export function ruleSentence(r: Rule, facts: FactDef[], fieldLabel: (k: string) => Bilingual): Bilingual {
  const t = triggerDef(r.trigger);
  const hours = r.params?.hoursBefore;
  const whenEn = `${t?.labelEn ?? r.trigger}${hours ? ` (${hours} hours before)` : ''}`;
  const whenAr = `${t?.labelAr ?? r.trigger}${hours ? ` (قبل ${hours} ساعة)` : ''}`;
  const condEn = r.when ? `, if ${describe(r.when as Condition, facts, 'en')}` : '';
  const condAr = r.when ? `، إذا ${describe(r.when as Condition, facts, 'ar')}` : '';
  return {
    en: `When: ${whenEn}${condEn}, then ${r.actions.map((a) => actionText(a, 'en', fieldLabel)).join('; ')}.`,
    ar: `عند: ${whenAr}${condAr}، يتم ${r.actions.map((a) => actionText(a, 'ar', fieldLabel)).join('؛ ')}.`,
  };
}

/** Flat list of changed paths between two plain objects (arrays and scalars compared as JSON). */
export function flatDiff(before: unknown, after: unknown, prefix = ''): { path: string; before: unknown; after: unknown }[] {
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (isObj(before) && isObj(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys.flatMap((k) => flatDiff(before[k], after[k], prefix ? `${prefix}.${k}` : k));
  }
  // Key order is not meaningful (jsonb reorders keys): compare canonically.
  if (canonicalJson(before ?? null) === canonicalJson(after ?? null)) return [];
  return [{ path: prefix || '(value)', before: before ?? null, after: after ?? null }];
}
