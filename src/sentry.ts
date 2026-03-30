import { config } from './config.js';
import type { ErrorRequestHandler, RequestHandler } from 'express';

let sentryInitialized = false;
let sentryCaptureExceptionFn: ((error: unknown) => void) | null = null;

export async function setupSentry(): Promise<void> {
  if (!config.glitchtipDsn) {
    return;
  }

  const Sentry = await import('@sentry/node');
  Sentry.init({
    dsn: config.glitchtipDsn,
    environment: config.nodeEnv,
    tracesSampleRate: 0,
  });
  sentryCaptureExceptionFn = Sentry.captureException.bind(Sentry);
  sentryInitialized = true;
}

export function captureException(error: unknown): void {
  if (sentryInitialized && sentryCaptureExceptionFn) {
    sentryCaptureExceptionFn(error);
  }
}

export function getSentryErrorHandler(): ErrorRequestHandler {
  const handler: ErrorRequestHandler = (err, _req, _res, next) => {
    if (sentryInitialized) {
      captureException(err);
    }
    next(err);
  };
  return handler;
}

export function getSentryRequestHandler(): RequestHandler {
  const noop: RequestHandler = (_req, _res, next) => next();
  return noop;
}
