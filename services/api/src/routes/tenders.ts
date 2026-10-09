import { Router, Response } from 'express';
import { db, TenderRecord } from '../db/client.js';
import { AuthenticatedRequest } from '../middleware/tenant.js';
import { auditLogger } from '../services/audit.js';
import { validateTenderTransition, TenderStatus } from '../domain/state-model.js';
import { clarificationsRouter } from './clarifications.js';
import { bidsRouter } from './bids.js';
import { evaluationsRouter } from './evaluations.js';

export const tendersRouter = Router();

// Sub-routers for nested resources under /tenders/:tenderId
tendersRouter.use('/:tenderId/clarifications', clarificationsRouter);
tendersRouter.use('/:tenderId/bids', bidsRouter);
tendersRouter.use('/:tenderId/evaluations', evaluationsRouter);

tendersRouter.get('/', (req: AuthenticatedRequest, res: Response) => {
  const statusFilter = req.query.status as string;
  const list = Array.from(db.tenders.values()).filter(t => {
    if (t.tenantId !== req.tenantId) return false;
    if (statusFilter && t.status !== statusFilter) return false;
    return true;
  });
  res.json(list);
});

tendersRouter.post('/', async (req: AuthenticatedRequest, res: Response) => {
  if (req.user?.role === 'VENDOR' || req.user?.role === 'PUBLIC') {
    res.status(403).json({ code: 'FORBIDDEN_ROLE', message: 'Vendors are not permitted to draft tenders.' });
    return;
  }

  const { tenderNumber, titleEn, titleAr, category, estimatedBudget, submissionDeadline, documentIds } = req.body;

  if (!tenderNumber || !titleEn || !titleAr || !estimatedBudget || !submissionDeadline) {
    res.status(400).json({ code: 'INVALID_REQUEST', message: 'Missing required tender fields.' });
    return;
  }

  const id = `tnd_${Date.now()}`;
  const tender: TenderRecord = {
    id,
    tenantId: req.tenantId!,
    tenderNumber,
    titleEn,
    titleAr,
    category: category || 'IT',
    status: 'DRAFT',
    estimatedBudget: Number(estimatedBudget),
    currency: 'KWD',
    submissionDeadline,
    documentIds: documentIds || [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  db.tenders.set(id, tender);

  await auditLogger.logEvent({
    tenantId: req.tenantId!,
    actorId: req.user?.id || 'officer@kea.gov.kw',
    actorRole: req.user?.role || 'PROCUREMENT_OFFICER',
    action: 'TENDER_CREATED',
    resourceType: 'TENDER',
    resourceId: id,
    prevState: null,
    newState: 'DRAFT',
    reason: `Created tender ${tenderNumber}`
  });

  res.status(201).json(tender);
});

tendersRouter.post('/:tenderId/approve-publish', async (req: AuthenticatedRequest, res: Response) => {
  if (req.user?.role === 'VENDOR' || req.user?.role === 'PUBLIC') {
    res.status(403).json({ code: 'FORBIDDEN_ROLE', message: 'Vendors are not permitted to approve tenders.' });
    return;
  }

  const { tenderId } = req.params;
  const { reason, aiAdvisoryRef } = req.body;
  const tender = db.tenders.get(tenderId);

  if (!tender || tender.tenantId !== req.tenantId) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Tender not found.' });
    return;
  }

  try {
    // Non-negotiable Rule 7: Must be authorized by human officer
    validateTenderTransition(tender.status as TenderStatus, 'APPROVED_FOR_PUBLICATION');

    const prev = tender.status;
    tender.status = 'APPROVED_FOR_PUBLICATION';
    tender.aiAdvisoryRef = aiAdvisoryRef || null;
    tender.updatedAt = new Date().toISOString();

    await auditLogger.logEvent({
      tenantId: req.tenantId!,
      actorId: req.user?.id || 'director@kea.gov.kw',
      actorRole: 'DIRECTOR',
      action: 'TENDER_APPROVED_FOR_PUBLISH',
      resourceType: 'TENDER',
      resourceId: tenderId,
      prevState: prev,
      newState: 'APPROVED_FOR_PUBLICATION',
      reason: reason || 'Human sign-off approving publication after AI completeness review.'
    });

    res.json(tender);
  } catch (err: any) {
    res.status(400).json({ code: 'ILLEGAL_TRANSITION', message: err.message });
  }
});

tendersRouter.post('/:tenderId/publish', async (req: AuthenticatedRequest, res: Response) => {
  if (req.user?.role === 'VENDOR' || req.user?.role === 'PUBLIC') {
    res.status(403).json({ code: 'FORBIDDEN_ROLE', message: 'Vendors are not permitted to publish tenders.' });
    return;
  }

  const { tenderId } = req.params;
  const tender = db.tenders.get(tenderId);

  if (!tender || tender.tenantId !== req.tenantId) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Tender not found.' });
    return;
  }

  try {
    validateTenderTransition(tender.status as TenderStatus, 'PUBLISHED');

    const prev = tender.status;
    tender.status = 'PUBLISHED';
    tender.updatedAt = new Date().toISOString();

    await auditLogger.logEvent({
      tenantId: req.tenantId!,
      actorId: req.user?.id || 'officer@kea.gov.kw',
      actorRole: 'PROCUREMENT_OFFICER',
      action: 'TENDER_PUBLISHED',
      resourceType: 'TENDER',
      resourceId: tenderId,
      prevState: prev,
      newState: 'PUBLISHED',
      reason: 'Published to Vendor Portal for supplier bidding.'
    });

    res.json(tender);
  } catch (err: any) {
    res.status(400).json({ code: 'ILLEGAL_TRANSITION', message: err.message });
  }
});

tendersRouter.post('/:tenderId/close', async (req: AuthenticatedRequest, res: Response) => {
  const { tenderId } = req.params;
  const tender = db.tenders.get(tenderId);

  if (!tender || tender.tenantId !== req.tenantId) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Tender not found.' });
    return;
  }

  try {
    validateTenderTransition(tender.status as TenderStatus, 'CLOSED');

    const prev = tender.status;
    tender.status = 'CLOSED';
    tender.updatedAt = new Date().toISOString();

    await auditLogger.logEvent({
      tenantId: req.tenantId!,
      actorId: req.user?.id || 'system',
      actorRole: 'SYSTEM',
      action: 'TENDER_CLOSED',
      resourceType: 'TENDER',
      resourceId: tenderId,
      prevState: prev,
      newState: 'CLOSED',
      reason: 'Submission deadline elapsed. Tender closed for sealed bid opening.'
    });

    res.json(tender);
  } catch (err: any) {
    res.status(400).json({ code: 'ILLEGAL_TRANSITION', message: err.message });
  }
});

tendersRouter.get('/:tenderId', (req: AuthenticatedRequest, res: Response) => {
  const tender = db.tenders.get(req.params.tenderId);
  if (!tender || tender.tenantId !== req.tenantId) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Tender not found.' });
    return;
  }
  res.json(tender);
});
