// FileNet search: GET /filenet/search?q=&tenderNumber=&documentType= runs a Content Engine SQL query in IBM FileNet
// (documents(repositoryIdentifier, from, where, pageSize)). The WHERE clause always starts with
// `TF_TenantId = '<tenant from the token>' AND IsCurrentVersion = TRUE`; every value is whitelisted
// (content/filenet-model.ts buildSearchWhere). Staff only. Each hit is then mapped to its TenderFlow document and kept
// only when the caller may read that document under TenderFlow's own rules — a sealed bid never appears to someone who
// cannot open it, and objects TenderFlow does not know are not shown.
import type express from 'express';
import type { Ctx } from '../ctx.js';
import { STAFF_ROLES } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import { actor, h, requireRoles } from '../routes.js';
import { ApiError, badRequest } from '../util.js';
import type { DocumentRow } from '../services/documents.js';
import { buildSearchWhere, SearchInputError, type SearchVocabulary } from '../content/filenet-model.js';
import { ContentStoreUnavailableError } from '../content/types.js';
import { fileNetStoreOf } from './filenet-access.js';
import { loadForEvidence } from './filenet-showcase.js';

const MODEL_SEARCH_PROPS = ['TF_TenantId', 'TF_TenderNumber', 'TF_OwnerType'];
const PAGE = 50;

export function registerFileNetSearchRoutes(r: express.Router, ctx: Ctx): void {
  r.get('/filenet/search', requireRoles(...STAFF_ROLES), h((req) => fileNetSearch(ctx, actor(req), req.query as Record<string, unknown>)));
}

const unavailable = (msg: string) => new ApiError(409, 'FILENET_SEARCH_UNAVAILABLE', msg);

function param(q: Record<string, unknown>, name: string): string | null {
  const v = q[name];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw badRequest(`${name} must be a single value`);
  const t = v.trim();
  return t ? t : null;
}

/** Which class and property vocabulary the search can use in this repository, or why it cannot run. */
async function searchTarget(ctx: Ctx): Promise<{ from: string; vocabulary: SearchVocabulary; props: string[] }> {
  const fn = fileNetStoreOf(ctx);
  if (!fn) throw unavailable('FileNet search needs IBM FileNet as the content store (CONTENT_STORE_TYPE=filenet); this environment uses the local file store.');
  if (fn.config.classModel === 'subclasses') {
    const st = await fn.modelStatus();
    const base = st.classes.find((c) => c.name === 'TF_Document');
    if (base?.exists && (!base.present || MODEL_SEARCH_PROPS.every((p) => base.present!.includes(p)))) {
      return { from: 'TF_Document', vocabulary: 'model', props: ['DocumentTitle', ...MODEL_SEARCH_PROPS, 'TF_Confidentiality', 'TF_VersionNo'] };
    }
  }
  if (fn.config.setCustomProperties && fn.config.docClass !== 'Document') {
    return { from: fn.config.docClass, vocabulary: 'legacy', props: ['DocumentTitle', 'TF_TenantId', 'TF_TenderId', 'TF_DocType'] };
  }
  throw unavailable('FileNet search needs TF_TenantId on the document class: create the TenderFlow class model in ACCE (docs/filenet/ACCE-RUNBOOK.md) and set FILENET_CLASS_MODEL=subclasses (or FILENET_DOC_CLASS=TF_Document with FILENET_SET_CUSTOM_PROPERTIES=true).');
}

export async function fileNetSearch(ctx: Ctx, a: Actor, query: Record<string, unknown>) {
  const q = param(query, 'q');
  const tenderNumber = param(query, 'tenderNumber');
  const documentType = param(query, 'documentType');
  const target = await searchTarget(ctx);
  const fn = fileNetStoreOf(ctx)!;
  let tenderId: string | null = null;
  if (tenderNumber && target.vocabulary === 'legacy') {
    tenderId = (await ctx.db.query<{ id: string }>('SELECT id FROM tenders WHERE tenant_id=$1 AND tender_number=$2', [a.tenantId, tenderNumber]))[0]?.id ?? null;
    if (!tenderId) return { from: target.from, vocabulary: target.vocabulary, where: null, results: [], repositoryHits: 0, hidden: 0, more: false, note: 'no tender with this number' };
  }
  let where: string;
  try {
    where = buildSearchWhere({ tenantId: a.tenantId, q, tenderNumber, tenderId, ownerType: documentType }, target.vocabulary);
  } catch (e) {
    if (e instanceof SearchInputError) throw badRequest(e.message);
    throw e;
  }
  let found;
  try {
    found = await fn.search(target.from, where, PAGE, target.props);
  } catch (e) {
    if (e instanceof ContentStoreUnavailableError) throw new ApiError(503, 'CONTENT_STORE_UNAVAILABLE', (e as Error).message);
    throw e;
  }
  const refs = found.documents.map((d) => `filenet:${fn.config.objectStore}:${d.id}`);
  const rows = refs.length
    ? await ctx.db.query<DocumentRow & { tender_number: string | null }>(
      `SELECT d.*, t.tender_number FROM documents d LEFT JOIN tenders t ON t.id=d.tender_id WHERE d.tenant_id=$1 AND d.store_ref = ANY($2::text[])`, [a.tenantId, refs])
    : [];
  const byRef = new Map(rows.map((r) => [r.store_ref, r]));
  const results = [];
  for (const hit of found.documents) {
    const row = byRef.get(`filenet:${fn.config.objectStore}:${hit.id}`);
    if (!row) continue; // not a TenderFlow document of this entity
    try { await loadForEvidence(ctx, a, row.id); } catch (e) { if (e instanceof ApiError) continue; throw e; }
    results.push({
      documentId: row.id, title: row.title, ownerType: row.owner_type, tenderId: row.tender_id, tenderNumber: row.tender_number ?? null,
      versionNo: row.version_no ?? 1, createdAt: row.created_at, encrypted: row.encrypted, storeType: row.store_type,
      isRecord: !!row.is_record, recordDeclaredAt: row.record_declared_at ?? null, supersedesId: row.supersedes_id ?? null,
      objectId: hit.id, className: hit.className, name: hit.name,
      repositoryVersion: typeof hit.majorVersionNumber === 'number' ? `${hit.majorVersionNumber}.${hit.minorVersionNumber ?? 0}` : null,
      properties: hit.properties,
    });
  }
  return {
    from: target.from, vocabulary: target.vocabulary, where, results,
    repositoryHits: found.documents.length, hidden: found.documents.length - results.length, more: found.more,
  };
}
