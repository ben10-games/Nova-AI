#!/usr/bin/env node
// Syntaz browser benchmark: runs realistic tasks with YOUR model (from .env.local / LM Studio) in a
// throwaway headless Chrome with the real extension, on local test pages, and checks the real page.
// It starts its own Syntaz on free ports (your running Syntaz is not touched) and needs a production
// build: `npm run build` (or NOVA_NEXT_DIST_DIR=.next-test npm run build while `npm run dev` runs).
//
//   npm run benchmark                     # browser tasks
//   npm run benchmark -- math vision      # other task sets (test/fixtures/benchmark/<name>.json)
//   npm run benchmark -- browser --runs 2 --verbose
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const runs = Number(argv[argv.indexOf("--runs") + 1]) > 0 && argv.includes("--runs") ? Number(argv[argv.indexOf("--runs") + 1]) : 1;
const verbose = argv.includes("--verbose");
const sets = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--runs");
const chrome = process.env.NOVA_TEST_CHROME_BIN || "/usr/bin/google-chrome";
if (!existsSync(chrome)) throw new Error(`Chrome not found at ${chrome} (set NOVA_TEST_CHROME_BIN).`);

const { startApp, freePort } = await import(path.join(root, "test/helpers.mjs"));
const { default: puppeteer } = await import("puppeteer-core");
const EXT_ID = readFileSync(path.join(root, "src/lib/extension-origin.ts"), "utf8").match(/DEFAULT_EXTENSION_ID = "([a-p]{32})"/)[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const site = http.createServer((req, res) => {
  try {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(readFileSync(path.join(root, "test/fixtures/site", path.basename(req.url.split("?")[0]) || "index.html")));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${site.address().port}`;
const tmp = mkdtempSync(path.join(os.tmpdir(), "nova-bench-"));
const tokenFile = path.join(tmp, "token");
const port = await freePort();
const app = await startApp({ MCP_SERVERS: "browser", NOVA_BROWSER_TOKEN_FILE: tokenFile, NOVA_BROWSER_PORT: String(port), WORKSPACE_DIR: "" });
let browser;
const totals = [];
try {
  const status = await (await fetch(app.base + "/api/status", { headers: { Origin: app.base } })).json();
  console.log(`Model: ${status.model ?? "(none loaded!)"}   context: ${status.contextLength ?? "?"}`);
  for (let i = 0; i < 50 && !existsSync(tokenFile); i++) await sleep(100);
  const ext = path.join(tmp, "ext");
  cpSync(path.join(root, "chrome-extension"), ext, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(ext, "manifest.json"), "utf8"));
  manifest.host_permissions = ["<all_urls>"]; // the test pages are local; also lets look_at_page take screenshots
  writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));
  // A normal Chrome user agent: some sites (e.g. DuckDuckGo) show bot checks to the "HeadlessChrome" one,
  // which a real user's Chrome never sends.
  const probe = await puppeteer.launch({ executablePath: chrome, headless: true, pipe: true });
  const ua = (await probe.userAgent()).replace("HeadlessChrome", "Chrome");
  await probe.close();
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, pipe: true, enableExtensions: true, userDataDir: path.join(tmp, "profile"), args: [`--user-agent=${ua}`] });
  await browser.installExtension(ext);
  const page = await browser.newPage();
  const sw = await (await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().includes(EXT_ID))).worker();
  for (let i = 0; i < 50 && !(await sw.evaluate(() => !!globalThis.chrome?.storage).catch(() => false)); i++) await sleep(100);
  await sw.evaluate(async (token, p) => {
    await chrome.storage.local.set({ token, port: p, cursorMs: 150 });
    await chrome.storage.session.set({ intent: true });
    connect();
  }, readFileSync(tokenFile, "utf8").trim(), port);
  await sleep(1500);
  const H = { "Content-Type": "application/json", Origin: app.base };
  for (const set of sets.length ? sets : ["browser"]) {
    const tasks = JSON.parse(readFileSync(path.join(root, "test/fixtures/benchmark", `${set}.json`), "utf8"));
    for (let run = 1; run <= runs; run++) {
      let passed = 0;
      console.log(`\n== ${set}${runs > 1 ? ` (run ${run}/${runs})` : ""}`);
      for (const { page: file, goal, check, handsOff } of tasks) {
        await page.goto(`${base}/${file}`);
        await page.bringToFront();
        await sleep(300);
        const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
        const fullGoal = `${goal}\n\n(The user's current tab: "${await page.title()}" — ${base}/${file}, tab_id ${tabId}. Read it with get_page if needed.)`;
        const t0 = Date.now();
        const res = await fetch(app.base + "/api/agent", { method: "POST", headers: H, body: JSON.stringify({ goal: fullGoal, expectTools: true, focus: "browser", handsOff: handsOff === true }) });
        let runId;
        const calls = new Map();
        const steps = [];
        const dec = new TextDecoder();
        let buf = "";
        for await (const ch of res.body) {
          buf += dec.decode(ch, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const l of lines.filter(Boolean)) {
            const e = JSON.parse(l);
            if (e.type === "run_started") runId = e.runId;
            if (e.type === "tool_call") calls.set(e.callId, `${e.tool.replace("mcp__browser__", "")}(${JSON.stringify(e.arguments)})`);
            if (e.type === "thinking" && verbose) steps.push(`  thought: ${e.thought.replace(/\s+/g, " ").slice(0, 300)}`);
            // The benchmark approves every action (the pages are local test pages).
            if (e.type === "approval_required") await fetch(app.base + "/api/agent/approve", { method: "POST", headers: H, body: JSON.stringify({ runId, callId: e.callId, approved: true }) });
            if (e.type === "tool_result" && verbose && calls.get(e.callId)?.startsWith("work_out")) steps.push(`  working: ${e.output.replace(/\s+/g, " ").slice(0, 400)}`);
            if (e.type === "tool_result") steps.push(`${e.ok ? "ok     " : e.executed ? "FAILED " : "not run"} ${calls.get(e.callId)}${e.ok ? "" : ` → ${e.output.split("\n")[0].slice(0, 140)}`}`);
            if (e.type === "notice" && verbose) steps.push(`  notice: ${e.message.slice(0, 140)}`);
            if ((e.type === "final" || e.type === "error") && verbose) steps.push(`  ${e.type}: ${(e.answer ?? e.message ?? "").replace(/\s+/g, " ").slice(0, 300)}`);
            if (e.type === "done" && verbose) steps.push(`  done: ${e.status}`);
          }
        }
        // Syntaz may have opened the result in a new tab: the task passes if any open tab passes the check.
        let ok = false;
        for (const p of await browser.pages()) if (!p.url().startsWith("chrome-extension://") && (await p.evaluate(check).catch(() => false)) === true) ok = true;
        for (const p of await browser.pages()) if (p !== page && !p.url().startsWith("chrome-extension://")) await p.close().catch(() => {});
        if (ok) passed++;
        const notRun = steps.filter((s) => s.startsWith("not run")).length;
        console.log(`${ok ? "PASS" : "FAIL"}  ${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s  not-run:${notRun}  ${goal}`);
        if (verbose || !ok) for (const s of steps) console.log(`        ${s}`);
      }
      totals.push(`${set}${runs > 1 ? ` #${run}` : ""}: ${passed}/${tasks.length}`);
    }
  }
  console.log(`\nResult: ${totals.join("   ")}`);
} finally {
  await browser?.close().catch(() => {});
  app.child.kill();
  site.close();
  rmSync(tmp, { recursive: true, force: true });
}
