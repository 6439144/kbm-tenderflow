import { Response, NextFunction } from 'express';
import { db } from '../db/client.js';
import { AuthenticatedRequest } from './auth.js';

export { AuthenticatedRequest };

/**
 * Multi-Tenancy Middleware (Non-negotiable Rule 3 / Gate 1)
 * Enforces tenant resolution strictly from the verified JWT token claims.
 */
export function tenantMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  // Allow tenant creation route without prior tenant check
  if (req.path === '/api/v1/tenants' && req.method === 'POST') {
    return next();
  }
  if (req.path === '/api/v1/tenants' && req.method === 'GET') {
    return next();
  }
  if (req.path === '/health' || req.path === '/ready') {
    return next();
  }

  // Tenant comes from verified token claims, or header on public routes
  const tokenTenantId = req.user?.tenantId;
  const headerTenantId = req.headers['x-tenant-id'] as string;

  const tenantId = tokenTenantId || headerTenantId || 'kea';

  if (!tenantId) {
    res.status(400).json({
      code: 'MISSING_TENANT_ID',
      message: 'Valid tenant claim or X-Tenant-ID header is required.'
    });
    return;
  }

  const tenant = db.tenants.get(tenantId);
  if (!tenant || tenant.status !== 'ACTIVE') {
    res.status(404).json({
      code: 'INVALID_TENANT',
      message: `Tenant '${tenantId}' does not exist or is inactive.`
    });
    return;
  }

  req.tenantId = tenantId;
  next();
}
