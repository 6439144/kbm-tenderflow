#!/usr/bin/env node
// Reset a TenderFlow DEMO installation to a fresh seed.
//
// The application cannot reset itself: its audit log is append-only and HMAC-chained by design, so no API
// can delete history. A demo reset therefore happens outside the app, with the server STOPPED:
//   npm run demo:reset            → dry run: shows what would be deleted
//   npm run demo:reset -- --yes   → deletes DATA_DIR (embedded database + filesystem content store)
// Then start the server again with SEED_DEMO=true and it reseeds both demo entities.
//
// DATA_DIR is resolved exactly like services/api/src/config.ts: environment first, then the repo-root .env
// (without overriding), default ./data, relative paths relative to the repo root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const opt = (v) => (v && v.trim() ? v.trim() : undefined);
loadDotEnv(path.join(REPO_ROOT, '.env'));
const yes = process.argv.includes('--yes');
const dataDir = path.resolve(REPO_ROOT, opt(process.env.DATA_DIR) ?? 'data');

function fail(msg) {
  console.error(`demo:reset refused: ${msg}`);
  process.exit(1);
}

// Safety rails: never delete the filesystem root, the home directory, the repository or one of its parents.
const forbidden = [path.parse(dataDir).root, os.homedir(), REPO_ROOT];
if (forbidden.includes(dataDir) || REPO_ROOT.startsWith(dataDir + path.sep)) fail(`DATA_DIR (${dataDir}) is not a dedicated data directory.`);
if (opt(process.env.DATABASE_URL))
  fail('DATABASE_URL points to an external PostgreSQL database; deleting DATA_DIR would not reset it. Recreate that database instead.');

const exists = fs.existsSync(dataDir);
const entries = exists ? fs.readdirSync(dataDir) : [];
if (exists && entries.length && !entries.some((e) => e === 'pg' || e === 'content'))
  fail(`${dataDir} does not look like a TenderFlow data directory (no pg/ or content/ inside). Contents: ${entries.slice(0, 10).join(', ')}`);

const cst = (opt(process.env.CONTENT_STORE_TYPE) ?? 'filesystem').toLowerCase();
console.log(`TenderFlow demo reset`);
console.log(`  DATA_DIR      : ${dataDir}${exists ? '' : ' (does not exist — nothing to delete)'}`);
console.log(`  contents      : ${entries.length ? entries.join(', ') : '—'}`);
console.log(`  content store : ${cst}${cst === 'filenet' ? ' — documents already stored in FileNet are NOT deleted by this script (remove the demo folder in FileNet if needed)' : ''}`);
if (!exists) process.exit(0);
if (!yes) {
  console.log('\nDry run. Stop the server, then run `npm run demo:reset -- --yes` to delete DATA_DIR.');
  console.log('Next start with SEED_DEMO=true reseeds both demo entities (kea, gcia).');
  process.exit(0);
}
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\nDeleted ${dataDir}. Start the server with SEED_DEMO=true to reseed.`);
