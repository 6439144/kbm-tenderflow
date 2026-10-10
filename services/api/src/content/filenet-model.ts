// TenderFlow's FileNet document class model and document security (ACL) model.
//
//   TF_Document                       base class (subclass of the system class Document)
//     ├─ TF_TenderDocument            tender pack, addenda, notices, request letters
//     ├─ TF_BidEnvelope               sealed technical / financial envelopes (ciphertext)
//     ├─ TF_VendorDocument            vendor registration documents
//     ├─ TF_CommitteeRecord           opening records, committee reports, evaluation narratives
//     └─ TF_EvidencePack              auditor evidence packs
//
// The classes and property templates are created by a person in ACCE (docs/filenet/ACCE-RUNBOOK.md §6); the Content
// Services GraphQL API has no mutation for class definitions. FILENET_CLASS_MODEL=subclasses makes uploads use the
// subclass of each document; a class or property that does not exist (yet) is never written — the document falls
// back to FILENET_DOC_CLASS, so uploads keep working on an environment where the runbook has not been done.
//
// Security: each document gets a confidentiality level from its owner type. With FILENET_ACL_MODE=groups the
// permission list (service user full control + the level's groups) is written at create and changed when the
// envelopes are opened (SEALED → COMMITTEE). TenderFlow's own access rules still decide every read through the API.

/** Owner types TenderFlow stores (documents.owner_type). */
export const OWNER_TYPES = [
  'VENDOR', 'TENDER_PACK', 'ADDENDUM', 'NOTICE', 'REQUEST_LETTER', 'BID_TECHNICAL', 'BID_FINANCIAL',
  'OPENING_RECORD', 'COMMITTEE_REPORT', 'EVALUATION_NARRATIVE', 'EVIDENCE_PACK',
] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];

export const TF_BASE_CLASS = 'TF_Document';
export const TF_SUBCLASSES = ['TF_TenderDocument', 'TF_BidEnvelope', 'TF_VendorDocument', 'TF_CommitteeRecord', 'TF_EvidencePack'] as const;
export type TfClassName = typeof TF_BASE_CLASS | (typeof TF_SUBCLASSES)[number];
export const TF_CLASSES: TfClassName[] = [TF_BASE_CLASS, ...TF_SUBCLASSES];

const SUBCLASS_OF: Record<OwnerType, (typeof TF_SUBCLASSES)[number]> = {
  TENDER_PACK: 'TF_TenderDocument', ADDENDUM: 'TF_TenderDocument', NOTICE: 'TF_TenderDocument', REQUEST_LETTER: 'TF_TenderDocument',
  BID_TECHNICAL: 'TF_BidEnvelope', BID_FINANCIAL: 'TF_BidEnvelope',
  VENDOR: 'TF_VendorDocument',
  OPENING_RECORD: 'TF_CommitteeRecord', COMMITTEE_REPORT: 'TF_CommitteeRecord', EVALUATION_NARRATIVE: 'TF_CommitteeRecord',
  EVIDENCE_PACK: 'TF_EvidencePack',
};

export const isOwnerType = (v: unknown): v is OwnerType => typeof v === 'string' && (OWNER_TYPES as readonly string[]).includes(v);

/** FileNet class for a TenderFlow owner type (unknown owner types use the base class TF_Document). */
export function subclassFor(ownerType: string | null | undefined): TfClassName {
  return isOwnerType(ownerType) ? SUBCLASS_OF[ownerType] : TF_BASE_CLASS;
}

/** Owner types stored in each class (for the model page and the runbook). */
export function ownerTypesOf(cls: TfClassName): OwnerType[] {
  return OWNER_TYPES.filter((o) => SUBCLASS_OF[o] === cls);
}

export type TfDataType = 'STRING' | 'INTEGER' | 'FLOAT' | 'BOOLEAN';
export interface TfPropertySpec { name: string; dataType: TfDataType; maxLength?: number; description: string }

