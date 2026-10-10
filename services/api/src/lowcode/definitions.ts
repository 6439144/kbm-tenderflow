// Versioned low-code definitions (forms and the rule set): DRAFT → PUBLISHED → RETIRED, like cycle templates.
// Only a DRAFT can be edited; publishing re-validates against the entity's current forms and integrations and retires
// the previous published version. Running tenders keep the form version and the gate rules they started with.
import type { Ctx } from '../ctx.js';
import { auditTx } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import type { Queryable } from '../db.js';
import { ApiError, badRequest, conflict, forbidden, isUuid, notFound, now, str, uuid } from '../util.js';
import { factsFor } from './conditions.js';
import type { Scope } from './catalog.js';
import { FORM_CODES, validateFormDefinition, type FormCode, type FormDefinition } from './forms.js';
import { customFactSources, factKeysUsed, rulesetWarnings, validateRuleset, type RuleContext, type RulesetDefinition } from './rules.js';
import { getProfile } from '../services/templates.js';

export type Kind = 'FORM' | 'RULESET';
export interface DefinitionRow {
  id: string; tenant_id: string; kind: Kind; code: string; version: number; status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  name_en: string; name_ar: string; definition: any; created_by: string; updated_by: string; created_at: Date; updated_at: Date;
  published_by: string | null; published_at: Date | null;
}

export const RULESET_CODE = 'PROCESS';

export const publicDefinitionRow = (r: DefinitionRow) => ({
  id: r.id, kind: r.kind, code: r.code, version: r.version, status: r.status, nameEn: r.name_en, nameAr: r.name_ar,
  definition: r.definition, createdBy: r.created_by, updatedBy: r.updated_by, createdAt: r.created_at, updatedAt: r.updated_at,
  publishedBy: r.published_by, publishedAt: r.published_at,
});

export async function liveDefinition(q: Queryable, tenantId: string, kind: Kind, code: string): Promise<DefinitionRow | null> {
  const r = await q.query<DefinitionRow>(
    `SELECT * FROM lowcode_definitions WHERE tenant_id=$1 AND kind=$2 AND code=$3 AND status='PUBLISHED' ORDER BY version DESC LIMIT 1`, [tenantId, kind, code]);
  return r[0] ?? null;
}
export async function definitionById(q: Queryable, tenantId: string, id: string): Promise<DefinitionRow> {
  if (!isUuid(id)) throw notFound('Definition');
  const r = await q.query<DefinitionRow>('SELECT * FROM lowcode_definitions WHERE id=$1 AND tenant_id=$2', [id, tenantId]);
  if (!r[0]) throw notFound('Definition');
  return r[0];
}

/** Published forms of an entity (for rule validation, the catalogue and the simulator). */
export async function liveForms(q: Queryable, tenantId: string): Promise<RuleContext['forms']> {
  const rows = await q.query<DefinitionRow>(
    `SELECT DISTINCT ON (code) * FROM lowcode_definitions WHERE tenant_id=$1 AND kind='FORM' AND status='PUBLISHED' ORDER BY code, version DESC`, [tenantId]);
  return Object.fromEntries(rows.map((r) => [r.code, r.definition as FormDefinition]));
}
export async function liveRuleset(q: Queryable, tenantId: string): Promise<DefinitionRow | null> {
  return liveDefinition(q, tenantId, 'RULESET', RULESET_CODE);
}

export async function ruleContext(q: Queryable, tenantId: string, formsOverride?: RuleContext['forms']): Promise<RuleContext> {
  const forms = { ...(await liveForms(q, tenantId)), ...(formsOverride ?? {}) };
  const hooks = await q.query<{ code: string }>('SELECT code FROM webhook_endpoints WHERE tenant_id=$1', [tenantId]);
  return { forms, webhookCodes: hooks.map((h) => h.code) };
}
export const factsWith = (rc: RuleContext) => (scope: Scope | null) => factsFor(scope, customFactSources(rc.forms));

/** Validate a form / rule-set body against a rule context (forms + integrations). Throws a 400 ApiError with the reason. */
export function validateBody(kind: Kind, code: string, def: unknown, rc: RuleContext) {
  if (kind === 'FORM') {
    if (!FORM_CODES.includes(code as FormCode)) throw badRequest(`Form code must be one of ${FORM_CODES.join(', ')}`);
    return validateFormDefinition(def, code as FormCode);
  }
  if (code !== RULESET_CODE) throw badRequest(`Rule set code must be ${RULESET_CODE}`);
  return validateRuleset(def, rc, factsWith(rc) as (s: Scope) => any);
}

