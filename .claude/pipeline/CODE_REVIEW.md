# Code Review — 2026-03-30

## Verdict: ⚠️ Approved with suggestions

**Critical:** 3 | **Major:** 7 | **Minor/Style:** 8

---

## CRITICAL Issues
> Pipeline is BLOCKED until resolved.

---

**[CRITICAL-1]** `src/sentry.ts:15-23` — Floating promise in `setupSentry()`

**Problem:** `setupSentry()` calls `import('@sentry/node').then(...)` but never awaits or returns that promise. The function returns `void` synchronously, meaning `sentryInitialized` will still be `false` for any errors that occur during startup or the first few requests. Sentry will silently drop those events.

**Why:** The dynamic import is async. Any exception captured between process startup and the microtask resolution of the import is lost. This is especially painful because the IMPL_SUMMARY itself notes "Sentry must be initialized before any other imports that could throw."

**Fix:**
```ts
// Option A: Make setupSentry async and await it in index.ts before app.listen
export async function setupSentry(): Promise<void> {
  if (!config.glitchtipDsn) return;
  const { init } = await import('@sentry/node');
  init({
    dsn: config.glitchtipDsn,
    environment: config.nodeEnv,
    tracesSampleRate: 0,
  });
  sentryInitialized = true;
}

// In index.ts:
await setupSentry();
app.listen(config.port, ...);
```

---

**[CRITICAL-2]** `src/sentry.ts:48-58` — Floating promise inside Express error middleware + broken Sentry handler logic

**Problem:** `getSentryErrorHandler()` contains two nested `.then()` chains that are neither awaited nor have rejection handlers. If the dynamic import fails the error is silently swallowed. More critically, the `setupExpressErrorHandler` import is imported but immediately voided (`void setupExpressErrorHandler`) — the Sentry app-level patching is never actually applied. The middleware reduces to: if Sentry is initialized, fire-and-forget `captureException`, then always call `next(err)`.

**Why:** `void setupExpressErrorHandler` on line 51 is a no-op. The variable is discarded. Sentry request context (user, breadcrumbs, transaction) will never be attached to captured exceptions.

**Fix:**
```ts
// The simplest correct implementation for per-request capture:
const handler: ErrorRequestHandler = (err, _req, _res, next) => {
  if (sentryInitialized) {
    // captureException is already defined as a module-level export — reuse it
    void captureException(err); // best-effort; errors here should not block response
  }
  next(err);
};
return handler;
```
If full Sentry Express integration is needed, `setupExpressErrorHandler` must be called once at app setup time (after all routes), not inside a per-request handler.

---

**[CRITICAL-3]** `src/pipeline/queue.ts:16` — `addJob` returns `void` while silently discarding a `Promise<void>` from `queue.add()`

**Problem:** `queue.add()` returns `Promise<void | undefined>`. The return value is discarded (floating promise). Any unhandled rejection thrown inside the queue worker — beyond the inner `catch` — cannot be observed. The inner `catch {}` block on line 24 only catches errors; a promise rejection that slips through (e.g., an error thrown synchronously in `processor` before the first `await`) would become an unhandled rejection crash in Node.

**Why:** p-queue v8 with `throwOnTimeout: false` (default) does not propagate rejections beyond its internal handler when the returned promise is not awaited. Combined with the empty catch `catch {}` on line 24, any rethrown error becomes a silent no-op in the stats but may still emit `unhandledRejection`.

**Fix:**
```ts
export function addJob(job: DocumentJob, processor: (job: DocumentJob) => Promise<void>): void {
  jobs.set(job.id, job);
  // Explicitly void the queued promise and attach a top-level rejection handler
  void queue.add(async () => {
    try {
      await processor(job);
      stats[job.status === 'done' ? 'processed' : 'failed']++;
    } catch (err) {
      stats.failed++;
      // processor already sets job.status = 'failed' internally,
      // but if it throws before doing so, catch that here:
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
    }
  }).catch((err: unknown) => {
    // p-queue itself can reject on timeout or AbortError
    logger.error({ err, jobId: job.id }, 'Queue worker rejected unexpectedly');
  });
}
```

---

## MAJOR Issues

---

**[MAJOR-1]** `src/pipeline/queue.ts:6` — Unbounded in-memory job store causes memory leak

**Problem:** `jobs` is a `Map<string, DocumentJob>` that grows forever. Each `DocumentJob` holds the full `pdfBuffer: Buffer` (potentially megabytes per document). Jobs are added but never removed. Under continuous load, the process will exhaust heap memory.

**Why:** `pdfBuffer` is never cleared after the job completes. A 5 MB PDF that completes will sit in the Map in full until process restart.

