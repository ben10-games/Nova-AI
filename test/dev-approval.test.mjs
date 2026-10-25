// Regression: in `next dev` (what users run), the FIRST approval after starting the server used to
// fail with "This action is no longer waiting for approval": the approve route loaded its own copy
// of the pending-approval registry. This runs a real dev server in its own build folder.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { MOCK_KEY, startMockProvider } from "./mock-provider.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = ".next-devtest";
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let mock, child, base;
before(async () => {
  rmSync(path.join(root, DIST), { recursive: true, force: true }); // a fresh dev server: nothing compiled yet
  mock = await startMockProvider();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "development", NOVA_NEXT_DIST_DIR: DIST, AI_BASE_URL: mock.url, AI_API_KEY: MOCK_KEY, AI_PROVIDER: "openai-compatible", AI_PROVIDER_NAME: "Mock AI", AI_MODEL: "mock-chat-large", AI_MODELS: "", LMSTUDIO_BASE_URL: "", LMSTUDIO_MODEL: "", WORKSPACE_DIR: "", BASIC_AUTH_USER: "", BASIC_AUTH_PASSWORD: "", RATE_LIMIT_MAX: "1000", NOVA_ACTIONS_ENABLED: "true", MCP_SERVERS: "nova-test", AGENT_APPROVAL_TIMEOUT_MS: "8000" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  for (let i = 0; i < 400; i++) {
    try {
      await fetch(base + "/api/status", { headers: { Origin: base } });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error("next dev did not start");
});
after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child.once("exit", r));
    child.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }
  mock?.server.close();
  rmSync(path.join(root, DIST), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("next dev: the first approval after start reaches the waiting task (and later ones too)", { timeout: 240_000 }, async () => {
  const H = { "Content-Type": "application/json", Origin: base };
  for (const round of [1, 2]) {
    await mock.script([
      { json: { steps: ["a"] } },
      { json: { thought: "t", step: 1, action: "call_tool", tool: "mcp__nova-test__add_note", arguments: { text: `round ${round}` }, answer: "" } },
      { json: { thought: "f", step: 1, action: "finish", tool: "none", arguments: {}, answer: "done" } },
    ]);
    const res = await fetch(base + "/api/agent", { method: "POST", headers: H, body: JSON.stringify({ goal: "add a note" }) });
    let runId;
    const approvals = [];
    let executed = null;
    const dec = new TextDecoder();
    let buf = "";
    for await (const ch of res.body) {
      buf += dec.decode(ch, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const l of lines.filter(Boolean)) {
        const e = JSON.parse(l);
        if (e.type === "run_started") runId = e.runId;
        if (e.type === "approval_required") {
          const a = await fetch(base + "/api/agent/approve", { method: "POST", headers: H, body: JSON.stringify({ runId, callId: e.callId, approved: true }) });
          approvals.push(a.status === 200 ? 200 : `${a.status} ${(await a.json()).error}`);
        }
        if (e.type === "tool_result") executed = e.executed;
      }
    }
    assert.deepEqual(approvals, [200], `round ${round}: the approval was accepted`);
    assert.equal(executed, true, `round ${round}: the approved action ran`);
  }
});
