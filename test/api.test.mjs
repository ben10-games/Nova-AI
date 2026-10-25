// Integration tests: run the production build against a mock provider.
// Usage: npm run build && npm test
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { MOCK_KEY, startMockProvider } from "./mock-provider.mjs";

import { basic, chatBody, freePort, json, root, startApp } from "./helpers.mjs";

async function readEvents(res) {
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

let mock, app, limited, misconfigured;

before(async () => {
  mock = await startMockProvider();
  const common = {
    AI_BASE_URL: mock.url,
    AI_API_KEY: MOCK_KEY,
    AI_PROVIDER: "openai-compatible",
    AI_PROVIDER_NAME: "Mock AI",
    AI_MODEL: "",
    AI_MODELS: "",
    LMSTUDIO_BASE_URL: "",
    LMSTUDIO_MODEL: "",
  };
  [app, limited, misconfigured] = await Promise.all([
    startApp({ ...common, AI_MAX_OUTPUT_TOKENS: "256", AI_TIMEOUT_MS: "1500", RATE_LIMIT_MAX: "1000", RATE_LIMIT_CONCURRENT: "1", BASIC_AUTH_USER: "", BASIC_AUTH_PASSWORD: "" }),
    startApp({ ...common, RATE_LIMIT_MAX: "3", RATE_LIMIT_WINDOW_MS: "60000", TRUST_PROXY: "true", BASIC_AUTH_USER: "admin", BASIC_AUTH_PASSWORD: "correct horse" }),
    startApp({ ...common, AI_BASE_URL: "", BASIC_AUTH_USER: "", BASIC_AUTH_PASSWORD: "" }),
  ]);
});

after(() => {
  for (const a of [app, limited, misconfigured]) a?.child.kill();
  mock?.server.close();
});

describe("provider configuration", () => {
  test("status reports provider and discovered chat models without leaking URL or key", async () => {
    const res = await fetch(app.base + "/api/status");
    assert.equal(res.status, 200);
    const text = await res.text();
    const data = JSON.parse(text);
    assert.deepEqual(data.provider, { name: "Mock AI", kind: "openai-compatible" });
    assert.deepEqual(data.models.map((m) => m.id), ["mock-chat-large", "mock-chat-small"]);
    assert.equal(data.model, "mock-chat-large");
    assert.ok(!text.includes(MOCK_KEY) && !text.includes(mock.url) && !text.includes("127.0.0.1"));
  });

  test("chat streams, sends the API key server-side and applies the output-token cap", async () => {
    const res = await fetch(app.base + "/api/chat", { method: "POST", headers: json, body: chatBody("hi", { options: { maxTokens: 5000, model: "mock-chat-small" } }) });
    assert.equal(res.status, 200);
    const events = await readEvents(res);
    assert.equal(events.filter((e) => e.type === "delta").map((e) => e.text).join(""), "Hello from mock");
    assert.equal(events.at(-1).type, "done");
    const sent = mock.seen.chatBodies.at(-1);
    assert.equal(sent.model, "mock-chat-small");
    assert.equal(sent.max_tokens, 256, "AI_MAX_OUTPUT_TOKENS must cap the browser's request");
    assert.equal(sent.messages[0].role, "system");
    assert.equal(mock.seen.auth.at(-1), `Bearer ${MOCK_KEY}`);
  });

  test("a picture on the last message reaches the model as an image part; anything else is refused", async () => {
    const IMG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP////////////////////////8=";
    const post = (messages) => fetch(app.base + "/api/chat", { method: "POST", headers: json, body: JSON.stringify({ messages }) });
    const res = await post([{ role: "user", content: "What is in this picture?", images: [IMG] }]);
    assert.equal(res.status, 200);
    await readEvents(res);
    const sent = mock.seen.chatBodies.at(-1).messages.at(-1);
    assert.deepEqual(sent.content, [{ type: "text", text: "What is in this picture?" }, { type: "image_url", image_url: { url: IMG } }]);
    let bad = await post([{ role: "user", content: "a", images: [IMG] }, { role: "assistant", content: "b" }, { role: "user", content: "c" }]);
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /Only the last user message may include one image/);
    bad = await post([{ role: "user", content: "x", images: ["https://example.com/a.png"] }]);
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /JPEG or PNG data URL/);
    bad = await post([{ role: "user", content: "x", images: [IMG, IMG] }]);
    assert.equal(bad.status, 400);
  });

  test("model outside the discovered list is rejected", async () => {
    const res = await fetch(app.base + "/api/chat", { method: "POST", headers: json, body: chatBody("hi", { options: { model: "gpt-expensive" } }) });
    assert.equal(res.status, 400);
  });

  test("missing AI_BASE_URL in production fails safely instead of defaulting to localhost", async () => {
    const status = await fetch(misconfigured.base + "/api/status");
    assert.equal(status.status, 503);
    const res = await fetch(misconfigured.base + "/api/chat", { method: "POST", headers: json, body: chatBody("hi") });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /not configured/);
    assert.match(misconfigured.logs(), /AI_BASE_URL is not set/);
  });
});

