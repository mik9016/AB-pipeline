import FormData from 'form-data';
import { config } from '../config.js';
import { logger } from '../logger.js';

const SERVICE_NAME = 'OCR';

export async function extractTextFromPdf(
  pdfBuffer: Buffer,
  originalFilename: string,
): Promise<string> {
  const form = new FormData();
  form.append('file', pdfBuffer, {
    filename: originalFilename,
    contentType: 'application/pdf',
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.ocrTimeoutMs);

  let response: Response;
  try {
    response = await fetch(config.ocrServiceUrl, {
      method: 'POST',
      headers: form.getHeaders(),
      body: new Uint8Array(form.getBuffer()),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${SERVICE_NAME} request failed: ${message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `${SERVICE_NAME} returned HTTP ${response.status}: ${body.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as Record<string, unknown>;

  // The OCR service returns { text: "..." } or { result: "..." }
  const text =
    typeof data['text'] === 'string'
      ? data['text']
      : typeof data['result'] === 'string'
        ? data['result']
        : typeof data['extracted_text'] === 'string'
          ? data['extracted_text']
          : null;

  if (text === null) {
    logger.warn({ data }, `${SERVICE_NAME} response had no recognized text field`);
    return '';
  }

  return text;
}
