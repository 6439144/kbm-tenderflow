import { Router, Response } from 'express';
import { db } from '../db/client.js';
import { AuthenticatedRequest } from '../middleware/tenant.js';
import { auditLogger } from '../services/audit.js';

export const tenantsRouter = Router();

tenantsRouter.get('/', (req: AuthenticatedRequest, res: Response) => {
  const list = Array.from(db.tenants.values());
  res.json(list);
});

tenantsRouter.get('/:tenantId', (req: AuthenticatedRequest, res: Response) => {
  const tenant = db.tenants.get(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ code: 'TENANT_NOT_FOUND', message: 'Tenant not found.' });
    return;
  }
  res.json(tenant);
});

tenantsRouter.post('/', async (req: AuthenticatedRequest, res: Response) => {
  const { id, nameEn, nameAr, defaultCurrency, branding, config } = req.body;

  if (!id || !nameEn || !nameAr) {
    res.status(400).json({ code: 'INVALID_REQUEST', message: 'id, nameEn, and nameAr are required.' });
    return;
  }

  if (db.tenants.has(id)) {
    res.status(409).json({ code: 'TENANT_EXISTS', message: `Tenant with id '${id}' already exists.` });
    return;
  }

  const newTenant = {
    id,
    nameEn,
    nameAr,
    defaultCurrency: defaultCurrency || 'KWD',
    status: 'ACTIVE' as const,
    branding: branding || { primaryColor: '#0B4F6C', defaultDirection: 'rtl' },
    config: config || req.body,
    createdAt: new Date().toISOString()
  };

  db.tenants.set(id, newTenant);

  await auditLogger.logEvent({
    tenantId: id,
    actorId: req.user?.id || 'admin',
    actorRole: 'SUPER_ADMIN',
    action: 'TENANT_CREATED',
    resourceType: 'TENANT',
    resourceId: id,
    prevState: null,
    newState: 'ACTIVE',
    reason: `Tenant provisioned from configuration package for ${nameEn}`
  });

  res.status(201).json(newTenant);
});
