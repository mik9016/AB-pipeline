import { timingSafeEqual } from 'node:crypto';
import { Router, type IRouter } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { addJob, getJob, getStats } from '../pipeline/queue.js';
import { processDocument } from '../pipeline/processor.js';
import { config } from '../config.js';
import { AppError } from '../middleware/error-handler.js';
import type { DocumentRequest, DocumentJob, DocumentResponse } from '../types/document.js';

const MAX_DOCUMENTS_PER_REQUEST = 20;
const MAX_QUEUE_DEPTH = 500;

const router: IRouter = Router();

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function validateApiKey(req: Request, _res: Response, next: NextFunction): void {
  const providedKey = req.headers['x-api-key'];
  if (typeof providedKey !== 'string' || !safeCompare(providedKey, config.apiKey)) {
    next(new AppError('Unauthorized', 401));
    return;
  }
  next();
}

function isValidDocumentRequest(doc: unknown): doc is DocumentRequest {
  if (typeof doc !== 'object' || doc === null) return false;
  const d = doc as Record<string, unknown>;
  return (
    typeof d['parentMessageId'] === 'string' &&
    typeof d['attachmentId'] === 'string' &&
    typeof d['originalFilename'] === 'string' &&
    typeof d['pdfBase64'] === 'string'
  );
}

router.post('/', validateApiKey, (req: Request, res: Response, next: NextFunction): void => {
  const body = req.body as Record<string, unknown>;

  if (!Array.isArray(body['documents'])) {
    next(new AppError('Request body must contain a "documents" array', 400));
    return;
  }

  const documents = body['documents'] as unknown[];
  if (documents.length === 0) {
    next(new AppError('"documents" array must not be empty', 400));
    return;
  }

  if (documents.length > MAX_DOCUMENTS_PER_REQUEST) {
    next(new AppError(`Maximum ${MAX_DOCUMENTS_PER_REQUEST} documents per request`, 400));
    return;
  }

  const stats = getStats();
  if (stats.queueDepth + documents.length > MAX_QUEUE_DEPTH) {
    next(new AppError('Queue is full, try again later', 503));
    return;
  }

  const invalidIndex = documents.findIndex((d) => !isValidDocumentRequest(d));
  if (invalidIndex !== -1) {
    next(
      new AppError(
        `Document at index ${invalidIndex} is missing required fields: ` +
          'parentMessageId, attachmentId, originalFilename, pdfBase64',
        400,
      ),
    );
    return;
  }

  const acceptedJobs: DocumentResponse[] = [];

  for (const doc of documents as DocumentRequest[]) {
    let pdfBuffer: Buffer;
    try {
      const raw = doc.pdfBase64.includes(',') ? doc.pdfBase64.split(',')[1] : doc.pdfBase64;
      pdfBuffer = Buffer.from(raw, 'base64');
    } catch {
      next(new AppError(`Invalid base64 for document "${doc.originalFilename}"`, 400));
      return;
    }

    const job: DocumentJob = {
      id: uuidv4(),
      parentMessageId: doc.parentMessageId,
      attachmentId: doc.attachmentId,
      originalFilename: doc.originalFilename,
      pdfBuffer,
      emailFrom: doc.emailFrom ?? '',
      emailTo: doc.emailTo ?? '',
      status: 'queued',
      receivedAt: new Date(),
    };

    addJob(job, processDocument);

    acceptedJobs.push({
      jobId: job.id,
      filename: job.originalFilename,
      status: job.status,
    });
  }

  res.status(202).json({
    accepted: acceptedJobs.length,
    jobs: acceptedJobs,
  });
});

router.get('/:jobId/status', validateApiKey, (req: Request, res: Response, next: NextFunction): void => {
  const jobId = req.params['jobId'];
  const job = getJob(Array.isArray(jobId) ? jobId[0]! : jobId!);

  if (!job) {
    next(new AppError(`Job ${jobId} not found`, 404));
    return;
  }

  res.json({
    jobId: job.id,
    filename: job.originalFilename,
    status: job.status,
    error: job.error,
    classification: job.status === 'done' ? job.classification : undefined,
    receivedAt: job.receivedAt,
    completedAt: job.completedAt,
  });
});

export default router;