/** Property templates on TF_Document (inherited by every subclass). */
export const TF_BASE_PROPERTIES: TfPropertySpec[] = [
  { name: 'TF_TenantId', dataType: 'STRING', maxLength: 64, description: 'TenderFlow entity (tenant) id' },
  { name: 'TF_TenderId', dataType: 'STRING', maxLength: 64, description: 'TenderFlow tender id (uuid)' },
  { name: 'TF_VendorId', dataType: 'STRING', maxLength: 64, description: 'TenderFlow vendor id (uuid)' },
  { name: 'TF_DocType', dataType: 'STRING', maxLength: 64, description: 'Document type (rc3 property; the accepted document-intelligence type)' },
  { name: 'TF_Sha256', dataType: 'STRING', maxLength: 64, description: 'SHA-256 (hex) of the stored bytes' },
  { name: 'TF_TenderNumber', dataType: 'STRING', maxLength: 64, description: 'Tender number, e.g. KEA-2026-102' },
  { name: 'TF_OwnerType', dataType: 'STRING', maxLength: 32, description: 'Upload slot: TENDER_PACK, BID_TECHNICAL, VENDOR …' },
  { name: 'TF_DocumentType', dataType: 'STRING', maxLength: 64, description: 'Document type at upload (the owner type)' },
  { name: 'TF_Confidentiality', dataType: 'STRING', maxLength: 16, description: 'PUBLIC, INTERNAL, SEALED, COMMITTEE or AUDIT' },
  { name: 'TF_UploadedBy', dataType: 'STRING', maxLength: 64, description: 'TenderFlow user id of the uploader' },
  { name: 'TF_VersionNo', dataType: 'INTEGER', description: 'TenderFlow version number (1, 2, …)' },
  { name: 'TF_AiClassification', dataType: 'STRING', maxLength: 64, description: 'Document type suggested by watsonx Orchestrate (not yet reviewed)' },
  { name: 'TF_AiConfidence', dataType: 'FLOAT', description: 'Share (0–1) of the suggested type\'s required fields extracted with a verified citation' },
];
/** Properties defined only on one subclass (beyond the inherited ones). */
export const TF_SUBCLASS_PROPERTIES: Partial<Record<TfClassName, TfPropertySpec[]>> = {
  TF_BidEnvelope: [{ name: 'TF_BidId', dataType: 'STRING', maxLength: 64, description: 'TenderFlow bid id (uuid)' }],
};
export const TF_AI_MODEL_PROPERTIES = ['TF_AiClassification', 'TF_AiConfidence'] as const;

/** Every property a class is expected to have (inherited + own). */
export function expectedProperties(cls: TfClassName): TfPropertySpec[] {
  return cls === TF_BASE_CLASS ? [...TF_BASE_PROPERTIES] : [...TF_BASE_PROPERTIES, ...(TF_SUBCLASS_PROPERTIES[cls] ?? [])];
}
const SPEC_BY_NAME = new Map<string, TfPropertySpec>(
  [...TF_BASE_PROPERTIES, ...Object.values(TF_SUBCLASS_PROPERTIES).flat()].map((p) => [p!.name, p!]),
);
export const propertySpec = (name: string) => SPEC_BY_NAME.get(name);

export type ModelValue = string | number | boolean;

/**
 * Model property values for one upload, from the properties TenderFlow passes to the content store
 * (services/documents.ts putDocument) and the stored bytes' SHA-256. Empty values are omitted; strings longer than the
 * template's maximum length are rejected (never silently truncated).
 */
export function modelPropertyValues(cls: TfClassName, tenantId: string, p: Record<string, string>, storedSha256: string): Record<string, ModelValue> {
  const pick = (...keys: string[]) => keys.map((k) => p[k]).find((v) => v !== undefined && v !== null && String(v) !== '');
  const ownerType = pick('TF_OwnerType', 'TF_DocType', 'docType');
  const versionNo = Number(pick('TF_VersionNo'));
  const raw: Record<string, ModelValue | undefined> = {
    TF_TenantId: pick('TF_TenantId') ?? tenantId,
    TF_TenderId: pick('TF_TenderId', 'tenderId'),
    TF_VendorId: pick('TF_VendorId', 'vendorId'),
    TF_DocType: pick('TF_DocType', 'docType') ?? ownerType,
    TF_Sha256: storedSha256,
    TF_TenderNumber: pick('TF_TenderNumber'),
    TF_OwnerType: ownerType,
    TF_DocumentType: pick('TF_DocumentType') ?? ownerType,
    TF_Confidentiality: confidentialityFor(ownerType),
    TF_UploadedBy: pick('TF_UploadedBy'),
    TF_VersionNo: Number.isInteger(versionNo) && versionNo > 0 ? versionNo : undefined,
    TF_BidId: cls === 'TF_BidEnvelope' ? pick('TF_BidId', 'bidId') : undefined,
  };
  const out: Record<string, ModelValue> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === '') continue;
    const spec = SPEC_BY_NAME.get(k);
    if (spec?.maxLength && typeof v === 'string' && v.length > spec.maxLength) throw new Error(`${k} value is longer than ${spec.maxLength} characters`);
    out[k] = v;
  }
  return out;
}

// ------------------------------------------------------------------ class model status (classDescription)