/** Validate a definition and report errors and warnings without saving (Studio "Check" button). */
export async function checkDefinition(ctx: Ctx, actor: Actor, b: any) {
  const kind: Kind = b?.kind === 'FORM' ? 'FORM' : 'RULESET';
  const code = String(b?.code ?? (kind === 'RULESET' ? RULESET_CODE : '')).toUpperCase();
  const rc = await ruleContext(ctx.db, actor.tenantId);
  try {
    const def = validateBody(kind, code, b?.definition, rc);
    return { valid: true, errors: [], warnings: await warningsFor(ctx, actor.tenantId, kind, code, def, rc), definition: def };
  } catch (e) {
    if (e instanceof ApiError) return { valid: false, errors: [e.message], warnings: [] };
    throw e;
  }
}

async function warningsFor(ctx: Ctx, tenantId: string, kind: Kind, code: string, def: any, rc: RuleContext): Promise<string[]> {
  if (kind === 'RULESET') return rulesetWarnings(def as RulesetDefinition);
  // A form change that removes a field the live rule set uses would make those rules fail validation at next publish.
  const w: string[] = [];
  const rs = await liveRuleset(ctx.db, tenantId);
  if (rs) {
    const prefix = code === 'TENDER' ? 'tender.custom.' : code === 'VENDOR' ? 'vendor.custom.' : 'request.custom.';
    const keys = new Set((def as FormDefinition).fields.map((f) => f.key));
    for (const fk of factKeysUsed(rs.definition)) if (fk.startsWith(prefix) && !keys.has(fk.slice(prefix.length)))
      w.push(`The published rule set tests '${fk}', which this form no longer has. Update the rules after publishing.`);
  }
  if ((def as FormDefinition).fields.length === 0) w.push('The form has no fields.');
  void rc;
  return w;
}

export async function listDefinitions(ctx: Ctx, actor: Actor, kind?: unknown) {
  const k = kind === 'FORM' || kind === 'RULESET' ? kind : null;
  const rows = await ctx.db.query<DefinitionRow>(
    `SELECT * FROM lowcode_definitions WHERE tenant_id=$1 AND ($2::text IS NULL OR kind=$2) ORDER BY kind, code, version DESC`, [actor.tenantId, k]);
  return rows.map(publicDefinitionRow);
}

export async function getDefinition(ctx: Ctx, actor: Actor, id: string) {
  return publicDefinitionRow(await definitionById(ctx.db, actor.tenantId, id));
}

/** New DRAFT version (from a body, or a copy of `fromId`). Only one open draft per kind+code. */
export async function createDraft(ctx: Ctx, actor: Actor, b: any) {
  const kind: Kind = b?.kind === 'FORM' ? 'FORM' : b?.kind === 'RULESET' ? 'RULESET' : (() => { throw badRequest("kind must be 'FORM' or 'RULESET'"); })();
  let code = String(b?.code ?? (kind === 'RULESET' ? RULESET_CODE : '')).toUpperCase();
  let body = b?.definition;
  let nameEn = str(b?.nameEn, 'nameEn', { max: 200 });
  let nameAr = str(b?.nameAr, 'nameAr', { max: 200 });
  if (b?.fromId) {
    const src = await definitionById(ctx.db, actor.tenantId, String(b.fromId));
    if (src.kind !== kind) throw badRequest('fromId is a different kind of definition');
    code = src.code; body = body ?? src.definition; nameEn = nameEn ?? src.name_en; nameAr = nameAr ?? src.name_ar;
  }
  const rc = await ruleContext(ctx.db, actor.tenantId);
  const def = validateBody(kind, code, body ?? (kind === 'FORM' ? { sections: [], fields: [] } : { rules: [] }), rc);
  return ctx.db.tx(async (q) => publicDefinitionRow(await insertDraft(ctx, q, actor, { kind, code, definition: def, nameEn, nameAr, fromId: b?.fromId ?? null })));
}

/**
 * Insert a new DRAFT version inside the caller's transaction. The definition must already be validated (validateBody).
 * 409 DRAFT_EXISTS when a draft of this kind+code is open. Audited as LOWCODE_DRAFT_CREATED.
 */
