// Database access: PostgreSQL via `pg` when DATABASE_URL is set, otherwise embedded PGlite
// persisted at DATA_DIR/pg. Same SQL for both.
import fs from 'node:fs';
import path from 'node:path';
import { API_ROOT } from './config.js';

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
}
export interface Db extends Queryable {
  kind: 'postgres' | 'pglite';
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export async function openDb(opts: { databaseUrl?: string; dataDir: string }): Promise<Db> {
  if (opts.databaseUrl) {
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 10 });
    // Fail fast if unreachable.
    await pool.query('SELECT 1');
    return {
      kind: 'postgres',
      async query(sql, params) { return (await pool.query(sql, params as any[])).rows; },
      async exec(sql) { await pool.query(sql); },
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn({ query: async (s, p) => (await client.query(s, p as any[])).rows });
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      },
      async close() { await pool.end(); },
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = path.join(opts.dataDir, 'pg');
  fs.mkdirSync(dir, { recursive: true });
  const lite = new PGlite(dir);
  await lite.waitReady;
  return {
    kind: 'pglite',
    async query(sql, params) { return (await lite.query<any>(sql, params as any[])).rows; },
    async exec(sql) { await lite.exec(sql); },
    async tx(fn) {
      return lite.transaction(async (t) => fn({ query: async (s, p) => (await t.query<any>(s, p as any[])).rows }));
    },
    async close() { await lite.close(); },
  };
}

export const MIGRATIONS_DIR = path.join(API_ROOT, 'migrations');

export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ version: string }>('SELECT version FROM schema_migrations')).map((r) => r.version));
  const files = fs.readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    if (db.kind === 'pglite') {
      // PGlite: exec inside a transaction block
      await db.exec(`BEGIN;\n${sql}\nINSERT INTO schema_migrations(version) VALUES ('${f.replace(/'/g, "''")}');\nCOMMIT;`);
    } else {
      await db.tx(async (q) => {
        await q.query(sql);
        await q.query('INSERT INTO schema_migrations(version) VALUES ($1)', [f]);
      });
    }
    applied.push(f);
  }
  return applied;
}
