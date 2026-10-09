import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/tenant.js';
import { auditLogger } from '../services/audit.js';

export const auditRouter = Router();

auditRouter.get('/', (req: AuthenticatedRequest, res: Response) => {
  const resourceType = req.query.resourceType as string;
  const resourceId = req.query.resourceId as string;

  const logs = auditLogger.getLogs({
    tenantId: req.tenantId,
    resourceType,
    resourceId
  });

  res.json(logs);
});

auditRouter.get('/verify-integrity', (req: AuthenticatedRequest, res: Response) => {
  const isValid = auditLogger.verifyChain();
  res.json({
    chainIntegrityValid: isValid,
    totalEventsVerified: auditLogger.getLogs().length,
    algorithm: 'HMAC-SHA256'
  });
});
