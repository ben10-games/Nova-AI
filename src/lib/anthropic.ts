import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { AiConfig } from "./config";

/**
 * Anthropic (Claude) through the official SDK. The rest of Syntaz speaks the OpenAI chat format, so this file
 * takes such a request and answers with a Response shaped like OpenAI's /chat/completions (JSON, or SSE when
 * `stream` is set). Errors come back as HTTP responses too, so the usual error messages apply.
 */

type OpenAiPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type OpenAiMsg = { role: string; content: string | OpenAiPart[] | null };
type OpenAiBody = {
  model: string;
  messages: OpenAiMsg[];
  stream?: boolean;
  max_tokens?: number;
  tools?: unknown[];
  response_format?: { type: string; json_schema?: { schema?: unknown } };
};

// Models that accept server-side refusal fallbacks ("default" routes by refusal category).
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const DEFAULT_MAX_TOKENS = 16_000; // thinking counts toward it; a small cap would cut answers off
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export function anthropicClient(config: AiConfig): Anthropic {
  return new Anthropic({ apiKey: config.apiKey ?? "", baseURL: config.baseUrl, timeout: config.timeoutMs, maxRetries: 2 });
}

/** Effort for Claude from AI_REASONING_EFFORT ("none"/"minimal" mean as little as possible). */
function effort(config: AiConfig): "low" | "medium" | "high" | null {
  const e = config.reasoningEffort;
  if (!e) return null;
  return e === "none" || e === "minimal" ? "low" : (e as "low" | "medium" | "high");
}

function toContent(content: OpenAiMsg["content"]): Anthropic.Beta.BetaMessageContentParam {
  if (typeof content === "string" || content === null) return content || " ";
  return content.map((part): Anthropic.Beta.BetaContentBlockParam => {
    if (part.type === "text") return { type: "text", text: part.text || " " };
    const m = /^data:([^;]+);base64,(.+)$/.exec(part.image_url.url);
    if (m && IMAGE_TYPES.has(m[1])) {
      return { type: "image", source: { type: "base64", media_type: m[1] as "image/png", data: m[2] } };
    }
    return { type: "image", source: { type: "url", url: part.image_url.url } };
  });
}

function toParams(config: AiConfig, body: OpenAiBody): Anthropic.Beta.MessageCreateParamsNonStreaming {
  const system: string[] = [];
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of body.messages) {
    if (m.role === "system") system.push(typeof m.content === "string" ? m.content : "");
    else if (m.role === "user" || m.role === "assistant") messages.push({ role: m.role, content: toContent(m.content) });
  }
  // Prompted JSON instead of structured outputs: Syntaz's step schema is looser than strict schemas allow,
  // and its reader already finds the JSON object in the answer.
  const schema = body.response_format?.json_schema?.schema;
  if (schema) system.push(`Reply with only one JSON object that matches this JSON Schema, and no other text:\n${JSON.stringify(schema)}`);
  const level = effort(config);
  const fallback = FALLBACK_MODELS.has(body.model);
  return {
    model: body.model,
    max_tokens: Math.max(body.max_tokens ?? config.maxOutputTokens ?? DEFAULT_MAX_TOKENS, 1_024),
    ...(system.length ? { system: system.join("\n\n") } : {}),
    messages,
    ...(level ? { output_config: { effort: level } } : {}),
    ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
  };
}

const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

function errorResponse(err: unknown): Response {
  if (err instanceof Anthropic.APIError && typeof err.status === "number") {
    const message = (err.error as { error?: { message?: string } } | undefined)?.error?.message ?? err.message;
    return json(err.status, { error: { message } });
  }
  throw err; // network problems, aborts: handled like a failed fetch
}

const finishReason = (stop: string | null) => (stop === "max_tokens" ? "length" : stop === "refusal" ? "content_filter" : "stop");
const REFUSED = "(Claude declined this request.)";

/** POST /chat/completions, answered by Claude. */
export async function anthropicChat(config: AiConfig, body: OpenAiBody, signal: AbortSignal): Promise<Response> {
  if (body.tools?.length) return json(400, { error: { message: "Native tool calling isn't supported with Anthropic in Syntaz; use AI_AGENT_MODE=json." } });
  const params = toParams(config, body);
  const client = anthropicClient(config);
  if (!body.stream) {
    let msg: Anthropic.Beta.BetaMessage;
    try {
      msg = await client.beta.messages.create(params, { signal });
    } catch (err) {
      return errorResponse(err);
    }
    let text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    if (!text && msg.stop_reason === "refusal") text = REFUSED;
    return json(200, {
      choices: [{ message: { role: "assistant", content: text }, finish_reason: finishReason(msg.stop_reason) }],
      usage: { prompt_tokens: msg.usage.input_tokens, completion_tokens: msg.usage.output_tokens },
    });
  }
  // Streaming: the first event decides between an error response and a stream (like an HTTP status line).
  const events = client.beta.messages.stream(params, { signal });
  const iterator = events[Symbol.asyncIterator]();
  let first: IteratorResult<Anthropic.Beta.BetaRawMessageStreamEvent>;
  try {
    first = await iterator.next();
  } catch (err) {
    return errorResponse(err);
  }
  const encoder = new TextEncoder();
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    encoder.encode(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let wrote = false;
      let stop: string | null = null;
      try {
        for (let r = first; !r.done; r = await iterator.next()) {
          const e = r.value;
          if (e.type === "content_block_delta" && e.delta.type === "text_delta" && e.delta.text) {
            wrote = true;
            controller.enqueue(chunk({ content: e.delta.text }));
          } else if (e.type === "message_delta") stop = e.delta.stop_reason ?? stop;
        }
        if (!wrote && stop === "refusal") controller.enqueue(chunk({ content: REFUSED }));
        controller.enqueue(chunk({}, finishReason(stop)));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        if (!signal.aborted) {
          const message = err instanceof Anthropic.APIError ? err.message : "the stream was interrupted";
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message } })}\n\n`));
        }
      }
      controller.close();
    },
    cancel() {
      events.abort();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** The chat models this key may use, newest first, with their context size. */
export async function anthropicModels(config: AiConfig): Promise<{ id: string; contextLength: number | null }[]> {
  const out: { id: string; contextLength: number | null }[] = [];
  for await (const m of anthropicClient(config).models.list({ limit: 100 })) {
    if (m.deprecated_at) continue;
    out.push({ id: m.id, contextLength: m.max_input_tokens ?? null });
  }
  return out;
}
