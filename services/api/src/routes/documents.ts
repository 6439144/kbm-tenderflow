import { Router, Response } from 'express';
import { Readable } from 'stream';
import { AuthenticatedRequest } from '../middleware/auth.js';
import { createContentStore, DocumentMetadata } from '@tenderflow/content-adapter';
import { auditLogger } from '../services/audit.js';
import { sealedBidVault } from '../services/sealed-bid-vault.js';
import { db } from '../db/client.js';

export const documentsRouter = Router();
const contentStore = createContentStore();

documentsRouter.post('/upload', async (req: AuthenticatedRequest, res: Response) => {
  const { title, docType, mimeType, contentBase64, customProperties, owningType, tenderId, vendorId } = req.body;

  if (!title || !docType) {
    res.status(400).json({ code: 'INVALID_REQUEST', message: 'title and docType are required.' });
    return;
  }

  const tenantId = req.tenantId || 'kea';
  const buffer = contentBase64 ? Buffer.from(contentBase64, 'base64') : Buffer.from(`TenderFlow Document: ${title}`);
  const stream = Readable.from(buffer);

  const metadata: DocumentMetadata = {
    title,
    docType,
    mimeType: mimeType || 'application/pdf',
    byteSize: buffer.length,
    uploadedBy: req.user?.id || 'system',
    customProperties
  };

  try {
    const record = await contentStore.uploadDocument(tenantId, metadata, stream);

    // Register document ownership
    sealedBidVault.registerDocument({
      documentId: record.id,
      tenantId,
      owningType: owningType || (docType.startsWith('BID') ? 'BID_TECHNICAL' : 'TENDER_PACK'),
      tenderId,
      vendorId: vendorId || req.user?.vendorId || req.user?.id
    });

    await auditLogger.logEvent({
      tenantId,
      actorId: req.user?.id || 'system',
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
 * Download document with strict ownership and sealed-bid access checking (Rule 1 & G1-c)
 */
documentsRouter.get('/:documentId', async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenantId || 'kea';
  const { documentId } = req.params;

  // Check resource ownership
  const ownership = sealedBidVault.getDocumentOwnership(documentId);
  if (ownership) {
    if (ownership.tenantId !== tenantId) {
      res.status(404).json({ code: 'DOCUMENT_NOT_FOUND', message: 'Document not found in this tenant.' });
      return;
    }

    // Protection for Sealed Bid attachments (Rule 1)
    if (ownership.owningType === 'BID_TECHNICAL' || ownership.owningType === 'BID_FINANCIAL') {
      const isOpened = ownership.tenderId ? sealedBidVault.isTenderOpened(ownership.tenderId) : false;
      if (!isOpened) {
        res.status(403).json({
          code: 'BIDS_SEALED_UNTIL_OPENING_EVENT',
          message: 'Non-negotiable Rule 1 Violation: Document is a sealed bid attachment and cannot be downloaded before the formal Bid Opening Ceremony.'
        });
        return;
      }

      // If opened, competitor vendor cannot download another vendor's bid document
      if (req.user?.role === 'VENDOR') {
        const callerVendorId = req.user.vendorId || req.user.id;
        if (ownership.vendorId && ownership.vendorId !== callerVendorId) {
          res.status(403).json({
            code: 'FORBIDDEN_COMPETITOR_ACCESS',
            message: 'Vendors are forbidden from accessing attachments of competing bids.'
          });
          return;
        }
      }
    }

    // Protection for Tender Pack: public/vendor can only download if published
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

  // Mask metadata if it's a sealed bid attachment prior to opening
  const ownership = sealedBidVault.getDocumentOwnership(documentId);
  if (ownership && (ownership.owningType === 'BID_TECHNICAL' || ownership.owningType === 'BID_FINANCIAL')) {
    const isOpened = ownership.tenderId ? sealedBidVault.isTenderOpened(ownership.tenderId) : false;
    if (!isOpened) {
      res.status(403).json({
        code: 'BIDS_SEALED_UNTIL_OPENING_EVENT',
        message: 'Non-negotiable Rule 1 Violation: Document metadata is sealed prior to opening.'
      });
      return;
    }
  }

  try {
    const record = await contentStore.getDocumentMetadata(tenantId, documentId);
    res.json(record);
  } catch (err: any) {
    res.status(404).json({ code: 'DOCUMENT_NOT_FOUND', message: err.message });
  }
});
