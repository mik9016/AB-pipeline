# Security Audit -- 2026-03-30

## Verdict: BLOCKED -- Critical findings

**SEC-Critical:** 2 | **SEC-High:** 4 | **SEC-Medium:** 5 | **SEC-Low:** 3

---

## CRITICAL -- Pipeline BLOCKED

**[SEC-CRIT-1]** `.env` (project root)
**Vulnerability:** Live secret committed to project directory
**Details:** The `.env` file contains a real n8n JWT token (`N8N_API_KEY=eyJhbGci...`). While `.env` is listed in `.gitignore`, the file exists on disk in the project root. If this project is ever initialized as a git repo, pushed to a remote with the `.env` in the working tree, or the `.gitignore` is bypassed (e.g., `git add -f`), this token is exposed. The JWT decodes to a public-API token for `n8n.bosavertrieb.de` with an expiry of 2026-06-12.
**Impact:** Full n8n API access to the production instance.
**Fix:**
1. Rotate the n8n API key immediately -- assume it may be compromised.
2. Remove the `.env` file from version-controlled directories or ensure it is never added.
3. Use a secrets manager or inject secrets via CI/CD environment variables only.

**[SEC-CRIT-2]** `src/routes/documents.ts:12-23` + `src/config.ts:60`
**Vulnerability:** Authentication bypass by default
**Details:** `config.apiKey` defaults to an empty string when `API_KEY` is unset. The `validateApiKey` middleware explicitly skips authentication when `config.apiKey` is falsy (line 13-15). This means the server is **completely unauthenticated by default**. The `.env.example` also documents `API_KEY=` as blank, reinforcing the insecure default.
**Attack scenario:** Any attacker with network access to port 3000 can submit arbitrary documents for processing, consuming OCR/LLM resources, uploading arbitrary PDFs to Supabase storage, and inserting rows into the database.
**Fix:**
```typescript
// config.ts -- make API_KEY required
const REQUIRED_VARS = [
  'API_KEY',        // <-- add this
  'OCR_SERVICE_URL',
  // ...
] as const;

// documents.ts -- always enforce auth
function validateApiKey(req: Request, _res: Response, next: NextFunction): void {
  const providedKey = req.headers['x-api-key'];
  if (!providedKey || providedKey !== config.apiKey) {
    next(new AppError('Unauthorized', 401));
    return;
  }
  next();
}
```

---

## HIGH Severity

**[SEC-HIGH-1]** `src/routes/documents.ts:17-18`
**Vulnerability:** Timing-attack on API key comparison
**Details:** The string comparison `providedKey !== config.apiKey` uses JavaScript's default string equality, which short-circuits on the first differing byte. An attacker can statistically determine the API key one character at a time by measuring response times.
**Fix:** Use a constant-time comparison:
```typescript
import { timingSafeEqual } from 'node:crypto';

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
```

**[SEC-HIGH-2]** `src/pipeline/queue.ts` (entire file)
**Vulnerability:** Unbounded in-memory job store -- denial of service
**Details:** The `jobs` Map grows without bound. Every submitted document's `pdfBuffer` (up to ~37.5 MB decoded from 50 MB base64) is held in memory indefinitely since jobs are never evicted from the Map. An attacker (especially with auth bypass SEC-CRIT-2) can exhaust server memory by submitting many requests.
**Attack scenario:** Submit 100 requests with 50 MB bodies each. The server will retain ~3.75 GB of PDF buffers in memory permanently, leading to OOM kill.
**Fix:**
1. Evict completed/failed jobs after a TTL (e.g., 15 minutes).
2. Null out `job.pdfBuffer` and `job.ocrText` after processing completes.
3. Set a maximum queue depth and reject new submissions when full.

**[SEC-HIGH-3]** No rate limiting on any endpoint
**Vulnerability:** Denial of service via resource exhaustion
**Details:** There is no rate limiting middleware (`express-rate-limit` or similar). Combined with SEC-CRIT-2 (no auth by default), an attacker can flood the server with requests, overwhelming the OCR service, Ollama LLM, and Supabase backend.
**Fix:** Add `express-rate-limit` middleware, at minimum on the `POST /api/documents` endpoint.

