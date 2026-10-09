// Cycle templates: each entity's tender cycle as versioned configuration that the server enforces.
// A tender pins a snapshot of the template version it was created with, so later template edits never
// change a running tender. Integrity rules (sealed bids, opening after deadline by the chair, approver ≠
// creator, recommender ≠ award approver, append-only audit) are NOT configurable and are not represented here.
import type { Ctx } from '../ctx.js';
import { auditTx } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import type { Queryable } from '../db.js';
import { ROLES } from '../auth/tokens.js';
import { ApiError, badRequest, camel, conflict, isUuid, notFound, now, reqStr, str, uuid } from '../util.js';

export interface ApprovalLevel {
  role: string; labelEn: string; labelAr: string;
  /** Service level of this approval step in hours (stored and validated here; escalation is a notifications feature). */
  dueHours?: number;
}
/**
 * FULL_CYCLE — request → … → sealed bids → opening → evaluation → award (default).
 * PUBLICATION_AND_SALE — the cycle ends at document purchase: bidding, opening, evaluation and award are not part
 * of this entity's current scope (e.g. MOI Phase 1). The bid/opening routes refuse with 409 STAGE_NOT_IN_SCOPE.
 */
export type CycleScope = 'FULL_CYCLE' | 'PUBLICATION_AND_SALE';
export const OUT_OF_SCOPE_STAGES: Record<CycleScope, string[]> = {
  FULL_CYCLE: [],
  PUBLICATION_AND_SALE: ['SEALED_BIDS', 'OPENING', 'COMPLIANCE', 'EVALUATION', 'AWARD_APPROVAL', 'RECORDS_LOCK'],
};
export interface CycleConfig {
  scope?: CycleScope;
  stages: {
    requestIntake: boolean;      // departmental request (Raslni / scanned letter) precedes the tender
    documentPurchase: boolean;   // vendors buy the tender documents before bidding
    gazette: boolean;            // Kuwait Al-Youm notice
    capt: boolean;               // CAPT notice
    complianceScreening: boolean;// AI compliance checklist after opening (advisory)
    recordsLock: boolean;        // documents declared as records at award
  };
  approvals: { request: ApprovalLevel[]; publish: ApprovalLevel[]; award: ApprovalLevel[] };
  envelopes: 'ONE' | 'TWO';
  evaluation: { technicalPassMark: number | null; financialCriteria: string[] };
  eligibility: { activityCodes: string[]; minGrade: number | null };
  fees: { documentPrice: number; currency: string; exemptionAllowed: boolean };
  ai: { packCheck: boolean; clarification: boolean; compliance: boolean; gazette: boolean; relevance: boolean; narrative: boolean; requestClassify: boolean;
    /** Classify + extract data from documents of this tender automatically after upload / opening (watsonx Orchestrate). */
    documentIntelligence: boolean };
}

export interface TemplateRow {
  id: string; tenant_id: string; code: string; version: number; name_en: string; name_ar: string; description: string;
  config: CycleConfig; status: 'DRAFT' | 'PUBLISHED' | 'RETIRED'; is_default: boolean; created_by: string; created_at: Date; published_at: Date | null;
}

const L = (role: string, labelEn: string, labelAr: string): ApprovalLevel => ({ role, labelEn, labelAr });
export const LEVEL_DIRECTOR = L('DIRECTOR', 'Procurement Director', 'مدير المشتريات');
export const LEVEL_UNDERSECRETARY = L('UNDERSECRETARY', 'Undersecretary', 'الوكيل');

/** Behaviour of a tender with no template: identical to TenderFlow v1.0 (one director approval, one envelope). */
export const DEFAULT_CONFIG: CycleConfig = {
  scope: 'FULL_CYCLE',
  stages: { requestIntake: false, documentPurchase: false, gazette: false, capt: false, complianceScreening: true, recordsLock: false },
  approvals: { request: [LEVEL_DIRECTOR], publish: [LEVEL_DIRECTOR], award: [LEVEL_DIRECTOR] },
  envelopes: 'ONE',
  evaluation: { technicalPassMark: null, financialCriteria: [] },
  eligibility: { activityCodes: [], minGrade: null },
  fees: { documentPrice: 0, currency: 'KWD', exemptionAllowed: false },
  ai: { packCheck: true, clarification: true, compliance: true, gazette: true, relevance: true, narrative: true, requestClassify: true, documentIntelligence: true },
};