export interface ClassStatus {
  name: TfClassName;
  parent: string;
  ownerTypes: OwnerType[];
  /** null = could not be checked (error). */
  exists: boolean | null;
  /** Property names the repository reports on the class (inherited included); null when the repository did not list them. */
  present: string[] | null;
  missing: string[];
  error?: string;
}
export interface ModelStatus {
  mode: 'single' | 'subclasses';
  checkedAt: string;
  fallbackClass: string;
  classes: ClassStatus[];
  /** Every class exists and has every expected property. */
  ready: boolean;
}

/**
 * Class a document of `ownerType` is created in, given the model status. Subclass → base class → FILENET_DOC_CLASS.
 * Returns the properties that may be written (only those the repository reports on that class; when the repository
 * did not list properties, all expected properties are attempted and a refusal falls back at upload).
 */
export function planClass(status: ModelStatus, ownerType: string | null | undefined): { className: string; model: boolean; writable: Set<string> | 'all' | null; fallback?: string } {
  const target = subclassFor(ownerType);
  const order: TfClassName[] = target === TF_BASE_CLASS ? [TF_BASE_CLASS] : [target, TF_BASE_CLASS];
  const reasons: string[] = [];
  for (const cls of order) {
    const c = status.classes.find((x) => x.name === cls);
    if (!c || c.exists !== true) { reasons.push(`${cls} ${c?.exists === false ? 'does not exist' : 'could not be checked'}`); continue; }
    const writable = c.present ? new Set(c.present) : 'all';
    return { className: cls, model: true, writable, ...(reasons.length ? { fallback: reasons.join('; ') } : {}) };
  }
  return { className: status.fallbackClass, model: false, writable: null, fallback: `${reasons.join('; ')} → FILENET_DOC_CLASS ${status.fallbackClass}` };
}

// ------------------------------------------------------------------ security (ACL)

export const CONFIDENTIALITY_LEVELS = ['PUBLIC', 'INTERNAL', 'SEALED', 'COMMITTEE', 'AUDIT'] as const;
export type Confidentiality = (typeof CONFIDENTIALITY_LEVELS)[number];

/** Confidentiality of a document from its owner type (a sealed envelope becomes COMMITTEE when it is opened). */
export function confidentialityFor(ownerType: string | null | undefined): Confidentiality {
  switch (ownerType) {
    case 'TENDER_PACK': case 'ADDENDUM': case 'NOTICE': return 'PUBLIC';
    case 'BID_TECHNICAL': case 'BID_FINANCIAL': return 'SEALED';
    case 'OPENING_RECORD': case 'COMMITTEE_REPORT': case 'EVALUATION_NARRATIVE': return 'COMMITTEE';
    case 'EVIDENCE_PACK': return 'AUDIT';
    default: return 'INTERNAL'; // VENDOR, REQUEST_LETTER, anything new
  }
}

/** FileNet access masks (Content Engine AccessLevel constants). */
export const ACCESS_MASK = { FULL_CONTROL: 998903, VIEW_CONTENT: 131201 } as const;
export type AccessName = keyof typeof ACCESS_MASK;

/** Which configured groups get view access at each level (the service user always has full control). */
export const LEVEL_GROUPS: Record<Confidentiality, Confidentiality[]> = {
  PUBLIC: ['PUBLIC', 'INTERNAL', 'COMMITTEE', 'AUDIT'],
  INTERNAL: ['INTERNAL', 'AUDIT'],
  SEALED: [], // nobody but the service user: the envelope is ciphertext and TenderFlow holds the key
  COMMITTEE: ['COMMITTEE', 'AUDIT'],
  AUDIT: ['AUDIT'],
};

export interface AclEntry { granteeName: string; access: AccessName; accessMask: number }
export interface AclConfig { mode: 'off' | 'groups'; serviceGrantee: string; groups: Record<Confidentiality, string | null> }

/** Grantee names: user / group short names or LDAP DNs. No quotes, braces, backslashes or control characters. */
export const GRANTEE_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._@=,()#-]{0,254}$/u;

export function aclEntriesFor(cfg: AclConfig, level: Confidentiality): AclEntry[] {
  const out: AclEntry[] = [{ granteeName: cfg.serviceGrantee, access: 'FULL_CONTROL', accessMask: ACCESS_MASK.FULL_CONTROL }];
  for (const g of LEVEL_GROUPS[level]) {
    const name = cfg.groups[g];
    if (name && !out.some((e) => e.granteeName.toLowerCase() === name.toLowerCase())) out.push({ granteeName: name, access: 'VIEW_CONTENT', accessMask: ACCESS_MASK.VIEW_CONTENT });
  }
  for (const e of out) if (!GRANTEE_RE.test(e.granteeName)) throw new Error(`invalid grantee name "${e.granteeName}"`);
  return out;
}

