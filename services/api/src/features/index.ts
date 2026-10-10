// Feature modules. Each registers its own routes; keep this file to one line per feature.
import type express from 'express';
import type { Ctx } from '../ctx.js';
import { registerDemoRoutes } from './demo.js';
import { registerFileNetShowcaseRoutes } from './filenet-showcase.js';
import { registerAssistantRoutes } from './assistant.js';
import { registerDocumentIntelligenceRoutes } from './document-intelligence.js';
import { registerInsightRoutes, registerPublicBoardRoutes } from './insight.js';
import { registerNotifyRoutes } from './notify.js';
import { registerSecurityRoutes } from './security.js';
import { registerMoiRoutes } from './moi.js';
import { registerHardenRoutes } from './harden.js';

export function registerFeatureRoutes(r: express.Router, ctx: Ctx) {
  registerDemoRoutes(r, ctx);
  registerFileNetShowcaseRoutes(r, ctx);
  registerAssistantRoutes(r, ctx);
  registerDocumentIntelligenceRoutes(r, ctx);
  registerMoiRoutes(r, ctx);
  registerSecurityRoutes(r, ctx);
  registerNotifyRoutes(r, ctx);
  registerInsightRoutes(r, ctx);
  registerHardenRoutes(r, ctx);
}

/** Routes that need no login (registered before the authentication middleware in routes.ts). */
export function registerPublicFeatureRoutes(r: express.Router, ctx: Ctx) {
  registerPublicBoardRoutes(r, ctx);
}
