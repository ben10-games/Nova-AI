import "server-only";
import { getAiConfig, type AiConfig } from "./config";

export type ModelInfo = {
  id: string;
  type: "llm" | "vlm" | "unknown";
  /** Whether the provider reports the model as loaded (null if it can't tell). */
  loaded: boolean | null;
  /** Context window, if known. */
  contextLength: number | null;
};

/** An error whose message is safe to show to end users. */
export class UpstreamError extends Error {
  constructor(
    message: string,
    public status = 502,
  ) {
    super(message);
  }
}

/** Removes anything that looks like a credential from text that may be shown to users. */
export function redact(text: string): string {
  return text
    .replace(/\b(sk|pk|rk|key|api|token)[-_][A-Za-z0-9_\-*]{8,}/gi, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/https?:\/\/[^\s"')]+/gi, "[url]");
}

export function providerHeaders(config: AiConfig): Record<string, string> {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}

function unreachableMessage(config: AiConfig): string {
  return config.kind === "lmstudio"
    ? "Cannot reach LM Studio. Make sure LM Studio is open and its local server is started (Developer tab → Start Server)."
    : `Cannot reach ${config.providerName}. Please try again in a moment.`;
}

/**
 * Converts a provider HTTP error into a message that is safe for end users.
 * Full details are logged on the server only.
 */
export function describeUpstreamError(config: AiConfig, status: number, body: string): UpstreamError {
  let detail = "";
  try {
    const parsed = JSON.parse(body) as { error?: string | { message?: string } };
    detail = typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? "");
  } catch {
    detail = body;
  }
  detail = redact(detail).slice(0, 300);
  console.error(`[provider] HTTP ${status}: ${detail}`);

  const name = config.providerName;
  if (status === 401 || status === 403) {
    return new UpstreamError(`${name} rejected the server's credentials. The site administrator needs to check AI_API_KEY.`, 502);
  }
  if (status === 404) {
    return new UpstreamError(`${name} could not find the requested model or endpoint. The site administrator needs to check AI_MODEL and AI_BASE_URL.`, 502);
  }
  if (status === 429 && DAILY_QUOTA.test(body)) {
    return new UpstreamError(`The free daily limit of ${name} is used up. It resets tomorrow; until then use another API key or a local model.`, 503);
  }
  if (status === 429) return new UpstreamError(`${name} is rate limiting requests. Please wait a moment and try again.`, 503);
  if (status >= 500) return new UpstreamError(`${name} is having problems (HTTP ${status}). Please try again later.`, 502);
  // 400-range request errors (e.g. context length exceeded) are useful to the user.
  return new UpstreamError(`${name} error (HTTP ${status})${detail ? `: ${detail}` : "."}`, 502);
}

const DAILY_QUOTA = /per ?day|PerDay|daily (?:limit|quota)/i;

/**
 * How long to wait before retrying a rate-limited or overloaded request (free cloud tiers allow only a
 * few requests per minute), or null to give up: too many tries, a daily quota, or a wait over 65 s (per-minute limits never need longer).
 */
export function retryAfterMs(status: number, headers: Headers, body: string, attempt: number): number | null {
  if (attempt >= 3 || (status !== 429 && status !== 503) || DAILY_QUOTA.test(body)) return null;
  let ms = Number(headers.get("retry-after")) * 1000 || 0;
  const hinted = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body); // Google's hint
  if (hinted) ms = Math.max(ms, Number(hinted[1]) * 1000);
  if (!ms) ms = 4_000 * 2 ** attempt;
  return ms > 65_000 ? null : ms + 500;
}

/** fetch() to the provider that waits and tries again when it says "slow down" (see retryAfterMs). */
export async function fetchWithRetry(url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 && res.status !== 503) return res;
    const body = await res.text().catch(() => "");
    const wait = retryAfterMs(res.status, res.headers, body, attempt);
    if (wait === null) return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    console.warn(`[provider] HTTP ${res.status}: waiting ${Math.round(wait / 1000)} s before trying again`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, wait);
      init.signal.addEventListener("abort", () => (clearTimeout(timer), reject(init.signal.reason)), { once: true });
    });
  }
}

