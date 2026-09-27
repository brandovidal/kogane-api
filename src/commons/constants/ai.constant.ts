export enum AiProvider {
  GEMINI = 'gemini',
  GROQ = 'groq',
  LOCAL = 'local', // OCR of bank screenshots (P21): logged like the AI to count what it saved
}

export enum AiOperation {
  EXTRACT = 'extract',
  TRANSCRIBE = 'transcribe',
  RECOGNIZE = 'recognize', // local OCR + templates (D63)
  STATEMENT = 'statement', // the text of a bank statement (P14, D95)
  QUESTION = 'question', // /pregunta: one predefined query picked for a question (P18, D131)
}

export const OCR_MODEL = 'tesseract'

export enum AiInputPartType {
  TEXT = 'text',
  IMAGE = 'image',
}

export enum AiErrorCode {
  PROVIDER_ERROR = 'PROVIDER_ERROR',
  INVALID_OUTPUT = 'INVALID_OUTPUT',
}

// Model names change often: override them with env vars (see .env.example)
export const DEFAULT_GEMINI_MODEL_LITE = 'gemini-3.5-flash-lite'
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash'
export const DEFAULT_GROQ_MODEL = 'qwen/qwen3.8-27b'
// Voice notes (P5): transcribed with Whisper on Groq, then read like a text message
export const DEFAULT_GROQ_TRANSCRIBE_MODEL = 'whisper-large-v3-turbo'

// Free tier requests per day (September 2026)
export const DEFAULT_GEMINI_LITE_DAILY_LIMIT = 500
export const DEFAULT_GEMINI_DAILY_LIMIT = 20
export const DEFAULT_GROQ_DAILY_LIMIT = 1000
export const DEFAULT_GROQ_TRANSCRIBE_DAILY_LIMIT = 2000

// Stop using a model once this share of its daily quota is spent
export const AI_QUOTA_USAGE_THRESHOLD = 0.9

// Timezone where each provider resets its daily quota
export const AI_QUOTA_TIME_ZONES: Record<AiProvider, string> = {
  [AiProvider.GEMINI]: 'America/Los_Angeles',
  [AiProvider.GROQ]: 'UTC',
  [AiProvider.LOCAL]: 'America/Lima', // no quota: only for /uso
}

export const DEFAULT_AI_TIMEOUT_MS = 20_000

// Attempts per model when the output does not match the schema
export const AI_MAX_STRUCTURE_ATTEMPTS = 2

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1'

// Groq free tier allows 1,000 output tokens per minute on Qwen: without a cap it reserves more and answers 429
export const GROQ_MAX_OUTPUT_TOKENS = 900

// Whisper hint: the user speaks Spanish (Peru); better accuracy and no language detection
export const TRANSCRIPTION_LANGUAGE = 'es'
