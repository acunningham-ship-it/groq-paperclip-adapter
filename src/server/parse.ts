/**
 * Session codec + history persistence for the Groq adapter.
 *
 * Groq's API is stateless: there is no server-side session id. So to
 * support multi-turn resume, we persist the running conversation
 * (messages array) as a JSON file on disk keyed by a random sessionId,
 * and round-trip that sessionId through AdapterRuntime.sessionParams.
 *
 * File location: $SESSION_DIR/<sessionId>.json
 * Shape: { messages: ChatMessage[], createdAt: string, updatedAt: string }
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { SESSION_DIR } from "../shared/constants.js";

export interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** Assistant messages may carry only tool_calls and an empty content. */
  content: string;
  /** Assistant-side tool invocations. */
  tool_calls?: ChatToolCall[];
  /** Tool-result messages: id of the tool_call being answered. */
  tool_call_id?: string;
  /** Tool-result messages: friendly tool name (OpenAI-compatible). */
  name?: string;
}

export interface SessionFile {
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function newSessionId(): string {
  return "groq-" + crypto.randomBytes(12).toString("hex");
}

function sessionFilePath(sessionId: string): string {
  // Defensive: sanitize to avoid traversal.
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "");
  return path.join(SESSION_DIR, safe + ".json");
}

export async function loadSession(sessionId: string): Promise<SessionFile | null> {
  try {
    const raw = await fs.readFile(sessionFilePath(sessionId), "utf-8");
    const parsed = JSON.parse(raw) as Partial<SessionFile>;
    if (!parsed || !Array.isArray(parsed.messages)) return null;
    return {
      messages: parsed.messages.filter(
        (m): m is ChatMessage =>
          !!m && typeof m === "object" &&
          (m.role === "system" ||
            m.role === "user" ||
            m.role === "assistant" ||
            m.role === "tool") &&
          typeof m.content === "string",
      ),
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function saveSession(sessionId: string, messages: ChatMessage[]): Promise<void> {
  await fs.mkdir(SESSION_DIR, { recursive: true });
  const now = new Date().toISOString();
  const existing = await loadSession(sessionId);
  const data: SessionFile = {
    messages,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await fs.writeFile(sessionFilePath(sessionId), JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Parse a single SSE line from Groq. Returns either a text delta,
 * a usage object, or null for non-content events (role messages,
 * [DONE], empty lines).
 */
/**
 * One chunk of a streaming tool_call. Groq (OpenAI-compat) streams tool
 * call args token-by-token, keyed by `index`. Consumers accumulate
 * per-index into a ChatToolCall.
 */
export interface StreamToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}

export interface StreamDelta {
  textDelta?: string;
  toolCalls?: StreamToolCallDelta[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  finishReason?: string | null;
  model?: string;
}

export function parseSseLine(line: string): StreamDelta | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
  const out: StreamDelta = {};
  if (typeof obj.model === "string") out.model = obj.model;
  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  if (first) {
    const delta = (first.delta ?? {}) as Record<string, unknown>;
    if (typeof delta.content === "string") out.textDelta = delta.content;
    const rawToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    if (rawToolCalls.length > 0) {
      const tcs: StreamToolCallDelta[] = [];
      for (const raw of rawToolCalls) {
        if (!raw || typeof raw !== "object") continue;
        const rec = raw as Record<string, unknown>;
        const idx = typeof rec.index === "number" ? rec.index : 0;
        const fn = (rec.function ?? {}) as Record<string, unknown>;
        tcs.push({
          index: idx,
          id: typeof rec.id === "string" ? rec.id : undefined,
          name: typeof fn.name === "string" ? fn.name : undefined,
          argumentsDelta: typeof fn.arguments === "string" ? fn.arguments : undefined,
        });
      }
      if (tcs.length > 0) out.toolCalls = tcs;
    }
    const finish = first.finish_reason;
    if (typeof finish === "string" || finish === null) out.finishReason = finish ?? null;
  }
  const usage = obj.usage;
  if (usage && typeof usage === "object" && !Array.isArray(usage)) {
    out.usage = usage as StreamDelta["usage"];
  }
  return out;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id);
    if (!sessionId) return null;
    const out: Record<string, unknown> = { sessionId };
    const cwd = readNonEmptyString(record.cwd);
    if (cwd) out.cwd = cwd;
    return out;
  },
  serialize(params) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
    if (!sessionId) return null;
    const out: Record<string, unknown> = { sessionId };
    const cwd = readNonEmptyString(params.cwd);
    if (cwd) out.cwd = cwd;
    return out;
  },
  getDisplayId(params) {
    if (!params) return null;
    return readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
  },
};
