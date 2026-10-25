import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@/lib/agent-types";
import { runAgent } from "@/lib/agent/runner";
import { registerRun, unregisterRun, waitForApproval } from "@/lib/agent/runs";
import { buildRegistry } from "@/lib/agent/tools";
import { getAgentConfig, getAiConfig, getRateLimitConfig } from "@/lib/config";
import { BodyTooLargeError, clientKey, checkClient, jsonError, readBodyText } from "@/lib/http";
import { resolveModel, UpstreamError } from "@/lib/provider";
import { acquireSlot, checkRateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_GOAL_CHARS = 4_000;

/** Starts a Nova Actions run and streams its progress as NDJSON events. */
export async function POST(req: Request) {
  const denied = checkClient(req);
  if (denied) return denied;
  if (!req.headers.get("content-type")?.includes("application/json")) return jsonError("Content-Type must be application/json.", 415);

  let ai, agent, rate;
  try {
    ai = getAiConfig();
    agent = getAgentConfig();
    rate = getRateLimitConfig();
  } catch (err) {
    console.error("[agent] configuration error:", err instanceof Error ? err.message : err);
    return jsonError("The AI service is not configured on the server.", 503);
  }
  if (!agent.enabled) return jsonError("Nova Actions is disabled on this server.", 404);

  const client = clientKey(req, rate.trustProxy);
  const limited = checkRateLimit(`chat:${client}`, rate.max, rate.windowMs);
  if (!limited.ok) {
    return jsonError(`Too many requests. Please wait ${limited.retryAfterSeconds} seconds and try again.`, 429, { "Retry-After": String(limited.retryAfterSeconds) });
  }

  let body: { goal?: unknown; model?: unknown; expectTools?: unknown; focus?: unknown; handsOff?: unknown };
  try {
    body = JSON.parse(await readBodyText(req, 64 * 1024));
  } catch (err) {
    if (err instanceof BodyTooLargeError) return jsonError("Request body is too large.", 413);
    return jsonError("Request body is not valid JSON.", 400);
  }
  if (!body || typeof body !== "object") return jsonError("Request body must be a JSON object.", 400);
  if (typeof body.goal !== "string" || !body.goal.trim()) return jsonError("Describe the goal for Nova Actions.", 400);
  if (body.goal.length > MAX_GOAL_CHARS) return jsonError(`The goal is too long (max ${MAX_GOAL_CHARS} characters).`, 400);
  if (body.model !== undefined && body.model !== null && (typeof body.model !== "string" || body.model.length > 256)) {
    return jsonError("Invalid model ID.", 400);
  }

  let model;
  try {
    model = await resolveModel((body.model as string | null | undefined) || null);
  } catch (err) {
    if (err instanceof UpstreamError) return jsonError(err.message, err.status);
    console.error("[agent] model lookup failed", err);
    return jsonError(`Unexpected error while contacting ${ai.providerName}.`, 500);
  }

  const release = acquireSlot(`chat:${client}`, rate.concurrent);
  if (!release) return jsonError("Another task or reply is still running. Wait for it to finish or stop it first.", 429, { "Retry-After": "5" });

  const registry = await buildRegistry(agent);
  const runId = randomUUID();
  registerRun(runId, client);
  const controller = new AbortController();
  const onClientAbort = () => controller.abort();
  req.signal.addEventListener("abort", onClientAbort);
  const goal = body.goal.trim();

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(stream) {
      let open = true;
      const emit = (event: AgentEvent) => {
        if (!open) return;
        try {
          stream.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          open = false;
        }
      };
      try {
        await runAgent({
          ai,
          agent,
          model,
          registry,
          goal,
          runId,
          expectTools: body.expectTools === true,
          focus: body.focus === "browser" ? "browser" : undefined,
          handsOff: body.focus === "browser" && body.handsOff === true,
          signal: controller.signal,
          emit,
          requestApproval: (callId) => waitForApproval(runId, callId, agent.approvalTimeoutMs, controller.signal),
        });
      } finally {
        open = false;
        unregisterRun(runId);
        req.signal.removeEventListener("abort", onClientAbort);
        release();
        try {
          stream.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      controller.abort();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" },
  });
}
