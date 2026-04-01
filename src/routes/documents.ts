import { timingSafeEqual } from 'node:crypto';
import { Router, type IRouter } from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { addJob, getJob, getStats } from '../pipeline/queue.js';
import { processDocument } from '../pipeline/processor.js';
import { config } from '../config.js';
import { AppError } from '../middleware/error-handler.js';
import type { DocumentJob, DocumentResponse } from '../types/document.js';

const MAX_QUEUE_DEPTH = 500;

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

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

router.post(
  '/',
  validateApiKey,
  upload.single('file'),
  (req: Request, res: Response, next: NextFunction): void => {
    if (!req.file) {
      next(new AppError('Missing required field: file (multipart/form-data)', 400));
      return;
    }

    const { parentMessageId, attachmentId, emailFrom, emailTo } = req.body as Record<string, string>;
    const originalFilename = (req.body as Record<string, string>)['originalFilename'] ?? req.file.originalname;

    if (!parentMessageId || !attachmentId) {
      next(new AppError('Missing required fields: parentMessageId, attachmentId', 400));
      return;
    }

    const stats = getStats();
    if (stats.queueDepth + 1 > MAX_QUEUE_DEPTH) {
      next(new AppError('Queue is full, try again later', 503));
      return;
    }

    const job: DocumentJob = {
      id: uuidv4(),
      parentMessageId,
      attachmentId,
      originalFilename,
      pdfBuffer: req.file.buffer,
      emailFrom: emailFrom ?? '',
      emailTo: emailTo ?? '',
      status: 'queued',
      receivedAt: new Date(),
    };

    addJob(job, processDocument);

    const response: { accepted: number; jobs: DocumentResponse[] } = {
      accepted: 1,
      jobs: [{ jobId: job.id, filename: job.originalFilename, status: job.status }],
    };

    res.status(202).json(response);
  },
);

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
