import "server-only";
import { ErrorCode, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpConfig, TrustedMcpServer } from "../config";
import { redact } from "../provider";
import { ToolError, type ObjectSchema, type PropertySchema } from "../agent/schema";
import type { ToolDefinition } from "../agent/tools";
import { callTool, discoverTools, McpUnavailableError, type McpCallResult } from "./client";

/** Converts discovered MCP tools into Nova tools. Everything from the server is treated as untrusted input. */

const TOOL_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_TOOLS_PER_SERVER = 20;
const MAX_DESCRIPTION = 300;
const MAX_STRING_ARG = 10_000;
const MAX_OUTPUT = 8_000;

export const mcpToolName = (serverId: string, tool: string) => `mcp__${serverId}__${tool}`;

function clean(text: string | undefined, max: number): string {
  // Strip control characters so server text can't break prompts or the UI.
  return (text ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Accepts only flat object schemas with string / number / integer / boolean properties. */
export function convertSchema(input: Tool["inputSchema"]): { ok: true; schema: ObjectSchema } | { ok: false; reason: string } {
  if (!input || input.type !== "object") return { ok: false, reason: "input schema is not an object" };
  const props = (input.properties ?? {}) as Record<string, Record<string, unknown>>;
  const names = Object.keys(props);
  if (names.length > 20) return { ok: false, reason: "too many arguments" };
  const properties: Record<string, PropertySchema> = {};
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) return { ok: false, reason: `unsupported argument name "${clean(name, 40)}"` };
    const p = props[name] ?? {};
    const description = typeof p.description === "string" ? clean(p.description, 200) : undefined;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    switch (p.type) {
      case "string": {
        const values = Array.isArray(p.enum) ? p.enum : undefined;
        if (values && (values.length > 50 || !values.every((v) => typeof v === "string"))) return { ok: false, reason: `unsupported enum for "${name}"` };
        const maxLength = Math.min(num(p.maxLength) ?? MAX_STRING_ARG, MAX_STRING_ARG);
        properties[name] = { type: "string", description, maxLength, ...(values ? { enum: values as string[] } : {}) };
        break;
      }
      case "integer":
      case "number":
        properties[name] = { type: p.type, description, minimum: num(p.minimum), maximum: num(p.maximum) };
        break;
      case "boolean":
        properties[name] = { type: "boolean", description };
        break;
      case "array": {
        // Only short lists of numbers (e.g. [x, y, z]) are supported.
        const items = (p.items ?? {}) as Record<string, unknown>;
        const min = num(p.minItems);
        const max = num(p.maxItems);
        if (items.type !== "number" && items.type !== "integer") return { ok: false, reason: `argument "${name}" is a list of unsupported items` };
        if (min === undefined || max === undefined || min < 1 || max > 16 || min > max) return { ok: false, reason: `argument "${name}" is a list without a small fixed size` };
        properties[name] = { type: "array", description, items: { type: "number", minimum: num(items.minimum), maximum: num(items.maximum) }, minItems: min, maxItems: max };
        break;
      }
      default:
        return { ok: false, reason: `argument "${name}" has an unsupported type (${typeof p.type === "string" ? p.type : "none"})` };
    }
  }
  const required = Array.isArray(input.required) ? input.required.filter((r): r is string => typeof r === "string" && r in properties) : [];
  // Extra arguments are always rejected, whatever the server's schema allows.
  return { ok: true, schema: { type: "object", properties, required, additionalProperties: false } };
}

const MAX_IMAGE_BASE64 = 4_000_000; // ~3 MB

/** An image the model may be shown: JPEG/PNG, base64, of a bounded size. */
function usableImage(item: { type?: string; data?: unknown; mimeType?: unknown }): boolean {
  return (
    item?.type === "image" &&
    typeof item.data === "string" &&
    item.data.length <= MAX_IMAGE_BASE64 &&
    (item.mimeType === "image/jpeg" || item.mimeType === "image/png") &&
    /^[A-Za-z0-9+/=]+$/.test(item.data)
  );
}

