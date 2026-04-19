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
 * v0.7 scope:
 *   - streaming chat completions with session resume
 *   - OpenAI-style tool/function calling with a client-driven loop
 *     (Groq has no server loop; we invoke tools via ctx.tools.invoke
 *     and feed results back until finish_reason: "stop")
 *   - streaming responses logged delta-by-delta via onLog("stdout")
 *   - GROQ_API_KEY resolution: config.env → process.env
 *
 * TODO(next):
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
  type ChatToolCall,
} from "./parse.js";
import {
  ADAPTER_TYPE,
  AUTH_ENV_VAR,
  BILLER_SLUG,
  DEFAULT_MODEL,
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_TIMEOUT_SEC,
  GROQ_CHAT_URL,
  MAX_TOOL_ITERATIONS,
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

// --------------------------------------------------------------------
// Tool wiring
// --------------------------------------------------------------------
//
// The adapter-utils SDK does not (yet) formally expose a tools surface
// on AdapterExecutionContext. We feature-detect two possible shapes:
//
//   1. ctx.tools — an object with { list?, invoke(name, args) } as
//      signalled in the v0.7 task (future SDK shape)
//   2. config.tools — a JSON array of OpenAI-function descriptors
//      supplied directly on the agent config (operator-provided)
//
// Either one activates the tool-calling loop. When neither is present
// we fall back to the v0.5 single-turn streaming path — exactly as
// before — so existing agents are unaffected.

interface OpenAIFunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface RawToolDescriptor {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  input_schema?: Record<string, unknown>;
}

interface PaperclipToolsSurface {
  list?: () => RawToolDescriptor[] | Promise<RawToolDescriptor[]>;
  invoke: (name: string, args: unknown) => Promise<unknown> | unknown;
}

async function resolveToolsSurface(
  ctx: AdapterExecutionContext,
): Promise<{
  openaiTools: OpenAIFunctionTool[];
  invoke: ((name: string, args: unknown) => Promise<unknown>) | null;
}> {
  const surface = (ctx as unknown as { tools?: PaperclipToolsSurface }).tools;

  let rawTools: RawToolDescriptor[] | null = null;
  let invoke: ((name: string, args: unknown) => Promise<unknown>) | null = null;

  if (surface && typeof surface.invoke === "function") {
    invoke = async (name, args) => surface.invoke(name, args);
    if (typeof surface.list === "function") {
      try {
        rawTools = await surface.list();
      } catch {
        rawTools = null;
      }
    }
  }

  // Fallback: config.tools as a literal OpenAI-style array.
  if (!rawTools) {
    const fromConfig = Array.isArray(
      (ctx.config as Record<string, unknown>).tools,
    )
      ? ((ctx.config as Record<string, unknown>).tools as unknown[])
      : null;
    if (fromConfig) {
      rawTools = fromConfig
        .map((t): RawToolDescriptor | null => {
          if (!t || typeof t !== "object") return null;
          const r = t as Record<string, unknown>;
          const fn = (r.function ?? r) as Record<string, unknown>;
          const name = typeof fn.name === "string" ? fn.name : null;
          if (!name) return null;
          return {
            name,
            description:
              typeof fn.description === "string" ? fn.description : undefined,
            parameters:
              fn.parameters && typeof fn.parameters === "object"
                ? (fn.parameters as Record<string, unknown>)
                : undefined,
            input_schema:
              fn.input_schema && typeof fn.input_schema === "object"
                ? (fn.input_schema as Record<string, unknown>)
                : undefined,
          };
        })
        .filter((v): v is RawToolDescriptor => v !== null);
    }
  }

  const openaiTools: OpenAIFunctionTool[] = (rawTools ?? []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters:
        t.parameters ?? t.input_schema ?? { type: "object", properties: {} },
    },
  }));

  return { openaiTools, invoke };
}

// --------------------------------------------------------------------
// Streaming one turn
// --------------------------------------------------------------------

interface TurnResult {
  assistantText: string;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  usageIn: number;
  usageOut: number;
  model: string;
  streamError: string | null;
  aborted: boolean;
  httpError?: { status: number; body: string } | null;
  networkError?: string | null;
}

