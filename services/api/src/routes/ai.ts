import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/tenant.js';
import { aiAdvisory } from '../services/ai-advisory.js';
import { db } from '../db/client.js';

import { sealedBidVault } from '../services/sealed-bid-vault.js';

export const aiRouter = Router();

aiRouter.post('/advisory/tender-completeness-check', async (req: AuthenticatedRequest, res: Response) => {
  const { tenderId } = req.body;
  const tender = db.tenders.get(tenderId);

  if (!tender || tender.tenantId !== req.tenantId) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Tender not found.' });
    return;
  }

  const report = await aiAdvisory.checkTenderCompleteness({
    tenderNumber: tender.tenderNumber,
    titleEn: tender.titleEn,
    titleAr: tender.titleAr,
    estimatedBudget: tender.estimatedBudget,
    submissionDeadline: tender.submissionDeadline,
    documentCount: tender.documentIds.length
  });

  res.json(report);
});

aiRouter.post('/advisory/draft-clarification-reply', async (req: AuthenticatedRequest, res: Response) => {
  const { question } = req.body;
  if (!question) {
    res.status(400).json({ code: 'INVALID_REQUEST', message: 'question is required.' });
    return;
  }

  const draft = await aiAdvisory.draftClarificationResponse(question);
  res.json(draft);
});

aiRouter.post('/advisory/evaluate-bid-compliance', async (req: AuthenticatedRequest, res: Response) => {
  const { bidId, vendorName } = req.body;

  // Non-negotiable Rule 1: Nobody (including AI tools) reads a sealed bid before opening
  if (bidId) {
    const storedBid = sealedBidVault.getBidById(bidId);
    if (storedBid && storedBid.status === 'SEALED') {
      res.status(403).json({
        code: 'BIDS_SEALED_UNTIL_OPENING_EVENT',
        message: 'Non-negotiable Rule 1 Violation: AI tools cannot inspect bid compliance while the bid remains sealed.'
      });
      return;
    }
  }

  const suggestion = await aiAdvisory.suggestBidEvaluation({
    id: bidId || 'bid_001',
    vendorName: vendorName || 'Vendor Consortium'
  });

  res.json(suggestion);
});
