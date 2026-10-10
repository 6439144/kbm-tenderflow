// Process Studio services: the catalogue for the visual editors, the simulator ("what would happen if…"), the process
// map (stages + rules attached to each stage), and configuration packages (export an entity's process; import it into
// another entity as DRAFTs that an administrator reviews and publishes).
import crypto from 'node:crypto';
import type { Ctx } from '../ctx.js';
import { auditTx } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import { ApiError, badRequest, canonicalJson, isUuid, notFound, now, uuid } from '../util.js';
import {
  ACTIONS, APPROVER_ROLES, BLOCKABLE_GATES, FACTS, LOCKED_CONTROLS, OPS, OP_LABELS, STAFF_TARGET_ROLES, TRIGGERS, triggerDef, type Scope,
} from './catalog.js';
import { describe, evaluate, type Facts } from './conditions.js';
import { definitionById, factsWith, liveRuleset, ruleContext, RULESET_CODE, type DefinitionRow } from './definitions.js';
import { FIELD_TYPES, FORMATS, FORM_CODES, validateFormDefinition, type FormDefinition } from './forms.js';
import { evaluateGate, validateRuleset, type Action, type Rule, type RulesetDefinition } from './rules.js';
import { awardFacts, tenderFacts } from './gates.js';
import { DEFAULT_CONFIG, configOf, parseConfig, stageList, type CycleConfig, type TemplateRow } from '../services/templates.js';
import { checkUrl, webhookPolicy } from './webhooks.js';

export async function catalog(ctx: Ctx, actor: Actor) {
  const rc = await ruleContext(ctx.db, actor.tenantId);
  const fx = factsWith(rc);
  const scopes: Scope[] = ['TENDER', 'AWARD', 'VENDOR', 'REQUEST', 'DOCUMENT'];
  return {
    facts: Object.fromEntries(scopes.map((s) => [s, fx(s)])), ops: OPS, opLabels: OP_LABELS, triggers: TRIGGERS, actions: ACTIONS,
    approverRoles: APPROVER_ROLES, staffRoles: STAFF_TARGET_ROLES, blockableGates: BLOCKABLE_GATES, webhooks: rc.webhookCodes,
    fieldTypes: FIELD_TYPES, formats: FORMATS, formCodes: FORM_CODES, lockedControls: LOCKED_CONTROLS,
    placeholders: {
      TENDER: ['tender.number', 'tender.title', 'tender.titleAr', 'tender.status', 'tender.category', 'tender.deadline'],
      AWARD: ['tender.number', 'tender.title', 'tender.titleAr'], VENDOR: ['vendor.name', 'vendor.nameAr', 'vendor.cr', 'vendor.status'],
      REQUEST: ['request.number', 'request.subject', 'request.department'], DOCUMENT: ['document.title', 'vendor.name'],
    },
    liveForms: Object.keys(rc.forms),
  };
}

function actionSummary(a: Action, lang: 'en' | 'ar'): string {
  const ar = lang === 'ar';
  switch (a.type) {
    case 'ADD_APPROVER': return ar ? `إضافة مستوى اعتماد: ${a.labelAr} (${a.role})` : `Add approval level: ${a.labelEn} (${a.role})`;
    case 'BLOCK': return ar ? `إيقاف: ${a.messageAr}` : `Stop: ${a.messageEn}`;
    case 'REQUIRE_FIELDS': return ar ? `اشتراط الحقول: ${a.fields.join('، ')}` : `Require fields: ${a.fields.join(', ')}`;
    case 'REQUIRE_DOCUMENTS': return ar ? `اشتراط ${a.minCount} مستند${a.titleContains ? ` بعنوان «${a.titleContains}»` : ''}` : `Require ${a.minCount} pack document(s)${a.titleContains ? ` titled “${a.titleContains}”` : ''}`;
    case 'NOTIFY': return ar ? `إشعار ${a.to === 'ROLE' ? a.role : a.to === 'CREATOR' ? 'المنشئ' : 'المورد'}: ${a.titleAr}` : `Notify ${a.to === 'ROLE' ? a.role : a.to === 'CREATOR' ? 'the creator' : 'the vendor'}: ${a.titleEn}`;
    case 'CREATE_TASK': return ar ? `مهمة لـ ${a.role}: ${a.titleAr}${a.blocksGate ? ` (تمنع ${a.blocksGate})` : ''}` : `Task for ${a.role}: ${a.titleEn}${a.blocksGate ? ` (blocks ${a.blocksGate})` : ''}`;
    case 'WEBHOOK': return ar ? `استدعاء التكامل ${a.endpoint}` : `Call integration ${a.endpoint}`;
    case 'SET_FIELD': return ar ? `تعيين ${a.field} = ${JSON.stringify(a.value)}` : `Set ${a.field} = ${JSON.stringify(a.value)}`;
  }
}

