import type { ErrorRequestHandler } from 'express';
import { logger } from '../logger.js';
import { config } from '../config.js';

export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const globalErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const statusCode = err instanceof AppError ? err.statusCode : 500;
  const message =
    err instanceof AppError || config.nodeEnv !== 'production'
      ? String(err.message ?? err)
      : 'Internal server error';

  logger.error({ err, statusCode }, 'Unhandled error');

  res.status(statusCode).json({ error: message });
};
