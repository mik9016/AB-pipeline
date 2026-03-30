import { config } from '../config.js';
import { logger } from '../logger.js';
import type { ClassificationResult, DocumentCategory } from '../types/document.js';

const SERVICE_NAME = 'Ollama';

const CLASSIFICATION_PROMPT = `Du bist ein Dokumenten-Klassifikations-Assistent. Analysiere den folgenden Text und klassifiziere das Dokument.

Mögliche Kategorien:
- "Auftragsbestätigung": Eine Bestätigung einer Bestellung/eines Auftrags vom Lieferanten
- "Rechnung": Eine Rechnung über erbrachte Leistungen oder gelieferte Waren
- "Angebot": Ein Angebot/eine Offerte für Waren oder Dienstleistungen
- "Unbekannt": Keiner der oben genannten Kategorien

Antworte AUSSCHLIESSLICH mit einem JSON-Objekt in folgendem Format:

Für Auftragsbestätigung:
{
  "kategorie": "Auftragsbestätigung",
  "konfidenz": 0.95,
  "ab_nummer": "AB-12345",
  "ab_nummer_label": "Auftrags-Nr.",
  "lieferant": "Firma XY GmbH",
  "kunde": "Kunde ABC",
  "kommission": "K-2024-001",
  "ab_datum": "15.03.2024",
  "auftrag_vom": "10.03.2024",
  "lieferwoche": "KW15/2024",
  "netto_text": "6.737,00",
  "modelle": "Modell A, Modell B"
}

Für Rechnung:
{
  "kategorie": "Rechnung",
  "konfidenz": 0.92,
  "rechnungs_nummer": "RE-2024-001",
  "lieferant": "Firma XY GmbH",
  "kunde": "Kunde ABC",
  "betrag": "1.250,00"
}

Für Angebot:
{
  "kategorie": "Angebot",
  "konfidenz": 0.88,
  "angebots_nummer": "ANG-2024-001",
  "lieferant": "Firma XY GmbH",
  "kunde": "Kunde ABC",
  "betrag": "3.500,00"
}

Für unbekannte Dokumente:
{
  "kategorie": "Unbekannt",
  "konfidenz": 0.5
}

Fehlende Felder weglassen (nicht als null angeben).

Dokumenttext:
`;

interface OllamaMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface OllamaResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

/** Convert DD.MM.YYYY → YYYY-MM-DD. Returns null when input is invalid. */
function toIsoDate(germanDate: string | undefined): string | null {
  if (!germanDate) return null;
  const match = germanDate.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`;
}

/**
 * Convert Lieferwoche string (e.g. "KW15/2024", "KW 15 / 2024") to the
 * Monday date of that ISO week in YYYY-MM-DD format.
 */
function lieferwoecheToDate(lieferwoche: string | undefined): string | null {
  if (!lieferwoche) return null;

  const match = lieferwoche.match(/KW\s*(\d{1,2})\s*[/\-]\s*(\d{4})/i);
  if (!match) return null;

  const week = parseInt(match[1]!, 10);
  const year = parseInt(match[2]!, 10);

  if (isNaN(week) || isNaN(year) || week < 1 || week > 53) return null;

  // ISO week 1 is the week containing the first Thursday.
  // Monday of week 1: Jan 4 minus its weekday offset.
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() === 0 ? 7 : jan4.getDay(); // Mon=1..Sun=7
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - (dayOfWeek - 1) + (week - 1) * 7);

  const y = monday.getFullYear();
  const m = String(monday.getMonth() + 1).padStart(2, '0');
  const d = String(monday.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Parse German decimal format "6.737,00" → 6737.00 */
function parseGermanAmount(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const cleaned = text.replace(/\./g, '').replace(',', '.');
  const value = parseFloat(cleaned);
  return isNaN(value) ? undefined : value;
}

/** Strip markdown code fences from LLM output and extract the JSON object. */
function extractJson(raw: string): string {
  // Remove ```json ... ``` or ``` ... ``` wrappers
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1]!.trim();

  // Try to extract the first { ... } block
  const braceStart = raw.indexOf('{');
  const braceEnd = raw.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    return raw.slice(braceStart, braceEnd + 1);
  }

  return raw.trim();
}

async function callOllama(text: string, signal: AbortSignal): Promise<string> {
  const messages: OllamaMessage[] = [
    {
      role: 'user',
      content: `${CLASSIFICATION_PROMPT}${text}`,
    },
  ];

  const response = await fetch(config.ollamaUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.ollamaToken}`,
    },
    body: JSON.stringify({
      model: config.ollamaModel,
      messages,
      temperature: 0,
      stream: false,
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${SERVICE_NAME} returned HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as OllamaResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`${SERVICE_NAME} returned empty content`);
  }
  return content;
}

