// Feature modules. Each registers its own routes; keep this file to one line per feature.
import type express from 'express';
import type { Ctx } from '../ctx.js';
import { registerDemoRoutes } from './demo.js';
import { registerFileNetShowcaseRoutes } from './filenet-showcase.js';
import { registerAssistantRoutes } from './assistant.js';
import { registerDocumentIntelligenceRoutes } from './document-intelligence.js';
import { registerMoiRoutes } from './moi.js';

export function registerFeatureRoutes(r: express.Router, ctx: Ctx) {
  registerDemoRoutes(r, ctx);
  registerFileNetShowcaseRoutes(r, ctx);
  registerAssistantRoutes(r, ctx);
  registerDocumentIntelligenceRoutes(r, ctx);
  registerMoiRoutes(r, ctx);
}
