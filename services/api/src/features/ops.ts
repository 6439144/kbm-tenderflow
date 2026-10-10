// OPS workstream: public operational endpoints under /api/v1 (no login). /health and /ready live in app.ts.
import type express from 'express';
import type { Ctx } from '../ctx.js';
import { versionInfo } from '../ops/version.js';

export function registerOpsPublicRoutes(r: express.Router, _ctx: Ctx) {
  const info = versionInfo(); // fixed for the life of the process
  r.get('/version', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(info); });
}
