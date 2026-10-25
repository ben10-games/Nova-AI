// The friends' setup (setup/setup.mjs), run against a local stand-in for Google's Gemini API.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOOD = "AQ.Ab8GoodTestKey_1234567890abcdefghij"; // the new key style has a dot

function fakeGemini() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      const send = (status, json) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (req.headers.authorization !== `Bearer ${GOOD}`) return send(400, { error: { message: "API key not valid. Please pass a valid API key." } });
      if (req.method === "GET" && req.url === "/models") return send(200, { data: [{ id: "models/gemini-3.1-flash-lite" }, { id: "models/gemini-3.6-flash" }, { id: "models/text-embedding-004" }] });
      if (req.method === "POST" && req.url === "/chat/completions") {
        const { model, reasoning_effort } = JSON.parse(body);
        // This key has no free quota left for the first model; the second doesn't take "thinking off".
        if (model === "gemini-3.1-flash-lite") return send(429, { error: { message: "Quota exceeded for metric: free_tier_requests, PerDay" } });
        if (reasoning_effort) return send(400, { error: { message: "reasoning_effort is not supported for this model" } });
        return send(200, { choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });
      }
      send(404, { error: { message: "not found" } });
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

function runSetup(dir, input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, "setup", "setup.mjs"), "--configure-only"], { cwd: dir, env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
}

test("setup with a free Gemini key: checks the key, picks a model that answers, writes private settings, never prints the key", async () => {
  const g = await fakeGemini();
  const dir = mkdtempSync(path.join(os.tmpdir(), "nova-setup-"));
  try {
    mkdirSync(path.join(dir, "setup"));
    for (const f of ["setup.mjs", "lib.mjs"]) copyFileSync(path.join(root, "setup", f), path.join(dir, "setup", f));
    writeFileSync(path.join(dir, ".env.local"), "AI_BASE_URL=http://127.0.0.1:1234/v1\n");
    // Choice 1 (Gemini) → not a key → a wrong key → the right key.
    const { code, out } = await runSetup(dir, `1\nhello there\nAIzaWrongKey_0000000000000000000000\n${GOOD}\n`, { NOVA_SETUP_GEMINI_BASE: g.base });
    assert.equal(code, 0, out);
    assert.match(out, /doesn't look like an API key/);
    assert.match(out, /Google says this key doesn't work/);
    assert.match(out, /✔ The key works\. Nova will use gemini-3\.6-flash\./);
    assert.ok(!out.includes(GOOD), "the key is never shown");
    const env = readFileSync(path.join(dir, ".env.local"), "utf8");
    for (const line of [`AI_BASE_URL=${g.base}`, `AI_API_KEY=${GOOD}`, "AI_PROVIDER=openai-compatible", "AI_PROVIDER_NAME=Google Gemini", "AI_MODEL=gemini-3.6-flash", "AI_MODELS=gemini-3.6-flash", "AI_REASONING_EFFORT=", "MCP_SERVERS=browser", "NOVA_ACTIONS_ENABLED=true", "WORKSPACE_DIR="]) {
      assert.ok(env.split("\n").includes(line), `missing ${line}`);
    }
    assert.ok(!env.startsWith("﻿"), "no byte-order mark (it would break the first setting)");
    if (process.platform !== "win32") assert.equal(statSync(path.join(dir, ".env.local")).mode & 0o777, 0o600, "only this user can read it");
    assert.equal(readFileSync(path.join(dir, ".env.local.before-setup"), "utf8"), "AI_BASE_URL=http://127.0.0.1:1234/v1\n", "old settings kept");
    assert.ok(g.seen.some((s) => s.url === "/chat/completions" && JSON.parse(s.body).model === "gemini-3.1-flash-lite"), "tried the preferred model first");
  } finally {
    g.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup without internet says so plainly and writes nothing", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nova-setup-"));
  try {
    mkdirSync(path.join(dir, "setup"));
    for (const f of ["setup.mjs", "lib.mjs"]) copyFileSync(path.join(root, "setup", f), path.join(dir, "setup", f));
    const { code, out } = await runSetup(dir, `1\n${GOOD}\n`, { NOVA_SETUP_GEMINI_BASE: "http://127.0.0.1:9" });
    assert.equal(code, 1);
    assert.match(out, /Can't reach Google\. Check your internet connection/);
    assert.ok(!existsSync(path.join(dir, ".env.local")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
