// Document storage through the ContentStore (plain or sealed) + deny-by-default generic download.
import type { Ctx } from '../ctx.js';
import { isStaff, isVendor } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import type { Queryable } from '../db.js';
import { ApiError, badRequest, isUuid, notFound, sha256Hex, uuid, now, camel } from '../util.js';
import { encrypt, decrypt } from './vault.js';
import { ContentStoreUnavailableError } from '../content/types.js';
import { vendorMayReadPack } from './vendor-lifecycle.js';

export interface UploadFile { originalname: string; mimetype: string; buffer: Buffer; size: number }

export interface DocumentRow {
  id: string; tenant_id: string; owner_type: string; owner_id: string; tender_id: string | null; vendor_id: string | null;
  bid_id: string | null; title: string; mime_type: string; byte_size: number; sha256_plain: string; store_type: string;
  store_ref: string; encrypted: boolean; enc_iv: string | null; enc_tag: string | null; uploaded_by: string | null; created_at: Date;
  supersedes_id?: string | null; version_no?: number; is_record?: boolean; record_declared_at?: Date | null; store_meta?: any;
}

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Determine the real type from magic bytes; only pdf, docx, txt/md, png, jpg are accepted. */
export function detectMime(file: UploadFile): string {
  const b = file.buffer;
  const name = file.originalname.toLowerCase();
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 4 && b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    if (name.endsWith('.docx') && b.includes(Buffer.from('word/'))) return DOCX;
    throw new ApiError(415, 'UNSUPPORTED_FILE_TYPE', 'Only .docx ZIP documents are accepted');
  }
  const textLike = /\.(txt|md|markdown)$/.test(name) || file.mimetype === 'text/plain' || file.mimetype === 'text/markdown';
  if (textLike && !b.includes(0)) {
    const s = b.toString('utf8');
    if (!s.includes('�')) return name.endsWith('.md') || name.endsWith('.markdown') ? 'text/markdown' : 'text/plain';
  }
  throw new ApiError(415, 'UNSUPPORTED_FILE_TYPE', 'Allowed file types: pdf, docx, txt, md, png, jpg');
}

export function validateUpload(file: UploadFile | undefined, field = 'file'): UploadFile & { detectedMime: string } {
  if (!file || !file.buffer) throw badRequest(`multipart field '${field}' is required`);
  if (file.size === 0) throw badRequest(`${field} is empty`);
  if (file.size > MAX_UPLOAD_BYTES) throw new ApiError(413, 'FILE_TOO_LARGE', 'Max upload size is 25 MB');
  return { ...file, detectedMime: detectMime(file) };
}

export interface StoreDocInput {
  tenantId: string;
  ownerType: 'VENDOR' | 'TENDER_PACK' | 'ADDENDUM' | 'BID_TECHNICAL' | 'BID_FINANCIAL' | 'OPENING_RECORD' | 'COMMITTEE_REPORT'
    | 'REQUEST_LETTER' | 'NOTICE' | 'EVALUATION_NARRATIVE';
  ownerId: string;
  tenderId?: string | null;
  tenderNumber?: string | null;
  vendorId?: string | null;
  bidId?: string | null;
  title: string;
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  uploadedBy: string | null;
  /** If given, the file is AES-256-GCM encrypted with this data key before it reaches the content store. */
  dataKey?: Buffer;
  /** The document this one supersedes (it becomes the next version of it). */
  supersedes?: DocumentRow | null;
  /** Folder segment used when there is no tender number (default 'vendors'). */
  folderKey?: string;
}

export interface PreparedDoc { row: Omit<DocumentRow, 'created_at'> }

