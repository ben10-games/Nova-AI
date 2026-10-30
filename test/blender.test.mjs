// Blender MCP integration tests. The production build talks to the REAL
// nova-blender MCP server (stdio), which talks to either:
//  - a mock Syntaz Blender Bridge (Node TCP server speaking the same protocol), or
//  - a real headless Blender running blender-addon/nova_blender_bridge.py,
//    when NOVA_TEST_BLENDER_BIN points to a Blender executable (optional).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { freePort, json, root, startApp } from "./helpers.mjs";
import { MOCK_KEY, startMockProvider } from "./mock-provider.mjs";

const TOKEN = "a".repeat(64);
const B = (tool) => `mcp__blender__${tool}`;
const step = (tool, args) => ({ json: { thought: `use ${tool}`, step: 1, action: "call_tool", tool, arguments: args, answer: "" } });
const finish = (answer = "Done.") => ({ json: { thought: "finished", step: 1, action: "finish", tool: "none", arguments: {}, answer } });
const PLAN = { json: { steps: ["Use Blender", "Answer"] } };

let mock, bridge, app, notRunning, noToken, badPort, tmp;

/** Mock bridge: records received commands; special object names trigger failures. */
function startMockBridge() {
  const seen = { commands: [], closedEarly: 0 };
  const server = net.createServer((socket) => {
    let buffer = "";
    let answered = false;
    socket.on("close", () => {
      if (!answered) seen.closedEarly++;
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      const msg = JSON.parse(buffer.slice(0, nl));
      const reply = (payload) => {
        answered = true;
        socket.end(JSON.stringify({ id: msg.id, ...payload }) + "\n");
      };
      if (msg.token !== TOKEN) return reply({ ok: false, error: "authentication failed" });
      seen.commands.push({ command: msg.command, params: msg.params });
      const name = msg.params?.name;
      if (name === "SLOW") return setTimeout(() => !socket.destroyed && reply({ ok: true, result: { slow: true } }), 10_000);
      if (name === "CRASH") return socket.destroy();
      if (name === "MALFORMED") {
        answered = true;
        return socket.end("this is not json\n");
      }
      if (msg.command === "scene_info") return reply({ ok: true, result: { scene: "Scene", objects: [{ name: "Cube", type: "MESH" }, { name: "Camera", type: "CAMERA" }] } });
      if (name === "Missing") return reply({ ok: false, error: "no object named 'Missing'. Objects: Cube, Camera" });
      reply({ ok: true, result: { command: msg.command, received: msg.params } });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, port: server.address().port })));
}

async function run(target, goal, { onApproval = () => true, abortOn = () => false } = {}) {
  const controller = new AbortController();
  const res = await fetch(target.base + "/api/agent", { method: "POST", headers: json, body: JSON.stringify({ goal }), signal: controller.signal });
  assert.equal(res.status, 200);
  const events = [];
  let runId = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const e = JSON.parse(line);
        events.push(e);
        if (e.type === "run_started") runId = e.runId;
        if (e.type === "approval_required") {
          const decision = await onApproval(e);
          if (decision !== null && decision !== undefined) {
            await fetch(target.base + "/api/agent/approve", { method: "POST", headers: json, body: JSON.stringify({ runId, callId: e.callId, approved: decision }) });
          }
        }
        if (await abortOn(e)) {
          controller.abort();
          return { events };
        }
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) throw err;
  }
  return { events };
}

const of = (events, type) => events.filter((e) => e.type === type);
const resultsFor = (events, tool) => {
  const ids = of(events, "tool_call").filter((c) => c.tool === tool).map((c) => c.callId);
  return of(events, "tool_result").filter((r) => ids.includes(r.callId));
};
const status = async (target) => (await (await fetch(target.base + "/api/status")).json()).actions;

const common = (mockUrl) => ({
  AI_BASE_URL: mockUrl,
  AI_API_KEY: MOCK_KEY,
  AI_PROVIDER: "openai-compatible",
  AI_PROVIDER_NAME: "Mock AI",
  AI_MODEL: "mock-chat-large",
  AI_MODELS: "",
  LMSTUDIO_BASE_URL: "",
  LMSTUDIO_MODEL: "",
  RATE_LIMIT_MAX: "1000",
  RATE_LIMIT_CONCURRENT: "1",
  BASIC_AUTH_USER: "",
  BASIC_AUTH_PASSWORD: "",
  NOVA_ACTIONS_ENABLED: "true",
  WORKSPACE_DIR: "",
  AGENT_APPROVAL_TIMEOUT_MS: "5000",
});