export const STARTER_TEMPLATES: { code: string; nameEn: string; nameAr: string; description: string; config: CycleConfig }[] = [
  {
    code: 'PUBLIC_TENDER', nameEn: 'Public tender (one envelope)', nameAr: 'مناقصة عامة (مظروف واحد)',
    description: 'Open competition. Departmental request, director approval, gazette notice, one sealed envelope, records locked at award.',
    config: {
      ...DEFAULT_CONFIG,
      stages: { requestIntake: true, documentPurchase: false, gazette: true, capt: false, complianceScreening: true, recordsLock: true },
    },
  },
  {
    code: 'LIMITED_TENDER', nameEn: 'Limited tender / practice', nameAr: 'مناقصة محدودة / ممارسة',
    description: 'Invited vendors, single approval, no gazette notice, no document fee.',
    config: { ...DEFAULT_CONFIG, stages: { ...DEFAULT_CONFIG.stages, complianceScreening: true } },
  },
  {
    code: 'RFP_TWO_ENVELOPE', nameEn: 'RFP — two envelopes', nameAr: 'طلب عروض — مظروفان',
    description: 'Technical envelope opened and scored first; only bids above the pass mark have their financial envelope opened. Two approval levels, paid documents, gazette and CAPT notices, minimum Second grade.',
    config: {
      stages: { requestIntake: true, documentPurchase: true, gazette: true, capt: true, complianceScreening: true, recordsLock: true },
      approvals: { request: [LEVEL_DIRECTOR], publish: [LEVEL_DIRECTOR, LEVEL_UNDERSECRETARY], award: [LEVEL_DIRECTOR, LEVEL_UNDERSECRETARY] },
      envelopes: 'TWO',
      evaluation: { technicalPassMark: 70, financialCriteria: ['price'] },
      eligibility: { activityCodes: [], minGrade: 2 },
      fees: { documentPrice: 50, currency: 'KWD', exemptionAllowed: true },
      ai: { ...DEFAULT_CONFIG.ai },
    },
  },
];

const APPROVER_ROLES = ['DIRECTOR', 'UNDERSECRETARY', 'COMMITTEE_CHAIR', 'TENANT_ADMIN'];
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

function parseLevels(v: unknown, field: string, min = 1): ApprovalLevel[] {
  if (!Array.isArray(v)) throw badRequest(`${field} must be an array of approval levels`);
  if (v.length < min) throw badRequest(`${field} needs at least ${min} level(s)`);
  if (v.length > 5) throw badRequest(`${field} allows at most 5 levels`);
  return v.map((x: any, i) => {
    const role = x?.role;
    if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role) || !APPROVER_ROLES.includes(role))
      throw badRequest(`${field}[${i}].role must be one of ${APPROVER_ROLES.join(', ')}`);
    const out: ApprovalLevel = { role, labelEn: str(x?.labelEn, `${field}[${i}].labelEn`, { max: 120 }) ?? role, labelAr: str(x?.labelAr, `${field}[${i}].labelAr`, { max: 120 }) ?? role };
    if (x?.dueHours !== undefined && x?.dueHours !== null && x?.dueHours !== '') {
      const h = Number(x.dueHours);
      if (!Number.isInteger(h) || h < 1 || h > 8760) throw badRequest(`${field}[${i}].dueHours must be a whole number of hours between 1 and 8760`);
      out.dueHours = h;
    }
    return out;
  });
}

