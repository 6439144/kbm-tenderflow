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
  /**
   * Run `fn` while holding a named lock shared by every process on this database: a PostgreSQL session advisory
   * lock (`pg_advisory_lock(hashtext(name))`, released when `fn` settles or the connection dies) or, on PGlite
   * (one process, one connection), an in-process mutex. Used for migrations so two pods starting together never
   * apply the same migration twice.
   */
  withLock<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/** In-process mutex per lock name (PGlite has one connection, so its advisory locks never block itself). */
function processMutex() {
  const chains = new Map<string, Promise<unknown>>();
  return <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chains.get(name) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    chains.set(name, tail);
    void tail.then(() => { if (chains.get(name) === tail) chains.delete(name); });
    return run;
  };
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
      async withLock(name, fn) {
        const client = await pool.connect();
        let broken: Error | undefined;
        try {
          await client.query('SELECT pg_advisory_lock(hashtext($1))', [name]);
          try {
            return await fn();
          } finally {
            try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [name]); }
            catch (err) { broken = err as Error; } // the connection is destroyed below, which also drops the lock
          }
        } finally {
          client.release(broken);
        }
      },
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
    withLock: processMutex(),
  };
}

export const MIGRATIONS_DIR = path.join(API_ROOT, 'migrations');

export const MIGRATION_LOCK = 'tenderflow:migrate';

const migrationFiles = (dir: string) => fs.readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();

/** Migration files not yet recorded in `schema_migrations` (all of them on an empty database). */
export async function pendingMigrations(db: Queryable, dir = MIGRATIONS_DIR): Promise<string[]> {
  const exists = await db.query<{ t: string | null }>(`SELECT to_regclass('schema_migrations')::text AS t`);
  const done = exists[0]?.t ? new Set((await db.query<{ version: string }>('SELECT version FROM schema_migrations')).map((r) => r.version)) : new Set<string>();
  return migrationFiles(dir).filter((f) => !done.has(f));
}

/** Apply pending migrations in order, under the cluster-wide migration lock (safe when several pods start together). */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  return db.withLock(MIGRATION_LOCK, () => migrateUnlocked(db, dir));
}

async function migrateUnlocked(db: Db, dir: string): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ version: string }>('SELECT version FROM schema_migrations')).map((r) => r.version));
  const files = migrationFiles(dir);
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
