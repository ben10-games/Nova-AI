import { buildRegistry, summarize } from "@/lib/agent/tools";
import { ConfigError, getAgentConfig, getAiConfig, getBrowserConfig, getMcpConfig, getRateLimitConfig } from "@/lib/config";
import { checkClient, clientKey, jsonError } from "@/lib/http";
import { listModels, resolveModel, UpstreamError } from "@/lib/provider";
import { checkRateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Reports whether the AI provider is reachable and which models can be used.
 * Never exposes the provider URL or API key.
 */
export async function GET(req: Request) {
  const denied = checkClient(req);
  if (denied) return denied;
  let config;
  try {
    config = getAiConfig();
    const rate = getRateLimitConfig();
    const limited = checkRateLimit(`status:${clientKey(req, rate.trustProxy)}`, 120, 60_000);
    if (!limited.ok) return jsonError("Too many requests.", 429, { "Retry-After": String(limited.retryAfterSeconds) });
  } catch (err) {
    console.error("[status] configuration error:", err instanceof Error ? err.message : err);
    return jsonError("The AI service is not configured on the server.", 503);
  }

  const provider = { name: config.providerName, kind: config.kind };
  try {
    // Uses the short model-list cache so polling clients can't hammer the provider.
    const models = await listModels();
    let active: Awaited<ReturnType<typeof resolveModel>> | null = null;
    let warning: string | null = null;
    try {
      active = await resolveModel(null);
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      warning = err.message;
    }
    return Response.json(
      {
        online: true,
        provider,
        model: active?.id ?? null,
        contextLength: active?.contextLength ?? null,
        models,
        modelLocked: config.model !== null,
        warning,
        actions: await actionsStatus(),
        browser: browserStatus(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof UpstreamError) return jsonError(err.message, err.status === 404 ? 502 : err.status);
    if (err instanceof ConfigError) {
      console.error("[status] configuration error:", err.message);
      return jsonError("The AI service is not configured on the server.", 503);
    }
    console.error("[status]", err);
    return jsonError(`Unexpected error while contacting ${config.providerName}.`, 500);
  }
}

/** Which Syntaz Actions tools are available. Never includes the workspace path. */
/** For the side panel: the site the search_web tool opens (so the user can allow Syntaz to read it). */
function browserStatus() {
  try {
    if (!getMcpConfig().servers.some((s) => s.id === "browser")) return null;
    return { searchOrigin: new URL(getBrowserConfig().searchUrl).origin };
  } catch {
    return null;
  }
}

async function actionsStatus() {
  const agent = getAgentConfig();
  if (!agent.enabled) return { enabled: false, workspace: false, writes: false, tools: [], notes: [] };
  const registry = await buildRegistry(agent);
  return {
    enabled: true,
    workspace: registry.workspace !== null,
    writes: registry.tools.has("create_file"),
    tools: summarize(registry),
    notes: registry.notes,
  };
}