interface StreamingToolCallAccum {
  id?: string;
  name?: string;
  args: string;
}

async function runOneTurn(params: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools: OpenAIFunctionTool[];
  signal: AbortSignal;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<TurnResult> {
  const { apiKey, model, messages, tools, signal, onLog } = params;

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  let response: Response;
  try {
    response = await fetch(GROQ_CHAT_URL, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        authorization: "Bearer " + apiKey,
        "content-type": "application/json",
        "user-agent": "groq-paperclip-adapter/0.7.0",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const aborted = (err as { name?: string })?.name === "AbortError";
    return {
      assistantText: "",
      toolCalls: [],
      finishReason: null,
      usageIn: 0,
      usageOut: 0,
      model,
      streamError: null,
      aborted,
      networkError: err instanceof Error ? err.message : String(err),
    };
  }

  if (!response.ok || !response.body) {
    const bodyText = await response.text().catch(() => "");
    return {
      assistantText: "",
      toolCalls: [],
      finishReason: null,
      usageIn: 0,
      usageOut: 0,
      model,
      streamError: null,
      aborted: false,
      httpError: { status: response.status, body: bodyText },
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let assistantText = "";
  let finalModel = model;
  let finishReason: string | null = null;
  let usageIn = 0;
  let usageOut = 0;
  const toolAccum = new Map<number, StreamingToolCallAccum>();
  let streamError: string | null = null;
  let aborted = false;

  const apply = async (line: string) => {
    const delta = parseSseLine(line);
    if (!delta) return;
    if (delta.model) finalModel = delta.model;
    if (delta.textDelta) {
      assistantText += delta.textDelta;
      await onLog("stdout", delta.textDelta);
    }
    if (delta.toolCalls) {
      for (const tc of delta.toolCalls) {
        const existing = toolAccum.get(tc.index) ?? { args: "" };
        if (tc.id) existing.id = tc.id;
        if (tc.name) existing.name = tc.name;
        if (tc.argumentsDelta) existing.args += tc.argumentsDelta;
        toolAccum.set(tc.index, existing);
      }
    }
    if (delta.usage) {
      usageIn = delta.usage.prompt_tokens ?? usageIn;
      usageOut = delta.usage.completion_tokens ?? usageOut;
    }
    if (delta.finishReason) finishReason = delta.finishReason;
  };

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) await apply(line);
    }
    if (buffer.trim()) await apply(buffer);
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") {
      aborted = true;
    } else {
      streamError = err instanceof Error ? err.message : String(err);
    }
  }

  const toolCalls: ChatToolCall[] = [...toolAccum.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, acc]) => ({
      id: acc.id ?? `call_${idx}`,
      type: "function" as const,
      function: {
        name: acc.name ?? "",
        arguments: acc.args,
      },
    }));

  return {
    assistantText,
    toolCalls,
    finishReason,
    usageIn,
    usageOut,
    model: finalModel,
    streamError,
    aborted,
  };
}

function safeParseJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { _raw: trimmed };
  }
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

