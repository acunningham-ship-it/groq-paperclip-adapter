/**
 * Groq adapter — shared constants.
 */

export const ADAPTER_TYPE = "groq_local";
export const ADAPTER_LABEL = "Groq (OpenAI-compatible chat completions)";
export const PROVIDER_SLUG = "groq";
export const BILLER_SLUG = "groq";

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
export const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
export const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";

export const DEFAULT_MODEL = "llama-3.3-70b-versatile";
export const DEFAULT_TIMEOUT_SEC = 300;
export const DEFAULT_GRACE_SEC = 10;

export const DEFAULT_PROMPT_TEMPLATE =
  "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.";

/**
 * Free models known to work on Groq.
 */
export const FREE_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "qwen/qwen3-32b",
  "openai/gpt-oss-120b",
  "moonshotai/kimi-k2-instruct",
] as const;

export const AUTH_ENV_VAR = "GROQ_API_KEY";

/** Directory where we persist session histories. */
export const SESSION_DIR = "/tmp/paperclip-groq-sessions";