/** Validate a template config. Rejects anything that would weaken a fixed integrity rule. */
export function parseConfig(raw: any): CycleConfig {
  if (!raw || typeof raw !== 'object') throw badRequest('config must be an object');
  const d = DEFAULT_CONFIG;
  const s = raw.stages ?? {};
  const envelopes = raw.envelopes ?? 'ONE';
  if (envelopes !== 'ONE' && envelopes !== 'TWO') throw badRequest("envelopes must be 'ONE' or 'TWO'");
  const ev = raw.evaluation ?? {};
  let pass: number | null = ev.technicalPassMark === undefined || ev.technicalPassMark === null || ev.technicalPassMark === '' ? null : Number(ev.technicalPassMark);
  if (pass !== null && (!Number.isFinite(pass) || pass < 0 || pass > 100)) throw badRequest('evaluation.technicalPassMark must be 0-100');
  const finCrit = Array.isArray(ev.financialCriteria) ? ev.financialCriteria.filter((x: unknown) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(x)) : [];
  if (envelopes === 'TWO') {
    if (pass === null) throw badRequest('Two-envelope templates need evaluation.technicalPassMark');
    if (!finCrit.length) throw badRequest('Two-envelope templates need at least one evaluation.financialCriteria key (e.g. "price")');
  } else pass = null;
  const el = raw.eligibility ?? {};
  const minGrade = el.minGrade === undefined || el.minGrade === null || el.minGrade === '' ? null : Number(el.minGrade);
  if (minGrade !== null && ![1, 2, 3].includes(minGrade)) throw badRequest('eligibility.minGrade must be 1 (First), 2 (Second), 3 (Third) or null');
  const codes = Array.isArray(el.activityCodes) ? el.activityCodes.filter((x: unknown) => typeof x === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(x)) : [];
  const f = raw.fees ?? {};
  const price = Number(f.documentPrice ?? 0);
  if (!Number.isFinite(price) || price < 0 || price > 100000) throw badRequest('fees.documentPrice must be 0-100000');
  const documentPurchase = bool(s.documentPurchase, d.stages.documentPurchase);
  if (documentPurchase && price <= 0) throw badRequest('documentPurchase needs fees.documentPrice > 0');
  const ap = raw.approvals ?? {};
  const ai = raw.ai ?? {};
  const scope = raw.scope ?? 'FULL_CYCLE';
  if (scope !== 'FULL_CYCLE' && scope !== 'PUBLICATION_AND_SALE') throw badRequest("scope must be 'FULL_CYCLE' or 'PUBLICATION_AND_SALE'");
  return {
    scope,
    stages: {
      requestIntake: bool(s.requestIntake, d.stages.requestIntake), documentPurchase,
      gazette: bool(s.gazette, d.stages.gazette), capt: bool(s.capt, d.stages.capt),
      complianceScreening: bool(s.complianceScreening, d.stages.complianceScreening), recordsLock: bool(s.recordsLock, d.stages.recordsLock),
    },
    approvals: {
      request: ap.request === undefined ? d.approvals.request : parseLevels(ap.request, 'approvals.request'),
      publish: ap.publish === undefined ? d.approvals.publish : parseLevels(ap.publish, 'approvals.publish'),
      award: ap.award === undefined ? d.approvals.award : parseLevels(ap.award, 'approvals.award'),
    },
    envelopes,
    evaluation: { technicalPassMark: pass, financialCriteria: envelopes === 'TWO' ? finCrit : [] },
    eligibility: { activityCodes: codes, minGrade },
    fees: { documentPrice: documentPurchase ? price : 0, currency: str(f.currency, 'fees.currency', { max: 3 }) ?? 'KWD', exemptionAllowed: bool(f.exemptionAllowed, false) },
    ai: Object.fromEntries(Object.entries(d.ai).map(([k, v]) => [k, bool(ai[k], v)])) as CycleConfig['ai'],
  };
}

/** The effective config of a tender (its pinned snapshot, or the v1 default). */
export function configOf(t: { template_snapshot?: any }): CycleConfig {
  const snap = t.template_snapshot?.config;
  return snap ? (snap as CycleConfig) : DEFAULT_CONFIG;
}