/** Writes the bytes (encrypted when dataKey given) to the content store. Returns a row ready to insert. */
export async function putDocument(ctx: Ctx, d: StoreDocInput): Promise<PreparedDoc> {
  const id = uuid();
  const sha = sha256Hex(d.bytes);
  let bytes = d.bytes;
  let encIv: string | null = null;
  let encTag: string | null = null;
  if (d.dataKey) {
    const s = encrypt(d.dataKey, d.bytes, `doc:${id}`);
    bytes = s.data; encIv = s.iv; encTag = s.tag;
  }
  const folderPath = `/${d.tenantId}/${d.tenderNumber ?? d.folderKey ?? 'vendors'}/${d.ownerType}`;
  const safeName = d.fileName.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(-120) || 'file';
  let stored;
  try {
    stored = await ctx.store.put({
      tenantId: d.tenantId, folderPath, fileName: `${id}-${safeName}${d.dataKey ? '.enc' : ''}`,
      mimeType: d.dataKey ? 'application/octet-stream' : d.mimeType, bytes,
      properties: {
        TF_TenantId: d.tenantId, TF_TenderId: d.tenderId ?? '', TF_VendorId: d.vendorId ?? '',
        TF_DocType: d.ownerType, TF_Sha256: sha,
        // FileNet class model (content/filenet-model.ts); stores without it ignore these.
        TF_OwnerType: d.ownerType, TF_TenderNumber: d.tenderNumber ?? '', TF_UploadedBy: d.uploadedBy ?? '',
        TF_VersionNo: String((d.supersedes?.version_no ?? 0) + 1), TF_BidId: d.bidId ?? '',
      },
      supersedesRef: d.supersedes?.store_ref,
    });
  } catch (err) {
    if (err instanceof ContentStoreUnavailableError || (err as any)?.code === 'CONTENT_STORE_UNAVAILABLE')
      throw new ApiError(503, 'CONTENT_STORE_UNAVAILABLE', (err as Error).message);
    throw err;
  }
  return {
    row: {
      id, tenant_id: d.tenantId, owner_type: d.ownerType, owner_id: d.ownerId, tender_id: d.tenderId ?? null,
      vendor_id: d.vendorId ?? null, bid_id: d.bidId ?? null, title: d.title, mime_type: d.mimeType,
      byte_size: d.bytes.length, sha256_plain: sha, store_type: stored.storeType, store_ref: stored.storeRef,
      encrypted: !!d.dataKey, enc_iv: encIv, enc_tag: encTag, uploaded_by: d.uploadedBy,
      supersedes_id: d.supersedes?.id ?? null, version_no: (d.supersedes?.version_no ?? 0) + 1, is_record: false, record_declared_at: null,
      store_meta: { folderPath, ...(stored.meta ?? {}) },
    },
  };
}

export async function insertDocument(q: Queryable, p: PreparedDoc): Promise<DocumentRow> {
  const r = p.row;
  const rows = await q.query<DocumentRow>(
    `INSERT INTO documents (id, tenant_id, owner_type, owner_id, tender_id, vendor_id, bid_id, title, mime_type, byte_size,
       sha256_plain, store_type, store_ref, encrypted, enc_iv, enc_tag, uploaded_by, created_at, supersedes_id, version_no, store_meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb) RETURNING *`,
    [r.id, r.tenant_id, r.owner_type, r.owner_id, r.tender_id, r.vendor_id, r.bid_id, r.title, r.mime_type, r.byte_size,
      r.sha256_plain, r.store_type, r.store_ref, r.encrypted, r.enc_iv, r.enc_tag, r.uploaded_by, now(),
      r.supersedes_id ?? null, r.version_no ?? 1, JSON.stringify(r.store_meta ?? {})]);
  return rows[0];
}

export const publicDoc = (d: DocumentRow) => camel({
  id: d.id, owner_type: d.owner_type, owner_id: d.owner_id, tender_id: d.tender_id, vendor_id: d.vendor_id, bid_id: d.bid_id,
  title: d.title, mime_type: d.mime_type, byte_size: d.byte_size, sha256_plain: d.sha256_plain, store_type: d.store_type,
  encrypted: d.encrypted, created_at: d.created_at, supersedes_id: d.supersedes_id ?? null, version_no: d.version_no ?? 1,
  is_record: d.is_record ?? false, record_declared_at: d.record_declared_at ?? null,
});

