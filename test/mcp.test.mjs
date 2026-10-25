// MCP integration tests: the production build talks to REAL stdio MCP servers
// (the trusted nova-test server and a fault-injection fixture) while a scripted
// mock model chooses the tool calls. No real model or account is used.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { json, startApp } from "./helpers.mjs";
import { MOCK_KEY, startMockProvider } from "./mock-provider.mjs";

const OUTSIDE_SECRET = "TOP-SECRET-OUTSIDE-WORKSPACE";
let mock, m, onlyTrusted, noMcp, tmp, workspace;

const step = (tool, args) => ({ json: { thought: `use ${tool}`, step: 1, action: "call_tool", tool, arguments: args, answer: "" } });
const finish = (answer = "Done.") => ({ json: { thought: "finished", step: 1, action: "finish", tool: "none", arguments: {}, answer } });
const PLAN = { json: { steps: ["Use the tools", "Answer"] } };
const T = (tool) => `mcp__nova-test__${tool}`;
const F = (tool) => `mcp__nova-faults__${tool}`;

/** Runs a goal; `onApproval(event, runId)` returns true/false to decide or null to leave pending. */
async function run(app, goal, { onApproval = () => true, abortOn = () => false, headers = {} } = {}) {
  const controller = new AbortController();
  const res = await fetch(app.base + "/api/agent", { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify({ goal }), signal: controller.signal });
  assert.equal(res.status, 200, `agent request failed: ${res.status}`);
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
          const decision = await onApproval(e, runId);
          if (decision !== null && decision !== undefined) {
            const r = await fetch(app.base + "/api/agent/approve", { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify({ runId, callId: e.callId, approved: decision }) });
            assert.equal(r.status, 200);
          }
        }
        if (await abortOn(e)) {
          controller.abort();
          return { events, runId };
        }
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) throw err;
  }
  return { events, runId };
}

const of = (events, type) => events.filter((e) => e.type === type);
/** Tool results excluding the automatic workspace overview. */
const results = (events) => {
  const overview = of(events, "tool_call").find((c) => c.tool === "list_files" && c.arguments?.depth === 2 && c.arguments?.path === ".");
  return of(events, "tool_result").filter((r) => r.callId !== overview?.callId);
};
const resultFor = (events, tool) => {
  const call = of(events, "tool_call").find((c) => c.tool === tool);
  return call && of(events, "tool_result").find((r) => r.callId === call.callId);
};
const status = async (app) => (await (await fetch(app.base + "/api/status")).json()).actions;
const faultStats = async () => {
  await mock.script([PLAN, step(F("stats"), {}), finish()]);
  const { events } = await run(m, "stats");
  return JSON.parse(resultFor(events, F("stats")).output);
};

before(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "nova-mcp-test-"));
  workspace = path.join(tmp, "workspace");
  mkdirSync(path.join(workspace, "notes"), { recursive: true });
  writeFileSync(path.join(workspace, "notes", "plan.md"), "# Plan\nLaunch on 20 October.\n");
  writeFileSync(path.join(tmp, "outside.txt"), `${OUTSIDE_SECRET}\n`);
  mock = await startMockProvider();
  const common = {
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
    WORKSPACE_ALLOW_WRITES: "false",
  };
  [m, onlyTrusted, noMcp] = await Promise.all([
    startApp({
      ...common,
      WORKSPACE_DIR: workspace,
      MCP_SERVERS: "nova-test,nova-faults,nova-missing",
      NOVA_ENABLE_TEST_FIXTURES: "true",
      MCP_TOOL_TIMEOUT_MS: "2000",
      AGENT_APPROVAL_TIMEOUT_MS: "5000",
      TRUST_PROXY: "true",
    }),
    startApp({ ...common, WORKSPACE_DIR: "", MCP_SERVERS: "nova-test,nova-faults,evil-server", NOVA_ENABLE_TEST_FIXTURES: "false" }),
    startApp({ ...common, WORKSPACE_DIR: "", MCP_SERVERS: "" }),
  ]);
});

