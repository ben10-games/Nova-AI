// The Syntaz AI website (website/) in real Chrome, served over HTTP like GitHub Pages serves it. Google's
// Gemini API is a local stand-in: Chrome maps generativelanguage.googleapis.com to it (HTTPS with a throwaway
// certificate), so the chat's real request code, CORS and its Content-Security-Policy all apply.
// NOVA_SITE_SHOTS=<folder> also saves screenshots of every page.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.join(root, "website");
const CHROME = process.env.NOVA_TEST_CHROME_BIN;
const SHOTS = process.env.NOVA_SITE_SHOTS;
const GOOD = "AQ.SiteTestKey_abcdefghijklmnopqrstuvwxyz0123";
const PAGES = ["index.html", "features.html", "download.html", "chat.html", "safety.html", "faq.html", "changelog.html"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let tmp, gemini, web, base, browser, page;
const seen = [];
let next = []; // scripted answers for streamGenerateContent: { status, body } or { chunks: [...] }
const sse = (chunks) => chunks.map((t) => `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: t }] } }] })}\r\n\r\n`).join("");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".svg": "image/svg+xml", ".css": "text/css" };

before(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "syntaz-site-test-"));
  spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(tmp, "k.pem"), "-out", path.join(tmp, "c.pem"), "-days", "1", "-subj", "/CN=generativelanguage.googleapis.com"], { stdio: "ignore" });
  gemini = https.createServer({ key: readFileSync(path.join(tmp, "k.pem")), cert: readFileSync(path.join(tmp, "c.pem")) }, (req, res) => {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type,x-goog-api-key", "Access-Control-Allow-Methods": "GET,POST" };
    if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ url: req.url, key: req.headers["x-goog-api-key"], body });
      if (req.headers["x-goog-api-key"] !== GOOD) return res.writeHead(400, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key." } }));
      if (req.method === "GET") return res.writeHead(200, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify({ models: [] }));
      const n = next.shift() ?? { chunks: ["Hello from the stand-in."] };
      if (n.status) return res.writeHead(n.status, { ...cors, "Content-Type": "application/json" }).end(n.body);
      res.writeHead(200, { ...cors, "Content-Type": "text/event-stream" });
      res.end(sse(n.chunks));
    });
  });
  await new Promise((r) => gemini.listen(0, "127.0.0.1", r));
  // A plain static server, like GitHub Pages.
  web = http.createServer((req, res) => {
    const file = path.join(site, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html");
    if (!file.startsWith(site) || !existsSync(file)) return res.writeHead(404).end("not found");
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  await new Promise((r) => web.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${web.address().port}`;
  const { default: puppeteer } = await import("puppeteer-core");
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-first-run", `--host-resolver-rules=MAP generativelanguage.googleapis.com 127.0.0.1:${gemini.address().port}`, "--ignore-certificate-errors", `--user-data-dir=${path.join(tmp, "profile")}`],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
});

after(async () => {
  await browser?.close();
  gemini?.close();
  web?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function waitFor(fn, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {
      /* not yet */
    }
    await sleep(150);
  }
  throw new Error("timed out waiting");
}
// What is really on screen (a CSS rule can override the hidden attribute).
const visible = (sel) => page.$eval(sel, (e) => e.getClientRects().length > 0);
const idle = () => waitFor(async () => !(await visible("#stop")) && (await visible("#send")));
const shot = (name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: !name.includes("chat") }) : null);

test("the site has all seven pages, every link between them works, and nothing is left from the design tool", () => {
  assert.deepEqual(readdirSync(site).filter((f) => f.endsWith(".html")).sort(), [...PAGES].sort());
  for (const p of PAGES) {
    const html = readFileSync(path.join(site, p), "utf8");
    assert.ok(!/\{\{|<sc-|\.dc\.html|support\.js|vendor\//.test(html), `${p}: design-tool leftovers`);
    for (const [, href] of html.matchAll(/href="([^"#:]+\.html)(#[^"]*)?"/g)) assert.ok(PAGES.includes(href), `${p} links to missing ${href}`);
    assert.match(html, /<meta name="viewport"/, `${p}: phone-ready`);
  }
});

test("every page loads without errors, fits a phone screen, and has light and dark themes", async () => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  for (const width of [1280, 390]) {
    await page.setViewport({ width, height: 860 });
    for (const theme of ["dark", "light"]) {
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
      for (const p of PAGES) {
        await page.goto(`${base}/${p}`);
        assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme, `${p} follows the computer's theme`);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        assert.ok(over <= 0, `${p} at ${width}px is ${over}px too wide`);
        await shot(`${p.replace(".html", "")}-${width}-${theme}`);
      }
    }
  }
  assert.deepEqual(errors, []);
  await page.setViewport({ width: 1280, height: 900 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
});

test("the theme button switches, and the choice carries over to other pages", async () => {
  await page.goto(`${base}/index.html`);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  await page.click("[data-theme-toggle]");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".site")).backgroundColor), "rgb(255, 255, 255)");
  await page.goto(`${base}/faq.html`);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
  await page.click("[data-theme-toggle]");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
});

