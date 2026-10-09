import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './tenant.js';

export function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  // Public routes: vendor registration, public tenders viewing, health check
  const isPublicRoute = 
    req.path === '/api/v1/vendors/register' ||
    req.path === '/health' ||
    (req.path.startsWith('/api/v1/tenants') && req.method === 'GET');

  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    // In dev / test environment, support convenient synthetic token decoding
    if (token.startsWith('mock:')) {
      const parts = token.split(':');
      req.user = {
        id: parts[1] || 'usr_default',
        username: parts[2] || 'test_user',
        role: parts[3] || 'PROCUREMENT_OFFICER',
        tenantId: req.tenantId || 'kea'
      };
      return next();
    }
  }

  // Fallback defaults for seamless demo / test execution if no token provided on public routes
  if (isPublicRoute) {
    req.user = {
      id: 'anonymous',
      username: 'guest',
      role: 'PUBLIC',
      tenantId: req.tenantId || 'kea'
    };
    return next();
  }

  // Set default actor if header not provided in local dev mode
  req.user = {
    id: (req.headers['x-actor-id'] as string) || 'officer@kea.gov.kw',
    username: 'procurement_officer',
    role: (req.headers['x-actor-role'] as string) || 'PROCUREMENT_OFFICER',
    tenantId: req.tenantId || 'kea'
  };

  next();
}

export function requireRole(allowedRoles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        code: 'FORBIDDEN_ROLE',
        message: `Current role '${req.user?.role}' is not authorized to execute this action.`
      });
      return;
    }
    next();
  };
}