**Fix — two parts:**
1. After a job reaches `done` or `failed`, null out the buffer in `processDocument` after the upload step:
```ts
// processor.ts — immediately after uploadPdf() succeeds:
(job as { pdfBuffer: Buffer | null }).pdfBuffer = null!;
```
Or add an optional field `pdfBuffer?: Buffer | null` to `DocumentJob` and set it to `null` post-upload.

2. Evict completed jobs from the Map after a TTL (e.g., 1 hour) or cap map size. A simple approach:
```ts
// After marking job done/failed, schedule eviction:
setTimeout(() => jobs.delete(job.id), 60 * 60 * 1000);
```

---

**[MAJOR-2]** `src/services/ollama.service.ts:261-262` — `modelle` and `modelle_str` always hold the same value

**Problem:** Both fields are assigned `parsed['modelle']`. If these are meant to differ (e.g., `modelle` = raw string, `modelle_str` = formatted/truncated string), the logic is wrong. If they are genuinely identical, storing the same data twice under two keys is wasteful and will cause confusion when reading the database.

**Why:** `ClassificationResult` and `InsertDocumentData` both carry `modelle` and `modelle_str`, implying different purposes. The current code defeats any distinction.

**Fix:** Clarify the intent. If `modelle` is an array and `modelle_str` is its stringified version, then `modelle` should be `parsed['modelle']` (kept raw) and `modelle_str` should be `Array.isArray(...) ? arr.join(', ') : string`. If they are always the same, remove one field from both `ClassificationResult` and `InsertDocumentData`.

---

**[MAJOR-3]** `src/services/supabase.service.ts:125` — `on_conflict=ab_nummer` upsert will silently swallow duplicate non-AB documents

**Problem:** All documents — including `Rechnung`, `Angebot`, and `Unbekannt` — are inserted to the same endpoint with `on_conflict=ab_nummer&Prefer: resolution=merge-duplicates`. Documents without `ab_nummer` will have `null` in that column. PostgreSQL `ON CONFLICT` does not trigger on NULL values (NULLs are never equal), so duplicate non-AB documents insert new rows, which is noted as a "Known Gap." However, the more dangerous scenario is the inverse: if two different documents somehow share an `ab_nummer` due to an LLM error, they will be silently merged without any warning.

**Why:** Data loss is silent — no log line, no error, no returned ID to compare. The caller has no way to detect a merge happened.

**Fix:** Add a `return=representation` Prefer header and log when a row is returned (merge occurred):
```ts
headers: supabaseHeaders({
  'Content-Type': 'application/json',
  Prefer: 'return=representation,resolution=merge-duplicates',
}),
```
Then check `response.status === 200` (merged) vs `201` (created) and log accordingly.

---

**[MAJOR-4]** `src/routes/documents.ts:64-71` — `next()` called inside `for` loop after continuing iteration

**Problem:** When `Buffer.from(doc.pdfBase64, 'base64')` throws and `next(new AppError(...))` is called inside the `for` loop, the loop does not `return` from the outer handler function — it returns from the catch block, but the `for` loop continues to the next iteration. Any subsequent valid documents will still be enqueued and `res.status(202).json(...)` will be called after `next(error)` was already invoked, resulting in headers-already-sent errors.

**Why:** `return` inside a `catch` only exits the `catch` block, not the enclosing function. The `for` loop resumes.

**Fix:**
```ts
for (const doc of documents as DocumentRequest[]) {
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = Buffer.from(doc.pdfBase64, 'base64');
  } catch {
    next(new AppError(`Invalid base64 for document "${doc.originalFilename}"`, 400));
    return; // <-- must return from the handler, not just the catch
  }
  // ...rest of loop
}
```

---

**[MAJOR-5]** `src/config.ts:15-21` — `requireEnv` silently treats empty string `""` as missing

**Problem:** `requireEnv` uses `if (!value)` which is falsy for both `undefined` and `""`. This is actually correct behavior, but `validateRequiredVars()` on lines 28-40 does the same `if (!process.env[name])` check. However, `requireEnv` is then called again for each variable individually (lines 48-58), meaning each variable goes through two separate validation passes. This is redundant — if `validateRequiredVars` passes, `requireEnv` can never throw.

**Why:** DRY violation. `validateRequiredVars` collects all missing vars for a single helpful error message, but `requireEnv` is called immediately after for each variable individually. If somehow the first check passed (e.g., a value was set between calls — impossible in synchronous module init, but conceptually confusing), `requireEnv` would throw a single-variable error. Both paths exist for no benefit.

**Fix:** Either remove `validateRequiredVars` and keep `requireEnv` (you lose the "all missing at once" message), or remove the individual `requireEnv` calls and use `process.env[name]!` after validation:
```ts
validateRequiredVars(); // throws listing ALL missing vars

export const config = Object.freeze({
  ocrServiceUrl: process.env['OCR_SERVICE_URL']!,
  // ...etc — validation already guaranteed they exist
});
```

