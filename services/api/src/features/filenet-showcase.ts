// FileNet showcase: per-document repository evidence (object, class, version chain, record status, Navigator link)
// and the FileNet health page (connection, class, folder tree, counts, operation telemetry, latest verify report).
// Owned by the FileNet workstream. Read-only: nothing here writes to the database or the repository.
import fs from 'node:fs';
import path from 'node:path';
import type express from 'express';
import type { Ctx } from '../ctx.js';
import { hasRole, isStaff } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import { REPO_ROOT } from '../config.js';
import { h, actor, requireRoles } from '../routes.js';
import { ApiError, forbidden, isUuid, notFound } from '../util.js';
import { loadReadableDocument, type DocumentRow } from '../services/documents.js';
import { financialSealed, loadBid } from '../services/bids.js';
import type { TenderRow } from '../services/tenders.js';
import type { ContentStore, FolderNode, RepositoryDescription, TelemetryEntry } from '../content/types.js';
import { FileNetStore } from '../content/filenet-store.js';
import { navigatorConfig, navigatorUrl } from '../content/navigator.js';

/** Same roles as services/bids.ts BID_READERS (who may read opened bids). */
const BID_READERS = ['COMMITTEE_CHAIR', 'EVALUATOR', 'DIRECTOR', 'UNDERSECRETARY'];
const MAX_CHAIN = 50;

export function registerFileNetShowcaseRoutes(r: express.Router, ctx: Ctx): void {
  r.get('/documents/:id/evidence', h((req) => documentEvidence(ctx, actor(req), req.params.id)));
  r.get('/filenet/health', requireRoles('TENANT_ADMIN', 'AUDITOR'), h((req) => fileNetHealth(ctx, actor(req))));
}

const innerStore = (s: ContentStore): ContentStore => (s.unwrap ? s.unwrap() : s);

/**
 * Loads a document the actor may read, with the same rules as the download routes:
 * GET /documents/:id for non-bid documents; GET /bids/:id/documents/:docId for BID_* (owner vendor, or
 * chair/evaluators/director/undersecretary after opening, financial envelope only once opened).
 */
async function loadForEvidence(ctx: Ctx, a: Actor, id: string): Promise<DocumentRow> {
  if (!isUuid(id)) throw notFound('Document');
  const row = (await ctx.db.query<DocumentRow>('SELECT * FROM documents WHERE id=$1 AND tenant_id=$2', [id, a.tenantId]))[0];
  if (!row) throw notFound('Document');
  if (!row.owner_type.startsWith('BID_')) return loadReadableDocument(ctx, a, id);
  if (!row.bid_id) throw notFound('Document');
  const bid = await loadBid(ctx, a.tenantId, row.bid_id);
  const isOwner = !!a.vendorId && a.vendorId === bid.vendor_id;
  if (!isOwner) {
    if (!isStaff(a)) throw notFound('Document');
    if (!hasRole(a, ...BID_READERS)) throw forbidden('Only the committee chair, evaluators and the director may read opened bids');
    if (bid.status !== 'OPENED') throw new ApiError(403, 'BID_SEALED', 'Bid is sealed until the opening ceremony');
    if (row.owner_type === 'BID_FINANCIAL') {
      const t = (await ctx.db.query<TenderRow>('SELECT * FROM tenders WHERE id=$1', [bid.tender_id]))[0];
      if (financialSealed(t, bid)) throw new ApiError(403, 'FINANCIAL_SEALED', 'The financial envelope stays sealed until the chair opens it for bids that passed the technical evaluation');
    }
  }
  return row;
}

/** Version chain kept by TenderFlow (documents.supersedes_id / version_no), oldest first. */
async function versionChain(ctx: Ctx, d: DocumentRow) {
  const cols = 'id, title, version_no, supersedes_id, store_ref, store_type, store_meta, sha256_plain, created_at, is_record';
  const byId = async (id: string) => (await ctx.db.query<any>(`SELECT ${cols} FROM documents WHERE id=$1 AND tenant_id=$2`, [id, d.tenant_id]))[0];
  const back: any[] = [];
  let cur: any = await byId(d.id);
  const seen = new Set<string>();
  while (cur && back.length < MAX_CHAIN && !seen.has(cur.id)) {
    seen.add(cur.id);
    back.unshift(cur);
    cur = cur.supersedes_id ? await byId(cur.supersedes_id) : null;
  }
  let tip = back[back.length - 1];
  const forward: any[] = [];
  while (tip && forward.length + back.length < MAX_CHAIN) {
    const next = (await ctx.db.query<any>(`SELECT ${cols} FROM documents WHERE supersedes_id=$1 AND tenant_id=$2 ORDER BY created_at LIMIT 1`, [tip.id, d.tenant_id]))[0];
    if (!next || seen.has(next.id)) break;
    seen.add(next.id);
    forward.push(next);
    tip = next;
  }
  const all = [...back, ...forward];
  return all.map((v, i) => ({
    id: v.id, title: v.title, versionNo: v.version_no ?? 1, createdAt: v.created_at, sha256: v.sha256_plain,
    objectId: v.store_meta?.objectId ?? null, repositoryVersion: v.store_meta?.versionLabel ?? null,
    isRecord: !!v.is_record, isThis: v.id === d.id, isLatest: i === all.length - 1,
    repositoryVersioning: v.store_meta?.repositoryVersioning === true,
  }));
}

