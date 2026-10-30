// blender_build_scene tests: the production build runs against a scripted mock
// model and a STATEFUL fake Blender bridge that tracks objects and reports real
// dimensions (primitive base size x scale), so verification is meaningful.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { json, startApp } from "./helpers.mjs";
import { MOCK_KEY, startMockProvider } from "./mock-provider.mjs";

const TOKEN = "c".repeat(64);
const BASE = { cube: [1, 1, 1], uv_sphere: [1, 1, 1], cylinder: [1, 1, 2], cone: [1, 1, 2], plane: [1, 1, 0] };
const CREATE_KEYS = ["kind", "name", "location", "rotation_deg", "scale", "size"];

let mock, fake, app, tmp;

/** Fake Blender: default scene (2 m Cube at the origin, Light, Camera) + fault injection by name. */
function startFakeBlender() {
  const state = { objects: new Map(), log: [] };
  const reset = () => {
    state.objects.clear();
    state.log = [];
    state.objects.set("Cube", { name: "Cube", type: "MESH", kind: "cube", location: [0, 0, 0], rotation_deg: [0, 0, 0], scale: [2, 2, 2], materials: [] });
    state.objects.set("Light", { name: "Light", type: "LIGHT", location: [4, 1, 6], rotation_deg: [0, 0, 0], scale: [1, 1, 1], materials: [] });
    state.objects.set("Camera", { name: "Camera", type: "CAMERA", location: [7, -7, 5], rotation_deg: [63, 0, 47], scale: [1, 1, 1], materials: [] });
  };
  reset();
  const summary = (o) => ({ name: o.name, type: o.type, location: o.location, rotation_deg: o.rotation_deg, scale: o.scale, materials: o.materials.map((m) => m.name) });
  const unique = (name) => {
    if (!state.objects.has(name)) return name;
    for (let i = 1; ; i++) if (!state.objects.has(`${name}.${String(i).padStart(3, "0")}`)) return `${name}.${String(i).padStart(3, "0")}`;
  };
  const handle = (command, p) => {
    switch (command) {
      case "scene_info":
        return { scene: "Scene", objects: [...state.objects.values()].map(summary) };
      case "object_info": {
        const o = state.objects.get(p.name);
        if (!o) throw new Error(`no object named '${p.name}'`);
        let dims = o.kind ? BASE[o.kind].map((b, i) => Math.round(b * o.scale[i] * 1e4) / 1e4) : [0, 0, 0];
        if (o.name.startsWith("Warp")) dims = dims.map((d) => d * 2); // simulate Blender disagreeing with the design
        return { ...summary(o), dimensions: dims, materials: o.materials };
      }
      case "create_primitive": {
        if (p.name === "FAILME") throw new Error("simulated Blender failure");
        const name = unique(p.name ?? p.kind);
        const o = { name, type: "MESH", kind: p.kind, location: p.location ?? [0, 0, 0], rotation_deg: p.rotation_deg ?? [0, 0, 0], scale: p.scale ?? [1, 1, 1], materials: [] };
        state.objects.set(name, o);
        return summary(o);
      }
      case "set_material": {
        const o = state.objects.get(p.object);
        if (!o) throw new Error(`no object named '${p.object}'`);
        o.materials = [{ name: p.material, base_color: p.base_color, metallic: p.metallic, roughness: p.roughness }];
        return { object: o.name, material: o.materials[0] };
      }
      case "add_light":
      case "add_camera": {
        const name = unique(p.name);
        const o = { name, type: command === "add_light" ? "LIGHT" : "CAMERA", location: p.location, rotation_deg: p.rotation_deg, scale: [1, 1, 1], materials: [], energy: p.energy };
        state.objects.set(name, o);
        return summary(o);
      }
      case "render_image":
        return { file: `/tmp/nova-blender-renders/${p.filename}`, resolution: [p.resolution_x, p.resolution_y] };
      default:
        throw new Error(`unknown command: ${command}`);
    }
  };
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      const msg = JSON.parse(buffer.slice(0, nl));
      let reply;
      if (msg.token !== TOKEN) reply = { id: msg.id, ok: false, error: "authentication failed" };
      else {
        state.log.push({ command: msg.command, params: msg.params });
        try {
          reply = { id: msg.id, ok: true, result: handle(msg.command, msg.params ?? {}) };
        } catch (err) {
          reply = { id: msg.id, ok: false, error: err.message };
        }
      }
      socket.end(JSON.stringify(reply) + "\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, reset, port: server.address().port })));
}

const step = (tool, args) => ({ json: { thought: `use ${tool}`, step: 1, action: "call_tool", tool, arguments: args, answer: "" } });
const finish = (answer = "Done.") => ({ json: { thought: "finished", step: 1, action: "finish", tool: "none", arguments: {}, answer } });
const PLAN = { json: { steps: ["Design and build the scene", "Answer"] } };
const BUILD = (brief = "A cozy living room with a sofa, coffee table and floor lamp", extra = {}) => step("blender_build_scene", { brief, ...extra });

function goodSpec(overrides = {}) {
  return {
    theme: "cozy living room",
    objects: [
      { id: "sofa", name: "Sofa", purpose: "main seating", shape: "box", size: [2, 0.9, 0.8], material: "fabric", relation: "anchor", reference: "", gap_m: 0, rotation_z_deg: 0 },
      { id: "coffee_table", name: "Coffee Table", purpose: "surface in front of the sofa", shape: "box", size: [1, 0.6, 0.45], material: "wood", relation: "in_front_of", reference: "sofa", gap_m: 0.4, rotation_z_deg: 0 },
      { id: "floor_lamp", name: "Floor Lamp", purpose: "reading light beside the sofa", shape: "cylinder", size: [0.3, 0.3, 1.6], material: "metal", relation: "right_of", reference: "sofa", gap_m: 0.3, rotation_z_deg: 0 },
      { id: "floor", name: "Wooden Floor", purpose: "ground the room stands on", shape: "box", size: [3, 3, 0.05], material: "wood", relation: "floor_under_all", reference: "", gap_m: 0, rotation_z_deg: 0 },
    ],
    materials: [
      { id: "fabric", name: "Fabric", color: [0.35, 0.4, 0.5], metallic: 0, roughness: 0.9 },
      { id: "wood", name: "Oak", color: [0.55, 0.38, 0.22], metallic: 0, roughness: 0.6 },
      { id: "metal", name: "Brushed Steel", color: [0.7, 0.7, 0.72], metallic: 0.9, roughness: 0.3 },
    ],
    lights: [
      { role: "key", energy: 99999, color: [1, 0.95, 0.9] },
      { role: "fill", energy: 5, color: [0.9, 0.95, 1] },
    ],
    camera: { view: "front_left", lens_mm: 35 },
    ...overrides,
  };
}

async function run(goal, { decide = () => true } = {}) {
  const res = await fetch(app.base + "/api/agent", { method: "POST", headers: json, body: JSON.stringify({ goal }) });
  assert.equal(res.status, 200);
  const events = [];
  let runId = null;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines.filter(Boolean)) {
      const e = JSON.parse(line);
      events.push(e);
      if (e.type === "run_started") runId = e.runId;
      if (e.type === "approval_required") {
        await fetch(app.base + "/api/agent/approve", { method: "POST", headers: json, body: JSON.stringify({ runId, callId: e.callId, approved: await decide(e) }) });
      }
    }
  }
  return events;
}

