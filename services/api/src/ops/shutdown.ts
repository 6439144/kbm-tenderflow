// Graceful shutdown (OpenShift sends SIGTERM, waits terminationGracePeriodSeconds, then SIGKILL):
//   1. /ready answers 503 so the Service/Route stop sending new requests to this pod;
//   2. after SHUTDOWN_DELAY_MS (endpoint removal propagates) the listener closes: no new connections,
//      idle keep-alive connections are closed, in-flight requests finish;
//   3. connections still open after SHUTDOWN_TIMEOUT_MS are closed;
//   4. the app closes: background jobs stop (scheduler waits for running jobs) and the database is closed.
// Keep SHUTDOWN_DELAY_MS + SHUTDOWN_TIMEOUT_MS + a few seconds below terminationGracePeriodSeconds.
import type { Server } from 'node:http';
import type { AppHandle } from '../app.js';

export interface ShutdownOptions { delayMs: number; timeoutMs: number; log?: (msg: string) => void }
export interface ShutdownResult { forcedConnections: boolean; ms: number }

export async function gracefulShutdown(server: Server, handle: Pick<AppHandle, 'startDraining' | 'close'>, opts: ShutdownOptions): Promise<ShutdownResult> {
  const started = Date.now();
  const log = opts.log ?? (() => undefined);
  handle.startDraining();
  if (opts.delayMs > 0) {
    log(`draining: /ready answers 503; closing the listener in ${opts.delayMs} ms`);
    await new Promise((r) => setTimeout(r, opts.delayMs));
  }
  let forced = false;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      forced = true;
      log(`connections still open after ${opts.timeoutMs} ms: closing them`);
      server.closeAllConnections();
    }, opts.timeoutMs);
    timer.unref();
    // Keep-alive connections become idle when their in-flight request finishes: close them as soon as they do.
    const idle = setInterval(() => server.closeIdleConnections(), 100);
    idle.unref();
    server.close(() => { clearTimeout(timer); clearInterval(idle); resolve(); });
    server.closeIdleConnections();
  });
  log('listener closed; stopping background jobs and closing the database');
  await handle.close();
  return { forcedConnections: forced, ms: Date.now() - started };
}
