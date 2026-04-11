import { config } from '../config.js';
import { logger } from '../logger.js';
import type { ClassificationResult } from '../types/document.js';

const RETRY_DELAY_MS = 2000;

function supabaseHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: config.supabaseKey,
    Authorization: `Bearer ${config.supabaseKey}`,
    ...extra,
  };
}

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (firstErr) {
    logger.warn({ err: firstErr, label }, 'Supabase request failed — retrying in 2s');
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return await fn();
  }
}

export async function uploadPdf(
  pdfBuffer: Buffer,
  storagePath: string,
): Promise<string> {
  const url = `${config.supabaseUrl}/storage/v1/object/${config.supabaseBucket}/${storagePath}`;

  await withRetry(`uploadPdf(${storagePath})`, async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: supabaseHeaders({
        'Content-Type': 'application/pdf',
        'x-upsert': 'true',
      }),
      body: new Uint8Array(pdfBuffer),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Supabase Storage upload failed HTTP ${response.status}: ${body.slice(0, 200)}`,
      );
    }
  });

  // Return the public URL for the object
  return `${config.supabaseUrl}/storage/v1/object/public/${config.supabaseBucket}/${storagePath}`;
}

export interface InsertDocumentData {
  ab_nummer?: string;
  ab_nummer_label?: string;
  lieferant?: string;
  kunde?: string;
  kommission?: string;
  ab_datum?: string;
  ab_datum_iso?: string | null;
  auftrag_vom?: string | null;
  lieferwoche?: string;
  liefer_datum?: string | null;
  modelle?: string;
  modelle_str?: string;
  netto?: number;
  netto_text?: string;
  empfangen_am: string;
  datei_name: string;
  datei_original: string;
  jahr: number;
  onedrive_pfad: string;
  pdf_url: string;
  email_from: string;
  email_to: string;
  kategorie: string;
}

export function buildInsertData(params: {
  classification: ClassificationResult;
  originalFilename: string;
  storagePath: string;
  pdfUrl: string;
  emailFrom: string;
  emailTo: string;
  receivedAt: Date;
}): InsertDocumentData {
  const { classification, originalFilename, storagePath, pdfUrl, emailFrom, emailTo, receivedAt } =
    params;

  const jahr = receivedAt.getFullYear();
  const empfangen_am = receivedAt.toISOString();

  return {
    ab_nummer: classification.ab_nummer,
    ab_nummer_label: classification.ab_nummer_label,
    lieferant: classification.lieferant,
    kunde: classification.kunde,
    kommission: classification.kommission,
    ab_datum: classification.ab_datum,
    ab_datum_iso: classification.ab_datum_iso,
    auftrag_vom: classification.auftrag_vom,
    lieferwoche: classification.lieferwoche,
    liefer_datum: classification.liefer_datum,
    modelle: classification.modelle,
    modelle_str: classification.modelle_str,
    netto: classification.netto,
    netto_text: classification.netto_text,
    empfangen_am,
    datei_name: storagePath,
    datei_original: originalFilename,
    jahr,
    onedrive_pfad: storagePath,
    pdf_url: pdfUrl,
    email_from: emailFrom,
    email_to: emailTo,
    kategorie: classification.category,
  };
}

export async function insertDocument(data: InsertDocumentData): Promise<void> {
  // ABs: upsert on ab_nummer (full unique constraint exists)
  // Non-ABs: plain insert, partial index on datei_original catches duplicates as 409
  const isAb = !!data.ab_nummer;
  const url = isAb
    ? `${config.supabaseUrl}/rest/v1/auftragseingang?on_conflict=ab_nummer`
    : `${config.supabaseUrl}/rest/v1/auftragseingang`;

  await withRetry(`insertDocument(${data.ab_nummer ?? data.datei_original})`, async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: supabaseHeaders({
        'Content-Type': 'application/json',
        ...(isAb ? { Prefer: 'resolution=ignore-duplicates' } : {}),
      }),
      body: JSON.stringify(data),
    });

    if (response.status === 409) {
      // Duplicate — already stored, treat as success
      return;
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Supabase REST insert failed HTTP ${response.status}: ${body.slice(0, 200)}`,
      );
    }
  });
}
