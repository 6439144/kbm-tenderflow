// Entry point: `node dist/server.js` (or `tsx src/server.ts`).
import { ConfigError, loadConfig, loadDotEnv } from './config.js';
import { createApp } from './app.js';
import { gracefulShutdown } from './ops/shutdown.js';
import { versionInfo } from './ops/version.js';

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
  const v = versionInfo();
  const server = handle.app.listen(config.port, () => {
    console.log(`[tenderflow] ${v.version}${v.commit ? ` (${v.commit.slice(0, 12)})` : ''} API listening on :${config.port} (env=${config.tfEnv}, db=${handle.ctx.db.kind}, content=${handle.ctx.store.type}, ai=${handle.ctx.ai.isConfigured() ? 'configured' : 'NOT configured'})`);
  });
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) { console.warn(`[tenderflow] ${signal} again during shutdown: exiting now`); process.exit(1); }
    stopping = true;
    console.log(`[tenderflow] ${signal} received: graceful shutdown`);
    // Fail-safe: never hang past the grace period (OpenShift would SIGKILL anyway).
    const hard = setTimeout(() => { console.error('[tenderflow] shutdown did not finish in time: exiting'); process.exit(1); },
      config.shutdownDelayMs + config.shutdownTimeoutMs + 10_000);
    hard.unref();
    gracefulShutdown(server, handle, { delayMs: config.shutdownDelayMs, timeoutMs: config.shutdownTimeoutMs, log: (m) => console.log(`[shutdown] ${m}`) })
      .then((r) => { console.log(`[tenderflow] stopped in ${r.ms} ms`); process.exit(0); },
        (err) => { console.error('[tenderflow] shutdown failed:', err instanceof Error ? err.message : err); process.exit(1); });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[tenderflow] startup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