export async function documentEvidence(ctx: Ctx, a: Actor, id: string) {
  const d = await loadForEvidence(ctx, a, id);
  const meta = (d.store_meta ?? {}) as Record<string, any>;
  let repository: RepositoryDescription | { error: string } | null = null;
  if (ctx.store.describe) {
    try { repository = await ctx.store.describe(d.store_ref); } catch (e) { repository = { error: String((e as Error)?.message ?? e).slice(0, 1000) }; }
  } else {
    repository = { error: `content store '${ctx.store.type}' cannot describe stored objects` };
  }
  const desc = repository && !('error' in repository) ? repository : null;
  const isFileNet = d.store_type === 'filenet';
  const ref = /^filenet:([^:]+):(.+)$/.exec(d.store_ref);
  const versions = await versionChain(ctx, d);
  return {
    documentId: d.id,
    title: d.title,
    ownerType: d.owner_type,
    mimeType: d.mime_type,
    byteSize: d.byte_size,
    createdAt: d.created_at,
    storeType: d.store_type,
    storeRef: d.store_ref,
    objectStore: isFileNet ? (meta.objectStore ?? desc?.objectStore ?? ref?.[1] ?? null) : null,
    objectId: isFileNet ? (meta.objectId ?? desc?.id ?? ref?.[2] ?? null) : null,
    className: isFileNet ? (desc?.className ?? meta.className ?? null) : null,
    folderPath: meta.folderPath ?? desc?.folders?.[0] ?? null,
    versionNo: d.version_no ?? 1,
    supersedesId: d.supersedes_id ?? null,
    versions,
    /** True when any version in the chain was checked in as a FileNet version (FILENET_VERSIONING=true at upload). */
    repositoryVersioning: versions.some((v) => v.repositoryVersioning),
    isRecord: !!d.is_record,
    recordDeclaredAt: d.record_declared_at ?? null,
    record: meta.record ?? null,
    encrypted: d.encrypted,
    encryptionNote: d.encrypted ? 'ciphertext in FileNet; key held by TenderFlow' : null,
    sha256: d.sha256_plain,
    repository,
    navigatorUrl: isFileNet && desc ? navigatorUrl(navigatorConfig(), desc) : null,
  };
}

// ---------------------------------------------------------------- health

const one = async (ctx: Ctx, sql: string, params: unknown[]) => Number((await ctx.db.query<{ n: string }>(sql, params))[0]?.n ?? 0);

/** Telemetry entries that belong to this tenant (by known storeRef or by tenant folder); others are not shown. */
async function tenantTelemetry(ctx: Ctx, tenantId: string, limit: number): Promise<TelemetryEntry[]> {
  const all = ctx.store.telemetry ? ctx.store.telemetry() : [];
  const refs = [...new Set(all.map((e) => e.ref).filter((x): x is string => !!x))];
  const mine = new Set<string>();
  if (refs.length) {
    const ph = refs.map((_, i) => `$${i + 2}`).join(',');
    for (const row of await ctx.db.query<{ store_ref: string }>(`SELECT store_ref FROM documents WHERE tenant_id=$1 AND store_ref IN (${ph})`, [tenantId, ...refs])) mine.add(row.store_ref);
  }
  const folderPrefix = `/${tenantId}/`;
  return all.filter((e) => (e.ref && mine.has(e.ref)) || (!!e.folder && (e.folder + '/').startsWith(folderPrefix))).slice(0, limit);
}

