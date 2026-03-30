export type DocumentCategory = 'Auftragsbestätigung' | 'Rechnung' | 'Angebot' | 'Unbekannt';

export interface DocumentRequest {
  parentMessageId: string;
  attachmentId: string;
  originalFilename: string;
  pdfBase64: string;
  emailFrom?: string;
  emailTo?: string;
}

export interface ClassificationResult {
  category: DocumentCategory;
  confidence: number;
  rawResponse: string;
  // AB-specific fields
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
}

export type JobStatus = 'queued' | 'ocr' | 'classifying' | 'storing' | 'done' | 'failed';

export interface DocumentJob {
  id: string;
  parentMessageId: string;
  attachmentId: string;
  originalFilename: string;
  pdfBuffer: Buffer;
  emailFrom: string;
  emailTo: string;
  ocrText?: string;
  classification?: ClassificationResult;
  status: JobStatus;
  error?: string;
  receivedAt: Date;
  completedAt?: Date;
}

export interface DocumentResponse {
  jobId: string;
  filename: string;
  status: string;
}
