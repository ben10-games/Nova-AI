import "server-only";
import { DEFAULT_EXTENSION_ID } from "./extension-origin";

// Paths that work on Linux, macOS and Windows (no node: imports: this file is also bundled elsewhere).
const isWindowsPath = (p: string) => /^[A-Za-z]:[\\/]|^\\\\/.test(p);
const isAbsolutePath = (p: string) => p.startsWith("/") || isWindowsPath(p);
const homeDir = () => process.env.HOME || process.env.USERPROFILE || "";
const joinPath = (base: string, ...parts: string[]) => [base.replace(/[\\/]+$/, ""), ...parts].join(isWindowsPath(base) ? "\\" : "/");

/**
 * Server-side configuration. Everything here comes from environment variables
 * that are never prefixed with NEXT_PUBLIC_, so none of it reaches the browser.
 */

export type ProviderKind = "lmstudio" | "openai-compatible";

export type AiConfig = {
  kind: ProviderKind;
  /** Display name shown in the UI (never the URL). */
  providerName: string;
  /** OpenAI-compatible base URL, e.g. https://api.example.com/v1 */
  baseUrl: string;
  apiKey: string | null;
  /** Fixed model ID. When set, users cannot pick another model. */
  model: string | null;
  /** Optional allowlist of model IDs users may pick from. */
  allowedModels: string[] | null;
  systemPrompt: string;
  /** Context window to assume when the provider doesn't report one. */
  contextLength: number | null;
  /** Server-enforced ceiling on max_tokens per reply. */
  maxOutputTokens: number | null;
  /** Sent as reasoning_effort (e.g. "none" turns Gemini's slow thinking off); null = provider default. */
  reasoningEffort: string | null;
  /** Max time to wait for the provider to start responding. */
  timeoutMs: number;
};

export class ConfigError extends Error {}

const DEV_DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
const DEFAULT_SYSTEM_PROMPT =
  "You are Syntaz, a helpful, accurate and concise AI assistant. Use Markdown formatting where it helps readability, and fenced code blocks with a language tag for code.";

export const isProduction = process.env.NODE_ENV === "production";

