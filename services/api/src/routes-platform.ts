// REST routes of the generic platform layer: entity profile, cycle templates, activity codes and vendor grades,
// eligibility and document purchase, two-envelope financial opening, request intake, publication channels,
// notifications.
import type express from 'express';
import type { Ctx } from './ctx.js';
import { STAFF_ROLES } from './ctx.js';
import { actor, h, requireRoles, upload } from './routes.js';
import type { UploadFile } from './services/documents.js';
import * as templates from './services/templates.js';
import * as elig from './services/eligibility.js';
import * as bids from './services/bids.js';
import * as requests from './services/requests.js';
import * as pubs from './services/publications.js';
import * as notes from './services/notifications.js';
import { loadTender } from './services/tenders.js';

const OFFICER = 'PROCUREMENT_OFFICER';
const ADMIN = 'TENANT_ADMIN';

export function registerPlatformRoutes(r: express.Router, ctx: Ctx) {
  const staff = requireRoles(...STAFF_ROLES);

  // Entity profile
  r.get('/entity/profile', h((req) => templates.getProfile(ctx, actor(req).tenantId)));
  r.put('/entity/profile', requireRoles(ADMIN), h((req) => templates.updateProfile(ctx, actor(req), req.body)));

  // Cycle templates (Cycle Designer)
  r.get('/templates', staff, h((req) => templates.listTemplates(ctx, actor(req), { includeDrafts: req.query.all === 'true' })));
  r.get('/templates/starter', staff, h(async () => templates.STARTER_TEMPLATES));
  r.post('/templates/validate', staff, h(async (req) => templates.validateTemplate(req.body)));
  r.post('/templates/install-starters', requireRoles(ADMIN), h(async (req, res) => { res.status(201); return templates.installStarterTemplates(ctx, actor(req)); }));
  r.post('/templates', requireRoles(ADMIN), h(async (req, res) => { res.status(201); return templates.createTemplate(ctx, actor(req), req.body); }));
  r.get('/templates/:id', staff, h((req) => templates.getTemplate(ctx, actor(req), req.params.id)));
  r.patch('/templates/:id', requireRoles(ADMIN), h((req) => templates.updateTemplate(ctx, actor(req), req.params.id, req.body)));
  r.post('/templates/:id/publish', requireRoles(ADMIN), h((req) => templates.publishTemplate(ctx, actor(req), req.params.id, req.body)));
  r.post('/templates/:id/default', requireRoles(ADMIN), h((req) => templates.setDefaultTemplate(ctx, actor(req), req.params.id)));

  // Activity codes & vendor grades
  r.get('/activity-codes', h((req) => elig.listActivityCodes(ctx, actor(req).tenantId)));
  r.post('/activity-codes', requireRoles(ADMIN), h((req) => elig.upsertActivityCode(ctx, actor(req), req.body)));
  r.get('/vendors/:id/classifications', staff, h((req) => elig.vendorClassifications(ctx.db, actor(req).tenantId, req.params.id)));
  r.get('/vendor/me/classifications', requireRoles('VENDOR'), h((req) => elig.vendorClassifications(ctx.db, actor(req).tenantId, actor(req).vendorId!)));
  r.post('/vendors/:id/classifications', requireRoles(OFFICER, ADMIN), h((req) => elig.setClassification(ctx, actor(req), req.params.id, req.body)));

  // Eligibility & document purchase
  r.get('/tenders/:id/eligibility', requireRoles('VENDOR'), h(async (req) => {
    const t = await loadTender(ctx, actor(req), req.params.id);
    return elig.checkEligibility(ctx.db, t, actor(req).vendorId!);
  }));
  r.post('/tenders/:id/purchase', requireRoles('VENDOR'), h(async (req, res) => {
    const t = await loadTender(ctx, actor(req), req.params.id);
    res.status(201);
    return elig.purchaseDocuments(ctx, actor(req), t, req.body);
  }));
  r.get('/tenders/:id/purchases', h(async (req) => elig.listPurchases(ctx, actor(req), await loadTender(ctx, actor(req), req.params.id))));
  r.post('/tenders/:id/fee-exemptions', requireRoles(OFFICER, 'DIRECTOR'), h(async (req, res) => {
    const t = await loadTender(ctx, actor(req), req.params.id);
    res.status(201);
    return elig.exemptVendor(ctx, actor(req), t, req.body);
  }));

  // Two-envelope: open the financial envelopes
  r.post('/tenders/:id/open-financial', requireRoles('COMMITTEE_CHAIR'), h((req) => bids.openFinancial(ctx, actor(req), req.params.id, req.body)));

  // Departmental requests
  r.get('/requests', staff, h((req) => requests.listRequests(ctx, actor(req))));
  r.post('/requests', requireRoles(OFFICER), upload.single('letter'),
    h(async (req, res) => { res.status(201); return requests.createRequest(ctx, actor(req), req.body, req.file as UploadFile | undefined); }));
  r.get('/requests/:id', staff, h((req) => requests.getRequest(ctx, actor(req), req.params.id)));
  r.post('/requests/:id/decision', requireRoles('DIRECTOR', 'UNDERSECRETARY', 'COMMITTEE_CHAIR', ADMIN), h((req) => requests.decideRequest(ctx, actor(req), req.params.id, req.body)));
  r.post('/requests/:id/convert', requireRoles(OFFICER), h(async (req, res) => { res.status(201); return requests.convertRequest(ctx, actor(req), req.params.id, req.body); }));

  // Publication channels
  r.post('/tenders/:id/notices', requireRoles(OFFICER), h(async (req, res) => { res.status(201); return pubs.saveNotice(ctx, actor(req), req.params.id, req.body); }));
  r.post('/publications/:id/approve', requireRoles('DIRECTOR', 'UNDERSECRETARY'), h((req) => pubs.approveNotice(ctx, actor(req), req.params.id)));
  r.post('/publications/:id/record', requireRoles(OFFICER), h((req) => pubs.recordPublication(ctx, actor(req), req.params.id, req.body)));

  // Notifications
  r.get('/notifications', h((req) => notes.myNotifications(ctx, actor(req))));
  r.post('/notifications/:id/read', h((req) => notes.markRead(ctx, actor(req), req.params.id)));
}
