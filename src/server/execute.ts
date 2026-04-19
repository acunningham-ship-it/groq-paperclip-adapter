/**
 * Execute a single Groq run.
 *
 * Strategy: direct HTTP POST to Groq's OpenAI-compatible
 *   https://api.groq.com/openai/v1/chat/completions
 * endpoint with stream: true. We accumulate SSE deltas into a single
 * assistant reply, append (user prompt + assistant reply) to the stored
 * session history, and return an AdapterExecutionResult.
 *
 * No child process is spawned — unlike claude_local / openrouter_local,
 * Groq has no CLI; we speak HTTP directly.
 *
 * v0.5 scope (first-pass MVP):
 *   - single-turn chat completions (no tool calling)
 *   - streaming responses, delta-by-delta logged to onLog("stdout")
 *   - session resume via on-disk history JSON (see ./parse.ts)
 *   - GROQ_API_KEY resolution: config.env → process.env
 *
 * TODO(v1):
 *   - OpenAI tool / function calling passthrough
 *   - retry on 429 with exponential backoff
 *   - cost tracking (currently $0 since Groq is free-tier)
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  asString,
  asNumber,
  parseObject,
  buildPaperclipEnv,
  joinPromptSections,
  renderTemplate,
  renderPaperclipWakePrompt,
} from "@paperclipai/adapter-utils/server-utils";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  loadSession,
  saveSession,
  newSessionId,
  parseSseLine,
  type ChatMessage,
} from "./parse.js";
import {
  ADAPTER_TYPE,
  AUTH_ENV_VAR,
  BILLER_SLUG,
  DEFAULT_MODEL,
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_TIMEOUT_SEC,
  GROQ_CHAT_URL,
  PROVIDER_SLUG,
} from "../shared/constants.js";

function resolveApiKey(configEnv: Record<string, unknown>): {
  key: string | null;
  source: "config_env" | "process_env" | "missing";
} {
  const fromConfig =
    typeof configEnv[AUTH_ENV_VAR] === "string"
      ? (configEnv[AUTH_ENV_VAR] as string).trim()
      : "";
  if (fromConfig) return { key: fromConfig, source: "config_env" };
  const fromProc = (process.env[AUTH_ENV_VAR] ?? "").trim();
  if (fromProc) return { key: fromProc, source: "process_env" };
  return { key: null, source: "missing" };
}

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta } = ctx;

  const model = asString(config.model, DEFAULT_MODEL);
  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PROMPT_TEMPLATE);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const envConfig = parseObject(config.env);

  // -------- API key --------
  const { key: apiKey, source: apiKeySource } = resolveApiKey(envConfig);
  if (!apiKey) {
    await onLog(
      "stderr",
      `[paperclip-groq] Missing ${AUTH_ENV_VAR} in both config.env and process.env.\n`,
    );
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Missing ${AUTH_ENV_VAR}`,
      errorCode: "groq_missing_api_key",
    };
  }

  // -------- Session resume --------
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const existingSessionId =
    asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "") || null;
  const existingSession = existingSessionId
    ? await loadSession(existingSessionId)
    : null;
  const sessionId = existingSession ? existingSessionId! : newSessionId();

  // -------- Prompt assembly --------
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    resumedSession: Boolean(existingSession),
  });
  const sessionHandoffNote = asString(
    context.paperclipSessionHandoffMarkdown,
    "",
  ).trim();
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const userPrompt = joinPromptSections([
    wakePrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);

  // -------- Build messages --------
  const messages: ChatMessage[] = [];

  // Instructions (AGENTS.md) as system message. Only inject on a fresh
  // session — on resume, the existing history already carries it.
  if (!existingSession && instructionsFilePath) {
    try {
      const instructionsContent = await fs.readFile(instructionsFilePath, "utf-8");
      const pathDirective =
        `\n\nThe above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${path.dirname(instructionsFilePath)}/.`;
      messages.push({
        role: "system",
        content: instructionsContent + pathDirective,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stderr",
        `[paperclip-groq] Warning: could not read instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }

  if (existingSession) {
    messages.push(...existingSession.messages);
  }
  messages.push({ role: "user", content: userPrompt });

  const promptMetrics = {
    promptChars: userPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
    historyMessageCount: existingSession?.messages.length ?? 0,
  };

  // -------- Paperclip env (for log parity only; we don't spawn) --------
  const loggedEnv: Record<string, string> = {
    ...buildPaperclipEnv(agent),
    PAPERCLIP_RUN_ID: runId,
    [AUTH_ENV_VAR]: `[redacted:${apiKeySource}]`,
  };

  if (onMeta) {
    await onMeta({
      adapterType: ADAPTER_TYPE,
      command: "fetch(" + GROQ_CHAT_URL + ")",
      cwd: process.cwd(),
      commandArgs: [],
      commandNotes: [
        `POST ${GROQ_CHAT_URL} stream=true`,
        `model=${model}`,
        existingSession
          ? `resuming session ${sessionId} (${existingSession.messages.length} prior messages)`
          : `new session ${sessionId}`,
      ],
      env: loggedEnv,
      prompt: userPrompt,
      promptMetrics,
      context,
    });
  }

  // -------- Call Groq with streaming --------
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutSec * 1000);

  let response: Response;
  try {
    response = await fetch(GROQ_CHAT_URL, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        authorization: "Bearer " + apiKey,
        "content-type": "application/json",
        "user-agent": "groq-paperclip-adapter/0.0.1",
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutHandle);
    const aborted = (err as { name?: string })?.name === "AbortError";
    const message = err instanceof Error ? err.message : String(err);
    if (aborted) {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
      };
    }
    await onLog("stderr", `[paperclip-groq] fetch failed: ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Groq fetch failed: ${message}`,
      errorCode: "groq_fetch_failed",
    };
  }

  if (!response.ok || !response.body) {
    clearTimeout(timeoutHandle);
    const bodyText = await response.text().catch(() => "");
    await onLog(
      "stderr",
      `[paperclip-groq] HTTP ${response.status}: ${bodyText}\n`,
    );
    const errorCode =
      response.status === 401 || response.status === 403
        ? "groq_auth_required"
        : response.status === 429
          ? "groq_rate_limited"
          : "groq_http_error";
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Groq returned HTTP ${response.status}: ${bodyText.slice(0, 500)}`,
      errorCode,
    };
  }

  // -------- Parse SSE stream --------
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let assistantText = "";
  let usageIn = 0;
  let usageOut = 0;
  let finalModel = model;
  let finishReason: string | null = null;
  let streamError: string | null = null;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE event boundaries are double-newlines; but we tolerate per-line too.
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const delta = parseSseLine(line);
        if (!delta) continue;
        if (delta.model) finalModel = delta.model;
        if (delta.textDelta) {
          assistantText += delta.textDelta;
          await onLog("stdout", delta.textDelta);
        }
        if (delta.usage) {
          usageIn = delta.usage.prompt_tokens ?? usageIn;
          usageOut = delta.usage.completion_tokens ?? usageOut;
        }
        if (delta.finishReason) finishReason = delta.finishReason;
      }
    }
    // Flush any trailing line.
    if (buffer.trim()) {
      const delta = parseSseLine(buffer);
      if (delta?.textDelta) {
        assistantText += delta.textDelta;
        await onLog("stdout", delta.textDelta);
      }
      if (delta?.usage) {
        usageIn = delta.usage.prompt_tokens ?? usageIn;
        usageOut = delta.usage.completion_tokens ?? usageOut;
      }
    }
  } catch (err) {
    const aborted = (err as { name?: string })?.name === "AbortError";
    if (aborted) {
      clearTimeout(timeoutHandle);
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
      };
    }
    streamError = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[paperclip-groq] stream read error: ${streamError}\n`);
  } finally {
    clearTimeout(timeoutHandle);
  }

  await onLog("stdout", "\n");

  // -------- Persist updated session --------
  const updatedMessages: ChatMessage[] = [
    ...messages,
    { role: "assistant", content: assistantText },
  ];
  try {
    await saveSession(sessionId, updatedMessages);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await onLog(
      "stderr",
      `[paperclip-groq] Warning: could not persist session ${sessionId}: ${message}\n`,
    );
  }

  if (streamError && !assistantText) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Groq stream error: ${streamError}`,
      errorCode: "groq_stream_error",
      sessionId,
      sessionParams: { sessionId, cwd: process.cwd() },
      sessionDisplayId: sessionId,
      provider: PROVIDER_SLUG,
      biller: BILLER_SLUG,
      model: finalModel,
      billingType: "credits",
    };
  }

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    usage: {
      inputTokens: usageIn,
      outputTokens: usageOut,
    },
    sessionId,
    sessionParams: { sessionId, cwd: process.cwd() },
    sessionDisplayId: sessionId,
    provider: PROVIDER_SLUG,
    biller: BILLER_SLUG,
    model: finalModel,
    billingType: "credits",
    costUsd: 0,
    summary: assistantText.trim(),
    resultJson: {
      sessionId,
      model: finalModel,
      finishReason,
      inputTokens: usageIn,
      outputTokens: usageOut,
    },
  };
}
