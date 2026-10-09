// Document intelligence routes (classification + cited data extraction by the watsonx Orchestrate agent
// tenderflow_document_intelligence, human review, accepted data put to work) and the automatic queue wiring.
// Access to an insight = access to the document (shared rule); sealed bids are never read before opening.
import type express from 'express';
import type { Ctx } from '../ctx.js';
import { STAFF_ROLES } from '../ctx.js';
import { actor, h, requireRoles } from '../routes.js';
import { onDocumentEvent } from '../services/document-events.js';
import { createDocumentType, listDocumentTypes, patchDocumentType } from '../services/doc-catalogue.js';
import * as di from './docintel/service.js';

export function registerDocumentIntelligenceRoutes(r: express.Router, ctx: Ctx): void {
  // Automatic runs: after upload (plain documents), at the opening and at the financial opening (sealed bids).
  onDocumentEvent(ctx, async (c, e) => {
    if (e.type === 'UPLOADED') await di.onUploaded(c, e.actor, e.documentIds);
    else if (e.type === 'BIDS_OPENED') await di.onBidsOpened(c, e.actor, e.tenderId, 'OPENING');
    else if (e.type === 'FINANCIAL_OPENED') await di.onBidsOpened(c, e.actor, e.tenderId, 'FINANCIAL_OPENING');
  });

  r.post('/documents/:id/ai/classify', h(async (req, res) => { res.status(201); return di.classifyManually(ctx, actor(req), req.params.id); }));
  r.get('/documents/:id/insight', h((req) => di.documentInsight(ctx, actor(req), req.params.id)));
  r.get('/document-insights/latest', h((req) => di.latestForDocuments(ctx, actor(req), req.query.documentIds)));
  r.get('/document-insights', requireRoles(...STAFF_ROLES), h((req) => di.insightQueue(ctx, actor(req), req.query as Record<string, unknown>)));
  r.post('/document-insights/:id/review', h((req) => di.reviewInsight(ctx, actor(req), req.params.id, req.body)));
  r.post('/document-insights/:id/apply-classification', requireRoles('PROCUREMENT_OFFICER', 'TENANT_ADMIN'),
    h(async (req, res) => { res.status(201); return di.applyClassification(ctx, actor(req), req.params.id, req.body); }));

  // Accepted data at work
  r.get('/vendor/me/verified-documents', requireRoles('VENDOR'), h((req) => di.verifiedDocuments(ctx, actor(req), actor(req).vendorId ?? '')));
  r.get('/vendors/:id/verified-documents', requireRoles('PROCUREMENT_OFFICER', 'DIRECTOR', 'TENANT_ADMIN', 'AUDITOR'),
    h((req) => di.verifiedDocuments(ctx, actor(req), req.params.id)));
  r.get('/tenders/:id/extracted-totals', requireRoles('COMMITTEE_CHAIR', 'EVALUATOR', 'DIRECTOR', 'UNDERSECRETARY'),
    h((req) => di.extractedTotals(ctx, actor(req), req.params.id)));

  // Catalogue (per entity)
  r.get('/document-types', requireRoles(...STAFF_ROLES), h((req) => listDocumentTypes(ctx, actor(req), req.query.all === 'true')));
  r.post('/document-types', requireRoles('TENANT_ADMIN'), h(async (req, res) => { res.status(201); return createDocumentType(ctx, actor(req), req.body); }));
  r.patch('/document-types/:id', requireRoles('TENANT_ADMIN'), h((req) => patchDocumentType(ctx, actor(req), req.params.id, req.body)));
}
