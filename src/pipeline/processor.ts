import { logger } from '../logger.js';
import { captureException } from '../sentry.js';
import { extractTextFromPdf } from '../services/ocr.service.js';
import { classifyDocument } from '../services/ollama.service.js';
import { uploadPdf, insertDocument, buildInsertData } from '../services/supabase.service.js';
import type { DocumentJob } from '../types/document.js';

function elapsed(start: number): number {
  return Date.now() - start;
}

export async function processDocument(job: DocumentJob): Promise<void> {
  const log = logger.child({ jobId: job.id, filename: job.originalFilename });
  const jobStart = Date.now();

  // Step 1: OCR
  job.status = 'ocr';
  const ocrStart = Date.now();
  try {
    log.info('Starting OCR');
    job.ocrText = await extractTextFromPdf(job.pdfBuffer, job.originalFilename);
    log.info({ durationMs: elapsed(ocrStart) }, 'OCR complete');
  } catch (err) {
    log.error({ err, durationMs: elapsed(ocrStart) }, 'OCR failed — marking job as failed');
    job.status = 'failed';
    job.error = err instanceof Error ? err.message : String(err);
    captureException(err);
    return;
  }

  // Step 2: Classification
  job.status = 'classifying';
  const classifyStart = Date.now();
  try {
    log.info('Starting classification');
    job.classification = await classifyDocument(job.ocrText ?? '', job.originalFilename);
    log.info(
      { category: job.classification.category, durationMs: elapsed(classifyStart) },
      'Classification complete',
    );
  } catch (err) {
    // Classification errors do not fail the job — store as Unbekannt
    log.warn({ err, durationMs: elapsed(classifyStart) }, 'Classification error — using Unbekannt');
    job.classification = {
      category: 'Unbekannt',
      confidence: 0,
      rawResponse: '',
    };
  }

  // Step 3: Store
  job.status = 'storing';
  const storeStart = Date.now();
  try {
    log.info('Uploading PDF and storing metadata');

    const classification = job.classification!;
    const jahr = job.receivedAt.getFullYear();
    const rawName = classification.ab_nummer ?? job.originalFilename.replace(/\.pdf$/i, '');
    const safeFilename = rawName
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
      .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
      .replace(/ß/g, 'ss')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 200);
    const storagePath = `${jahr}/${safeFilename}.pdf`;

    const pdfUrl = await uploadPdf(job.pdfBuffer, storagePath);

    const insertData = buildInsertData({
      classification,
      originalFilename: job.originalFilename,
      storagePath,
      pdfUrl,
      emailFrom: job.emailFrom,
      emailTo: job.emailTo,
      receivedAt: job.receivedAt,
    });

    await insertDocument(insertData);

    log.info({ storagePath, pdfUrl, durationMs: elapsed(storeStart) }, 'Storage complete');
  } catch (err) {
    log.error({ err, durationMs: elapsed(storeStart) }, 'Storage failed — marking job as failed');
    job.status = 'failed';
    job.error = err instanceof Error ? err.message : String(err);
    captureException(err);
    return;
  }

  job.status = 'done';
  job.completedAt = new Date();
  log.info({ totalDurationMs: elapsed(jobStart) }, 'Job complete');
}