/** Ordered list of stages a template switches on, for previews and the tender stepper. */
export function stageList(c: CycleConfig): { key: string; kind: 'FIXED' | 'CONFIGURED' | 'OPTIONAL'; enabled: boolean; detail?: string }[] {
  const out = scopeOf(c) === 'FULL_CYCLE' ? null : OUT_OF_SCOPE_STAGES[scopeOf(c)];
  const all: { key: string; kind: 'FIXED' | 'CONFIGURED' | 'OPTIONAL'; enabled: boolean; detail?: string }[] = [
    { key: 'REQUEST_INTAKE', kind: 'OPTIONAL', enabled: c.stages.requestIntake },
    { key: 'DRAFT', kind: 'FIXED', enabled: true },
    { key: 'APPROVAL', kind: 'CONFIGURED', enabled: true, detail: c.approvals.publish.map((l) => l.role).join(' → ') },
    { key: 'PUBLISH', kind: 'FIXED', enabled: true },
    { key: 'GAZETTE', kind: 'OPTIONAL', enabled: c.stages.gazette },
    { key: 'CAPT', kind: 'OPTIONAL', enabled: c.stages.capt },
    { key: 'DOCUMENT_PURCHASE', kind: 'OPTIONAL', enabled: c.stages.documentPurchase, detail: c.stages.documentPurchase ? `${c.fees.documentPrice} ${c.fees.currency}` : undefined },
    { key: 'CLARIFICATIONS', kind: 'FIXED', enabled: true },
    { key: 'SEALED_BIDS', kind: 'FIXED', enabled: true },
    { key: 'CLOSE', kind: 'FIXED', enabled: true },
    { key: 'OPENING', kind: 'CONFIGURED', enabled: true, detail: c.envelopes === 'TWO' ? `TWO (pass mark ${c.evaluation.technicalPassMark})` : 'ONE' },
    { key: 'COMPLIANCE', kind: 'OPTIONAL', enabled: c.stages.complianceScreening },
    { key: 'EVALUATION', kind: 'CONFIGURED', enabled: true },
    { key: 'AWARD_APPROVAL', kind: 'CONFIGURED', enabled: true, detail: c.approvals.award.map((l) => l.role).join(' → ') },
    { key: 'RECORDS_LOCK', kind: 'OPTIONAL', enabled: c.stages.recordsLock },
  ];
  return out ? all.filter((s) => !out.includes(s.key)) : all;
}

export const scopeOf = (c: CycleConfig): CycleScope => (c.scope === 'PUBLICATION_AND_SALE' ? 'PUBLICATION_AND_SALE' : 'FULL_CYCLE');

/** Throws 409 STAGE_NOT_IN_SCOPE when the tender's pinned cycle excludes the stage (e.g. bids in PUBLICATION_AND_SALE). */
export function assertStageInScope(t: { template_snapshot?: any }, stage: string) {
  const scope = scopeOf(configOf(t));
  if (OUT_OF_SCOPE_STAGES[scope].includes(stage))
    throw new ApiError(409, 'STAGE_NOT_IN_SCOPE', `${stage} is outside this entity's current scope (${scope}): the cycle ends at document purchase. Bidding and award are outside the current scope.`, { scope, stage });
}

export const publicTemplate = (t: TemplateRow) => {
  const o = camel<any>({ ...t, config: undefined });
  o.config = t.config; // keep config keys as authored (already camelCase)
  o.stages = stageList(t.config);
  return o;
};

export async function listTemplates(ctx: Ctx, actor: Actor, opts: { includeDrafts?: boolean } = {}) {
  const rows = await ctx.db.query<TemplateRow>(
    `SELECT * FROM cycle_templates WHERE tenant_id=$1 AND ($2::boolean OR status='PUBLISHED') ORDER BY code, version DESC`,
    [actor.tenantId, !!opts.includeDrafts]);
  return rows.map(publicTemplate);
}

export async function loadTemplate(ctx: Ctx | { db: Queryable }, tenantId: string, id: string): Promise<TemplateRow> {
  if (!isUuid(id)) throw notFound('Template');
  const rows = await ctx.db.query<TemplateRow>('SELECT * FROM cycle_templates WHERE id=$1 AND tenant_id=$2', [id, tenantId]);
  if (!rows[0]) throw notFound('Template');
  return rows[0];
}

export async function getTemplate(ctx: Ctx, actor: Actor, id: string) {
  return publicTemplate(await loadTemplate(ctx, actor.tenantId, id));
}