const of = (events, type) => events.filter((e) => e.type === type);
const buildResult = (events) => {
  const call = of(events, "tool_call").find((c) => c.tool === "blender_build_scene");
  return call && of(events, "tool_result").find((r) => r.callId === call.callId);
};
const writes = () => fake.state.log.filter((l) => !["scene_info", "object_info"].includes(l.command));
const created = () => fake.state.log.filter((l) => l.command === "create_primitive").map((l) => l.params);
const byName = (name) => created().find((p) => p.name === name);
/** Box of a created object from what was actually sent to Blender. */
const boxOf = (p) => {
  const dims = BASE[p.kind].map((b, i) => b * p.scale[i]);
  return { min: p.location.map((c, i) => c - dims[i] / 2), max: p.location.map((c, i) => c + dims[i] / 2) };
};
const intersect = (a, b) => [0, 1, 2].every((i) => Math.min(a.max[i], b.max[i]) - Math.max(a.min[i], b.min[i]) > 0.01);
const close = (a, b, tol = 0.002) => Math.abs(a - b) <= tol;

before(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "nova-scene-test-"));
  writeFileSync(path.join(tmp, "token"), TOKEN);
  mock = await startMockProvider();
  fake = await startFakeBlender();
  app = await startApp({
    AI_BASE_URL: mock.url,
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
    MCP_SERVERS: "blender",
    NOVA_BLENDER_PORT: String(fake.port),
    NOVA_BLENDER_TOKEN_FILE: path.join(tmp, "token"),
  });
});

