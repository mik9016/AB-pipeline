import { pinoHttp } from 'pino-http';
import type { IncomingMessage, ServerResponse } from 'http';
import type pino from 'pino';
import { logger } from '../logger.js';

export const requestLogger = pinoHttp({
  logger,
  // Redact authorization headers from logs
  redact: ['req.headers.authorization', 'req.headers["x-api-key"]'],
  customLogLevel(
    _req: IncomingMessage,
    res: ServerResponse,
    err: Error | undefined,
  ): pino.LevelWithSilent {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
});
