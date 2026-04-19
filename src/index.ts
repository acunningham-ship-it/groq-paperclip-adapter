/**
 * Groq Paperclip adapter — main entry.
 *
 * v0.0.1: scaffold. Implementation TBD.
 */

import {
  ADAPTER_LABEL,
  ADAPTER_TYPE,
  DEFAULT_MODEL,
  AUTH_ENV_VAR,
} from "./shared/constants.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;

export const models = [];

export const agentConfigurationDoc = `# Groq Adapter Configuration

Free LLM access via Groq. Requires \`GROQ_API_KEY\` env var.

## Core configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| model | string | llama-3.3-70b-versatile | Model id |
| timeoutSec | number | 300 | Execution timeout |

See FREE_MODELS in src/shared/constants.ts for available free models.
`;

// TODO(Dev Team): implement createServerAdapter() factory