async function fetchBytes(ctx: Ctx, d: DocumentRow): Promise<Buffer> {
  try {
    return await ctx.store.get(d.store_ref);
  } catch (err) {
    if (err instanceof ContentStoreUnavailableError || (err as any)?.code === 'CONTENT_STORE_UNAVAILABLE')
      throw new ApiError(503, 'CONTENT_STORE_UNAVAILABLE', (err as Error).message);
    throw err;
  }
}

/** Plain bytes of a non-encrypted document; verifies the stored hash. */
export async function readPlain(ctx: Ctx, d: DocumentRow): Promise<Buffer> {
  if (d.encrypted) throw new Error('readPlain called on an encrypted document');
  const b = await fetchBytes(ctx, d);
  if (sha256Hex(b) !== d.sha256_plain) throw new ApiError(500, 'INTEGRITY_ERROR', 'Stored document hash mismatch');
  return b;
}

/** Decrypt a sealed bid document with its bid data key; verifies the plaintext hash. */
export async function readSealed(ctx: Ctx, d: DocumentRow, dataKey: Buffer): Promise<Buffer> {
  const b = await fetchBytes(ctx, d);
  const plain = decrypt(dataKey, b, d.enc_iv!, d.enc_tag!, `doc:${d.id}`);
  if (sha256Hex(plain) !== d.sha256_plain) throw new ApiError(500, 'INTEGRITY_ERROR', 'Decrypted bid hash mismatch');
  return plain;
}

const PUBLISHED_PLUS = ['PUBLISHED', 'CLOSED', 'OPENED', 'EVALUATION', 'AWARDED'];

/** GET /documents/:id — deny by default. BID_* documents are never served here. */
export async function downloadDocument(ctx: Ctx, actor: Actor, id: string) {
  const d = await loadReadableDocument(ctx, actor, id);
  // SEC: vendors never receive the original of a protected tender document (viewer / watermarked copy instead).
  await (await import('../features/security/content.js')).assertOriginalDownloadAllowed(ctx, actor, d);
  return { doc: d, bytes: await readPlain(ctx, d) };
}

/** Access rule of GET /documents/:id (deny by default; BID_* never), shared with the FileNet evidence route. */
export async function loadReadableDocument(ctx: Ctx, actor: Actor, id: string): Promise<DocumentRow> {
  if (!isUuid(id)) throw notFound('Document');
  const rows = await ctx.db.query<DocumentRow & { tender_status: string | null; tender_category: string | null }>(
    `SELECT d.*, t.status AS tender_status, t.category AS tender_category
       FROM documents d LEFT JOIN tenders t ON t.id = d.tender_id WHERE d.id=$1 AND d.tenant_id=$2`, [id, actor.tenantId]);
  const d = rows[0];
  if (!d) throw notFound('Document');
  let allowed = false;
  switch (d.owner_type) {
    case 'VENDOR':
      allowed = isStaff(actor) || (!!actor.vendorId && actor.vendorId === d.vendor_id);
      break;
    case 'TENDER_PACK':
    case 'ADDENDUM':
      if (isStaff(actor)) allowed = true;
      else if (isVendor(actor) && actor.vendorId && d.tender_status && PUBLISHED_PLUS.includes(d.tender_status)) {
        // Same rule as the tender itself (visibility policy, block, subscription) + purchase when the cycle sells the files.
        const t = (await ctx.db.query<any>('SELECT * FROM tenders WHERE id=$1 AND tenant_id=$2', [d.tender_id, actor.tenantId]))[0];
        allowed = Boolean(t) && (await vendorMayReadPack(ctx.db, actor.tenantId, actor.vendorId, t));
      }
      break;
    case 'OPENING_RECORD':
    case 'COMMITTEE_REPORT':
    case 'REQUEST_LETTER':
    case 'EVALUATION_NARRATIVE':
      allowed = isStaff(actor);
      break;
    case 'NOTICE':
      allowed = isStaff(actor) || (isVendor(actor) && !!d.tender_status && PUBLISHED_PLUS.includes(d.tender_status));
      break;
    default:
      allowed = false; // BID_* only via /bids/:id/documents/:docId
  }
  if (!allowed) throw notFound('Document');
  return d;
}