/** Images in an MCP result, as data: URLs (anything not usable is dropped). */
function imagesOf(result: McpCallResult): string[] | undefined {
  const out: string[] = [];
  for (const item of (Array.isArray(result.content) ? result.content : []) as { type?: string; data?: unknown; mimeType?: unknown }[]) {
    if (usableImage(item)) out.push(`data:${item.mimeType};base64,${item.data}`);
  }
  return out.length ? out.slice(0, 2) : undefined;
}

/** Turns an MCP result into text for the model and UI. `isError` results become failures. */
export function resultToText(result: McpCallResult): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const parts: string[] = [];
  for (const item of content as { type?: string; text?: unknown; data?: unknown; mimeType?: unknown; uri?: unknown; resource?: { uri?: unknown } }[]) {
    if (item?.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if (item?.type === "image") parts.push(usableImage(item) ? "[image attached]" : "[image content omitted]");
    else if (item?.type === "audio") parts.push("[audio content omitted]");
    else if (item?.type === "resource" || item?.type === "resource_link") parts.push("[resource omitted]");
    else parts.push("[unsupported content omitted]");
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent, null, 2));
  let text = parts.join("\n").trim() || "(The tool returned no content.)";
  if (text.length > MAX_OUTPUT) text = `${text.slice(0, MAX_OUTPUT)}\n[… output cut here: ${text.length - MAX_OUTPUT} more characters not shown]`;
  return text;
}

function describeError(err: unknown, server: TrustedMcpServer, timeoutMs: number): string {
  if (err instanceof McpUnavailableError) return `MCP server "${server.id}" is unavailable: ${err.message}`;
  if (err instanceof McpError) {
    if (err.code === ErrorCode.RequestTimeout) return `The MCP tool did not finish within ${Math.round(timeoutMs / 1000)} seconds and was cancelled.`;
    if (err.code === ErrorCode.ConnectionClosed) return `MCP server "${server.id}" disconnected during the call. It will be restarted on the next use.`;
    // The SDK client validates results and rejects ones that break the MCP schema.
    if (/Invalid tools\/call result/i.test(err.message)) return `MCP server "${server.id}" returned a malformed result, so it was discarded.`;
    return `MCP server "${server.id}" returned an error: ${redact(clean(err.message, 300))}`;
  }
  if (err instanceof Error && (err.name === "ZodError" || /invalid_type|Expected/.test(err.message))) {
    return `MCP server "${server.id}" returned a malformed result, so it was discarded.`;
  }
  if (err instanceof Error && /not connected|closed/i.test(err.message)) return `MCP server "${server.id}" is not connected. It will be restarted on the next use.`;
  console.error(`[mcp:${server.id}] call failed`, err);
  return `The call to MCP server "${server.id}" failed.`;
}

