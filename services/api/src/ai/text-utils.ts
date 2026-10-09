// Bilingual (Arabic / English) text helpers shared by prompt building, citation mapping and evals.

const ARABIC_DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g; // tashkeel + tatweel
const LATIN_DIACRITICS = /[̀-ͯ]/g;

/** Lower-case, strip Latin and Arabic diacritics, unify Arabic letter variants and digits, collapse whitespace. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(LATIN_DIACRITICS, '')
    .replace(ARABIC_DIACRITICS, '')
    .replace(/[آأإٱ]/g, 'ا') // آ أ إ ٱ → ا
    .replace(/ى/g, 'ي') // ى → ي
    .replace(/ة/g, 'ه') // ة → ه
    .replace(/[ؤ]/g, 'و') // ؤ → و
    .replace(/[ئ]/g, 'ي') // ئ → ي
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)) // Arabic-Indic digits
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)) // Extended Arabic-Indic digits
    .replace(/[٬،]/g, ',') // Arabic thousands separator / comma
    .replace(/(\d),(?=\d{3}\b)/g, '$1') // 1,000 → 1000
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** 'ar' when the text is mostly Arabic script, otherwise 'en'. */
export function detectLanguage(s: string): 'ar' | 'en' {
  const arabic = (s.match(/[؀-ۿ]/g) ?? []).length;
  const latin = (s.match(/[A-Za-z]/g) ?? []).length;
  return arabic > 0 && arabic >= latin * 0.5 ? 'ar' : 'en';
}

const STOP = new Set([
  'the', 'and', 'for', 'are', 'what', 'which', 'when', 'where', 'who', 'how', 'does', 'did', 'is', 'was', 'with', 'this', 'that',
  'from', 'any', 'can', 'there', 'their', 'shall', 'will', 'must', 'should', 'have', 'has', 'into', 'about', 'tender', 'please',
  'ما', 'ماذا', 'هل', 'كم', 'متي', 'اين', 'من', 'في', 'علي', 'الي', 'عن', 'هو', 'هي', 'التي', 'الذي', 'ذلك', 'هذا', 'هذه', 'او', 'مع', 'لا', 'ان', 'كان', 'المناقصه',
]);

/** Distinct significant terms (normalized) for relevance ranking. */
export function keyTerms(...texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    for (const w of normalizeText(t).split(/[^\p{L}\p{N}]+/u)) {
      if (w.length >= 3 && !STOP.has(w)) out.add(w);
      // Arabic definite article: also index the bare stem ("الضمان" → "ضمان").
      if (w.startsWith('ال') && w.length >= 5) out.add(w.slice(2));
    }
  }
  return [...out];
}
