import "server-only";
import type { AiConfig } from "../config";
import { describeUpstreamError, fetchWithRetry, providerHeaders, UpstreamError } from "../provider";
import type { ToolDefinition } from "./tools";

/** Text, or text plus images, for models that can see (OpenAI-style content parts). */
export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type ChatMsg =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: NativeToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

type NativeToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

/** What the model decided to do next. Malformed output is reported, never guessed at. */
export type Decision =
  | { kind: "tool"; thought: string; tool: string; arguments: unknown; stepIndex: number | null; nativeId?: string; argumentsError?: string }
  | { kind: "finish"; thought: string; answer: string }
  | { kind: "malformed"; raw: string; error: string };

/** Providers that rejected `response_format: json_schema`; we fall back to prompting for JSON. */
const noJsonSchema = new Set<string>();

async function post(config: AiConfig, body: Record<string, unknown>, signal: AbortSignal): Promise<{ message: { content?: string | null; tool_calls?: NativeToolCall[] }; finish: string | null }> {
  let res: Response;
  const started = Date.now();
  try {
    res = await fetchWithRetry(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...providerHeaders(config) },
      body: JSON.stringify({ ...body, ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}), stream: false }),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new UpstreamError(`Cannot reach ${config.providerName}.`, 503);
  }
  const text = await res.text();
  if (process.env.NOVA_DEBUG_LLM === "true") {
    // Timing only (no content): how long the model took and how much it read and wrote.
    const usage = (() => { try { return JSON.parse(text).usage ?? {}; } catch { return {}; } })();
    console.error(`[agent] model call ${Date.now() - started} ms, prompt ${usage.prompt_tokens ?? "?"} tokens, answer ${usage.completion_tokens ?? "?"} tokens`);
  }
  if (!res.ok) {
    const error = describeUpstreamError(config, res.status, text);
    (error as UpstreamError & { httpStatus?: number; body?: string }).httpStatus = res.status;
    (error as UpstreamError & { body?: string }).body = text;
    throw error;
  }
  let data: { choices?: { message?: { content?: string | null; tool_calls?: NativeToolCall[] }; finish_reason?: string | null }[] };
  try {
    data = JSON.parse(text);
  } catch {
    throw new UpstreamError(`${config.providerName} returned an invalid response.`, 502);
  }
  const choice = data.choices?.[0];
  if (!choice?.message) throw new UpstreamError(`${config.providerName} returned no answer.`, 502);
  return { message: choice.message, finish: choice.finish_reason ?? null };
}

/** Extracts the first balanced JSON object from model text (handles ```json fences and chatter). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const start = trimmed.indexOf("{");
  if (start < 0) throw new Error("no JSON object found");
  let depth = 0;
  let inString = false;
  for (let i = start; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(trimmed.slice(start, i + 1));
  }
  throw new Error("unterminated JSON object");
}

/** Asks for a JSON object matching `schema`, using structured output when the provider supports it. */
export async function completeJson(
  config: AiConfig,
  model: string,
  messages: ChatMsg[],
  schemaName: string,
  schema: Record<string, unknown>,
  signal: AbortSignal,
  extra: Record<string, unknown> = {},
): Promise<{ value: unknown; raw: string; error?: string }> {
  const base = { model, messages, temperature: 0.2, ...extra };
  let result;
  if (!noJsonSchema.has(config.baseUrl)) {
    try {
      result = await post(config, { ...base, response_format: { type: "json_schema", json_schema: { name: schemaName, strict: false, schema } } }, signal);
    } catch (err) {
      const status = (err as { httpStatus?: number }).httpStatus;
      const body = (err as { body?: string }).body ?? "";
      if (status === 400 && /response_format|json_schema|structured/i.test(body)) {
        noJsonSchema.add(config.baseUrl);
        console.warn("[agent] provider rejected json_schema; falling back to prompted JSON");
      } else throw err;
    }
  }
  if (!result) result = await post(config, base, signal);
  const raw = result.message.content ?? "";
  try {
    return { value: extractJson(raw), raw };
  } catch (err) {
    return { value: null, raw, error: (err as Error).message };
  }
}