/** Default (or given) cycle template config, for previews. */
async function baseConfig(ctx: Ctx, tenantId: string, templateCode?: unknown): Promise<CycleConfig> {
  const r = await ctx.db.query<TemplateRow>(
    `SELECT * FROM cycle_templates WHERE tenant_id=$1 AND status='PUBLISHED' AND ($2::text IS NULL OR code=$2) ORDER BY is_default DESC, version DESC LIMIT 1`,
    [tenantId, typeof templateCode === 'string' && templateCode ? templateCode : null]);
  return r[0]?.config ?? DEFAULT_CONFIG;
}

/** Simulator: evaluate a (draft or published) rule set for one trigger against sample facts or a real tender. */
export async function simulate(ctx: Ctx, actor: Actor, b: any) {
  const trig = triggerDef(b?.trigger);
  if (!trig) throw badRequest('trigger is required');
  let rsRow: DefinitionRow | null;
  if (b?.definitionId) { rsRow = await definitionById(ctx.db, actor.tenantId, String(b.definitionId)); if (rsRow.kind !== 'RULESET') throw badRequest('definitionId is not a rule set'); }
  else rsRow = await liveRuleset(ctx.db, actor.tenantId);
  const rc = await ruleContext(ctx.db, actor.tenantId);
  const factDefs = factsWith(rc)(trig.scope);
  let facts: Facts = {};
  let cfg: CycleConfig;
  let source: any = { type: 'SAMPLE' };
  if (b?.tenderId) {
    if (!isUuid(b.tenderId)) throw notFound('Tender');
    const t = (await ctx.db.query<any>('SELECT * FROM tenders WHERE id=$1 AND tenant_id=$2', [b.tenderId, actor.tenantId]))[0];
    if (!t) throw notFound('Tender');
    const aw = (await ctx.db.query<any>('SELECT bid_id FROM awards WHERE tender_id=$1', [t.id]))[0];
    facts = trig.scope === 'AWARD' && aw ? await awardFacts(ctx.db, t, aw.bid_id, actor) : await tenderFacts(ctx.db, t, actor);
    cfg = configOf({ template_snapshot: t.template_snapshot }); // chain without previously routed levels
    source = { type: 'TENDER', id: t.id, reference: t.tender_number };
  } else {
    const input = b?.facts && typeof b.facts === 'object' ? b.facts : {};
    for (const f of factDefs) {
      if (!(f.key in input)) continue;
      const v = input[f.key];
      facts[f.key] = f.type === 'number' ? (v === '' || v === null ? null : Number(v)) : f.type === 'boolean' ? v === true || v === 'true'
        : f.type === 'list' ? (Array.isArray(v) ? v : String(v ?? '').split(',').map((x: string) => x.trim()).filter(Boolean)) : v;
    }
    cfg = await baseConfig(ctx, actor.tenantId, facts['tender.templateCode']);
  }
  const rules: Rule[] = (rsRow?.definition as RulesetDefinition | undefined)?.rules.filter((r) => r.trigger === trig.key) ?? [];
  const results = rules.map((r) => ({
    ruleId: r.id, nameEn: r.nameEn, nameAr: r.nameAr, enabled: r.enabled, matched: r.enabled && evaluate(r.when, facts),
    whenEn: describe(r.when, factDefs, 'en'), whenAr: describe(r.when, factDefs, 'ar'),
    actions: r.actions.map((a) => ({ type: a.type, summaryEn: actionSummary(a, 'en'), summaryAr: actionSummary(a, 'ar') })),
  }));
  const out: any = { trigger: trig.key, kind: trig.kind, ruleset: rsRow ? { id: rsRow.id, version: rsRow.version, status: rsRow.status } : null, source, facts, results };
  if (trig.kind === 'GATE') {
    const g = evaluateGate(rsRow?.definition, trig.key, facts, factDefs);
    const base = trig.key === 'AWARD_RECOMMEND' ? cfg.approvals.award : cfg.approvals.publish;
    out.gate = {
      chain: [...base.map((l) => ({ ...l, added: false })), ...g.addLevels.map((l) => ({ ...l, added: true }))],
      blocks: g.blocks, requiredFields: g.requiredFields, requiredDocuments: g.requiredDocuments,
      passes: !g.blocks.length,
    };
  }
  return out;
}

