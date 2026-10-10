// The entity's current configuration, as the admin builder sees it: cycle templates, custom forms, the process rule set,
// integration codes and document types — for THIS entity only (every query filters by tenant_id). It is the base the
// proposal is validated against and, rendered as text, the context sent to the agent. No secrets (webhook URLs and
// signing secrets are never read), no tender, bid or vendor data.
import type { Queryable } from '../../db.js';
import { FORM_CODES, type FormCode, type FormDefinition } from '../../lowcode/forms.js';
import { RULESET_CODE, type DefinitionRow } from '../../lowcode/definitions.js';
import { factsFor } from '../../lowcode/conditions.js';
import { customFactSources, type RuleContext, type RulesetDefinition } from '../../lowcode/rules.js';
import { describe } from '../../lowcode/conditions.js';
import { STARTER_TEMPLATES, type TemplateRow } from '../../services/templates.js';
import { configSummary } from './describe.js';

export interface TemplateState { code: string; published: TemplateRow | null; draft: TemplateRow | null; latestVersion: number; isDefault: boolean }
export interface DefState { live: DefinitionRow | null; draft: DefinitionRow | null }
export interface EntityState {
  tenantId: string;
  templates: Map<string, TemplateState>;
  forms: Record<FormCode, DefState>;
  ruleset: DefState;
  webhookCodes: string[];
  docTypes: { code: string; nameEn: string; nameAr: string; active: boolean; contexts: string[] }[];
  fourEyes: boolean;
}

export const EMPTY_FORM: FormDefinition = { sections: [], fields: [] };
export const EMPTY_RULESET: RulesetDefinition = { rules: [] };

/** Working base of a definition: the open draft if any (changes go into it), else the live version, else empty. */
export const baseForm = (s: DefState): FormDefinition => structuredClone((s.draft ?? s.live)?.definition ?? EMPTY_FORM);
export const baseRuleset = (s: DefState): RulesetDefinition => structuredClone((s.draft ?? s.live)?.definition ?? EMPTY_RULESET);

export async function loadState(q: Queryable, tenantId: string): Promise<EntityState> {
  const tpls = await q.query<TemplateRow>('SELECT * FROM cycle_templates WHERE tenant_id=$1 ORDER BY code, version DESC', [tenantId]);
  const templates = new Map<string, TemplateState>();
  for (const t of tpls) {
    const s = templates.get(t.code) ?? { code: t.code, published: null, draft: null, latestVersion: t.version, isDefault: false };
    if (t.status === 'PUBLISHED' && !s.published) s.published = t;
    if (t.status === 'DRAFT' && !s.draft) s.draft = t;
    if (t.is_default) s.isDefault = true;
    s.latestVersion = Math.max(s.latestVersion, t.version);
    templates.set(t.code, s);
  }
  const defs = await q.query<DefinitionRow>(
    `SELECT * FROM lowcode_definitions WHERE tenant_id=$1 AND status IN ('PUBLISHED','DRAFT') ORDER BY kind, code, version DESC`, [tenantId]);
  const pick = (kind: string, code: string): DefState => ({
    live: defs.find((d) => d.kind === kind && d.code === code && d.status === 'PUBLISHED') ?? null,
    draft: defs.find((d) => d.kind === kind && d.code === code && d.status === 'DRAFT') ?? null,
  });
  const forms = Object.fromEntries(FORM_CODES.map((c) => [c, pick('FORM', c)])) as Record<FormCode, DefState>;
  const hooks = await q.query<{ code: string }>('SELECT code FROM webhook_endpoints WHERE tenant_id=$1 ORDER BY code', [tenantId]);
  const docTypes = await q.query<{ code: string; name_en: string; name_ar: string; active: boolean; contexts: string[] }>(
    'SELECT code, name_en, name_ar, active, contexts FROM document_types WHERE tenant_id=$1 ORDER BY code', [tenantId]);
  const prof = (await q.query<{ profile: any }>('SELECT profile FROM tenants WHERE id=$1', [tenantId]))[0];
  return {
    tenantId, templates, forms, ruleset: pick('RULESET', RULESET_CODE), webhookCodes: hooks.map((h) => h.code),
    docTypes: docTypes.map((d) => ({ code: d.code, nameEn: d.name_en, nameAr: d.name_ar, active: d.active, contexts: d.contexts })),
    fourEyes: prof?.profile?.configFourEyes === true,
  };
}

