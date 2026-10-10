// HARDEN workstream routes: administrator unlock of a sign-in lockout, and the protected document viewer
// (single-use 60-second grant → watermarked PDF bytes). Logic: services/login-lockout.ts, features/security/viewer.ts.
import type express from 'express';
import type { Ctx } from '../ctx.js';
import { actor, h, requireRoles } from '../routes.js';
import { adminUnlockUser } from '../services/login-lockout.js';
import { issueViewGrant, viewBytes, VIEWER_GRANT_HEADER } from './security/viewer.js';

export function registerHardenRoutes(r: express.Router, ctx: Ctx) {
  r.post('/admin/users/:id/unlock', requireRoles('TENANT_ADMIN'), h((req) => adminUnlockUser(ctx, actor(req), req.params.id, req.body)));

  r.post('/documents/:id/view-grant', h(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(201);
    return issueViewGrant(ctx, actor(req), req.params.id);
  }));
  r.get('/documents/:id/view-bytes', h(async (req, res) => {
    const bytes = await viewBytes(ctx, actor(req), req.params.id, req.headers[VIEWER_GRANT_HEADER]);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Content-Disposition', 'inline'); // no file name: nothing suggests saving it
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.end(bytes);
  }));
}
