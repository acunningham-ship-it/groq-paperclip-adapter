/**
 * Groq model detection. Hits /models to verify the catalog is reachable
 * and returns the full list of available model ids.
 */

import {
  DEFAULT_MODEL,
  GROQ_MODELS_URL,
  PROVIDER_SLUG,
  AUTH_ENV_VAR,
} from "../shared/constants.js";

export interface DetectedModel {
  model: string;
  provider: string;
  source: string;
  candidates?: string[];
}

interface GroqModel {
  id?: string;
  owned_by?: string;
  context_window?: number;
}

interface GroqModelsResponse {
  data?: GroqModel[];
}

const DETECTION_TIMEOUT_MS = 10_000;

function resolveApiKey(): string | null {
  const key = (process.env[AUTH_ENV_VAR] ?? "").trim();
  return key.length > 0 ? key : null;
}

export async function detectModel(): Promise<DetectedModel | null> {
  const apiKey = resolveApiKey();
  if (!apiKey) return null;
  let response: Response;
  try {
    response = await fetch(GROQ_MODELS_URL, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: "Bearer " + apiKey,
        "user-agent": "groq-paperclip-adapter/0.0.1",
      },
      signal: AbortSignal.timeout(DETECTION_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: GroqModelsResponse;
  try {
    body = (await response.json()) as GroqModelsResponse;
  } catch {
    return null;
  }
  if (!body || !Array.isArray(body.data)) return null;
  const candidates = body.data
    .map((m) => (typeof m.id === "string" ? m.id : null))
    .filter((id): id is string => !!id);
  return {
    model: DEFAULT_MODEL,
    provider: PROVIDER_SLUG,
    source: "groq_models_endpoint",
    candidates,
  };
}
