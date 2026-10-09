import { Router, Response } from 'express';
import { db, TenderRecord } from '../db/client.js';
import { AuthenticatedRequest, requireRole } from '../middleware/auth.js';
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

/**
 * Public listing of published tenders or authenticated view of all tenant tenders
 */
tendersRouter.get('/', (req: AuthenticatedRequest, res: Response) => {
  const statusFilter = req.query.status as string;
  const isVendorOrPublic = !req.user || req.user.role === 'VENDOR' || req.user.role === 'PUBLIC';

  const list = Array.from(db.tenders.values()).filter(t => {
    if (t.tenantId !== req.tenantId) return false;
    // Public/vendor can only see published/closed tenders
    if (isVendorOrPublic && (t.status === 'DRAFT' || t.status === 'APPROVED_FOR_PUBLICATION')) {
      return false;
    }
    if (statusFilter && t.status !== statusFilter) return false;
    return true;
  });
  res.json(list);
});

/**
 * Draft Tender Dossier (Step 3)
 * Requires PROCUREMENT_OFFICER, DIRECTOR, or ADMIN
 */
tendersRouter.post('/', requireRole(['PROCUREMENT_OFFICER', 'DIRECTOR', 'TENANT_ADMIN', 'SUPER_ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
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
    createdBy: req.user?.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  db.tenders.set(id, tender);

  await auditLogger.logEvent({
    tenantId: req.tenantId!,
    actorId: req.user?.id || 'system',
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

/**
 * Authorize Publication (Step 4)
 * Strict Segregation of Duties: Creator cannot approve own tender!
 * Requires DIRECTOR or ADMIN
 */
tendersRouter.post('/:tenderId/approve-publish', requireRole(['DIRECTOR', 'TENANT_ADMIN', 'SUPER_ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  const { tenderId } = req.params;
  const { reason, aiAdvisoryRef } = req.body;
  const tender = db.tenders.get(tenderId);

  if (!tender || tender.tenantId !== req.tenantId) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Tender not found.' });
    return;
  }

  // Segregation of Duties (Rule SoD-1): Approver cannot be the creator
  if (tender.createdBy && req.user?.id && tender.createdBy === req.user.id) {
    res.status(403).json({
      code: 'CREATOR_CANNOT_APPROVE',
      message: 'Segregation of duties violation: Tender creator cannot authorize publication of their own tender.'
    });
    return;
  }

  try {
    // Rule 7: Must be authorized by human director
    validateTenderTransition(tender.status as TenderStatus, 'APPROVED_FOR_PUBLICATION');

    const prev = tender.status;
    tender.status = 'APPROVED_FOR_PUBLICATION';
    tender.aiAdvisoryRef = aiAdvisoryRef || null;
    tender.updatedAt = new Date().toISOString();

    await auditLogger.logEvent({
      tenantId: req.tenantId!,
      actorId: req.user?.id || 'director',
      actorRole: req.user?.role || 'DIRECTOR',
      action: 'TENDER_APPROVED_FOR_PUBLISH',
      resourceType: 'TENDER',
      resourceId: tenderId,
      prevState: prev,
      newState: 'APPROVED_FOR_PUBLICATION',
      reason: reason || 'Human director sign-off approving publication after completeness review.'
    });

    res.json(tender);
  } catch (err: any) {
    res.status(400).json({ code: 'ILLEGAL_TRANSITION', message: err.message });
  }
});

/**
 * Publish Tender (Step 5)
 * Requires PROCUREMENT_OFFICER, DIRECTOR, or ADMIN
 */
tendersRouter.post('/:tenderId/publish', requireRole(['PROCUREMENT_OFFICER', 'DIRECTOR', 'TENANT_ADMIN', 'SUPER_ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
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
      actorId: req.user?.id || 'officer',
      actorRole: req.user?.role || 'PROCUREMENT_OFFICER',
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

/**
 * Close Tender at deadline
 */
tendersRouter.post('/:tenderId/close', requireRole(['PROCUREMENT_OFFICER', 'DIRECTOR', 'TENANT_ADMIN', 'SUPER_ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
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
      actorRole: req.user?.role || 'SYSTEM',
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

  const isVendorOrPublic = !req.user || req.user.role === 'VENDOR' || req.user.role === 'PUBLIC';
  if (isVendorOrPublic && (tender.status === 'DRAFT' || tender.status === 'APPROVED_FOR_PUBLICATION')) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Tender is not published yet.' });
    return;
  }

  res.json(tender);
});
