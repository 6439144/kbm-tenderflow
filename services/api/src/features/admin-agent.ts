// AI admin builder (docs/ADMIN-AI-BUILDER.md): the watsonx Orchestrate agent tenderflow_admin_builder turns a plain-language
// admin request into a validated change proposal; a TENANT_ADMIN reviews the exact change and applies it, which creates
// DRAFTS only. Auditors may read proposals. Everything is scoped to the caller's entity.
import type express from 'express';
import type { Ctx } from '../ctx.js';
import { actor, h, requireRoles } from '../routes.js';
import * as p from './admin-agent/proposals.js';

export function registerAdminAgentRoutes(r: express.Router, ctx: Ctx): void {
  const admin = requireRoles('TENANT_ADMIN');
  const readers = requireRoles('TENANT_ADMIN', 'AUDITOR');
  r.get('/admin-agent/status', readers, h((req) => p.adminAgentStatus(ctx, actor(req))));
  // Chat with the agent → a new proposal, or a refinement of the open one (proposalId / threadId of the same administrator)
  r.post('/admin-agent/chat', admin, h(async (req, res) => { res.status(201); return p.chat(ctx, actor(req), req.body); }));
  // Structured plan without AI (what the Orchestrate tool pack calls): same validation, stored as a proposal, never applied
  r.post('/admin-agent/proposals', admin, h(async (req, res) => { res.status(201); return p.submitPlan(ctx, actor(req), req.body); }));
  r.get('/admin-agent/proposals', readers, h((req) => p.listProposals(ctx, actor(req), req.query as Record<string, unknown>)));
  r.get('/admin-agent/proposals/:id', readers, h((req) => p.getProposal(ctx, actor(req), req.params.id)));
  r.post('/admin-agent/proposals/:id/apply', admin, h((req) => p.applyProposal(ctx, actor(req), req.params.id)));
  r.post('/admin-agent/proposals/:id/discard', admin, h((req) => p.discardProposal(ctx, actor(req), req.params.id, req.body)));
}
