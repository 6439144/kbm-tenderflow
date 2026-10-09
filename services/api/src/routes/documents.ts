import { Router, Response } from 'express';
import { Readable } from 'stream';
import { AuthenticatedRequest } from '../middleware/auth.js';
import { createContentStore, DocumentMetadata } from '@tenderflow/content-adapter';
import { auditLogger } from '../services/audit.js';
import { sealedBidVault } from '../services/sealed-bid-vault.js';
import { db } from '../db/client.js';

export const documentsRouter = Router();
const contentStore = createContentStore();

/**
 * Upload document
 * Derives owningType on server, ignores client asserted owningType/vendorId (Reviewer R1b-3)
 */
documentsRouter.post('/upload', async (req: AuthenticatedRequest, res: Response) => {
  const { title, docType, mimeType, contentBase64, customProperties, tenderId } = req.body;

  if (!title || !docType) {
    res.status(400).json({ code: 'INVALID_REQUEST', message: 'title and docType are required.' });
    return;
  }

  const tenantId = req.tenantId || 'kea';
  const buffer = contentBase64 ? Buffer.from(contentBase64, 'base64') : Buffer.from(`TenderFlow Document: ${title}`);
  const stream = Readable.from(buffer);

  // Server-side derivation of owningType from docType (Rule R1b-3)
  let derivedOwningType: 'BID_TECHNICAL' | 'BID_FINANCIAL' | 'VENDOR_DOC' | 'TENDER_PACK' = 'TENDER_PACK';
  const upperDocType = docType.toUpperCase();

  if (upperDocType === 'TECHNICAL_PROPOSAL' || upperDocType.includes('TECHNICAL')) {
    derivedOwningType = 'BID_TECHNICAL';
  } else if (upperDocType === 'FINANCIAL_PROPOSAL' || upperDocType.includes('FINANCIAL')) {
    derivedOwningType = 'BID_FINANCIAL';
  } else if (upperDocType.startsWith('BID')) {
    derivedOwningType = 'BID_TECHNICAL';
  } else if (
    upperDocType === 'CR_CERTIFICATE' ||
    upperDocType === 'TAX_CERTIFICATE' ||
    upperDocType === 'VENDOR_REGISTRATION' ||
    req.user?.role === 'VENDOR'
  ) {
    derivedOwningType = 'VENDOR_DOC';
  } else {
    derivedOwningType = 'TENDER_PACK';
  }

  const uploaderId = req.user?.id || 'system';
  const uploaderVendorId = req.user?.vendorId || req.user?.id;

  const metadata: DocumentMetadata = {
    title,
    docType,
    mimeType: mimeType || 'application/pdf',
    byteSize: buffer.length,
    uploadedBy: uploaderId,
    customProperties
  };

  try {
    const record = await contentStore.uploadDocument(tenantId, metadata, stream);

    // Register document ownership bound strictly to server identity (R1b-3)
    sealedBidVault.registerDocument({
      documentId: record.id,
      tenantId,
      owningType: derivedOwningType,
      tenderId: tenderId || undefined,
      vendorId: uploaderVendorId
    });

    await auditLogger.logEvent({
      tenantId,
      actorId: uploaderId,
      actorRole: req.user?.role || 'USER',
      action: 'DOCUMENT_UPLOADED',
      resourceType: 'DOCUMENT',
      resourceId: record.id,
      prevState: null,
      newState: 'STORED',
      reason: `Uploaded ${title} to ${record.storageBackend} store.`
    });

    res.status(201).json(record);
  } catch (err: any) {
    res.status(500).json({ code: 'UPLOAD_FAILED', message: err.message });
  }
});

/**
 * Download document with strict ownership and sealed-bid access checking (Rule 1 & Reviewer R1b-3)
 * Denies by default (unknown document -> 404)
 */
