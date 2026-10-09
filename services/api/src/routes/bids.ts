import { Router, Response } from 'express';
import { AuthenticatedRequest, requireRole } from '../middleware/auth.js';
import { sealedBidVault, SealedBidAccessViolationError } from '../services/sealed-bid-vault.js';
import { db } from '../db/client.js';
import { validateTenderTransition, TenderStatus } from '../domain/state-model.js';

export const bidsRouter = Router({ mergeParams: true });

bidsRouter.get('/', (req: AuthenticatedRequest, res: Response) => {
  const { tenderId } = req.params;
  const bids = sealedBidVault.listBidsForTender(req.tenantId!, tenderId);

  // If caller is a vendor, filter so they only see their own bid metadata or count
  if (req.user?.role === 'VENDOR') {
    const callerVendorId = req.user.vendorId || req.user.id;
    return res.json(bids.filter(b => b.vendorId === callerVendorId));
  }

  res.json(bids);
});

/**
 * Submit Sealed Bid (Step 7)
 * Strictly requires VENDOR role
 * Rejects submission if tender is not PUBLISHED or deadline has passed
 */
bidsRouter.post('/', requireRole(['VENDOR']), async (req: AuthenticatedRequest, res: Response) => {
  const { tenderId } = req.params;
  const { technicalProposalDocId, financialProposalDocId, hashDigest, vendorName } = req.body;

  if (!technicalProposalDocId || !financialProposalDocId || !hashDigest) {
    res.status(400).json({ code: 'INVALID_REQUEST', message: 'Missing required bid submission parameters.' });
    return;
  }

  const tender = db.tenders.get(tenderId);
  if (!tender || tender.tenantId !== req.tenantId) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Tender not found.' });
    return;
  }

  // Reject bids if tender is not in PUBLISHED state
  if (tender.status !== 'PUBLISHED') {
    res.status(400).json({
      code: 'TENDER_NOT_PUBLISHED',
      message: `Cannot submit bid: Tender status is '${tender.status}'. Bids can only be submitted for PUBLISHED tenders.`
    });
    return;
  }

  // Reject bids if server clock (UTC) has passed submission deadline
  const now = new Date();
  const deadline = new Date(tender.submissionDeadline);
  if (now > deadline) {
    res.status(400).json({
      code: 'DEADLINE_ELAPSED',
      message: `Cannot submit bid: Submission deadline (${tender.submissionDeadline}) has elapsed.`
    });
    return;
  }

  // vendorId is strictly derived from the authenticated token claim
  const authenticatedVendorId = req.user?.vendorId || req.user?.id || 'vnd_unknown';

  try {
    const { bid } = await sealedBidVault.submitSealedBid({
      tenantId: req.tenantId!,
      tenderId,
      vendorId: authenticatedVendorId,
      vendorName: vendorName || req.user?.username || 'Verified Vendor',
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
 * Competitor vendors are forbidden from reading other vendors' bids.
 */
bidsRouter.get('/:bidId/content', (req: AuthenticatedRequest, res: Response) => {
  const { tenderId, bidId } = req.params;

  try {
    const bid = sealedBidVault.getBidContent(req.tenantId!, tenderId, bidId);

    // Prevent competitor vendor from viewing another vendor's bid contents even after opening
    if (req.user?.role === 'VENDOR') {
      const callerVendorId = req.user.vendorId || req.user.id;
      if (bid.vendorId !== callerVendorId) {
        res.status(403).json({
          code: 'FORBIDDEN_COMPETITOR_ACCESS',
          message: 'Vendors are forbidden from inspecting competing bids.'
        });
        return;
      }
    }

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
 * Requires COMMITTEE_CHAIR, OPENING_COMMITTEE_CHAIR, or ADMIN
 * Cannot be opened before submission deadline (409 Conflict)
 */
bidsRouter.post('/opening-ceremony', requireRole(['COMMITTEE_CHAIR', 'OPENING_COMMITTEE_CHAIR', 'TENANT_ADMIN', 'SUPER_ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
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

  // Reject opening ceremony if now < deadline (Task G1-c / P0-2)
  const now = new Date();
  const deadline = new Date(tender.submissionDeadline);
  if (now < deadline) {
    res.status(409).json({
      code: 'OPENING_BEFORE_DEADLINE',
      message: `Opening ceremony cannot be convened before submission deadline (${tender.submissionDeadline}).`
    });
    return;
  }

  try {
    // If tender was PUBLISHED and deadline passed, auto-close
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