/** Template to use for a new tender: the requested one (must be PUBLISHED) or the tenant default (may be none). */
export async function resolveTemplate(ctx: Ctx, q: Queryable, tenantId: string, templateId?: unknown): Promise<TemplateRow | null> {
  if (templateId) {
    const t = await loadTemplate({ db: q }, tenantId, String(templateId));
    if (t.status !== 'PUBLISHED') throw conflict('TEMPLATE_NOT_PUBLISHED', 'Only published templates can be used for new tenders');
    return t;
  }
  const rows = await q.query<TemplateRow>(
    `SELECT * FROM cycle_templates WHERE tenant_id=$1 AND status='PUBLISHED' AND is_default ORDER BY version DESC LIMIT 1`, [tenantId]);
  return rows[0] ?? null;
}

export const snapshotOf = (t: TemplateRow | null) =>
  t ? { templateId: t.id, code: t.code, version: t.version, nameEn: t.name_en, nameAr: t.name_ar, config: t.config } : null;

/** Create a new DRAFT version (code new → version 1; existing code → next version). */
export async function createTemplate(ctx: Ctx, actor: Actor, b: any) {
  const code = reqStr(b?.code, 'code', 60).toUpperCase();
  if (!/^[A-Z0-9_]{2,60}$/.test(code)) throw badRequest('code may contain only A-Z, 0-9 and _');
  const config = parseConfig(b?.config ?? {});
  return ctx.db.tx(async (q) => {
    const v = await q.query<{ v: number | null }>('SELECT max(version) AS v FROM cycle_templates WHERE tenant_id=$1 AND code=$2', [actor.tenantId, code]);
    const version = (Number(v[0]?.v) || 0) + 1;
    const rows = await q.query<TemplateRow>(
      `INSERT INTO cycle_templates (id, tenant_id, code, version, name_en, name_ar, description, config, status, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'DRAFT',$9,$10) RETURNING *`,
      [uuid(), actor.tenantId, code, version, reqStr(b?.nameEn, 'nameEn', 200), reqStr(b?.nameAr, 'nameAr', 200),
        str(b?.description, 'description', { max: 2000 }) ?? '', JSON.stringify(config), actor.id, now()]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'TEMPLATE_CREATED', resourceType: 'TEMPLATE', resourceId: rows[0].id,
      newState: 'DRAFT', details: { code, version } });
    return publicTemplate(rows[0]);
  });
}

export async function updateTemplate(ctx: Ctx, actor: Actor, id: string, b: any) {
  const t = await loadTemplate(ctx, actor.tenantId, id);
  if (t.status !== 'DRAFT') throw conflict('INVALID_STATE', 'Only DRAFT template versions can be edited; create a new version instead');
  const config = b?.config !== undefined ? parseConfig(b.config) : t.config;
  return ctx.db.tx(async (q) => {
    const rows = await q.query<TemplateRow>(
      `UPDATE cycle_templates SET name_en=$1, name_ar=$2, description=$3, config=$4::jsonb WHERE id=$5 AND status='DRAFT' RETURNING *`,
      [str(b?.nameEn, 'nameEn', { max: 200 }) ?? t.name_en, str(b?.nameAr, 'nameAr', { max: 200 }) ?? t.name_ar,
        str(b?.description, 'description', { max: 2000 }) ?? t.description, JSON.stringify(config), id]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'TEMPLATE_UPDATED', resourceType: 'TEMPLATE', resourceId: id });
    return publicTemplate(rows[0]);
  });
}

/** Validate without saving (Cycle Designer "Validate" button). */
export function validateTemplate(b: any) {
  try {
    const config = parseConfig(b?.config ?? {});
    return { valid: true, config, stages: stageList(config) };
  } catch (e) {
    return { valid: false, error: (e as Error).message };
  }
}