/** First non-empty value among the given environment variables. */
function env(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

function positiveInt(name: string, fallback: number | null): number | null {
  const raw = env(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${name} must be a positive whole number.`);
  return n;
}

/** Loopback or private-network host (traffic does not cross the public internet). */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function reasoningEffort(): string | null {
  const v = env("AI_REASONING_EFFORT");
  if (v && !["none", "minimal", "low", "medium", "high"].includes(v)) throw new ConfigError('AI_REASONING_EFFORT must be "none", "minimal", "low", "medium" or "high".');
  return v;
}

export function getAiConfig(): AiConfig {
  const configuredUrl = env("AI_BASE_URL", "LMSTUDIO_BASE_URL");
  if (!configuredUrl && isProduction) {
    throw new ConfigError("AI_BASE_URL is not set. Configure the AI provider in the server environment.");
  }
  const rawUrl = configuredUrl ?? DEV_DEFAULT_BASE_URL;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigError("AI_BASE_URL is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError("AI_BASE_URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new ConfigError("Do not put credentials in AI_BASE_URL; use AI_API_KEY instead.");
  }

  const apiKey = env("AI_API_KEY");
  if (
    apiKey &&
    url.protocol === "http:" &&
    !isPrivateHost(url.hostname) &&
    process.env.AI_ALLOW_INSECURE_HTTP !== "true"
  ) {
    throw new ConfigError("Refusing to send AI_API_KEY over unencrypted http to a public host. Use an https AI_BASE_URL.");
  }

  const explicitKind = env("AI_PROVIDER");
  if (explicitKind && explicitKind !== "lmstudio" && explicitKind !== "openai-compatible") {
    throw new ConfigError('AI_PROVIDER must be "lmstudio" or "openai-compatible".');
  }
  const kind: ProviderKind =
    (explicitKind as ProviderKind | null) ??
    (env("LMSTUDIO_BASE_URL") || !configuredUrl ? "lmstudio" : "openai-compatible");

  const allowed = env("AI_MODELS")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    kind,
    providerName: env("AI_PROVIDER_NAME") ?? (kind === "lmstudio" ? "LM Studio" : "AI provider"),
    baseUrl: url.toString().replace(/\/+$/, ""),
    apiKey,
    model: env("AI_MODEL", "LMSTUDIO_MODEL"),
    allowedModels: allowed && allowed.length > 0 ? allowed : null,
    systemPrompt: env("AI_SYSTEM_PROMPT", "NOVA_SYSTEM_PROMPT") ?? DEFAULT_SYSTEM_PROMPT,
    contextLength: positiveInt("AI_CONTEXT_LENGTH", null),
    maxOutputTokens: positiveInt("AI_MAX_OUTPUT_TOKENS", null),
    reasoningEffort: reasoningEffort(),
    timeoutMs: positiveInt("AI_TIMEOUT_MS", 120_000)!,
  };
}

export function getRateLimitConfig() {
  return {
    /** Chat requests allowed per client per window. 0 disables the limit. */
    max: positiveIntOrZero("RATE_LIMIT_MAX", 20),
    windowMs: positiveInt("RATE_LIMIT_WINDOW_MS", 60_000)!,
    /** Simultaneous streaming replies per client. 0 disables the limit. */
    concurrent: positiveIntOrZero("RATE_LIMIT_CONCURRENT", 2),
    /** Trust X-Forwarded-For / X-Real-IP (only behind a reverse proxy you control). */
    trustProxy: process.env.TRUST_PROXY === "true",
  };
}

function positiveIntOrZero(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`${name} must be a whole number (0 disables it).`);
  return n;
}

export type AgentConfig = {
  enabled: boolean;
  /** How the model chooses tools: JSON-schema structured output, or OpenAI-native tool calls. */
  mode: "json" | "native";
  maxSteps: number;
  approvalTimeoutMs: number;
  toolTimeoutMs: number;
  /** Workspace directory (absolute, or relative to the server's working directory), or null when not configured. */
  workspaceDir: string | null;
  allowWrites: boolean;
};

export function getAgentConfig(): AgentConfig {
  const mode = env("AI_AGENT_MODE") ?? "json";
  if (mode !== "json" && mode !== "native") throw new ConfigError('AI_AGENT_MODE must be "json" or "native".');
  const dir = env("WORKSPACE_DIR");
  return {
    enabled: process.env.NOVA_ACTIONS_ENABLED !== "false",
    mode,
    maxSteps: Math.min(positiveInt("AGENT_MAX_STEPS", 8)!, 25),
    approvalTimeoutMs: positiveInt("AGENT_APPROVAL_TIMEOUT_MS", 10 * 60_000)!,
    toolTimeoutMs: positiveInt("AGENT_TOOL_TIMEOUT_MS", 60_000)!,
    workspaceDir: dir,
    allowWrites: process.env.WORKSPACE_ALLOW_WRITES === "true",
  };
}

/**
 * MCP servers Syntaz may start. The command and script for each server are fixed
 * here in source code and reviewed; configuration can only ENABLE a listed ID.
 * Nothing from users, the model or environment variables can supply a command or URL.
 */
export type TrustedMcpServer = {
  id: string;
  label: string;
  /** Script path relative to the app root, run with the same Node.js binary as the server. */
  script: string;
  /** Only available when NOVA_ENABLE_TEST_FIXTURES=true (automated tests). */
  testOnly?: boolean;
  /** Tools Syntaz itself classifies as read-only: they run without approval. Everything else needs approval. */
  readOnlyTools?: string[];
  /** Per-call timeout for this server (overrides MCP_TOOL_TIMEOUT_MS). */
  toolTimeoutMs?: number;
  /** Stop the whole task when one of this server's tools fails (e.g. a browser step). */
  haltOnFailure?: boolean;
  /** Error codes ("[code]" at the end of a failure) after which the task may continue with a different step. */
  recoverableErrors?: string[];
  /** Argument meaning "the user explicitly confirmed this consequential action" (asked for with a warning card). */
  confirmArg?: string;
  /** Tools whose identical repeats are legitimate (state changes or live reads); not refused as duplicates. */
  repeatableTools?: string[];
  /** Per tool: groups of arguments of which at least one must be given (checked before approval). */
  requireOneOf?: Record<string, string[][]>;
  /** Per tool: a tool of the same server that checks the call before approval (and describes it on the approval card). */
  precheckTools?: Record<string, string>;
  /** Tools Syntaz uses itself (e.g. those checks); never offered to the model. */
  internalTools?: string[];
  /** Tools whose real outcome (first line of the result) is shown under the final answer. */
  reportTools?: string[];
};

export const TRUSTED_MCP_SERVERS: TrustedMcpServer[] = [
  { id: "nova-test", label: "Syntaz test server", script: "mcp-servers/nova-test-server.mjs" },
  {
    id: "blender",
    label: "Blender (Syntaz bridge)",
    script: "mcp-servers/nova-blender-server.mjs",
    readOnlyTools: ["scene_info", "object_info"],
  },
  {
    id: "browser",
    label: "Chrome (Syntaz Browser Bridge)",
    script: "mcp-servers/nova-browser-server.mjs",
    readOnlyTools: ["browser_status", "list_tabs", "get_page", "list_elements", "read_field", "scroll", "look_at_page", "video_transcript"],
    haltOnFailure: true,
    // Failures that changed nothing in the page and that the next step can fix (e.g. list the elements again).
    recoverableErrors: [
      "stale_snapshot",
      "stale_element",
      "unknown_snapshot",
      "unknown_element",
      "needs_list",
      "needs_element",
      "not_visible",
      "ambiguous_field",
      "no_matching_field",
      "not_a_field",
      "wrong_tool",
      "latex_delimiters",
      "wrong_format",
      "invalid_arguments",
      "ambiguous_element",
      "no_matching_element",
      "no_such_option",
      "not_a_select",
    ],
    reportTools: ["type_text", "fill_field", "click", "select_option", "press_key"],
    requireOneOf: { click: [["element_id", "target"]] },
    confirmArg: "confirm_consequential",
    repeatableTools: ["scroll", "list_elements", "get_page", "read_field", "browser_status", "list_tabs", "look_at_page", "video_transcript"],
    precheckTools: { click: "check_action", type_text: "check_action", fill_field: "check_action", select_option: "check_action" },
    internalTools: ["check_action"],
  },
  { id: "nova-faults", label: "Fault-injection test server", script: "test/fixtures/mcp-fault-server.mjs", testOnly: true },
  { id: "nova-missing", label: "Missing test server", script: "test/fixtures/does-not-exist.mjs", testOnly: true },
];

export type McpConfig = {
  servers: TrustedMcpServer[];
  /** IDs in MCP_SERVERS that are not trusted servers (ignored). */
  ignored: string[];
  toolTimeoutMs: number;
  connectTimeoutMs: number;
};

export function getMcpConfig(): McpConfig {
  const requested = (env("MCP_SERVERS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fixtures = process.env.NOVA_ENABLE_TEST_FIXTURES === "true";
  const servers: TrustedMcpServer[] = [];
  const ignored: string[] = [];
  for (const id of [...new Set(requested)]) {
    const server = TRUSTED_MCP_SERVERS.find((s) => s.id === id && (!s.testOnly || fixtures));
    if (!server) ignored.push(id);
    else if (server.id === "blender") servers.push({ ...server, toolTimeoutMs: positiveInt("MCP_BLENDER_TOOL_TIMEOUT_MS", 300_000)! });
    else servers.push(server);
  }
  return {
    servers,
    ignored,
    toolTimeoutMs: positiveInt("MCP_TOOL_TIMEOUT_MS", 20_000)!,
    connectTimeoutMs: positiveInt("MCP_CONNECT_TIMEOUT_MS", 10_000)!,
  };
}

/** The Syntaz Browser Bridge extension's fixed id (from the public key in chrome-extension/manifest.json). */
export const BROWSER_EXTENSION_ID = DEFAULT_EXTENSION_ID;

/** Where the browser MCP server listens for the extension (always 127.0.0.1) and keeps its pairing token. */
export function getBrowserConfig(): { port: number; tokenFile: string; extensionId: string; shotDir: string; searchUrl: string } {
  const port = positiveInt("NOVA_BROWSER_PORT", 9895)!;
  if (port < 1024 || port > 65535) throw new ConfigError("NOVA_BROWSER_PORT must be between 1024 and 65535.");
  // Works on Linux, macOS and Windows (C:\Users\<name>\.config\nova-browser\token).
  const home = homeDir();
  const tokenFile = env("NOVA_BROWSER_TOKEN_FILE") ?? (home ? joinPath(home, ".config", "nova-browser", "token") : "");
  if (!isAbsolutePath(tokenFile)) throw new ConfigError("NOVA_BROWSER_TOKEN_FILE must be an absolute path.");
  const extensionId = env("NOVA_BROWSER_EXTENSION_ID") ?? BROWSER_EXTENSION_ID;
  if (!/^[a-p]{32}$/.test(extensionId)) throw new ConfigError("NOVA_BROWSER_EXTENSION_ID is not a valid Chrome extension id.");
  const shotDir = joinPath(process.env.TMPDIR || process.env.TEMP || process.env.TMP || "/tmp", "nova-browser-shots");
  // The search page Syntaz's search_web tool opens; the query is URL-encoded and appended.
  const searchUrl = env("NOVA_BROWSER_SEARCH_URL") ?? "https://html.duckduckgo.com/html/?q=";
  let parsed: URL;
  try {
    parsed = new URL(searchUrl);
  } catch {
    throw new ConfigError("NOVA_BROWSER_SEARCH_URL is not a valid URL.");
  }
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) throw new ConfigError("NOVA_BROWSER_SEARCH_URL must use https.");
  if (parsed.username || parsed.password) throw new ConfigError("NOVA_BROWSER_SEARCH_URL must not contain credentials.");
  return { port, tokenFile, extensionId, shotDir, searchUrl };
}

/** Where the Blender MCP server finds the Syntaz Blender Bridge (always on 127.0.0.1). */
export function getBlenderConfig(): { port: number; tokenFile: string } {
  const port = positiveInt("NOVA_BLENDER_PORT", 9890)!;
  if (port < 1024 || port > 65535) throw new ConfigError("NOVA_BLENDER_PORT must be between 1024 and 65535.");
  const home = homeDir();
  const tokenFile = env("NOVA_BLENDER_TOKEN_FILE") ?? (home ? joinPath(home, ".config", "nova-blender", "token") : "");
  if (tokenFile && !isAbsolutePath(tokenFile)) throw new ConfigError("NOVA_BLENDER_TOKEN_FILE must be an absolute path.");
  return { port, tokenFile };
}

export const limits = {
  maxMessages: 200,
  /** Per message, including attached file contents. */
  maxMessageChars: 120_000,
  maxTotalChars: 400_000,
  maxSystemPromptChars: 4_000,
  maxBodyBytes: 1024 * 1024,
};

/** Configuration problems worth logging once at startup. Never includes secret values. */
export function configWarnings(): string[] {
  const warnings: string[] = [];
  try {
    const ai = getAiConfig();
    const host = new URL(ai.baseUrl).hostname;
    if (isProduction && isPrivateHost(host)) {
      warnings.push(`AI_BASE_URL points to a local/private address (${host}). That only works if the AI server runs on the same machine or network as this app.`);
    }
    if (ai.kind === "openai-compatible" && !ai.model && !ai.allowedModels) {
      warnings.push("Neither AI_MODEL nor AI_MODELS is set; the first model reported by the provider will be used and users can pick any listed model.");
    }
    if (ai.kind === "openai-compatible" && !ai.maxOutputTokens) {
      warnings.push("AI_MAX_OUTPUT_TOKENS is not set; replies are only limited by the provider.");
    }
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : String(err));
  }
  try {
    const rl = getRateLimitConfig();
    if (isProduction && !rl.trustProxy) {
      warnings.push("TRUST_PROXY is not \"true\"; all visitors share one rate-limit bucket. Set TRUST_PROXY=true when running behind a reverse proxy or hosting platform.");
    }
    if (rl.max === 0) warnings.push("Rate limiting is disabled (RATE_LIMIT_MAX=0).");
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : String(err));
  }
  try {
    const agent = getAgentConfig();
    if (agent.enabled && agent.workspaceDir && isProduction) {
      warnings.push("WORKSPACE_DIR is set in production: Syntaz Actions can read files on the SERVER's disk inside that folder. Only point it at data every user of this site may see.");
    }
    if (agent.allowWrites) warnings.push("WORKSPACE_ALLOW_WRITES=true: the create_file tool is enabled (each write still needs explicit approval in the UI).");
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : String(err));
  }
  try {
    const mcp = getMcpConfig();
    if (mcp.ignored.length) {
      warnings.push(`MCP_SERVERS contains IDs that are not trusted servers and were ignored: ${mcp.ignored.join(", ")}. Trusted IDs are defined in src/lib/config.ts.`);
    }
    if (mcp.servers.length) warnings.push(`MCP enabled for: ${mcp.servers.map((s) => s.id).join(", ")} (every MCP tool call needs approval in the UI).`);
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : String(err));
  }
  if (isProduction && !process.env.BASIC_AUTH_USER) {
    warnings.push("No access protection (BASIC_AUTH_USER/BASIC_AUTH_PASSWORD) is configured; anyone who can reach this site can use your AI provider.");
  }
  return warnings;
}
