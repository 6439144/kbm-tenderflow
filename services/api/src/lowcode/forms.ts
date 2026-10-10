// Custom forms (form builder): extra fields an entity adds to tenders, departmental requests and vendor registration.
// A form definition is versioned in lowcode_definitions (kind FORM, code TENDER | REQUEST | VENDOR). Objects pin the
// version they were saved with; the server validates every value (type, required, range, options, format) and
// computes calculated fields itself (input for them is ignored).
import { badRequest, str } from '../util.js';
import { evalFormula, formulaRefs, parseFormula } from './formula.js';
import { evaluate, validateCondition, type Condition } from './conditions.js';
import type { FactDef } from './catalog.js';

export type FormCode = 'TENDER' | 'REQUEST' | 'VENDOR';
export const FORM_CODES: FormCode[] = ['TENDER', 'REQUEST', 'VENDOR'];
export const FIELD_TYPES = ['text', 'textarea', 'number', 'money', 'percent', 'date', 'select', 'multiselect', 'checkbox', 'email', 'phone', 'url', 'computed'] as const;
export type FieldType = typeof FIELD_TYPES[number];
export const FORMATS = ['none', 'digits', 'alphanumeric', 'iban', 'kwCivilId', 'crNumber'] as const;
const FORMAT_RE: Record<string, RegExp> = {
  digits: /^\d+$/, alphanumeric: /^[A-Za-z0-9]+$/, iban: /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/, kwCivilId: /^\d{12}$/, crNumber: /^[A-Za-z0-9-]{3,30}$/,
};

export interface FieldOption { value: string; labelEn: string; labelAr: string }
export interface FormField {
  key: string; type: FieldType; labelEn: string; labelAr: string; helpEn?: string; helpAr?: string; section?: string;
  required?: boolean;
  /** When a required value must be present: SAVE (every save) or SUBMIT (tender: before the first approval). */
  requiredAt?: 'SAVE' | 'SUBMIT';
  /** PUBLIC: vendors see it (tender form) / vendors fill it in (vendor form). INTERNAL: staff only. */
  audience?: 'PUBLIC' | 'INTERNAL';
  min?: number; max?: number; maxLength?: number; decimals?: number; format?: typeof FORMATS[number];
  options?: FieldOption[];
  formula?: string;
  /** Show (and validate) the field only when this condition over the form's own fields holds. */
  visibleWhen?: Condition | null;
  defaultValue?: unknown;
}
export interface FormSection { key: string; titleEn: string; titleAr: string }
export interface FormDefinition { sections: FormSection[]; fields: FormField[] }

const KEY_RE = /^[a-z][A-Za-z0-9]{0,39}$/; // camelCase only (the web client camel-cases snake_case keys)
const RESERVED = new Set(['budget', 'id', 'status', 'tenant', 'min', 'max', 'round', 'abs']);
const MAX_FIELDS = 60;

/** Facts a field condition may use: the form's own fields, referenced as `self.<key>`. */
export function selfFacts(fields: FormField[]): FactDef[] {
  const t: Record<string, FactDef['type']> = { number: 'number', money: 'number', percent: 'number', computed: 'number', date: 'date', select: 'enum', multiselect: 'list', checkbox: 'boolean' };
  return fields.map((f) => ({ key: `self.${f.key}`, labelEn: f.labelEn, labelAr: f.labelAr, type: t[f.type] ?? 'string', scopes: [], options: f.options }));
}

