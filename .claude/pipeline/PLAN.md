# Implementation Plan -- Fix n8n Workflow "AB Eingang Reprocess Mar 12-27"

## Date: 2026-03-29
## Workflow ID: apxJ6p1p540ssLfa

## Analysis of Execution 2134

All 434 items flowed through the pipeline but produced empty data because:

1. **OCR node (HTTP Request2) strips metadata**: Sends PDF binary to OCR, gets back `{text: ...}` only. The JSON fields `parentMessageId`, `attachmentId`, `originalFilename` from Store Attachment ID are lost. Binary PDF data is also lost.

2. **LLM Request 100% timeout**: All 434 requests to `apiollama.bosavertrieb.de` timed out (300s each). With 434 concurrent requests this is expected -- Ollama cannot handle that load.

3. **"Ist AB?" filter passes everything**: The boolean IF condition uses `operation: "true"` on an expression value. n8n converts `false` boolean to the string `"false"` in the expression, which is truthy. All 434 items (including non-ABs and errors) pass through.

4. **Upload PDF runs in `runOnceForAllItems` mode**: Only processes 1 item total instead of each item individually. Outputs 1 item.

5. **HTTP Request1 (Supabase) processes only 1 item**: Because Upload PDF only outputs 1 item.

6. **Binary data not available at Upload PDF**: Even if Upload PDF ran per-item, the binary PDF was lost at OCR step.

## Fixes

### Fix 1: Add "Merge Back Metadata" Code node after HTTP Request2

Insert a Code node between HTTP Request2 and LLM Request that:
- Re-attaches `parentMessageId`, `attachmentId`, `originalFilename` from the input item at matching index
- Preserves OCR `text` output
- Mode: `runOnceForEachItem`

**Actually, better approach**: Since HTTP Request2 is an HTTP Request node, we cannot make it preserve input JSON. Instead, we need to use a **Merge node** or **Code node** approach. The simplest fix: change the approach to use a Code node that:
- After OCR, merges the OCR text result back with the stored metadata from the paired input

However, the cleanest approach for n8n is: **Add a Code node after HTTP Request2** that references back to `Store Attachment ID` or `PDF herunterladen4` via `$('Store Attachment ID').item.json` to pull metadata forward.

### Fix 2: Fix "Ist AB?" boolean condition

Change the IF condition to use `equals` operator comparing to string `"true"` or use a Code expression that properly evaluates the boolean. Best approach: change leftValue to `={{ $json.is_auftragsbestaetigung === true }}` with a `boolean / true` operator, or change to `equals / true`.

### Fix 3: Upload PDF -- change to runOnceForEachItem mode

The Upload PDF Code node needs `mode: "runOnceForEachItem"`.

### Fix 4: Re-download PDF before upload

Since binary is lost at OCR, the Upload PDF node needs to re-download the PDF using `parentMessageId` and `attachmentId`. Modify the Upload PDF code to:
1. Check if binary exists
2. If not, use `parentMessageId` and `attachmentId` to download from Microsoft Graph API
3. Upload to Supabase

**Alternative simpler approach**: Insert a "Re-download PDF" node (Microsoft Outlook - download attachment) between Parse Ollama and Upload PDF, using `$json.parentMessageId` and `$json.attachmentId`.

### Fix 5: LLM timeout mitigation

The Ollama server cannot handle 434 concurrent requests. Options:
- Not directly fixable in workflow (infra issue)
- Could add batch processing but that's a major refactor
- For now, ensure error handling is robust so failed LLM items are filtered out

## Implementation Order

1. Insert "Restore Metadata" Code node after HTTP Request2 (before LLM Request)
2. Fix "Ist AB?" boolean condition
3. Change Upload PDF to `runOnceForEachItem`
4. Insert "Re-download PDF" node before Upload PDF
5. Wire all connections correctly

## Node Changes Summary

| Node | Change | Type |
|------|--------|------|
| NEW: Restore Metadata | Code node after HTTP Request2 | New node |
| Ist AB? | Fix boolean condition | Patch |
| Upload PDF | Set mode to runOnceForEachItem | Patch |
| NEW: Re-download PDF | Outlook download node before Upload PDF | New node |
| Connections | Rewire: OCR -> Restore Metadata -> LLM, Parse Ollama -> Re-download PDF -> Upload PDF | Rewire |
