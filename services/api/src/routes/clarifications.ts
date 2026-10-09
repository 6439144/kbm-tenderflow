import { Router, Response } from 'express';
import { db, ClarificationRecord } from '../db/client.js';
import { AuthenticatedRequest, requireRole } from '../middleware/auth.js';
import { auditLogger } from '../services/audit.js';

export const clarificationsRouter = Router({ mergeParams: true });

clarificationsRouter.get('/', (req: AuthenticatedRequest, res: Response) => {
  const { tenderId } = req.params;
  const list = Array.from(db.clarifications.values()).filter(
    c => c.tenantId === req.tenantId && c.tenderId === tenderId
  );
  res.json(list);
});

clarificationsRouter.post('/', async (req: AuthenticatedRequest, res: Response) => {
  const { tenderId } = req.params;
  const { question } = req.body;

  if (!question) {
    res.status(400).json({ code: 'INVALID_REQUEST', message: 'question is required.' });
    return;
  }

  const id = `clr_${Date.now()}`;
  const clar: ClarificationRecord = {
    id,
    tenantId: req.tenantId!,
    tenderId,
    vendorId: req.user?.id || 'anonymous_vendor',
    question,
    status: 'PENDING',
    createdAt: new Date().toISOString()
  };

  db.clarifications.set(id, clar);

  await auditLogger.logEvent({
    tenantId: req.tenantId!,
    actorId: req.user?.id || 'vendor',
    actorRole: req.user?.role || 'VENDOR',
    action: 'CLARIFICATION_SUBMITTED',
    resourceType: 'CLARIFICATION',
    resourceId: id,
    prevState: null,
    newState: 'PENDING',
    reason: `Inquiry submitted for tender ${tenderId}`
  });

  res.status(201).json(clar);
});

clarificationsRouter.post('/:clarificationId/respond', requireRole(['PROCUREMENT_OFFICER', 'DIRECTOR', 'TENANT_ADMIN', 'SUPER_ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  const { tenderId, clarificationId } = req.params;
  const { answer } = req.body;

  const clar = db.clarifications.get(clarificationId);
  if (!clar || clar.tenantId !== req.tenantId || clar.tenderId !== tenderId) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Clarification not found.' });
    return;
  }

  clar.answer = answer;
  clar.status = 'ANSWERED';
  clar.answeredAt = new Date().toISOString();

  await auditLogger.logEvent({
    tenantId: req.tenantId!,
    actorId: req.user?.id || 'officer',
    actorRole: req.user?.role || 'PROCUREMENT_OFFICER',
    action: 'CLARIFICATION_ANSWERED',
    resourceType: 'CLARIFICATION',
    resourceId: clarificationId,
    prevState: 'PENDING',
    newState: 'ANSWERED',
    reason: `Clarification response recorded by officer.`
  });

  res.json(clar);
});