export async function completeText(config: AiConfig, model: string, system: string, user: string | ContentPart[], signal: AbortSignal): Promise<string> {
  const result = await post(
    config,
    { model, temperature: 0.2, messages: [{ role: "system", content: system }, { role: "user", content: user }], ...(config.maxOutputTokens ? { max_tokens: config.maxOutputTokens } : {}) },
    signal,
  );
  return result.message.content ?? "";
}

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    steps: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 },
  },
  required: ["steps"],
};

/**
 * `argumentsAsText`: providers that enforce the schema strictly (e.g. Google Gemini) drop or skip fields an
 * open "object" doesn't list (every call became `click({})`). For them the arguments are a JSON string the
 * model writes freely, like OpenAI tool calls, and Syntaz parses it.
 */
export function stepSchema(toolNames: string[], argumentsAsText = false) {
  return {
    type: "object",
    properties: {
      thought: { type: "string" },
      step: { type: "integer" },
      action: { type: "string", enum: ["call_tool", "finish"] },
      tool: { type: "string", enum: [...toolNames, "none"] },
      arguments: argumentsAsText
        ? { type: "string", description: 'The tool\'s arguments as a JSON object, e.g. {"field": "Search", "text": "blue mug"}; "{}" when finishing.' }
        : { type: "object" },
      answer: { type: "string" },
    },
    required: ["thought", "step", "action", "tool", "arguments", "answer"],
  };
}

/** Interprets a JSON-mode step object. */
export function parseJsonDecision(value: unknown, raw: string): Decision {
  if (!value || typeof value !== "object") return { kind: "malformed", raw, error: "not a JSON object" };
  const v = value as Record<string, unknown>;
  const thought = typeof v.thought === "string" ? v.thought : "";
  const stepIndex = typeof v.step === "number" && Number.isInteger(v.step) ? v.step : null;
  if (v.action === "finish") {
    if (typeof v.answer !== "string" || !v.answer.trim()) return { kind: "malformed", raw, error: "finish without an answer" };
    return { kind: "finish", thought, answer: v.answer };
  }
  if (v.action === "call_tool") {
    if (typeof v.tool !== "string" || !v.tool || v.tool === "none") {
      // Small models sometimes say "call_tool" with no tool but a written answer: they meant to finish.
      if (typeof v.answer === "string" && v.answer.trim()) return { kind: "finish", thought, answer: v.answer };
      return { kind: "malformed", raw, error: "call_tool without a tool name" };
    }
    let args: unknown = v.arguments ?? {};
    if (typeof args === "string") {
      // Arguments written as JSON text (see stepSchema). Not JSON: passed on, and the call is refused with
      // "must be a JSON object" so the model can correct it.
      try {
        args = args.trim() ? JSON.parse(args) : {};
      } catch {
        /* keep the text */
      }
    }
    return { kind: "tool", thought, tool: v.tool, arguments: args, stepIndex };
  }
  return { kind: "malformed", raw, error: 'action must be "call_tool" or "finish"' };
}

export function nativeTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/** Native mode: one completion with OpenAI tool definitions. */
export async function nativeDecision(
  config: AiConfig,
  model: string,
  messages: ChatMsg[],
  tools: ToolDefinition[],
  signal: AbortSignal,
): Promise<Decision> {
  const { message } = await post(config, { model, messages, tools: nativeTools(tools), temperature: 0.2 }, signal);
  const call = message.tool_calls?.[0];
  if (call) {
    let args: unknown = {};
    let argumentsError: string | undefined;
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      argumentsError = "The tool arguments were not valid JSON.";
    }
    return { kind: "tool", thought: message.content ?? "", tool: call.function.name, arguments: args, stepIndex: null, nativeId: call.id, argumentsError };
  }
  const text = (message.content ?? "").trim();
  if (!text) return { kind: "malformed", raw: "", error: "empty reply" };
  return { kind: "finish", thought: "", answer: text };
}
