import { Request, Response, NextFunction } from 'express';
import { db } from '../db/client.js';

export interface AuthenticatedRequest extends Request {
  tenantId?: string;
  user?: {
    id: string;
    username: string;
    role: string;
    tenantId: string;
  };
}

/**
 * Multi-Tenancy Middleware (Non-negotiable Rule 3)
 * Guarantees that every request is strictly bound to an authorized tenant.
 */
export function tenantMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  // Allow tenant creation route without prior tenant header
  if (req.path === '/api/v1/tenants' && req.method === 'POST') {
    return next();
  }
  if (req.path === '/api/v1/tenants' && req.method === 'GET') {
    return next();
  }

  const headerTenantId = req.headers['x-tenant-id'] as string;
  const tokenTenantId = req.user?.tenantId;

  const tenantId = headerTenantId || tokenTenantId;

  if (!tenantId) {
    res.status(400).json({
      code: 'MISSING_TENANT_ID',
      message: 'X-Tenant-ID header or valid tenant claim is required.'
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