after(() => {
  for (const a of [m, onlyTrusted, noMcp]) a?.child.kill();
  mock?.server.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("discovery and configuration", () => {
  test("discovers tools from trusted servers, namespaced and approval-only", async () => {
    const actions = await status(m);
    const names = actions.tools.map((t) => t.name);
    for (const t of ["text_stats", "convert_temperature", "add_note", "list_notes"]) assert.ok(names.includes(T(t)), `${t} missing`);
    for (const t of ["echo", "slow", "read_file", "loose"]) assert.ok(names.includes(F(t)), `${t} missing`);
    for (const t of actions.tools.filter((x) => x.name.startsWith("mcp__"))) {
      assert.equal(t.risk, "external");
      assert.equal(t.source.kind, "mcp");
    }
    // The colliding tool is namespaced; the built-in read_file is still the built-in.
    assert.equal(actions.tools.find((t) => t.name === "read_file").risk, "read");
    assert.equal(actions.tools.find((t) => t.name === "read_file").source, undefined);
  });

  test("invalid names, unsupported schemas and tools over the limit are skipped and reported", async () => {
    const actions = await status(m);
    const names = actions.tools.map((t) => t.name);
    assert.ok(!names.some((n) => n.includes("bad name") || n === F("nested")));
    assert.equal(names.filter((n) => n.startsWith("mcp__nova-faults__")).length, 20);
    const note = actions.notes.find((n) => n.includes('"nova-faults": skipped'));
    assert.match(note, /"bad name!" \(invalid name\)/);
    assert.match(note, /"nested" \(argument "opts" has an unsupported type \(object\)\)/);
    assert.match(note, /3 more \(limit 20 tools per server\)/);
  });

  test("server descriptions are capped (untrusted text)", async () => {
    const long = (await status(m)).tools.find((t) => t.name === F("long_desc"));
    assert.ok(long.description.length <= 330, `description is ${long.description.length} chars`);
  });

  test("an unavailable server is reported and does not break other tools", async () => {
    const actions = await status(m);
    assert.ok(actions.notes.some((n) => /MCP server "nova-missing" is unavailable: the server program is missing/.test(n)));
    assert.ok(!actions.tools.some((t) => t.name.startsWith("mcp__nova-missing__")));
    assert.ok(actions.tools.some((t) => t.name === T("text_stats")));
  });

  test("only trusted IDs can be enabled; test-only and unknown IDs are ignored", async () => {
    const names = (await status(onlyTrusted)).tools.map((t) => t.name);
    assert.ok(names.includes(T("text_stats")));
    assert.ok(!names.some((n) => n.startsWith("mcp__nova-faults__") || n.includes("evil")));
    assert.match(onlyTrusted.logs(), /MCP_SERVERS contains IDs that are not trusted servers and were ignored: nova-faults, evil-server/);
  });

  test("without MCP_SERVERS there are no MCP tools", async () => {
    const names = (await status(noMcp)).tools.map((t) => t.name);
    assert.ok(!names.some((n) => n.startsWith("mcp__")));
  });
});

describe("calling MCP tools (real stdio connection)", () => {
  test("smoke test: text_stats runs on the real nova-test server after approval", async () => {
    await mock.script([PLAN, step(T("text_stats"), { text: "Hello MCP world. Second sentence!" }), finish()]);
    let preview = "";
    const { events } = await run(m, "Count words", { onApproval: (e) => ((preview = e.preview), true) });
    const call = of(events, "tool_call").find((c) => c.tool === T("text_stats"));
    assert.deepEqual(call.source, { kind: "mcp", server: "nova-test", serverLabel: "Nova test server", tool: "text_stats" });
    assert.equal(call.requiresApproval, true);
    assert.match(preview, /Run MCP tool "text_stats" on server "Nova test server" \(nova-test\)/);
    assert.match(preview, /"text": "Hello MCP world\. Second sentence!"/);
    const r = resultFor(events, T("text_stats"));
    assert.equal(r.executed, true);
    assert.equal(r.ok, true);
    assert.deepEqual(JSON.parse(r.output), { words: 5, characters: 33, lines: 1, sentences: 2 });
  });

  test("valid number and enum arguments", async () => {
    await mock.script([PLAN, step(T("convert_temperature"), { value: 100, from: "C", to: "F" }), finish()]);
    const { events } = await run(m, "Convert");
    assert.equal(resultFor(events, T("convert_temperature")).output, "100 °C = 212 °F");
  });

  test("invalid arguments are rejected before approval and never reach the server", async () => {
    await mock.script([
      PLAN,
      step(T("convert_temperature"), { value: 100, from: "C" }), // missing required
      step(T("convert_temperature"), { value: "hot", from: "C", to: "F" }), // wrong type
      step(T("convert_temperature"), { value: 1, from: "C", to: "X" }), // enum
      step(T("text_stats"), { text: "hi", sneaky: true }), // extra argument
      step(F("loose"), { x: "a", extra: "b" }), // server schema allows extras; Nova does not
      step(T("text_stats"), { text: "x".repeat(20_001) }), // over the server's maxLength
      finish(),
    ]);
    const { events } = await run(m, "Bad args", { onApproval: () => assert.fail("must not ask for approval") });
    const r = results(events);
    assert.equal(r.length, 6);
    for (const x of r) {
      assert.equal(x.executed, false);
      assert.match(x.output, /Invalid arguments/);
    }
    assert.equal(of(events, "approval_required").length, 0);
  });

  test("unknown, skipped and unavailable tool names are refused", async () => {
    await mock.script([
      PLAN,
      step(T("delete_everything"), {}),
      step(F("nested"), { opts: {} }),
      step("mcp__nova-missing__anything", {}),
      step("mcp__evil__run", {}),
      finish(),
    ]);
    const { events } = await run(m, "Unknown", { onApproval: () => assert.fail("must not ask for approval") });
    for (const x of results(events)) {
      assert.equal(x.executed, false);
      assert.match(x.output, /Unknown tool/);
    }
  });
});

describe("approval", () => {
  test("denied calls are not executed; each call needs its own approval", async () => {
    await mock.script([PLAN, step(T("add_note"), { text: "denied note" }), step(T("list_notes"), {}), finish()]);
    let asked = 0;
    const first = await run(m, "Deny then list", { onApproval: (e) => (asked++, e.tool === T("list_notes")) });
    assert.equal(asked, 2);
    assert.equal(resultFor(first.events, T("add_note")).executed, false);
    assert.match(resultFor(first.events, T("add_note")).output, /did not approve/);
    assert.doesNotMatch(resultFor(first.events, T("list_notes")).output, /denied note/);

    await mock.script([PLAN, step(T("add_note"), { text: "first" }), step(T("add_note"), { text: "second" }), finish()]);
    let approvals = 0;
    const second = await run(m, "Two notes", { onApproval: () => (approvals++, true) });
    assert.equal(approvals, 2, "an approval must not carry over to the next call");
    assert.equal(of(second.events, "tool_result").filter((r) => r.ok && /Saved note/.test(r.output)).length, 2);
  });

  test("a server's read-only hint does not skip approval", async () => {
    await mock.script([PLAN, step(F("echo"), { message: "hi" }), finish()]);
    let preview = "";
    const { events } = await run(m, "Echo", { onApproval: (e) => ((preview = e.preview), true) });
    assert.equal(of(events, "approval_required").length, 1);
    assert.match(preview, /Server-provided hint \(not verified\): read-only/);
    assert.equal(resultFor(events, F("echo")).output, "echo: hi");
  });

  test("another client cannot approve; unanswered approvals time out as denied", async () => {
    await mock.script([PLAN, step(T("add_note"), { text: "hijack" }), finish()]);
    let otherStatus;
    const { events } = await run(m, "Guarded", {
      headers: { "X-Forwarded-For": "198.51.100.10" },
      onApproval: async (e, runId) => {
        otherStatus = (
          await fetch(m.base + "/api/agent/approve", {
            method: "POST",
            headers: { ...json, "X-Forwarded-For": "203.0.113.99" },
            body: JSON.stringify({ runId, callId: e.callId, approved: true }),
          })
        ).status;
        return null; // the owner never answers
      },
    });
    assert.equal(otherStatus, 404);
    const resolved = of(events, "approval_resolved")[0];
    assert.equal(resolved.approved, false);
    assert.match(resolved.reason, /timed out/);
    assert.equal(resultFor(events, T("add_note")).executed, false);
  });
});

describe("timeouts, cancellation and failures", () => {
  test("a call that exceeds MCP_TOOL_TIMEOUT_MS fails cleanly and is cancelled on the server", async () => {
    const before = (await faultStats()).cancelled;
    await mock.script([PLAN, step(F("slow"), { seconds: 10 }), finish()]);
    const started = Date.now();
    const { events } = await run(m, "Slow");
    const r = resultFor(events, F("slow"));
    assert.equal(r.executed, true);
    assert.equal(r.ok, false);
    assert.match(r.output, /did not finish within 2 seconds/);
    assert.ok(Date.now() - started < 9_000);
    assert.equal((await faultStats()).cancelled, before + 1, "server did not receive the cancellation");
  });

  test("cancelling the task cancels the in-flight MCP call", async () => {
    const before = (await faultStats()).cancelled;
    await mock.script([PLAN, step(F("slow"), { seconds: 30 }), finish()]);
    const { events } = await run(m, "Cancel me", {
      abortOn: async (e) => {
        if (e.type !== "approval_resolved") return false;
        await new Promise((r) => setTimeout(r, 300));
        return true;
      },
    });
    assert.ok(!resultFor(events, F("slow")), "no result may be reported for a cancelled call");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await faultStats()).cancelled, before + 1);
  });

  const failures = [
    ["isError result", "fail", /reported an error: deliberate failure/],
    ["exception in the server", "throws", /returned an error/],
    ["malformed result", "malformed", /malformed result/],
  ];
  for (const [name, tool, pattern] of failures) {
    test(`${name} is reported as a failure, not a success`, async () => {
      await mock.script([PLAN, step(F(tool), {}), finish()]);
      const { events } = await run(m, name);
      const r = resultFor(events, F(tool));
      assert.equal(r.executed, true);
      assert.equal(r.ok, false);
      assert.match(r.output, pattern);
      assert.ok(!r.output.includes("sk-live-abcdef1234567890XYZ"), "secret-looking text was not redacted");
    });
  }

  test("huge and non-text results are capped / summarized", async () => {
    await mock.script([PLAN, step(F("huge"), {}), step(F("image"), {}), finish()]);
    const { events } = await run(m, "Big");
    const huge = resultFor(events, F("huge"));
    assert.ok(huge.ok && huge.output.length < 9_000);
    assert.match(huge.output, /output cut here: 192000 more characters not shown/);
    // A usable picture from a trusted tool is passed on (for models that can see), never inlined as text.
    assert.equal(resultFor(events, F("image")).output, "[image attached]");
    assert.deepEqual(resultFor(events, F("image")).images, ["data:image/png;base64,iVBORw0KGgo="]);
  });

  test("a crashed server is reported, then restarted on the next call", async () => {
    const pidBefore = (await faultStats()).pid;
    await mock.script([PLAN, step(F("crash"), {}), finish()]);
    const { events } = await run(m, "Crash");
    const r = resultFor(events, F("crash"));
    assert.equal(r.ok, false);
    assert.match(r.output, /disconnected|not connected/);
    const after = await faultStats();
    assert.notEqual(after.pid, pidBefore, "server was not restarted");
  });
});