export function validateFormDefinition(raw: any, code: FormCode): FormDefinition {
  if (!raw || typeof raw !== 'object') throw badRequest('definition must be an object');
  const sectionsIn = Array.isArray(raw.sections) ? raw.sections : [];
  if (sectionsIn.length > 10) throw badRequest('A form may have at most 10 sections');
  const sections: FormSection[] = sectionsIn.map((s: any, i: number) => {
    if (typeof s?.key !== 'string' || !KEY_RE.test(s.key)) throw badRequest(`sections[${i}].key must be camelCase: a lower-case letter, then letters or digits`);
    return { key: s.key, titleEn: str(s.titleEn, `sections[${i}].titleEn`, { required: true, max: 120 })!, titleAr: str(s.titleAr, `sections[${i}].titleAr`, { required: true, max: 120 })! };
  });
  if (new Set(sections.map((s) => s.key)).size !== sections.length) throw badRequest('Section keys must be unique');
  const fieldsIn = Array.isArray(raw.fields) ? raw.fields : null;
  if (!fieldsIn) throw badRequest('definition.fields must be a list');
  if (fieldsIn.length > MAX_FIELDS) throw badRequest(`A form may have at most ${MAX_FIELDS} fields`);
  const fields: FormField[] = fieldsIn.map((f: any, i: number) => {
    const p = `fields[${i}]`;
    if (typeof f?.key !== 'string' || !KEY_RE.test(f.key)) throw badRequest(`${p}.key must be camelCase: a lower-case letter, then letters or digits (max 40)`);
    if (RESERVED.has(f.key)) throw badRequest(`${p}.key '${f.key}' is reserved`);
    if (!FIELD_TYPES.includes(f.type)) throw badRequest(`${p}.type must be one of ${FIELD_TYPES.join(', ')}`);
    const out: FormField = {
      key: f.key, type: f.type,
      labelEn: str(f.labelEn, `${p}.labelEn`, { required: true, max: 120 })!, labelAr: str(f.labelAr, `${p}.labelAr`, { required: true, max: 120 })!,
      helpEn: str(f.helpEn, `${p}.helpEn`, { max: 300 }), helpAr: str(f.helpAr, `${p}.helpAr`, { max: 300 }),
      required: f.type === 'computed' ? false : f.required === true,
      requiredAt: code === 'TENDER' && f.requiredAt !== 'SAVE' ? 'SUBMIT' : 'SAVE',
      audience: f.audience === 'PUBLIC' ? 'PUBLIC' : 'INTERNAL',
    };
    if (f.section !== undefined && f.section !== null && f.section !== '') {
      if (!sections.some((s) => s.key === f.section)) throw badRequest(`${p}.section '${f.section}' is not a section of this form`);
      out.section = f.section;
    }
    const n = (v: unknown, name: string) => {
      if (v === undefined || v === null || v === '') return undefined;
      const x = Number(v); if (!Number.isFinite(x)) throw badRequest(`${p}.${name} must be a number`); return x;
    };
    if (['number', 'money', 'percent'].includes(f.type)) {
      out.min = n(f.min, 'min'); out.max = n(f.max, 'max');
      if (f.type === 'percent') { out.min = out.min ?? 0; out.max = out.max ?? 100; }
      if (out.min !== undefined && out.max !== undefined && out.min > out.max) throw badRequest(`${p}: min must not exceed max`);
      const d = n(f.decimals, 'decimals'); if (d !== undefined) { if (!Number.isInteger(d) || d < 0 || d > 6) throw badRequest(`${p}.decimals must be 0-6`); out.decimals = d; }
    }
    if (['text', 'textarea', 'email', 'phone', 'url'].includes(f.type)) {
      const ml = n(f.maxLength, 'maxLength');
      const cap = f.type === 'textarea' ? 8000 : 500;
      if (ml !== undefined && (!Number.isInteger(ml) || ml < 1 || ml > cap)) throw badRequest(`${p}.maxLength must be 1-${cap}`);
      out.maxLength = ml ?? cap;
      if (f.type === 'text') {
        if (f.format !== undefined && !FORMATS.includes(f.format)) throw badRequest(`${p}.format must be one of ${FORMATS.join(', ')}`);
        if (f.format && f.format !== 'none') out.format = f.format;
      }
    }
    if (f.type === 'select' || f.type === 'multiselect') {
      if (!Array.isArray(f.options) || !f.options.length || f.options.length > 50) throw badRequest(`${p}.options must list 1-50 choices`);
      out.options = f.options.map((o: any, j: number) => {
        const v = typeof o?.value === 'string' ? o.value.trim() : '';
        if (!/^[A-Za-z0-9_.-]{1,60}$/.test(v)) throw badRequest(`${p}.options[${j}].value must be 1-60 letters, digits, _ . -`);
        return { value: v, labelEn: str(o.labelEn, `${p}.options[${j}].labelEn`, { required: true, max: 120 })!, labelAr: str(o.labelAr, `${p}.options[${j}].labelAr`, { required: true, max: 120 })! };
      });
      if (new Set(out.options!.map((o) => o.value)).size !== out.options!.length) throw badRequest(`${p}.options values must be unique`);
    }
    if (f.type === 'computed') {
      const formula = str(f.formula, `${p}.formula`, { required: true, max: 300 })!;
      parseFormula(formula);
      out.formula = formula;
      const d = n(f.decimals, 'decimals'); out.decimals = d === undefined ? 3 : Math.max(0, Math.min(6, Math.trunc(d)));
      out.audience = f.audience === 'PUBLIC' ? 'PUBLIC' : 'INTERNAL';
    }
    if (f.defaultValue !== undefined && f.defaultValue !== null && f.defaultValue !== '' && f.type !== 'computed') out.defaultValue = f.defaultValue;
    return out;
  });
  if (new Set(fields.map((f) => f.key)).size !== fields.length) throw badRequest('Field keys must be unique');
  // Calculated fields may reference numeric fields of this form (and `budget` on the tender form), without cycles.
  const numeric = new Set(fields.filter((f) => ['number', 'money', 'percent', 'computed'].includes(f.type)).map((f) => f.key));
  const deps = new Map<string, string[]>();
  for (const f of fields.filter((x) => x.type === 'computed')) {
    const refs = [...formulaRefs(parseFormula(f.formula!))];
    for (const r of refs) {
      if (r === 'budget' && code === 'TENDER') continue;
      if (!numeric.has(r)) throw badRequest(`Formula of '${f.key}' uses '${r}', which is not a number field of this form${code === 'TENDER' ? " (or 'budget')" : ''}`);
    }
    deps.set(f.key, refs.filter((r) => r !== 'budget'));
  }
  const visiting = new Set<string>(); const done = new Set<string>();
  const visit = (k: string) => {
    if (done.has(k) || !deps.has(k)) return;
    if (visiting.has(k)) throw badRequest(`Calculated fields refer to each other in a loop (at '${k}')`);
    visiting.add(k); deps.get(k)!.forEach(visit); visiting.delete(k); done.add(k);
  };
  [...deps.keys()].forEach(visit);
  // Conditional visibility: conditions over this form's own fields.
  const facts = selfFacts(fields);
  fieldsIn.forEach((f: any, i: number) => {
    if (f?.visibleWhen) {
      const c = validateCondition(f.visibleWhen, facts.filter((x) => x.key !== `self.${f.key}`), `fields[${i}].visibleWhen`);
      fields[i].visibleWhen = c;
    }
  });
  if (code === 'VENDOR') for (const f of fields) if (f.type === 'computed') f.audience = 'INTERNAL';
  return { sections, fields };
}