documentsRouter.get('/:documentId', async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenantId || 'kea';
  const { documentId } = req.params;

  // 1. Deny by default: check registered resource ownership (R1b-3)
  const ownership = sealedBidVault.getDocumentOwnership(documentId);
  if (!ownership || ownership.tenantId !== tenantId) {
    res.status(404).json({ code: 'DOCUMENT_NOT_FOUND', message: 'Document not found or access denied.' });
    return;
  }

  // 2. Protection for Sealed Bid attachments (Rule 1 / R1b-3)
  if (ownership.owningType === 'BID_TECHNICAL' || ownership.owningType === 'BID_FINANCIAL') {
    const isOpened = ownership.tenderId ? sealedBidVault.isTenderOpened(ownership.tenderId) : false;
    
    if (!isOpened) {
      // Prior to opening ceremony: ONLY the uploading vendor can view their own file!
      const callerVendorId = req.user?.vendorId || req.user?.id;
      if (!callerVendorId || callerVendorId !== ownership.vendorId) {
        res.status(403).json({
          code: 'BIDS_SEALED_UNTIL_OPENING_EVENT',
          message: 'Non-negotiable Rule 1 Violation: Document is a sealed bid attachment and cannot be downloaded before the formal Bid Opening Ceremony.'
        });
        return;
      }
    } else {
      // After opening ceremony: Competitor vendors are STILL forbidden!
      if (req.user?.role === 'VENDOR') {
        const callerVendorId = req.user?.vendorId || req.user?.id;
        if (callerVendorId !== ownership.vendorId) {
          res.status(403).json({
            code: 'FORBIDDEN_COMPETITOR_ACCESS',
            message: 'Vendors are forbidden from accessing attachments of competing bids.'
          });
          return;
        }
      }
    }
  }

  // 3. Protection for Vendor Documents
  if (ownership.owningType === 'VENDOR_DOC') {
    if (req.user?.role === 'VENDOR') {
      const callerVendorId = req.user?.vendorId || req.user?.id;
      if (callerVendorId !== ownership.vendorId) {
        res.status(403).json({
          code: 'FORBIDDEN_COMPETITOR_ACCESS',
          message: 'Vendors are forbidden from accessing documents of competing vendors.'
        });
        return;
      }
    }
  }

  // 4. Protection for Tender Pack: public/vendor can only download if published
  if (ownership.owningType === 'TENDER_PACK' && ownership.tenderId) {
    const tender = db.tenders.get(ownership.tenderId);
    const isVendorOrPublic = !req.user || req.user.role === 'VENDOR' || req.user.role === 'PUBLIC';
    if (tender && isVendorOrPublic && (tender.status === 'DRAFT' || tender.status === 'APPROVED_FOR_PUBLICATION')) {
      res.status(403).json({
        code: 'TENDER_NOT_PUBLISHED',
        message: 'Tender pack documents cannot be accessed before public publication.'
      });
      return;
    }
  }

  try {
    const { record, stream } = await contentStore.getDocument(tenantId, documentId);
    res.setHeader('Content-Type', record.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${record.title}"`);
    stream.pipe(res);
  } catch (err: any) {
    res.status(404).json({ code: 'DOCUMENT_NOT_FOUND', message: err.message });
  }
});

documentsRouter.get('/:documentId/metadata', async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenantId || 'kea';
  const { documentId } = req.params;

  // Deny by default: check registered resource ownership (R1b-3)
  const ownership = sealedBidVault.getDocumentOwnership(documentId);
  if (!ownership || ownership.tenantId !== tenantId) {
    res.status(404).json({ code: 'DOCUMENT_NOT_FOUND', message: 'Document not found or access denied.' });
    return;
  }

  if (ownership.owningType === 'BID_TECHNICAL' || ownership.owningType === 'BID_FINANCIAL') {
    const isOpened = ownership.tenderId ? sealedBidVault.isTenderOpened(ownership.tenderId) : false;
    if (!isOpened) {
      const callerVendorId = req.user?.vendorId || req.user?.id;
      if (!callerVendorId || callerVendorId !== ownership.vendorId) {
        res.status(403).json({
          code: 'BIDS_SEALED_UNTIL_OPENING_EVENT',
          message: 'Non-negotiable Rule 1 Violation: Document metadata is sealed prior to opening.'
        });
        return;
      }
    }
  }

  try {
    const record = await contentStore.getDocumentMetadata(tenantId, documentId);
    res.json(record);
  } catch (err: any) {
    res.status(404).json({ code: 'DOCUMENT_NOT_FOUND', message: err.message });
  }
});