describe("permission boundaries", () => {
  test("MCP servers receive an empty environment (no secrets or server config)", async () => {
    await mock.script([PLAN, step(F("env_probe"), {}), finish()]);
    const { events } = await run(m, "Env");
    const env = JSON.parse(resultFor(events, F("env_probe")).output);
    for (const [key, value] of Object.entries(env)) {
      assert.ok(["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"].includes(key), `unexpected variable ${key}`);
      assert.equal(value, "", `${key} is not empty`);
    }
    const all = JSON.stringify(env);
    for (const leak of [MOCK_KEY, "AI_API_KEY", "AI_BASE_URL", "WORKSPACE_DIR", "MCP_SERVERS", workspace]) assert.ok(!all.includes(leak), `${leak} leaked`);
  });

  test("built-in file tools keep their sandbox and need no MCP approval", async () => {
    await mock.script([PLAN, step("read_file", { path: "notes/plan.md" }), step("read_file", { path: "../outside.txt" }), step(F("read_file"), { path: "../outside.txt" }), finish()]);
    const asked = [];
    const { events } = await run(m, "Read", { onApproval: (e) => (asked.push(e.tool), false) });
    const [ok, blocked, mcpCall] = results(events);
    assert.equal(ok.ok, true);
    assert.match(ok.output, /Launch on 20 October/);
    assert.equal(blocked.ok, false);
    assert.match(blocked.output, /outside the workspace|not permitted/);
    // The colliding MCP tool is a separate, approval-gated tool; denying it means it never runs.
    assert.deepEqual(asked, [F("read_file")]);
    assert.equal(mcpCall.executed, false);
    assert.ok(!JSON.stringify(events).includes(OUTSIDE_SECRET));
  });
});

