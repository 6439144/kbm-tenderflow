import { Router, Response } from 'express';
import { db, EvaluationRecord, AwardRecord } from '../db/client.js';
import { AuthenticatedRequest } from '../middleware/tenant.js';
import { auditLogger } from '../services/audit.js';
import { validateTenderTransition, TenderStatus } from '../domain/state-model.js';

export const evaluationsRouter = Router({ mergeParams: true });

evaluationsRouter.get('/', (req: AuthenticatedRequest, res: Response) => {
  const { tenderId } = req.params;
  const evals = Array.from(db.evaluations.values()).filter(
    e => e.tenantId === req.tenantId && e.tenderId === tenderId
  );
  res.json(evals);
});

evaluationsRouter.post('/scorecard', async (req: AuthenticatedRequest, res: Response) => {
  const { tenderId } = req.params;
  const { bidId, evaluatorId, technicalScore, financialScore, comments } = req.body;

  if (!bidId || technicalScore === undefined || financialScore === undefined) {
    res.status(400).json({ code: 'INVALID_REQUEST', message: 'Missing evaluation parameters.' });
    return;
  }

  const evalId = `eval_${Date.now()}`;
  const composite = (Number(technicalScore) * 0.7) + (Number(financialScore) * 0.3);

  const evaluation: EvaluationRecord = {
    id: evalId,
    tenantId: req.tenantId!,
    tenderId,
    bidId,
    evaluatorId: evaluatorId || req.user?.id || 'evaluator_1',
    technicalScore: Number(technicalScore),
    financialScore: Number(financialScore),
    compositeScore: Math.round(composite * 100) / 100,
    comments,
    submittedAt: new Date().toISOString()
  };

  db.evaluations.set(evalId, evaluation);

  // Transition tender to EVALUATED if opened
  const tender = db.tenders.get(tenderId);
  if (tender && tender.status === 'BIDS_OPENED') {
    tender.status = 'EVALUATED';
    tender.updatedAt = new Date().toISOString();
  }

  await auditLogger.logEvent({
    tenantId: req.tenantId!,
    actorId: evaluation.evaluatorId,
    actorRole: 'EVALUATOR',
    action: 'SCORECARD_SUBMITTED',
    resourceType: 'BID',
    resourceId: bidId,
    prevState: null,
    newState: 'SCORED',
    reason: `Evaluator scorecard recorded: Technical=${technicalScore}, Financial=${financialScore}, Composite=${composite}`
  });

  res.status(201).json(evaluation);
});

evaluationsRouter.post('/award', async (req: AuthenticatedRequest, res: Response) => {
  const { tenderId } = req.params;
  const { winningVendorId, awardValue, justification } = req.body;

  if (!winningVendorId || !awardValue) {
    res.status(400).json({ code: 'INVALID_REQUEST', message: 'winningVendorId and awardValue are required.' });
    return;
  }

  const tender = db.tenders.get(tenderId);
  if (!tender || tender.tenantId !== req.tenantId) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Tender not found.' });
    return;
  }

  validateTenderTransition(tender.status as TenderStatus, 'AWARDED');

  const awardId = `awd_${Date.now()}`;
  const award: AwardRecord = {
    id: awardId,
    tenantId: req.tenantId!,
    tenderId,
    winningVendorId,
    awardValue: Number(awardValue),
    justification: justification || 'Highest composite score in technical and commercial evaluation.',
    approvedBy: req.user?.id || 'director@kea.gov.kw',
    awardedAt: new Date().toISOString()
  };

  db.awards.set(awardId, award);

  const prev = tender.status;
  tender.status = 'AWARDED';
  tender.awardedVendorId = winningVendorId;
  tender.updatedAt = new Date().toISOString();

  await auditLogger.logEvent({
    tenantId: req.tenantId!,
    actorId: award.approvedBy,
    actorRole: 'DIRECTOR',
    action: 'TENDER_AWARDED',
    resourceType: 'TENDER',
    resourceId: tenderId,
    prevState: prev,
    newState: 'AWARDED',
    reason: `Official contract award approved to vendor ${winningVendorId} for ${awardValue} KWD.`
  });

  res.json({ tender, award });
});