function adapt(server: TrustedMcpServer, tool: Tool, config: McpConfig): ToolDefinition | { skipped: string } {
  if (!TOOL_NAME.test(tool.name)) return { skipped: `"${clean(tool.name, 40)}" (invalid name)` };
  const converted = convertSchema(tool.inputSchema);
  if (!converted.ok) return { skipped: `"${tool.name}" (${converted.reason})` };
  const description = clean(tool.description || tool.title, MAX_DESCRIPTION) || "No description provided.";
  // Only Nova's own code can mark a tool as safe to run without approval; server hints never do.
  const readOnly = server.readOnlyTools?.includes(tool.name) ?? false;
  const timeoutMs = server.toolTimeoutMs ?? config.toolTimeoutMs;
  const hints = tool.annotations
    ? [tool.annotations.readOnlyHint ? "read-only" : null, tool.annotations.destructiveHint ? "destructive" : null].filter(Boolean).join(", ")
    : "";
  return {
    name: mcpToolName(server.id, tool.name),
    description: `[MCP server ${server.id}] ${description}`,
    risk: readOnly ? "read" : "external",
    requiresApproval: !readOnly,
    haltOnFailure: server.haltOnFailure,
    recoverableErrors: server.recoverableErrors,
    repeatable: server.repeatableTools?.includes(tool.name) ?? false,
    confirmArg: server.confirmArg && converted.schema.properties[server.confirmArg] ? server.confirmArg : undefined,
    reportInFinal: server.reportTools?.includes(tool.name) ?? false,
    needsWorkspace: false,
    parameters: converted.schema,
    source: { kind: "mcp", server: server.id, serverLabel: server.label, tool: tool.name },
    precheck: async (args, ctx) => {
      // Calls that can't work are refused before the user is asked to approve anything.
      for (const group of server.requireOneOf?.[tool.name] ?? []) {
        if (!group.some((k) => args[k] !== undefined && args[k] !== "")) {
          throw new ToolError(`Not asked and not done: say which element to use (${group.join(" or ")}). [needs_element]`);
        }
      }
      // Ask the application first (e.g. the browser: does this element exist, what is it, is it allowed?).
      // A failed check refuses the call before the user is asked; a passed one describes it on the approval card.
      const checker = server.precheckTools?.[tool.name];
      let described = "";
      if (checker) {
        let result: McpCallResult;
        try {
          result = await callTool(server, checker, { tool: tool.name, ...args }, { signal: ctx.signal, timeoutMs, connectTimeoutMs: config.connectTimeoutMs });
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          throw new ToolError(`Not asked and not done: ${describeError(err, server, timeoutMs)}`);
        }
        const text = result && Array.isArray(result.content) ? resultToText(result) : "The check returned nothing.";
        if (!result || result.isError) throw new ToolError(`Not asked and not done: ${text}`);
        described = `Nova will: ${text.split("\n")[0].slice(0, 300)}\n\n`;
      }
      return (
        described +
        `Run MCP tool "${tool.name}" on server "${server.label}" (${server.id}) with these arguments:\n\n${JSON.stringify(args, null, 2)}` +
        (hints ? `\n\nServer-provided hint (not verified): ${hints}.` : "")
      );
    },
    run: async (args, ctx) => {
      let result: McpCallResult;
      try {
        result = await callTool(server, tool.name, args, { signal: ctx.signal, timeoutMs, connectTimeoutMs: config.connectTimeoutMs });
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        throw new ToolError(describeError(err, server, timeoutMs));
      }
      if (!result || !Array.isArray(result.content)) throw new ToolError(`MCP server "${server.id}" returned a malformed result, so it was discarded.`);
      const text = resultToText(result);
      if (result.isError) throw new ToolError(`MCP tool "${tool.name}" reported an error: ${text}`);
      return { output: text, images: imagesOf(result) };
    },
  };
}

/** Discovers and adapts tools from every enabled trusted server. Unavailable servers are reported, never fatal. */
export async function loadMcpTools(config: McpConfig): Promise<{ tools: ToolDefinition[]; notes: string[] }> {
  const tools: ToolDefinition[] = [];
  const notes: string[] = [];
  await Promise.all(
    config.servers.map(async (server) => {
      let discovered: Tool[];
      try {
        discovered = await discoverTools(server, config.connectTimeoutMs);
      } catch (err) {
        notes.push(describeError(err, server, config.connectTimeoutMs));
        return;
      }
      const skipped: string[] = [];
      let accepted = 0;
      for (const [i, tool] of discovered.entries()) {
        if (server.internalTools?.includes(tool.name)) continue; // used by Nova itself, never offered to the model
        if (accepted >= MAX_TOOLS_PER_SERVER) {
          skipped.push(`${discovered.length - i} more (limit ${MAX_TOOLS_PER_SERVER} tools per server)`);
          break;
        }
        const adapted = adapt(server, tool, config);
        if ("skipped" in adapted) skipped.push(adapted.skipped);
        else {
          tools.push(adapted);
          accepted++;
        }
      }
      if (skipped.length) notes.push(`MCP server "${server.id}": skipped unsupported tools: ${skipped.join("; ")}.`);
    }),
  );
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return { tools, notes };
}