/** Process map: the entity's stages (from the default template) with the rules attached to each stage. */
export async function processMap(ctx: Ctx, actor: Actor, query: Record<string, unknown>) {
  let rs: DefinitionRow | null = null;
  if (typeof query.definitionId === 'string' && query.definitionId) rs = await definitionById(ctx.db, actor.tenantId, query.definitionId);
  else rs = await liveRuleset(ctx.db, actor.tenantId);
  const cfg = await baseConfig(ctx, actor.tenantId, query.templateCode);
  const rc = await ruleContext(ctx.db, actor.tenantId);
  const fx = factsWith(rc);
  const rules: Rule[] = rs?.definition?.rules ?? [];
  const attach = (stage: string) => rules.filter((r) => triggerDef(r.trigger)?.stage === stage).map((r) => {
    const t = triggerDef(r.trigger)!;
    return { id: r.id, nameEn: r.nameEn, nameAr: r.nameAr, enabled: r.enabled, trigger: r.trigger, kind: t.kind,
      whenEn: describe(r.when, fx(t.scope), 'en'), whenAr: describe(r.when, fx(t.scope), 'ar'),
      actions: r.actions.map((a) => ({ type: a.type, summaryEn: actionSummary(a, 'en'), summaryAr: actionSummary(a, 'ar') })) };
  });
  const locked = new Map(LOCKED_CONTROLS.map((l) => [l.key, l]));
  const stages = [
    { key: 'VENDORS', kind: 'OPTIONAL', enabled: true },
    ...stageList(cfg),
  ].map((s) => ({ ...s, locked: locked.get(s.key) ?? null, rules: attach(s.key) }));
  return { ruleset: rs ? { id: rs.id, version: rs.version, status: rs.status } : null, stages, lockedControls: LOCKED_CONTROLS, unplaced: [] };
}

// ---------------------------------------------------------------- packages
const FORMAT = 'tenderflow.process-package/v1';
const sha = (o: unknown) => crypto.createHash('sha256').update(canonicalJson(o)).digest('hex');

export async function exportPackage(ctx: Ctx, actor: Actor) {
  const tpl = await ctx.db.query<TemplateRow>(
    `SELECT DISTINCT ON (code) * FROM cycle_templates WHERE tenant_id=$1 AND status='PUBLISHED' ORDER BY code, version DESC`, [actor.tenantId]);
  const defs = await ctx.db.query<DefinitionRow>(
    `SELECT DISTINCT ON (kind, code) * FROM lowcode_definitions WHERE tenant_id=$1 AND status='PUBLISHED' ORDER BY kind, code, version DESC`, [actor.tenantId]);
  const hooks = await ctx.db.query<any>('SELECT code, name, url, events FROM webhook_endpoints WHERE tenant_id=$1 ORDER BY code', [actor.tenantId]);
  const t = (await ctx.db.query<any>('SELECT id, name_en, name_ar FROM tenants WHERE id=$1', [actor.tenantId]))[0];
  const content = {
    cycleTemplates: tpl.map((x) => ({ code: x.code, version: x.version, nameEn: x.name_en, nameAr: x.name_ar, description: x.description, config: x.config, isDefault: x.is_default })),
    forms: defs.filter((d) => d.kind === 'FORM').map((d) => ({ code: d.code, version: d.version, nameEn: d.name_en, nameAr: d.name_ar, definition: d.definition })),
    ruleset: defs.filter((d) => d.kind === 'RULESET').map((d) => ({ version: d.version, nameEn: d.name_en, nameAr: d.name_ar, definition: d.definition }))[0] ?? null,
    integrations: hooks.map((h) => ({ code: h.code, name: h.name, url: h.url, events: h.events })),
  };
  const pkg = { format: FORMAT, exportedAt: now().toISOString(), source: { entity: t.id, nameEn: t.name_en, nameAr: t.name_ar }, content, checksum: sha(content) };
  await ctx.db.tx((q) => auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'LOWCODE_PACKAGE_EXPORTED', resourceType: 'TENANT', resourceId: actor.tenantId,
    details: { checksum: pkg.checksum, templates: content.cycleTemplates.length, forms: content.forms.length, rules: content.ruleset?.definition.rules.length ?? 0, integrations: content.integrations.length } }));
  return pkg;
}

