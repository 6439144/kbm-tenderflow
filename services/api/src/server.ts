// Entry point: `node dist/server.js` (or `tsx src/server.ts`).
import { ConfigError, loadConfig, loadDotEnv } from './config.js';
import { createApp } from './app.js';

async function main() {
  loadDotEnv();
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) { console.error(err.message); process.exit(1); }
    throw err;
  }
  const handle = await createApp(config);
  const server = handle.app.listen(config.port, () => {
    console.log(`[tenderflow] API listening on :${config.port} (db=${handle.ctx.db.kind}, content=${handle.ctx.store.type}, ai=${handle.ctx.ai.isConfigured() ? 'configured' : 'NOT configured'})`);
  });
  const shutdown = () => {
    server.close(() => { handle.close().then(() => process.exit(0), () => process.exit(1)); });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[tenderflow] startup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
