// Smoke test for a running Syntaz AI instance (uses the real configured provider).
// Usage: node scripts/smoke-test.mjs [baseUrl]   (default http://127.0.0.1:3000)
// If BASIC_AUTH_USER/BASIC_AUTH_PASSWORD are set in your shell, they are used.
const base = (process.argv[2] ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const auth =
  process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASSWORD
    ? { Authorization: "Basic " + Buffer.from(`${process.env.BASIC_AUTH_USER}:${process.env.BASIC_AUTH_PASSWORD}`).toString("base64") }
    : {};
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};

try {
  const page = await fetch(base + "/", { headers: auth });
  check("home page loads", page.status === 200, `HTTP ${page.status}`);
  check("CSP header present", !!page.headers.get("content-security-policy"));

  const statusRes = await fetch(base + "/api/status", { headers: auth });
  const status = await statusRes.json();
  check("provider reachable", statusRes.ok, statusRes.ok ? `${status.provider?.name}: ${status.model}` : status.error);

  if (statusRes.ok) {
    const started = Date.now();
    const res = await fetch(base + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ messages: [{ role: "user", content: "Reply with exactly one word: pong" }], options: { maxTokens: 20, temperature: 0 } }),
    });
    if (!res.ok) {
      check("chat reply", false, (await res.json()).error);
    } else {
      const events = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const text = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
      const errored = events.find((e) => e.type === "error");
      check("chat reply streams", !errored && events.at(-1)?.type === "done", errored?.message ?? `"${text.trim().slice(0, 40)}" in ${Date.now() - started} ms`);
    }
  }

  const bad = await fetch(base + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: '{"messages":[]}' });
  check("invalid request rejected", bad.status === 400, `HTTP ${bad.status}`);
} catch (err) {
  check("server reachable", false, err.message);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nAll smoke checks passed");
process.exit(failed ? 1 : 0);
