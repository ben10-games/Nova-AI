// Paid AI providers with the user's own key: Anthropic (through the official SDK), OpenAI and xAI (OpenAI
// format). Each runs against a local stand-in that answers like the real API; the setup's key check too.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { json, root, startApp } from "./helpers.mjs";

const CLAUDE_KEY = "sk-ant-api03-StandInKey_0123456789abcdefghijklmnop";
const OPENAI_KEY = "sk-proj-StandInKey_0123456789abcdefghijklmnop";

function listen(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
      seen.push(entry);
      handler(entry, res);
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}
const send = (res, status, value) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));

/** Answers like Anthropic's Messages API (models list, messages, streaming events). */
function fakeAnthropic() {
  return listen((r, res) => {
    // The SDK (API version 2026-10-21) sends the key as a Bearer token; setup's plain check uses x-api-key.
    if (r.headers["x-api-key"] !== CLAUDE_KEY && r.headers.authorization !== `Bearer ${CLAUDE_KEY}`) return send(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    if (r.method === "GET" && r.url.startsWith("/v1/models")) {
      const m = (id, at) => ({ type: "model", id, display_name: id, created_at: at, deprecated_at: null, max_input_tokens: 1_000_000, max_tokens: 128_000, capabilities: null });
      return send(res, 200, { data: [m("claude-opus-5-5", "2026-09-01T00:00:00Z"), m("claude-sonnet-5-5", "2026-08-01T00:00:00Z"), m("claude-haiku-5-5", "2026-07-01T00:00:00Z"), m("claude-opus-4-8", "2026-01-01T00:00:00Z")], has_more: false, first_id: "claude-opus-5-5", last_id: "claude-opus-4-8" });
    }
    if (r.method === "POST" && r.url.startsWith("/v1/messages")) {
      const sys = String(r.body.system ?? "");
      // Syntaz's agent asks for JSON: a plan first, then a step that finishes.
      const text = /"required":\["steps"\]/.test(sys)
        ? JSON.stringify({ steps: ["Answer the question"] })
        : /JSON Schema/.test(sys)
          ? JSON.stringify({ thought: "easy", step: 1, action: "finish", tool: "none", arguments: "{}", answer: "Hi from Claude." })
          : "Hello from Claude.";
      const message = { id: "msg_1", type: "message", role: "assistant", model: r.body.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } };
      if (!r.body.stream) return send(res, 200, message);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev("message_start", { message: { ...message, content: [], stop_reason: null } });
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hello " } });
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "from Claude." } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
      ev("message_stop", {});
      return res.end();
    }
    send(res, 404, { type: "error", error: { type: "not_found_error", message: "not found" } });
  });
}

