# Implementation Summary

## Tasks Completed

- [x] `package.json` — ESM project, all runtime + dev dependencies, pnpm scripts
- [x] `tsconfig.json` — ES2022, NodeNext module/moduleResolution, strict mode
- [x] `.env.example` — all env vars with placeholder values and comments
- [x] `.gitignore` — node_modules, dist, .env, pnpm-debug.log
- [x] `Dockerfile` — multi-stage build (node:20-alpine), non-root USER node
- [x] `docker-compose.yml` — single service doc-processor, env_file .env
- [x] `src/config.ts` — dotenv load, required-var validation with fail-fast, frozen export
- [x] `src/logger.ts` — pino logger, pino-pretty in dev, JSON in prod
- [x] `src/sentry.ts` — conditional init via GLITCHTIP_DSN, captureException helper, Express middleware helpers
- [x] `src/types/document.ts` — all types as specified
- [x] `src/middleware/request-logger.ts` — pino-http with named pinoHttp import
- [x] `src/middleware/error-handler.ts` — AppError class, global Express error handler
- [x] `src/services/ocr.service.ts` — multipart form POST via form-data + fetch, OCR_TIMEOUT_MS
- [x] `src/services/ollama.service.ts` — classification prompt in German, JSON extraction, date/amount parsing, retry once on failure, returns Unbekannt on error
- [x] `src/services/supabase.service.ts` — uploadPdf + insertDocument, retry with 2s delay, merge-duplicates upsert
- [x] `src/pipeline/queue.ts` — p-queue v8 (ESM), in-memory job Map, addJob/getJob/getStats
- [x] `src/pipeline/processor.ts` — OCR -> classify -> store pipeline, child logger, Sentry capture on hard failures
- [x] `src/routes/documents.ts` — POST /api/documents (validate + enqueue), GET /:jobId/status, optional API key auth
- [x] `src/routes/health.ts` — GET /health with queue stats
- [x] `src/app.ts` — Express app, all middleware in correct order
- [x] `src/index.ts` — server startup with startup log

## Files Changed

All files created fresh:

- `/home/mik/Projects/n8nBosa/package.json`
- `/home/mik/Projects/n8nBosa/tsconfig.json`
- `/home/mik/Projects/n8nBosa/.env.example`
- `/home/mik/Projects/n8nBosa/.gitignore`
- `/home/mik/Projects/n8nBosa/Dockerfile`
- `/home/mik/Projects/n8nBosa/docker-compose.yml`
- `/home/mik/Projects/n8nBosa/src/config.ts`
- `/home/mik/Projects/n8nBosa/src/logger.ts`
- `/home/mik/Projects/n8nBosa/src/sentry.ts`
- `/home/mik/Projects/n8nBosa/src/index.ts`
- `/home/mik/Projects/n8nBosa/src/app.ts`
- `/home/mik/Projects/n8nBosa/src/types/document.ts`
- `/home/mik/Projects/n8nBosa/src/middleware/request-logger.ts`
- `/home/mik/Projects/n8nBosa/src/middleware/error-handler.ts`
- `/home/mik/Projects/n8nBosa/src/services/ocr.service.ts`
- `/home/mik/Projects/n8nBosa/src/services/ollama.service.ts`
- `/home/mik/Projects/n8nBosa/src/services/supabase.service.ts`
- `/home/mik/Projects/n8nBosa/src/pipeline/queue.ts`
- `/home/mik/Projects/n8nBosa/src/pipeline/processor.ts`
- `/home/mik/Projects/n8nBosa/src/routes/documents.ts`
- `/home/mik/Projects/n8nBosa/src/routes/health.ts`

## Deviations from Plan

1. **pino-http import**: The plan's default import `pinoHttp from 'pino-http'` does not work with the v10 type declarations. Used the named export `{ pinoHttp }` instead, which is what the type file exports.

2. **Buffer as fetch body**: Node 20's built-in `fetch` does not accept `Buffer` as `BodyInit`. The OCR multipart body and Supabase PDF upload are wrapped in `new Uint8Array(buffer)` which is a valid `BodyInit` and preserves byte content without copying data.

3. **Express Router type**: `@types/express-serve-static-core@5.1.1` types `ParamsDictionary[key: string]` as `string | string[]`. Added explicit `IRouter` type annotations on router variables and safe handling for `req.params['jobId']` to satisfy strict mode.

4. **Sentry ESM ordering**: `import` statements in ESM are statically hoisted before execution. The plan's "import Sentry FIRST" is approximated by calling `setupSentry()` at the top of `app.ts` body before any service code executes. True Sentry-first initialization would require a dedicated entry file.

## Known Gaps / Follow-up Needed

- `pnpm-lock.yaml` is generated on first `pnpm install`. Commit it before building the Docker image, as the Dockerfile uses `--frozen-lockfile`.
- OCR response field name: the service assumes `{ text }`, `{ result }`, or `{ extracted_text }`. Verify against the live `ocr.unicatsolutions.de` API response shape.
- Supabase upsert key is `ab_nummer`. Documents without `ab_nummer` (Rechnung, Angebot, Unbekannt) always insert new rows. If deduplication is needed for non-AB categories, a different conflict column or composite key is required.
