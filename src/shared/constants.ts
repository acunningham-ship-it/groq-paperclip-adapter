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

/**
 * Tool-calling loop cap. Groq (like OpenAI) has no server-side loop —
 * we drive the tool_call/tool_result round-trips ourselves. 10 iterations
 * is generous for realistic agent workflows (typically 1-4 calls) while
 * still bounding runaway loops from hallucinated tool calls that keep
 * triggering each other.
 */
export const MAX_TOOL_ITERATIONS = 10;

export const DEFAULT_PROMPT_TEMPLATE =
  "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.";

/**
 * Free models known to work on Groq (April 2026).
 */
export const FREE_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "qwen/qwen3-32b",
  "openai/gpt-oss-120b",
  "moonshotai/kimi-k2-instruct",
] as const;

export const FREE_MODEL_SET = new Set<string>(FREE_MODELS);

/**
 * Rich model metadata used when Groq's /models endpoint is unreachable.
 * `free` follows the known April 2026 free tier; `contextWindow` is the
 * model's advertised max input tokens.
 */
export interface GroqModelMeta {
  id: string;
  label: string;
  free: boolean;
  contextWindow: number;
}

export const STATIC_MODEL_CATALOG: GroqModelMeta[] = [
  // Free tier
  { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B Versatile — free", free: true, contextWindow: 131072 },
  { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B Instant — free", free: true, contextWindow: 131072 },
  { id: "qwen/qwen3-32b", label: "Qwen 3 32B — free", free: true, contextWindow: 131072 },
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B — free", free: true, contextWindow: 131072 },
  { id: "moonshotai/kimi-k2-instruct", label: "Kimi K2 Instruct — free", free: true, contextWindow: 131072 },
  // Pro / higher-tier (still cheap; "free: false" just means not on the
  // always-free list — they may still be free-under-quota).
  { id: "deepseek-r1-distill-llama-70b", label: "DeepSeek R1 Distill 70B", free: false, contextWindow: 131072 },
  { id: "llama-3.2-11b-vision-preview", label: "Llama 3.2 11B Vision", free: false, contextWindow: 8192 },
  { id: "llama-3.2-90b-vision-preview", label: "Llama 3.2 90B Vision", free: false, contextWindow: 8192 },
];

export const AUTH_ENV_VAR = "GROQ_API_KEY";

/** Directory where we persist session histories. */
export const SESSION_DIR = "/tmp/paperclip-groq-sessions";