---

**[MAJOR-6]** `src/pipeline/processor.ts:36` — `job.ocrText ?? ''` masks OCR failure path

**Problem:** `job.ocrText` is only set when OCR succeeds (line 21). If OCR succeeds but returns `undefined` (which cannot happen given the type, but could if the type is widened), the `?? ''` silently sends an empty string to the LLM, which will return `Unbekannt` with no useful data. More practically: if a future developer adds an early-exit path without setting `ocrText`, this masking means classification will proceed on empty text with no warning.

**Why:** The function should use `job.ocrText!` (a non-null assertion is justified here because the code flow guarantees OCR succeeded if we reached step 2) or add an explicit guard:
```ts
const ocrText = job.ocrText;
if (!ocrText) {
  // OCR returned empty string — log and proceed or skip classification
  log.warn('OCR returned empty text — skipping classification');
}
```

---

**[MAJOR-7]** `src/app.ts:4` — `setupSentry()` called before Express app is created; ESM static imports still hoist `config.ts` module before `setupSentry()` runs

**Problem:** The IMPL_SUMMARY acknowledges this: "True Sentry-first initialization would require a dedicated entry file." In ESM, all `import` statements in `app.ts` are statically analyzed and their modules are evaluated before any line of the file body executes. This means `config.ts`, `logger.ts`, `middleware/*.ts`, `routes/*.ts` all execute before `setupSentry()` is ever called. If any of those imports throw (e.g., missing env var in `config.ts`), Sentry has not yet captured anything.

**Why:** This is a structural issue with the ESM module system. The comment in the file acknowledges it but does not mitigate it. For the current use case (GlitchTip error tracking), startup errors from missing config are the most critical ones to capture — and they are exactly the ones that will be missed.

**Fix:** Create `src/instrument.ts` that does nothing except `import './sentry.js'; await setupSentry();` and add `--import ./dist/instrument.js` to the node startup command in `package.json` and `Dockerfile CMD`. This is the standard Sentry ESM pattern. Alternatively, accept the limitation and document it explicitly.

---

## MINOR / Style

- `[MINOR-1]` `src/services/ocr.service.ts:25` — `new Uint8Array(form.getBuffer())` copies the entire PDF buffer into a new typed array just to satisfy `BodyInit`. For large PDFs this doubles memory usage for the duration of the fetch. Node's `fetch` accepts `Blob` directly: `new Blob([form.getBuffer()], { type: 'multipart/form-data' })` avoids the copy. Same issue in `src/services/supabase.service.ts:41`.

- `[MINOR-2]` `src/services/ollama.service.ts:174-178` — `UNKNOWN_RESULT` is a module-level constant but the `rawResponse` field is always `''`. Every call site does `{ ...UNKNOWN_RESULT }` (shallow copy) to allow overriding `rawResponse`. This pattern is fine but the spread at callsite is easy to forget. A factory function `unknownResult(raw = ''): ClassificationResult` would be safer.

- `[MINOR-3]` `src/pipeline/processor.ts:57-61` — The `safeFilename` replacement regex `[/\\?%*:|"<>]` does not include spaces or Unicode characters that are problematic in some storage backends. Supabase Storage paths with spaces can cause URL-encoding issues. Consider also replacing `\s+` with `_`.

- `[MINOR-4]` `src/config.ts:60` — `apiKey: process.env['API_KEY'] ?? ''` — empty string is the "disabled" sentinel value, but an empty string API key also passes `if (!config.apiKey)` in `validateApiKey`. This works correctly but is a hidden contract. A type of `string | null` with `process.env['API_KEY'] ?? null` would make the "no key" state explicit.

- `[MINOR-5]` `src/services/supabase.service.ts:125` — The table name `auftragseingang` is hardcoded. If this is ever renamed or the endpoint path changes, there is one string to update; at minimum extract it to a named constant at the top of the file.

- `[MINOR-6]` `docker-compose.yml:1` — `version: "3.9"` is deprecated. The `version` top-level key has been obsolete since Compose v2 (still valid but generates a warning). Remove the line entirely.

- `[MINOR-7]` `Dockerfile:4,18` — `corepack prepare pnpm@latest --activate` uses `latest` which is non-deterministic across builds. Pin to a specific pnpm version (e.g., `pnpm@9.15.4`) for reproducible builds.

- `[STYLE-1]` `src/pipeline/queue.ts:18-26` — The `if (job.status === 'done') stats.processed++ else stats.failed++` logic duplicates the "processor sets status" contract. A comment or assertion here (e.g., `// processor guarantees status is 'done' or 'failed' on normal exit`) would prevent a future developer from misunderstanding why the stats might be wrong when processor throws without setting status.