export async function insertDraft(ctx: Ctx, q: Queryable, actor: Actor, d: { kind: Kind; code: string; definition: unknown; nameEn?: string; nameAr?: string; fromId?: string | null },
  auditDetails: Record<string, unknown> = {}): Promise<DefinitionRow> {
  const { kind, code } = d;
  const open = await q.query('SELECT id FROM lowcode_definitions WHERE tenant_id=$1 AND kind=$2 AND code=$3 AND status=\'DRAFT\'', [actor.tenantId, kind, code]);
  if (open.length) throw conflict('DRAFT_EXISTS', 'A draft of this definition is already open; edit or discard it first');
  const v = await q.query<{ v: number | null }>('SELECT max(version) AS v FROM lowcode_definitions WHERE tenant_id=$1 AND kind=$2 AND code=$3', [actor.tenantId, kind, code]);
  const version = (Number(v[0]?.v) || 0) + 1;
  const defaults = kind === 'RULESET' ? ['Process rules', 'قواعد الإجراءات'] : [`${code[0]}${code.slice(1).toLowerCase()} form`, code === 'TENDER' ? 'نموذج المناقصة' : code === 'VENDOR' ? 'نموذج المورد' : 'نموذج الطلب'];
  const rows = await q.query<DefinitionRow>(
    `INSERT INTO lowcode_definitions (id, tenant_id, kind, code, version, status, name_en, name_ar, definition, created_by, updated_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'DRAFT',$6,$7,$8::jsonb,$9,$9,$10,$10) RETURNING *`,
    [uuid(), actor.tenantId, kind, code, version, d.nameEn ?? defaults[0], d.nameAr ?? defaults[1], JSON.stringify(d.definition), actor.id, now()]);
  await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'LOWCODE_DRAFT_CREATED', resourceType: 'LOWCODE_DEFINITION', resourceId: rows[0].id,
    newState: 'DRAFT', details: { kind, code, version, fromId: d.fromId ?? null, ...auditDetails } });
  return rows[0];
}

/** Save a (validated) definition into an open DRAFT inside the caller's transaction. Audited as LOWCODE_DRAFT_UPDATED. */
export async function saveDraft(ctx: Ctx, q: Queryable, actor: Actor, row: DefinitionRow, def: unknown, names: { nameEn?: string; nameAr?: string } = {},
  auditDetails: Record<string, unknown> = {}): Promise<DefinitionRow> {
  const rows = await q.query<DefinitionRow>(
    `UPDATE lowcode_definitions SET definition=$1::jsonb, name_en=$2, name_ar=$3, updated_by=$4, updated_at=$5 WHERE id=$6 AND tenant_id=$7 AND status='DRAFT' RETURNING *`,
    [JSON.stringify(def), names.nameEn ?? row.name_en, names.nameAr ?? row.name_ar, actor.id, now(), row.id, actor.tenantId]);
  if (!rows[0]) throw conflict('INVALID_STATE', 'The draft was published or discarded meanwhile');
  await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'LOWCODE_DRAFT_UPDATED', resourceType: 'LOWCODE_DEFINITION', resourceId: row.id,
    details: { kind: row.kind, code: row.code, version: row.version, ...auditDetails } });
  return rows[0];
}

export async function updateDraft(ctx: Ctx, actor: Actor, id: string, b: any) {
  const row = await definitionById(ctx.db, actor.tenantId, id);
  if (row.status !== 'DRAFT') throw conflict('INVALID_STATE', 'Only a DRAFT can be edited; create a new version instead');
  const rc = await ruleContext(ctx.db, actor.tenantId);
  const def = b?.definition !== undefined ? validateBody(row.kind, row.code, b.definition, rc) : row.definition;
  return ctx.db.tx(async (q) => publicDefinitionRow(await saveDraft(ctx, q, actor, row, def,
    { nameEn: str(b?.nameEn, 'nameEn', { max: 200 }), nameAr: str(b?.nameAr, 'nameAr', { max: 200 }) })));
}

export async function discardDraft(ctx: Ctx, actor: Actor, id: string) {
  const row = await definitionById(ctx.db, actor.tenantId, id);
  if (row.status !== 'DRAFT') throw conflict('INVALID_STATE', 'Only a DRAFT can be discarded; published versions are kept for the record');
  await ctx.db.tx(async (q) => {
    await q.query(`DELETE FROM lowcode_definitions WHERE id=$1 AND status='DRAFT'`, [id]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'LOWCODE_DRAFT_DISCARDED', resourceType: 'LOWCODE_DEFINITION', resourceId: id,
      prevState: 'DRAFT', details: { kind: row.kind, code: row.code, version: row.version } });
  });
  return { discarded: true };
}

