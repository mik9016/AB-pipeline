import PQueue from 'p-queue';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { DocumentJob } from '../types/document.js';

const queue = new PQueue({ concurrency: config.queueConcurrency });
const jobs = new Map<string, DocumentJob>();

const JOB_TTL_MS = 15 * 60 * 1000; // 15 minutes

const stats = {
  processed: 0,
  failed: 0,
  startedAt: Date.now(),
};

function scheduleEviction(jobId: string): void {
  setTimeout(() => {
    jobs.delete(jobId);
  }, JOB_TTL_MS);
}

function freeJobData(job: DocumentJob): void {
  job.pdfBuffer = Buffer.alloc(0);
  job.ocrText = undefined;
  if (job.classification) {
    job.classification.rawResponse = '';
  }
}

export function addJob(job: DocumentJob, processor: (job: DocumentJob) => Promise<void>): void {
  jobs.set(job.id, job);
  void queue.add(async () => {
    try {
      await processor(job);
      if (job.status === 'done') {
        stats.processed++;
      } else {
        stats.failed++;
      }
    } catch (err) {
      stats.failed++;
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
    }
    freeJobData(job);
    scheduleEviction(job.id);
  }).catch((err: unknown) => {
    logger.error({ err, jobId: job.id }, 'Queue worker rejected unexpectedly');
  });
}

export function getJob(id: string): DocumentJob | undefined {
  return jobs.get(id);
}

export function getStats(): {
  queueDepth: number;
  processed: number;
  failed: number;
  uptime: number;
} {
  return {
    queueDepth: queue.size + queue.pending,
    processed: stats.processed,
    failed: stats.failed,
    uptime: Math.floor((Date.now() - stats.startedAt) / 1000),
  };
}
