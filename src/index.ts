/**
 * Groq Paperclip adapter — main entry.
 *
 * Direct HTTP adapter against Groq's OpenAI-compatible chat completions
 * endpoint. Free-tier focused: llama-3.3-70b-versatile, llama-3.1-8b-instant,
 * qwen/qwen3-32b, openai/gpt-oss-120b, moonshotai/kimi-k2-instruct.
 *
 * v0.5 MVP: streaming single-turn + session resume via on-disk history.
 * No tool calling, no cost tracking (Groq is free).
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
  FREE_MODELS,
  GROQ_MODELS_URL,
} from "./shared/constants.js";
import {
  detectModel,
  execute,
  sessionCodec,
  testEnvironment,
} from "./server/index.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;

const STATIC_FALLBACK: AdapterModel[] = FREE_MODELS.map((id) => ({
  id,
  label: `${id} — free`,
}));

async function loadModels(): Promise<AdapterModel[]> {
  const apiKey = (process.env[AUTH_ENV_VAR] ?? "").trim();
  if (!apiKey) return STATIC_FALLBACK;
  try {
    const resp = await fetch(GROQ_MODELS_URL, {
      headers: {
        accept: "application/json",
        authorization: "Bearer " + apiKey,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return STATIC_FALLBACK;
    const body = (await resp.json()) as {
      data?: Array<{ id?: string; context_window?: number }>;
    };
    if (!body || !Array.isArray(body.data)) return STATIC_FALLBACK;
    const rows = body.data
      .filter((m): m is { id: string; context_window?: number } =>
        !!m && typeof m.id === "string" && m.id.length > 0,
      )
      .map((m) => ({
        id: m.id,
        label:
          m.id +
          (m.context_window ? ` · ${Math.round(m.context_window / 1000)}K ctx` : ""),
      }));
    return rows.length > 0 ? rows : STATIC_FALLBACK;
  } catch {
    return STATIC_FALLBACK;
  }
}

export const models: AdapterModel[] = await loadModels();

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

## Known limitations (v0.5)

- No tool/function calling yet.
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
      options: STATIC_FALLBACK.map((m) => ({ label: m.label, value: m.id })),
      hint: "Groq model id. Free-tier models preselected.",
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