export async function publishDefinition(ctx: Ctx, actor: Actor, id: string) {
  const row = await definitionById(ctx.db, actor.tenantId, id);
  if (row.status !== 'DRAFT') throw conflict('INVALID_STATE', 'This version is already published or retired');
  const profile = await getProfile(ctx, actor.tenantId);
  if (profile.configFourEyes && row.updated_by === actor.id)
    throw forbidden('Four-eyes on configuration: the last person who edited this draft cannot publish it');
  const rc = await ruleContext(ctx.db, actor.tenantId);
  const def = validateBody(row.kind, row.code, row.definition, rc); // re-validate against today's forms and integrations
  return ctx.db.tx(async (q) => {
    const prev = await q.query<{ id: string; version: number }>(
      `UPDATE lowcode_definitions SET status='RETIRED' WHERE tenant_id=$1 AND kind=$2 AND code=$3 AND status='PUBLISHED' RETURNING id, version`, [actor.tenantId, row.kind, row.code]);
    const rows = await q.query<DefinitionRow>(
      `UPDATE lowcode_definitions SET status='PUBLISHED', definition=$1::jsonb, published_by=$2, published_at=$3 WHERE id=$4 RETURNING *`,
      [JSON.stringify(def), actor.id, now(), id]);
    if (row.kind === 'RULESET') {
      // Event automation starts from "now": history is never replayed when rules are first published.
      await q.query(`INSERT INTO lowcode_cursor (tenant_id, last_seq, updated_at)
                     SELECT $1, COALESCE(max(seq),0), $2 FROM audit_events WHERE tenant_id=$1 ON CONFLICT (tenant_id) DO NOTHING`, [actor.tenantId, now()]);
    }
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'LOWCODE_PUBLISHED', resourceType: 'LOWCODE_DEFINITION', resourceId: id,
      prevState: 'DRAFT', newState: 'PUBLISHED', details: { kind: row.kind, code: row.code, version: row.version, retired: prev.map((p) => p.version),
        summary: row.kind === 'RULESET' ? { rules: (def as RulesetDefinition).rules.length } : { fields: (def as FormDefinition).fields.length } } });
    return publicDefinitionRow(rows[0]);
  });
}

/** Version history with a field/rule-level diff to the previous version (for reviewers and auditors). */
export async function definitionHistory(ctx: Ctx, actor: Actor, kind: string, code: string) {
  const rows = await ctx.db.query<DefinitionRow>(
    `SELECT * FROM lowcode_definitions WHERE tenant_id=$1 AND kind=$2 AND code=$3 ORDER BY version`, [actor.tenantId, kind, code.toUpperCase()]);
  const keyOf = (r: DefinitionRow) => new Map<string, string>(
    (r.kind === 'FORM' ? r.definition.fields.map((f: any) => [f.key, JSON.stringify(f)]) : r.definition.rules.map((x: any) => [x.id, JSON.stringify(x)])));
  return rows.map((r, i) => {
    const prev = i ? keyOf(rows[i - 1]) : new Map<string, string>();
    const cur = keyOf(r);
    return {
      ...publicDefinitionRow(r), definition: undefined,
      changes: {
        added: [...cur.keys()].filter((k) => !prev.has(k)),
        removed: [...prev.keys()].filter((k) => !cur.has(k)),
        changed: [...cur.keys()].filter((k) => prev.has(k) && prev.get(k) !== cur.get(k)),
      },
    };
  });
}

/** Insert a published definition directly (seed / starter content). */
export async function installPublished(ctx: Ctx, q: Queryable, actor: { id: string; roles: string[] }, tenantId: string, kind: Kind, code: string,
  nameEn: string, nameAr: string, definition: unknown) {
  const rc = await ruleContext(q, tenantId);
  const def = validateBody(kind, code, definition, rc);
  const id = uuid();
  await q.query(
    `INSERT INTO lowcode_definitions (id, tenant_id, kind, code, version, status, name_en, name_ar, definition, created_by, updated_by, created_at, updated_at, published_by, published_at)
     VALUES ($1,$2,$3,$4,1,'PUBLISHED',$5,$6,$7::jsonb,$8,$8,$9,$9,$8,$9)`, [id, tenantId, kind, code, nameEn, nameAr, JSON.stringify(def), actor.id, now()]);
  if (kind === 'RULESET') await q.query(`INSERT INTO lowcode_cursor (tenant_id, last_seq, updated_at)
     SELECT $1, COALESCE(max(seq),0), $2 FROM audit_events WHERE tenant_id=$1 ON CONFLICT (tenant_id) DO NOTHING`, [tenantId, now()]);
  await auditTx(ctx, q, { tenantId, actor, action: 'LOWCODE_PUBLISHED', resourceType: 'LOWCODE_DEFINITION', resourceId: id,
    newState: 'PUBLISHED', details: { kind, code, version: 1, starter: true } });
  return id;
}
