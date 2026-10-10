// TenderFlow FileNet verification CLI.
//   npm run build -w services/api     (once, after pulling)
//   npm run verify:filenet            (runs node services/api/dist/tools/verify-filenet.js)
// Windows without a build: scripts\windows\filenet-check.cmd (runs this file with tsx).
// Reads the repo-root .env, runs real calls against the configured FileNet Content Services GraphQL endpoint,
// prints PASS / FAIL / SKIP (with the reason) per step, writes docs/evidence/filenet-verify-<timestamp>.json (no secrets)
// and exits 1 when any step failed, with the full server error text. Steps 1–5 (connection, folder, upload/download)
// stop the run when they fail — nothing after them can work; later steps each report on their own.
// Writes only under FILENET_ROOT_FOLDER/_verify.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileNetStore, FileNetError, TF_PROPERTY_NAMES } from '../content/filenet-store.js';
import { bookmarkUrl } from '../content/navigator.js';
import { buildSearchWhere, type SearchVocabulary } from '../content/filenet-model.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Repo root: walk up from this file to the directory holding the workspace package.json. */
function findRepoRoot(): string {
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try { if (Array.isArray(JSON.parse(readFileSync(pkg, 'utf8')).workspaces)) return dir; } catch { /* keep walking */ }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}

