// Nova Actions integration tests: the production build runs against a scripted
// mock model, with a throwaway workspace on disk. No real model or account is used.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { json, startApp } from "./helpers.mjs";
import { MOCK_KEY, startMockProvider } from "./mock-provider.mjs";

const OUTSIDE_SECRET = "TOP-SECRET-OUTSIDE-WORKSPACE";
const ENV_SECRET = "sk-live-should-never-be-read";

let mock, rw, ro, native, disabled, big, tmp, workspace, bigWorkspace;

function makeWorkspace() {
  tmp = mkdtempSync(path.join(os.tmpdir(), "nova-actions-test-"));
  workspace = path.join(tmp, "workspace");
  mkdirSync(path.join(workspace, "notes"), { recursive: true });
  mkdirSync(path.join(workspace, "node_modules", "pkg"), { recursive: true });
  writeFileSync(path.join(workspace, "notes", "plan.md"), "# Plan\nLaunch on 20 October.\n");
  writeFileSync(path.join(workspace, "notes", "existing.md"), "keep me\n");
  writeFileSync(path.join(workspace, ".env"), `API_KEY=${ENV_SECRET}\n`);
  writeFileSync(path.join(workspace, "secrets.txt"), `${ENV_SECRET}\n`);
  writeFileSync(path.join(workspace, "notes", "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
  writeFileSync(path.join(workspace, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  writeFileSync(path.join(tmp, "outside.txt"), `${OUTSIDE_SECRET}\n`);
  mkdirSync(path.join(tmp, "outside-dir"));
  writeFileSync(path.join(tmp, "outside-dir", "data.md"), `${OUTSIDE_SECRET}\n`);
  symlinkSync(path.join(tmp, "outside-dir"), path.join(workspace, "link-out"));
  symlinkSync(path.join(tmp, "outside.txt"), path.join(workspace, "notes", "sneaky.md"));

  // A larger workspace whose overview is truncated and depth-limited.
  bigWorkspace = path.join(tmp, "big");
  mkdirSync(path.join(bigWorkspace, "bulk"), { recursive: true });
  mkdirSync(path.join(bigWorkspace, "docs", "deep", "x"), { recursive: true });
  mkdirSync(path.join(bigWorkspace, "data"), { recursive: true });
  for (let i = 0; i < 210; i++) writeFileSync(path.join(bigWorkspace, "bulk", `blob-${String(i).padStart(3, "0")}.bin`), "x");
  writeFileSync(path.join(bigWorkspace, "docs", "a.md"), "# A\nalpha\n");
  writeFileSync(path.join(bigWorkspace, "docs", "deep", "x", "y.md"), "# Y\nyankee\n");
  writeFileSync(path.join(bigWorkspace, "data", "report.csv"), "k,v\n1,2\n");
  writeFileSync(path.join(bigWorkspace, ".env"), `KEY=${ENV_SECRET}\n`);
  writeFileSync(path.join(bigWorkspace, "secrets.txt"), `${ENV_SECRET}\n`);
  symlinkSync(path.join(tmp, "outside-dir"), path.join(bigWorkspace, "link-out"));
}

const step = (tool, args, extra = {}) => ({ json: { thought: `use ${tool}`, step: 1, action: "call_tool", tool, arguments: args, answer: "", ...extra } });
const finish = (answer = "All done.") => ({ json: { thought: "finished", step: 1, action: "finish", tool: "none", arguments: {}, answer } });
const PLAN = { json: { steps: ["Look at the files", "Answer"] } };

/**
 * Runs a goal and collects events. `onApproval(event, runId)` may return true/false
 * to decide, or null to leave it pending. `abortOn(event)` cancels the run when it returns true.
 */
async function run(app, goal, { onApproval = () => null, abortOn = () => false, headers = {} } = {}) {
  const controller = new AbortController();
  const res = await fetch(app.base + "/api/agent", { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify({ goal }), signal: controller.signal });
  if (!res.ok) return { status: res.status, body: await res.json(), events: [] };
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
            const r = await fetch(app.base + "/api/agent/approve", { method: "POST", headers: json, body: JSON.stringify({ runId, callId: e.callId, approved: decision }) });
            assert.equal(r.status, 200);
          }
        }
        if (await abortOn(e)) {
          controller.abort();
          return { status: 200, events, runId, aborted: true };
        }
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) throw err;
  }
  return { status: 200, events, runId };
}