const selfMap = (vals: Record<string, unknown>) => Object.fromEntries(Object.entries(vals).map(([k, v]) => [`self.${k}`, v]));
export const isVisible = (f: FormField, vals: Record<string, unknown>) => !f.visibleWhen || evaluate(f.visibleWhen, selfMap(vals));
const empty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);

/**
 * Validate custom field values. `editable` limits which fields this caller may set (e.g. a vendor sets PUBLIC fields
 * of the vendor form only); other keys keep their previous value. Returns the full cleaned value set incl. computed.
 */
export function validateValues(def: FormDefinition, input: unknown, opts: {
  previous?: Record<string, unknown>; editable?: (f: FormField) => boolean; mode: 'SAVE' | 'SUBMIT'; budget?: number | null;
}): Record<string, unknown> {
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) throw badRequest('customFields must be an object');
  const inObj = (input ?? {}) as Record<string, unknown>;
  const editable = opts.editable ?? (() => true);
  for (const k of Object.keys(inObj)) {
    const f = def.fields.find((x) => x.key === k);
    if (!f) throw badRequest(`customFields.${k} is not a field of this form`);
    if (!editable(f) && f.type !== 'computed') throw badRequest(`customFields.${k} cannot be set by you`);
  }
  const out: Record<string, unknown> = {};
  for (const f of def.fields) {
    if (f.type === 'computed') continue;
    const has = Object.prototype.hasOwnProperty.call(inObj, f.key) && editable(f);
    let v = has ? inObj[f.key] : opts.previous?.[f.key];
    if (v === undefined && opts.previous === undefined && f.defaultValue !== undefined) v = f.defaultValue;
    out[f.key] = empty(v) ? null : coerce(f, v);
  }
  // computed (in dependency order: a few passes are enough for ≤ 60 fields)
  const computed = def.fields.filter((f) => f.type === 'computed');
  for (let pass = 0; pass < computed.length + 1; pass++) {
    for (const f of computed) {
      const vars: Record<string, number | null> = { budget: opts.budget ?? null };
      for (const [k, v] of Object.entries(out)) vars[k] = typeof v === 'number' ? v : null;
      const r = evalFormula(parseFormula(f.formula!), vars);
      out[f.key] = r === null ? null : Number(r.toFixed(f.decimals ?? 3));
    }
  }
  // required (only visible fields; SUBMIT-time fields are checked at the gate)
  const missing = missingRequired(def, out, opts.mode, editable);
  if (missing.length) throw badRequest(`Required: ${missing.map((f) => f.labelEn).join(', ')}`, 'FIELDS_REQUIRED');
  // hidden fields keep no value
  for (const f of def.fields) if (!isVisible(f, out) && f.type !== 'computed') out[f.key] = null;
  return out;
}

