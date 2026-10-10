// Dumps the live Content Services GraphQL type definitions TenderFlow depends on, so a failed
// verify-filenet run can be diagnosed from the real server schema.
//   node services/api/dist/tools/filenet-introspect.js
// Output: docs/evidence/filenet-schema-<timestamp>.txt (no secrets). Read-only: queries only.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileNetStore, FILENET_PROTOCOL } from '../content/filenet-store.js';

const here = dirname(fileURLToPath(import.meta.url));

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

const TYPES = [
  'DocumentPropertiesInput', 'ContentElementListInput', 'BaseContentElementInput', 'DependentObjectInput',
  'SubContentTransferInput', 'PropertyIdentifierAndScalarValue', 'FolderPropertiesInput', 'ObjectReferenceInput',
  'SubCheckinActionInput', 'ContentElementType',
  'Document', 'ContentElement', 'ContentTransfer', 'ContentTransferType', 'Folder', 'ObjectStore', 'ClassDescription',
  // FileNet workstream (class model, security, search) — the ASSUMED shapes in content/filenet-model.ts
  'PropertyDescription', 'PermissionListInput', 'PermissionInput', 'SubAccessPermissionInput', 'AccessPermissionInput',
  'Permission', 'AccessPermission', 'PermissionType', 'AccessType', 'DocumentSet',
];
const ROOT_FIELDS: { root: 'Query' | 'Mutation'; names: string[] }[] = [
  { root: 'Query', names: ['objectStore', 'folder', 'document', 'documents', 'classDescription', '_apiInfo'] },
  { root: 'Mutation', names: ['createDocument', 'createFolder', 'fileDocument', 'updateDocument'] },
];

const TYPE_REF = 'kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }';
const TYPE_QUERY = `query TfIntrospectType($name: String!) {
  __type(name: $name) {
    kind name description
    inputFields { name type { ${TYPE_REF} } defaultValue }
    fields(includeDeprecated: true) { name args { name type { ${TYPE_REF} } } type { ${TYPE_REF} } }
    enumValues(includeDeprecated: true) { name }
    possibleTypes { name }
    interfaces { name }
  }
}`;

function typeName(t: any): string {
  if (!t) return '?';
  if (t.kind === 'NON_NULL') return `${typeName(t.ofType)}!`;
  if (t.kind === 'LIST') return `[${typeName(t.ofType)}]`;
  return t.name;
}

function render(t: any): string {
  const lines: string[] = [];
  const head = `${t.kind === 'INPUT_OBJECT' ? 'input' : t.kind.toLowerCase()} ${t.name}`;
  const impl = t.interfaces?.length ? ` implements ${t.interfaces.map((i: any) => i.name).join(' & ')}` : '';
  if (t.description) lines.push(`# ${String(t.description).replace(/\n/g, '\n# ')}`);
  if (t.kind === 'SCALAR') return [...lines, `scalar ${t.name}`].join('\n');
  lines.push(`${head}${impl} {`);
  for (const f of t.inputFields ?? []) lines.push(`  ${f.name}: ${typeName(f.type)}${f.defaultValue != null ? ` = ${f.defaultValue}` : ''}`);
  for (const f of t.fields ?? []) {
    const args = f.args?.length ? `(${f.args.map((a: any) => `${a.name}: ${typeName(a.type)}`).join(', ')})` : '';
    lines.push(`  ${f.name}${args}: ${typeName(f.type)}`);
  }
  for (const e of t.enumValues ?? []) lines.push(`  ${e.name}`);
  lines.push('}');
  if (t.possibleTypes?.length) lines.push(`# possible types: ${t.possibleTypes.map((p: any) => p.name).join(', ')}`);
  return lines.join('\n');
}

async function main() {
  const root = findRepoRoot();
  const loaded = loadEnv(process.env.TF_ENV_FILE || join(root, '.env'));
  const store = new FileNetStore();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = process.env.TF_EVIDENCE_DIR || join(root, 'docs', 'evidence');
  const outFile = join(outDir, `filenet-schema-${stamp}.txt`);
  const password = process.env.FILENET_SERVICE_PASSWORD ?? '';
  const scrub = (s: string) => (password.length >= 3 ? s.split(password).join('***') : s);

  const out: string[] = [
    `# TenderFlow FileNet schema dump — ${new Date().toISOString()}`,
    `# endpoint: ${new URL(store.config.graphqlUrl).origin}${new URL(store.config.graphqlUrl).pathname}`,
    `# object store: ${store.config.objectStore}; .env ${loaded ? 'loaded' : 'not found'}; node ${process.version}`,
    `# client protocol constants: ${JSON.stringify({ ...FILENET_PROTOCOL, notFoundPattern: String(FILENET_PROTOCOL.notFoundPattern), notUniquePattern: String(FILENET_PROTOCOL.notUniquePattern) })}`,
    '',
  ];
  let failures = 0;

  const ping = await store.ping();
  out.push(`# ping: ${ping.ok ? 'ok' : 'FAILED'} — ${ping.detail}`, '');
  console.log(`${ping.ok ? '✓' : '✗'} ping: ${ping.detail}`);

  try {
    const info = await store.graphql(`query TfApiInfo($os: String) { _apiInfo(repositoryIdentifier: $os) { productVersion implementationVersion buildNumber buildDate } }`, { os: store.config.objectStore });
    out.push(`# _apiInfo: ${JSON.stringify((info as any)._apiInfo)}`, '');
  } catch (e: any) {
    out.push(`# _apiInfo FAILED: ${e.message}`, '');
  }

  for (const { root: rootType, names } of ROOT_FIELDS) {
    try {
      const data: any = await store.graphql(TYPE_QUERY, { name: rootType });
      const fields = (data.__type?.fields ?? []).filter((f: any) => names.includes(f.name));
      out.push(`# ${rootType} fields used by TenderFlow`, render({ ...data.__type, fields, inputFields: [], enumValues: [], possibleTypes: [], interfaces: [] }), '');
      console.log(`✓ ${rootType}: ${fields.map((f: any) => f.name).join(', ')}`);
    } catch (e: any) {
      failures++;
      out.push(`# ${rootType} FAILED: ${e.message}`, '');
      console.log(`✗ ${rootType}: ${e.message}`);
    }
  }

  for (const name of TYPES) {
    try {
      const data: any = await store.graphql(TYPE_QUERY, { name });
      if (!data.__type) { out.push(`# ${name}: NOT PRESENT in server schema`, ''); console.log(`- ${name}: not present`); continue; }
      out.push(render(data.__type), '');
      console.log(`✓ ${name}`);
    } catch (e: any) {
      failures++;
      out.push(`# ${name} FAILED: ${e.message}`, '');
      console.log(`✗ ${name}: ${e.message}`);
    }
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, scrub(out.join('\n')) + '\n', 'utf8');
  console.log(`\nSchema dump: ${outFile}`);
  if (failures) { console.log(`${failures} introspection queries failed (introspection may be disabled on the server).`); process.exit(1); }
}

main().catch((e) => { console.error(`✗ ${e?.message ?? e}`); process.exit(1); });