/** Newest docs/evidence/filenet-verify-*.json, summarised (the report files never contain secrets). */
function latestVerifyReport() {
  const dir = process.env.TF_EVIDENCE_DIR || path.join(REPO_ROOT, 'docs', 'evidence');
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => /^filenet-verify-.*\.json$/.test(f)).sort(); } catch { return null; }
  const file = files[files.length - 1];
  if (!file) return null;
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const cfg = { ...(r.config ?? {}) };
    delete cfg.FILENET_SERVICE_PASSWORD;
    return {
      file, startedAt: r.startedAt ?? null, finishedAt: r.finishedAt ?? null, ok: r.ok === true, config: cfg,
      steps: (Array.isArray(r.steps) ? r.steps : []).map((s: any) => ({ step: s.step, name: s.name, ok: !!s.ok, ms: s.ms ?? null, error: s.error ? String(s.error).slice(0, 500) : undefined })),
      documents: Array.isArray(r.documents) ? r.documents.map((d: any) => ({ label: d.label, id: d.id, className: d.className, version: d.version, byteSize: d.byteSize, sha256: d.sha256 })) : [],
    };
  } catch (e) {
    return { file, error: `report is not readable JSON: ${(e as Error).message}` };
  }
}

export async function fileNetHealth(ctx: Ctx, a: Actor) {
  const store = innerStore(ctx.store);
  const fn = store instanceof FileNetStore ? store : null;
  const nav = navigatorConfig();
  const config = fn
    ? {
        type: 'filenet' as const,
        endpointHost: new URL(fn.config.graphqlUrl).host,
        endpointTls: new URL(fn.config.graphqlUrl).protocol === 'https:',
        objectStore: fn.config.objectStore,
        rootFolder: fn.config.rootFolder,
        docClass: fn.config.docClass,
        setCustomProperties: fn.config.setCustomProperties,
        versioning: fn.config.versioning,
        recordsMode: fn.config.recordsMode,
        retentionDays: fn.config.retentionDays,
        navigator: nav ? { configured: true, host: new URL(nav.baseUrl).host, desktop: nav.desktop, repositoryId: nav.repositoryId } : { configured: false },
      }
    : { type: store.type, navigator: { configured: false } };

  let ping: { ok: boolean; detail: string };
  try { ping = await ctx.store.ping(); } catch (e) { ping = { ok: false, detail: (e as Error).message }; }

  let tfClass: { name: string; exists: boolean | null; error?: string; applicable: boolean } = { name: 'TF_Document', exists: null, applicable: !!fn };
  if (fn && ping.ok) {
    try { tfClass.exists = await fn.classExists('TF_Document'); } catch (e) { tfClass = { ...tfClass, error: (e as Error).message.slice(0, 500) }; }
  }

  const rootLabel = fn ? `${fn.config.rootFolder}/${a.tenantId}` : `/${a.tenantId}`;
  let folders: { root: string; tree: FolderNode | null; error?: string } = { root: rootLabel, tree: null };
  if (store.folderTree && ping.ok) {
    try { folders.tree = await store.folderTree(`/${a.tenantId}`, 2); } catch (e) { folders = { ...folders, error: (e as Error).message.slice(0, 500) }; }
  }

  const t = a.tenantId;
  const byStoreType = (await ctx.db.query<any>('SELECT store_type, count(*)::text AS n FROM documents WHERE tenant_id=$1 GROUP BY store_type ORDER BY store_type', [t]))
    .map((x) => ({ storeType: x.store_type, count: Number(x.n) }));
  const byOwnerType = (await ctx.db.query<any>('SELECT owner_type, store_type, count(*)::text AS n FROM documents WHERE tenant_id=$1 GROUP BY owner_type, store_type ORDER BY owner_type, store_type', [t]))
    .map((x) => ({ ownerType: x.owner_type, storeType: x.store_type, count: Number(x.n) }));
  const counts = {
    total: await one(ctx, 'SELECT count(*)::text AS n FROM documents WHERE tenant_id=$1', [t]),
    records: await one(ctx, 'SELECT count(*)::text AS n FROM documents WHERE tenant_id=$1 AND is_record', [t]),
    recordsInRepository: await one(ctx, `SELECT count(*)::text AS n FROM documents WHERE tenant_id=$1 AND is_record AND (store_meta->'record'->>'repository') = 'true'`, [t]),
    newerVersions: await one(ctx, 'SELECT count(*)::text AS n FROM documents WHERE tenant_id=$1 AND version_no > 1', [t]),
    encrypted: await one(ctx, 'SELECT count(*)::text AS n FROM documents WHERE tenant_id=$1 AND encrypted', [t]),
    byStoreType, byOwnerType,
  };

  return {
    storeType: store.type,
    checkedAt: new Date().toISOString(),
    config,
    ping,
    tfClass,
    folders,
    counts,
    operations: await tenantTelemetry(ctx, t, 50),
    verifyReport: latestVerifyReport(),
  };
}
