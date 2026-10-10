// npm run entity:create -- --code <code> --name-en "<English name>" --name-ar "<Arabic name>" [options]
//
// Provisions a new government entity (tenant) on the configured database: entity + profile, first administrator,
// starter cycle templates, default document types, notification templates and approval service level. Every step
// is audited. Safe to re-run: existing parts are never duplicated or overwritten (see src/ops/entity.ts).
//
// Options:
//   --colour #RRGGBB            brand colour (default #0B4F6C)
//   --sector "<text>"           sector shown on the entity profile
//   --admin-username <name>     first administrator's user name (default admin)
//   --admin-name "<text>"       first administrator's display name
//   --default-template <CODE>   PUBLIC_TENDER (default) | LIMITED_TENDER | RFP_TWO_ENVELOPE
//   --dry-run                   validate and show what would be created; write nothing
//
// Administrator password: TF_ENTITY_ADMIN_PASSWORD (at least 12 characters; never printed) or, when unset, a random
// one-time password printed ONCE on this console. It is stored only as a bcrypt hash and never written to the audit
// log. With embedded PGlite, stop the API first (one process per data directory).
import path from 'node:path';
import { ConfigError, REPO_ROOT, loadConfig, loadDotEnv } from '../config.js';
import { openDb, migrate } from '../db.js';
import type { Ctx } from '../ctx.js';
import { provisionEntity, type EntityInput } from '../ops/entity.js';
import { ApiError } from '../util.js';

const USAGE = 'usage: npm run entity:create -- --code <code> --name-en "<English name>" --name-ar "<Arabic name>" [--colour #RRGGBB] [--sector "<text>"] [--admin-username admin] [--admin-name "<text>"] [--default-template PUBLIC_TENDER] [--dry-run]';

function parseArgs(argv: string[]): { input: EntityInput; dryRun: boolean; help: boolean } {
  const map: Record<string, keyof EntityInput> = {
    '--code': 'code', '--name-en': 'nameEn', '--name-ar': 'nameAr', '--colour': 'colour', '--color': 'colour', '--sector': 'sector',
    '--admin-username': 'adminUsername', '--admin-name': 'adminDisplayName', '--default-template': 'defaultTemplate',
  };
  const input: Partial<EntityInput> = {};
  let dryRun = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    if (flag === '--dry-run') { dryRun = true; continue; }
    if (flag === '--help' || flag === '-h') { help = true; continue; }
    const key = map[flag];
    if (!key) throw new Error(`unknown option '${flag}'`);
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`option ${flag} needs a value`);
    (input as Record<string, string>)[key] = value;
  }
  return { input: input as EntityInput, dryRun, help };
}

/** A Ctx with only db + config: provisioning never touches the content store, AI or token services. */
function toolCtx(db: Ctx['db'], config: Ctx['config']): Ctx {
  const unavailable = (what: string) => new Proxy({}, { get() { throw new Error(`${what} is not available in entity:create`); } });
  return { db, config, store: unavailable('content store'), ai: unavailable('AI service'), tokens: unavailable('token service') } as unknown as Ctx;
}

async function main() {
  const { input, dryRun, help } = parseArgs(process.argv.slice(2));
  if (help) { console.log(USAGE); return; }
  if (!input.code || !input.nameEn || !input.nameAr) { console.error(USAGE); process.exitCode = 2; return; }
  loadDotEnv(process.env.TF_ENV_FILE || path.join(REPO_ROOT, '.env'));
  const config = loadConfig();
  const fromEnv = process.env.TF_ENTITY_ADMIN_PASSWORD?.trim();
  if (fromEnv) input.adminPassword = fromEnv;

  const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir });
  try {
    await migrate(db);
    const r = await provisionEntity(toolCtx(db, config), input, { dryRun });
    const c = r.created;
    const nothing = !c.tenant && !c.profile && !c.admin && !c.templates && !c.documentTypes && !c.notificationTemplates && !c.approvalSla;
    console.log(nothing ? `Entity '${r.tenantId}' is already fully provisioned: nothing changed (${db.kind}).`
      : `${dryRun ? '[dry run] would provision' : 'Provisioned'} entity '${r.tenantId}' (${db.kind}):`);
    console.log(`  entity record ............ ${c.tenant ? 'created' : 'already existed'}`);
    console.log(`  entity profile ........... ${c.profile ? 'created' : 'unchanged'}`);
    console.log(`  administrator ............ ${r.adminUsername} ${c.admin ? 'created' : '(already existed)'}`);
    console.log(`  cycle templates .......... ${c.templates} created`);
    console.log(`  document types ........... ${dryRun ? 'defaults' : `${c.documentTypes} installed`}`);
    console.log(`  notification templates ... ${dryRun ? 'defaults' : `${c.notificationTemplates} installed`}`);
    console.log(`  approval service level ... ${c.approvalSla ? 'created (48 h, escalate to next level)' : 'unchanged'}`);
    for (const w of r.warnings) console.log(`  note: ${w}`);
    if (r.oneTimePassword) {
      console.log('\nOne-time password for the administrator (shown only now; stored only as a hash):');
      console.log(`  ${r.oneTimePassword}`);
      console.log('Hand it over through a secure channel. The administrator should enrol two-step verification at first sign-in and');
      console.log('create named administrator accounts; then reset or disable this bootstrap account (Admin → Identity & access).');
    } else if (c.admin) console.log('\nAdministrator password: taken from TF_ENTITY_ADMIN_PASSWORD (not printed).');
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  if (err instanceof ConfigError) console.error(err.message);
  else if (err instanceof ApiError) console.error(`[entity:create] ${err.message}`);
  else console.error('[entity:create] failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
