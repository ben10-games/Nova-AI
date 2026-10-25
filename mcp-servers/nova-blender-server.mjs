#!/usr/bin/env node
// Nova Blender MCP server (stdio). Forwards a FIXED set of typed tools to the
// Nova Blender Bridge add-on running inside Blender. It never sends code, only
// connects to 127.0.0.1, and authenticates with the token the add-on writes.
//
// Nova starts it with an empty environment plus exactly two variables:
//   NOVA_BLENDER_PORT        bridge port (default 9890)
//   NOVA_BLENDER_TOKEN_FILE  absolute path of the bridge's token file
import { readFileSync } from "node:fs";
import net from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const HOST = "127.0.0.1"; // fixed: never connect anywhere else
const port = Number(process.env.NOVA_BLENDER_PORT ?? 9890);
const tokenFile = process.env.NOVA_BLENDER_TOKEN_FILE ?? "";
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("NOVA_BLENDER_PORT is invalid");

const NOT_RUNNING =
  "Blender is not connected. Open Blender, enable the 'Nova Blender Bridge' add-on and press Start in the 3D View sidebar (Nova tab).";

class BridgeError extends Error {}

function readToken() {
  if (!tokenFile) throw new BridgeError("No bridge token file is configured.");
  try {
    const token = readFileSync(tokenFile, "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("bad format");
    return token;
  } catch {
    throw new BridgeError(NOT_RUNNING);
  }
}

let nextId = 1;

/** Sends one command to the bridge over a fresh localhost connection. */
function bridgeCall(command, params, { timeoutMs, signal }) {
  const token = readToken();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: HOST, port });
    let buffer = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      fn(value);
    };
    const onAbort = () => finish(reject, new BridgeError("Cancelled. Blender may still finish an operation it had already started."));
    const timer = setTimeout(() => finish(reject, new BridgeError(`Blender did not answer within ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
    signal?.addEventListener("abort", onAbort);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ id, token, command, params }) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 2_000_000) return finish(reject, new BridgeError("Blender sent an oversized response."));
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      let msg;
      try {
        msg = JSON.parse(buffer.slice(0, nl));
      } catch {
        return finish(reject, new BridgeError("Blender sent an unexpected (malformed) response."));
      }
      if (!msg || typeof msg !== "object" || typeof msg.ok !== "boolean" || (msg.id !== id && msg.id !== null)) {
        return finish(reject, new BridgeError("Blender sent an unexpected (malformed) response."));
      }
      if (!msg.ok) {
        const error = String(msg.error ?? "unknown error").slice(0, 500);
        return finish(reject, new BridgeError(error === "authentication failed" ? "Blender rejected Nova's token. Restart the bridge in Blender (Stop, then Start)." : `Blender: ${error}`));
      }
      finish(resolve, msg.result);
    });
    socket.on("error", (err) => finish(reject, new BridgeError(err.code === "ECONNREFUSED" ? NOT_RUNNING : `Connection to Blender failed (${err.code ?? "error"}).`)));
    socket.on("close", () => finish(reject, new BridgeError("Blender closed the connection before answering.")));
  });
}

const server = new McpServer({ name: "nova-blender", version: "0.1.0" });

const vec3 = (lo, hi) => z.array(z.number().min(lo).max(hi)).length(3);
const name = z.string().min(1).max(63);

function tool(toolName, description, inputSchema, { readOnly = false, timeoutMs = 20_000 } = {}) {
  server.registerTool(
    toolName,
    { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false } },
    async (args, extra) => {
      try {
        const result = await bridgeCall(toolName, args, { timeoutMs, signal: extra.signal });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const message = err instanceof BridgeError ? err.message : "The Blender call failed unexpectedly.";
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );
}

tool("scene_info", "List the current Blender scene: objects (name, type, location, rotation, scale, materials), active camera and render settings.", {}, { readOnly: true });
tool("object_info", "Details of one object: transform, dimensions, mesh size, materials, modifiers, light or camera settings.", { name: name.describe("Object name") }, { readOnly: true });
tool(
  "create_primitive",
  "Add a mesh primitive to the scene.",
  {
    kind: z.enum(["cube", "uv_sphere", "ico_sphere", "cylinder", "cone", "torus", "plane", "monkey"]).describe("Shape"),
    name: name.optional().describe("Optional object name"),
    location: vec3(-1e5, 1e5).optional().describe("[x, y, z] in metres"),
    rotation_deg: vec3(-36000, 36000).optional().describe("[x, y, z] rotation in degrees"),
    scale: vec3(1e-4, 1e4).optional().describe("[x, y, z] scale"),
    size: z.number().min(1e-4).max(1e4).optional().describe("Overall size in metres (default 2)"),
  },
);
tool(
  "transform_object",
  "Move, rotate or scale an existing object. Give at least one of location, rotation_deg, scale.",
  {
    name: name.describe("Object name"),
    location: vec3(-1e5, 1e5).optional().describe("[x, y, z] in metres"),
    rotation_deg: vec3(-36000, 36000).optional().describe("[x, y, z] rotation in degrees"),
    scale: vec3(1e-4, 1e4).optional().describe("[x, y, z] scale"),
  },
);
tool("delete_object", "Delete an object from the scene (can be undone in Blender with Ctrl+Z).", { name: name.describe("Object name") });
tool(
  "set_material",
  "Give an object a simple material (Principled BSDF): colour, metallic, roughness.",
  {
    object: name.describe("Object name"),
    material: name.optional().describe("Material name (created if missing)"),
    base_color: z.array(z.number().min(0).max(1)).length(4).optional().describe("[r, g, b, a], each 0-1"),
    metallic: z.number().min(0).max(1).optional(),
    roughness: z.number().min(0).max(1).optional(),
  },
);
tool(
  "add_light",
  "Add a light to the scene.",
  {
    kind: z.enum(["POINT", "SUN", "SPOT", "AREA"]).optional().describe("Light type (default POINT)"),
    name: name.optional(),
    location: vec3(-1e5, 1e5).optional().describe("[x, y, z] in metres"),
    rotation_deg: vec3(-36000, 36000).optional().describe("[x, y, z] rotation in degrees"),
    energy: z.number().min(0).max(1e6).optional().describe("Watts (or strength for SUN)"),
    color: z.array(z.number().min(0).max(1)).length(3).optional().describe("[r, g, b], each 0-1"),
  },
);
tool(
  "add_camera",
  "Add a camera and (by default) make it the active camera.",
  {
    name: name.optional(),
    location: vec3(-1e5, 1e5).optional().describe("[x, y, z] in metres"),
    rotation_deg: vec3(-36000, 36000).optional().describe("[x, y, z] rotation in degrees"),
    lens_mm: z.number().min(1).max(5000).optional().describe("Focal length in mm (default 50)"),
    make_active: z.boolean().optional(),
  },
);
tool("set_active_camera", "Make an existing camera the active scene camera.", { name: name.describe("Camera object name") });
tool(
  "render_image",
  "Render the active camera to a PNG in Blender's fixed Nova render folder (max 1920x1080, max 128 samples). Existing files are never overwritten.",
  {
    filename: z.string().regex(/^[A-Za-z0-9_-]{1,64}\.png$/).describe("File name only, e.g. preview.png"),
    resolution_x: z.number().int().min(16).max(1920).optional(),
    resolution_y: z.number().int().min(16).max(1080).optional(),
    samples: z.number().int().min(1).max(128).optional(),
  },
  { timeoutMs: 300_000 },
);

await server.connect(new StdioServerTransport());
