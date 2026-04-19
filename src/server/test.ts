/**
 * Environment test for the Groq adapter.
 *
 * Validates:
 *   1. GROQ_API_KEY is resolvable (config.env > process.env).
 *   2. The /models endpoint is reachable with that key.
 *   3. A model is configured (warn if missing).
 */

import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentCheckLevel,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  ADAPTER_TYPE,
  AUTH_ENV_VAR,
  DEFAULT_MODEL,
  GROQ_MODELS_URL,
} from "../shared/constants.js";

function makeCheck(
  level: AdapterEnvironmentCheckLevel,
  code: string,
  message: string,
  extras: { detail?: string | null; hint?: string | null } = {},
): AdapterEnvironmentCheck {
  return {
    code,
    level,
    message,
    detail: extras.detail ?? null,
    hint: extras.hint ?? null,
  };
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveApiKey(config: Record<string, unknown>): {
  key: string | null;
  source: string | null;
} {
  const envConfig = (config.env ?? {}) as Record<string, unknown>;
  const fromConfig = asOptionalString(envConfig[AUTH_ENV_VAR]);
  if (fromConfig) return { key: fromConfig, source: `agent.env.${AUTH_ENV_VAR}` };
  const fromProc = (process.env[AUTH_ENV_VAR] ?? "").trim();
  if (fromProc) return { key: fromProc, source: `process.env.${AUTH_ENV_VAR}` };
  return { key: null, source: null };
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const checks: AdapterEnvironmentCheck[] = [];

  const { key: apiKey, source: apiKeySource } = resolveApiKey(config);
  if (!apiKey) {
    checks.push(
      makeCheck("error", "groq_no_api_key", `${AUTH_ENV_VAR} not configured`, {
        hint: `Set ${AUTH_ENV_VAR} in the agent's adapter env or the Paperclip server process env.`,
      }),
    );
  } else {
    checks.push(
      makeCheck("info", "groq_api_key_found", `Groq API key resolved from: ${apiKeySource}`),
    );
  }

  const model = asOptionalString(config.model);
  if (!model) {
    checks.push(
      makeCheck(
        "warn",
        "groq_no_model",
        `No model specified — adapter will fall back to "${DEFAULT_MODEL}"`,
      ),
    );
  } else {
    checks.push(makeCheck("info", "groq_model_configured", `Model: ${model}`));
  }

  if (apiKey) {
    try {
      const response = await fetch(GROQ_MODELS_URL, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: "Bearer " + apiKey,
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          checks.push(
            makeCheck(
              "error",
              "groq_auth_failed",
              `Groq rejected the API key (HTTP ${response.status})`,
              { hint: "Verify the key at https://console.groq.com/keys" },
            ),
          );
        } else {
          checks.push(
            makeCheck(
              "warn",
              "groq_models_endpoint_unhappy",
              `Groq /models returned HTTP ${response.status}`,
            ),
          );
        }
      } else {
        checks.push(
          makeCheck("info", "groq_reachable", "Groq /models endpoint reachable"),
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      checks.push(
        makeCheck("warn", "groq_unreachable", "Could not reach Groq /models endpoint", {
          detail: message,
        }),
      );
    }
  }

  const hasError = checks.some((c) => c.level === "error");
  const hasWarn = checks.some((c) => c.level === "warn");
  return {
    adapterType: ADAPTER_TYPE,
    status: hasError ? "fail" : hasWarn ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