describe("secrets never reach the browser", () => {
  test("client bundle and HTML contain no API key, provider URL or server env names", async () => {
    const files = [];
    const walk = (d) => readdirSync(d).forEach((f) => (statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f)) : files.push(path.join(d, f))));
    walk(path.join(root, ".next", "static"));
    const html = await (await fetch(app.base + "/")).text();
    for (const content of [html, ...files.map((f) => readFileSync(f, "utf8"))]) {
      for (const needle of [MOCK_KEY, mock.url, "AI_API_KEY", "AI_BASE_URL", "127.0.0.1:1234", "BASIC_AUTH_PASSWORD"]) {
        assert.ok(!content.includes(needle), `found ${needle} in browser-facing output`);
      }
    }
  });

  test("provider auth errors are reported without echoing the key", async () => {
    const res = await fetch(app.base + "/api/chat", { method: "POST", headers: json, body: chatBody("PROVIDER_401") });
    const text = await res.text();
    assert.equal(res.status, 502);
    assert.ok(!text.includes(MOCK_KEY));
    assert.match(text, /rejected the server's credentials/);
  });

  test("provider 5xx errors don't reveal internal URLs", async () => {
    const res = await fetch(app.base + "/api/chat", { method: "POST", headers: json, body: chatBody("PROVIDER_500") });
    const text = await res.text();
    assert.equal(res.status, 502);
    assert.ok(!text.includes("10.0.0.5") && !text.includes("secret-path"), text);
  });
});

describe("request validation", () => {
  const cases = [
    ["invalid role", JSON.stringify({ messages: [{ role: "system", content: "x" }] }), 400],
    ["empty messages", JSON.stringify({ messages: [] }), 400],
    ["malformed JSON", "{oops", 400],
    ["last message from assistant", JSON.stringify({ messages: [{ role: "assistant", content: "x" }] }), 400],
    ["temperature out of range", chatBody("x", { options: { temperature: 9 } }), 400],
    ["non-integer maxTokens", chatBody("x", { options: { maxTokens: 1.5 } }), 400],
    ["oversized message", chatBody("a".repeat(130_000)), 400],
    ["oversized body", chatBody("a".repeat(1_100_000)), 413],
  ];
  for (const [name, body, status] of cases) {
    test(name, async () => {
      const res = await fetch(app.base + "/api/chat", { method: "POST", headers: json, body });
      assert.equal(res.status, status);
      assert.ok((await res.json()).error);
    });
  }

  test("wrong content type", async () => {
    const res = await fetch(app.base + "/api/chat", { method: "POST", body: "x" });
    assert.equal(res.status, 415);
  });

  test("cross-site requests are rejected", async () => {
    const a = await fetch(app.base + "/api/chat", { method: "POST", headers: { ...json, Origin: "https://evil.example" }, body: chatBody("hi") });
    const b = await fetch(app.base + "/api/chat", { method: "POST", headers: { ...json, "Sec-Fetch-Site": "cross-site" }, body: chatBody("hi") });
    assert.equal(a.status, 403);
    assert.equal(b.status, 403);
  });

  test("GET on the chat endpoint is not allowed", async () => {
    assert.equal((await fetch(app.base + "/api/chat")).status, 405);
  });
});

describe("timeouts, cancellation and concurrency", () => {
  test("slow provider times out with 504", async () => {
    const res = await fetch(app.base + "/api/chat", { method: "POST", headers: json, body: chatBody("HANG") });
    assert.equal(res.status, 504);
  });

  test("client abort cancels the provider request", async () => {
    const before = mock.seen.aborted;
    const ctrl = new AbortController();
    const res = await fetch(app.base + "/api/chat", { method: "POST", headers: json, body: chatBody("SLOW"), signal: ctrl.signal });
    const reader = res.body.getReader();
    await reader.read();
    ctrl.abort();
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(mock.seen.aborted, before + 1);
  });

  test("a second simultaneous reply for the same client is refused", async () => {
    await new Promise((r) => setTimeout(r, 300)); // let the previous slot release
    const first = await fetch(app.base + "/api/chat", { method: "POST", headers: json, body: chatBody("SLOW") });
    const second = await fetch(app.base + "/api/chat", { method: "POST", headers: json, body: chatBody("hi") });
    assert.equal(second.status, 429);
    await first.text();
    const third = await fetch(app.base + "/api/chat", { method: "POST", headers: json, body: chatBody("hi") });
    assert.equal(third.status, 200);
    await third.text();
  });
});

describe("rate limiting and access protection", () => {
  const auth = { Authorization: basic("admin", "correct horse") };

  test("basic auth blocks pages and API without credentials", async () => {
    for (const p of ["/", "/api/status"]) {
      const res = await fetch(limited.base + p);
      assert.equal(res.status, 401);
      assert.match(res.headers.get("www-authenticate"), /Basic/);
    }
    const wrong = await fetch(limited.base + "/", { headers: { Authorization: basic("admin", "wrong") } });
    assert.equal(wrong.status, 401);
    assert.equal((await fetch(limited.base + "/", { headers: auth })).status, 200);
  });

  test("per-client limit returns 429 with Retry-After, other clients unaffected", async () => {
    const send = (ip) =>
      fetch(limited.base + "/api/chat", { method: "POST", headers: { ...json, ...auth, "X-Forwarded-For": ip }, body: chatBody("hi") });
    for (let i = 0; i < 3; i++) {
      const ok = await send("203.0.113.1");
      assert.equal(ok.status, 200);
      await ok.text();
    }
    const blocked = await send("203.0.113.1");
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
    const other = await send("203.0.113.2");
    assert.equal(other.status, 200);
    await other.text();
  });
});

describe("security headers", () => {
  test("CSP and hardening headers are set", async () => {
    const res = await fetch(app.base + "/");
    const csp = res.headers.get("content-security-policy");
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /connect-src 'self'(;|$)/);
    assert.doesNotMatch(csp, /unsafe-eval/);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.ok(res.headers.get("strict-transport-security"));
    assert.equal(res.headers.get("x-powered-by"), null);
  });
});
