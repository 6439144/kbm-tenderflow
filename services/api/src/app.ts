// Application assembly: DB + migrations, content store, AI service, token service, Express app, close job.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import type { Config } from './config.js';
import { openDb, migrate, pendingMigrations } from './db.js';
import { createContentStore } from './content/index.js';
import type { ContentStore } from './content/types.js';
import { createAiService, type AiService } from './ai/index.js';
import { TokenService } from './auth/tokens.js';
import type { Ctx } from './ctx.js';
import { apiRouter, errorHandler } from './routes.js';
import { closeDueTenders } from './services/tenders.js';
import { seedDemo } from './seed.js';

export interface AppHandle {
  app: express.Express; ctx: Ctx; close(): Promise<void>;
  /** Graceful shutdown has begun: /ready answers 503 so the router stops sending new requests (ops). */
  startDraining(): void;
}

export async function createApp(config: Config, overrides: { store?: ContentStore; ai?: AiService } = {}): Promise<AppHandle> {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir });
  try {
    await migrate(db);
  } catch (err) {
    await db.close();
    throw err;
  }
  const store = overrides.store ?? createContentStore({ type: config.contentStoreType, dataDir: config.dataDir });
  const ai = overrides.ai ?? createAiService();
  const tokens = await TokenService.init(db, config);
  const ctx: Ctx = { db, config, store, ai, tokens };

  if (config.seedDemo) {
    const tenants = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM tenants');
    if (Number(tenants[0].n) === 0) await seedDemo(ctx);
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  let draining = false;
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  if (config.corsOrigin) app.use(cors({ origin: config.corsOrigin.split(',').map((s) => s.trim()), credentials: false }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => { res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) }); });
  app.get('/ready', async (_req, res) => {
    if (draining) { res.status(503).json({ status: 'not_ready' }); return; } // ops: shutting down
    const checks: Record<string, { ok: boolean; detail: string }> = {};
    try { await db.query('SELECT 1'); checks.database = { ok: true, detail: `${db.kind} reachable` }; }
    catch (err) { checks.database = { ok: false, detail: (err as Error).message }; }
    try { checks.contentStore = await store.ping(); }
    catch (err) { checks.contentStore = { ok: false, detail: (err as Error).message }; }
    checks.contentStore.detail = `${store.type}: ${checks.contentStore.detail}`;
    if (ai.isConfigured()) {
      try { checks.ai = await ai.ping(); } catch (err) { checks.ai = { ok: false, detail: (err as Error).message }; }
    } else checks.ai = { ok: false, detail: 'AI not configured (WXO_INSTANCE_URL / WXO_API_KEY); AI endpoints return 503 AI_NOT_CONFIGURED' };
    try { const p = await pendingMigrations(db); checks.migrations = { ok: !p.length, detail: p.length ? `${p.length} pending` : 'all applied' }; }
    catch (err) { checks.migrations = { ok: false, detail: (err as Error).message }; }
    const ready = checks.database.ok && checks.contentStore.ok && checks.migrations.ok;
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
  });
  app.get('/.well-known/jwks.json', (_req, res) => { res.json(tokens.jwks()); });
  app.use('/api/v1', apiRouter(ctx));

  if (fs.existsSync(path.join(config.webDistDir, 'index.html'))) {
    app.use(express.static(config.webDistDir, { index: false }));
    app.get(/^\/(?!api\/|api$|\.well-known\/).*/, (_req, res) => { res.sendFile(path.join(config.webDistDir, 'index.html')); });
  }
  app.use(errorHandler);

  const timer = setInterval(() => {
    closeDueTenders(ctx).catch((err) => console.error('[close-job] failed:', (err as Error).message));
  }, config.closeJobIntervalMs);
  timer.unref();

  return {
    app, ctx,
    startDraining() { draining = true; },
    async close() { clearInterval(timer); await db.close(); },
  };
}
