# AB Eingang – Server Workflow Design

**Date:** 2026-04-01
**Status:** Approved

## Overview

An n8n workflow that reads incoming emails from Microsoft Outlook, extracts PDF attachments, and hands them off to the AB-Pipeline server (`https://ab.bosavertrieb.de`) for processing. The server handles OCR, LLM classification, and Supabase storage — n8n only orchestrates email intake and monitors job completion.

Replaces the direct OCR + LLM + Supabase calls in "AB Eingang latest 2".

## Trigger

**Phase 1 (now):** Manual Trigger — run on demand via the n8n UI execute button.

**Phase 2 (later):** Schedule Trigger — daily at 06:00, filtering emails received the previous day.

The only change between phases is swapping the trigger node; everything downstream stays identical.

## Workflow Nodes

```
1. Manual Trigger
2. Outlook: Get Messages         — unread, past 24h, with attachments
3. Split In Batches              — loop over each email
4. Outlook: Get Attachments      — for current email (messageId)
5. Filter: PDFs only             — by contentType or filename (.pdf)
6. Outlook: Download PDF         — binary content of attachment
7. Code: Base64 encode           — convert binary to base64 string
8. HTTP POST /api/documents      — submit to server
9. Wait 10s                      — pause before first status check
10. HTTP GET /api/documents/:id/status  — poll job status
11. IF: status check
    - "done"   → end (success)
    - "failed" → stop with error
    - else     → back to node 9 (Wait)
```

## Server Integration

**Endpoint:** `POST https://ab.bosavertrieb.de/api/documents`

**Headers:**
```
X-API-Key: <API_KEY>
Content-Type: application/json
```

**Request body:**
```json
{
  "documents": [
    {
      "parentMessageId": "{{ email.id }}",
      "attachmentId": "{{ attachment.id }}",
      "originalFilename": "{{ attachment.name }}",
      "pdfBase64": "{{ base64 string }}",
      "emailFrom": "{{ email.from }}",
      "emailTo": "{{ email.to }}"
    }
  ]
}
```

**Response (202):** returns `jobs[0].jobId` — used for status polling.

**Polling endpoint:** `GET https://ab.bosavertrieb.de/api/documents/{jobId}/status`

**Terminal states:** `done` (success, stored in Supabase) or `failed` (error in server logs / GlitchTip).

## Poll Loop Timing

- Wait 10s between each poll attempt
- Worst case processing time: ~3 minutes (60s OCR + 120s LLM)
- Max ~18 poll attempts before a 3-minute job completes
- Job TTL on server: 15 minutes

## Outlook Filter

- Folder: Inbox (same as existing "AB Eingang latest 2")
- Filter: unread messages received in the last 24 hours
- Only emails with at least one PDF attachment are processed

## What the Server Does (n8n does NOT need to handle)

- OCR text extraction
- LLM classification (Auftragsbestätigung / Rechnung / Angebot / Unbekannt)
- Supabase storage (upsert on `ab_nummer` for deduplication)
- Retries on OCR/LLM/storage failures
- PDF upload to Supabase Storage bucket

## What n8n Does

- Reads emails from Outlook
- Extracts and filters PDF attachments
- Encodes PDF as base64
- Submits to server and polls for completion
- Surfaces failures as n8n execution errors

## Out of Scope

- Zoho CRM integration (not needed for phase 1)
- Email folder moves after processing (not needed)
- Notifications on completion (not needed)
- Handling non-PDF attachments

## Phase 2 Upgrade (Cron)

Replace node 1 (Manual Trigger) with:
- **Type:** Schedule Trigger
- **Time:** 06:00 daily
- **Outlook filter adjustment:** emails from yesterday (receivedDateTime >= yesterday 00:00, < today 00:00)

No other nodes change.
