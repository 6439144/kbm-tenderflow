// REST API routes (docs/BUILD-SPEC.md §6).
import express, { type NextFunction, type Request, type Response, type RequestHandler } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import type { Ctx } from './ctx.js';
import { assertRole } from './ctx.js';
import { STAFF_ROLES } from './ctx.js';
import type { Actor } from './auth/tokens.js';
import { unauthorized } from './auth/tokens.js';
import { ApiError, camel, forbidden } from './util.js';
import * as identity from './services/identity.js';
import * as vendors from './services/vendors.js';
import * as tenders from './services/tenders.js';
import * as bids from './services/bids.js';
import * as award from './services/award.js';
import * as aiRuns from './services/ai-runs.js';
import { downloadDocument, MAX_UPLOAD_BYTES, type DocumentRow, type UploadFile } from './services/documents.js';
import { verifyAudit } from './services/audit.js';
import { registerPlatformRoutes } from './routes-platform.js';
import { registerFeatureRoutes, registerPublicFeatureRoutes } from './features/index.js';

declare module 'express-serve-static-core' {
  interface Request { actor?: Actor }
}

const OFFICER = 'PROCUREMENT_OFFICER';
export const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { fn(req, res).then((out) => { if (!res.headersSent) res.json(out); }).catch(next); };
export const actor = (req: Request) => req.actor!;

export function authenticate(ctx: Ctx): RequestHandler {
  return (req, _res, next) => {
    const hdr = req.headers.authorization;
    if (!hdr || !/^Bearer\s+\S+$/i.test(hdr)) return next(unauthorized());
    ctx.tokens.verify(hdr.replace(/^Bearer\s+/i, '').trim())
      .then(async (a) => {
        if (a.issuer === 'local') {
          const u = await ctx.db.query<{ active: boolean }>('SELECT active FROM users WHERE id=$1 AND tenant_id=$2', [a.id, a.tenantId]);
          if (!u[0]?.active) throw unauthorized('User is inactive or unknown');
        }
        req.actor = a;
        next();
      })
      .catch(next);
  };
}

export const requireRoles = (...roles: string[]): RequestHandler => (req, _res, next) => {
  const a = req.actor;
  if (!a) return next(unauthorized());
  if (!a.roles.some((r) => roles.includes(r))) return next(forbidden(`Requires one of roles: ${roles.join(', ')}`));
  next();
};

export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 2, fields: 20 } });

export function sendDoc(res: Response, doc: DocumentRow, bytes: Buffer) {
  res.setHeader('Content-Type', doc.mime_type.startsWith('text/') ? `${doc.mime_type}; charset=utf-8` : doc.mime_type);
  res.setHeader('Content-Length', String(bytes.length));
  const ascii = doc.title.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.title)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
  res.setHeader('X-Document-Sha256', doc.sha256_plain);
  res.end(bytes);
}

