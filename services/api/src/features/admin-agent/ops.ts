// Dry-run validation of an admin-builder proposal. Each operation is normalised and checked with the EXISTING server
// validators (parseConfig for cycle templates, validateFormDefinition for forms, validateRuleset for rules, the
// document-type parsers) against the entity's current configuration plus the earlier operations of the same proposal.
// Nothing is written here. The result carries, per operation: ok/error, bilingual errors and warnings, a plain-language
// sentence (EN/AR) computed from the validated values, the draft it targets and a field-level diff. The same function
// runs again inside the apply transaction, so what is applied is exactly what was re-validated at that moment.
import type { AdminOperation, AdminOpType, Bilingual } from '../../ai/index.js';
import { ApiError } from '../../util.js';
import { DEFAULT_CONFIG, parseConfig, STARTER_TEMPLATES, type CycleConfig } from '../../services/templates.js';
import { FORM_CODES, validateFormDefinition, type FormCode, type FormDefinition } from '../../lowcode/forms.js';
import { validateRuleset, type Rule, type RulesetDefinition } from '../../lowcode/rules.js';
import { factsFor } from '../../lowcode/conditions.js';
import { customFactSources, factKeysUsed } from '../../lowcode/rules.js';
import { triggerDef, type Scope } from '../../lowcode/catalog.js';
import { parseContexts, parseFields } from '../../services/doc-catalogue.js';
import type { DocTypeField } from '../../ai/index.js';
import { baseForm, baseRuleset, ruleContextOf, type EntityState } from './state.js';
import { configSummary, fieldSentence, FORM_LABELS, flatDiff, roleLabel, ruleSentence, settingLabel } from './describe.js';

export type TargetType = 'TEMPLATE' | 'FORM' | 'RULESET' | 'DOCUMENT_TYPE';
export interface OpTarget { type: TargetType; code: string; action: 'CREATE_DRAFT' | 'UPDATE_DRAFT' | 'CREATE_INACTIVE'; draftVersion: number | null; label: Bilingual }
export interface OpResult {
  index: number; op: AdminOpType; status: 'ok' | 'error';
  summary: Bilingual; errors: Bilingual[]; warnings: Bilingual[];
  target: OpTarget | null;
  diff: { path: string; before: unknown; after: unknown }[];
}
export interface Evaluation {
  valid: boolean;
  results: OpResult[];
  /** Problems that are not tied to one operation (e.g. the whole rule set no longer validates). */
  errors: Bilingual[];
  /** Notes for the administrator (four-eyes, publish order, nothing is live yet). */
  notes: Bilingual[];
  plan: ApplyPlan;
}

/** What apply will write (built from validated values only). */
export interface ApplyPlan {
  templates: { code: string; mode: 'insert' | 'update'; draftId: string | null; nameEn: string; nameAr: string; description: string; config: CycleConfig }[];
  forms: { code: FormCode; mode: 'insert' | 'update'; draftId: string | null; definition: FormDefinition }[];
  ruleset: { mode: 'insert' | 'update'; draftId: string | null; definition: RulesetDefinition } | null;
  docTypes: { code: string; nameEn: string; nameAr: string; contexts: string[]; fields: DocTypeField[] }[];
}

const LOCKED_HINT: Bilingual = {
  en: 'Locked integrity controls cannot be changed: bids stay encrypted until the chair opens them after the deadline, the creator never approves, the recommender never approves the award, and the audit trail is append-only. Rules can only add controls.',
  ar: 'لا يمكن تغيير الضوابط الثابتة: تبقى العطاءات مشفرة حتى يفتحها رئيس اللجنة بعد الموعد، ولا يعتمد المنشئ أبداً، ولا يعتمد صاحب التوصية الترسية، وسجل التدقيق غير قابل للتعديل. يمكن للقواعد إضافة ضوابط فقط.',
};

/** A validator message (English, from the existing services) shown in both languages. */
const fromServer = (msg: string): Bilingual => ({ en: msg, ar: `رفض الخادم هذه العملية: ${msg}` });
const err = (en: string, ar: string) => new OpError({ en, ar });
class OpError extends Error { constructor(public readonly b: Bilingual, public readonly extra: Bilingual[] = []) { super(b.en); } }