const CACHE_MS = 5_000;
let cache: { at: number; key: string; models: ModelInfo[] } | null = null;

async function fetchJson(config: AiConfig, url: string, timeoutMs = 8_000): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", headers: providerHeaders(config), signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new UpstreamError(unreachableMessage(config), 503);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = describeUpstreamError(config, res.status, body);
    if (res.status === 404) err.status = 404;
    throw err;
  }
  return res.json();
}

type V0Model = { id?: string; type?: string; state?: string; loaded_context_length?: number };

const NON_CHAT_MODEL = /embed|whisper|tts|dall-e|moderation|rerank|transcribe|image/i;

async function fetchModels(config: AiConfig): Promise<ModelInfo[]> {
  // LM Studio's native REST API reports type and load state.
  if (config.kind === "lmstudio") {
    try {
      const body = (await fetchJson(config, `${new URL(config.baseUrl).origin}/api/v0/models`)) as { data?: V0Model[] };
      if (Array.isArray(body.data)) {
        return body.data
          .filter((m): m is V0Model & { id: string } => !!m.id && (m.type === "llm" || m.type === "vlm"))
          .map((m) => ({
            id: m.id,
            type: m.type as "llm" | "vlm",
            loaded: m.state === "loaded",
            contextLength: m.state === "loaded" ? (m.loaded_context_length ?? null) : null,
          }));
      }
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 503) throw err;
      // Older LM Studio: fall through to the OpenAI-compatible endpoint.
    }
  }

  const body = (await fetchJson(config, `${config.baseUrl}/models`)) as { data?: { id?: string }[] };
  return (Array.isArray(body.data) ? body.data : [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && !NON_CHAT_MODEL.test(id))
    .map((id) => ({ id, type: "unknown" as const, loaded: null, contextLength: null }));
}

/** Lists chat models users may choose from (respecting AI_MODEL / AI_MODELS). */
export async function listModels(force = false): Promise<ModelInfo[]> {
  const config = getAiConfig();
  const key = `${config.baseUrl}|${config.kind}`;
  if (!force && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.models;

  let models: ModelInfo[];
  try {
    models = await fetchModels(config);
  } catch (err) {
    // Some providers don't implement /models; a fixed model still works.
    if (config.model && !(err instanceof UpstreamError && err.status === 503)) models = [];
    else throw err;
  }

  if (config.model) {
    const found = models.find((m) => m.id === config.model);
    models = [found ?? { id: config.model, type: "unknown", loaded: null, contextLength: null }];
  } else if (config.allowedModels) {
    const allowed = config.allowedModels;
    models = allowed.map(
      (id) => models.find((m) => m.id === id) ?? { id, type: "unknown" as const, loaded: null, contextLength: null },
    );
  }

  models = models.map((m) => ({ ...m, contextLength: m.contextLength ?? config.contextLength }));
  cache = { at: Date.now(), key, models };
  return models;
}

/**
 * Determines which model to use: AI_MODEL if set; otherwise the model requested
 * by the browser (must be in the allowed list); otherwise the model loaded in
 * LM Studio or the first available model. Never hardcodes a model name.
 */
export async function resolveModel(requested?: string | null): Promise<ModelInfo> {
  const config = getAiConfig();
  const models = await listModels();

  if (config.model) return models[0];

  if (requested) {
    const match = models.find((m) => m.id === requested);
    if (!match) {
      throw new UpstreamError(`The selected model "${requested}" is not available. Choose another model in Settings.`, 400);
    }
    return match;
  }

  const loaded = models.find((m) => m.loaded === true);
  if (loaded) return loaded;
  if (models.some((m) => m.loaded === false)) {
    throw new UpstreamError(
      "No chat model is loaded in LM Studio. Load a model (e.g. from the model picker at the top of LM Studio) and try again.",
      503,
    );
  }
  if (models[0]) return models[0];
  throw new UpstreamError(`${config.providerName} reports no chat models.`, 503);
}