**[SEC-HIGH-4]** Missing `.dockerignore` file
**Vulnerability:** Secrets leaked into Docker image layers
**Details:** There is no `.dockerignore` file. The `COPY` instructions in the Dockerfile will include `.env` (containing real secrets) in the build context and the builder stage layer. Even though the runtime stage does not explicitly copy `.env`, the build context is sent to the Docker daemon with secrets included. If multi-stage caching is used or images are pushed with all layers, secrets may be recoverable.
**Fix:** Create `.dockerignore`:
```
.env
.env.*
node_modules/
dist/
.git/
*.log
```

---

## MEDIUM Severity

**[SEC-MED-1]** `src/middleware/error-handler.ts:18-19`
**Vulnerability:** Information leakage in non-production environments
**Details:** When `NODE_ENV !== 'production'`, raw error messages (including stack traces and internal service URLs) are returned to clients. Since `NODE_ENV` defaults to `'development'` in config.ts, any deployment that forgets to set `NODE_ENV=production` will leak internal details.
**Impact:** Internal service URLs (OCR, Ollama, Supabase), error stack traces, and potentially database schema details in error messages.

**[SEC-MED-2]** `src/services/ocr.service.ts:22`, `src/services/ollama.service.ts:146`, `src/services/supabase.service.ts:35`
**Vulnerability:** SSRF risk via environment-controlled URLs
**Details:** The OCR, Ollama, and Supabase service URLs are taken directly from environment variables and used in `fetch()` calls without URL validation. If an attacker gains control of environment variables (e.g., via container escape, CI misconfiguration), they can redirect requests to internal network endpoints.
**Mitigation note:** These URLs come from server-side config, not user input, so the risk is medium rather than high. However, adding URL scheme validation (require `https://`) would be a defense-in-depth improvement.

**[SEC-MED-3]** `src/app.ts:21`
**Vulnerability:** 50 MB body limit enables memory pressure
**Details:** The `express.json({ limit: '50mb' })` setting allows very large request bodies. Combined with the documents array accepting multiple documents per request, a single request could deliver hundreds of megabytes of base64-encoded PDFs.
**Fix:** Add a maximum document count per request (e.g., 10) and consider reducing the body limit.

**[SEC-MED-4]** No CORS, Helmet, or security headers middleware
**Vulnerability:** Missing HTTP security headers
**Details:** The Express app does not use `helmet` for security headers (X-Content-Type-Options, X-Frame-Options, Strict-Transport-Security, etc.) and has no CORS configuration. While this is primarily an API server, security headers are a defense-in-depth measure.
**Fix:** Add `helmet` middleware: `app.use(helmet())`.

**[SEC-MED-5]** `src/services/supabase.service.ts:32`
**Vulnerability:** Path traversal in Supabase storage path
**Details:** The `storagePath` is constructed from `classification.ab_nummer` (LLM output) or `originalFilename` (user input) in `processor.ts:59-62`. While `processor.ts:61` strips some special characters via regex, it does not prevent `..` path traversal sequences. A crafted `originalFilename` like `../../etc/passwd.pdf` would have slashes stripped but the LLM-derived `ab_nummer` could contain `..` sequences.
**Fix:** Validate that the final `storagePath` does not contain `..` and is a simple `year/filename.pdf` pattern.

---

## LOW / Informational

**[SEC-LOW-1]** `src/index.ts:6-13`
**Vulnerability:** Startup log may leak configuration details
**Details:** The startup log includes `ollamaModel` and `queueConcurrency`. While not secrets, this reveals infrastructure details to anyone with log access. Ensure logs are not exposed publicly.

**[SEC-LOW-2]** `Dockerfile:2`
**Vulnerability:** Unpinned base image
**Details:** `node:20-alpine` uses a floating tag. A supply-chain attack on the Node.js Docker image could inject malicious code. Pin to a specific digest: `node:20-alpine@sha256:<digest>`.

**[SEC-LOW-3]** `src/routes/documents.ts:66-68`
**Vulnerability:** `Buffer.from(data, 'base64')` does not throw on invalid base64
**Details:** Node.js `Buffer.from(string, 'base64')` silently ignores invalid characters rather than throwing. The `try/catch` on line 66-70 will never actually catch malformed base64 -- it will silently produce a corrupted buffer. This is not a security vulnerability per se, but it means the validation does not work as intended. Malformed PDFs will be sent to the OCR service.