/** Rule context for validating rules: the entity's working forms (draft or live), with optional overrides from a proposal. */
export function ruleContextOf(state: EntityState, forms?: Partial<Record<FormCode, FormDefinition>>): RuleContext {
  const out: RuleContext['forms'] = {};
  for (const c of FORM_CODES) {
    const f = forms?.[c] ?? ((state.forms[c].draft ?? state.forms[c].live)?.definition as FormDefinition | undefined);
    if (f) out[c] = f;
  }
  return { forms: out, webhookCodes: state.webhookCodes };
}

const FORM_FACT_PREFIX: Record<FormCode, string> = { TENDER: 'tender.custom.', VENDOR: 'vendor.custom.', REQUEST: 'request.custom.' };

/** Catalogue lines for the entity's custom-field facts (what a rule condition may test). */
export function customFactLines(rc: RuleContext): string[] {
  return customFactSources(rc.forms).flatMap((src) => src.fields.map((f) =>
    `- ${src.prefix}${f.key} (${f.type}${f.options ? `: ${f.options.map((o) => o.value).join('|')}` : ''}) [${src.scopes.join(',')}] — ${f.labelEn} — ${f.labelAr}`));
}

/** The configuration as plain-text sections for the agent prompt (names, codes, keys, settings; nothing else). */
export function stateSections(state: EntityState): { section: string; text: string }[] {
  const tl = [...state.templates.values()].map((t) => {
    const cur = t.draft ?? t.published!;
    const st = [t.published ? `published v${t.published.version}${t.isDefault ? ' (default)' : ''}` : null, t.draft ? `open DRAFT v${t.draft.version}` : null].filter(Boolean).join(', ');
    return `- ${t.code} — ${cur.name_en} — ${cur.name_ar} — ${st} — ${configSummary(cur.config).en}`;
  });
  const starters = STARTER_TEMPLATES.map((s) => `- ${s.code} — ${s.nameEn} — ${configSummary(s.config).en}`);
  const rc = ruleContextOf(state);
  const formText = FORM_CODES.map((c) => {
    const s = state.forms[c];
    const def = (s.draft ?? s.live)?.definition as FormDefinition | undefined;
    const ver = [s.live ? `live v${s.live.version}` : 'nothing published', s.draft ? `open DRAFT v${s.draft.version} (changes go into it)` : null].filter(Boolean).join(', ');
    if (!def) return `${c} form: ${ver}; no fields.`;
    return [`${c} form: ${ver}.`,
      `  sections: ${def.sections.length ? def.sections.map((x) => `${x.key} (${x.titleEn} / ${x.titleAr})`).join('; ') : 'none'}`,
      ...def.fields.map((f) => `  - ${f.key} (${f.type}${f.required ? `, required at ${f.requiredAt}` : ''}, ${f.audience}${f.section ? `, section ${f.section}` : ''}) — ${f.labelEn} — ${f.labelAr}`),
    ].join('\n');
  }).join('\n');
  const rs = state.ruleset;
  const rules = baseRuleset(rs).rules;
  const facts = factsFor(null, customFactSources(rc.forms));
  const ruleText = [
    `Rule set PROCESS: ${rs.live ? `live v${rs.live.version}` : 'nothing published'}${rs.draft ? `, open DRAFT v${rs.draft.version} (changes go into it)` : ''}.`,
    ...rules.map((r) => `- ${r.id} — ${r.enabled ? 'on' : 'OFF'} — ${r.trigger}${r.params?.hoursBefore ? ` (${r.params.hoursBefore} h before)` : ''} — ${r.nameEn} — if ${describe(r.when, facts, 'en')} — actions: ${r.actions.map((a) => a.type + ('role' in a && a.role ? ` ${a.role}` : '')).join(', ')}`),
  ].join('\n');
  return [
    { section: 'Cycle templates of this entity (code — English name — Arabic name — versions — settings)', text: tl.join('\n') || 'none' },
    { section: 'Starter templates that may be used as "baseCode" for a new template', text: starters.join('\n') },
    { section: 'Custom forms (field key (type, required, audience, section) — English label — Arabic label)', text: formText },
    { section: 'Process rules (id — on/off — trigger — name — condition — actions)', text: ruleText },
    { section: 'Integrations (webhook codes usable by a WEBHOOK action)', text: state.webhookCodes.join(', ') || 'none' },
    { section: 'Document types (code — names — active)', text: state.docTypes.map((d) => `- ${d.code} — ${d.nameEn} — ${d.nameAr} — ${d.active ? 'active' : 'inactive'}`).join('\n') || 'none' },
    { section: 'Governance', text: `Four-eyes on configuration: ${state.fourEyes ? 'ON (the last editor of a draft cannot publish it)' : 'off'}. Publishing is always a human step.` },
  ];
}

export { FORM_FACT_PREFIX };