const of = (events, type) => events.filter((e) => e.type === type);
const results = (events) => of(events, "tool_result").slice(1); // skip the automatic workspace overview
const done = (events) => of(events, "done").at(-1)?.status;

before(async () => {
  makeWorkspace();
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
  };
  [rw, ro, native, disabled, big] = await Promise.all([
    startApp({ ...common, WORKSPACE_DIR: workspace, WORKSPACE_ALLOW_WRITES: "true", AGENT_MAX_STEPS: "4", AGENT_APPROVAL_TIMEOUT_MS: "2500", TRUST_PROXY: "true" }),
    startApp({ ...common, WORKSPACE_DIR: workspace, WORKSPACE_ALLOW_WRITES: "false" }),
    startApp({ ...common, WORKSPACE_DIR: workspace, WORKSPACE_ALLOW_WRITES: "false", AI_AGENT_MODE: "native" }),
    startApp({ ...common, NOVA_ACTIONS_ENABLED: "false" }),
    startApp({ ...common, WORKSPACE_DIR: bigWorkspace, WORKSPACE_ALLOW_WRITES: "false", AGENT_MAX_STEPS: "3" }),
  ]);
});

after(() => {
  for (const a of [rw, ro, native, disabled, big]) a?.child.kill();
  mock?.server.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("plan-and-execute loop", () => {
  test("plans, runs a read tool, feeds the result back and finishes", async () => {
    await mock.script([PLAN, step("read_file", { path: "notes/plan.md" }), finish("Launch is on 20 October.")]);
    const { events } = await run(ro, "When is the launch?");
    assert.deepEqual(of(events, "plan")[0].steps, ["Look at the files", "Answer"]);
    const [read] = results(events);
    assert.equal(read.ok, true);
    assert.equal(read.executed, true);
    assert.match(read.output, /Launch on 20 October/);
    // The tool result was actually sent back to the model before it answered.
    assert.match(JSON.stringify(mock.seen.agentBodies.at(-1).messages), /Launch on 20 October/);
    assert.equal(of(events, "final")[0].answer, "Launch is on 20 October.");
    assert.equal(done(events), "completed");
    assert.ok(mock.seen.agentBodies.every((b) => b.response_format?.type === "json_schema"), "JSON mode uses structured output");
  });

  test("workspace overview hides secrets, hidden files and dependencies", async () => {
    await mock.script([PLAN, finish()]);
    const { events } = await run(ro, "What's here?");
    const overview = of(events, "tool_result")[0].output;
    assert.match(overview, /plan\.md/);
    for (const hidden of [".env", "secrets.txt", "node_modules"]) assert.ok(!overview.includes(hidden), `${hidden} listed`);
  });

  test("a repeated identical call is not executed twice", async () => {
    await mock.script([PLAN, step("read_file", { path: "notes/plan.md" }), step("read_file", { path: "notes/plan.md" }), finish()]);
    const { events } = await run(ro, "Read twice");
    const [first, second] = results(events);
    assert.equal(first.executed, true);
    assert.equal(second.executed, false);
    assert.match(second.output, /Not run: an equivalent read_file call/);
  });

  test("step limit stops the run and writes up only gathered results", async () => {
    await mock.script([
      PLAN,
      step("get_current_time", {}),
      step("read_file", { path: "notes/plan.md" }),
      step("read_file", { path: "notes/existing.md" }),
      step("read_file", { path: "notes/photo.png" }), // executes and fails: still uses a step
      { content: "## What I found\nPartial answer from gathered results.\n## Not finished\n- the rest" },
    ]);
    const { events } = await run(rw, "Loop forever");
    assert.equal(done(events), "step_limit");
    assert.equal(results(events).filter((r) => r.executed).length, 4);
    assert.match(of(events, "final")[0].answer, /Stopped after using all 4 tool steps/);
    assert.match(of(events, "final")[0].answer, /Partial answer/);
  });
});

describe("path traversal and file permissions", () => {
  const attacks = [
    ["parent traversal", "../outside.txt"],
    ["nested traversal", "notes/../../outside.txt"],
    ["absolute path", "/etc/passwd"],
    ["absolute path to secret", null], // filled in below with the real absolute path
    ["windows drive path", "C:\\Windows\\win.ini"],
    ["home shortcut", "~/.ssh/id_rsa"],
    ["symlinked folder escape", "link-out/data.md"],
    ["symlinked file escape", "notes/sneaky.md"],
    ["dotenv file", ".env"],
    ["secret-looking file", "secrets.txt"],
    ["dependency folder", "node_modules/pkg/index.js"],
    ["binary file", "notes/photo.png"],
    ["NUL byte", "notes/plan.md\u0000.txt"],
  ];
  for (const [name, p] of attacks) {
    test(`read_file blocks ${name}`, async () => {
      const target = p ?? path.join(tmp, "outside.txt");
      await mock.script([PLAN, step("read_file", { path: target }), finish()]);
      const { events } = await run(ro, "Read it");
      const [r] = results(events);
      assert.equal(r.ok, false, `${name} should fail`);
      const everything = JSON.stringify(events) + JSON.stringify(mock.seen.agentBodies);
      assert.ok(!everything.includes(OUTSIDE_SECRET), "outside content leaked");
      assert.ok(!everything.includes(ENV_SECRET), "secret leaked");
    });
  }

  test("list_files and search_files cannot leave the workspace or reveal secrets", async () => {
    await mock.script([PLAN, step("list_files", { path: ".." }), step("list_files", { path: "link-out" }), step("search_files", { query: "*" }), finish()]);
    const { events } = await run(big, "Look around");
    const [up, link, search] = results(events);
    assert.equal(up.ok, false);
    assert.equal(link.ok, false);
    assert.equal(search.ok, true);
    assert.ok(search.executed);
    assert.ok(!/outside|secrets\.txt|\.env|node_modules|link-out/.test(search.output), search.output);
  });

  test("write tools are not offered when the workspace is read-only", async () => {
    await mock.script([PLAN, step("create_file", { path: "new.md", content: "x" }), finish()]);
    const { events } = await run(ro, "Write a file");
    const started = of(events, "run_started")[0];
    assert.ok(!started.tools.some((t) => t.name === "create_file"));
    const [r] = results(events);
    assert.equal(r.executed, false);
    assert.match(r.output, /Unknown tool "create_file"/);
    assert.equal(of(events, "approval_required").length, 0);
    assert.ok(!existsSync(path.join(workspace, "new.md")));
  });

  test("unsupported tools (shell, delete) are refused and never executed", async () => {
    await mock.script([PLAN, step("run_shell", { command: "rm -rf /" }), step("delete_file", { path: "notes/plan.md" }), finish()]);
    const { events } = await run(rw, "Clean up");
    const [shell, del] = results(events);
    for (const r of [shell, del]) {
      assert.equal(r.executed, false);
      assert.match(r.output, /Unknown tool/);
    }
    assert.ok(existsSync(path.join(workspace, "notes", "plan.md")));
  });
});

describe("argument validation", () => {
  const cases = [
    ["missing required argument", "read_file", {}, /Missing required argument "path"/],
    ["wrong type", "read_file", { path: 42 }, /must be a string/],
    ["unexpected argument", "read_file", { path: "notes/plan.md", mode: "rw" }, /Unknown argument "mode"/],
    ["out-of-range integer", "list_files", { path: ".", depth: 50 }, /at most 3/],
    ["arguments not an object", "search_files", "*.md", /must be a JSON object/],
  ];
  test("arguments written as JSON text (how Gemini answers) are read like an object", async () => {
    await mock.script([PLAN, step("read_file", JSON.stringify({ path: "notes/plan.md" })), finish()]);
    const { events } = await run(ro, "What is in the plan?");
    const call = of(events, "tool_call").find((c) => c.tool === "read_file");
    const r = of(events, "tool_result").find((x) => x.callId === call.callId);
    assert.deepEqual(call.arguments, { path: "notes/plan.md" });
    assert.equal(r.executed, true);
    assert.equal(r.ok, true);
    assert.match(r.output, /Launch/);
  });

  for (const [name, tool, args, pattern] of cases) {
    test(name, async () => {
      await mock.script([PLAN, step(tool, args), finish()]);
      const { events } = await run(ro, "Validate");
      const [r] = results(events);
      assert.equal(r.executed, false);
      assert.match(r.output, pattern);
    });
  }
});

describe("approval requirements", () => {
  test("create_file waits for approval; denial means nothing is written", async () => {
    await mock.script([PLAN, step("create_file", { path: "out/denied.md", content: "nope" }), finish()]);
    let existedDuringApproval = null;
    const { events } = await run(rw, "Save a file", {
      onApproval: (e) => {
        existedDuringApproval = existsSync(path.join(workspace, "out", "denied.md"));
        assert.match(e.preview, /out\/denied\.md/);
        return false;
      },
    });
    assert.equal(existedDuringApproval, false, "file must not exist before approval");
    assert.equal(of(events, "approval_resolved")[0].approved, false);
    const [r] = results(events);
    assert.equal(r.executed, false);
    assert.match(r.output, /NOT performed/);
    assert.ok(!existsSync(path.join(workspace, "out")));
    assert.deepEqual(of(events, "final")[0].deliverables, []);
  });

  test("approved create_file writes exactly the approved content and reports a deliverable", async () => {
    await mock.script([PLAN, step("create_file", { path: "reports/summary.md", content: "# Summary\nok" }), finish("Saved.")]);
    const { events } = await run(rw, "Save a summary", { onApproval: () => true });
    const [r] = results(events);
    assert.equal(r.ok, true);
    assert.equal(readFileSync(path.join(workspace, "reports", "summary.md"), "utf8"), "# Summary\nok");
    assert.deepEqual(of(events, "final")[0].deliverables, [{ kind: "file", path: "reports/summary.md" }]);
  });

  test("doomed writes are rejected before asking for approval (overwrite, traversal, bad type)", async () => {
    await mock.script([
      PLAN,
      step("create_file", { path: "notes/existing.md", content: "overwrite!" }),
      step("create_file", { path: "../escape.md", content: "x" }),
      step("create_file", { path: "link-out/inside-link.md", content: "x" }),
      step("create_file", { path: "run.exe", content: "x" }),
      finish(),
    ]);
    const { events } = await run(rw, "Try bad writes", { onApproval: () => assert.fail("must not ask for approval") });
    assert.equal(of(events, "approval_required").length, 0);
    for (const r of results(events)) assert.equal(r.executed, false);
    assert.equal(readFileSync(path.join(workspace, "notes", "existing.md"), "utf8"), "keep me\n");
    assert.ok(!existsSync(path.join(tmp, "escape.md")));
    assert.ok(!existsSync(path.join(tmp, "outside-dir", "inside-link.md")));
  });

  test("an unanswered approval times out as denied", async () => {
    await mock.script([PLAN, step("create_file", { path: "timeout.md", content: "x" }), finish()]);
    const { events } = await run(rw, "Wait for me");
    const resolved = of(events, "approval_resolved")[0];
    assert.equal(resolved.approved, false);
    assert.match(resolved.reason, /timed out/);
    assert.ok(!existsSync(path.join(workspace, "timeout.md")));
  });

  test("approval endpoint rejects unknown runs, other clients, cross-site and malformed requests", async () => {
    await mock.script([PLAN, step("create_file", { path: "guarded.md", content: "x" }), finish()]);
    const checks = {};
    await run(rw, "Guarded write", {
      headers: { "X-Forwarded-For": "198.51.100.7" },
      onApproval: async (e, runId) => {
        const post = (body, headers = {}) =>
          fetch(rw.base + "/api/agent/approve", { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify(body) });
        checks.unknownRun = (await post({ runId: "00000000-0000-4000-8000-000000000000", callId: e.callId, approved: true }, { "X-Forwarded-For": "198.51.100.7" })).status;
        checks.otherClient = (await post({ runId, callId: e.callId, approved: true }, { "X-Forwarded-For": "203.0.113.9" })).status;
        checks.crossSite = (await post({ runId, callId: e.callId, approved: true }, { "Sec-Fetch-Site": "cross-site", "X-Forwarded-For": "198.51.100.7" })).status;
        checks.malformed = (await post({ runId, callId: "x", approved: "yes" }, { "X-Forwarded-For": "198.51.100.7" })).status;
        checks.existsAfterAttacks = existsSync(path.join(workspace, "guarded.md"));
        // The real owner denies.
        checks.owner = (await post({ runId, callId: e.callId, approved: false }, { "X-Forwarded-For": "198.51.100.7" })).status;
        return null;
      },
    });
    assert.deepEqual(checks, { unknownRun: 404, otherClient: 404, crossSite: 403, malformed: 400, existsAfterAttacks: false, owner: 200 });
    assert.ok(!existsSync(path.join(workspace, "guarded.md")));
  });
});

describe("cancellation", () => {
  test("cancelling while the model is thinking aborts the provider request; no tool runs", async () => {
    await mock.script([PLAN, { delayMs: 5000, ...step("read_file", { path: "notes/plan.md" }) }]);
    const before = mock.seen.agentAborted;
    // Cancel only once the model request is really in flight (not during the workspace overview).
    const { events } = await run(ro, "Slow task", {
      abortOn: async (e) => {
        if (e.type !== "plan") return false;
        for (let i = 0; i < 100 && mock.seen.agentBodies.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
        return true;
      },
    });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(mock.seen.agentAborted, before + 1, "provider request was not aborted");
    assert.equal(results(events).length, 0);
    // The concurrency slot was released: a new run can start.
    await mock.script([PLAN, finish()]);
    const again = await run(ro, "Next task");
    assert.equal(done(again.events), "completed");
  });

  test("cancelling while an approval is pending denies it and writes nothing", async () => {
    await mock.script([PLAN, step("create_file", { path: "cancelled.md", content: "x" }), finish()]);
    let pending;
    await run(rw, "Cancel me", { abortOn: (e) => { if (e.type === "approval_required") { pending = e; return true; } return false; } });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(pending);
    assert.ok(!existsSync(path.join(workspace, "cancelled.md")));
  });
});

describe("model and provider failures", () => {
  test("malformed model output is retried, then the run fails without running tools", async () => {
    await mock.script([PLAN, { content: "Sure! I will read the file." }, { content: "{not json" }, { json: { action: "dance" } }]);
    const { events } = await run(ro, "Garbage");
    assert.equal(of(events, "notice").filter((n) => /couldn't be understood/.test(n.message)).length, 2);
    assert.equal(results(events).length, 0);
    assert.equal(done(events), "failed");
    assert.match(of(events, "error")[0].message, /did not produce a valid action/);
  });

  test("one malformed reply is recovered from", async () => {
    await mock.script([PLAN, { content: "```json\n{oops" }, step("read_file", { path: "notes/plan.md" }), finish()]);
    const { events } = await run(ro, "Recover");
    assert.equal(results(events)[0].ok, true);
    assert.equal(done(events), "completed");
  });

  test("provider error mid-run fails safely with a redacted message", async () => {
    await mock.script([PLAN, { status: 500, body: JSON.stringify({ error: "boom at http://10.0.0.5/internal" }) }]);
    const { events } = await run(ro, "Fail");
    assert.equal(done(events), "failed");
    const msg = of(events, "error")[0].message;
    assert.ok(!msg.includes("10.0.0.5"), msg);
  });

  test("free-tier rate limits: Nova waits as the provider asks and carries on; a used-up daily limit is said plainly", async () => {
    const slowDown = { status: 429, body: JSON.stringify({ error: { code: 429, message: "Resource has been exhausted", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "1s" }] } }) };
    await mock.script([slowDown, PLAN, slowDown, finish("All good."), finish("All good.")]); // (answering without a tool is questioned once)
    const t0 = Date.now();
    let { events } = await run(ro, "Say hi");
    assert.equal(done(events), "completed");
    assert.equal(of(events, "final")[0].answer, "All good.");
    assert.ok(Date.now() - t0 >= 2_500, "it waited about 1.5 s twice");
    await mock.script([PLAN, { status: 429, body: JSON.stringify({ error: { message: "Quota exceeded for metric: generate_content_free_tier_requests, limit: 250, quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier" } }) }]);
    ({ events } = await run(ro, "Say hi again"));
    assert.equal(done(events), "failed");
    assert.match(of(events, "error")[0].message, /free daily limit of .* is used up\. It resets tomorrow/);
  });
});

describe("native tool-calling mode", () => {
  test("uses OpenAI tool calls and handles malformed arguments", async () => {
    await mock.script([
      PLAN,
      { tool_calls: [{ name: "read_file", arguments: "{bad json" }] },
      { tool_calls: [{ name: "read_file", arguments: JSON.stringify({ path: "notes/plan.md" }) }] },
      { content: "Launch is on 20 October." },
    ]);
    const { events } = await run(native, "When is launch?");
    const [bad, good] = results(events);
    assert.equal(bad.executed, false);
    assert.match(bad.output, /not valid JSON/);
    assert.equal(good.ok, true);
    assert.equal(of(events, "final")[0].answer, "Launch is on 20 October.");
    const stepRequest = mock.seen.agentBodies[1];
    assert.ok(Array.isArray(stepRequest.tools) && stepRequest.tools.some((t) => t.function.name === "read_file"));
    // Tool results go back as role "tool" messages tied to the call id.
    assert.ok(mock.seen.agentBodies.at(-1).messages.some((m) => m.role === "tool" && m.tool_call_id));
  });

  test("falls back to prompted JSON when the provider rejects json_schema", async () => {
    await mock.script([{ status: 400, body: JSON.stringify({ error: { message: "response_format json_schema is not supported" } }) }, PLAN, { content: "Done." }]);
    const { events } = await run(native, "Fallback");
    assert.equal(done(events), "completed");
    assert.ok(mock.seen.agentBodies[0].response_format);
    assert.equal(mock.seen.agentBodies[1].response_format, undefined);
  });
});

describe("request validation", () => {
  const post = (app, body, headers = {}) => fetch(app.base + "/api/agent", { method: "POST", headers: { ...json, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  test("rejects empty, oversized and malformed goals", async () => {
    assert.equal((await post(ro, { goal: "  " })).status, 400);
    assert.equal((await post(ro, { goal: "x".repeat(4001) })).status, 400);
    assert.equal((await post(ro, "{oops")).status, 400);
    assert.equal((await post(ro, { goal: "hi", model: 42 })).status, 400);
  });
  test("rejects cross-site requests", async () => {
    assert.equal((await post(ro, { goal: "hi" }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  });
  test("returns 404 when Nova Actions is disabled", async () => {
    assert.equal((await post(disabled, { goal: "hi" })).status, 404);
  });
  test("status lists tools without revealing the workspace path", async () => {
    const text = await (await fetch(rw.base + "/api/status")).text();
    const { actions } = JSON.parse(text);
    assert.equal(actions.workspace, true);
    assert.equal(actions.writes, true);
    assert.ok(actions.tools.find((t) => t.name === "create_file").risk === "write");
    assert.ok(!text.includes(tmp), "workspace path leaked");
  });
});

describe("efficient exploration and step budget", () => {
  const sentMessages = () => mock.seen.agentBodies.map((b) => b.messages);
  const lastUserNote = (messages) => [...messages].reverse().find((m) => m.role === "user" && /Tool steps used/.test(m.content))?.content ?? "";

  test("a complete listing says so, and flags files that cannot be read", async () => {
    await mock.script([PLAN, finish()]);
    const { events } = await run(ro, "Overview");
    const overview = of(events, "tool_result")[0].output;
    // Other tests may add files to this shared workspace, so only the wording is fixed here.
    assert.match(overview, /Listing COMPLETE: all \d+ files in \d+ folders? under \.\/ are shown/);
    assert.match(overview, /photo\.png \(7 B\) \[not a readable text file\]/);
    assert.match(overview, /protected or non-regular entries are not shown/);
    for (const name of [".env", "secrets.txt", "sneaky.md", "link-out", "node_modules"]) assert.ok(!overview.includes(name), `${name} listed`);
  });

  test("a depth-limited listing marks unexpanded folders and says it is incomplete", async () => {
    await mock.script([PLAN, step("list_files", { path: "docs", depth: 1 }), finish()]);
    const { events } = await run(big, "Docs");
    const [docs] = results(events);
    assert.match(docs.output, /deep\/ \[not expanded: 0 files, 1 folder — call list_files with path "docs\/deep"\]/);
    assert.match(docs.output, /Listing INCOMPLETE \(depth limit 1\)/);
  });

  test("a truncated listing says so and is shown to the model with an explicit cut marker", async () => {
    await mock.script([PLAN, finish()]);
    const { events } = await run(big, "Overview");
    const overview = of(events, "tool_result")[0].output;
    assert.match(overview, /Listing TRUNCATED: stopped after 200 entries/);
    const sent = JSON.stringify(sentMessages().at(-1));
    assert.match(sent, /output cut here: \d+ more characters not shown/);
  });

  test("one search can combine several patterns (comma or |), case-insensitively", async () => {
    await mock.script([PLAN, step("search_files", { query: "*.MD | *.csv" }), finish()]);
    const { events } = await run(big, "Find docs");
    const [found] = results(events);
    assert.equal(found.executed, true);
    for (const f of ["docs/a.md", "docs/deep/x/y.md", "data/report.csv"]) assert.ok(found.output.includes(f), found.output);
    assert.match(found.output, /Search complete: 3 files match \*\.csv, \*\.md/);
  });

  test("equivalent and already-covered searches are not run again", async () => {
    await mock.script([
      PLAN,
      step("search_files", { query: "*.md, *.csv" }),
      step("search_files", { query: " *.MD " }), // covered (case/whitespace)
      step("search_files", { query: "*.csv,*.md" }), // same set, different order
      step("list_files", { path: "./docs/" }),
      step("list_files", { path: "docs", depth: 2 }), // equivalent to the previous call
      finish(),
    ]);
    const { events } = await run(big, "Search a lot");
    const r = results(events);
    assert.deepEqual(r.map((x) => x.executed), [true, false, false, true, false]);
    assert.match(r[1].output, /already searched/);
    assert.match(r[2].output, /equivalent search_files call/);
    assert.match(r[4].output, /equivalent list_files call/);
  });

  test("searching or re-listing is refused when the complete listing already shows everything", async () => {
    await mock.script([PLAN, step("search_files", { query: "*.md" }), step("list_files", { path: "notes" }), step("read_file", { path: "notes/plan.md" }), finish()]);
    const { events } = await run(ro, "Find markdown");
    const [search, list, read] = results(events);
    assert.equal(search.executed, false);
    assert.match(search.output, /listing above is COMPLETE/);
    assert.equal(list.executed, false);
    assert.equal(read.executed, true);
    // The model is told the listing is complete and which readable files it hasn't opened.
    const note = lastUserNote(sentMessages()[1]);
    assert.match(note, /workspace listing is COMPLETE/);
    assert.match(note, /Readable files not opened yet: notes\/existing\.md, notes\/plan\.md/);
  });

  test("refused calls don't eat the budget: real work still gets every step", async () => {
    await mock.script([
      PLAN,
      step("search_files", { query: "*.md, *.csv" }),
      step("search_files", { query: "*.md" }),
      step("search_files", { query: "*.csv" }),
      step("search_files", { query: "*.MD" }),
      step("read_file", { path: "docs/a.md" }),
      step("read_file", { path: "data/report.csv" }),
      { content: "## What I found\nalpha, report\n## Not finished\n- y.md" },
    ]);
    const { events } = await run(big, "Read the docs");
    const r = results(events);
    assert.deepEqual(r.map((x) => x.executed), [true, false, false, false, true, true]);
    assert.equal(done(events), "step_limit");
  });

  test("the model sees its remaining budget and is warned before the last step", async () => {
    await mock.script([PLAN, step("read_file", { path: "docs/a.md" }), step("read_file", { path: "data/report.csv" }), finish("done")]);
    await run(big, "Budget");
    const notes = sentMessages().slice(1).map(lastUserNote);
    assert.match(notes[0], /Tool steps used: 0 of 3 \(3 left\)/);
    assert.match(notes[1], /Tool steps used: 1 of 3 \(2 left\)/);
    assert.match(notes[1], /Only 2 steps left/);
    assert.match(notes[2], /This is your LAST tool step/);
  });

  test("a model stuck repeating itself is stopped by the hard cap (no endless loop)", async () => {
    const repeat = Array.from({ length: 30 }, () => step("search_files", { query: "*.md" }));
    await mock.script([PLAN, ...repeat]);
    const { events } = await run(big, "Loop");
    assert.equal(done(events), "step_limit");
    const decisions = mock.seen.agentBodies.filter((b) => b.response_format?.json_schema?.name === "agent_step").length;
    assert.ok(decisions <= 3 + 3 + 2 + 1, `made ${decisions} model calls`);
    assert.equal(results(events).filter((x) => x.executed).length, 1);
  });

  test("out of budget: partial answer, explicit unfinished parts, and files not examined", async () => {
    await mock.script([
      PLAN,
      step("search_files", { query: "*.md, *.csv" }),
      step("read_file", { path: "docs/a.md" }),
      step("get_current_time", {}),
      { content: "## What I found\n- a.md says alpha\n## Not finished\n- y.md and report.csv were not read" },
    ]);
    const { events } = await run(big, "Summarize every document");
    assert.equal(done(events), "step_limit");
    const answer = of(events, "final")[0].answer;
    assert.match(answer, /^> Stopped after using all 3 tool steps, so this answer is partial\./);
    assert.match(answer, /## What I found[\s\S]*alpha/);
    assert.match(answer, /## Not finished/);
    assert.match(answer, /\*\*Files not examined\*\*[\s\S]*`data\/report\.csv`[\s\S]*`docs\/deep\/x\/y\.md`/);
    assert.ok(!/`docs\/a\.md`/.test(answer.split("Files not examined")[1]), "a.md was examined");
    assert.ok(!/blob-/.test(answer), "non-readable files are not listed as unexamined");
    // The wrap-up request demanded the two sections and contained only real tool results.
    const wrap = mock.seen.agentBodies.at(-1);
    assert.match(wrap.messages[0].content, /## Not finished/);
    assert.match(wrap.messages[1].content, /alpha/);
  });

  test("answering without opening any file is challenged once, then the model decides", async () => {
    await mock.script([PLAN, finish("budget.csv probably holds budget data"), step("read_file", { path: "notes/plan.md" }), finish("Plan: launch on 20 October.")]);
    const { events } = await run(ro, "What do my files say?");
    assert.ok(of(events, "notice").some((n) => /without using any tool/.test(n.message)));
    assert.equal(results(events)[0].executed, true);
    assert.equal(of(events, "final")[0].answer, "Plan: launch on 20 October.");

    // If the goal genuinely doesn't need contents, finishing again is accepted.
    await mock.script([PLAN, finish("Files: plan.md, existing.md"), finish("Files: plan.md, existing.md")]);
    const again = await run(ro, "Just list my file names");
    assert.equal(done(again.events), "completed");
    assert.equal(of(again.events, "final")[0].answer, "Files: plan.md, existing.md");
    assert.equal(of(again.events, "notice").filter((n) => /without using any tool/.test(n.message)).length, 1);
  });

  test("finishing within budget gives a normal final answer", async () => {
    await mock.script([PLAN, step("read_file", { path: "docs/a.md" }), finish("A says alpha.")]);
    const { events } = await run(big, "Read a");
    assert.equal(done(events), "completed");
    assert.equal(of(events, "final")[0].answer, "A says alpha.");
  });
});