export async function publishTemplate(ctx: Ctx, actor: Actor, id: string, b: any) {
  const t = await loadTemplate(ctx, actor.tenantId, id);
  if (t.status !== 'DRAFT') throw conflict('INVALID_STATE', 'Template version is already published or retired');
  parseConfig(t.config); // re-validate
  const makeDefault = b?.makeDefault === true;
  return ctx.db.tx(async (q) => {
    // A new version of the current default template stays the default; otherwise only when asked (or when none exists).
    const prevDefault = await q.query<{ code: string }>(`SELECT code FROM cycle_templates WHERE tenant_id=$1 AND is_default`, [actor.tenantId]);
    const becomeDefault = makeDefault || prevDefault.length === 0 || prevDefault.some((p) => p.code === t.code);
    // Older published versions of the same code retire; running tenders keep their snapshot.
    await q.query(`UPDATE cycle_templates SET status='RETIRED', is_default=false WHERE tenant_id=$1 AND code=$2 AND status='PUBLISHED'`, [actor.tenantId, t.code]);
    if (becomeDefault) await q.query(`UPDATE cycle_templates SET is_default=false WHERE tenant_id=$1`, [actor.tenantId]);
    const rows = await q.query<TemplateRow>(
      `UPDATE cycle_templates SET status='PUBLISHED', published_at=$1, is_default=$2 WHERE id=$3 RETURNING *`, [now(), becomeDefault, id]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'TEMPLATE_PUBLISHED', resourceType: 'TEMPLATE', resourceId: id,
      prevState: 'DRAFT', newState: 'PUBLISHED', details: { code: t.code, version: t.version, isDefault: becomeDefault } });
    return publicTemplate(rows[0]);
  });
}

export async function setDefaultTemplate(ctx: Ctx, actor: Actor, id: string) {
  const t = await loadTemplate(ctx, actor.tenantId, id);
  if (t.status !== 'PUBLISHED') throw conflict('INVALID_STATE', 'Only a published template can be the default');
  return ctx.db.tx(async (q) => {
    await q.query(`UPDATE cycle_templates SET is_default=false WHERE tenant_id=$1`, [actor.tenantId]);
    const rows = await q.query<TemplateRow>(`UPDATE cycle_templates SET is_default=true WHERE id=$1 RETURNING *`, [id]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'TEMPLATE_DEFAULT_SET', resourceType: 'TEMPLATE', resourceId: id });
    return publicTemplate(rows[0]);
  });
}

/** Install the three starter templates (published) for a tenant that has none. */
export async function installStarterTemplates(ctx: Ctx, actor: { id: string; roles: string[]; tenantId: string }, defaultCode = 'PUBLIC_TENDER',
  overrides: Partial<Record<string, Partial<CycleConfig>>> = {}) {
  const existing = await ctx.db.query('SELECT 1 FROM cycle_templates WHERE tenant_id=$1 LIMIT 1', [actor.tenantId]);
  if (existing.length) throw conflict('TEMPLATES_EXIST', 'This entity already has templates');
  return ctx.db.tx(async (q) => {
    const out = [];
    for (const s of STARTER_TEMPLATES) {
      const config = parseConfig({ ...s.config, ...(overrides[s.code] ?? {}) });
      const rows = await q.query<TemplateRow>(
        `INSERT INTO cycle_templates (id, tenant_id, code, version, name_en, name_ar, description, config, status, is_default, created_by, created_at, published_at)
         VALUES ($1,$2,$3,1,$4,$5,$6,$7::jsonb,'PUBLISHED',$8,$9,$10,$10) RETURNING *`,
        [uuid(), actor.tenantId, s.code, s.nameEn, s.nameAr, s.description, JSON.stringify(config), s.code === defaultCode, actor.id, now()]);
      await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'TEMPLATE_PUBLISHED', resourceType: 'TEMPLATE', resourceId: rows[0].id,
        newState: 'PUBLISHED', details: { code: s.code, version: 1, starter: true } });
      out.push(publicTemplate(rows[0]));
    }
    return out;
  });
}