---

## Security Checklist Results

### Input Validation & Injection
- [x] No SQL injection vectors (Supabase REST API used, data passed as JSON body)
- [x] No `eval()`, `Function()`, or dynamic code execution
- [x] No XSS vectors (JSON API only, no HTML rendering)
- [ ] Path traversal prevention -- incomplete (SEC-MED-5)
- [ ] All external inputs validated -- base64 validation is ineffective (SEC-LOW-3)
- [x] No command injection vectors

### Authentication & Authorization
- [ ] Auth checks enforced -- auth is optional by default (SEC-CRIT-2)
- [x] No hardcoded credentials in source code (.ts files are clean)
- [ ] API key comparison is timing-safe -- it is not (SEC-HIGH-1)
- [x] Health endpoint is appropriately unauthenticated

### Secrets & Config
- [ ] No secrets in project files -- `.env` contains live JWT (SEC-CRIT-1)
- [x] Secrets sourced from environment variables at runtime
- [x] Sensitive headers redacted from logs (request-logger.ts:9)
- [ ] Error messages do not leak internal details -- they do in non-production (SEC-MED-1)

### Docker / Container
- [x] Final image runs as non-root user (`USER node` in Dockerfile)
- [ ] `.dockerignore` present -- missing (SEC-HIGH-4)
- [x] Multi-stage build with production-only dependencies
- [x] Minimal Alpine base image
- [ ] Base image pinned to digest -- floating tag used (SEC-LOW-2)
- [x] Only port 3000 exposed

### Rust Memory Safety
- N/A (Node.js/TypeScript project)

### Dependency & Supply Chain
- [x] Dependencies are reasonable for the use case
- [x] Lock file present (pnpm-lock.yaml)
- [x] Dev dependencies not installed in production image (`pnpm install --prod`)
- [ ] No known vulnerable versions flagged -- recommend running `pnpm audit`

### Cryptography
- [x] No homebrew crypto
- [ ] Constant-time comparison for secrets -- not used (SEC-HIGH-1)

### DoS Resilience
- [ ] Bounded queue/memory -- unbounded job store (SEC-HIGH-2)
- [ ] Rate limiting -- absent (SEC-HIGH-3)
- [ ] Request size limits appropriate -- 50 MB with no document count cap (SEC-MED-3)

---

## Attack Surface Summary

This is an Express.js HTTP API that accepts PDF documents as base64 over JSON, processes them through an external OCR service, classifies them via an Ollama LLM, and stores results in Supabase. The primary attack surface is:

1. **HTTP ingress** (port 3000): Accepts unauthenticated POST requests with large payloads by default.
2. **Outbound SSRF surface**: Three external service calls (OCR, Ollama, Supabase) using URLs from environment config.
3. **In-memory state**: The job queue retains all PDF buffers indefinitely, creating a memory exhaustion vector.
4. **Supabase storage**: User-influenced file paths written to object storage.

---

## Recommendations (Priority Order)

1. **Rotate the n8n API key** in `.env` immediately and delete the `.env` file from any shared locations.
2. **Make `API_KEY` a required environment variable** -- never allow the server to run unauthenticated.
3. **Use constant-time comparison** for API key validation (`crypto.timingSafeEqual`).
4. **Create a `.dockerignore`** excluding `.env`, `node_modules/`, `.git/`, and logs.
5. **Implement job eviction** -- clear `pdfBuffer` after processing, evict completed jobs after a TTL, and cap maximum queue depth.
6. **Add rate limiting** via `express-rate-limit` on document submission endpoints.
7. **Add `helmet` middleware** for security headers.
8. **Cap documents per request** (e.g., max 10) to limit payload size amplification.
9. **Validate storage paths** to prevent path traversal in Supabase uploads.
10. **Set `NODE_ENV=production`** in the Dockerfile or docker-compose to ensure error details are never leaked.
11. **Pin Docker base image** to a specific digest.
12. **Run `pnpm audit`** regularly and integrate it into CI.

---

Security audit complete: verdict=BLOCKED, critical=2, high=4.