const strict = (o: unknown, allowed: string[], what: Bilingual, lockedHint = false) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw err(`${what.en} must be an object`, `يجب أن يكون ${what.ar} كائناً`);
  const bad = Object.keys(o).filter((k) => !allowed.includes(k));
  if (bad.length) throw new OpError({ en: `Unknown key(s) in ${what.en}: ${bad.join(', ')}. Allowed: ${allowed.join(', ')}.`, ar: `مفاتيح غير معروفة في ${what.ar}: ${bad.join(', ')}.` }, lockedHint ? [LOCKED_HINT] : []);
};

// ---------------------------------------------------------------- cycle templates

const TEMPLATE_KEYS: Record<string, string[] | null> = {
  scope: null, envelopes: null,
  stages: Object.keys(DEFAULT_CONFIG.stages), approvals: ['request', 'publish', 'award'],
  evaluation: ['technicalPassMark', 'financialCriteria'], eligibility: ['activityCodes', 'minGrade'],
  fees: ['documentPrice', 'currency', 'exemptionAllowed'], ai: Object.keys(DEFAULT_CONFIG.ai),
};

/** Merge a settings patch into a config (objects merged, arrays and scalars replaced); unknown settings are refused. */
export function mergeTemplateChanges(base: CycleConfig, changes: unknown): unknown {
  if (changes === undefined || changes === null) return structuredClone(base);
  strict(changes, Object.keys(TEMPLATE_KEYS), { en: 'template changes', ar: 'تغييرات النموذج' }, true);
  const out: any = structuredClone(base);
  for (const [k, v] of Object.entries(changes as Record<string, unknown>)) {
    const sub = TEMPLATE_KEYS[k];
    if (!sub) { out[k] = v; continue; }
    strict(v, sub, { en: `template setting "${k}"`, ar: `إعداد النموذج "${k}"` }, true);
    for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'approvals' && Array.isArray(v2)) {
        // Fill missing labels from the role (the Cycle Designer shows the label at every approval step).
        out.approvals[k2] = v2.map((l: any) => (l && typeof l === 'object' && typeof l.role === 'string'
          ? { ...l, labelEn: l.labelEn || roleLabel(l.role).en, labelAr: l.labelAr || roleLabel(l.role).ar } : l));
      } else out[k][k2] = v2;
    }
  }
  // Two envelopes need a financial criterion key; "price" is the only one the tender form uses by default.
  if (out.envelopes === 'TWO' && (!Array.isArray(out.evaluation?.financialCriteria) || !out.evaluation.financialCriteria.length)) out.evaluation.financialCriteria = ['price'];
  return out;
}

// ---------------------------------------------------------------- forms

const FIELD_KEYS = ['key', 'type', 'labelEn', 'labelAr', 'helpEn', 'helpAr', 'section', 'required', 'requiredAt', 'audience', 'min', 'max',
  'maxLength', 'decimals', 'format', 'options', 'formula', 'visibleWhen', 'defaultValue'];
const SECTION_KEYS = ['key', 'titleEn', 'titleAr'];
const RULE_KEYS = ['id', 'nameEn', 'nameAr', 'enabled', 'trigger', 'params', 'when', 'actions'];

const formCodeOf = (v: unknown): FormCode => {
  const c = String(v ?? '').toUpperCase();
  if (!FORM_CODES.includes(c as FormCode)) throw err(`form must be one of ${FORM_CODES.join(', ')}`, `يجب أن يكون النموذج أحد: ${FORM_CODES.join(', ')}`);
  return c as FormCode;
};

/** Rule id from a name when the agent gave none: lower-case letters, digits and '-' (unique in the set). */
function ruleIdFrom(name: string, taken: Set<string>): string {
  let base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36);
  if (!/^[a-z]/.test(base)) base = `rule-${base}`.replace(/-+$/, '');
  if (base.length < 2) base = 'rule';
  let id = base; let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

// ---------------------------------------------------------------- evaluation

const ORDER: Record<AdminOpType, number> = {
  ADD_FORM_SECTION: 0, ADD_FORM_FIELD: 1, UPDATE_FORM_FIELD: 1, CREATE_TEMPLATE: 2, NEW_TEMPLATE_VERSION: 2, ADD_DOCUMENT_TYPE: 3,
  ADD_RULE: 4, UPDATE_RULE: 4, SET_RULE_ENABLED: 4,
};