---

## Logic Verification

**OCR service — happy path:** FormData built, timeout registered, fetch called, timeout cleared in `finally`, response checked, JSON parsed, text field extracted. Correct.

**OCR service — timeout path:** `AbortController.abort()` fires, fetch throws `AbortError`, caught in the outer `catch`, timeout cleared via `finally`. Correct. Note: the `clearTimeout` in the catch block (line 29) is redundant — the `finally` on line 33 always fires. It is harmless but confusing.

**Ollama service — date parsing:** `toIsoDate` correctly handles `DD.MM.YYYY` with 1-2 digit day/month. Edge case: `toIsoDate("31.2.2024")` returns `"2024-02-31"` — an invalid date that will not be caught at this layer. Postgres will reject it, surfacing as a Supabase insert error. Low risk in practice (LLMs rarely hallucinate Feb 31) but worth noting.

**Ollama service — ISO week calculation:** The `lieferwoecheToDate` function correctly implements ISO 8601 week Monday calculation. Edge case tested mentally: week 1 of 2024 — Jan 4, 2024 is Thursday (day 4), dayOfWeek = 4, monday = Jan 4 - 3 + 0 = Jan 1, 2024. Correct (ISO week 1 of 2024 starts Jan 1).

**Queue stats — concurrency:** `queue.size` is the number of waiting jobs and `queue.pending` is the number of running jobs. Their sum correctly reflects total in-flight work.

**documents.ts POST — race condition:** If the same document is submitted twice concurrently with the same `attachmentId`, two separate jobs with different UUIDs will be created and both will process and upsert to Supabase. No deduplication at the queue level. This is a design decision but should be documented as intentional behavior.

**validateApiKey — header type:** `req.headers['x-api-key']` returns `string | string[] | undefined`. The comparison `providedKey !== config.apiKey` would fail (and correctly reject) if the client sends multiple `x-api-key` headers (value would be an array). This is actually the safe/correct behavior — the check should probably explicitly handle `string[]` by taking `[0]` if accepting multi-value headers is desired.

**index.ts — listen error:** `app.listen()` is not checked for errors. An `EADDRINUSE` error would cause an unhandled `error` event on the HTTP server, crashing the process with no log line from the application logger. Fix: `app.listen(config.port, ...).on('error', (err) => { logger.fatal(err, 'Failed to bind port'); process.exit(1); })`.

---

## What's Good

- The fail-fast config validation with a single error listing all missing variables at once is exactly correct and production-ready.
- The `extractJson` function in `ollama.service.ts` handling both fenced code blocks and bare JSON objects is a pragmatic and correct approach to LLM output parsing.
- The `lieferwoecheToDate` ISO week algorithm is non-trivial and implemented correctly.
- `clearTimeout` in `finally` blocks in both `ocr.service.ts` and `ollama.service.ts` correctly prevents timer leaks on both success and failure paths.
- The `buildInsertData` function cleanly separates data mapping from I/O, making it independently testable.
- The Dockerfile multi-stage build correctly separates builder and runtime, uses non-root `USER node`, and copies only `dist/` into the final image.
- Per-job child logger (`logger.child({ jobId, filename })`) in `processor.ts` makes log correlation straightforward.
- The `parseGermanAmount` function correctly handles the German thousands-separator (`.`) vs decimal (`,`) format.

---

## Suggested Next Steps (Ordered by Impact)

1. **[CRITICAL-1 + CRITICAL-2]** Make `setupSentry` async and await it in `index.ts` before `app.listen`. Simplify `getSentryErrorHandler` to directly call `captureException` without nested dynamic imports.
2. **[CRITICAL-3]** Attach a `.catch()` to the promise returned by `queue.add()` to prevent unhandled rejections crashing the process.
3. **[MAJOR-1]** Free `pdfBuffer` after a successful upload by setting it to `null` on the job object, and schedule job eviction from the Map via `setTimeout`.
4. **[MAJOR-4]** Add a top-level `return` in the `documents.ts` POST handler's base64 decode catch block to prevent the loop from continuing after `next(error)`.
5. **[MAJOR-7]** Add a startup listen error handler in `index.ts` to log and exit cleanly on port binding failures.
6. **[MAJOR-2]** Clarify and fix the `modelle` / `modelle_str` duplication or remove one field.
7. **[MINOR-7]** Pin pnpm version in Dockerfile to a specific semver for reproducible builds.
8. **[MINOR-6]** Remove deprecated `version:` key from `docker-compose.yml`.
9. Address the Known Gap around non-AB document deduplication before production load.
