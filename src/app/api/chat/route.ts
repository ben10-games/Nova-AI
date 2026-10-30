import { ConfigError, getAiConfig, getRateLimitConfig, limits, type AiConfig } from "@/lib/config";
import { BodyTooLargeError, clientKey, checkClient, jsonError, readBodyText } from "@/lib/http";
import { chatCompletions, describeUpstreamError, redact, resolveModel, UpstreamError } from "@/lib/provider";
import { acquireSlot, checkRateLimit } from "@/lib/ratelimit";
import type { StreamEvent } from "@/lib/types";
import { fitToContext, validateChatBody } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NOT_CONFIGURED = "The AI service is not configured on the server. The site administrator needs to check the server logs.";

export async function POST(req: Request) {
  const denied = checkClient(req);
  if (denied) return denied;
  if (!req.headers.get("content-type")?.includes("application/json")) {
    return jsonError("Content-Type must be application/json.", 415);
  }

  let config: AiConfig;
  let rate: ReturnType<typeof getRateLimitConfig>;
  try {
    config = getAiConfig();
    rate = getRateLimitConfig();
  } catch (err) {
    console.error("[chat] configuration error:", err instanceof Error ? err.message : err);
    return jsonError(NOT_CONFIGURED, 503);
  }

  const client = clientKey(req, rate.trustProxy);
  const limited = checkRateLimit(`chat:${client}`, rate.max, rate.windowMs);
  if (!limited.ok) {
    return jsonError(
      `Too many messages. Please wait ${limited.retryAfterSeconds} seconds and try again.`,
      429,
      { "Retry-After": String(limited.retryAfterSeconds) },
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(await readBodyText(req, limits.maxBodyBytes));
  } catch (err) {
    if (err instanceof BodyTooLargeError) return jsonError("Request body is too large.", 413);
    return jsonError("Request body is not valid JSON.", 400);
  }

  const validation = validateChatBody(body);
  if (!validation.ok) return jsonError(validation.error, 400);
  const { options } = validation;

  let model;
  try {
    model = await resolveModel(options.model);
  } catch (err) {
    if (err instanceof UpstreamError) return jsonError(err.message, err.status);
    if (err instanceof ConfigError) {
      console.error("[chat] configuration error:", err.message);
      return jsonError(NOT_CONFIGURED, 503);
    }
    console.error("[chat] model lookup failed", err);
    return jsonError(`Unexpected error while contacting ${config.providerName}.`, 500);
  }

  // Server-side ceiling on reply length, regardless of what the browser asks for.
  const maxTokens =
    config.maxOutputTokens !== null
      ? Math.min(options.maxTokens ?? config.maxOutputTokens, config.maxOutputTokens)
      : options.maxTokens;

  const systemPrompt = options.systemPrompt ?? config.systemPrompt;
  const history = fitToContext(validation.messages, systemPrompt, model.contextLength, maxTokens);
  if (!history) {
    return jsonError(
      `Your message is too long for the model's context window (${model.contextLength?.toLocaleString("en-US")} tokens). Shorten it or attach a smaller file.`,
      413,
    );
  }

  const release = acquireSlot(`chat:${client}`, rate.concurrent);
  if (!release) {
    return jsonError("Another reply is still being generated. Wait for it to finish or stop it first.", 429, {
      "Retry-After": "5",
    });
  }

  // Abort upstream when the browser disconnects (Stop button) or the provider is too slow to respond.
  const upstreamAbort = new AbortController();
  const onClientAbort = () => upstreamAbort.abort();
  req.signal.addEventListener("abort", onClientAbort);
  const timeout = setTimeout(() => upstreamAbort.abort(), config.timeoutMs);
  const cleanup = () => {
    clearTimeout(timeout);
    req.signal.removeEventListener("abort", onClientAbort);
    release();
  };

  let upstream: Response;
  try {
    upstream = await chatCompletions(
      config,
      {
        model: model.id,
        messages: [
          { role: "system", content: systemPrompt },
          // A message with a picture becomes text + image parts (for models that can see).
          ...history.map((m) =>
            m.images?.length
              ? { role: m.role, content: [{ type: "text", text: m.content }, ...m.images.map((url) => ({ type: "image_url", image_url: { url } }))] }
              : { role: m.role, content: m.content },
          ),
        ],
        stream: true,
        temperature: options.temperature,
        top_p: options.topP,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
      },
      upstreamAbort.signal,
    );
  } catch {
    cleanup();
    if (req.signal.aborted) return new Response(null, { status: 499 });
    if (upstreamAbort.signal.aborted) {
      return jsonError(`${config.providerName} took too long to respond. Please try again.`, 504);
    }
    return jsonError(
      config.kind === "lmstudio"
        ? "Cannot reach LM Studio. Make sure its local server is running."
        : `Cannot reach ${config.providerName}. Please try again in a moment.`,
      503,
    );
  }
  // Headers received: the timeout only guards the wait for the first response.
  clearTimeout(timeout);

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    cleanup();
    const err = describeUpstreamError(config, upstream.status, text);
    return jsonError(err.message, err.status);
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: StreamEvent) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      send({ type: "meta", model: model.id });

      let buffer = "";
      let finishReason: string | null = null;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") continue;
            let chunk: {
              error?: string | { message?: string };
              choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
            };
            try {
              chunk = JSON.parse(data);
            } catch {
              continue;
            }
            if (chunk.error) {
              const msg = typeof chunk.error === "string" ? chunk.error : (chunk.error.message ?? "Unknown error");
              console.error("[chat] provider stream error:", redact(msg));
              send({ type: "error", message: `${config.providerName} error: ${redact(msg).slice(0, 300)}` });
              continue;
            }
            const choice = chunk.choices?.[0];
            if (choice?.delta?.content) send({ type: "delta", text: choice.delta.content });
            if (choice?.finish_reason) finishReason = choice.finish_reason;
          }
        }
        send({ type: "done", finishReason });
        controller.close();
      } catch (err) {
        if (req.signal.aborted) {
          controller.close();
          return;
        }
        console.error("[chat] stream interrupted", err);
        send({ type: "error", message: `The connection to ${config.providerName} was interrupted.` });
        controller.close();
      } finally {
        cleanup();
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
      upstreamAbort.abort();
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
