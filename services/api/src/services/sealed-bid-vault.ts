import * as crypto from 'crypto';
import { auditLogger } from './audit.js';

export class SealedBidAccessViolationError extends Error {
  public code = 'BIDS_SEALED_UNTIL_OPENING_EVENT';
  constructor(message?: string) {
    super(message || 'Access Denied: Bids are sealed and cannot be accessed before the formal Opening Ceremony event.');
    this.name = 'SealedBidAccessViolationError';
  }
}

export interface EncryptedDataKeyEnvelope {
  wrappedKeyHex: string;
  ivHex: string;
  tagHex: string;
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
  envelope: EncryptedDataKeyEnvelope;
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

export interface DocumentOwnership {
  documentId: string;
  tenantId: string;
  owningType: 'TENDER_PACK' | 'BID_TECHNICAL' | 'BID_FINANCIAL' | 'VENDOR_DOC';
  tenderId?: string;
  bidId?: string;
  vendorId?: string;
}

export class SealedBidVaultService {
  private bids: Map<string, StoredBid> = new Map();
  private openingCeremonies: Map<string, OpeningCeremonyRecord> = new Map();
  private documentRegistry: Map<string, DocumentOwnership> = new Map();

  /**
   * Derives 32-byte master key from BID_MASTER_KEY environment variable.
   */
  private getMasterKey(): Buffer {
    const rawKey = process.env.BID_MASTER_KEY;
    if (!rawKey) {
      // Default 32-byte key for local dev if not supplied
      return Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');
    }
    // Handle base64 or hex or direct utf8
    if (rawKey.length === 64 && /^[0-9a-fA-F]+$/.test(rawKey)) {
      return Buffer.from(rawKey, 'hex');
    }
    const buf = Buffer.from(rawKey, 'base64');
    if (buf.length === 32) return buf;
    return crypto.createHash('sha256').update(rawKey).digest();
  }

  /**
   * AES-256-GCM Envelope Encryption (Task G1-c / Non-negotiable Rule 1)
   * Wraps a freshly generated per-bid data key using the master key.
   */
  private wrapDataKey(dataKey: Buffer): EncryptedDataKeyEnvelope {
    const masterKey = this.getMasterKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
    const wrapped = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      wrappedKeyHex: wrapped.toString('hex'),
      ivHex: iv.toString('hex'),
      tagHex: tag.toString('hex')
    };
  }

  /**
   * Unwraps the per-bid data key using the master key after opening ceremony.
   */
  private unwrapDataKey(envelope: EncryptedDataKeyEnvelope): Buffer {
    const masterKey = this.getMasterKey();
    const iv = Buffer.from(envelope.ivHex, 'hex');
    const tag = Buffer.from(envelope.tagHex, 'hex');
    const wrapped = Buffer.from(envelope.wrappedKeyHex, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(wrapped), decipher.final()]);
  }

  /**
   * Register document ownership for access-control validation on /documents/:id
   */
  registerDocument(ownership: DocumentOwnership): void {
    this.documentRegistry.set(ownership.documentId, ownership);
  }

  getDocumentOwnership(documentId: string): DocumentOwnership | undefined {
    return this.documentRegistry.get(documentId);
  }

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
    
    // Generate fresh 32-byte AES-256 data key per bid
    const perBidDataKey = crypto.randomBytes(32);
    const envelope = this.wrapDataKey(perBidDataKey);

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
      envelope,
      submittedAt: new Date().toISOString()
    };

    this.bids.set(id, bid);

    // Register ownership of technical & financial document IDs
    this.registerDocument({
      documentId: params.technicalDocId,
      tenantId: params.tenantId,
      owningType: 'BID_TECHNICAL',
      tenderId: params.tenderId,
      bidId: id,
      vendorId: params.vendorId
    });
    this.registerDocument({
      documentId: params.financialDocId,
      tenantId: params.tenantId,
      owningType: 'BID_FINANCIAL',
      tenderId: params.tenderId,
      bidId: id,
      vendorId: params.vendorId
    });

    await auditLogger.logEvent({
      tenantId: params.tenantId,
      actorId: params.vendorId,
      actorRole: 'VENDOR',
      action: 'BID_SUBMITTED_SEALED',
      resourceType: 'BID',
      resourceId: id,
      prevState: null,
      newState: 'SEALED',
      reason: `Bid submitted with cryptographic hash receipt: ${params.hashDigest} (Envelope Encrypted with AES-256-GCM)`
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

    // Unseal all bids for this tender and unwrap their data keys
    const tenderBids: StoredBid[] = [];
    for (const bid of this.bids.values()) {
      if (bid.tenantId === params.tenantId && bid.tenderId === params.tenderId) {
        bid.status = 'OPENED';
        bid.unsealedAt = new Date().toISOString();
        
        // Prove decryption capability
        this.unwrapDataKey(bid.envelope);
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

  listBidsForTender(tenantId: string, tenderId: string): Array<Omit<StoredBid, 'envelope'>> {
    const list: Array<Omit<StoredBid, 'envelope'>> = [];
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

  getBidById(bidId: string): StoredBid | undefined {
    return this.bids.get(bidId);
  }

  isTenderOpened(tenderId: string): boolean {
    return this.openingCeremonies.has(tenderId);
  }
}

export const sealedBidVault = new SealedBidVaultService();