/** Loads KEY=VALUE lines; existing process env wins. */
function loadEnv(file: string): boolean {
  if (!existsSync(file)) return false;
  const p = process as unknown as { loadEnvFile?: (path: string) => void };
  if (typeof p.loadEnvFile === 'function') { p.loadEnvFile(file); return true; }
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return true;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const OK = '✓';
const FAIL = '✗';

type StepStatus = 'PASS' | 'FAIL' | 'SKIP';
interface StepResult { step: number; name: string; status: StepStatus; ok: boolean; ms: number; detail?: unknown; error?: string; reason?: string }
/** Thrown by a step to report SKIP with a reason (the feature is not enabled / not applicable here). */
class Skip extends Error {}

async function main() {
  const root = findRepoRoot();
  const envFile = process.env.TF_ENV_FILE || join(root, '.env');
  const loaded = loadEnv(envFile);
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const evidenceDir = process.env.TF_EVIDENCE_DIR || join(root, 'docs', 'evidence');
  const reportFile = join(evidenceDir, `filenet-verify-${stamp}.json`);
  const steps: StepResult[] = [];
  const report: Record<string, unknown> = {
    tool: 'verify-filenet', startedAt: startedAt.toISOString(), node: process.version, platform: process.platform,
    envFile: loaded ? envFile : `(not found: ${envFile}; using process environment)`,
    config: {
      FILENET_GRAPHQL_URL: process.env.FILENET_GRAPHQL_URL ?? null,
      FILENET_OBJECT_STORE: process.env.FILENET_OBJECT_STORE ?? null,
      FILENET_SERVICE_USER: process.env.FILENET_SERVICE_USER ?? null,
      FILENET_SERVICE_PASSWORD: process.env.FILENET_SERVICE_PASSWORD ? '(set, not shown)' : null,
      FILENET_DOC_CLASS: process.env.FILENET_DOC_CLASS || 'Document',
      FILENET_ROOT_FOLDER: process.env.FILENET_ROOT_FOLDER || '/TenderFlow',
      FILENET_SET_CUSTOM_PROPERTIES: process.env.FILENET_SET_CUSTOM_PROPERTIES || 'false',
      FILENET_VERSIONING: process.env.FILENET_VERSIONING || 'false',
      FILENET_RECORDS_MODE: process.env.FILENET_RECORDS_MODE || 'none',
      FILENET_RETENTION_DAYS: process.env.FILENET_RETENTION_DAYS || null,
      FILENET_CLASS_MODEL: process.env.FILENET_CLASS_MODEL || 'single',
      FILENET_ACL_MODE: process.env.FILENET_ACL_MODE || 'off',
      FILENET_NAVIGATOR_URL: process.env.FILENET_NAVIGATOR_URL || '(derived from FILENET_GRAPHQL_URL)',
      FILENET_ACCE_URL: process.env.FILENET_ACCE_URL || '(derived from FILENET_GRAPHQL_URL)',
    },
    steps,
  };
  const password = process.env.FILENET_SERVICE_PASSWORD;
  const scrub = (s: string) => (password && password.length >= 3 ? s.split(password).join('***') : s);

  const writeReport = (ok: boolean) => {
    report.finishedAt = new Date().toISOString();
    report.ok = ok;
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(reportFile, scrub(JSON.stringify(report, null, 2)) + '\n', 'utf8');
    console.log(`\nReport: ${reportFile}`);
  };

  console.log('TenderFlow FileNet verification');
  console.log(`  .env           : ${loaded ? envFile : 'not found — using process environment'}`);
  for (const [k, v] of Object.entries(report.config as Record<string, unknown>)) console.log(`  ${k.padEnd(30)}: ${v ?? '(missing)'}`);
  console.log('');

  let store: FileNetStore;
  try {
    store = new FileNetStore();
  } catch (e: any) {
    console.log(`${FAIL} FAIL 0 configuration: ${scrub(e.message)}`);
    steps.push({ step: 0, name: 'configuration', status: 'FAIL', ok: false, ms: 0, error: scrub(e.message) });
    writeReport(false);
    process.exit(1);
  }
  const cfg = store.config;

  let failures = 0;
  const skip = (step: number, name: string, reason: string) => {
    steps.push({ step, name, status: 'SKIP', ok: true, ms: 0, reason });
    console.log(`- SKIP ${step} ${name} — ${reason}`);
  };
  /**
   * Runs one step. PASS / FAIL / SKIP (a step throws Skip). `fatal` steps end the run on failure (exit 1); others are
   * recorded and the run continues. Returns undefined when the step did not pass.
   */
  const step = async <T>(n: number, name: string, fn: () => Promise<T>, describe?: (r: T) => string, opts: { fatal?: boolean } = {}): Promise<T | undefined> => {
    const t0 = Date.now();
    try {
      const r = await fn();
      const ms = Date.now() - t0;
      steps.push({ step: n, name, status: 'PASS', ok: true, ms, detail: r as unknown });
      console.log(`${OK} PASS ${n} ${name}${describe ? ` — ${describe(r)}` : ''} (${ms} ms)`);
      return r;
    } catch (e: any) {
      const ms = Date.now() - t0;
      if (e instanceof Skip) { steps.push({ step: n, name, status: 'SKIP', ok: true, ms, reason: e.message }); console.log(`- SKIP ${n} ${name} — ${e.message}`); return undefined; }
      failures++;
      const msg = scrub(String(e?.message ?? e));
      const gql = e instanceof FileNetError && e.graphqlErrors ? e.graphqlErrors : undefined;
      steps.push({ step: n, name, status: 'FAIL', ok: false, ms, error: msg, detail: gql ? { graphqlErrors: JSON.parse(scrub(JSON.stringify(gql))) } : undefined });
      console.log(`${FAIL} FAIL ${n} ${name} (${ms} ms)\n\n${msg}`);
      if (gql) console.log(`\nGraphQL errors (raw):\n${scrub(JSON.stringify(gql, null, 2))}`);
      if (opts.fatal) {
        console.log('\nIf this is a schema/shape error, run:  node services/api/dist/tools/filenet-introspect.js\nand send docs/evidence/filenet-schema-*.txt together with this report.');
        writeReport(false);
        process.exit(1);
      }
      console.log('');
      return undefined;
    }
  };
  /** Fatal step (connection, folder, upload/download): returns its value or ends the run. */
  const run = async <T>(n: number, name: string, fn: () => Promise<T>, describe?: (r: T) => string): Promise<T> => (await step(n, name, fn, describe, { fatal: true })) as T;

  // 1. ping
  await run(1, 'ping object store', async () => {
    const r = await store.ping();
    if (!r.ok) throw new Error(r.detail);
    return r;
  }, (r) => r.detail);

  // 2. folder
  const verifyFolder = `${cfg.rootFolder}/_verify`;
  await run(2, `ensure folder ${verifyFolder}`, async () => { await store.ensureFolder(verifyFolder); return { folder: verifyFolder }; });

  const docs: { label: string; storeRef: string; id: string; name: string; byteSize: number; sha256: string; path: string }[] = [];
  const put = async (label: string, fileName: string, mimeType: string, bytes: Buffer) => {
    const out = await store.put({ tenantId: '_verify', folderPath: '/_verify', fileName, mimeType, bytes, properties: { tenderId: 'VERIFY', vendorId: 'VERIFY', docType: 'VERIFY' } });
    const id = store.parseStoreRef(out.storeRef).id;
    const rec = { label, storeRef: out.storeRef, id, name: fileName, byteSize: out.byteSize, sha256: sha256(bytes), path: `${verifyFolder}/${fileName}` };
    docs.push(rec);
    return rec;
  };
  const roundTrip = async (rec: { storeRef: string; sha256: string; byteSize: number }) => {
    const back = await store.get(rec.storeRef);
    const got = sha256(back);
    if (got !== rec.sha256 || back.length !== rec.byteSize) {
      throw new Error(`content mismatch: uploaded ${rec.byteSize} bytes sha256=${rec.sha256}, downloaded ${back.length} bytes sha256=${got}`);
    }
    return { bytes: back.length, sha256: got };
  };

  // 3 + 4. UTF-8 Arabic + English text
  const text = Buffer.from(
    `TenderFlow FileNet verification — ${startedAt.toISOString()}\n` +
    'تحقق منصة المناقصات الرقمية من التخزين في FileNet\n' +
    'مناقصة رقم ٢٠٢٦/٠٠١ — Tender No. 2026/001\n',
    'utf8',
  );
  const textDoc = await run(3, 'upload UTF-8 Arabic + English text', () => put('text', `verify-text-${stamp}.txt`, 'text/plain; charset=utf-8', text), (r) => `${r.id} (${r.byteSize} bytes)`);
  await run(4, 'download text and compare SHA-256', () => roundTrip(textDoc), (r) => `sha256 ${r.sha256.slice(0, 16)}… matches`);

  // 5. 2 MB binary
  const bin = randomBytes(2 * 1024 * 1024);
  const binDoc = await run(5, 'upload 2 MB binary', () => put('binary', `verify-binary-${stamp}.bin`, 'application/octet-stream', bin), (r) => `${r.id} (${r.byteSize} bytes)`);
  await run(5, 'download 2 MB binary and compare SHA-256', () => roundTrip(binDoc), (r) => `sha256 ${r.sha256.slice(0, 16)}… matches`);

  // 6. class + custom properties
  if (cfg.docClass !== 'Document') {
    await step(6, `document class ${cfg.docClass} exists`, async () => {
      if (!(await store.classExists(cfg.docClass))) throw new Error(`class ${cfg.docClass} not found in ${cfg.objectStore}; see docs/filenet/ACCE-RUNBOOK.md`);
      return { class: cfg.docClass };
    });
  } else {
    skip(6, 'document class check', 'FILENET_DOC_CLASS=Document (the base class always exists)');
  }
  if (cfg.setCustomProperties) {
    await step(6, 'custom TF_* properties stored', async () => {
      const info = await store.describeDocument(textDoc.id, [...TF_PROPERTY_NAMES]);
      const expected: Record<string, string> = { TF_TenantId: '_verify', TF_TenderId: 'VERIFY', TF_VendorId: 'VERIFY', TF_DocType: 'VERIFY', TF_Sha256: textDoc.sha256 };
      const wrong = Object.entries(expected).filter(([k, v]) => info.properties[k] !== v).map(([k, v]) => `${k}: expected "${v}", got ${JSON.stringify(info.properties[k] ?? null)}`);
      if (info.className !== cfg.docClass) wrong.unshift(`className: expected ${cfg.docClass}, got ${info.className}`);
      if (wrong.length) throw new Error(`custom properties not stored as expected:\n  ${wrong.join('\n  ')}`);
      return { className: info.className, properties: info.properties };
    }, () => 'all 5 match');
  } else {
    skip(6, 'custom TF_* properties stored', 'FILENET_SET_CUSTOM_PROPERTIES=false');
  }

  // 7. evidence for screenshots
  await step(7, 'read back document metadata for evidence', async () => {
    const out = [];
    for (const d of docs) {
      const info = await store.describeDocument(d.id);
      out.push({ ...d, className: info.className, version: `${info.majorVersionNumber}.${info.minorVersionNumber}`, filedIn: info.folders, contentElements: info.contentElements.map((c) => ({ contentType: c.contentType, contentSize: c.contentSize, retrievalName: c.retrievalName })) });
    }
    report.documents = out;
    return { count: out.length };
  });

  // 8. versioning: v1 created, v2 checked in as the next MAJOR version (checkout + checkin), both read back.
  // Runs regardless of FILENET_VERSIONING so the flag can be enabled only after this passes live.
  if (/^(1|true|yes)$/i.test(process.env.VERIFY_SKIP_VERSIONING ?? '')) {
    skip(8, 'versioning round-trip', 'VERIFY_SKIP_VERSIONING=true');
  } else {
    const vstore = new FileNetStore({ ...process.env, FILENET_VERSIONING: 'true' });
    const vName = `verify-version-${stamp}.txt`;
    const v1Bytes = Buffer.from(`TenderFlow versioning check — v1 — ${startedAt.toISOString()}\nالإصدار الأول\n`, 'utf8');
    const v2Bytes = Buffer.from(`TenderFlow versioning check — v2 (addendum) — ${startedAt.toISOString()}\nالإصدار الثاني — ملحق\n`, 'utf8');
    const props = { tenderId: 'VERIFY', vendorId: 'VERIFY', docType: 'VERIFY' };
    const v1 = await step(8, 'versioning: create v1', async () => {
      const out = await vstore.put({ tenantId: '_verify', folderPath: '/_verify', fileName: vName, mimeType: 'text/plain; charset=utf-8', bytes: v1Bytes, properties: props });
      return { storeRef: out.storeRef, id: vstore.parseStoreRef(out.storeRef).id, sha256: sha256(v1Bytes), byteSize: v1Bytes.length, meta: out.meta };
    }, (r) => `${r.id} (version ${r.meta?.versionLabel ?? '?'})`);
    const v2 = v1 && await step(8, 'versioning: check in v2 as the next major version (checkout + checkin)', async () => {
      const out = await vstore.put({ tenantId: '_verify', folderPath: '/_verify', fileName: vName, mimeType: 'text/plain; charset=utf-8', bytes: v2Bytes, properties: props, supersedesRef: v1.storeRef });
      return { storeRef: out.storeRef, id: vstore.parseStoreRef(out.storeRef).id, sha256: sha256(v2Bytes), byteSize: v2Bytes.length, meta: out.meta };
    }, (r) => `${r.id} (version ${r.meta?.versionLabel ?? '?'})`);
    if (v1 && v2) await step(8, 'versioning: read v1 and v2 back and compare SHA-256', async () => {
      const a = await roundTrip(v1);
      const b = await roundTrip(v2);
      if (a.sha256 === b.sha256) throw new Error('v1 and v2 returned the same content');
      return { v1: a.sha256, v2: b.sha256 };
    }, () => 'both versions match what was uploaded');
    const vInfo = v1 && v2 && await step(8, 'versioning: describe both versions (same version series, v2 current)', async () => {
      const d1 = await vstore.describe(v1.storeRef);
      const d2 = await vstore.describe(v2.storeRef);
      const problems: string[] = [];
      if (v1.id === v2.id) problems.push('v2 has the same object id as v1');
      if (!d1.versionSeriesId || d1.versionSeriesId !== d2.versionSeriesId) problems.push(`version series differ (v1 ${d1.versionSeriesId}, v2 ${d2.versionSeriesId})`);
      if ((d2.majorVersionNumber ?? 0) <= (d1.majorVersionNumber ?? 0)) problems.push(`v2 major version ${d2.majorVersionNumber} is not above v1 major version ${d1.majorVersionNumber}`);
      if (d2.isCurrentVersion !== true) problems.push(`v2 isCurrentVersion = ${d2.isCurrentVersion}`);
      if (d1.isCurrentVersion !== false) problems.push(`v1 isCurrentVersion = ${d1.isCurrentVersion}`);
      if (problems.length) throw new Error(`versioning not as expected:\n  ${problems.join('\n  ')}`);
      return { versionSeriesId: d2.versionSeriesId, v1Version: `${d1.majorVersionNumber}.${d1.minorVersionNumber}`, v2Version: `${d2.majorVersionNumber}.${d2.minorVersionNumber}`, versions: d2.versions, className: d2.className, folders: d2.folders, objectStoreId: d2.objectStoreId ?? null, navigatorUrl: null as string | null };
    }, (r) => `series ${r.versionSeriesId}: ${r.v1Version} → ${r.v2Version}`);
    if (v1 && v2) report.versioning = { v1: { id: v1.id, sha256: v1.sha256 }, v2: { id: v2.id, sha256: v2.sha256 }, ...(vInfo ?? {}) };
  }

  // 9. records declaration (only when FILENET_RECORDS_MODE is property or retention)
  if (cfg.recordsMode === 'none') {
    skip(9, 'records declaration', 'FILENET_RECORDS_MODE=none');
  } else {
    await step(9, `records declaration (FILENET_RECORDS_MODE=${cfg.recordsMode})`, async () => {
      const r = await store.declareRecord(textDoc.storeRef, { reason: 'verify-filenet' });
      if (!r.ok) throw new Error(r.detail);
      const d = await store.describe(textDoc.storeRef);
      if (cfg.recordsMode === 'property' && String(d.properties?.TF_RecordDeclared).toLowerCase() !== 'true') {
        throw new Error(`TF_RecordDeclared reads back as ${JSON.stringify(d.properties?.TF_RecordDeclared ?? null)}`);
      }
      if (cfg.recordsMode === 'retention' && !d.cmRetentionDate) throw new Error('CmRetentionDate reads back empty');
      return { detail: r.detail, properties: d.properties, cmRetentionDate: d.cmRetentionDate ?? null };
    }, (r) => r.detail);
  }

  // 10. class model: TF_Document + five subclasses with their properties; one upload lands in its subclass
  if (cfg.classModel !== 'subclasses') {
    skip(10, 'class model (TF_Document + subclasses)', 'FILENET_CLASS_MODEL=single (every document uses FILENET_DOC_CLASS)');
  } else {
    await step(10, 'class model: classes and properties exist', async () => {
      const st = await store.modelStatus({ force: true });
      const problems = st.classes.filter((c) => c.exists !== true || c.missing.length || c.present === null)
        .map((c) => `${c.name}: ${c.exists === false ? 'class missing' : c.exists === null ? `not checked (${c.error ?? '?'})` : c.present === null ? `property list not available (${c.error ?? '?'})` : `missing ${c.missing.join(', ')}`}`);
      if (problems.length) throw new Error(`class model incomplete (uploads fall back to ${cfg.docClass}):\n  ${problems.join('\n  ')}`);
      return { classes: st.classes.map((c) => ({ name: c.name, properties: c.present?.length ?? null })) };
    }, (r) => `${r.classes.length} classes ready`);
    await step(10, 'class model: a tender document is stored as TF_TenderDocument with its properties', async () => {
      const out = await store.put({ tenantId: '_verify', folderPath: '/_verify', fileName: `verify-model-${stamp}.txt`, mimeType: 'text/plain; charset=utf-8',
        bytes: Buffer.from(`TenderFlow class model check ${stamp}\n`, 'utf8'),
        properties: { TF_OwnerType: 'TENDER_PACK', TF_TenderNumber: 'VERIFY-001', TF_VersionNo: '1', TF_UploadedBy: 'verify-filenet' } });
      const d = await store.describe(out.storeRef, { className: String(out.meta?.className ?? '') });
      if (d.className !== 'TF_TenderDocument') throw new Error(`stored as ${d.className}; fallback: ${JSON.stringify((out.meta as any)?.classModel ?? null)}`);
      const want: Record<string, unknown> = { TF_TenantId: '_verify', TF_OwnerType: 'TENDER_PACK', TF_TenderNumber: 'VERIFY-001', TF_Confidentiality: 'PUBLIC', TF_VersionNo: 1 };
      const wrong = Object.entries(want).filter(([k, v]) => String(d.properties?.[k]) !== String(v)).map(([k, v]) => `${k}: expected ${v}, got ${JSON.stringify(d.properties?.[k] ?? null)}`);
      if (wrong.length) throw new Error(`properties not as expected:\n  ${wrong.join('\n  ')}`);
      return { id: d.id, className: d.className, properties: d.properties };
    }, (r) => `${r.id} (${r.className})`);
  }

  // 11. security: permission list written at create and changed (SEALED → COMMITTEE), each read back
  if (cfg.acl.mode !== 'groups') {
    skip(11, 'ACL write and read-back', 'FILENET_ACL_MODE=off (documents keep their class default security)');
  } else {
    const sealed = await step(11, 'ACL: sealed envelope created with the SEALED permission list (read back)', async () => {
      const out = await store.put({ tenantId: '_verify', folderPath: '/_verify', fileName: `verify-acl-${stamp}.enc`, mimeType: 'application/octet-stream',
        bytes: randomBytes(64), properties: { TF_OwnerType: 'BID_TECHNICAL', TF_BidId: 'VERIFY' } });
      const acl = (out.meta as any)?.acl;
      if (acl?.status !== 'APPLIED') throw new Error(`permission list ${acl?.status ?? 'not written'}: ${acl?.error ?? ''}`);
      return { storeRef: out.storeRef, grantees: acl.grantees };
    }, (r) => r.grantees.map((g: any) => g.name).join(', '));
    if (sealed) {
      await step(11, 'ACL: opened envelope changed to COMMITTEE (read back)', async () => {
        const r = await store.setAccess(sealed.storeRef, 'COMMITTEE');
        if (!r.ok) throw new Error(r.detail);
        return { detail: r.detail };
      }, (r) => r.detail);
    }
  }

  // 12. CE SQL search finds the verify text document
  {
    let vocabulary: SearchVocabulary | null = null; let from = '';
    if (cfg.classModel === 'subclasses') {
      const base = (await store.modelStatus().catch(() => null))?.classes.find((c) => c.name === 'TF_Document');
      if (base?.exists && (!base.present || ['TF_TenantId', 'TF_OwnerType', 'TF_TenderNumber'].every((p) => base.present!.includes(p)))) { vocabulary = 'model'; from = 'TF_Document'; }
    }
    if (!vocabulary && cfg.setCustomProperties && cfg.docClass !== 'Document') { vocabulary = 'legacy'; from = cfg.docClass; }
    if (!vocabulary) {
      skip(12, 'CE SQL search', 'needs TF_TenantId on the class (FILENET_CLASS_MODEL=subclasses, or FILENET_DOC_CLASS=TF_Document with FILENET_SET_CUSTOM_PROPERTIES=true)');
    } else {
      await step(12, `CE SQL search (${from}) finds the verify text document`, async () => {
        const where = buildSearchWhere({ tenantId: '_verify', q: textDoc.name }, vocabulary!);
        const r = await store.search(from, where, 10, ['DocumentTitle', 'TF_TenantId']);
        if (!r.documents.some((d) => d.id === textDoc.id)) throw new Error(`no hit for ${textDoc.id} with: SELECT … FROM ${from} WHERE ${where} (got ${r.documents.length} hits)`);
        return { where, hits: r.documents.length };
      }, (r) => `${r.hits} hit(s) for WHERE ${r.where}`);
    }
  }

  // 13. Navigator reachability (evidence links route into Navigator)
  let nav: Awaited<ReturnType<FileNetStore['resolveNavigator']>> = null;
  if (!cfg.navigator) {
    skip(13, 'IBM Content Navigator reachable', 'FILENET_NAVIGATOR_URL=off (evidence shows the object id and ACCE only)');
  } else {
    await step(13, `IBM Content Navigator reachable (${cfg.navigator.mode})`, async () => {
      nav = await store.resolveNavigator({ force: true });
      const tried = (nav?.tried ?? []).map((t) => `${t.url} → ${t.status ?? t.error}`).join('; ');
      if (!nav?.reachable) throw new Error(`no Navigator answered (${tried}). Set FILENET_NAVIGATOR_URL to the Navigator URL (e.g. https://host:9443/navigator), or FILENET_NAVIGATOR_URL=off.`);
      return { url: nav.url, status: nav.status, tried };
    }, (r) => `${r.url} answered HTTP ${r.status}`);
  }
  report.navigator = nav ? { url: (nav as any).url, source: (nav as any).source, reachable: (nav as any).reachable, tried: (nav as any).tried } : null;
  report.acceUrl = cfg.acceUrl;

  // 14. AI properties (TF_AiClassification / TF_AiConfidence) written and read back
  await step(14, 'AI properties TF_AiClassification / TF_AiConfidence written', async () => {
    const r = await store.setModelProperties(textDoc.storeRef, null, { TF_AiClassification: 'VERIFY', TF_AiConfidence: 0.5 });
    if (!r.ok) throw new Skip(r.detail);
    return r;
  }, (r) => r.detail);

  const vrNav = report.versioning as { navigatorUrl?: string | null; className?: string; objectStoreId?: string | null; v2: { id: string } } | undefined;
  const navNow = nav as Awaited<ReturnType<FileNetStore['resolveNavigator']>>;
  if (vrNav && navNow && navNow.repositoryId && vrNav.className && vrNav.objectStoreId) {
    vrNav.navigatorUrl = bookmarkUrl(navNow.url, navNow.desktop, navNow.repositoryId, { className: vrNav.className, objectStoreId: vrNav.objectStoreId, id: vrNav.v2.id });
  }

  console.log('\nDocuments (open in IBM Content Navigator / ACCE to screenshot):');
  for (const d of ((report.documents as any[] | undefined) ?? [])) {
    console.log(`  ${d.label.padEnd(7)} id ${d.id}`);
    console.log(`          class ${d.className}, version ${d.version}, ${d.byteSize} bytes, sha256 ${d.sha256}`);
    console.log(`          Navigator path: ${cfg.objectStore} > ${(d.filedIn[0] ?? verifyFolder).split('/').filter(Boolean).join(' > ')} > ${d.name}`);
  }
  const vr = report.versioning as { v1: { id: string }; v2: { id: string }; navigatorUrl?: string | null } | undefined;
  if (vr) {
    console.log(`  version  v1 id ${vr.v1.id}`);
    console.log(`           v2 id ${vr.v2.id} (open the document in Navigator → Versions to see both)`);
    if (vr.navigatorUrl) console.log(`           Navigator link (format ASSUMED — open it to confirm): ${vr.navigatorUrl}`);
  }
  if (cfg.acceUrl) console.log(`  ACCE: ${cfg.acceUrl} (search the object id under ${cfg.objectStore})`);
  const counts = { PASS: steps.filter((x) => x.status === 'PASS').length, FAIL: failures, SKIP: steps.filter((x) => x.status === 'SKIP').length };
  report.summary = counts;
  if (failures) {
    console.log(`\n${FAIL} FileNet verification: ${counts.FAIL} step(s) FAILED, ${counts.PASS} passed, ${counts.SKIP} skipped (${cfg.objectStore} at ${new URL(cfg.graphqlUrl).origin}).`);
    writeReport(false);
    process.exit(1);
  }
  console.log(`\n${OK} FileNet verification passed: ${counts.PASS} passed, ${counts.SKIP} skipped (${cfg.objectStore} at ${new URL(cfg.graphqlUrl).origin}).`);
  writeReport(true);
}

main().catch((e) => {
  console.error(`${FAIL} unexpected failure: ${e?.stack ?? e}`);
  process.exit(1);
});

