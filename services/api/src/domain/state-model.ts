/**
 * Shared Contract: TenderFlow State Models & State Transitions
 * 
 * Rules:
 * - Every state transition must write an audit record (Rule 2).
 * - Transitions must be strictly validated; illegal transitions throw InvalidStateTransitionError.
 */

export type TenderStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED_FOR_PUBLICATION'
  | 'PUBLISHED'
  | 'CLOSED'
  | 'BIDS_OPENED'
  | 'EVALUATED'
  | 'AWARDED'
  | 'CANCELLED';

export type VendorStatus =
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'SUSPENDED';

export type BidStatus =
  | 'SEALED'
  | 'OPENED'
  | 'DISQUALIFIED'
  | 'AWARDED';

export type ClarificationStatus =
  | 'PENDING'
  | 'ANSWERED';

export const VALID_TENDER_TRANSITIONS: Record<TenderStatus, TenderStatus[]> = {
  DRAFT: ['PENDING_APPROVAL', 'APPROVED_FOR_PUBLICATION', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED_FOR_PUBLICATION', 'DRAFT', 'CANCELLED'],
  APPROVED_FOR_PUBLICATION: ['PUBLISHED', 'CANCELLED'],
  PUBLISHED: ['CLOSED', 'CANCELLED'],
  CLOSED: ['BIDS_OPENED', 'CANCELLED'],
  BIDS_OPENED: ['EVALUATED', 'CANCELLED'],
  EVALUATED: ['AWARDED', 'CANCELLED'],
  AWARDED: [],
  CANCELLED: []
};

export const VALID_VENDOR_TRANSITIONS: Record<VendorStatus, VendorStatus[]> = {
  PENDING_REVIEW: ['APPROVED', 'REJECTED'],
  APPROVED: ['SUSPENDED'],
  REJECTED: ['PENDING_REVIEW'],
  SUSPENDED: ['APPROVED']
};

export const VALID_BID_TRANSITIONS: Record<BidStatus, BidStatus[]> = {
  SEALED: ['OPENED', 'DISQUALIFIED'],
  OPENED: ['DISQUALIFIED', 'AWARDED'],
  DISQUALIFIED: [],
  AWARDED: []
};

export class InvalidStateTransitionError extends Error {
  constructor(entity: string, from: string, to: string) {
    super(`Illegal state transition for ${entity}: cannot transition from '${from}' to '${to}'.`);
    this.name = 'InvalidStateTransitionError';
  }
}

export function validateTenderTransition(from: TenderStatus, to: TenderStatus): void {
  const allowed = VALID_TENDER_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new InvalidStateTransitionError('Tender', from, to);
  }
}

export function validateVendorTransition(from: VendorStatus, to: VendorStatus): void {
  const allowed = VALID_VENDOR_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new InvalidStateTransitionError('Vendor', from, to);
  }
}

export function validateBidTransition(from: BidStatus, to: BidStatus): void {
  const allowed = VALID_BID_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new InvalidStateTransitionError('Bid', from, to);
  }
}
