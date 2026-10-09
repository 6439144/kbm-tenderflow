// watsonx Orchestrate across the whole cycle: the TenderFlow Assistant (supervisor agent with collaborators) in every
// portal, plus specialist agents for request intake, gazette/CAPT notices, vendor relevance, the committee narrative
// and vendor grade review. Every call is recorded as an ai_run (+ audit) and is advisory; people decide.
import type express from 'express';
import type { Ctx } from '../ctx.js';
import { STAFF_ROLES } from '../ctx.js';
import { actor, h, requireRoles } from '../routes.js';
import * as agents from './assistant/agents.js';
import { chat, myTasks } from './assistant/chat.js';
import { insights } from './assistant/insights.js';

const OFFICER = 'PROCUREMENT_OFFICER';
const DECIDERS = [OFFICER, 'DIRECTOR', 'UNDERSECRETARY', 'COMMITTEE_CHAIR', 'TENANT_ADMIN'];

export function registerAssistantRoutes(r: express.Router, ctx: Ctx): void {
  // Assistant (any signed-in user; context is role-scoped on the server)
  r.get('/assistant/status', h(async () => ({ configured: ctx.ai.isConfigured() })));
  r.get('/assistant/my-tasks', h((req) => myTasks(ctx, actor(req))));
  r.post('/assistant/chat', h(async (req, res) => { res.status(201); return chat(ctx, actor(req), req.body); }));
  r.get('/assistant/insights', requireRoles('TENANT_ADMIN', 'AUDITOR'), h((req) => insights(ctx, actor(req))));

  // Request intake → classification (template, activity codes, urgency, budget, summaries)
  r.post('/requests/:id/ai/classify', requireRoles(...DECIDERS), h(async (req, res) => { res.status(201); return agents.classifyRequest(ctx, actor(req), req.params.id); }));

  // Publication → Kuwait Al-Youm / CAPT notice draft (saved as a DRAFT notice by the officer via POST /tenders/:id/notices)
  r.post('/tenders/:id/ai/notice', requireRoles(OFFICER), h(async (req, res) => { res.status(201); return agents.draftNotice(ctx, actor(req), req.params.id, req.body); }));

  // Matching: rank vendors that already passed the eligibility rules / rank open eligible tenders for a vendor
  r.post('/tenders/:id/ai/relevance', requireRoles(...DECIDERS), h(async (req, res) => { res.status(201); return agents.rankVendorsForTender(ctx, actor(req), req.params.id); }));
  r.get('/vendor/ai/tenders-for-me', requireRoles('VENDOR'), h((req) => agents.tendersForMe(ctx, actor(req))));
  r.post('/vendor/ai/tenders-for-me', requireRoles('VENDOR'), h(async (req, res) => { res.status(201); return agents.rankTendersForMe(ctx, actor(req)); }));

  // Evaluation → committee narrative (chair), stored in the content store only when the chair saves it
  r.post('/tenders/:id/ai/narrative', requireRoles('COMMITTEE_CHAIR'), h(async (req, res) => { res.status(201); return agents.draftNarrative(ctx, actor(req), req.params.id); }));
  r.post('/ai-runs/:id/save-narrative', requireRoles('COMMITTEE_CHAIR'), h(async (req, res) => { res.status(201); return agents.saveNarrative(ctx, actor(req), req.params.id, req.body); }));
  r.get('/tenders/:id/narratives', requireRoles(...STAFF_ROLES), h((req) => agents.listNarratives(ctx, actor(req), req.params.id)));

  // Vendor grading → document checklist review
  r.post('/vendors/:id/ai/grade-review', requireRoles(OFFICER, 'TENANT_ADMIN'), h(async (req, res) => { res.status(201); return agents.gradeReview(ctx, actor(req), req.params.id, req.body); }));
  r.get('/vendors/:id/ai/grade-review', requireRoles(OFFICER, 'TENANT_ADMIN'), h((req) => agents.gradeReviews(ctx, actor(req), req.params.id)));
}
