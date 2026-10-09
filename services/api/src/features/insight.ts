// Insight workstream: role dashboards, procurement analytics, the auditor evidence pack and the public tender board.
// Authenticated routes are registered here; the public board is registered before authentication through
// registerPublicFeatureRoutes (features/index.ts). Every query is tenant-scoped from the token, except the public
// board, which is the one deliberate cross-entity read (see insight/public-board.ts).
import type express from 'express';
import type { Ctx } from '../ctx.js';
import { actor, h, requireRoles, sendDoc } from '../routes.js';
import { roleDashboard, approvalsWaiting } from './insight/dashboards.js';
import { analytics } from './insight/analytics.js';
import { downloadEvidencePack, generateEvidencePack, listEvidencePacks } from './insight/evidence.js';
export { registerPublicBoardRoutes } from './insight/public-board.js';

const ANALYTICS_ROLES = ['DIRECTOR', 'UNDERSECRETARY', 'TENANT_ADMIN', 'AUDITOR'];
const EVIDENCE_ROLES = ['AUDITOR', 'TENANT_ADMIN'];

export function registerInsightRoutes(r: express.Router, ctx: Ctx): void {
  // Role dashboard: one section per role the caller holds (any signed-in user).
  r.get('/insight/dashboard', h((req) => roleDashboard(ctx, actor(req))));
  r.get('/insight/approvals-waiting', requireRoles('DIRECTOR', 'UNDERSECRETARY', 'COMMITTEE_CHAIR', 'TENANT_ADMIN'), h((req) => approvalsWaiting(ctx, actor(req))));
  // Procurement analytics
  r.get('/insight/analytics', requireRoles(...ANALYTICS_ROLES), h((req) => analytics(ctx, actor(req), req.query as Record<string, unknown>)));
  // Auditor evidence pack
  r.post('/audit/evidence-pack', requireRoles(...EVIDENCE_ROLES), h(async (req, res) => { res.status(201); return generateEvidencePack(ctx, actor(req), req.body); }));
  r.get('/audit/evidence-packs', requireRoles(...EVIDENCE_ROLES), h((req) => listEvidencePacks(ctx, actor(req), req.query.tenderId)));
  r.get('/audit/evidence-packs/:id/download', requireRoles(...EVIDENCE_ROLES), h(async (req, res) => {
    const { doc, bytes } = await downloadEvidencePack(ctx, actor(req), req.params.id);
    sendDoc(res, { ...doc, title: doc.title.endsWith('.zip') ? doc.title : `${doc.title.replace(/[^\w.-]+/g, '_')}.zip` }, bytes);
  }));
}
