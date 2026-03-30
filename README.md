# Bosa Document Processor

Express TypeScript server that processes PDF documents from email attachments. Receives documents from n8n (which handles Outlook email fetching), runs them through OCR, classifies them using an LLM, and stores the results in Supabase.

## Why

The previous n8n-only workflow was unreliable at scale:
- OCR node stripped metadata between pipeline steps
- 434 concurrent Ollama requests all timed out
- Binary PDF data got lost mid-pipeline
- No structured logging to diagnose failures

This server replaces the heavy processing with proper code while keeping n8n for what it does well -- Outlook credential management and email fetching.

## Architecture

```
n8n (Outlook email fetch + PDF download)
  |
  |  POST /api/documents  (batch of PDFs as base64)
  v
Bosa Document Processor (this server)
  |
  |-- Sequential queue (no concurrent overload)
  |
  |-- Step 1: OCR         ->  ocr.unicatsolutions.de
  |-- Step 2: Classify    ->  Ollama LLM (gpt-oss:20b)
  |-- Step 3: Upload PDF  ->  Supabase Storage
  |-- Step 4: Insert row  ->  Supabase DB (auftragseingang table)
```

### Document Classification

The LLM classifies each document into one of:

| Category | German | Description |
|----------|--------|-------------|
| Auftragsbestaetigung (AB) | Auftragsbestaetigung | Order confirmation |
| Rechnung | Rechnung | Invoice |
| Angebot | Angebot | Quote / Offer |
| Unbekannt | Unbekannt | Unknown (fallback) |

For AB documents, the LLM also extracts structured fields: order number, supplier, customer, commission, dates, delivery week, net amount, and model numbers.

## Prerequisites

- **Docker** and **Docker Compose** (recommended), or
- **Node.js 20+** and **pnpm** for local development
- Access to the external services:
  - OCR endpoint (e.g. `ocr.unicatsolutions.de`)
  - Ollama-compatible LLM endpoint
  - Supabase instance with storage bucket and `auftragseingang` table

## Setup

### 1. Clone and configure

```bash
git clone <repo-url>
cd n8nBosa
cp .env.example .env
```

Edit `.env` and fill in all required values:

```env
# REQUIRED -- shared secret for authenticating requests from n8n
API_KEY=your-secret-api-key

# OCR service
OCR_SERVICE_URL=https://ocr.unicatsolutions.de/extract-text
OCR_TIMEOUT_MS=60000

# Ollama / LLM
OLLAMA_URL=https://ollama.unicatsolutions.de/api/chat/completions
OLLAMA_MODEL=gpt-oss:20b
OLLAMA_TOKEN=your-ollama-bearer-token
OLLAMA_TIMEOUT_MS=120000

# Supabase
SUPABASE_URL=https://supabase.bosavertrieb.de
SUPABASE_KEY=your-supabase-service-role-key
SUPABASE_BUCKET=Bosa-Vertrieb

# Optional
PORT=3000
LOG_LEVEL=info
GLITCHTIP_DSN=               # GlitchTip/Sentry DSN for error tracking
QUEUE_CONCURRENCY=1          # how many documents to process in parallel
```

### 2. Run with Docker (recommended)

```bash
docker compose up --build -d
```

Check logs:

```bash
docker compose logs -f
```

Stop:

```bash
docker compose down
```

### 3. Run locally (development)

```bash
pnpm install
pnpm dev
```

This starts the server with hot-reload via `tsx watch`.

Build for production:

```bash
pnpm build
pnpm start
```

## API Endpoints

### `POST /api/documents`

Submit documents for processing. Returns immediately with job IDs (202 Accepted).

**Headers:**
- `Content-Type: application/json`
- `x-api-key: <your API_KEY>`

**Request body:**

```json
{
  "documents": [
    {
      "parentMessageId": "AAMkAGI2...",
      "attachmentId": "AAMkAGI2...attachment",
      "originalFilename": "AB_12345.pdf",
      "pdfBase64": "JVBERi0xLjQK...",
      "emailFrom": "supplier@example.com",
      "emailTo": "inbox@bosavertrieb.de"
    }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `parentMessageId` | Yes | Outlook message ID |
| `attachmentId` | Yes | Outlook attachment ID |
| `originalFilename` | Yes | PDF filename |
| `pdfBase64` | Yes | PDF file as base64 string |
| `emailFrom` | No | Sender email address |
| `emailTo` | No | Recipient email address |

**Response (202):**

```json
{
  "accepted": 1,
  "jobs": [
    {
      "jobId": "550e8400-e29b-41d4-a716-446655440000",
      "filename": "AB_12345.pdf",
      "status": "queued"
    }
  ]
}
```

**Limits:**
- Max 20 documents per request
- Max 500 documents in queue (returns 503 when full)
- Max 50 MB request body size

---

### `GET /api/documents/:jobId/status`

Check processing status of a submitted document.

**Headers:**
- `x-api-key: <your API_KEY>`

**Response:**

```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "filename": "AB_12345.pdf",
  "status": "done",
  "classification": {
    "category": "Auftragsbestaetigung",
    "confidence": 0.95,
    "ab_nummer": "279169",
    "lieferant": "Firma XY GmbH",
    "kunde": "Bosa Vertrieb"
  },
  "receivedAt": "2026-03-30T10:00:00.000Z",
  "completedAt": "2026-03-30T10:00:45.000Z"
}
```

Job statuses: `queued` -> `ocr` -> `classifying` -> `storing` -> `done` or `failed`

---

### `GET /health`

Health check (no authentication required).

**Response:**

```json
{
  "status": "ok",
  "queueDepth": 3,
  "processed": 142,
  "failed": 2,
  "uptime": 3600
}
```

## n8n Workflow Setup

Simplify your n8n workflow to:

```
Schedule Trigger -> Get Messages -> Get Attachments -> Filter PDFs
  -> Download PDF -> Build Payload (Code node) -> SplitInBatches
  -> HTTP Request POST to this server