export function missingRequired(def: FormDefinition, vals: Record<string, unknown>, mode: 'SAVE' | 'SUBMIT', editable: (f: FormField) => boolean = () => true): FormField[] {
  return def.fields.filter((f) => f.required && editable(f) && isVisible(f, vals) && empty(vals[f.key]) &&
    (mode === 'SUBMIT' || f.requiredAt !== 'SUBMIT'));
}

function coerce(f: FormField, v: unknown): unknown {
  const bad = (msg: string) => badRequest(`${f.labelEn}: ${msg}`);
  switch (f.type) {
    case 'number': case 'money': case 'percent': {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/,/g, '')) : NaN;
      if (!Number.isFinite(n)) throw bad('must be a number');
      if (f.min !== undefined && n < f.min) throw bad(`must be at least ${f.min}`);
      if (f.max !== undefined && n > f.max) throw bad(`must be at most ${f.max}`);
      return f.decimals !== undefined ? Number(n.toFixed(f.decimals)) : n;
    }
    case 'checkbox': {
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 'false') return v === 'true';
      throw bad('must be yes or no');
    }
    case 'date': {
      const d = typeof v === 'string' ? new Date(v) : null;
      if (!d || Number.isNaN(d.getTime())) throw bad('must be a date');
      return d.toISOString().slice(0, 10);
    }
    case 'select': {
      if (typeof v !== 'string' || !f.options!.some((o) => o.value === v)) throw bad('choose one of the listed options');
      return v;
    }
    case 'multiselect': {
      const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : null;
      if (!arr || arr.some((x) => typeof x !== 'string' || !f.options!.some((o) => o.value === x))) throw bad('choose from the listed options');
      return [...new Set(arr as string[])];
    }
    default: {
      if (typeof v !== 'string' && typeof v !== 'number') throw bad('must be text');
      const s = String(v).trim();
      if (s.length > (f.maxLength ?? 500)) throw bad(`must be at most ${f.maxLength} characters`);
      if (f.type === 'email' && !/^[^\s@]{1,64}@[^\s@]{1,200}\.[^\s@]{2,}$/.test(s)) throw bad('must be an e-mail address');
      if (f.type === 'phone' && !/^\+?[0-9 ()-]{6,20}$/.test(s)) throw bad('must be a phone number');
      if (f.type === 'url') { try { const u = new URL(s); if (!['https:', 'http:'].includes(u.protocol)) throw new Error(); } catch { throw bad('must be a web address (https://…)'); } }
      if (f.format && FORMAT_RE[f.format] && !FORMAT_RE[f.format].test(s.replace(/\s/g, ''))) throw bad(`does not match the ${f.format} format`);
      return s;
    }
  }
}

/** Values a reader may see: vendors only see PUBLIC fields. Returns [{key, label, value, display}] in form order. */
export function presentValues(def: FormDefinition | null, vals: Record<string, unknown> | null | undefined, opts: { publicOnly: boolean }) {
  if (!def) return [];
  const v = vals ?? {};
  return def.fields
    .filter((f) => (!opts.publicOnly || f.audience === 'PUBLIC') && isVisible(f, v))
    .map((f) => ({
      key: f.key, type: f.type, labelEn: f.labelEn, labelAr: f.labelAr, section: f.section ?? null, audience: f.audience, value: v[f.key] ?? null,
      displayEn: display(f, v[f.key], 'en'), displayAr: display(f, v[f.key], 'ar'),
    }));
}

function display(f: FormField, v: unknown, lang: 'en' | 'ar'): string {
  if (v === null || v === undefined || v === '') return '—';
  if (f.type === 'checkbox') return v ? (lang === 'ar' ? 'نعم' : 'Yes') : (lang === 'ar' ? 'لا' : 'No');
  if (f.type === 'select') { const o = f.options?.find((x) => x.value === v); return o ? (lang === 'ar' ? o.labelAr : o.labelEn) : String(v); }
  if (f.type === 'multiselect' && Array.isArray(v)) return v.map((x) => { const o = f.options?.find((y) => y.value === x); return o ? (lang === 'ar' ? o.labelAr : o.labelEn) : x; }).join(', ');
  if (typeof v === 'number') return v.toLocaleString('en-US', { maximumFractionDigits: f.decimals ?? 3 }) + (f.type === 'percent' ? '%' : '');
  return String(v);
}

/** Public subset of a definition (what a vendor filling in the vendor form, or reading a tender, may see). */
export function publicDefinition(def: FormDefinition): FormDefinition {
  const fields = def.fields.filter((f) => f.audience === 'PUBLIC');
  return { sections: def.sections.filter((s) => fields.some((f) => f.section === s.key)), fields };
}
