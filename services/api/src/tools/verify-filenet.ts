// TenderFlow FileNet verification CLI.
//   npm run build -w services/api     (once, after pulling)
//   npm run verify:filenet            (runs node services/api/dist/tools/verify-filenet.js)
// Reads the repo-root .env, runs real calls against the configured FileNet Content Services GraphQL endpoint,
// prints ✓/✗ per step, writes docs/evidence/filenet-verify-<timestamp>.json (no secrets) and exits 1 on the
// first failure with the full server error text. Writes only under FILENET_ROOT_FOLDER/_verify.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileNetStore, FileNetError, TF_PROPERTY_NAMES } from '../content/filenet-store.js';
import { navigatorConfig, navigatorUrl } from '../content/navigator.js';

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

interface StepResult { step: number; name: string; ok: boolean; ms: number; detail?: unknown; error?: string }

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
    console.log(`${FAIL} 0 configuration: ${scrub(e.message)}`);
    steps.push({ step: 0, name: 'configuration', ok: false, ms: 0, error: scrub(e.message) });
    writeReport(false);
    process.exit(1);
  }
  const cfg = store.config;

  const run = async <T>(step: number, name: string, fn: () => Promise<T>, describe?: (r: T) => string): Promise<T> => {
    const t0 = Date.now();
    try {
      const r = await fn();
      const ms = Date.now() - t0;
      steps.push({ step, name, ok: true, ms, detail: r as unknown });
      console.log(`${OK} ${step} ${name}${describe ? ` — ${describe(r)}` : ''} (${ms} ms)`);
      return r;
    } catch (e: any) {
      const ms = Date.now() - t0;
      const msg = scrub(String(e?.message ?? e));
      const gql = e instanceof FileNetError && e.graphqlErrors ? e.graphqlErrors : undefined;
      steps.push({ step, name, ok: false, ms, error: msg, detail: gql ? { graphqlErrors: JSON.parse(scrub(JSON.stringify(gql))) } : undefined });
      console.log(`${FAIL} ${step} ${name} (${ms} ms)\n\n${msg}`);
      if (gql) console.log(`\nGraphQL errors (raw):\n${scrub(JSON.stringify(gql, null, 2))}`);
      console.log('\nIf this is a schema/shape error, run:  node services/api/dist/tools/filenet-introspect.js\nand send docs/evidence/filenet-schema-*.txt together with this report.');
      writeReport(false);
      process.exit(1);
    }
  };

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
    await run(6, `document class ${cfg.docClass} exists`, async () => {
      if (!(await store.classExists(cfg.docClass))) throw new Error(`class ${cfg.docClass} not found in ${cfg.objectStore}; see docs/filenet/ACCE-RUNBOOK.md`);
      return { class: cfg.docClass };
    });
  } else {
    console.log(`- 6 class check skipped (FILENET_DOC_CLASS=Document)`);
  }
  if (cfg.setCustomProperties) {
    await run(6, 'custom TF_* properties stored', async () => {
      const info = await store.describeDocument(textDoc.id, [...TF_PROPERTY_NAMES]);
      const expected: Record<string, string> = { TF_TenantId: '_verify', TF_TenderId: 'VERIFY', TF_VendorId: 'VERIFY', TF_DocType: 'VERIFY', TF_Sha256: textDoc.sha256 };
      const wrong = Object.entries(expected).filter(([k, v]) => info.properties[k] !== v).map(([k, v]) => `${k}: expected "${v}", got ${JSON.stringify(info.properties[k] ?? null)}`);
      if (info.className !== cfg.docClass) wrong.unshift(`className: expected ${cfg.docClass}, got ${info.className}`);
      if (wrong.length) throw new Error(`custom properties not stored as expected:\n  ${wrong.join('\n  ')}`);
      return { className: info.className, properties: info.properties };
    }, () => 'all 5 match');
  } else {
    console.log(`- 6 custom property check skipped (FILENET_SET_CUSTOM_PROPERTIES=false)`);
  }

  // 7. evidence for screenshots
  await run(7, 'read back document metadata for evidence', async () => {
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
    console.log('- 8 versioning check skipped (VERIFY_SKIP_VERSIONING=true)');
  } else {
    const vstore = new FileNetStore({ ...process.env, FILENET_VERSIONING: 'true' });
    const vName = `verify-version-${stamp}.txt`;
    const v1Bytes = Buffer.from(`TenderFlow versioning check — v1 — ${startedAt.toISOString()}\nالإصدار الأول\n`, 'utf8');
    const v2Bytes = Buffer.from(`TenderFlow versioning check — v2 (addendum) — ${startedAt.toISOString()}\nالإصدار الثاني — ملحق\n`, 'utf8');
    const props = { tenderId: 'VERIFY', vendorId: 'VERIFY', docType: 'VERIFY' };
    const v1 = await run(8, 'versioning: create v1', async () => {
      const out = await vstore.put({ tenantId: '_verify', folderPath: '/_verify', fileName: vName, mimeType: 'text/plain; charset=utf-8', bytes: v1Bytes, properties: props });
      return { storeRef: out.storeRef, id: vstore.parseStoreRef(out.storeRef).id, sha256: sha256(v1Bytes), byteSize: v1Bytes.length, meta: out.meta };
    }, (r) => `${r.id} (version ${r.meta?.versionLabel ?? '?'})`);
    const v2 = await run(8, 'versioning: check in v2 as the next major version (checkout + checkin)', async () => {
      const out = await vstore.put({ tenantId: '_verify', folderPath: '/_verify', fileName: vName, mimeType: 'text/plain; charset=utf-8', bytes: v2Bytes, properties: props, supersedesRef: v1.storeRef });
      return { storeRef: out.storeRef, id: vstore.parseStoreRef(out.storeRef).id, sha256: sha256(v2Bytes), byteSize: v2Bytes.length, meta: out.meta };
    }, (r) => `${r.id} (version ${r.meta?.versionLabel ?? '?'})`);
    await run(8, 'versioning: read v1 and v2 back and compare SHA-256', async () => {
      const a = await roundTrip(v1);
      const b = await roundTrip(v2);
      if (a.sha256 === b.sha256) throw new Error('v1 and v2 returned the same content');
      return { v1: a.sha256, v2: b.sha256 };
    }, () => 'both versions match what was uploaded');
    const vInfo = await run(8, 'versioning: describe both versions (same version series, v2 current)', async () => {
      const d1 = await vstore.describe(v1.storeRef);
      const d2 = await vstore.describe(v2.storeRef);
      const problems: string[] = [];
      if (v1.id === v2.id) problems.push('v2 has the same object id as v1');
      if (!d1.versionSeriesId || d1.versionSeriesId !== d2.versionSeriesId) problems.push(`version series differ (v1 ${d1.versionSeriesId}, v2 ${d2.versionSeriesId})`);
      if ((d2.majorVersionNumber ?? 0) <= (d1.majorVersionNumber ?? 0)) problems.push(`v2 major version ${d2.majorVersionNumber} is not above v1 major version ${d1.majorVersionNumber}`);
      if (d2.isCurrentVersion !== true) problems.push(`v2 isCurrentVersion = ${d2.isCurrentVersion}`);
      if (d1.isCurrentVersion !== false) problems.push(`v1 isCurrentVersion = ${d1.isCurrentVersion}`);
      if (problems.length) throw new Error(`versioning not as expected:\n  ${problems.join('\n  ')}`);
      return { versionSeriesId: d2.versionSeriesId, v1Version: `${d1.majorVersionNumber}.${d1.minorVersionNumber}`, v2Version: `${d2.majorVersionNumber}.${d2.minorVersionNumber}`, versions: d2.versions, className: d2.className, folders: d2.folders, navigatorUrl: navigatorUrl(navigatorConfig(), d2) };
    }, (r) => `series ${r.versionSeriesId}: ${r.v1Version} → ${r.v2Version}`);
    report.versioning = { v1: { id: v1.id, sha256: v1.sha256 }, v2: { id: v2.id, sha256: v2.sha256 }, ...vInfo };
  }

  // 9. records declaration (only when FILENET_RECORDS_MODE is property or retention)
  if (cfg.recordsMode === 'none') {
    console.log('- 9 records declaration check skipped (FILENET_RECORDS_MODE=none)');
  } else {
    await run(9, `records declaration (FILENET_RECORDS_MODE=${cfg.recordsMode})`, async () => {
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

  console.log('\nDocuments (open in IBM Content Navigator / ACCE to screenshot):');
  for (const d of (report.documents as any[])) {
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
  console.log(`\n${OK} FileNet verification passed (${cfg.objectStore} at ${new URL(cfg.graphqlUrl).origin}).`);
  writeReport(true);
}

main().catch((e) => {
  console.error(`${FAIL} unexpected failure: ${e?.stack ?? e}`);
  process.exit(1);
});