test("Download: the steps start on the visitor's computer and the tabs switch them", async () => {
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36");
  await page.goto(`${base}/download.html`);
  const shown = () => page.$$eval("[data-panel]", (ps) => ps.filter((p) => p.getClientRects().length > 0).map((p) => p.dataset.panel));
  assert.deepEqual(await shown(), ["win"]);
  assert.equal(await page.$eval('[data-tab="win"]', (b) => b.getAttribute("aria-pressed")), "true");
  await page.click('[data-tab="mac"]');
  assert.deepEqual(await shown(), ["mac"]);
  assert.match(await page.$eval('[data-panel="mac"]', (p) => p.textContent), /Open Anyway/);
  await page.click('[data-tab="lite"]');
  assert.deepEqual(await shown(), ["lite"]);
  const links = await page.$$eval("a[href*='releases/latest/download']", (a) => [...new Set(a.map((x) => x.href.split("/").pop()))].sort());
  assert.deepEqual(links, ["Syntaz-Lite.html", "Syntaz-for-Mac.zip", "Syntaz-for-Windows.zip"]);
  await page.setUserAgent(await browser.userAgent());
});

test("Chat: asks for a key, checks it with Google, then chats for real (streamed, safe Markdown)", async () => {
  await page.goto(`${base}/chat.html`);
  assert.equal(await visible("#setup"), true);
  assert.equal(await visible("#cancelSetup"), false, "nothing to go back to on a first visit");
  assert.equal(await visible("#app"), false);
  await page.type("#k", "nope");
  await page.click("#start");
  await waitFor(async () => /doesn't look like a Gemini key/.test(await page.$eval("#keyMsg", (e) => e.textContent)));
  await page.$eval("#k", (i) => (i.value = ""));
  await page.type("#k", "AQ.WrongKey_000000000000000000000000000");
  await page.click("#start");
  await waitFor(async () => /This key doesn't work/.test(await page.$eval("#keyMsg", (e) => e.textContent)));
  await page.$eval("#k", (i) => (i.value = ""));
  await page.type("#k", GOOD);
  await page.click("#start");
  await waitFor(() => visible("#app"));
  assert.match(await page.$eval("#msgs", (e) => e.textContent), /Hi! What should Syntaz do\?/);
  // A suggestion fills the box.
  await page.evaluate(() => [...document.querySelectorAll(".sugg")].find((b) => b.textContent === "Quiz me").click());
  assert.match(await page.$eval("#msg", (e) => e.value), /^Quiz me with 5 questions/);
  await page.$eval("#msg", (e) => (e.value = ""));
  // A real (stand-in) answer, streamed in, shown as Markdown; text from the AI can't run code.
  next.push({ chunks: ["391.\n\n**Bold** and `code`\n\n", "```js\nlet x = 1;\n```\n", '<img src=x onerror="window.hacked=1">'] });
  await page.click("#msg");
  await page.keyboard.type("what is 17 times 23?");
  await page.keyboard.press("Enter");
  await idle();
  const html = await page.evaluate(() => [...document.querySelectorAll(".ans")].pop().innerHTML);
  assert.match(html, /<p>391\.<\/p>/);
  assert.match(html, /<strong>Bold<\/strong> and <code>code<\/code>/);
  assert.match(html, /Copy code<\/button><\/div><pre><code>let x = 1;<\/code><\/pre>/);
  assert.match(html, /&lt;img src=x onerror=/);
  assert.equal(await page.evaluate(() => window.hacked), undefined);
  const req = JSON.parse(seen.filter((s) => s.url.includes("streamGenerateContent")).at(-1).body);
  assert.equal(req.contents.at(-1).parts[0].text, "what is 17 times 23?");
  assert.match(seen.at(-1).url, /gemini-3\.1-flash-lite:streamGenerateContent/);
  assert.equal(await page.$eval("#chatTitle", (e) => e.textContent), "what is 17 times 23?");
  await shot("chat-conversation-1280-dark");
});

test("Chat: a used-up daily limit is explained with Retry; chats are saved in this browser", async () => {
  next.push({ status: 429, body: JSON.stringify({ error: { message: "Quota exceeded for metric: GenerateRequestsPerDayPerProjectPerModel-FreeTier" } }) });
  await page.click("#msg");
  await page.keyboard.type("and 18 times 23?");
  await page.keyboard.press("Enter");
  await waitFor(async () => /Today's free limit for this model is used up/.test(await page.$eval("#msgs", (e) => e.textContent)));
  next.push({ chunks: ["414."] });
  await page.evaluate(() => [...document.querySelectorAll(".err button")].pop().click());
  await waitFor(async () => /414\./.test(await page.$eval("#msgs", (e) => e.textContent)) && (await idle().then(() => true)));
  assert.equal((await page.$$eval(".bub-u", (b) => b.map((x) => x.textContent))).join("|"), "what is 17 times 23?|and 18 times 23?");
  await page.reload();
  await waitFor(() => visible("#app"));
  assert.deepEqual(await page.$$eval("#chatList .open", (b) => b.map((x) => x.textContent)), ["what is 17 times 23?"]);
  await page.click("#chatList .open");
  assert.match(await page.$eval("#msgs", (e) => e.textContent), /391\.[\s\S]*414\./);
  // Only Google is ever contacted with the key.
  assert.ok(seen.every((s) => !s.key || s.key === GOOD || s.key.startsWith("AQ.Wrong")));
});