export function evaluatePlan(state: EntityState, operations: AdminOperation[]): Evaluation {
  // Working copies: everything the proposal changes, on top of the current configuration.
  const tpl = new Map<string, ApplyPlan['templates'][number] & { version: number; label: Bilingual }>();
  const forms = new Map<FormCode, { def: FormDefinition; touched: boolean }>();
  const formOf = (c: FormCode) => { if (!forms.has(c)) forms.set(c, { def: baseForm(state.forms[c]), touched: false }); return forms.get(c)!; };
  let rules: RulesetDefinition | null = null;
  const rulesOf = () => (rules ??= baseRuleset(state.ruleset));
  const docTypes: ApplyPlan['docTypes'] = [];
  const workingForms = () => Object.fromEntries(FORM_CODES.map((c) => [c, forms.get(c)?.def ?? (state.forms[c].draft ?? state.forms[c].live)?.definition]).filter(([, d]) => d)) as Partial<Record<FormCode, FormDefinition>>;
  const rc = () => ruleContextOf(state, workingForms());
  const factsOf = () => { const r = rc(); return (scope: Scope | null) => factsFor(scope, customFactSources(r.forms)); };
  const fieldLabel = (code: FormCode) => (k: string): Bilingual => {
    const f = formOf(code).def.fields.find((x) => x.key === k);
    return f ? { en: `“${f.labelEn}”`, ar: `«${f.labelAr}»` } : { en: k, ar: k };
  };
  const formTarget = (code: FormCode): OpTarget => {
    const s = state.forms[code];
    return { type: 'FORM', code, action: s.draft ? 'UPDATE_DRAFT' : 'CREATE_DRAFT',
      draftVersion: s.draft ? s.draft.version : Math.max(s.live?.version ?? 0, 0) + 1, label: FORM_LABELS[code] };
  };
  const rulesetTarget = (): OpTarget => {
    const s = state.ruleset;
    return { type: 'RULESET', code: 'PROCESS', action: s.draft ? 'UPDATE_DRAFT' : 'CREATE_DRAFT',
      draftVersion: s.draft ? s.draft.version : (s.live?.version ?? 0) + 1, label: { en: 'process rules', ar: 'قواعد الإجراءات' } };
  };

  const handlers: Record<AdminOpType, (o: any, r: OpResult) => void> = {
    CREATE_TEMPLATE(o, r) {
      const code = String(o.code).trim().toUpperCase();
      if (!/^[A-Z0-9_]{2,60}$/.test(code)) throw err('code may contain only A-Z, 0-9 and _ (2-60 characters)', 'يجب أن يتكون الرمز من A-Z و0-9 و_ فقط (2-60 حرفاً)');
      if (state.templates.has(code) || tpl.has(code)) throw err(`A template with code ${code} already exists; use NEW_TEMPLATE_VERSION to change it.`, `يوجد نموذج بالرمز ${code}؛ استخدم إصداراً جديداً لتعديله.`);
      let base = DEFAULT_CONFIG; let baseLabel: Bilingual = { en: 'the TenderFlow default (one envelope, one director approval)', ar: 'الإعداد الافتراضي (مظروف واحد واعتماد واحد من المدير)' };
      if (o.baseCode) {
        const bc = String(o.baseCode).trim().toUpperCase();
        const ex = state.templates.get(bc); const st = STARTER_TEMPLATES.find((s) => s.code === bc); const pend = tpl.get(bc);
        if (ex) { base = (ex.published ?? ex.draft)!.config; baseLabel = { en: `template ${bc}`, ar: `النموذج ${bc}` }; }
        else if (pend) { base = pend.config; baseLabel = { en: `template ${bc} (this proposal)`, ar: `النموذج ${bc} (هذا الاقتراح)` }; }
        else if (st) { base = st.config; baseLabel = { en: `the starter template ${st.nameEn}`, ar: `النموذج الجاهز ${st.nameAr}` }; }
        else throw err(`baseCode ${bc} is neither a template of this entity nor a starter template`, `الرمز ${bc} ليس نموذجاً لدى الجهة ولا نموذجاً جاهزاً`);
      }
      const config = parseConfig(mergeTemplateChanges(base, o.changes));
      const nameEn = String(o.nameEn).trim().slice(0, 200); const nameAr = String(o.nameAr).trim().slice(0, 200);
      if (!nameEn || !nameAr) throw err('nameEn and nameAr are required', 'الاسم بالإنجليزية والعربية مطلوب');
      const description = typeof o.description === 'string' ? o.description.trim().slice(0, 2000) : '';
      tpl.set(code, { code, mode: 'insert', draftId: null, nameEn, nameAr, description, config, version: 1, label: { en: nameEn, ar: nameAr } });
      const cs = configSummary(config);
      r.summary = { en: `Create a new cycle template “${nameEn}” (${code}) as a draft, based on ${baseLabel.en}: ${cs.en}.`,
        ar: `إنشاء نموذج دورة جديد «${nameAr}» (${code}) كمسودة، استناداً إلى ${baseLabel.ar}: ${cs.ar}.` };
      r.target = { type: 'TEMPLATE', code, action: 'CREATE_DRAFT', draftVersion: 1, label: { en: nameEn, ar: nameAr } };
      r.diff = [{ path: 'name', before: null, after: `${nameEn} / ${nameAr}` }, ...flatDiff(base, config)];
    },

    NEW_TEMPLATE_VERSION(o, r) {
      const code = String(o.code).trim().toUpperCase();
      const ex = state.templates.get(code); const pend = tpl.get(code);
      if (!ex && !pend) throw err(`There is no template with code ${code}; use CREATE_TEMPLATE for a new one.`, `لا يوجد نموذج بالرمز ${code}؛ استخدم إنشاء نموذج جديد.`);
      let entry = pend;
      if (!entry) {
        const src = ex!.draft ?? ex!.published!;
        entry = { code, mode: ex!.draft ? 'update' : 'insert', draftId: ex!.draft?.id ?? null, nameEn: src.name_en, nameAr: src.name_ar,
          description: src.description ?? '', config: src.config, version: ex!.draft ? ex!.draft.version : ex!.latestVersion + 1, label: { en: src.name_en, ar: src.name_ar } };
        if (ex!.draft) r.warnings.push({ en: `Draft version ${ex!.draft.version} of ${code} is already open; these changes go into that draft.`,
          ar: `المسودة رقم ${ex!.draft.version} من ${code} مفتوحة بالفعل؛ ستضاف هذه التغييرات إليها.` });
      }
      const before = entry.config;
      const config = parseConfig(mergeTemplateChanges(before, o.changes));
      const nameEn = typeof o.nameEn === 'string' && o.nameEn.trim() ? o.nameEn.trim().slice(0, 200) : entry.nameEn;
      const nameAr = typeof o.nameAr === 'string' && o.nameAr.trim() ? o.nameAr.trim().slice(0, 200) : entry.nameAr;
      const description = typeof o.description === 'string' ? o.description.trim().slice(0, 2000) : entry.description;
      const diff = flatDiff(before, config);
      if (nameEn !== entry.nameEn || nameAr !== entry.nameAr) diff.unshift({ path: 'name', before: `${entry.nameEn} / ${entry.nameAr}`, after: `${nameEn} / ${nameAr}` });
      if (!diff.length && description === entry.description) throw err('This operation changes nothing in the template.', 'هذه العملية لا تغير شيئاً في النموذج.');
      tpl.set(code, { ...entry, nameEn, nameAr, description, config });
      const paths = [...new Set(diff.map((d) => (d.path.startsWith('stages.') || d.path.startsWith('ai.') || d.path.startsWith('approvals.') || d.path.startsWith('evaluation.') || d.path.startsWith('fees.') || d.path.startsWith('eligibility.') ? d.path : d.path.split('.')[0])))];
      const changedEn = paths.map((p) => (p === 'name' ? 'name' : settingLabel(p).en)).join(', ');
      const changedAr = paths.map((p) => (p === 'name' ? 'الاسم' : settingLabel(p).ar)).join('، ');
      const cs = configSummary(config);
      const verb = entry.mode === 'update' ? { en: `Update the open draft version ${entry.version}`, ar: `تحديث المسودة المفتوحة رقم ${entry.version}` }
        : pend ? { en: 'Change the new template', ar: 'تعديل النموذج الجديد' } : { en: `Create draft version ${entry.version}`, ar: `إنشاء المسودة رقم ${entry.version}` };
      r.summary = { en: `${verb.en} of “${nameEn}” (${code}), changing ${changedEn || 'the description'}. Result: ${cs.en}.`,
        ar: `${verb.ar} من «${nameAr}» (${code})، مع تغيير ${changedAr || 'الوصف'}. النتيجة: ${cs.ar}.` };
      r.target = { type: 'TEMPLATE', code, action: entry.mode === 'update' ? 'UPDATE_DRAFT' : 'CREATE_DRAFT', draftVersion: entry.version, label: { en: nameEn, ar: nameAr } };
      r.diff = diff;
    },

    ADD_FORM_SECTION(o, r) {
      const code = formCodeOf(o.form);
      strict(o.section, SECTION_KEYS, { en: 'section', ar: 'القسم' });
      const w = formOf(code);
      if (w.def.sections.some((s) => s.key === o.section.key)) throw err(`The ${code} form already has a section "${o.section.key}".`, `يحتوي النموذج ${code} على قسم "${o.section.key}" بالفعل.`);
      const def = validateFormDefinition({ ...w.def, sections: [...w.def.sections, o.section] }, code);
      const sec = def.sections.at(-1)!;
      w.def = def; w.touched = true;
      r.summary = { en: `Add the section “${sec.titleEn}” (${sec.key}) to the ${FORM_LABELS[code].en}.`, ar: `إضافة القسم «${sec.titleAr}» (${sec.key}) إلى ${FORM_LABELS[code].ar}.` };
      r.target = formTarget(code);
      r.diff = flatDiff({}, sec);
    },

    ADD_FORM_FIELD(o, r) {
      const code = formCodeOf(o.form);
      strict(o.field, FIELD_KEYS, { en: 'field', ar: 'الحقل' });
      const w = formOf(code);
      if (w.def.fields.some((f) => f.key === o.field.key)) throw err(`The ${code} form already has a field "${o.field.key}"; use UPDATE_FORM_FIELD.`, `يحتوي النموذج ${code} على الحقل "${o.field.key}" بالفعل؛ استخدم تعديل الحقل.`);
      const def = validateFormDefinition({ ...w.def, fields: [...w.def.fields, o.field] }, code);
      const f = def.fields.find((x) => x.key === o.field.key)!;
      w.def = def; w.touched = true;
      const sec = f.section ? def.sections.find((s) => s.key === f.section) : null;
      r.summary = fieldSentence(f, code, sec ? { en: sec.titleEn, ar: sec.titleAr } : null, 'add');
      r.target = formTarget(code);
      r.diff = flatDiff({}, f);
    },

    UPDATE_FORM_FIELD(o, r) {
      const code = formCodeOf(o.form);
      strict(o.changes, FIELD_KEYS.filter((k) => k !== 'key'), { en: 'field changes', ar: 'تغييرات الحقل' });
      const w = formOf(code);
      const i = w.def.fields.findIndex((f) => f.key === o.key);
      if (i < 0) throw err(`The ${code} form has no field "${o.key}".`, `لا يحتوي النموذج ${code} على الحقل "${o.key}".`);
      const before = w.def.fields[i];
      const fields = w.def.fields.map((f, j) => (j === i ? { ...f, ...o.changes } : f));
      const def = validateFormDefinition({ ...w.def, fields }, code);
      const f = def.fields[i];
      const diff = flatDiff(before, f);
      if (!diff.length) throw err('This operation changes nothing in the field.', 'هذه العملية لا تغير شيئاً في الحقل.');
      w.def = def; w.touched = true;
      const sec = f.section ? def.sections.find((s) => s.key === f.section) : null;
      r.summary = fieldSentence(f, code, sec ? { en: sec.titleEn, ar: sec.titleAr } : null, 'update');
      r.target = formTarget(code);
      r.diff = diff;
    },

    ADD_DOCUMENT_TYPE(o, r) {
      const code = String(o.code).trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9_]{1,59}$/.test(code)) throw err('code must be UPPER_SNAKE_CASE', 'يجب أن يكون الرمز بأحرف كبيرة وشرطة سفلية');
      if (state.docTypes.some((d) => d.code === code) || docTypes.some((d) => d.code === code)) throw err(`Document type ${code} already exists.`, `نوع المستند ${code} موجود بالفعل.`);
      const contexts = parseContexts(o.contexts);
      const fields = parseFields(o.fields ?? []);
      const nameEn = String(o.nameEn).trim().slice(0, 200); const nameAr = String(o.nameAr).trim().slice(0, 200);
      docTypes.push({ code, nameEn, nameAr, contexts, fields });
      r.summary = { en: `Add the document type “${nameEn}” (${code}) for ${contexts.join(', ')} with ${fields.length} field(s). It is created switched off; an administrator switches it on in Document types.`,
        ar: `إضافة نوع المستند «${nameAr}» (${code}) لـ ${contexts.join('، ')} مع ${fields.length} حقل. يُنشأ غير مفعل، ويفعّله المسؤول من صفحة أنواع المستندات.` };
      r.target = { type: 'DOCUMENT_TYPE', code, action: 'CREATE_INACTIVE', draftVersion: null, label: { en: nameEn, ar: nameAr } };
      r.diff = flatDiff({}, { code, nameEn, nameAr, contexts, fields, active: false });
    },

    ADD_RULE(o, r) {
      strict(o.rule, RULE_KEYS, { en: 'rule', ar: 'القاعدة' }, true);
      const set = rulesOf();
      const taken = new Set(set.rules.map((x) => x.id));
      const raw = { ...o.rule };
      if (!raw.id) raw.id = ruleIdFrom(String(raw.nameEn ?? 'rule'), taken);
      if (taken.has(raw.id)) throw err(`A rule with id "${raw.id}" already exists; use UPDATE_RULE.`, `توجد قاعدة بالمعرف "${raw.id}"؛ استخدم تعديل القاعدة.`);
      if (set.rules.length >= 100) throw err('A rule set may have at most 100 rules.', 'لا يمكن أن تتجاوز القواعد 100 قاعدة.');
      const rule = validateRuleset({ rules: [raw] }, rc(), factsOf() as (s: Scope) => any).rules[0];
      set.rules = [...set.rules, rule];
      describeRule(r, rule, 'add');
      r.diff = flatDiff({}, rule);
    },

    UPDATE_RULE(o, r) {
      strict(o.changes, RULE_KEYS.filter((k) => k !== 'id'), { en: 'rule changes', ar: 'تغييرات القاعدة' }, true);
      const set = rulesOf();
      const i = set.rules.findIndex((x) => x.id === o.ruleId);
      if (i < 0) throw err(`There is no rule "${o.ruleId}".`, `لا توجد قاعدة بالمعرف "${o.ruleId}".`);
      const before = set.rules[i];
      const rule = validateRuleset({ rules: [{ ...before, ...o.changes, id: before.id }] }, rc(), factsOf() as (s: Scope) => any).rules[0];
      const diff = flatDiff(before, rule);
      if (!diff.length) throw err('This operation changes nothing in the rule.', 'هذه العملية لا تغير شيئاً في القاعدة.');
      set.rules = set.rules.map((x, j) => (j === i ? rule : x));
      describeRule(r, rule, 'update');
      r.diff = diff;
    },

    SET_RULE_ENABLED(o, r) {
      const set = rulesOf();
      const i = set.rules.findIndex((x) => x.id === o.ruleId);
      if (i < 0) throw err(`There is no rule "${o.ruleId}".`, `لا توجد قاعدة بالمعرف "${o.ruleId}".`);
      const before = set.rules[i];
      if (before.enabled === o.enabled) r.warnings.push({ en: `The rule is already ${o.enabled ? 'on' : 'off'}.`, ar: `القاعدة ${o.enabled ? 'مفعلة' : 'متوقفة'} بالفعل.` });
      const rule = { ...before, enabled: o.enabled };
      set.rules = set.rules.map((x, j) => (j === i ? rule : x));
      r.summary = o.enabled
        ? { en: `Switch on the rule “${rule.nameEn}” (${rule.id}).`, ar: `تفعيل القاعدة «${rule.nameAr}» (${rule.id}).` }
        : { en: `Switch off the rule “${rule.nameEn}” (${rule.id}); it stays in the rule set and can be switched on again.`, ar: `إيقاف القاعدة «${rule.nameAr}» (${rule.id})؛ تبقى ضمن القواعد ويمكن تفعيلها مجدداً.` };
      r.target = rulesetTarget();
      r.diff = [{ path: 'enabled', before: before.enabled, after: o.enabled }];
    },
  };

  function describeRule(r: OpResult, rule: Rule, verb: 'add' | 'update') {
    const scope = triggerDef(rule.trigger)!.scope;
    const s = ruleSentence(rule, factsOf()(scope), fieldLabel('TENDER'));
    r.summary = verb === 'add'
      ? { en: `Add the rule “${rule.nameEn}”${rule.enabled ? '' : ' (switched off)'}. ${s.en}`, ar: `إضافة القاعدة «${rule.nameAr}»${rule.enabled ? '' : ' (متوقفة)'}. ${s.ar}` }
      : { en: `Change the rule “${rule.nameEn}” (${rule.id}). ${s.en}`, ar: `تعديل القاعدة «${rule.nameAr}» (${rule.id}). ${s.ar}` };
    r.target = rulesetTarget();
    // A rule that tests or requires a custom field that is only in a form DRAFT can be published only after that form.
    const live = ruleContextOf({ ...state, forms: Object.fromEntries(FORM_CODES.map((c) => [c, { live: state.forms[c].live, draft: null }])) as EntityState['forms'] }).forms;
    const used = [...factKeysUsed({ rules: [rule] })];
    for (const a of rule.actions) if (a.type === 'REQUIRE_FIELDS') used.push(...a.fields.map((k) => `tender.custom.${k}`));
    for (const fk of used) {
      const m = /^(tender|vendor|request)\.custom\.(.+)$/.exec(fk);
      if (!m) continue;
      const code = m[1].toUpperCase() as FormCode;
      if (!live[code]?.fields.some((f) => f.key === m[2]))
        r.warnings.push({ en: `It uses the field "${m[2]}", which is not in the published ${FORM_LABELS[code].en} yet: publish the form draft before the rule set.`,
          ar: `تستخدم الحقل "${m[2]}" غير الموجود في ${FORM_LABELS[code].ar} المنشور بعد: انشر مسودة النموذج قبل القواعد.` });
    }
  }

  const results: OpResult[] = operations.map((o, index) => ({ index, op: o.op, status: 'ok', summary: { en: '', ar: '' }, errors: [], warnings: [], target: null, diff: [] }));
  const order = operations.map((o, i) => i).sort((a, b) => ORDER[operations[a].op] - ORDER[operations[b].op] || a - b);
  for (const i of order) {
    const o = operations[i]; const r = results[i];
    // Snapshot the working state so a failed operation leaves no trace for the later ones.
    const cur: RulesetDefinition | null = rules;
    const snapTpl = new Map(tpl);
    const snapForms = new Map<FormCode, { def: FormDefinition; touched: boolean }>([...forms].map(([k, v]) => [k, { ...v }]));
    const snap: { tpl: typeof snapTpl; forms: typeof snapForms; rules: RulesetDefinition | null; docs: number } =
      { tpl: snapTpl, forms: snapForms, rules: cur ? { rules: [...cur.rules] } : null, docs: docTypes.length };
    try {
      handlers[o.op](o, r);
    } catch (e) {
      tpl.clear(); snap.tpl.forEach((v, k) => tpl.set(k, v));
      forms.clear(); snap.forms.forEach((v, k) => forms.set(k, v));
      rules = snap.rules; docTypes.length = snap.docs;
      r.status = 'error';
      r.warnings = [];
      if (e instanceof OpError) r.errors.push(e.b, ...e.extra);
      else if (e instanceof ApiError) {
        // Single-rule validation reports paths as rules[0]…; show them as rule… to the administrator.
        r.errors.push(fromServer(e.message.replace(/\brules\[0\]\.?/g, 'rule.')));
        if (/\.type must be one of|cannot be used with this trigger|needs at least 1 level/i.test(e.message)) r.errors.push(LOCKED_HINT);
      } else throw e;
      r.summary = failedSummary(o);
    }
  }

  // Whole-definition checks after all operations (e.g. a rule set that was already inconsistent).
  const errors: Bilingual[] = [];
  if (rules && results.every((r) => r.status === 'ok')) {
    try { validateRuleset(rules, rc(), factsOf() as (s: Scope) => any); }
    catch (e) { if (e instanceof ApiError) errors.push(fromServer(`Process rules: ${e.message}`)); else throw e; }
  }
  const notes: Bilingual[] = [];
  if (operations.length) notes.push({ en: 'Nothing is live until someone publishes the drafts in Cycle Designer / Process Studio.', ar: 'لن يُطبق أي تغيير حتى تُنشر المسودات من مصمم الدورة / استوديو الإجراءات.' });
  if (state.fourEyes && operations.length) notes.push({ en: 'Four-eyes on configuration is on: the person who applies this proposal (the last editor of the drafts) cannot publish them.', ar: 'مبدأ الأعين الأربع مفعّل: من يطبق هذا الاقتراح (آخر من عدّل المسودات) لا يمكنه نشرها.' });

  const plan: ApplyPlan = {
    templates: [...tpl.values()].map(({ version: _v, label: _l, ...t }) => t),
    forms: FORM_CODES.filter((c) => forms.get(c)?.touched).map((c) => ({ code: c, mode: state.forms[c].draft ? 'update' as const : 'insert' as const, draftId: state.forms[c].draft?.id ?? null, definition: forms.get(c)!.def })),
    ruleset: rules && results.some((r) => r.status === 'ok' && r.target?.type === 'RULESET')
      ? { mode: state.ruleset.draft ? 'update' : 'insert', draftId: state.ruleset.draft?.id ?? null, definition: rules } : null,
    docTypes,
  };
  return { valid: operations.length > 0 && results.every((r) => r.status === 'ok') && !errors.length, results, errors, notes, plan };
}

