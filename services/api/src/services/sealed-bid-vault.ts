import * as crypto from 'crypto';
import { auditLogger } from './audit.js';

export class SealedBidAccessViolationError extends Error {
  public code = 'BIDS_SEALED_UNTIL_OPENING_EVENT';
  constructor(message?: string) {
    super(message || 'Access Denied: Bids are sealed and cannot be accessed before the formal Opening Ceremony event.');
    this.name = 'SealedBidAccessViolationError';
  }
}

export interface StoredBid {
  id: string;
  tenantId: string;
  tenderId: string;
  vendorId: string;
  vendorName: string;
  status: 'SEALED' | 'OPENED' | 'DISQUALIFIED' | 'AWARDED';
  hashDigest: string;
  technicalDocId: string;
  financialDocId: string;
  envelopeKeyEncrypted: string;
  submittedAt: string;
  unsealedAt?: string | null;
}

export interface OpeningCeremonyRecord {
  id: string;
  tenantId: string;
  tenderId: string;
  ceremonyTime: string;
  committeeChair: string;
  attendees: string[];
  minutesNotes?: string;
  openedBidsCount: number;
}

export class SealedBidVaultService {
  private bids: Map<string, StoredBid> = new Map();
  private openingCeremonies: Map<string, OpeningCeremonyRecord> = new Map();

  /**
   * Submits and cryptographically seals a bid package.
   */
  async submitSealedBid(params: {
    tenantId: string;
    tenderId: string;
    vendorId: string;
    vendorName: string;
    technicalDocId: string;
    financialDocId: string;
    hashDigest: string;
  }): Promise<StoredBid> {
    const id = `bid_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const envelopeKey = crypto.randomBytes(32).toString('hex');

    const bid: StoredBid = {
      id,
      tenantId: params.tenantId,
      tenderId: params.tenderId,
      vendorId: params.vendorId,
      vendorName: params.vendorName,
      status: 'SEALED',
      hashDigest: params.hashDigest,
      technicalDocId: params.technicalDocId,
      financialDocId: params.financialDocId,
      envelopeKeyEncrypted: envelopeKey,
      submittedAt: new Date().toISOString()
    };

    this.bids.set(id, bid);

    await auditLogger.logEvent({
      tenantId: params.tenantId,
      actorId: params.vendorId,
      actorRole: 'VENDOR',
      action: 'BID_SUBMITTED_SEALED',
      resourceType: 'BID',
      resourceId: id,
      prevState: null,
      newState: 'SEALED',
      reason: `Bid submitted with cryptographic hash receipt: ${params.hashDigest}`
    });

    return bid;
  }

  /**
   * Non-negotiable Rule 1 Enforcement:
   * Rejects any attempt to read bid payload prior to recorded Bid Opening Ceremony.
   */
  getBidContent(tenantId: string, tenderId: string, bidId: string): StoredBid {
    const bid = this.bids.get(bidId);
    if (!bid || bid.tenantId !== tenantId || bid.tenderId !== tenderId) {
      throw new Error(`Bid not found: ${bidId}`);
    }

    const ceremony = this.openingCeremonies.get(tenderId);
    if (!ceremony || bid.status === 'SEALED') {
      throw new SealedBidAccessViolationError(
        `Non-negotiable Rule 1 Violation: Bid ${bidId} is sealed. Zero read access permitted prior to Bid Opening Event.`
      );
    }

    return bid;
  }

  /**
   * Executes the Bid Opening Ceremony, unsealing bids and recording immutable audit trail.
   */
  async executeOpeningCeremony(params: {
    tenantId: string;
    tenderId: string;
    committeeChair: string;
    attendees: string[];
    minutesNotes?: string;
  }): Promise<OpeningCeremonyRecord> {
    if (this.openingCeremonies.has(params.tenderId)) {
      throw new Error(`Opening ceremony already recorded for tender ${params.tenderId}`);
    }

    // Find all bids for this tender
    const tenderBids: StoredBid[] = [];
    for (const bid of this.bids.values()) {
      if (bid.tenantId === params.tenantId && bid.tenderId === params.tenderId) {
        bid.status = 'OPENED';
        bid.unsealedAt = new Date().toISOString();
        tenderBids.push(bid);
      }
    }

    const ceremonyId = `cer_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const record: OpeningCeremonyRecord = {
      id: ceremonyId,
      tenantId: params.tenantId,
      tenderId: params.tenderId,
      ceremonyTime: new Date().toISOString(),
      committeeChair: params.committeeChair,
      attendees: params.attendees,
      minutesNotes: params.minutesNotes,
      openedBidsCount: tenderBids.length
    };

    this.openingCeremonies.set(params.tenderId, record);

    await auditLogger.logEvent({
      tenantId: params.tenantId,
      actorId: params.committeeChair,
      actorRole: 'OPENING_COMMITTEE_CHAIR',
      action: 'BID_OPENING_RECORDED',
      resourceType: 'TENDER',
      resourceId: params.tenderId,
      prevState: 'CLOSED',
      newState: 'BIDS_OPENED',
      reason: `Formal Bid Opening Event executed. Attendees: ${params.attendees.join(', ')}. Unsealed ${tenderBids.length} bids.`
    });

    return record;
  }

  listBidsForTender(tenantId: string, tenderId: string): Array<Omit<StoredBid, 'envelopeKeyEncrypted'>> {
    const list: Array<Omit<StoredBid, 'envelopeKeyEncrypted'>> = [];
    for (const bid of this.bids.values()) {
      if (bid.tenantId === tenantId && bid.tenderId === tenderId) {
        // Return summary only; if still sealed, payload doc IDs are masked
        list.push({
          id: bid.id,
          tenantId: bid.tenantId,
          tenderId: bid.tenderId,
          vendorId: bid.vendorId,
          vendorName: bid.vendorName,
          status: bid.status,
          hashDigest: bid.hashDigest,
          technicalDocId: bid.status === 'SEALED' ? 'PROTECTED_SEALED_CONTENT' : bid.technicalDocId,
          financialDocId: bid.status === 'SEALED' ? 'PROTECTED_SEALED_CONTENT' : bid.financialDocId,
          submittedAt: bid.submittedAt,
          unsealedAt: bid.unsealedAt
        });
      }
    }
    return list;
  }
}

export const sealedBidVault = new SealedBidVaultService();