export function apiRouter(ctx: Ctx): express.Router {
  const r = express.Router();
  const auth = authenticate(ctx);

  // ---- public ----
  const loginLimiter = rateLimit({ windowMs: 60_000, limit: ctx.config.loginRateLimit, standardHeaders: 'draft-7', legacyHeaders: false,
    handler: (_req, res) => { res.status(429).json({ code: 'RATE_LIMITED', message: 'Too many login attempts, try again later' }); } });
  r.post('/auth/login', loginLimiter, h((req) => identity.login(ctx, req.body)));
  r.get('/public/tenants', h(() => identity.publicTenants(ctx)));
  r.post('/public/vendors/register', loginLimiter, h(async (req, res) => { res.status(201); return vendors.registerVendor(ctx, req.body); }));
  registerPublicFeatureRoutes(r, ctx);

  // ---- everything below requires a valid token ----
  r.use(auth);
  r.get('/auth/me', h((req) => identity.me(ctx, actor(req))));

  // Vendors
  r.get('/vendors/me', requireRoles('VENDOR'), h((req) => vendors.myVendor(ctx, actor(req))));
  r.post('/vendors/me/documents', requireRoles('VENDOR'), upload.single('file'),
    h(async (req, res) => { res.status(201); return vendors.uploadVendorDocument(ctx, actor(req), req.file as UploadFile | undefined, req.body?.title); }));
  const vendorReaders = requireRoles(OFFICER, 'DIRECTOR', 'TENANT_ADMIN', 'AUDITOR');
  r.get('/vendors', vendorReaders, h((req) => vendors.listVendors(ctx, actor(req), req.query.status)));
  r.get('/vendors/:id', vendorReaders, h((req) => vendors.getVendor(ctx, actor(req), req.params.id)));
  r.post('/vendors/:id/decision', requireRoles(OFFICER), h((req) => vendors.decideVendor(ctx, actor(req), req.params.id, req.body)));

  // Tenders
  r.get('/tenders', h((req) => tenders.listTenders(ctx, actor(req), req.query.status)));
  r.post('/tenders', requireRoles(OFFICER), h(async (req, res) => { res.status(201); return tenders.createTender(ctx, actor(req), req.body); }));
  r.get('/tenders/:id', h((req) => tenders.tenderDetail(ctx, actor(req), req.params.id)));
  r.patch('/tenders/:id', requireRoles(OFFICER), h((req) => tenders.patchTender(ctx, actor(req), req.params.id, req.body)));
  r.post('/tenders/:id/documents', requireRoles(OFFICER), upload.single('file'),
    h(async (req, res) => { res.status(201); return tenders.uploadTenderDocument(ctx, actor(req), req.params.id, req.file as UploadFile | undefined, req.body); }));
  r.post('/tenders/:id/ai/pack-check', requireRoles(OFFICER), h(async (req, res) => { res.status(201); return aiRuns.packCheck(ctx, actor(req), req.params.id, req.body); }));
  // Approval chains: the service checks the role of the level being decided (template-configured).
  r.post('/tenders/:id/approve', requireRoles('DIRECTOR', 'UNDERSECRETARY', 'COMMITTEE_CHAIR', 'TENANT_ADMIN'), h((req) => tenders.approveTender(ctx, actor(req), req.params.id, req.body)));
  r.post('/tenders/:id/return', requireRoles('DIRECTOR', 'UNDERSECRETARY', 'COMMITTEE_CHAIR', 'TENANT_ADMIN'), h((req) => tenders.returnTender(ctx, actor(req), req.params.id, req.body)));
  r.post('/tenders/:id/publish', requireRoles(OFFICER), h((req) => tenders.publishTender(ctx, actor(req), req.params.id)));
  r.post('/tenders/:id/cancel', requireRoles('DIRECTOR'), h((req) => tenders.cancelTender(ctx, actor(req), req.params.id, req.body)));

  // AI review (any staff role that can trigger AI)
  r.post('/ai-runs/:id/review', requireRoles(OFFICER, 'DIRECTOR', 'COMMITTEE_CHAIR', 'EVALUATOR'),
    h((req) => aiRuns.reviewRun(ctx, actor(req), req.params.id, req.body)));

  // Clarifications
  r.post('/tenders/:id/clarifications', requireRoles('VENDOR'),
    h(async (req, res) => { res.status(201); return tenders.askClarification(ctx, actor(req), req.params.id, req.body); }));
  r.post('/clarifications/:id/ai-draft', requireRoles(OFFICER), h(async (req, res) => { res.status(201); return aiRuns.clarificationDraft(ctx, actor(req), req.params.id); }));
  r.post('/clarifications/:id/answer', requireRoles(OFFICER), h((req) => tenders.answerClarification(ctx, actor(req), req.params.id, req.body)));

  // Bids
  r.post('/tenders/:id/bids', requireRoles('VENDOR'), upload.fields([{ name: 'technical', maxCount: 1 }, { name: 'financial', maxCount: 1 }]),
    h(async (req, res) => {
      const files = (req.files ?? {}) as Record<string, UploadFile[]>;
      res.status(201);
      return bids.submitBid(ctx, actor(req), req.params.id, { technical: files.technical?.[0], financial: files.financial?.[0] });
    }));
  r.get('/tenders/:id/bids', h((req) => bids.listBids(ctx, actor(req), req.params.id)));
  r.get('/bids/:id/documents/:docId', h(async (req, res) => {
    const { doc, bytes } = await bids.downloadBidDocument(ctx, actor(req), req.params.id, req.params.docId);
    sendDoc(res, doc, bytes);
  }));

  // Opening, screening, evaluation, award
  r.post('/tenders/:id/open', requireRoles('COMMITTEE_CHAIR'), h((req) => bids.openTender(ctx, actor(req), req.params.id, req.body)));
  r.post('/tenders/:id/ai/compliance-screen', requireRoles('COMMITTEE_CHAIR', 'EVALUATOR'),
    h(async (req, res) => { res.status(201); return aiRuns.complianceScreen(ctx, actor(req), req.params.id, req.body); }));
  r.post('/bids/:id/evaluation', requireRoles('EVALUATOR'), h((req) => award.submitEvaluation(ctx, actor(req), req.params.id, req.body)));
  r.get('/tenders/:id/evaluations', requireRoles('COMMITTEE_CHAIR', 'DIRECTOR', 'UNDERSECRETARY', 'EVALUATOR'), h((req) => award.listEvaluations(ctx, actor(req), req.params.id)));
  r.post('/tenders/:id/award/recommend', requireRoles('COMMITTEE_CHAIR'), h((req) => award.recommendAward(ctx, actor(req), req.params.id, req.body)));
  r.post('/tenders/:id/award/approve', requireRoles('DIRECTOR', 'UNDERSECRETARY', 'COMMITTEE_CHAIR', 'TENANT_ADMIN'), h((req) => award.approveAward(ctx, actor(req), req.params.id, req.body)));

  // Documents (generic, deny by default)
  r.get('/documents/:id', h(async (req, res) => {
    const { doc, bytes } = await downloadDocument(ctx, actor(req), req.params.id);
    sendDoc(res, doc, bytes);
  }));

  // Admin & audit
  r.get('/admin/users', requireRoles('TENANT_ADMIN'), h((req) => identity.listUsers(ctx, actor(req))));
  r.post('/admin/users', requireRoles('TENANT_ADMIN'), h(async (req, res) => { res.status(201); return identity.adminCreateUser(ctx, actor(req), req.body); }));
  const auditReaders = requireRoles('AUDITOR', 'TENANT_ADMIN', 'DIRECTOR');
  // Full log: auditors, admins, directors. Other staff may read the timeline of one resource (e.g. a tender).
  r.get('/audit', requireRoles(...STAFF_ROLES), h(async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
    const resourceId = typeof req.query.resourceId === 'string' && req.query.resourceId ? req.query.resourceId : null;
    if (!resourceId) assertRole(actor(req), 'AUDITOR', 'TENANT_ADMIN', 'DIRECTOR');
    const rows = await ctx.db.query(
      `SELECT seq::text AS seq, id, actor_id, actor_roles, action, resource_type, resource_id, prev_state, new_state, reason, details, at, hmac
         FROM audit_events WHERE tenant_id=$1 AND ($2::text IS NULL OR resource_id=$2) ORDER BY audit_events.seq DESC LIMIT $3`,
      [actor(req).tenantId, resourceId, limit]);
    return camel<any[]>(rows).map((x) => ({ ...x, seq: Number(x.seq) }));
  }));
  r.get('/audit/verify', auditReaders, h((req) => verifyAudit(ctx.db, ctx.config.auditSigningKey, actor(req).tenantId)));
  r.get('/dashboard', requireRoles(...STAFF_ROLES), h(async (req) => {
    const t = actor(req).tenantId;
    const byStatus = await ctx.db.query<{ status: string; n: string }>('SELECT status, count(*)::text AS n FROM tenders WHERE tenant_id=$1 GROUP BY status', [t]);
    const one = async (sql: string) => Number((await ctx.db.query<{ n: string }>(sql, [t]))[0].n);
    return {
      tendersByStatus: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])),
      vendorsPending: await one(`SELECT count(*)::text AS n FROM vendors WHERE tenant_id=$1 AND status='PENDING_REVIEW'`),
      vendorsApproved: await one(`SELECT count(*)::text AS n FROM vendors WHERE tenant_id=$1 AND status='APPROVED'`),
      bids: await one('SELECT count(*)::text AS n FROM bids WHERE tenant_id=$1'),
      openClarifications: await one(`SELECT count(*)::text AS n FROM clarifications WHERE tenant_id=$1 AND status='OPEN'`),
      aiRuns: await one('SELECT count(*)::text AS n FROM ai_runs WHERE tenant_id=$1'),
      aiRunsFailed: await one(`SELECT count(*)::text AS n FROM ai_runs WHERE tenant_id=$1 AND status='ERROR'`),
    };
  }));

  registerPlatformRoutes(r, ctx);
  registerFeatureRoutes(r, ctx);

  r.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'No such API route')));
  return r;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    const extra = err.details && typeof err.details === 'object' ? err.details : {};
    res.status(err.status).json({ code: err.code, message: err.message, ...extra });
    return;
  }
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    res.status(status).json({ code: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'UPLOAD_ERROR', message: err.message });
    return;
  }
  const e = err as any;
  if (e?.type === 'entity.too.large') { res.status(413).json({ code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' }); return; }
  if (e?.type === 'entity.parse.failed') { res.status(400).json({ code: 'INVALID_JSON', message: 'Malformed JSON body' }); return; }
  console.error('[api] unhandled error:', err);
  res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
}