const UNKNOWN_RESULT: ClassificationResult = {
  category: 'Unbekannt',
  confidence: 0,
  rawResponse: '',
};

export async function classifyDocument(
  ocrText: string,
  filename: string,
): Promise<ClassificationResult> {
  const attemptClassify = async (): Promise<string> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.ollamaTimeoutMs);
    try {
      return await callOllama(ocrText, controller.signal);
    } finally {
      clearTimeout(timeoutId);
    }
  };

  let rawResponse: string;
  try {
    rawResponse = await attemptClassify();
  } catch (firstErr) {
    logger.warn({ err: firstErr, filename }, `${SERVICE_NAME} first attempt failed — retrying`);
    try {
      rawResponse = await attemptClassify();
    } catch (secondErr) {
      logger.error({ err: secondErr, filename }, `${SERVICE_NAME} both attempts failed`);
      return { ...UNKNOWN_RESULT };
    }
  }

  let parsed: Record<string, unknown>;
  try {
    const jsonStr = extractJson(rawResponse);
    parsed = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch (parseErr) {
    logger.error(
      { err: parseErr, rawResponse: rawResponse.slice(0, 500), filename },
      `${SERVICE_NAME} JSON parse failed`,
    );
    return { ...UNKNOWN_RESULT, rawResponse };
  }

  const rawCategory = String(parsed['kategorie'] ?? '');
  const validCategories: DocumentCategory[] = [
    'Auftragsbestätigung',
    'Rechnung',
    'Angebot',
    'Unbekannt',
  ];
  const category: DocumentCategory = validCategories.includes(rawCategory as DocumentCategory)
    ? (rawCategory as DocumentCategory)
    : 'Unbekannt';

  const confidence =
    typeof parsed['konfidenz'] === 'number' ? parsed['konfidenz'] : 0;

  const base: ClassificationResult = {
    category,
    confidence,
    rawResponse,
  };

  if (category === 'Auftragsbestätigung') {
    const lieferwoche =
      typeof parsed['lieferwoche'] === 'string' ? parsed['lieferwoche'] : undefined;
    const abDatum =
      typeof parsed['ab_datum'] === 'string' ? parsed['ab_datum'] : undefined;

    return {
      ...base,
      ab_nummer: typeof parsed['ab_nummer'] === 'string' ? parsed['ab_nummer'] : undefined,
      ab_nummer_label:
        typeof parsed['ab_nummer_label'] === 'string' ? parsed['ab_nummer_label'] : undefined,
      lieferant: typeof parsed['lieferant'] === 'string' ? parsed['lieferant'] : undefined,
      kunde: typeof parsed['kunde'] === 'string' ? parsed['kunde'] : undefined,
      kommission: typeof parsed['kommission'] === 'string' ? parsed['kommission'] : undefined,
      ab_datum: abDatum,
      ab_datum_iso: toIsoDate(abDatum),
      auftrag_vom:
        typeof parsed['auftrag_vom'] === 'string'
          ? toIsoDate(parsed['auftrag_vom'])
          : null,
      lieferwoche,
      liefer_datum: lieferwoecheToDate(lieferwoche),
      modelle: typeof parsed['modelle'] === 'string' ? parsed['modelle'] : undefined,
      modelle_str: typeof parsed['modelle'] === 'string' ? parsed['modelle'] : undefined,
      netto_text: typeof parsed['netto_text'] === 'string' ? parsed['netto_text'] : undefined,
      netto: parseGermanAmount(
        typeof parsed['netto_text'] === 'string' ? parsed['netto_text'] : undefined,
      ),
    };
  }

  return base;
}
