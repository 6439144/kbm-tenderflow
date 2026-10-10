// npm run config:check [-- --connect] [-- --json]
// Prints every configuration check as OK / WARN / FAIL without printing secret values; exits 1 on any FAIL.
// Reads the environment plus `.env` at the repo root (or TF_ENV_FILE), exactly like the server.
// --connect  also connects to PostgreSQL (DATABASE_URL) and reports pending migrations.
// --json     machine-readable output.
import path from 'node:path';
import { REPO_ROOT, loadDotEnv } from '../config.js';
import { buildConfigReport, formatReport } from '../ops/config-report.js';

async function main() {
  const args = new Set(process.argv.slice(2));
  loadDotEnv(process.env.TF_ENV_FILE || path.join(REPO_ROOT, '.env'));
  const report = await buildConfigReport(process.env, { connect: args.has('--connect') });
  console.log(args.has('--json') ? JSON.stringify(report, null, 2) : formatReport(report));
  process.exitCode = report.exitCode;
}

main().catch((err) => {
  console.error('[config:check] failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