function failedSummary(o: AdminOperation): Bilingual {
  const what: Record<AdminOpType, Bilingual> = {
    CREATE_TEMPLATE: { en: `Create the cycle template ${String(o.code ?? '')}`, ar: `إنشاء نموذج الدورة ${String(o.code ?? '')}` },
    NEW_TEMPLATE_VERSION: { en: `New draft version of ${String(o.code ?? '')}`, ar: `إصدار جديد من ${String(o.code ?? '')}` },
    ADD_RULE: { en: `Add the rule “${String((o.rule as any)?.nameEn ?? (o.rule as any)?.id ?? '')}”`, ar: `إضافة القاعدة «${String((o.rule as any)?.nameAr ?? (o.rule as any)?.id ?? '')}»` },
    UPDATE_RULE: { en: `Change the rule ${String(o.ruleId ?? '')}`, ar: `تعديل القاعدة ${String(o.ruleId ?? '')}` },
    SET_RULE_ENABLED: { en: `Switch the rule ${String(o.ruleId ?? '')} ${o.enabled ? 'on' : 'off'}`, ar: `${o.enabled ? 'تفعيل' : 'إيقاف'} القاعدة ${String(o.ruleId ?? '')}` },
    ADD_FORM_FIELD: { en: `Add the field ${String((o.field as any)?.key ?? '')} to the ${String(o.form ?? '')} form`, ar: `إضافة الحقل ${String((o.field as any)?.key ?? '')} إلى النموذج ${String(o.form ?? '')}` },
    UPDATE_FORM_FIELD: { en: `Change the field ${String(o.key ?? '')} of the ${String(o.form ?? '')} form`, ar: `تعديل الحقل ${String(o.key ?? '')} في النموذج ${String(o.form ?? '')}` },
    ADD_FORM_SECTION: { en: `Add a section to the ${String(o.form ?? '')} form`, ar: `إضافة قسم إلى النموذج ${String(o.form ?? '')}` },
    ADD_DOCUMENT_TYPE: { en: `Add the document type ${String(o.code ?? '')}`, ar: `إضافة نوع المستند ${String(o.code ?? '')}` },
  };
  const w = what[o.op];
  return { en: `${w.en} — cannot be applied as proposed.`, ar: `${w.ar} — لا يمكن تطبيقها كما اقتُرحت.` };
}