// ---------------- Entity profile ----------------
export interface EntityProfile {
  numberingPattern?: string;          // e.g. 'KEA-{YYYY}-{SEQ3}'
  receiptPattern?: string;            // e.g. 'KEA-R-{YYYY}-{SEQ5}'
  identityProvider?: 'LOCAL' | 'OIDC';
  channels?: { knet?: boolean; gazette?: boolean; capt?: boolean };
  fiscalYearStartMonth?: number;
  logoText?: string;
  sector?: string;
  /** Classify vendor and request-letter uploads automatically with Orchestrate (unset → env DOC_AI_AUTO). */
  documentIntelligenceAuto?: boolean;
  /** List this entity's PUBLISHED tenders on the public cross-entity tender board (unset = on). */
  publicBoard?: boolean;
}

export function parseProfile(b: any): EntityProfile {
  const pat = (v: unknown, f: string) => {
    const s = str(v, f, { max: 60 });
    if (s && !/^[A-Za-z0-9_{}-]+$/.test(s)) throw badRequest(`${f} may contain letters, digits, -, _ and {YYYY} {SEQ3}..{SEQ6}`);
    return s;
  };
  const fy = b?.fiscalYearStartMonth === undefined ? undefined : Number(b.fiscalYearStartMonth);
  if (fy !== undefined && (!Number.isInteger(fy) || fy < 1 || fy > 12)) throw badRequest('fiscalYearStartMonth must be 1-12');
  return {
    numberingPattern: pat(b?.numberingPattern, 'numberingPattern'),
    receiptPattern: pat(b?.receiptPattern, 'receiptPattern'),
    identityProvider: b?.identityProvider === 'OIDC' ? 'OIDC' : 'LOCAL',
    channels: { knet: !!b?.channels?.knet, gazette: !!b?.channels?.gazette, capt: !!b?.channels?.capt },
    fiscalYearStartMonth: fy,
    logoText: str(b?.logoText, 'logoText', { max: 12 }),
    sector: str(b?.sector, 'sector', { max: 100 }),
    documentIntelligenceAuto: typeof b?.documentIntelligenceAuto === 'boolean' ? b.documentIntelligenceAuto : undefined,
    publicBoard: typeof b?.publicBoard === 'boolean' ? b.publicBoard : undefined,
  };
}

/** Apply a numbering pattern: {YYYY} → year, {SEQn} → zero-padded sequence. */
export function applyPattern(pattern: string, seq: number, date = now()): string {
  return pattern
    .replace(/\{YYYY\}/g, String(date.getUTCFullYear()))
    .replace(/\{SEQ([3-6])\}/g, (_, n: string) => String(seq).padStart(Number(n), '0'));
}

export async function getProfile(ctx: Ctx, tenantId: string): Promise<EntityProfile & { nameEn: string; nameAr: string; primaryColor: string }> {
  const r = (await ctx.db.query<any>('SELECT name_en, name_ar, primary_color, profile FROM tenants WHERE id=$1', [tenantId]))[0];
  if (!r) throw notFound('Tenant');
  return { nameEn: r.name_en, nameAr: r.name_ar, primaryColor: r.primary_color, ...(r.profile ?? {}) };
}

export async function updateProfile(ctx: Ctx, actor: Actor, b: any) {
  const profile = parseProfile(b);
  // A save that does not mention publicBoard keeps the current setting (never silently re-publishes an entity).
  if (profile.publicBoard === undefined) profile.publicBoard = (await getProfile(ctx, actor.tenantId)).publicBoard;
  const color = str(b?.primaryColor, 'primaryColor', { max: 9 });
  if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw badRequest('primaryColor must be #RRGGBB');
  await ctx.db.tx(async (q) => {
    await q.query(`UPDATE tenants SET profile=$1::jsonb, name_en=COALESCE($2,name_en), name_ar=COALESCE($3,name_ar), primary_color=COALESCE($4,primary_color) WHERE id=$5`,
      [JSON.stringify(profile), str(b?.nameEn, 'nameEn', { max: 200 }) ?? null, str(b?.nameAr, 'nameAr', { max: 200 }) ?? null, color ?? null, actor.tenantId]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'ENTITY_PROFILE_UPDATED', resourceType: 'TENANT', resourceId: actor.tenantId,
      details: { fields: Object.keys(b ?? {}) } });
  });
  return getProfile(ctx, actor.tenantId);
}