interface Plan { items: { kind: string; code: string; action: string; note?: string }[]; errors: string[]; warnings: string[]; checksumOk: boolean;
  parsed: { templates: any[]; forms: { code: string; nameEn: string; nameAr: string; def: FormDefinition }[]; ruleset: { nameEn: string; nameAr: string; def: RulesetDefinition } | null; integrations: any[] } }

async function plan(ctx: Ctx, actor: Actor, pkg: any): Promise<Plan> {
  const p: Plan = { items: [], errors: [], warnings: [], checksumOk: false, parsed: { templates: [], forms: [], ruleset: null, integrations: [] } };
  if (!pkg || typeof pkg !== 'object' || pkg.format !== FORMAT || !pkg.content) { p.errors.push(`Not a TenderFlow process package (expected format ${FORMAT})`); return p; }
  if (JSON.stringify(pkg).length > 1_000_000) { p.errors.push('Package is larger than 1 MB'); return p; }
  p.checksumOk = sha(pkg.content) === pkg.checksum;
  if (!p.checksumOk) p.warnings.push('Checksum does not match: the package was edited after export. Review every item before publishing.');
  const c = pkg.content;
  const tryIt = (label: string, fn: () => void) => { try { fn(); } catch (e) { p.errors.push(`${label}: ${(e as Error).message}`); } };
  const openDrafts = await ctx.db.query<{ kind: string; code: string }>(`SELECT kind, code FROM lowcode_definitions WHERE tenant_id=$1 AND status='DRAFT'`, [actor.tenantId]);
  for (const t of Array.isArray(c.cycleTemplates) ? c.cycleTemplates : []) tryIt(`Template ${t?.code}`, () => {
    const code = String(t?.code ?? '').toUpperCase();
    if (!/^[A-Z0-9_]{2,60}$/.test(code)) throw badRequest('invalid code');
    const config = parseConfig(t.config);
    p.parsed.templates.push({ code, nameEn: String(t.nameEn ?? code).slice(0, 200), nameAr: String(t.nameAr ?? code).slice(0, 200), description: String(t.description ?? '').slice(0, 2000), config });
    p.items.push({ kind: 'CYCLE_TEMPLATE', code, action: 'NEW_DRAFT_VERSION' });
  });
  for (const f of Array.isArray(c.forms) ? c.forms : []) tryIt(`Form ${f?.code}`, () => {
    const code = String(f?.code ?? '').toUpperCase();
    if (!FORM_CODES.includes(code as any)) throw badRequest('invalid form code');
    if (openDrafts.some((d) => d.kind === 'FORM' && d.code === code)) throw badRequest('a draft of this form is already open here — publish or discard it first');
    p.parsed.forms.push({ code, nameEn: String(f.nameEn ?? code).slice(0, 200), nameAr: String(f.nameAr ?? code).slice(0, 200), def: validateFormDefinition(f.definition, code as any) });
    p.items.push({ kind: 'FORM', code, action: 'NEW_DRAFT_VERSION' });
  });
  const pol = webhookPolicy();
  for (const h of Array.isArray(c.integrations) ? c.integrations : []) tryIt(`Integration ${h?.code}`, () => {
    const code = String(h?.code ?? '').toLowerCase();
    if (!/^[a-z][a-z0-9_-]{1,40}$/.test(code)) throw badRequest('invalid code');
    checkUrl(h.url, pol);
    p.parsed.integrations.push({ code, name: String(h.name ?? code).slice(0, 120), url: String(h.url), events: Array.isArray(h.events) ? h.events.filter((e: string) => TRIGGERS.some((t) => t.key === e && t.kind !== 'GATE')) : [] });
  });
  const existingHooks = (await ctx.db.query<{ code: string }>('SELECT code FROM webhook_endpoints WHERE tenant_id=$1', [actor.tenantId])).map((x) => x.code);
  for (const h of p.parsed.integrations) p.items.push({ kind: 'INTEGRATION', code: h.code, action: existingHooks.includes(h.code) ? 'KEEP_EXISTING' : 'CREATE_SWITCHED_OFF',
    note: existingHooks.includes(h.code) ? 'already configured here; left unchanged' : 'created switched off with a new secret' });
  const targetCtx = await ruleContext(ctx.db, actor.tenantId, Object.fromEntries(p.parsed.forms.map((f) => [f.code, f.def])));
  if (c.ruleset) tryIt('Rule set', () => {
    if (openDrafts.some((d) => d.kind === 'RULESET')) throw badRequest('a draft of the rule set is already open here — publish or discard it first');
    const rc = { forms: targetCtx.forms, webhookCodes: [...new Set([...existingHooks, ...p.parsed.integrations.map((h) => h.code)])] };
    p.parsed.ruleset = { nameEn: String(c.ruleset.nameEn ?? 'Process rules').slice(0, 200), nameAr: String(c.ruleset.nameAr ?? 'قواعد الإجراءات').slice(0, 200),
      def: validateRuleset(c.ruleset.definition, rc, factsWith(rc) as any) };
    p.items.push({ kind: 'RULESET', code: RULESET_CODE, action: 'NEW_DRAFT_VERSION', note: p.parsed.forms.length ? 'publish the imported forms before the rule set' : undefined });
  });
  return p;
}

