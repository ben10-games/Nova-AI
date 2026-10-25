import "server-only";
import { existsSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getBlenderConfig, getBrowserConfig, type TrustedMcpServer } from "../config";

/**
 * Server-side MCP client for trusted stdio servers (official SDK v1).
 * Only servers from TRUSTED_MCP_SERVERS can be started; their command and
 * script are fixed in code. The child process gets an EMPTY environment.
 */

/**
 * The SDK merges a default environment (HOME, PATH, USER, ...) into the child's env.
 * Overriding each default with "" means the server sees no values from this machine.
 */
const EMPTY_ENV: Record<string, string> = Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map((k) => [k, ""]));
/**
 * Windows: Node needs these system locations (not secrets) for sockets, randomness and temp files;
 * blanking them would break the servers there.
 */
const WINDOWS_SYSTEM_ENV = ["SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "TEMP", "TMP"];
function systemEnv(): Record<string, string> {
  if (process.platform !== "win32") return {};
  return Object.fromEntries(WINDOWS_SYSTEM_ENV.flatMap((k) => (process.env[k] ? [[k, process.env[k] as string]] : [])));
}

const DISCOVERY_CACHE_MS = 30_000;
const FAILURE_BACKOFF_MS = 10_000;
const MAX_PAGES = 5;

type Connection = { client: Client; closed: boolean };
type State = {
  connections: Map<string, Promise<Connection>>;
  tools: Map<string, { at: number; tools: Tool[] }>;
  failures: Map<string, { at: number; message: string }>;
};

// Survives Next.js dev hot reloads so we don't leak child processes.
const g = globalThis as { __novaMcp?: State };
const state: State = (g.__novaMcp ??= { connections: new Map(), tools: new Map(), failures: new Map() });

export class McpUnavailableError extends Error {}

/** The ONLY variables a server receives besides the blanked defaults. Fixed per server, in code. */
function serverEnv(server: TrustedMcpServer): Record<string, string> {
  if (server.id === "blender") {
    const { port, tokenFile } = getBlenderConfig();
    return { NOVA_BLENDER_PORT: String(port), NOVA_BLENDER_TOKEN_FILE: tokenFile };
  }
  if (server.id === "browser") {
    const b = getBrowserConfig();
    return { NOVA_BROWSER_PORT: String(b.port), NOVA_BROWSER_TOKEN_FILE: b.tokenFile, NOVA_BROWSER_EXTENSION_ID: b.extensionId, NOVA_BROWSER_SHOT_DIR: b.shotDir, NOVA_BROWSER_SEARCH_URL: b.searchUrl, ...siteSearchForTests() };
  }
  return {};
}

/** Automated tests only (NOVA_ENABLE_TEST_FIXTURES=true): site searches go to a local page. */
function siteSearchForTests(): Record<string, string> {
  const base = process.env.NOVA_BROWSER_SITE_SEARCH_BASE ?? "";
  return process.env.NOVA_ENABLE_TEST_FIXTURES === "true" && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/[\w./-]*$/.test(base) ? { NOVA_BROWSER_SITE_SEARCH_BASE: base } : {};
}

function scriptPath(server: TrustedMcpServer): string {
  return path.join(/* turbopackIgnore: true */ process.cwd(), server.script);
}

async function connect(server: TrustedMcpServer, timeoutMs: number): Promise<Connection> {
  const script = scriptPath(server);
  if (!existsSync(script)) throw new McpUnavailableError(`the server program is missing (${server.script}).`);
  let extraEnv: Record<string, string>;
  try {
    extraEnv = serverEnv(server);
  } catch (err) {
    throw new McpUnavailableError(`configuration error: ${err instanceof Error ? err.message : String(err)}`);
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [script],
    cwd: path.dirname(script),
    env: { ...EMPTY_ENV, ...systemEnv(), ...extraEnv },
    stderr: "pipe",
  });
  // Keep the child's stderr out of our own output stream, but log a bounded amount for diagnosis.
  let logged = 0;
  transport.stderr?.on("data", (chunk: Buffer) => {
    if (logged > 4_000) return;
    logged += chunk.length;
    console.warn(`[mcp:${server.id}] ${chunk.toString("utf8").slice(0, 1_000).trimEnd()}`);
  });
  const client = new Client({ name: "nova-ai", version: "0.1.0" }, { capabilities: {} });
  const conn: Connection = { client, closed: false };
  client.onclose = () => {
    conn.closed = true;
    state.connections.delete(server.id);
    state.tools.delete(server.id);
  };
  try {
    await client.connect(transport, { timeout: timeoutMs });
  } catch (err) {
    await client.close().catch(() => {});
    throw new McpUnavailableError(`could not start or connect (${err instanceof Error ? err.message.slice(0, 200) : "unknown error"}).`);
  }
  return conn;
}

async function getConnection(server: TrustedMcpServer, timeoutMs: number): Promise<Connection> {
  const existing = state.connections.get(server.id);
  if (existing) {
    const conn = await existing.catch(() => null);
    if (conn && !conn.closed) return conn;
    state.connections.delete(server.id);
  }
  const failure = state.failures.get(server.id);
  if (failure && Date.now() - failure.at < FAILURE_BACKOFF_MS) throw new McpUnavailableError(failure.message);
  const pending = connect(server, timeoutMs);
  state.connections.set(server.id, pending);
  try {
    const conn = await pending;
    state.failures.delete(server.id);
    return conn;
  } catch (err) {
    state.connections.delete(server.id);
    state.failures.set(server.id, { at: Date.now(), message: (err as Error).message });
    throw err;
  }
}

/** Lists the server's tools (cached briefly). */
export async function discoverTools(server: TrustedMcpServer, timeoutMs: number): Promise<Tool[]> {
  const cached = state.tools.get(server.id);
  if (cached && Date.now() - cached.at < DISCOVERY_CACHE_MS) return cached.tools;
  const { client } = await getConnection(server, timeoutMs);
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.listTools(cursor ? { cursor } : {}, { timeout: timeoutMs });
    tools.push(...res.tools);
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  state.tools.set(server.id, { at: Date.now(), tools });
  return tools;
}

export type McpCallResult = Awaited<ReturnType<Client["callTool"]>>;

/** Calls one tool. Rejects on timeout, cancellation (signal), disconnects and protocol errors. */
export async function callTool(
  server: TrustedMcpServer,
  name: string,
  args: Record<string, unknown>,
  opts: { signal: AbortSignal; timeoutMs: number; connectTimeoutMs: number },
): Promise<McpCallResult> {
  const { client } = await getConnection(server, opts.connectTimeoutMs);
  return client.callTool({ name, arguments: args }, undefined, { signal: opts.signal, timeout: opts.timeoutMs });
}
