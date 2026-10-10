// Apply a validated admin-builder plan inside ONE transaction (the caller's `q`; never ctx.db — PGlite has a single
// connection). Every write goes through the existing services' transaction-scoped writers, which re-validate with the
// same validators and write their own audit events (TEMPLATE_CREATED/UPDATED, LOWCODE_DRAFT_CREATED/UPDATED,
// DOCUMENT_TYPE_CREATED). Only DRAFT versions are created or edited; document types are created switched off.
// Nothing is published here.
import type { Ctx } from '../../ctx.js';
import type { Actor } from '../../auth/tokens.js';
import type { Queryable } from '../../db.js';
import type { Bilingual } from '../../ai/index.js';
import { insertTemplateDraft, parseConfig, updateTemplateDraft } from '../../services/templates.js';
import { insertDraft, RULESET_CODE, saveDraft, validateBody } from '../../lowcode/definitions.js';
import { insertDocumentType } from '../../services/doc-catalogue.js';
import { ruleContextOf, type EntityState } from './state.js';
import { FORM_LABELS } from './describe.js';
import type { ApplyPlan } from './ops.js';

export interface AppliedRef {
  type: 'TEMPLATE' | 'FORM' | 'RULESET' | 'DOCUMENT_TYPE';
  id: string; code: string; version: number | null; status: 'DRAFT' | 'INACTIVE'; action: 'CREATED' | 'UPDATED';
  label: Bilingual; link: string;
}

export async function applyPlan(ctx: Ctx, q: Queryable, actor: Actor, state: EntityState, plan: ApplyPlan, proposalId: string): Promise<AppliedRef[]> {
  const via = { via: 'ADMIN_AGENT', proposalId };
  const refs: AppliedRef[] = [];
  const rc0 = ruleContextOf(state);

  for (const f of plan.forms) {
    const def = validateBody('FORM', f.code, f.definition, rc0);
    const draft = state.forms[f.code].draft;
    const row = f.mode === 'update' && draft ? await saveDraft(ctx, q, actor, draft, def, {}, via)
      : await insertDraft(ctx, q, actor, { kind: 'FORM', code: f.code, definition: def, fromId: state.forms[f.code].live?.id ?? null }, via);
    refs.push({ type: 'FORM', id: row.id, code: f.code, version: row.version, status: 'DRAFT', action: f.mode === 'update' ? 'UPDATED' : 'CREATED',
      label: FORM_LABELS[f.code], link: '/admin/studio?tab=forms' });
  }

  for (const t of plan.templates) {
    const config = parseConfig(t.config);
    const row = t.mode === 'update' && t.draftId
      ? await updateTemplateDraft(ctx, q, actor, t.draftId, { nameEn: t.nameEn, nameAr: t.nameAr, description: t.description, config }, via)
      : await insertTemplateDraft(ctx, q, actor, { code: t.code, nameEn: t.nameEn, nameAr: t.nameAr, description: t.description, config }, via);
    refs.push({ type: 'TEMPLATE', id: row.id, code: row.code, version: row.version, status: 'DRAFT', action: t.mode === 'update' ? 'UPDATED' : 'CREATED',
      label: { en: row.name_en, ar: row.name_ar }, link: `/admin/cycle?template=${row.id}` });
  }

  if (plan.ruleset) {
    // Rules may test fields this proposal adds to a form draft: validate against the working forms.
    const rc = ruleContextOf(state, Object.fromEntries(plan.forms.map((f) => [f.code, f.definition])));
    const def = validateBody('RULESET', RULESET_CODE, plan.ruleset.definition, rc);
    const draft = state.ruleset.draft;
    const row = plan.ruleset.mode === 'update' && draft ? await saveDraft(ctx, q, actor, draft, def, {}, via)
      : await insertDraft(ctx, q, actor, { kind: 'RULESET', code: RULESET_CODE, definition: def, fromId: state.ruleset.live?.id ?? null }, via);
    refs.push({ type: 'RULESET', id: row.id, code: RULESET_CODE, version: row.version, status: 'DRAFT', action: plan.ruleset.mode === 'update' ? 'UPDATED' : 'CREATED',
      label: { en: 'Process rules', ar: 'قواعد الإجراءات' }, link: '/admin/studio?tab=rules' });
  }

  for (const d of plan.docTypes) {
    const row = await insertDocumentType(ctx, q, actor, { ...d, active: false }, via);
    refs.push({ type: 'DOCUMENT_TYPE', id: row.id, code: row.code, version: null, status: 'INACTIVE', action: 'CREATED',
      label: { en: row.name_en, ar: row.name_ar }, link: '/admin/document-types' });
  }
  return refs;
}
