// Rule-based flags computed by TenderFlow (never by the AI) from the extracted or corrected values: expiry, name
// match against the registered vendor, document type vs the slot/title the uploader chose, required fields, currency.
import type { DocFieldValue, DocTypeDef } from '../../ai/index.js';
import { normalizeText } from '../../ai/text-utils.js';
import { currencyIn } from '../../ai/parse.js';

export type FlagCode = 'EXPIRED' | 'EXPIRING_SOON' | 'NAME_MISMATCH' | 'TYPE_MISMATCH' | 'REQUIRED_MISSING' | 'CURRENCY_MISMATCH';
export interface Flag { code: FlagCode; severity: 'HIGH' | 'MEDIUM' | 'LOW'; field?: string; data: Record<string, string | number | string[]> }
export interface EffectiveField { key: string; value: DocFieldValue; raw?: string }

export const EXPIRY_KEYS = ['expiryDate', 'validUntil'];
export const EXPIRING_DAYS = 30;

const LEGAL_WORDS = new Set([
  'company', 'co', 'the', 'wll', 'llc', 'ltd', 'limited', 'kscc', 'kscp', 'ksc', 'kscc', 'inc', 'plc', 'est', 'establishment', 'and', 'for',
  'شركه', 'ذمم', 'ذ', 'م', 'ش', 'ك', 'مقفله', 'عامه', 'مساهمه', 'مؤسسه', 'و',
]);
/** Legal-entity name reduced to its distinctive words (legal forms, punctuation and "(fictitious)" removed). */
export function normaliseCompanyName(s: string): string {
  return normalizeText(String(s ?? '').replace(/\((?:fictitious|وهمية|وهميه)\)/gi, ' '))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((w) => w && !LEGAL_WORDS.has(w))
    .join(' ');
}
export function namesMatch(found: string, registered: (string | null | undefined)[]): boolean {
  const f = normaliseCompanyName(found);
  if (!f) return true;
  return registered.filter(Boolean).some((r) => {
    const n = normaliseCompanyName(r!);
    return !!n && (n === f || n.includes(f) || f.includes(n));
  });
}

const ALIASES: Record<string, string[]> = {
  COMMERCIAL_REGISTRATION: ['commercial registration', 'commercial register', 'cr', 'سجل تجاري', 'السجل التجاري'],
  MOCI_CLASSIFICATION_CERT: ['classification', 'moci', 'تصنيف', 'شهادة التصنيف'],
  CHAMBER_OF_COMMERCE_CERT: ['chamber of commerce', 'chamber', 'غرفة التجارة', 'الغرفة'],
  BANK_GUARANTEE: ['bank guarantee', 'guarantee', 'bid bond', 'ضمان', 'كفالة', 'كفالة بنكية'],
  ISO_CERTIFICATE: ['iso', 'ايزو', 'آيزو'],
  COMPANY_PROFILE: ['company profile', 'profile', 'نبذة', 'ملف الشركة'],
  TECHNICAL_PROPOSAL: ['technical proposal', 'technical offer', 'العرض الفني'],
  FINANCIAL_PROPOSAL: ['financial proposal', 'financial offer', 'price offer', 'العرض المالي'],
  GM_LETTER: ['gm letter', 'letter', 'كتاب', 'خطاب'],
  ADDENDUM: ['addendum', 'ملحق'],
  TENDER_PACK: ['tender pack', 'rfp', 'كراسة'],
};
const words = (s: string) => ` ${normalizeText(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/**
 * The type the uploader meant, from the upload slot (financial envelope → financial proposal, request letter → GM
 * letter, addendum) or from the title they typed (catalogue names and common aliases, whole words). null = unknown.
 */
export function expectedTypeOf(ownerType: string, title: string, catalogue: DocTypeDef[]): string | null {
  if (ownerType === 'BID_FINANCIAL') return 'FINANCIAL_PROPOSAL';
  if (ownerType === 'REQUEST_LETTER') return 'GM_LETTER';
  const t = words(title);
  let best: { code: string; len: number } | null = null; let tie = false;
  for (const def of catalogue) {
    if (def.code === 'OTHER') continue;
    for (const a of [def.nameEn, def.nameAr, ...(ALIASES[def.code] ?? [])]) {
      const w = words(a);
      if (w.trim().length < 2 || !t.includes(w)) continue;
      const len = w.length;
      if (!best || len > best.len) { best = { code: def.code, len }; tie = false; }
      else if (len === best.len && best.code !== def.code) tie = true;
    }
  }
  return best && !tie ? best.code : null;
}

export interface FlagInput {
  docType: string | null;
  fields: EffectiveField[];
  typeDef: DocTypeDef | null;
  today: string; // YYYY-MM-DD
  vendor?: { legalNameEn: string; legalNameAr: string } | null;
  expectedType?: string | null;
  tenderCurrency?: string | null;
}

const addDays = (iso: string, d: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);

export function computeFlags(i: FlagInput): Flag[] {
  const out: Flag[] = [];
  const byKey = new Map(i.fields.map((f) => [f.key, f]));
  for (const k of EXPIRY_KEYS) {
    const v = byKey.get(k)?.value;
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) continue;
    if (v < i.today) out.push({ code: 'EXPIRED', severity: 'HIGH', field: k, data: { date: v } });
    else if (v <= addDays(i.today, EXPIRING_DAYS)) out.push({ code: 'EXPIRING_SOON', severity: 'MEDIUM', field: k, data: { date: v, days: EXPIRING_DAYS } });
  }
  const name = byKey.get('companyName')?.value;
  if (i.vendor && typeof name === 'string' && name.trim() && !namesMatch(name, [i.vendor.legalNameEn, i.vendor.legalNameAr])) {
    out.push({ code: 'NAME_MISMATCH', severity: 'HIGH', field: 'companyName', data: { found: name, registeredEn: i.vendor.legalNameEn, registeredAr: i.vendor.legalNameAr } });
  }
  if (i.expectedType && i.docType && i.docType !== i.expectedType) {
    out.push({ code: 'TYPE_MISMATCH', severity: 'MEDIUM', data: { expected: i.expectedType, found: i.docType } });
  }
  if (i.typeDef) {
    const missing = i.typeDef.fields.filter((f) => f.required && !byKey.has(f.key)).map((f) => f.key);
    if (missing.length) out.push({ code: 'REQUIRED_MISSING', severity: 'MEDIUM', data: { keys: missing } });
  }
  if (i.docType === 'FINANCIAL_PROPOSAL' && i.tenderCurrency) {
    const cf = byKey.get('currency');
    const total = byKey.get('totalAmount')?.value;
    const found = (cf ? currencyIn(String(cf.raw ?? cf.value)) ?? (typeof cf.value === 'string' && /^[A-Z]{3}$/.test(cf.value) ? cf.value : null) : null)
      ?? (total && typeof total === 'object' && !Array.isArray(total) ? total.currency : null);
    if (found && found.toUpperCase() !== i.tenderCurrency.toUpperCase()) {
      out.push({ code: 'CURRENCY_MISMATCH', severity: 'HIGH', field: cf ? 'currency' : 'totalAmount', data: { found, expected: i.tenderCurrency } });
    }
  }
  return out;
}
