import { config as loadDotenv } from 'dotenv';

loadDotenv();

const REQUIRED_VARS = [
  'API_KEY',
  'OCR_SERVICE_URL',
  'OLLAMA_URL',
  'OLLAMA_MODEL',
  'OLLAMA_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'SUPABASE_BUCKET',
] as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

function validateRequiredVars(): void {
  const missing: string[] = [];
  for (const name of REQUIRED_VARS) {
    if (!process.env[name]) {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'Please copy .env.example to .env and fill in the values.',
    );
  }
}

validateRequiredVars();

export const config = Object.freeze({
  port: parseInt(optionalEnv('PORT', '3000'), 10),
  nodeEnv: optionalEnv('NODE_ENV', 'development'),

  ocrServiceUrl: requireEnv('OCR_SERVICE_URL'),
  ocrTimeoutMs: parseInt(optionalEnv('OCR_TIMEOUT_MS', '60000'), 10),

  ollamaUrl: requireEnv('OLLAMA_URL'),
  ollamaModel: requireEnv('OLLAMA_MODEL'),
  ollamaToken: requireEnv('OLLAMA_TOKEN'),
  ollamaTimeoutMs: parseInt(optionalEnv('OLLAMA_TIMEOUT_MS', '120000'), 10),

  supabaseUrl: requireEnv('SUPABASE_URL'),
  supabaseKey: requireEnv('SUPABASE_KEY'),
  supabaseBucket: requireEnv('SUPABASE_BUCKET'),

  apiKey: requireEnv('API_KEY'),

  logLevel: optionalEnv('LOG_LEVEL', 'info'),

  glitchtipDsn: process.env['GLITCHTIP_DSN'] ?? '',

  queueConcurrency: parseInt(optionalEnv('QUEUE_CONCURRENCY', '1'), 10),
});

export type Config = typeof config;