/** Answers like OpenAI's newer models: no temperature, max_completion_tokens instead of max_tokens. */
function fakeOpenAi({ credit = true, ids = ["gpt-6-luna", "gpt-6-sol"] } = {}) {
  return listen((r, res) => {
    if (r.headers.authorization !== `Bearer ${OPENAI_KEY}`) return send(res, 401, { error: { message: "Incorrect API key provided.", code: "invalid_api_key" } });
    if (r.method === "GET" && r.url === "/models") {
      return send(res, 200, { data: [...ids.map((id, i) => ({ id, created: 1_790_000_000 + i * 5_000_000 })), { id: "text-embedding-4", created: 1_799_000_000 }, { id: "whisper-2", created: 1_700_000_000 }] });
    }
    if (!credit) return send(res, 429, { error: { message: "You exceeded your current quota, please check your plan and billing details.", code: "insufficient_quota" } });
    if (r.body.max_tokens !== undefined) return send(res, 400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", param: "max_tokens" } });
    if (r.body.temperature !== undefined && r.body.temperature !== 1) return send(res, 400, { error: { message: `Unsupported value: 'temperature' does not support ${r.body.temperature} with this model. Only the default (1) value is supported.`, param: "temperature" } });
    if (r.body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello from GPT." }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      return res.end();
    }
    send(res, 200, { choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });
  });
}

async function chat(base, content, extra = {}) {
  const res = await fetch(`${base}/api/chat`, { method: "POST", headers: json, body: JSON.stringify({ messages: [{ role: "user", content }], ...extra }) });
  const events = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { status: res.status, events, text: events.filter((e) => e.type === "delta").map((e) => e.text).join("") };
}

describe("Anthropic (Claude) through the official SDK", () => {
  let fake, app;
  before(async () => {
    fake = await fakeAnthropic();
    app = await startApp({
      AI_PROVIDER: "anthropic",
      AI_PROVIDER_NAME: "Anthropic (Claude)",
      AI_BASE_URL: fake.base,
      AI_API_KEY: CLAUDE_KEY,
      AI_MODEL: "",
      AI_MODELS: "claude-opus-5-5,claude-haiku-5-5",
      AI_CONTEXT_LENGTH: "32768",
      AI_MAX_OUTPUT_TOKENS: "16000",
      AI_AGENT_MODE: "json",
      WORKSPACE_DIR: path.join(root, "examples", "workspace"),
      NOVA_ACTIONS_ENABLED: "true",
      MCP_SERVERS: "",
      RATE_LIMIT_MAX: "0",
    });
  });
  after(() => {
    app?.child.kill();
    fake?.server.close();
  });

  test("chat streams Claude's answer; the request is a proper Messages API call", async () => {
    const pic = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
    const r = await chat(app.base, "hello", { messages: [{ role: "user", content: "what is this?", images: [pic] }] });
    assert.equal(r.status, 200, JSON.stringify(r.events) + "\n" + app.logs().slice(-3000));
    assert.equal(r.text, "Hello from Claude.");
    assert.equal(r.events.at(-1).type, "done");
    const req = fake.seen.filter((s) => s.url.startsWith("/v1/messages")).at(-1);
    assert.equal(req.headers.authorization, `Bearer ${CLAUDE_KEY}`);
    assert.equal(req.body.model, "claude-opus-5-5", "the first model of AI_MODELS is the default");
    assert.equal(req.body.stream, true);
    assert.equal(req.body.max_tokens, 16000);
    assert.equal(typeof req.body.system, "string", "the system prompt goes in `system`, not in the messages");
    assert.equal(req.body.temperature, undefined, "no sampling settings (current Claude models reject them)");
    assert.deepEqual(req.body.messages[0].content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: pic.split(",")[1] } });
    assert.equal(req.body.fallbacks, "default", "refusal fallbacks are on");
    assert.match(req.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  });

  test("the model picker lists the key's Claude models, with Syntaz's (bounded) context size", async () => {
    const s = await (await fetch(`${app.base}/api/status`)).json();
    assert.deepEqual(s.models.map((m) => m.id), ["claude-opus-5-5", "claude-haiku-5-5"]);
    assert.ok(s.models.every((m) => m.contextLength === 32768), JSON.stringify(s.models));
    const r = await chat(app.base, "hi", { options: { model: "claude-haiku-5-5" } });
    assert.equal(r.status, 200);
    const req = fake.seen.filter((x) => x.url.startsWith("/v1/messages")).at(-1);
    assert.equal(req.body.model, "claude-haiku-5-5");
    assert.equal(req.body.fallbacks, undefined, "Haiku has no server-side fallback");
  });

  test("Actions run with Claude: plan and steps come back as JSON through the SDK", async () => {
    const res = await fetch(`${app.base}/api/agent`, { method: "POST", headers: json, body: JSON.stringify({ goal: "Say hi" }) });
    const events = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(events.find((e) => e.type === "done")?.status, "completed", JSON.stringify(events).slice(0, 800));
    assert.equal(events.find((e) => e.type === "final").answer, "Hi from Claude.");
    const reqs = fake.seen.filter((x) => x.url.startsWith("/v1/messages") && !x.body.stream);
    assert.ok(reqs.length >= 2);
    assert.ok(reqs.every((x) => /JSON Schema/.test(x.body.system)), "asks for JSON in the system prompt");
  });

  test("a wrong key gives a plain message", async () => {
    const bad = await startApp({ AI_PROVIDER: "anthropic", AI_PROVIDER_NAME: "", AI_BASE_URL: fake.base, AI_API_KEY: "sk-ant-wrong-key-000000000000000000", AI_MODELS: "claude-opus-5-5", AI_MAX_OUTPUT_TOKENS: "16000", RATE_LIMIT_MAX: "0", MCP_SERVERS: "" });
    try {
      const res = await fetch(`${bad.base}/api/chat`, { method: "POST", headers: json, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
      assert.ok(res.status >= 400);
      assert.match((await res.json()).error, /Anthropic rejected the server's credentials/);
    } finally {
      bad.child.kill();
    }
  });
});

describe("OpenAI's newer models", () => {
  let fake, app;
  before(async () => {
    fake = await fakeOpenAi();
    app = await startApp({ AI_PROVIDER: "openai-compatible", AI_PROVIDER_NAME: "OpenAI", AI_BASE_URL: fake.base, AI_API_KEY: OPENAI_KEY, AI_MODELS: "gpt-6-sol", AI_MAX_OUTPUT_TOKENS: "4096", RATE_LIMIT_MAX: "0", MCP_SERVERS: "" });
  });
  after(() => {
    app?.child.kill();
    fake?.server.close();
  });

  test("settings the model rejects (max_tokens, temperature) are left out, once learned", async () => {
    const r = await chat(app.base, "hi", { options: { temperature: 0.7 } });
    assert.equal(r.status, 200, JSON.stringify(r.events));
    assert.equal(r.text, "Hello from GPT.");
    const last = fake.seen.at(-1).body;
    assert.equal(last.max_completion_tokens, 4096);
    assert.equal(last.max_tokens, undefined);
    assert.equal(last.temperature, undefined);
    const before = fake.seen.length;
    assert.equal((await chat(app.base, "again", { options: { temperature: 0.7 } })).text, "Hello from GPT.");
    assert.equal(fake.seen.length - before, 1, "remembered: one request the second time");
  });
});

describe("setup: checking a paid key", () => {
  let anthropic, openai, broke, lib;
  before(async () => {
    anthropic = await fakeAnthropic();
    openai = await fakeOpenAi();
    broke = await fakeOpenAi({ credit: false, ids: ["grok-5"] });
    process.env.NOVA_SETUP_ANTHROPIC_BASE = anthropic.base;
    process.env.NOVA_SETUP_OPENAI_BASE = openai.base;
    process.env.NOVA_SETUP_XAI_BASE = broke.base;
    lib = await import(`../setup/lib.mjs?paid=${Date.now()}`);
  });
  after(() => {
    for (const k of ["NOVA_SETUP_ANTHROPIC_BASE", "NOVA_SETUP_OPENAI_BASE", "NOVA_SETUP_XAI_BASE"]) delete process.env[k];
    for (const f of [anthropic, openai, broke]) f?.server.close();
  });

  test("Anthropic: the current Claude models first, a tiny test question, settings for Syntaz", async () => {
    const r = await lib.checkPaid("anthropic", ` ${CLAUDE_KEY} `);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.models, ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-4-8"]);
    assert.equal(r.model, "claude-opus-5-5");
    assert.equal(r.values.AI_PROVIDER, "anthropic");
    assert.equal(r.values.AI_BASE_URL, anthropic.base);
    assert.equal(r.values.AI_MODELS, "claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5,claude-opus-4-8");
    const test = anthropic.seen.find((s) => s.url === "/v1/messages");
    assert.equal(test.headers["anthropic-version"], "2023-06-01");
    // A chosen model is tested and becomes the default.
    const h = await lib.checkPaid("anthropic", CLAUDE_KEY, "claude-haiku-5-5");
    assert.equal(h.model, "claude-haiku-5-5");
    assert.match(h.values.AI_MODELS, /^claude-haiku-5-5,claude-opus-5-5,/);
    assert.match((await lib.checkPaid("anthropic", "sk-ant-wrong-key-000000000000000000")).error, /Anthropic \(Claude\) says this key doesn't work/);
  });

  test("OpenAI: chat models only, newest first; a key without credit is caught now", async () => {
    const r = await lib.checkPaid("openai", OPENAI_KEY);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.models, ["gpt-6-sol", "gpt-6-luna"], "no embedding or speech models");
    assert.equal(r.values.AI_PROVIDER, "openai-compatible");
    const noCredit = await lib.checkPaid("xai", OPENAI_KEY);
    assert.equal(noCredit.ok, false);
    assert.match(noCredit.error, /no credit\. Add a payment method or buy credits/);
    assert.match((await lib.checkPaid("openai", "short")).error, /doesn't look like/);
  });

  test("the text setup offers the paid AIs and saves the chosen Claude model", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "syntaz-paid-setup-"));
    try {
      mkdirSync(path.join(dir, "setup"));
      for (const f of ["setup.mjs", "lib.mjs"]) copyFileSync(path.join(root, "setup", f), path.join(dir, "setup", f));
      const child = spawn(process.execPath, [path.join(dir, "setup", "setup.mjs"), "--configure-only"], { env: { ...process.env, NOVA_SETUP_ANTHROPIC_BASE: anthropic.base, NOVA_SETUP_GEMINI_BASE: "http://127.0.0.1:9" }, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.stdin.end(`4\n${CLAUDE_KEY}\n3\n`);
      const code = await new Promise((r) => child.on("close", r));
      assert.equal(code, 0, out);
      assert.match(out, /4 = Anthropic \(Claude\), with your own paid API key/);
      assert.match(out, /1 = claude-opus-5-5 \(suggested\)/);
      assert.match(out, /✔ Syntaz will use claude-haiku-5-5\./);
      assert.ok(!out.includes(CLAUDE_KEY), "the key is never shown");
      const env = readFileSync(path.join(dir, ".env.local"), "utf8");
      for (const line of ["AI_PROVIDER=anthropic", `AI_API_KEY=${CLAUDE_KEY}`, "AI_PROVIDER_NAME=Anthropic (Claude)"]) assert.ok(env.split("\n").includes(line), `missing ${line}`);
      assert.match(env, /^AI_MODELS=claude-haiku-5-5,claude-opus-5-5,/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