/**
 * ASSUMED (not verified live): documentProperties.permissions input shape, mirroring the content-element pattern of the
 * published schema ({ type: CONTENT_TRANSFER, subContentTransfer: {…} }). Change only this function and
 * PERMISSIONS_SELECTION if the live server refuses it (run tools/filenet-introspect for PermissionListInput).
 */
export function permissionsLiteral(entries: AclEntry[]): string {
  const items = entries.map((e) => {
    if (!GRANTEE_RE.test(e.granteeName)) throw new Error(`invalid grantee name "${e.granteeName}"`);
    if (!Number.isInteger(e.accessMask)) throw new Error('invalid access mask');
    return `{ type: ACCESS_PERMISSION, subAccessPermission: { accessType: ALLOW, inheritableDepth: 0, accessMask: ${e.accessMask}, granteeName: ${JSON.stringify(e.granteeName)} } }`;
  });
  return `permissions: { replace: [${items.join(' ')}] }`;
}
/** ASSUMED: selection that reads a document's permission list back. */
export const PERMISSIONS_SELECTION = 'permissions { ... on AccessPermission { granteeName accessMask accessType permissionSource } }';

/** True when every expected grantee is present with at least the expected rights (direct, ALLOW). */
export function aclMatches(expected: AclEntry[], readBack: { granteeName?: string | null; accessMask?: number | null; accessType?: string | null }[]): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const e of expected) {
    const hit = readBack.find((r) => String(r.granteeName ?? '').toLowerCase() === e.granteeName.toLowerCase()
      && (r.accessType == null || String(r.accessType).toUpperCase() === 'ALLOW')
      && typeof r.accessMask === 'number' && (r.accessMask & e.accessMask) === e.accessMask);
    if (!hit) missing.push(`${e.granteeName} (${e.access})`);
  }
  return { ok: missing.length === 0, missing };
}

// ------------------------------------------------------------------ CE SQL search (whitelisted values only)

export interface SearchCriteria { tenantId: string; q?: string | null; tenderNumber?: string | null; tenderId?: string | null; ownerType?: string | null }
export type SearchVocabulary = 'model' | 'legacy';

const TENANT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TENDER_NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9./-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEXT_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u;

export class SearchInputError extends Error { constructor(readonly field: string, message: string) { super(message); } }

/**
 * WHERE clause of the FileNet search. Always starts with the tenant and the current-version condition; every value
 * comes from a whitelist (no quote, backslash, wildcard or operator can reach the query).
 *  - model vocabulary (FILENET_CLASS_MODEL=subclasses): TF_TenderNumber, TF_OwnerType
 *  - legacy vocabulary (rc3 TF_* properties on FILENET_DOC_CLASS): TF_TenderId (tender number resolved to its id), TF_DocType
 */
export function buildSearchWhere(c: SearchCriteria, vocabulary: SearchVocabulary): string {
  if (!TENANT_RE.test(c.tenantId)) throw new SearchInputError('tenantId', 'invalid tenant id');
  const parts = [`TF_TenantId = '${c.tenantId}'`, 'IsCurrentVersion = TRUE'];
  if (c.tenderNumber) {
    if (!TENDER_NUMBER_RE.test(c.tenderNumber)) throw new SearchInputError('tenderNumber', 'tenderNumber may contain only letters, digits, ".", "/" and "-"');
    if (vocabulary === 'model') parts.push(`TF_TenderNumber = '${c.tenderNumber}'`);
    else {
      if (!c.tenderId || !UUID_RE.test(c.tenderId)) throw new SearchInputError('tenderNumber', 'unknown tender number');
      parts.push(`TF_TenderId = '${c.tenderId.toLowerCase()}'`);
    }
  }
  if (c.ownerType) {
    if (!isOwnerType(c.ownerType)) throw new SearchInputError('documentType', `documentType must be one of ${OWNER_TYPES.join(', ')}`);
    parts.push(`${vocabulary === 'model' ? 'TF_OwnerType' : 'TF_DocType'} = '${c.ownerType}'`);
  }
  if (c.q) {
    const q = c.q.trim();
    if (!TEXT_RE.test(q)) throw new SearchInputError('q', 'q may contain only letters, digits, spaces, ".", "_" and "-" (max 64)');
    parts.push(`DocumentTitle LIKE '%${q}%'`);
  }
  const where = parts.join(' AND ');
  // Defence in depth: exactly the quotes the builder wrote (two per value), nothing else that could close a literal.
  if (/[\\;]|--|\/\*/.test(where)) throw new SearchInputError('q', 'unsafe search input');
  return where;
}
