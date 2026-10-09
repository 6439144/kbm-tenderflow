import { Router, Response } from 'express';
import { db, VendorRecord } from '../db/client.js';
import { AuthenticatedRequest } from '../middleware/tenant.js';
import { auditLogger } from '../services/audit.js';
import { validateVendorTransition } from '../domain/state-model.js';

export const vendorsRouter = Router();

vendorsRouter.get('/', (req: AuthenticatedRequest, res: Response) => {
  const statusFilter = req.query.status as string;
  const list = Array.from(db.vendors.values()).filter(v => {
    if (v.tenantId !== req.tenantId) return false;
    if (statusFilter && v.status !== statusFilter) return false;
    return true;
  });
  res.json(list);
});

vendorsRouter.post('/register', async (req: AuthenticatedRequest, res: Response) => {
  const { legalNameEn, legalNameAr, crNumber, contactEmail, contactPhone, documentIds } = req.body;
  const tenantId = req.tenantId || 'kea';

  if (!legalNameEn || !legalNameAr || !crNumber || !contactEmail) {
    res.status(400).json({ code: 'INVALID_REQUEST', message: 'Missing required vendor registration fields.' });
    return;
  }

  // Check unique CR number per tenant
  for (const v of db.vendors.values()) {
    if (v.tenantId === tenantId && v.crNumber === crNumber) {
      res.status(409).json({ code: 'CR_EXISTS', message: `CR Number ${crNumber} is already registered.` });
      return;
    }
  }

  const vendorId = `vnd_${Date.now()}`;
  const vendor: VendorRecord = {
    id: vendorId,
    tenantId,
    legalNameEn,
    legalNameAr,
    crNumber,
    contactEmail,
    contactPhone,
    status: 'PENDING_REVIEW',
    documentIds: documentIds || [],
    createdAt: new Date().toISOString()
  };

  db.vendors.set(vendorId, vendor);

  await auditLogger.logEvent({
    tenantId,
    actorId: contactEmail,
    actorRole: 'APPLICANT',
    action: 'VENDOR_REGISTERED',
    resourceType: 'VENDOR',
    resourceId: vendorId,
    prevState: null,
    newState: 'PENDING_REVIEW',
    reason: `Self-registration submitted by ${legalNameEn} (${crNumber})`
  });

  res.status(201).json(vendor);
});

vendorsRouter.post('/:vendorId/approve', async (req: AuthenticatedRequest, res: Response) => {
  if (req.user?.role === 'VENDOR' || req.user?.role === 'PUBLIC') {
    res.status(403).json({ code: 'FORBIDDEN_ROLE', message: 'Vendors are not permitted to approve vendor registrations.' });
    return;
  }

  const { vendorId } = req.params;
  const { reason } = req.body;
  const vendor = db.vendors.get(vendorId);

  if (!vendor || vendor.tenantId !== req.tenantId) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Vendor not found.' });
    return;
  }

  try {
    validateVendorTransition(vendor.status, 'APPROVED');
  } catch (err: any) {
    res.status(400).json({ code: 'ILLEGAL_TRANSITION', message: err.message });
    return;
  }

  const prev = vendor.status;
  vendor.status = 'APPROVED';

  await auditLogger.logEvent({
    tenantId: req.tenantId!,
    actorId: req.user?.id || 'officer@kea.gov.kw',
    actorRole: req.user?.role || 'PROCUREMENT_OFFICER',
    action: 'VENDOR_APPROVED',
    resourceType: 'VENDOR',
    resourceId: vendorId,
    prevState: prev,
    newState: 'APPROVED',
    reason: reason || 'Approved after document compliance verification'
  });

  res.json(vendor);
});
