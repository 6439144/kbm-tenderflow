import { Router, Response } from 'express';
import { Readable } from 'stream';
import { AuthenticatedRequest } from '../middleware/tenant.js';
import { createContentStore, DocumentMetadata } from '@tenderflow/content-adapter';
import { auditLogger } from '../services/audit.js';

export const documentsRouter = Router();
const contentStore = createContentStore();

documentsRouter.post('/upload', async (req: AuthenticatedRequest, res: Response) => {
  const { title, docType, mimeType, contentBase64, customProperties } = req.body;

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

documentsRouter.get('/:documentId', async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenantId || 'kea';
  const { documentId } = req.params;

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

  try {
    const record = await contentStore.getDocumentMetadata(tenantId, documentId);
    res.json(record);
  } catch (err: any) {
    res.status(404).json({ code: 'DOCUMENT_NOT_FOUND', message: err.message });
  }
});