after(() => {
  app?.child.kill();
  fake?.server.close();
  mock?.server.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("scene planning and layout", () => {
  test("a valid design is laid out coherently: grounded, related, non-overlapping, clear of existing objects", async () => {
    fake.reset();
    await mock.script([PLAN, BUILD(), { json: goodSpec() }, finish("Built.")]);
    let preview = "";
    const events = await run("Build a living room", { decide: (e) => ((preview = e.preview), true) });
    const r = buildResult(events);
    assert.equal(r.ok, true, r.output);
    assert.match(r.output, /as designed: 12 steps completed and verified/);

    const sofa = byName("Sofa");
    const table = byName("Coffee Table");
    const lamp = byName("Floor Lamp");
    const floor = byName("Wooden Floor");
    // Everything stands on the floor (z = height / 2); the floor slab's top is at z = 0.
    assert.ok(close(sofa.location[2], 0.4) && close(table.location[2], 0.225) && close(lamp.location[2], 0.8));
    assert.ok(close(floor.location[2], -0.025));
    // Relations: table in front (-Y) with a 0.4 m gap; lamp to the right (+X) with a 0.3 m gap.
    assert.ok(close(table.location[0], sofa.location[0]) && close(table.location[1], sofa.location[1] - 0.45 - 0.4 - 0.3));
    assert.ok(close(lamp.location[1], sofa.location[1]) && close(lamp.location[0], sofa.location[0] + 1 + 0.3 + 0.15));
    // Exact sizes via scale (cylinders are 2 m tall at scale 1).
    assert.deepEqual(sofa.scale, [2, 0.9, 0.8]);
    assert.deepEqual(lamp.scale, [0.3, 0.3, 0.8]);
    // The floor was enlarged to cover everything; nothing overlaps; the existing Cube is avoided.
    const furniture = [sofa, table, lamp].map(boxOf);
    const fb = boxOf(floor);
    for (const b of furniture) assert.ok(b.min[0] >= fb.min[0] && b.max[0] <= fb.max[0] && b.min[1] >= fb.min[1] && b.max[1] <= fb.max[1], "floor must extend under all furniture");
    for (let i = 0; i < furniture.length; i++) for (let j = i + 1; j < furniture.length; j++) assert.ok(!intersect(furniture[i], furniture[j]));
    const cube = { min: [-1, -1, -1], max: [1, 1, 1] };
    for (const p of [sofa, table, lamp, floor]) assert.ok(!intersect(boxOf(p).max[2] - boxOf(p).min[2] < 0.1 ? { ...boxOf(p), max: [boxOf(p).max[0], boxOf(p).max[1], 0.02] } : boxOf(p), cube), `${p.name} intersects the existing Cube`);
    assert.ok(!fake.state.log.some((l) => l.command === "delete_object"), "nothing may be deleted");
    // The approval card shows the design and the exact calls.
    assert.match(preview, /Sofa — main seating\. box 2 x 0\.9 x 0\.8 m/);
    assert.match(preview, /Moved the whole design by \[/);
    assert.match(preview, /Exact Blender calls, in order:\n1\. \[geometry\] create_primitive/);
  });

  test("calls follow dependency order and use only the real tools' arguments", async () => {
    fake.reset();
    await mock.script([PLAN, BUILD(), { json: goodSpec() }, finish()]);
    await run("Build a living room");
    const order = writes().map((w) => w.command);
    const last = (c) => order.lastIndexOf(c);
    const first = (c) => order.indexOf(c);
    assert.ok(last("create_primitive") < first("set_material"), "geometry before materials");
    assert.ok(last("set_material") < first("add_light"), "materials before lights");
    assert.ok(last("add_light") < first("add_camera"), "lights before camera");
    assert.ok(first("add_camera") < first("render_image"), "camera before render");
    // Verification reads happen after the render.
    const log = fake.state.log.map((l) => l.command);
    assert.ok(log.lastIndexOf("object_info") > log.indexOf("render_image"));
    for (const c of created()) assert.deepEqual(Object.keys(c).sort(), [...CREATE_KEYS].sort());
    for (const m of writes().filter((w) => w.command === "set_material")) assert.ok(["Sofa", "Coffee Table", "Floor Lamp", "Wooden Floor"].includes(m.params.object));
  });

  test("lights are aimed at the design with exposure set by Syntaz, not the model's watts", async () => {
    fake.reset();
    await mock.script([PLAN, BUILD(), { json: goodSpec() }, finish()]);
    await run("Build a living room");
    const lights = writes().filter((w) => w.command === "add_light").map((w) => w.params);
    const [key, fill] = lights;
    assert.equal(key.kind, "AREA");
    assert.ok(key.energy < 5000 && key.energy > 50, `key energy ${key.energy}`);
    assert.ok(close(fill.energy / key.energy, 0.35, 0.01));
    const camera = writes().find((w) => w.command === "add_camera").params;
    assert.ok(camera.rotation_deg[0] > 45 && camera.rotation_deg[0] < 90, "camera tilted down at the scene");
    assert.equal(camera.make_active, true);
  });

  test("the requested preview file name is used; an invalid one is refused before approval", async () => {
    fake.reset();
    await mock.script([PLAN, BUILD("A sofa scene", { preview_filename: "room.png" }), { json: goodSpec() }, finish()]);
    await run("Build and render room.png");
    assert.equal(writes().find((w) => w.command === "render_image").params.filename, "room.png");

    fake.reset();
    await mock.script([PLAN, BUILD("A sofa scene", { preview_filename: "../x.png" }), finish()]);
    const events = await run("Bad name", { decide: () => assert.fail("must not ask") });
    assert.equal(buildResult(events).executed, false);
    assert.equal(writes().length, 0);
  });
});

describe("design validation and repair", () => {
  test("problems go back to the model; the corrected design is built", async () => {
    fake.reset();
    const broken = goodSpec({
      objects: [
        { ...goodSpec().objects[0], relation: "in_front_of", reference: "ghost" },
        { ...goodSpec().objects[1], material: "marble" },
      ],
    });
    await mock.script([PLAN, BUILD(), { json: broken }, { json: goodSpec() }, finish()]);
    const events = await run("Build a living room");
    assert.equal(buildResult(events).ok, true);
    assert.ok(of(events, "notice").some((n) => /Design attempt 2 of 3: fixing \d+ problem/.test(n.message)));
    const repair = mock.seen.agentBodies.find((b) => b.response_format?.json_schema?.name === "scene_spec" && /previous spec/.test(b.messages.at(-1).content));
    assert.match(repair.messages.at(-1).content, /which is not an object id/);
    assert.match(repair.messages.at(-1).content, /material "marble", which is not defined/);
    assert.match(repair.messages.at(-1).content, /Exactly one object must have relation "anchor"/);
  });

  test("model formatting variants are normalized, with notes (0-255 colours, references by name, stray camera)", async () => {
    fake.reset();
    const spec = goodSpec();
    spec.materials[0].color = [90, 102, 128];
    spec.objects[1].reference = "Sofa"; // name instead of id
    spec.objects.push({ id: "camera", name: "Camera", purpose: "view", shape: "box", size: [0.1, 0.1, 0.1], material: "metal", relation: "behind", reference: "sofa", gap_m: 1, rotation_z_deg: 0 });
    let preview = "";
    await mock.script([PLAN, BUILD(), { json: spec }, finish()]);
    const events = await run("Build a living room", { decide: (e) => ((preview = e.preview), true) });
    assert.equal(buildResult(events).ok, true);
    assert.match(preview, /colour \[90,102,128\] read as 0-255/);
    assert.match(preview, /Removed "camera" from the objects/);
    assert.ok(!created().some((c) => c.name === "Camera"));
    assert.deepEqual(writes().find((w) => w.command === "set_material" && w.params.object === "Sofa").params.base_color, [0.353, 0.4, 0.502, 1]);
  });

  test("after 3 invalid designs nothing is built and the final answer can't claim success", async () => {
    fake.reset();
    const bad = { json: goodSpec({ objects: [] }) };
    await mock.script([PLAN, BUILD(), bad, bad, bad, finish("The living room was built successfully!")]);
    const events = await run("Build a living room", { decide: () => assert.fail("must not ask") });
    const r = buildResult(events);
    assert.equal(r.executed, false);
    assert.match(r.output, /could not produce a valid scene design after 3 attempts/);
    assert.equal(writes().length, 0, "no scene modification");
    const answer = of(events, "final")[0].answer;
    assert.match(answer, /Checked by Syntaz \(from the actual tool results\):\*\*\n- ✘ blender_build_scene: not run/);
  });

  test("an oversize object on top of a small one is rejected", async () => {
    fake.reset();
    const spec = goodSpec();
    spec.objects.push({ id: "tv", name: "Huge TV", purpose: "screen", shape: "box", size: [3, 1, 1], material: "metal", relation: "on_top_of", reference: "coffee_table", gap_m: 0, rotation_z_deg: 0 });
    await mock.script([PLAN, BUILD(), { json: spec }, { json: goodSpec() }, finish()]);
    const events = await run("Build a living room");
    assert.ok(of(events, "notice").some((n) => /too big to stand on "Coffee Table"/.test(n.message)));
    assert.equal(buildResult(events).ok, true);
  });
});

describe("execution reliability and honest reporting", () => {
  test("denying the plan means Blender is only inspected, never changed", async () => {
    fake.reset();
    await mock.script([PLAN, BUILD(), { json: goodSpec() }, finish()]);
    const events = await run("Build a living room", { decide: () => false });
    assert.equal(buildResult(events).executed, false);
    assert.deepEqual([...new Set(fake.state.log.map((l) => l.command))].sort(), ["object_info", "scene_info"]);
  });

  test("the scene builder runs once per task; a repeat call is refused", async () => {
    fake.reset();
    await mock.script([PLAN, BUILD(), { json: goodSpec() }, BUILD("again"), finish()]);
    let approvals = 0;
    const events = await run("Build twice", { decide: () => (approvals++, true) });
    const calls = of(events, "tool_call").filter((c) => c.tool === "blender_build_scene");
    assert.equal(calls.length, 2);
    const second = of(events, "tool_result").find((r) => r.callId === calls[1].callId);
    assert.equal(second.executed, false);
    assert.match(second.output, /already ran in this task/);
    assert.equal(approvals, 1);
    assert.equal(created().length, 4, "objects must not be created twice");
  });

  test("a failed operation skips its dependants and the build is reported as failed", async () => {
    fake.reset();
    const spec = goodSpec();
    spec.objects[2].name = "FAILME";
    await mock.script([PLAN, BUILD(), { json: spec }, finish("All done, everything worked.")]);
    const events = await run("Build a living room");
    const r = buildResult(events);
    assert.equal(r.ok, false);
    assert.equal(r.executed, true);
    assert.match(r.output, /FAILED:\n- FAILME: cylinder .*simulated Blender failure/);
    assert.match(r.output, /SKIPPED \(depends on a failed step\):\n- FAILME -> Brushed Steel \(its object was not created\)/);
    assert.ok(!writes().some((w) => w.command === "set_material" && w.params.object === "FAILME"));
    assert.ok(writes().some((w) => w.command === "render_image"), "independent phases still run");
    assert.match(of(events, "final")[0].answer, /- ✘ blender_build_scene: Built "cozy living room" with problems/);
  });

  test("verification compares the real scene with the design and reports differences", async () => {
    fake.reset();
    const spec = goodSpec();
    spec.objects[1].name = "Warp Table"; // the fake Blender reports doubled dimensions for this object
    await mock.script([PLAN, BUILD(), { json: spec }, finish("Perfect scene!")]);
    const events = await run("Build a living room");
    const r = buildResult(events);
    assert.equal(r.ok, false);
    assert.match(r.output, /DIFFERENCES from the design found when inspecting Blender:\n- Warp Table: size is \[2,1\.2,0\.9\] m, designed \[1,0\.6,0\.45\] m/);
    assert.match(r.output, /Visual check: Syntaz did not look at the render image/);
    assert.match(of(events, "final")[0].answer, /✘ blender_build_scene/);
  });

  test("invented arguments to the scene builder are rejected", async () => {
    fake.reset();
    await mock.script([PLAN, step("blender_build_scene", { brief: "room", code: "import os" }), finish()]);
    const events = await run("Build", { decide: () => assert.fail("must not ask") });
    assert.match(buildResult(events).output, /Invalid arguments: Unknown argument "code"/);
    assert.equal(fake.state.log.length, 0);
  });
});
