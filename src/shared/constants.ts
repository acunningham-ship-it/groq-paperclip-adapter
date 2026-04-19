/**
 * Groq adapter — shared constants.
 */

export const ADAPTER_TYPE = "groq_local";
export const ADAPTER_LABEL = "groq_local";
export const PROVIDER_SLUG = "groq";
export const BILLER_SLUG = "groq";

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

export const DEFAULT_MODEL = "llama-3.3-70b-versatile";
export const DEFAULT_TIMEOUT_SEC = 300;
export const DEFAULT_GRACE_SEC = 10;

export const DEFAULT_PROMPT_TEMPLATE = `{{instructions}}

{{paperclipContext}}

{{taskBody}}`;

/**
 * Free models known to work on Groq.
 */
export const FREE_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "qwen/qwen3-32b",
  "openai/gpt-oss-120b",
  "moonshotai/kimi-k2-instruct"
] as const;

export const AUTH_ENV_VAR = "GROQ_API_KEY";
