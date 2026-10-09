// Auditor evidence pack: one ZIP per tender (or per date range) that an external auditor can verify offline.
//   manifest.json      — scope, entity, who/when generated, every document (FileNet object id / store ref, version,
//                        SHA-256, record status) and whether its bytes are in the pack (and if not, why)
//   audit-events.json  — the slice of the HMAC-chained audit log + the chain verification result at generation time
//   approvals.json     — approval-chain decisions (request, publication, award) with the configured chain
//   tender.json        — tender, publications, purchases (receipts), bids (status + receipt hash; never keys), opening, award
//   documents/…        — the non-sealed documents (pack, addenda, notices, opening records, committee report, …)
//   bids/…             — bid documents ONLY after the opening (financial envelope only once opened); never before
//   SHA256SUMS         — `sha256sum -c SHA256SUMS` checks every file in the pack
//   README.txt         — how to verify
// The ZIP is itself stored as an EVIDENCE_PACK document through putDocument (so it lands in FileNet) and the
// generation is audited (EVIDENCE_PACK_GENERATED) in the same transaction as the document row.
import type { Ctx } from '../../ctx.js';
import { auditTx } from '../../ctx.js';
import type { Actor } from '../../auth/tokens.js';
import { ApiError, badRequest, camel, isUuid, notFound, now, sha256Hex, uuid } from '../../util.js';
import { insertDocument, putDocument, readPlain, readSealed, type DocumentRow } from '../../services/documents.js';
import { financialSealed, type BidRow } from '../../services/bids.js';
import { publicTender, approvalChainView, type TenderRow } from '../../services/tenders.js';
import { configOf, DEFAULT_CONFIG, getProfile, type CycleConfig } from '../../services/templates.js';
import { verifyAudit } from '../../services/audit.js';
import { unwrapKey } from '../../services/vault.js';
import { buildZip, type ZipEntry } from './zip.js';

export const PACK_FORMAT = 'tenderflow-evidence-pack/1';
/** Upper bound of document bytes put in one pack (the ZIP is stored and downloaded in one piece). */
export const MAX_PACK_BYTES = 150 * 1024 * 1024;
const MAX_RANGE_DAYS = 366;

const EXT: Record<string, string> = {
  'text/markdown': '.md', 'text/plain': '.txt', 'text/html': '.html', 'application/pdf': '.pdf', 'image/png': '.png',
  'image/jpeg': '.jpg', 'application/json': '.json', 'application/zip': '.zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};
const safe = (s: string, max = 60) => (s.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/_+/g, '_').replace(/^[._]+/, '').slice(0, max) || 'file');
function fileName(d: DocumentRow) {
  const ext = EXT[d.mime_type] ?? '';
  const base = safe(d.title.replace(/\.[A-Za-z0-9]{1,5}$/, ''));
  return `${d.id.slice(0, 8)}-${base}${ext}`;
}

export type Scope = { type: 'TENDER'; tenderId: string } | { type: 'RANGE'; from: Date; to: Date };

