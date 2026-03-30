import { getSentryRequestHandler, getSentryErrorHandler } from './sentry.js';
import express, { type Express } from 'express';
import { requestLogger } from './middleware/request-logger.js';
import { globalErrorHandler } from './middleware/error-handler.js';
import documentsRouter from './routes/documents.js';
import healthRouter from './routes/health.js';

const app: Express = express();

// Sentry request tracing (no-op when DSN absent)
app.use(getSentryRequestHandler());

// HTTP request logging
app.use(requestLogger);

// Body parsing — 50 MB limit to handle large base64-encoded PDFs
app.use(express.json({ limit: '50mb' }));

// Routes
app.use('/api/documents', documentsRouter);
app.use('/health', healthRouter);

// Sentry error handler (must come before global error handler)
app.use(getSentryErrorHandler());

// Global error handler (must be last)
app.use(globalErrorHandler);

export default app;