```

**Build Payload** Code node example:

```javascript
const binary = $input.item.binary;
const binaryProp = Object.values(binary)[0];

return {
  json: {
    parentMessageId: $('Get Messages').item.json.id,
    attachmentId: $json.id,
    originalFilename: $json.name,
    pdfBase64: binaryProp.data,
    emailFrom: $('Get Messages').item.json.from?.emailAddress?.address || '',
    emailTo: ''
  }
};
```

**HTTP Request** node configuration:
- Method: `POST`
- URL: `http://your-server:3000/api/documents`
- Headers: `x-api-key: <your API_KEY>`
- Body: `{{ JSON.stringify({ documents: $input.all().map(i => i.json) }) }}`

Use **SplitInBatches** with batch size 5-10 before the HTTP Request to avoid sending too many documents at once.

## Supabase Schema

The server expects an `auftragseingang` table with these columns:

| Column | Type | Description |
|--------|------|-------------|
| `ab_nummer` | text | Order confirmation number (upsert key) |
| `ab_nummer_label` | text | Full label |
| `lieferant` | text | Supplier name |
| `kunde` | text | Customer name |
| `kommission` | text | Commission/project reference |
| `ab_datum` | text | Confirmation date (DD.MM.YYYY) |
| `ab_datum_iso` | date | Confirmation date (ISO) |
| `auftrag_vom` | date | Order date (ISO) |
| `lieferwoche` | text | Delivery week (e.g. KW15/2026) |
| `liefer_datum` | date | Delivery date (computed from week) |
| `modelle` | text | Model numbers |
| `modelle_str` | text | Model numbers (string) |
| `netto` | numeric | Net amount |
| `netto_text` | text | Net amount (German format) |
| `empfangen_am` | timestamptz | When the server received it |
| `datei_name` | text | Storage path |
| `datei_original` | text | Original filename |
| `jahr` | integer | Year |
| `onedrive_pfad` | text | Storage path |
| `pdf_url` | text | Public URL of uploaded PDF |
| `email_from` | text | Sender email |
| `email_to` | text | Recipient email |
| `kategorie` | text | Classification result |

A Supabase Storage bucket named `Bosa-Vertrieb` is also required.

## Logging

The server uses [Pino](https://github.com/pinojs/pino) for structured JSON logging.

- **Development**: Pretty-printed, colorized output
- **Production** (Docker): JSON lines, suitable for log aggregation

Every processing step is logged with `jobId` and `filename` for easy tracing:

```json
{"level":"info","jobId":"550e...","filename":"AB_12345.pdf","durationMs":4200,"msg":"Classification complete"}
```

### GlitchTip / Sentry

Set `GLITCHTIP_DSN` to enable error tracking via [GlitchTip](https://glitchtip.com/) (Sentry-compatible). Captures unhandled exceptions and processing failures automatically.

## Project Structure

```
src/
  index.ts                 # Entry point, starts server
  app.ts                   # Express app, middleware, routes
  config.ts                # Environment variable validation
  logger.ts                # Pino logger setup
  sentry.ts                # GlitchTip/Sentry integration
  routes/
    documents.ts           # POST /api/documents, GET status
    health.ts              # GET /health
  services/
    ocr.service.ts         # OCR HTTP call
    ollama.service.ts      # LLM classification + response parsing
    supabase.service.ts    # PDF upload + DB insert
  pipeline/
    processor.ts           # Orchestrates OCR -> classify -> store
    queue.ts               # Sequential processing queue (p-queue)
  types/
    document.ts            # TypeScript type definitions
  middleware/
    error-handler.ts       # Global error handler
    request-logger.ts      # HTTP request logging
```

## Security

- API key authentication required on all document endpoints
- Timing-safe key comparison (`crypto.timingSafeEqual`)
- Request size limits (50 MB body, 20 docs/request, 500 queue depth)
- Path traversal prevention on storage paths
- Non-root Docker user
- Secrets via environment variables only (never hardcoded)
- Production mode hides internal error details