export function parseScope(b: any): Scope {
  if (b?.tenderId !== undefined && b?.tenderId !== null && b?.tenderId !== '') {
    if (!isUuid(b.tenderId)) throw notFound('Tender');
    return { type: 'TENDER', tenderId: b.tenderId };
  }
  const d = (v: unknown, end: boolean) => {
    if (typeof v !== 'string' || !v) return null;
    const x = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T${end ? '23:59:59.999' : '00:00:00.000'}+03:00`) : new Date(v);
    return Number.isNaN(x.getTime()) ? null : x;
  };
  const from = d(b?.from, false);
  const to = d(b?.to, true);
  if (!from || !to) throw badRequest('Give either tenderId, or from and to (YYYY-MM-DD, Kuwait time)');
  if (to < from) throw badRequest('to must not be before from');
  if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_RANGE_DAYS) throw badRequest(`A date-range pack covers at most ${MAX_RANGE_DAYS} days`);
  return { type: 'RANGE', from, to };
}

interface ManifestDoc {
  documentId: string; ownerType: string; title: string; mimeType: string; byteSize: number; sha256: string;
  versionNo: number; supersedesId: string | null; tenderId: string | null; bidId: string | null; vendor: string | null;
  storeType: string; storeRef: string; objectStore: string | null; objectId: string | null; folderPath: string | null;
  isRecord: boolean; recordDeclaredAt: string | null; recordInRepository: boolean | null; encryptedAtRest: boolean;
  createdAt: string; included: boolean; path: string | null; exclusionReason: string | null; integrity: 'VERIFIED' | 'MISMATCH' | 'NOT_READ';
}

const isoOf = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

async function requestChain(ctx: Ctx, tenantId: string): Promise<CycleConfig['approvals']['request']> {
  const r = await ctx.db.query<{ config: CycleConfig }>(
    `SELECT config FROM cycle_templates WHERE tenant_id=$1 AND status='PUBLISHED' AND is_default LIMIT 1`, [tenantId]);
  return r[0]?.config?.approvals?.request ?? DEFAULT_CONFIG.approvals.request;
}

export async function generateEvidencePack(ctx: Ctx, actor: Actor, body: any) {
  const scope = parseScope(body);
  const tenantId = actor.tenantId;
  const entity = await getProfile(ctx, tenantId);
  const generatedAt = now();
  const packId = uuid();

  // ---------------------------------------------------------------- scope → rows
  let tender: TenderRow | null = null;
  let docs: DocumentRow[];
  let tenders: TenderRow[];
  let requestId: string | null = null;
  if (scope.type === 'TENDER') {
    tender = (await ctx.db.query<TenderRow>('SELECT * FROM tenders WHERE id=$1 AND tenant_id=$2', [scope.tenderId, tenantId]))[0] ?? null;
    if (!tender) throw notFound('Tender');
    tenders = [tender];
    requestId = tender.request_id ?? null;
    const letter = requestId
      ? (await ctx.db.query<{ letter_document_id: string | null }>('SELECT letter_document_id FROM procurement_requests WHERE id=$1 AND tenant_id=$2', [requestId, tenantId]))[0]?.letter_document_id ?? null
      : null;
    docs = await ctx.db.query<DocumentRow>(
      `SELECT * FROM documents WHERE tenant_id=$1 AND owner_type <> 'EVIDENCE_PACK' AND (tender_id=$2 OR id=$3::uuid) ORDER BY created_at, id`,
      [tenantId, tender.id, letter]);
  } else {
    docs = await ctx.db.query<DocumentRow>(
      `SELECT * FROM documents WHERE tenant_id=$1 AND owner_type <> 'EVIDENCE_PACK' AND created_at >= $2 AND created_at <= $3 ORDER BY created_at, id`,
      [tenantId, scope.from, scope.to]);
    const tids = [...new Set(docs.map((d) => d.tender_id).filter((x): x is string => !!x))];
    const touched = await ctx.db.query<{ resource_id: string }>(
      `SELECT DISTINCT resource_id FROM audit_events WHERE tenant_id=$1 AND resource_type='TENDER' AND at >= $2 AND at <= $3 AND resource_id IS NOT NULL`,
      [tenantId, scope.from, scope.to]);
    for (const x of touched) if (isUuid(x.resource_id) && !tids.includes(x.resource_id)) tids.push(x.resource_id);
    tenders = tids.length ? await ctx.db.query<TenderRow>('SELECT * FROM tenders WHERE tenant_id=$1 AND id = ANY($2::uuid[]) ORDER BY created_at', [tenantId, tids]) : [];
  }
  const tenderById = new Map(tenders.map((t) => [t.id, t]));
  const tenderIds = tenders.map((t) => t.id);

  const bids = tenderIds.length ? await ctx.db.query<BidRow & { legal_name_en: string; legal_name_ar: string }>(
    `SELECT b.*, v.legal_name_en, v.legal_name_ar FROM bids b JOIN vendors v ON v.id=b.vendor_id
      WHERE b.tenant_id=$1 AND b.tender_id = ANY($2::uuid[]) ORDER BY b.submitted_at`, [tenantId, tenderIds]) : [];
  // Range scope: bid documents of tenders outside the touched set still need their bid row for the sealing rule.
  const extraBidIds = docs.map((d) => d.bid_id).filter((x): x is string => !!x && !bids.some((b) => b.id === x));
  if (extraBidIds.length) {
    bids.push(...await ctx.db.query<any>(`SELECT b.*, v.legal_name_en, v.legal_name_ar FROM bids b JOIN vendors v ON v.id=b.vendor_id
      WHERE b.tenant_id=$1 AND b.id = ANY($2::uuid[])`, [tenantId, extraBidIds]));
    for (const b of bids) if (!tenderById.has(b.tender_id)) {
      const t = (await ctx.db.query<TenderRow>('SELECT * FROM tenders WHERE id=$1 AND tenant_id=$2', [b.tender_id, tenantId]))[0];
      if (t) tenderById.set(t.id, t);
    }
  }
  const bidById = new Map(bids.map((b) => [b.id, b]));

  // ---------------------------------------------------------------- documents
  const entries: ZipEntry[] = [];
  const manifestDocs: ManifestDoc[] = [];
  let totalBytes = 0;
  const usedPaths = new Set<string>();
  for (const d of docs) {
    const meta = (d.store_meta ?? {}) as Record<string, any>;
    const fnRef = /^filenet:([^:]+):(.+)$/.exec(d.store_ref);
    const bid = d.bid_id ? bidById.get(d.bid_id) ?? null : null;
    const m: ManifestDoc = {
      documentId: d.id, ownerType: d.owner_type, title: d.title, mimeType: d.mime_type, byteSize: d.byte_size, sha256: d.sha256_plain,
      versionNo: d.version_no ?? 1, supersedesId: d.supersedes_id ?? null, tenderId: d.tender_id, bidId: d.bid_id,
      vendor: bid ? `${bid.legal_name_en} / ${bid.legal_name_ar}` : null,
      storeType: d.store_type, storeRef: d.store_ref,
      objectStore: d.store_type === 'filenet' ? (meta.objectStore ?? fnRef?.[1] ?? null) : null,
      objectId: d.store_type === 'filenet' ? (meta.objectId ?? fnRef?.[2] ?? null) : null,
      folderPath: meta.folderPath ?? null,
      isRecord: !!d.is_record, recordDeclaredAt: isoOf(d.record_declared_at),
      recordInRepository: meta.record ? meta.record.repository === true : null,
      encryptedAtRest: !!d.encrypted, createdAt: isoOf(d.created_at)!,
      included: false, path: null, exclusionReason: null, integrity: 'NOT_READ',
    };
    let bytes: Buffer | null = null;
    try {
      if (d.owner_type.startsWith('BID_')) {
        const t = bid ? tenderById.get(bid.tender_id) : undefined;
        if (!bid || !t) m.exclusionReason = 'BID_NOT_FOUND';
        else if (bid.status !== 'OPENED') m.exclusionReason = 'SEALED_UNTIL_OPENING';
        else if (d.owner_type === 'BID_FINANCIAL' && financialSealed(t, bid)) m.exclusionReason = 'FINANCIAL_ENVELOPE_SEALED';
        else {
          const key = unwrapKey(ctx.config.bidMasterKey, bid);
          try { bytes = await readSealed(ctx, d, key); } finally { key.fill(0); }
        }
      } else if (d.encrypted) {
        m.exclusionReason = 'ENCRYPTED';
      } else {
        bytes = await readPlain(ctx, d);
      }
    } catch (err) {
      const code = (err as ApiError)?.code;
      if (code === 'CONTENT_STORE_UNAVAILABLE') throw err; // no partial packs when the repository is down
      if (code === 'INTEGRITY_ERROR') { m.integrity = 'MISMATCH'; m.exclusionReason = 'HASH_MISMATCH'; }
      else m.exclusionReason = `READ_FAILED: ${String((err as Error)?.message ?? err).slice(0, 200)}`;
      bytes = null;
    }
    if (bytes) {
      totalBytes += bytes.length;
      if (totalBytes > MAX_PACK_BYTES) throw new ApiError(413, 'PACK_TOO_LARGE', `The documents in scope exceed ${MAX_PACK_BYTES / 1024 / 1024} MB; choose a narrower scope`);
      const dir = d.owner_type.startsWith('BID_')
        ? `bids/${safe(bid!.legal_name_en, 40)}-${bid!.id.slice(0, 8)}`
        : `documents/${d.owner_type}`;
      let p = `${dir}/${fileName(d)}`;
      for (let i = 2; usedPaths.has(p); i++) p = `${dir}/${i}-${fileName(d)}`;
      usedPaths.add(p);
      entries.push({ name: p, data: bytes, date: new Date(d.created_at) });
      m.included = true; m.path = p; m.integrity = 'VERIFIED';
    }
    manifestDocs.push(m);
  }

  // ---------------------------------------------------------------- related ids → audit slice
  const relIds = new Set<string>([...tenderIds, ...docs.map((d) => d.id), ...bids.map((b) => b.id)]);
  if (requestId) relIds.add(requestId);
  if (tenderIds.length) {
    for (const [sql] of [
      ['SELECT id FROM clarifications WHERE tenant_id=$1 AND tender_id = ANY($2::uuid[])'],
      ['SELECT id FROM publications WHERE tenant_id=$1 AND tender_id = ANY($2::uuid[])'],
      ['SELECT id FROM awards WHERE tenant_id=$1 AND tender_id = ANY($2::uuid[])'],
      ['SELECT id FROM openings WHERE tenant_id=$1 AND tender_id = ANY($2::uuid[])'],
      ['SELECT id FROM ai_runs WHERE tenant_id=$1 AND tender_id = ANY($2::uuid[])'],
      ['SELECT id FROM tender_purchases WHERE tenant_id=$1 AND tender_id = ANY($2::uuid[])'],
    ]) for (const r of await ctx.db.query<{ id: string }>(sql, [tenantId, tenderIds])) relIds.add(r.id);
  }
  const ids = [...relIds];
  const cols = `seq::text AS seq, id, actor_id, actor_roles, action, resource_type, resource_id, prev_state, new_state, reason, details, at, prev_hmac, hmac`;
  const events = scope.type === 'TENDER'
    ? await ctx.db.query<any>(
      `SELECT ${cols} FROM audit_events WHERE tenant_id=$1 AND (resource_id = ANY($2::text[]) OR details->>'tenderId' = ANY($2::text[])
         OR details->>'documentId' = ANY($2::text[]) OR details->>'subjectId' = ANY($2::text[])) ORDER BY seq`, [tenantId, ids])
    : await ctx.db.query<any>(`SELECT ${cols} FROM audit_events WHERE tenant_id=$1 AND at >= $2 AND at <= $3 ORDER BY seq`, [tenantId, scope.from, scope.to]);
  const chain = await verifyAudit(ctx.db, ctx.config.auditSigningKey, tenantId);
  const head = (await ctx.db.query<{ seq: string; hmac: string }>('SELECT seq::text AS seq, hmac FROM audit_events WHERE tenant_id=$1 ORDER BY seq DESC LIMIT 1', [tenantId]))[0];
  const auditJson = {
    chainVerification: {
      verifiedAt: generatedAt.toISOString(), algorithm: 'HMAC-SHA256 over canonical JSON, chained per entity (hmac = HMAC(key, prev_hmac | payload))',
      valid: chain.valid, eventsInChain: chain.count, brokenAt: chain.brokenAt ?? null, reason: chain.reason ?? null,
      chainHead: head ? { seq: Number(head.seq), hmac: head.hmac } : null,
    },
    slice: { scope: scope.type, events: events.length, firstSeq: events[0] ? Number(events[0].seq) : null, lastSeq: events.length ? Number(events[events.length - 1].seq) : null },
    events: events.map((e) => ({ ...camel<any>({ ...e, details: undefined }), details: e.details, seq: Number(e.seq), at: isoOf(e.at) })),
  };

  // ---------------------------------------------------------------- approvals
  const subjectIds = [...tenderIds, ...(requestId ? [requestId] : [])];
  const approvals = subjectIds.length || scope.type === 'RANGE' ? await ctx.db.query<any>(
    `SELECT a.id, a.subject_type, a.subject_id, a.gate, a.level, a.role, a.approver_id, u.display_name AS approver_name, a.decision, a.reason, a.round, a.decided_at
       FROM approvals a LEFT JOIN users u ON u.id=a.approver_id
      WHERE a.tenant_id=$1 AND ${scope.type === 'TENDER' ? 'a.subject_id = ANY($2::uuid[])' : 'a.decided_at >= $2 AND a.decided_at <= $3'}
      ORDER BY a.decided_at, a.level`, scope.type === 'TENDER' ? [tenantId, subjectIds] : [tenantId, scope.from, scope.to]) : [];
  const chains: any[] = [];
  for (const t of tenders) {
    const cfg = configOf(t);
    chains.push({ subjectType: 'TENDER', subjectId: t.id, tenderNumber: t.tender_number, gate: 'PUBLISH', levels: await approvalChainView(ctx.db, t.id, 'PUBLISH', cfg.approvals.publish) });
    const aw = (await ctx.db.query<any>('SELECT created_at FROM awards WHERE tender_id=$1', [t.id]))[0];
    if (aw) chains.push({ subjectType: 'TENDER', subjectId: t.id, tenderNumber: t.tender_number, gate: 'AWARD', levels: await approvalChainView(ctx.db, t.id, 'AWARD', cfg.approvals.award, new Date(aw.created_at)) });
  }
  if (requestId) chains.push({ subjectType: 'REQUEST', subjectId: requestId, gate: 'REQUEST', levels: await approvalChainView(ctx.db, requestId, 'REQUEST', await requestChain(ctx, tenantId)) });
  const approvalsJson = { decisions: camel(approvals.map((a) => ({ ...a, decided_at: isoOf(a.decided_at) }))), chains };

  // ---------------------------------------------------------------- tender.json
  const tenderInfo = [];
  for (const t of tenders) {
    const pub = publicTender(t);
    tenderInfo.push({
      tender: { ...pub, eligibility: t.eligibility ?? {}, template: pub.template },
      publications: camel(await ctx.db.query('SELECT channel, status, reference, published_on, document_id, created_at FROM publications WHERE tender_id=$1 ORDER BY channel', [t.id])),
      purchases: camel(await ctx.db.query(
        `SELECT p.receipt_number, p.amount, p.currency, p.gateway, p.status, p.paid_at, v.legal_name_en AS vendor_en, v.legal_name_ar AS vendor_ar,
                (p.gateway = 'TEST') AS test_payment
           FROM tender_purchases p JOIN vendors v ON v.id=p.vendor_id WHERE p.tender_id=$1 ORDER BY p.paid_at`, [t.id])),
      bids: bids.filter((b) => b.tender_id === t.id).map((b) => ({
        bidId: b.id, vendorEn: b.legal_name_en, vendorAr: b.legal_name_ar, status: b.status, submittedAt: isoOf(b.submitted_at),
        openedAt: isoOf(b.opened_at), receiptSha256: b.receipt_sha256, technicalResult: b.technical_result ?? null,
        technicalScore: b.technical_score === null || b.technical_score === undefined ? null : Number(b.technical_score),
        financialOpenedAt: isoOf(b.financial_opened_at), financialSealed: financialSealed(t, b),
      })),
      opening: camel((await ctx.db.query('SELECT id, chair_id, attendees, notes, record_document_id, opened_at FROM openings WHERE tender_id=$1', [t.id]))[0] ?? null),
      award: camel((await ctx.db.query('SELECT id, bid_id, recommended_by, justification, approved_by, status, report_document_id, created_at, approved_at FROM awards WHERE tender_id=$1', [t.id]))[0] ?? null),
      clarifications: camel(await ctx.db.query('SELECT id, question, language, answer, status, created_at, answered_at FROM clarifications WHERE tender_id=$1 ORDER BY created_at', [t.id])),
    });
  }

  // ---------------------------------------------------------------- assemble
  const json = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2) + '\n', 'utf8');
  const label = tender ? tender.tender_number : `${scope.type === 'RANGE' ? scope.from.toISOString().slice(0, 10) : ''}_${scope.type === 'RANGE' ? scope.to.toISOString().slice(0, 10) : ''}`;
  entries.push({ name: 'audit-events.json', data: json(auditJson), date: generatedAt });
  entries.push({ name: 'approvals.json', data: json(approvalsJson), date: generatedAt });
  entries.push({ name: scope.type === 'TENDER' ? 'tender.json' : 'tenders.json', data: json(scope.type === 'TENDER' ? tenderInfo[0] : tenderInfo), date: generatedAt });
  entries.push({ name: 'README.txt', data: Buffer.from(readme(label, entity.nameEn), 'utf8'), date: generatedAt });
  const files = entries.map((e) => ({ path: e.name, sha256: sha256Hex(e.data), byteSize: e.data.length }));
  const manifest = {
    format: PACK_FORMAT,
    packId,
    scope: scope.type === 'TENDER'
      ? { type: 'TENDER', tenderId: tender!.id, tenderNumber: tender!.tender_number, titleEn: tender!.title_en, titleAr: tender!.title_ar, status: tender!.status }
      : { type: 'RANGE', from: scope.from.toISOString(), to: scope.to.toISOString(), tenders: tenders.map((t) => t.tender_number) },
    entity: { id: tenantId, nameEn: entity.nameEn, nameAr: entity.nameAr },
    generatedAt: generatedAt.toISOString(),
    generatedBy: { id: actor.id, username: actor.username, roles: actor.roles },
    contentStore: ctx.store.type,
    auditChain: auditJson.chainVerification,
    documents: manifestDocs,
    summary: {
      documents: manifestDocs.length, included: manifestDocs.filter((d) => d.included).length,
      excluded: manifestDocs.filter((d) => !d.included).length,
      sealedBidDocumentsExcluded: manifestDocs.filter((d) => d.exclusionReason === 'SEALED_UNTIL_OPENING' || d.exclusionReason === 'FINANCIAL_ENVELOPE_SEALED').length,
      hashMismatches: manifestDocs.filter((d) => d.integrity === 'MISMATCH').length,
      auditEvents: events.length, approvals: approvals.length,
    },
    files,
  };
  const manifestBuf = json(manifest);
  entries.push({ name: 'manifest.json', data: manifestBuf, date: generatedAt });
  const sums = [...files, { path: 'manifest.json', sha256: sha256Hex(manifestBuf), byteSize: manifestBuf.length }]
    .map((f) => `${f.sha256}  ${f.path}`).join('\n') + '\n';
  entries.push({ name: 'SHA256SUMS', data: Buffer.from(sums, 'utf8'), date: generatedAt });
  const zip = buildZip(entries);

  // ---------------------------------------------------------------- store (FileNet) + audit
  const stamp = generatedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const prepared = await putDocument(ctx, {
    tenantId, ownerType: 'EVIDENCE_PACK' as any, ownerId: packId, tenderId: tender?.id ?? null, tenderNumber: tender?.tender_number ?? null,
    folderKey: 'evidence-packs', title: `Evidence pack ${label} ${stamp}`, fileName: `evidence-pack-${safe(label, 40)}-${stamp}.zip`,
    mimeType: 'application/zip', bytes: zip, uploadedBy: actor.id,
  });
  const row = await ctx.db.tx(async (q) => {
    const d = await insertDocument(q, prepared);
    await auditTx(ctx, q, {
      tenantId, actor, action: 'EVIDENCE_PACK_GENERATED', resourceType: tender ? 'TENDER' : 'EVIDENCE_PACK', resourceId: tender?.id ?? packId,
      details: {
        documentId: d.id, packId, sha256: d.sha256_plain, byteSize: d.byte_size, storeRef: d.store_ref, scope: manifest.scope,
        documentsIncluded: manifest.summary.included, documentsExcluded: manifest.summary.excluded,
        bidDocumentsIncluded: manifestDocs.filter((x) => x.included && x.ownerType.startsWith('BID_')).length,
        auditEvents: events.length, chainValid: chain.valid,
      },
    });
    return d;
  });
  return { ...packView(row, tender?.tender_number ?? null, actor.username), summary: manifest.summary, auditChain: { valid: chain.valid, count: chain.count, brokenAt: chain.brokenAt ?? null } };
}

function packView(d: DocumentRow & { tender_number?: string | null; generated_by_name?: string | null }, tenderNumber: string | null, by?: string | null) {
  const meta = (d.store_meta ?? {}) as Record<string, any>;
  return {
    documentId: d.id, title: d.title, tenderId: d.tender_id, tenderNumber: tenderNumber ?? d.tender_number ?? null,
    sha256: d.sha256_plain, byteSize: d.byte_size, storeType: d.store_type,
    objectId: d.store_type === 'filenet' ? (meta.objectId ?? null) : null, folderPath: meta.folderPath ?? null,
    createdAt: d.created_at, generatedBy: by ?? d.generated_by_name ?? null,
    downloadUrl: `/api/v1/audit/evidence-packs/${d.id}/download`,
  };
}

export async function listEvidencePacks(ctx: Ctx, actor: Actor, tenderId?: unknown) {
  const tid = typeof tenderId === 'string' && isUuid(tenderId) ? tenderId : null;
  const rows = await ctx.db.query<any>(
    `SELECT d.*, t.tender_number, u.display_name AS generated_by_name FROM documents d
       LEFT JOIN tenders t ON t.id=d.tender_id LEFT JOIN users u ON u.id=d.uploaded_by
      WHERE d.tenant_id=$1 AND d.owner_type='EVIDENCE_PACK' AND ($2::uuid IS NULL OR d.tender_id=$2) ORDER BY d.created_at DESC LIMIT 100`,
    [actor.tenantId, tid]);
  return rows.map((r) => packView(r, r.tender_number));
}

export async function downloadEvidencePack(ctx: Ctx, actor: Actor, id: string) {
  if (!isUuid(id)) throw notFound('Evidence pack');
  const d = (await ctx.db.query<DocumentRow>(`SELECT * FROM documents WHERE id=$1 AND tenant_id=$2 AND owner_type='EVIDENCE_PACK'`, [id, actor.tenantId]))[0];
  if (!d) throw notFound('Evidence pack');
  const bytes = await readPlain(ctx, d);
  await ctx.db.tx((q) => auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'EVIDENCE_PACK_DOWNLOADED', resourceType: 'DOCUMENT', resourceId: d.id,
    details: { sha256: d.sha256_plain, tenderId: d.tender_id } }));
  return { doc: d, bytes };
}

function readme(label: string, entity: string): string {
  return `TenderFlow evidence pack — ${label} — ${entity}
=====================================================================

This archive was generated by TenderFlow for an auditor. It is also stored, unchanged, as an
EVIDENCE_PACK document in the entity's content store (IBM FileNet in production); its SHA-256 is
recorded in the audit event EVIDENCE_PACK_GENERATED.

Contents
--------
manifest.json      Scope, entity, who generated the pack and when, and EVERY document in scope with its
                   content-store reference (FileNet object store + object id, or the local store ref), version,
                   SHA-256 of the plain content, record status, and whether its bytes are included here.
                   "exclusionReason" says why a document is not included:
                     SEALED_UNTIL_OPENING       sealed bid: never leaves the vault before the opening ceremony
                     FINANCIAL_ENVELOPE_SEALED  two-envelope tender: financial envelope not opened (yet)
                     HASH_MISMATCH              stored bytes did not match the recorded SHA-256 (investigate)
audit-events.json  The audit-log events about this scope, each with prev_hmac and hmac, plus the result of
                   verifying the entity's whole HMAC chain at generation time ("chainVerification").
approvals.json     Every approval-chain decision (request, publication, award) and the configured chain.
tender.json        Tender, publications, document purchases (gateway TEST = simulated payment), bids
                   (status, receipt hash; never encryption keys), opening and award.
documents/         The non-sealed documents (tender pack, addenda, notices, opening records, committee report …).
bids/              Bid documents, only for bids that were opened (never before the opening).
SHA256SUMS         SHA-256 of every file in this archive.

How to verify
-------------
1. File integrity:   sha256sum -c SHA256SUMS          (Linux/macOS; on Windows: Get-FileHash -Algorithm SHA256)
2. Document hashes:  for every document with "included": true, the SHA-256 of the file at "path" equals
                     "sha256" in manifest.json, which is the hash TenderFlow recorded when the file was uploaded
                     (and, for bids, the hash in the vendor's submission receipt / BID_SUBMITTED audit event).
3. Repository:       look up "objectId" in the FileNet object store "objectStore" (IBM Content Navigator) and
                     compare its TF_Sha256 property with "sha256".
4. Audit chain:      "chainVerification.valid" is the server-side result. With the entity's audit signing key an
                     auditor can recompute each event: hmac = HMAC-SHA256(key, prev_hmac + "|" + canonical JSON of
                     {id, tenantId, actorId, actorRoles, action, resourceType, resourceId, prevState, newState,
                     reason, details, at}) with object keys sorted; prev_hmac must equal the previous event's hmac.
                     The event that records this pack's own generation is written after the pack is built.

دليل التحقق (عربي)
------------------
يحتوي هذا الأرشيف على أدلة المناقصة للمدقق: ملف manifest.json يسرد كل مستند ومرجعه في FileNet وبصمته SHA-256،
وسجل التدقيق المتسلسل (HMAC) مع نتيجة التحقق، وقرارات الاعتماد، والمستندات غير المختومة. لا تُضمَّن العطاءات
المختومة قبل جلسة الفتح أبداً. للتحقق من سلامة الملفات: sha256sum -c SHA256SUMS
`;
}
