// Checklist used by the grade-review agent (tenderflow_grade_reviewer). It is a CONFIGURABLE document checklist,
// not a statement of Ministry of Commerce grading law: TenderFlow does not encode grading thresholds. An entity
// replaces it with its own list through WXO_GRADE_CRITERIA (JSON), either one list for every grade
//   [{"key":"CR","nameEn":"...","nameAr":"..."}, ...]
// or one list per grade
//   {"1":[...], "2":[...], "3":[...]}
import type { GradeCriterion } from './types.js';

export const DEFAULT_GRADE_CRITERIA: GradeCriterion[] = [
  { key: 'COMMERCIAL_REGISTRATION', nameEn: 'Valid commercial registration', nameAr: 'سجل تجاري ساري المفعول' },
  { key: 'CHAMBER_CERTIFICATE', nameEn: 'Chamber of commerce membership certificate', nameAr: 'شهادة عضوية غرفة التجارة' },
  { key: 'CLASSIFICATION_CERTIFICATE', nameEn: 'Classification certificate showing the requested grade', nameAr: 'شهادة التصنيف بالدرجة المطلوبة' },
  { key: 'FINANCIAL_STATEMENTS', nameEn: 'Audited financial statements for the latest year', nameAr: 'بيانات مالية مدققة لآخر سنة' },
  { key: 'SIMILAR_PROJECTS', nameEn: 'List of completed similar projects with values', nameAr: 'قائمة بالمشاريع المماثلة المنفذة مع قيمها' },
  { key: 'KEY_STAFF', nameEn: 'Key technical staff list or CVs', nameAr: 'قائمة الكوادر الفنية الرئيسية أو سيرهم الذاتية' },
];

const KEY_RE = /^[A-Za-z0-9_-]{1,60}$/;

function parseList(v: unknown): GradeCriterion[] | null {
  if (!Array.isArray(v) || !v.length) return null;
  const out: GradeCriterion[] = [];
  for (const x of v) {
    const k = (x as any)?.key; const en = (x as any)?.nameEn; const ar = (x as any)?.nameAr;
    if (typeof k !== 'string' || !KEY_RE.test(k) || typeof en !== 'string' || !en.trim() || typeof ar !== 'string' || !ar.trim()) return null;
    out.push({ key: k, nameEn: en.trim(), nameAr: ar.trim() });
  }
  return out;
}

/** The checklist for a grade: WXO_GRADE_CRITERIA when valid, otherwise the default list. Throws on invalid JSON so a typo is visible. */
export function gradeCriteria(grade: 1 | 2 | 3, env: NodeJS.ProcessEnv = process.env): GradeCriterion[] {
  const raw = (env.WXO_GRADE_CRITERIA ?? '').trim();
  if (!raw) return DEFAULT_GRADE_CRITERIA;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('WXO_GRADE_CRITERIA is not valid JSON'); }
  const list = Array.isArray(parsed) ? parseList(parsed) : parseList((parsed as Record<string, unknown>)?.[String(grade)]);
  if (!list) throw new Error(`WXO_GRADE_CRITERIA has no valid checklist for grade ${grade} (expected [{key,nameEn,nameAr}] or {"${grade}":[...]})`);
  return list;
}