describe("small-model robustness (found in real-model testing)", () => {
  test("an action the user declined is not asked for again in the same task", async () => {
    await mock.script([PLAN, step(T("add_note"), { text: "Call Sam" }), step(T("add_note"), { text: "Call Sam" }), step(T("add_note"), { text: "Call Sam" }), finish()]);
    let asked = 0;
    const { events } = await run(m, "Save a note", { onApproval: () => (asked++, false) });
    assert.equal(asked, 1, "the user must be asked only once");
    const r = results(events);
    assert.deepEqual(r.map((x) => x.executed), [false, false, false]);
    assert.match(r[1].output, /already declined this exact action/);
  });

  test("the same refused call repeated 3 times stops the run early with an honest partial answer", async () => {
    const bad = step(T("text_stats"), { "},": "answer" }); // missing "text" plus a junk key
    await mock.script([PLAN, bad, bad, bad, bad, bad, { content: "## What I found\nNothing.\n## Not finished\n- list notes" }]);
    const { events } = await run(m, "List notes", { onApproval: () => assert.fail("must not ask") });
    assert.equal(results(events).length, 3);
    assert.ok(of(events, "notice").some((n) => /kept repeating a call that was refused/.test(n.message)));
    assert.match(of(events, "final")[0].answer, /^> Stopped early because the model kept repeating a refused call/);
    assert.equal(of(events, "done")[0].status, "step_limit");
  });

  test("unknown arguments with empty values are dropped; unknown arguments with values are still rejected", async () => {
    await mock.script([PLAN, step(T("text_stats"), { text: "a b c", focus: "" }), step(T("text_stats"), { text: "a b", focus: "x" }), finish()]);
    let preview = "";
    const { events } = await run(m, "Stats", { onApproval: (e) => ((preview = e.preview), true) });
    const [ok, rejected] = results(events);
    assert.equal(ok.ok, true);
    assert.equal(JSON.parse(ok.output).words, 3);
    assert.doesNotMatch(preview, /focus/, "the approval card must show exactly what is sent");
    assert.equal(rejected.executed, false);
    assert.match(rejected.output, /Unknown argument "focus"/);
  });

  test("the 'no files opened' challenge is not used when the task already used tools", async () => {
    await mock.script([PLAN, step(T("convert_temperature"), { value: 0, from: "C", to: "K" }), finish("0 °C is 273.15 K.")]);
    const { events } = await run(m, "Convert");
    assert.ok(!of(events, "notice").some((n) => /without using any tool/.test(n.message)));
    assert.equal(of(events, "final")[0].answer, "0 °C is 273.15 K.");
  });
});
