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
import { securityGate } from './features/security.js';
import { closeDueTenders } from './services/tenders.js';
import { seedDemo } from './seed.js';
import { resolveTenancy } from './tenancy.js';

/**
 * HARDEN: Content-Security-Policy of the single-page app and the API (docs/SECURITY-FEATURES.md). No inline or remote
 * scripts; the pdf.js worker is a same-origin file. style-src keeps 'unsafe-inline' because the server-generated HTML
 * records (opening record, committee report, notices) carry an inline <style> and are opened as blob: documents,
 * which inherit this policy. Document downloads (sendDoc) override it with a sandboxing policy of their own.
 */
export const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:', 'blob:'],
  workerSrc: ["'self'", 'blob:'],
  connectSrc: ["'self'"],
  frameAncestors: ["'none'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
};

export interface AppHandle {
  app: express.Express; ctx: Ctx; close(): Promise<void>;
  /** Graceful shutdown has begun: /ready answers 503 so the router stops sending new requests (ops). */
  startDraining(): void;
}

export async function createApp(baseConfig: Config, overrides: { store?: ContentStore; ai?: AiService } = {}): Promise<AppHandle> {
  fs.mkdirSync(baseConfig.dataDir, { recursive: true });
  const db = await openDb({ databaseUrl: baseConfig.databaseUrl, dataDir: baseConfig.dataDir });
  // Deployment model (tenancy.ts): bind a dedicated installation to its entity before anything can serve a request.
  let config: Config;
  let tenantIds: string[];
  try {
    await migrate(db);
    tenantIds = (await db.query<{ id: string }>('SELECT id FROM tenants ORDER BY id')).map((r) => r.id);
    const t = resolveTenancy(baseConfig, tenantIds);
    for (const w of t.warnings) console.warn(`[tenancy] ${w}`);
    config = { ...baseConfig, tenancyMode: t.mode, entityId: t.entityId ?? undefined };
  } catch (err) {
    await db.close();
    throw err;
  }
  const store = overrides.store ?? createContentStore({ type: config.contentStoreType, dataDir: config.dataDir });
  const ai = overrides.ai ?? createAiService();
  const tokens = await TokenService.init(db, config);
  const ctx: Ctx = { db, config, store, ai, tokens };

  // Demo seed on an empty database: a dedicated installation seeds only its own (demo) entity, shared mode all three.
  if (config.seedDemo && tenantIds.length === 0)
    await seedDemo(ctx, config.tenancyMode === 'dedicated' && config.entityId ? [config.entityId] : undefined);
  if (!process.env.NODE_TEST_CONTEXT) console.log(config.tenancyMode === 'dedicated'
    ? `[tenancy] dedicated installation for entity '${config.entityId ?? '(not provisioned yet)'}'`
    : '[tenancy] shared installation (several entities)');

  const app = express();
  app.disable('x-powered-by');
  // HARDEN: TRUST_PROXY (default off) — only then is X-Forwarded-For used for req.ip (staff allowlist, lockout audit).
  app.set('trust proxy', config.trustProxy);
  let draining = false;
  app.use(helmet({ contentSecurityPolicy: { useDefaults: false, directives: CSP_DIRECTIVES }, crossOriginEmbedderPolicy: false }));
  if (config.corsOrigin) app.use(cors({ origin: config.corsOrigin.split(',').map((s) => s.trim()), credentials: false }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => { res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) }); });
  // HARDEN: probes and the public get { status } only; dependency details only for a signed-in TENANT_ADMIN / AUDITOR.
  const readyDetailsAllowed = async (req: express.Request): Promise<boolean> => {
    const hdr = req.headers.authorization;
    if (!hdr || !/^Bearer\s+\S+$/i.test(hdr)) return false;
    try {
      const a = await tokens.verify(hdr.replace(/^Bearer\s+/i, '').trim());
      await securityGate(ctx, req, a);
      return a.roles.some((r) => r === 'TENANT_ADMIN' || r === 'AUDITOR');
    } catch { return false; }
  };
  app.get('/ready', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const details = await readyDetailsAllowed(req);
    if (draining) { res.status(503).json({ status: 'not_ready' }); return; } // ops: shutting down
    const checks: Record<string, { ok: boolean; detail: string }> = {};
    try { await db.query('SELECT 1'); checks.database = { ok: true, detail: `${db.kind} reachable` }; }
    catch (err) { checks.database = { ok: false, detail: (err as Error).message }; }
    try { checks.contentStore = await store.ping(); }
    catch (err) { checks.contentStore = { ok: false, detail: (err as Error).message }; }
    checks.contentStore.detail = `${store.type}: ${checks.contentStore.detail}`;
    try { const p = await pendingMigrations(db); checks.migrations = { ok: !p.length, detail: p.length ? `${p.length} pending` : 'all applied' }; }
    catch (err) { checks.migrations = { ok: false, detail: (err as Error).message }; }
    const ready = checks.database.ok && checks.contentStore.ok && checks.migrations.ok;
    if (!details) { res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' }); return; }
    if (ai.isConfigured()) {
      try { checks.ai = await ai.ping(); } catch (err) { checks.ai = { ok: false, detail: (err as Error).message }; }
    } else checks.ai = { ok: false, detail: 'AI not configured (WXO_INSTANCE_URL / WXO_API_KEY); AI endpoints return 503 AI_NOT_CONFIGURED' };
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
