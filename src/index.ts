/**
 * Groq Paperclip adapter — main entry.
 *
 * Direct HTTP adapter against Groq's OpenAI-compatible chat completions
 * endpoint. Free-tier focused: llama-3.3-70b-versatile, llama-3.1-8b-instant,
 * qwen/qwen3-32b, openai/gpt-oss-120b, moonshotai/kimi-k2-instruct.
 *
 * v0.7:
 *   - streaming + session resume (v0.5)
 *   - OpenAI-style tool calling with client-driven loop (capped at
 *     MAX_TOOL_ITERATIONS)
 *   - full /v1/models catalog at boot, free first, with rich metadata
 *     ({ id, label, free, contextWindow }) and hardcoded fallback.
 *
 * @packageDocumentation
 */

import type {
  AdapterConfigSchema,
  AdapterModel,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import {
  ADAPTER_LABEL,
  ADAPTER_TYPE,
  AUTH_ENV_VAR,
  DEFAULT_MODEL,
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_TIMEOUT_SEC,
  FREE_MODEL_SET,
  GROQ_MODELS_URL,
  STATIC_MODEL_CATALOG,
  type GroqModelMeta,
} from "./shared/constants.js";
import {
  detectModel,
  execute,
  sessionCodec,
  testEnvironment,
} from "./server/index.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;

/**
 * Extended model record — a superset of AdapterModel carrying the extra
 * metadata (`free`, `contextWindow`) requested by v0.7.
 */
export interface ExtendedGroqModel extends AdapterModel {
  free: boolean;
  contextWindow: number;
}

function labelFor(id: string, contextWindow: number, free: boolean): string {
  const parts: string[] = [id];
  if (free) parts.push("free");
  if (contextWindow > 0) parts.push(`${Math.round(contextWindow / 1000)}K ctx`);
  return parts.length > 1 ? `${parts[0]} — ${parts.slice(1).join(" · ")}` : parts[0];
}

/**
 * Orders models as: free first (alphabetical within), then non-free
 * (alphabetical within). Stable and predictable for UI rendering.
 */
function orderModels(rows: ExtendedGroqModel[]): ExtendedGroqModel[] {
  return [...rows].sort((a, b) => {
    if (a.free !== b.free) return a.free ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

const STATIC_EXTENDED_FALLBACK: ExtendedGroqModel[] = orderModels(
  STATIC_MODEL_CATALOG.map((m: GroqModelMeta) => ({
    id: m.id,
    label: m.label,
    free: m.free,
    contextWindow: m.contextWindow,
  })),
);

async function loadModels(): Promise<ExtendedGroqModel[]> {
  const apiKey = (process.env[AUTH_ENV_VAR] ?? "").trim();
  if (!apiKey) return STATIC_EXTENDED_FALLBACK;
  try {
    const resp = await fetch(GROQ_MODELS_URL, {
      headers: {
        accept: "application/json",
        authorization: "Bearer " + apiKey,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return STATIC_EXTENDED_FALLBACK;
    const body = (await resp.json()) as {
      data?: Array<{
        id?: string;
        context_window?: number;
        active?: boolean;
      }>;
    };
    if (!body || !Array.isArray(body.data)) return STATIC_EXTENDED_FALLBACK;
    const rows = body.data
      .filter(
        (m): m is { id: string; context_window?: number; active?: boolean } =>
          !!m && typeof m.id === "string" && m.id.length > 0,
      )
      .filter((m) => m.active !== false)
      .map((m) => {
        const free = FREE_MODEL_SET.has(m.id);
        const contextWindow = m.context_window ?? 0;
        return {
          id: m.id,
          label: labelFor(m.id, contextWindow, free),
          free,
          contextWindow,
        };
      });
    return rows.length > 0 ? orderModels(rows) : STATIC_EXTENDED_FALLBACK;
  } catch {
    return STATIC_EXTENDED_FALLBACK;
  }
}

/**
 * Full extended catalog, resolved at module load. Exported so callers
 * that care about `free` / `contextWindow` can consume it directly.
 */
export const extendedModels: ExtendedGroqModel[] = await loadModels();

/**
 * AdapterModel-compatible view consumed by Paperclip's core
 * (which only knows about `{id, label}`).
 */
export const models: AdapterModel[] = extendedModels.map(({ id, label }) => ({
  id,
  label,
}));

export const agentConfigurationDoc = `# Groq Adapter

Free, lightning-fast LLM access via [Groq](https://groq.com)'s OpenAI-compatible
chat completions endpoint. Good for agents where latency matters more than
frontier-model capability.

## Prerequisites

- A Groq API key from https://console.groq.com/keys
- Set \`${AUTH_ENV_VAR}\` in the agent's adapter env or the Paperclip server env.

## Core Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| model | string | \`${DEFAULT_MODEL}\` | Groq model id. See https://console.groq.com/docs/models |
| timeoutSec | number | ${DEFAULT_TIMEOUT_SEC} | Hard timeout for a single run. |
| promptTemplate | string | _(default)_ | Mustache-style template. |
| instructionsFilePath | string | _(none)_ | Path to a markdown file injected as a \`system\` message on fresh sessions. |
| env.${AUTH_ENV_VAR} | string | _(none)_ | Preferred location for the API key. |

## Session resume

Groq is stateless, so this adapter persists the running conversation
as JSON under \`/tmp/paperclip-groq-sessions/<sessionId>.json\` and
round-trips the sessionId through Paperclip's \`sessionParams\`.

## Tool calling (v0.7)

When the Paperclip runtime supplies a tool surface (\`ctx.tools\`) or
the agent config provides a literal \`tools: []\` array of OpenAI-style
function descriptors, the adapter streams tool_call deltas from Groq,
invokes each tool, appends the results as \`role: "tool"\` messages,
and re-queries — up to 10 iterations before giving up.

## Known limitations

- No retry on 429 (rate limit).
- \`costUsd\` is always 0 — Groq's free tier has no per-run billing.
`;

const configSchema: AdapterConfigSchema = {
  fields: [
    {
      key: "model",
      label: "Model",
      type: "combobox",
      default: DEFAULT_MODEL,
      required: false,
      options: extendedModels.map((m) => ({
        label: m.label,
        value: m.id,
        group: m.free ? "Free" : "Paid",
      })),
      hint: "Groq model id. Free-tier models listed first.",
    },
    {
      key: "timeoutSec",
      label: "Timeout (seconds)",
      type: "number",
      default: DEFAULT_TIMEOUT_SEC,
      required: false,
    },
    {
      key: "promptTemplate",
      label: "Prompt template",
      type: "textarea",
      default: DEFAULT_PROMPT_TEMPLATE,
      required: false,
    },
    {
      key: "instructionsFilePath",
      label: "Instructions file path (AGENTS.md)",
      type: "text",
      default: "",
      required: false,
    },
  ],
};

/**
 * Factory invoked by the Paperclip plugin loader.
 */
export function createServerAdapter(): ServerAdapterModule {
  return {
    type: ADAPTER_TYPE,
    execute,
    testEnvironment,
    sessionCodec,
    models,
    agentConfigurationDoc,
    detectModel,
    getConfigSchema: () => configSchema,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
  };
}

export default createServerAdapter;
