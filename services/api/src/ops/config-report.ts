// `npm run config:check` engine: every configuration check (ops/checks.ts) plus the real start-up validation
// (loadConfig) and, with --connect, a PostgreSQL round trip and the pending-migration count.
// Output never contains secret values: messages are built without them and every line is also scrubbed against
// the secret variables' values as a second line of defence.
import { ConfigError, loadConfig } from '../config.js';
import { evaluateConfig, isSecretVar, tfEnvOf, type CheckLevel } from './checks.js';

export interface ReportLine { id: string; level: CheckLevel; message: string }
export interface ConfigReport { tfEnv: string; checks: ReportLine[]; fails: number; warns: number; exitCode: 0 | 1 }

/** Replace any secret value (and the password of DATABASE_URL) that might appear in `text`. */
export function scrubSecrets(text: string, env: NodeJS.ProcessEnv): string {
  const values = new Set<string>();
  for (const [k, v] of Object.entries(env)) {
    if (!v || !isSecretVar(k)) continue;
    const t = v.trim();
    if (t.length >= 4) values.add(t);
    for (const part of t.split(/\r?\n|\\n/)) if (part.trim().length >= 8) values.add(part.trim()); // PEM lines
  }
  try {
    const u = env.DATABASE_URL ? new URL(env.DATABASE_URL) : null;
    if (u?.password) { values.add(u.password); values.add(decodeURIComponent(u.password)); }
  } catch { /* not a URL */ }
  let out = text;
  for (const v of [...values].sort((a, b) => b.length - a.length)) out = out.split(v).join('***');
  return out;
}

export async function buildConfigReport(env: NodeJS.ProcessEnv, opts: { connect?: boolean } = {}): Promise<ConfigReport> {
  const checks: ReportLine[] = evaluateConfig(env).map(({ id, level, message }) => ({ id, level, message }));

  // The real start-up validation: anything it rejects that a check above did not already explain.
  try {
    loadConfig(env);
    checks.push({ id: 'STARTUP', level: 'OK', message: 'start-up validation passes' });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    const reasons = err.message.split('\n').filter((l) => l.startsWith('  - ')).map((l) => l.slice(4));
    checks.push({ id: 'STARTUP', level: 'FAIL', message: `the API would refuse to start (${reasons.length} reason${reasons.length === 1 ? '' : 's'} above)` });
  }

  if (opts.connect) {
    const url = env.DATABASE_URL?.trim();
    if (!url) checks.push({ id: 'DB_CONNECT', level: 'WARN', message: 'PGlite: not opened by config:check (it would lock the data directory of a running server)' });
    else {
      const pg = (await import('pg')).default;
      const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5_000 });
      try {
        await pool.query('SELECT 1');
        checks.push({ id: 'DB_CONNECT', level: 'OK', message: 'PostgreSQL reachable' });
        const { pendingMigrations } = await import('../db.js');
        const pending = await pendingMigrations({ query: async (s: string, p?: unknown[]) => (await pool.query(s, p as any[])).rows });
        checks.push({ id: 'MIGRATIONS', level: pending.length ? 'WARN' : 'OK',
          message: pending.length ? `${pending.length} migration(s) pending (applied automatically at start-up): ${pending.join(', ')}` : 'all migrations applied' });
      } catch (err) {
        checks.push({ id: 'DB_CONNECT', level: 'FAIL', message: `PostgreSQL not reachable: ${(err as Error).message}` });
      } finally {
        await pool.end().catch(() => undefined);
      }
    }
  }

  const scrubbed = checks.map((c) => ({ ...c, message: scrubSecrets(c.message, env) }));
  const fails = scrubbed.filter((c) => c.level === 'FAIL').length;
  return { tfEnv: tfEnvOf(env) ?? 'invalid', checks: scrubbed, fails, warns: scrubbed.filter((c) => c.level === 'WARN').length, exitCode: fails ? 1 : 0 };
}

export function formatReport(r: ConfigReport): string {
  const lines = [`TenderFlow configuration check — TF_ENV=${r.tfEnv}`, ''];
  for (const c of r.checks) lines.push(`[${c.level.padEnd(4)}] ${c.id.padEnd(26)} ${c.message}`);
  lines.push('', r.fails ? `${r.fails} FAIL, ${r.warns} WARN — fix every FAIL before starting.` : `No FAIL (${r.warns} WARN).`);
  return lines.join('\n');
}