export async function previewImport(ctx: Ctx, actor: Actor, pkg: any) {
  const p = await plan(ctx, actor, pkg);
  return { valid: !p.errors.length, items: p.items, errors: p.errors, warnings: p.warnings, checksumOk: p.checksumOk, source: pkg?.source ?? null };
}

export async function importPackage(ctx: Ctx, actor: Actor, pkg: any) {
  const p = await plan(ctx, actor, pkg);
  if (p.errors.length) throw new ApiError(400, 'PACKAGE_INVALID', `The package cannot be imported: ${p.errors.join(' · ')}`, { errors: p.errors });
  const created: { kind: string; code: string; id: string; version?: number }[] = [];
  await ctx.db.tx(async (q) => {
    for (const t of p.parsed.templates) {
      const v = Number((await q.query<{ v: number | null }>('SELECT max(version) AS v FROM cycle_templates WHERE tenant_id=$1 AND code=$2', [actor.tenantId, t.code]))[0]?.v) || 0;
      const id = uuid();
      await q.query(`INSERT INTO cycle_templates (id, tenant_id, code, version, name_en, name_ar, description, config, status, created_by, created_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'DRAFT',$9,$10)`, [id, actor.tenantId, t.code, v + 1, t.nameEn, t.nameAr, t.description, JSON.stringify(t.config), actor.id, now()]);
      created.push({ kind: 'CYCLE_TEMPLATE', code: t.code, id, version: v + 1 });
    }
    const insertDef = async (kind: 'FORM' | 'RULESET', code: string, nameEn: string, nameAr: string, def: unknown) => {
      const v = Number((await q.query<{ v: number | null }>('SELECT max(version) AS v FROM lowcode_definitions WHERE tenant_id=$1 AND kind=$2 AND code=$3', [actor.tenantId, kind, code]))[0]?.v) || 0;
      const id = uuid();
      await q.query(`INSERT INTO lowcode_definitions (id, tenant_id, kind, code, version, status, name_en, name_ar, definition, created_by, updated_by, created_at, updated_at)
                     VALUES ($1,$2,$3,$4,$5,'DRAFT',$6,$7,$8::jsonb,$9,$9,$10,$10)`, [id, actor.tenantId, kind, code, v + 1, nameEn, nameAr, JSON.stringify(def), actor.id, now()]);
      created.push({ kind, code, id, version: v + 1 });
    };
    for (const f of p.parsed.forms) await insertDef('FORM', f.code, f.nameEn, f.nameAr, f.def);
    if (p.parsed.ruleset) await insertDef('RULESET', RULESET_CODE, p.parsed.ruleset.nameEn, p.parsed.ruleset.nameAr, p.parsed.ruleset.def);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'LOWCODE_PACKAGE_IMPORTED', resourceType: 'TENANT', resourceId: actor.tenantId,
      details: { source: pkg.source?.entity ?? null, checksum: pkg.checksum ?? null, checksumOk: p.checksumOk, created: created.map((c) => `${c.kind}:${c.code}:v${c.version}`) } });
  });
  // Integrations need their own secret each (created switched off; the admin enters the URL owner's details and enables them).
  const secrets: { code: string; secret: string }[] = [];
  const { createEndpoint } = await import('./webhooks.js');
  const existing = (await ctx.db.query<{ code: string }>('SELECT code FROM webhook_endpoints WHERE tenant_id=$1', [actor.tenantId])).map((x) => x.code);
  for (const h of p.parsed.integrations) {
    if (existing.includes(h.code)) continue;
    const r = await createEndpoint(ctx, actor, { ...h, enabled: false });
    secrets.push({ code: h.code, secret: r.secret });
    created.push({ kind: 'INTEGRATION', code: h.code, id: r.id });
  }
  return { created, integrationSecrets: secrets, warnings: p.warnings,
    next: 'Review the drafts in the Process Studio, publish the forms first, then the rule set; publish the cycle templates in the Cycle Designer.' };
}