before(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "nova-blender-test-"));
  writeFileSync(path.join(tmp, "token"), TOKEN);
  mock = await startMockProvider();
  bridge = await startMockBridge();
  const unusedPort = await freePort();
  [app, notRunning, noToken, badPort] = await Promise.all([
    startApp({ ...common(mock.url), MCP_SERVERS: "blender", NOVA_BLENDER_PORT: String(bridge.port), NOVA_BLENDER_TOKEN_FILE: path.join(tmp, "token"), MCP_BLENDER_TOOL_TIMEOUT_MS: "2000" }),
    startApp({ ...common(mock.url), MCP_SERVERS: "blender", NOVA_BLENDER_PORT: String(unusedPort), NOVA_BLENDER_TOKEN_FILE: path.join(tmp, "token") }),
    startApp({ ...common(mock.url), MCP_SERVERS: "blender", NOVA_BLENDER_PORT: String(bridge.port), NOVA_BLENDER_TOKEN_FILE: path.join(tmp, "no-such-token") }),
    startApp({ ...common(mock.url), MCP_SERVERS: "blender", NOVA_BLENDER_PORT: "80", NOVA_BLENDER_TOKEN_FILE: path.join(tmp, "token") }),
  ]);
});

after(() => {
  for (const a of [app, notRunning, noToken, badPort]) a?.child?.kill();
  bridge?.server.close();
  mock?.server.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("Blender MCP: discovery and policy", () => {
  test("fixed tool set; only inspection is read-only, everything else needs approval", async () => {
    const tools = (await status(app)).tools.filter((t) => t.name.startsWith("mcp__blender__"));
    const byName = Object.fromEntries(tools.map((t) => [t.name.replace("mcp__blender__", ""), t.risk]));
    assert.deepEqual(byName, {
      add_camera: "external",
      add_light: "external",
      create_primitive: "external",
      delete_object: "external",
      object_info: "read",
      render_image: "external",
      scene_info: "read",
      set_active_camera: "external",
      set_material: "external",
      transform_object: "external",
    });
    assert.ok(!tools.some((t) => /exec|python|code|shell/i.test(t.name)), "no code-execution tool may exist");
  });

  test("only the servers named in MCP_SERVERS are enabled", async () => {
    // MCP_SERVERS=blender enables Blender and nothing else (nova-test is off).
    const names = (await status(app)).tools.map((t) => t.name);
    assert.ok(names.some((n) => n.startsWith("mcp__blender__")));
    assert.ok(!names.some((n) => n.startsWith("mcp__") && !n.startsWith("mcp__blender__")));
  });

  test("scene inspection runs without approval and reaches the bridge with the token", async () => {
    await mock.script([PLAN, step(B("scene_info"), {}), finish()]);
    const before = bridge.seen.commands.length;
    const { events } = await run(app, "What is in the scene?", { onApproval: () => assert.fail("inspection must not need approval") });
    const [r] = resultsFor(events, B("scene_info"));
    assert.equal(r.ok, true);
    assert.match(r.output, /"Cube"/);
    assert.deepEqual(bridge.seen.commands.slice(before), [{ command: "scene_info", params: {} }]);
  });

  test("a scene change needs approval; denial means the bridge never receives it", async () => {
    await mock.script([PLAN, step(B("create_primitive"), { kind: "cube", name: "Box", location: [1, 2, 3] }), finish()]);
    const before = bridge.seen.commands.length;
    let preview = "";
    const { events } = await run(app, "Add a box", { onApproval: (e) => ((preview = e.preview), false) });
    assert.match(preview, /create_primitive[\s\S]*"kind": "cube"[\s\S]*"location": \[\s*1,\s*2,\s*3\s*\]/);
    assert.equal(resultsFor(events, B("create_primitive"))[0].executed, false);
    assert.equal(bridge.seen.commands.length, before, "denied command reached Blender");
  });

  test("approved changes reach the bridge with exactly the approved arguments", async () => {
    const args = { kind: "uv_sphere", name: "Ball", location: [0, 0, 2], scale: [1, 1, 1.5] };
    await mock.script([PLAN, step(B("create_primitive"), args), step(B("set_material"), { object: "Ball", base_color: [1, 0, 0, 1], metallic: 0.8 }), finish()]);
    const before = bridge.seen.commands.length;
    let approvals = 0;
    const { events } = await run(app, "Red ball", { onApproval: () => (approvals++, true) });
    assert.equal(approvals, 2);
    assert.deepEqual(bridge.seen.commands.slice(before), [
      { command: "create_primitive", params: args },
      { command: "set_material", params: { object: "Ball", base_color: [1, 0, 0, 1], metallic: 0.8 } },
    ]);
    assert.ok(resultsFor(events, B("set_material"))[0].ok);
  });
});

describe("Blender MCP: argument validation", () => {
  test("bad vectors, enums and extra keys are rejected before approval", async () => {
    await mock.script([
      PLAN,
      step(B("create_primitive"), { kind: "cube", location: [1, 2] }),
      step(B("create_primitive"), { kind: "cube", location: [1, "2", 3] }),
      step(B("create_primitive"), { kind: "teapot" }),
      step(B("create_primitive"), { kind: "cube", code: "import os" }),
      step(B("set_material"), { object: "Cube", base_color: [2, 0, 0, 1] }),
      step(B("render_image"), { filename: "x.png", resolution_x: 8000 }),
      finish(),
    ]);
    const before = bridge.seen.commands.length;
    const { events } = await run(app, "Bad", { onApproval: () => assert.fail("must not ask") });
    const results = of(events, "tool_result");
    assert.equal(results.length, 6);
    for (const r of results) {
      assert.equal(r.executed, false);
      assert.match(r.output, /Invalid arguments/);
    }
    assert.equal(bridge.seen.commands.length, before);
  });

  test("a path-like render filename is rejected by the MCP server even after approval", async () => {
    await mock.script([PLAN, step(B("render_image"), { filename: "../../home/x.png" }), finish()]);
    const before = bridge.seen.commands.length;
    const { events } = await run(app, "Render", { onApproval: () => true });
    const [r] = resultsFor(events, B("render_image"));
    assert.equal(r.ok, false);
    assert.match(r.output, /filename|Invalid|validation/i);
    assert.equal(bridge.seen.commands.length, before, "a traversal filename must never reach Blender");
  });

  test("code-execution tools don't exist, whatever the model asks for", async () => {
    await mock.script([PLAN, step(B("execute_python"), { code: "import os" }), step(B("execute_code"), { code: "1" }), finish()]);
    const { events } = await run(app, "Run code", { onApproval: () => assert.fail("must not ask") });
    for (const r of of(events, "tool_result")) {
      assert.equal(r.executed, false);
      assert.match(r.output, /Unknown tool/);
    }
  });
});

describe("Blender MCP: failures are reported honestly", () => {
  test("Blender not running (nothing listening)", async () => {
    await mock.script([PLAN, step(B("scene_info"), {}), finish()]);
    const { events } = await run(notRunning, "Scene?");
    const [r] = resultsFor(events, B("scene_info"));
    assert.equal(r.ok, false);
    assert.match(r.output, /Blender is not connected/);
    // Tools are still listed so the user can see Blender is configured.
    assert.ok((await status(notRunning)).tools.some((t) => t.name === B("scene_info")));
  });

  test("bridge not started (no token file)", async () => {
    await mock.script([PLAN, step(B("scene_info"), {}), finish()]);
    const { events } = await run(noToken, "Scene?");
    assert.match(resultsFor(events, B("scene_info"))[0].output, /Blender is not connected/);
  });

  test("wrong token is reported, not retried silently", async () => {
    writeFileSync(path.join(tmp, "token"), "b".repeat(64));
    try {
      await mock.script([PLAN, step(B("scene_info"), {}), finish()]);
      const { events } = await run(app, "Scene?");
      assert.match(resultsFor(events, B("scene_info"))[0].output, /rejected Syntaz's token/);
    } finally {
      writeFileSync(path.join(tmp, "token"), TOKEN);
    }
  });

  test("invalid port configuration is reported as a configuration error", async () => {
    const notes = (await status(badPort)).notes.join(" ");
    assert.match(notes, /MCP server "blender" is unavailable: configuration error: NOVA_BLENDER_PORT must be between 1024 and 65535/);
  });

  test("an unknown object is a clear error from Blender", async () => {
    await mock.script([PLAN, step(B("object_info"), { name: "Missing" }), finish()]);
    const { events } = await run(app, "Info");
    assert.match(resultsFor(events, B("object_info"))[0].output, /Blender: no object named 'Missing'/);
  });

  test("timeout: a call that takes too long fails and closes the connection", async () => {
    await mock.script([PLAN, step(B("object_info"), { name: "SLOW" }), finish()]);
    const before = bridge.seen.closedEarly;
    const { events } = await run(app, "Slow");
    const [r] = resultsFor(events, B("object_info"));
    assert.equal(r.ok, false);
    assert.match(r.output, /did not finish within 2 seconds/);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(bridge.seen.closedEarly, before + 1);
  });

  test("cancellation closes the bridge connection and reports nothing as done", async () => {
    await mock.script([PLAN, step(B("transform_object"), { name: "SLOW", location: [0, 0, 1] }), finish()]);
    const before = bridge.seen.closedEarly;
    const { events } = await run(app, "Move", {
      onApproval: () => true,
      abortOn: async (e) => e.type === "approval_resolved" && (await new Promise((r) => setTimeout(r, 300)), true),
    });
    assert.equal(resultsFor(events, B("transform_object")).length, 0);
    await new Promise((res) => setTimeout(res, 800));
    assert.equal(bridge.seen.closedEarly, before + 1);
  });

  test("a crashed connection and a malformed reply are failures, not successes", async () => {
    await mock.script([PLAN, step(B("object_info"), { name: "CRASH" }), step(B("object_info"), { name: "MALFORMED" }), finish()]);
    const { events } = await run(app, "Bad bridge");
    const [crash, malformed] = resultsFor(events, B("object_info"));
    assert.equal(crash.ok, false);
    assert.match(crash.output, /closed the connection/);
    assert.equal(malformed.ok, false);
    assert.match(malformed.output, /malformed/);
  });
});

// ---------------------------------------------------------------------------
// Optional: real Blender (set NOVA_TEST_BLENDER_BIN to a Blender executable).
// ---------------------------------------------------------------------------
const BLENDER = process.env.NOVA_TEST_BLENDER_BIN;
describe("Blender MCP: real headless Blender", { skip: !BLENDER || !existsSync(BLENDER) ? "set NOVA_TEST_BLENDER_BIN to run" : false }, () => {
  let blender, real, realTmp;
  const renderName = `nova-test-${process.pid}.png`;

  before(async () => {
    realTmp = mkdtempSync(path.join(os.tmpdir(), "nova-real-blender-"));
    const port = await freePort();
    const tokenFile = path.join(realTmp, "token");
    blender = spawn(BLENDER, ["--background", "--factory-startup", "--python", path.join(root, "test/fixtures/blender_headless.py"), "--", String(port), tokenFile], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("headless Blender did not start")), 120_000);
      blender.stdout.on("data", (d) => String(d).includes("NOVA_BRIDGE_READY") && (clearTimeout(t), resolve()));
      blender.on("exit", (code) => reject(new Error(`Blender exited (${code})`)));
    });
    real = await startApp({ ...common(mock.url), MCP_SERVERS: "blender", NOVA_BLENDER_PORT: String(port), NOVA_BLENDER_TOKEN_FILE: tokenFile });
  });

  after(() => {
    real?.child?.kill();
    blender?.kill();
    rmSync(path.join(os.tmpdir(), "nova-blender-renders", renderName), { force: true });
    if (realTmp) rmSync(realTmp, { recursive: true, force: true });
  });

  test("inspect, create, colour and render in a real Blender", async () => {
    await mock.script([
      PLAN,
      step(B("scene_info"), {}),
      step(B("create_primitive"), { kind: "cube", name: "NovaTestCube", location: [0, 0, 1] }),
      step(B("set_material"), { object: "NovaTestCube", base_color: [0.1, 0.4, 0.9, 1], roughness: 0.3 }),
      step(B("object_info"), { name: "NovaTestCube" }),
      step(B("render_image"), { filename: renderName, resolution_x: 64, resolution_y: 36, samples: 1 }),
      finish(),
    ]);
    const { events } = await run(real, "Build and render", { onApproval: () => true });
    assert.match(resultsFor(events, B("scene_info"))[0].output, /"Camera"[\s\S]*"Cube"|"Cube"[\s\S]*"Camera"/);
    assert.ok(resultsFor(events, B("create_primitive"))[0].ok);
    const info = JSON.parse(resultsFor(events, B("object_info"))[0].output);
    assert.deepEqual(info.location, [0, 0, 1]);
    assert.deepEqual(info.materials[0].base_color, [0.1, 0.4, 0.9, 1]);
    const render = resultsFor(events, B("render_image"))[0];
    assert.ok(render.ok, render.output);
    assert.ok(existsSync(JSON.parse(render.output).file));
  });
});
