import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/tenant.js';
import { sealedBidVault, SealedBidAccessViolationError } from '../services/sealed-bid-vault.js';
import { db } from '../db/client.js';
import { validateTenderTransition, TenderStatus } from '../domain/state-model.js';

export const bidsRouter = Router({ mergeParams: true });

bidsRouter.get('/', (req: AuthenticatedRequest, res: Response) => {
  const { tenderId } = req.params;
  const bids = sealedBidVault.listBidsForTender(req.tenantId!, tenderId);
  res.json(bids);
});

bidsRouter.post('/', async (req: AuthenticatedRequest, res: Response) => {
  const { tenderId } = req.params;
  const { vendorId, vendorName, technicalProposalDocId, financialProposalDocId, hashDigest } = req.body;

  if (!vendorId || !technicalProposalDocId || !financialProposalDocId || !hashDigest) {
    res.status(400).json({ code: 'INVALID_REQUEST', message: 'Missing required bid submission parameters.' });
    return;
  }

  const tender = db.tenders.get(tenderId);
  if (!tender || tender.tenantId !== req.tenantId) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Tender not found.' });
    return;
  }

  try {
    const bid = await sealedBidVault.submitSealedBid({
      tenantId: req.tenantId!,
      tenderId,
      vendorId,
      vendorName: vendorName || 'Registered Vendor',
      technicalDocId: technicalProposalDocId,
      financialDocId: financialProposalDocId,
      hashDigest
    });

    res.status(201).json({
      id: bid.id,
      tenderId: bid.tenderId,
      vendorId: bid.vendorId,
      vendorName: bid.vendorName,
      status: bid.status,
      hashDigest: bid.hashDigest,
      submittedAt: bid.submittedAt
    });
  } catch (err: any) {
    res.status(400).json({ code: 'BID_SUBMISSION_ERROR', message: err.message });
  }
});

/**
 * Non-negotiable Rule 1: Sealed bids access control.
 * Strictly returns HTTP 403 if tender has not held opening ceremony.
 */
bidsRouter.get('/:bidId/content', (req: AuthenticatedRequest, res: Response) => {
  const { tenderId, bidId } = req.params;

  try {
    const bid = sealedBidVault.getBidContent(req.tenantId!, tenderId, bidId);
    res.json({
      bidId: bid.id,
      technicalProposalDocId: bid.technicalDocId,
      financialProposalDocId: bid.financialDocId,
      unsealedAt: bid.unsealedAt
    });
  } catch (err: any) {
    if (err instanceof SealedBidAccessViolationError) {
      res.status(403).json({
        code: err.code,
        message: err.message
      });
      return;
    }
    res.status(404).json({ code: 'NOT_FOUND', message: err.message });
  }
});

/**
 * Step 8: Bid Opening Ceremony
 */
bidsRouter.post('/opening-ceremony', async (req: AuthenticatedRequest, res: Response) => {
  const { tenderId } = req.params;
  const { committeeChair, attendees, minutesNotes } = req.body;

  if (!committeeChair || !attendees || !Array.isArray(attendees)) {
    res.status(400).json({ code: 'INVALID_REQUEST', message: 'committeeChair and attendees are required.' });
    return;
  }

  const tender = db.tenders.get(tenderId);
  if (!tender || tender.tenantId !== req.tenantId) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Tender not found.' });
    return;
  }

  try {
    // If tender is not yet closed, transition to CLOSED first
    if (tender.status === 'PUBLISHED') {
      tender.status = 'CLOSED';
    }
    validateTenderTransition(tender.status as TenderStatus, 'BIDS_OPENED');

    const ceremony = await sealedBidVault.executeOpeningCeremony({
      tenantId: req.tenantId!,
      tenderId,
      committeeChair,
      attendees,
      minutesNotes
    });

    tender.status = 'BIDS_OPENED';
    tender.updatedAt = new Date().toISOString();

    res.json(ceremony);
  } catch (err: any) {
    res.status(400).json({ code: 'OPENING_CEREMONY_FAILED', message: err.message });
  }
});