// --------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------

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

  // -------- Tool surface --------
  const { openaiTools, invoke: toolInvoke } = await resolveToolsSurface(ctx);
  const toolsEnabled = openaiTools.length > 0 && toolInvoke !== null;

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
        toolsEnabled
          ? `tools enabled (${openaiTools.length}): ${openaiTools
              .map((t) => t.function.name)
              .join(", ")}`
          : "tools disabled",
      ],
      env: loggedEnv,
      prompt: userPrompt,
      promptMetrics,
      context,
    });
  }

  // -------- Loop: chat → tools → chat until finish_reason: "stop" --------
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutSec * 1000);

  let totalUsageIn = 0;
  let totalUsageOut = 0;
  let finalModel = model;
  let finalFinishReason: string | null = null;
  let lastAssistantText = "";
  let streamError: string | null = null;
  let iterationsUsed = 0;
  let hitIterationCap = false;

  try {
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      iterationsUsed = iter + 1;
      const turn = await runOneTurn({
        apiKey,
        model,
        messages,
        tools: toolsEnabled ? openaiTools : [],
        signal: controller.signal,
        onLog,
      });

      if (turn.aborted) {
        clearTimeout(timeoutHandle);
        return {
          exitCode: null,
          signal: null,
          timedOut: true,
          errorMessage: `Timed out after ${timeoutSec}s`,
          errorCode: "timeout",
        };
      }
      if (turn.networkError) {
        await onLog(
          "stderr",
          `[paperclip-groq] fetch failed: ${turn.networkError}\n`,
        );
        clearTimeout(timeoutHandle);
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: `Groq fetch failed: ${turn.networkError}`,
          errorCode: "groq_fetch_failed",
        };
      }
      if (turn.httpError) {
        await onLog(
          "stderr",
          `[paperclip-groq] HTTP ${turn.httpError.status}: ${turn.httpError.body}\n`,
        );
        clearTimeout(timeoutHandle);
        const errorCode =
          turn.httpError.status === 401 || turn.httpError.status === 403
            ? "groq_auth_required"
            : turn.httpError.status === 429
              ? "groq_rate_limited"
              : "groq_http_error";
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: `Groq returned HTTP ${turn.httpError.status}: ${turn.httpError.body.slice(0, 500)}`,
          errorCode,
        };
      }

      totalUsageIn += turn.usageIn;
      totalUsageOut += turn.usageOut;
      finalModel = turn.model;
      finalFinishReason = turn.finishReason;
      lastAssistantText = turn.assistantText;
      streamError = turn.streamError;

      // Always push the assistant turn (text and/or tool_calls) onto history.
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: turn.assistantText,
      };
      if (turn.toolCalls.length > 0) {
        assistantMsg.tool_calls = turn.toolCalls;
      }
      messages.push(assistantMsg);

      const wantsTools =
        turn.finishReason === "tool_calls" && turn.toolCalls.length > 0;
      if (!wantsTools) break;

      if (!toolInvoke) {
        await onLog(
          "stderr",
          `[paperclip-groq] Model requested tool_calls but no tool invoker is wired. Ending turn.\n`,
        );
        break;
      }

      for (const call of turn.toolCalls) {
        const toolName = call.function.name;
        const args = safeParseJson(call.function.arguments);
        await onLog(
          "stdout",
          `\n[tool_call] ${toolName}(${stringifyToolResult(args).slice(0, 500)})\n`,
        );
        let resultText: string;
        let isError = false;
        try {
          const result = await toolInvoke(toolName, args);
          resultText = stringifyToolResult(result);
        } catch (err) {
          isError = true;
          resultText = stringifyToolResult({
            error: err instanceof Error ? err.message : String(err),
          });
        }
        await onLog(
          "stdout",
          `[tool_result${isError ? ":error" : ""}] ${resultText.slice(0, 500)}\n`,
        );
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: toolName,
          content: resultText,
        });
      }

      if (iter === MAX_TOOL_ITERATIONS - 1) {
        hitIterationCap = true;
        await onLog(
          "stderr",
          `[paperclip-groq] Hit MAX_TOOL_ITERATIONS=${MAX_TOOL_ITERATIONS}; stopping tool loop.\n`,
        );
      }
    }
  } finally {
    clearTimeout(timeoutHandle);
  }

  await onLog("stdout", "\n");

  // -------- Persist updated session --------
  try {
    await saveSession(sessionId, messages);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await onLog(
      "stderr",
      `[paperclip-groq] Warning: could not persist session ${sessionId}: ${message}\n`,
    );
  }

  if (streamError && !lastAssistantText) {
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
      inputTokens: totalUsageIn,
      outputTokens: totalUsageOut,
    },
    sessionId,
    sessionParams: { sessionId, cwd: process.cwd() },
    sessionDisplayId: sessionId,
    provider: PROVIDER_SLUG,
    biller: BILLER_SLUG,
    model: finalModel,
    billingType: "credits",
    costUsd: 0,
    summary: lastAssistantText.trim(),
    resultJson: {
      sessionId,
      model: finalModel,
      finishReason: finalFinishReason,
      inputTokens: totalUsageIn,
      outputTokens: totalUsageOut,
      toolIterations: iterationsUsed,
      hitIterationCap,
    },
  };
}
