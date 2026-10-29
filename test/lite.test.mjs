// Nova Lite (lite/Nova Lite.html) in real Chrome, opened as a local file. Google's Gemini API is a local
// stand-in: Chrome maps generativelanguage.googleapis.com to it (HTTPS with a throwaway certificate), so the
// page's real request code, CORS and its Content-Security-Policy all apply.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.NOVA_TEST_CHROME_BIN;
const GOOD = "AQ.LiteTestKey_abcdefghijklmnopqrstuvwxyz0123";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let tmp, server, browser, page;
const seen = [];
let next = []; // scripted answers for streamGenerateContent: { status, body } or { chunks: [...] }

const sse = (chunks) => chunks.map((t) => `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: t }] } }] })}\r\n\r\n`).join("");

before(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "nova-lite-test-"));
  spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(tmp, "k.pem"), "-out", path.join(tmp, "c.pem"), "-days", "1", "-subj", "/CN=generativelanguage.googleapis.com"], { stdio: "ignore" });
  server = https.createServer({ key: readFileSync(path.join(tmp, "k.pem")), cert: readFileSync(path.join(tmp, "c.pem")) }, (req, res) => {
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
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { default: puppeteer } = await import("puppeteer-core");
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-first-run", `--host-resolver-rules=MAP generativelanguage.googleapis.com 127.0.0.1:${server.address().port}`, "--ignore-certificate-errors", `--user-data-dir=${path.join(tmp, "profile")}`],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 800 });
});

after(async () => {
  await browser?.close();
  server?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const lite = () => `file://${path.join(root, "lite", "Nova Lite.html")}`;
const visible = (sel) => page.$eval(sel, (e) => !e.hidden);
const lastAnswer = () => page.evaluate(() => [...document.querySelectorAll(".msg.ai .b")].pop()?.innerHTML ?? "");
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
async function say(text) {
  await page.click("#input");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}
const idle = () => waitFor(() => page.$eval("#stop", (b) => b.hidden));

test("first open: asks for a key, checks it with Google, remembers it", async () => {
  await page.goto(lite());
  assert.equal(await visible("#setup"), true);
  await page.type("#key", "nope");
  await page.click("#saveKey");
  await waitFor(async () => /doesn't look like an API key/.test(await page.$eval("#keyMsg", (e) => e.textContent)));
  await page.$eval("#key", (i) => (i.value = ""));
  await page.type("#key", "AQ.WrongKey_000000000000000000000000000");
  await page.click("#saveKey");
  await waitFor(async () => /key doesn.t work/.test(await page.$eval("#keyMsg", (e) => e.textContent)));
  await page.$eval("#key", (i) => (i.value = ""));
  await page.type("#key", GOOD);
  await page.click("#saveKey");
  await waitFor(() => visible("#app"));
  await page.reload();
  await waitFor(() => visible("#app")); // remembered
});

test("answers stream in, Markdown is shown, and the AI's text can't run code in the page", async () => {
  next.push({ chunks: ["391.\n\n**Bold** and `code`\n\n", "```\nlet x = 1;\n```\n", "5. fifth\n6. sixth\n\n", '<img src=x onerror="window.hacked=1"><script>window.hacked=2</script>'] });
  await say("hi");
  await idle();
  const html = await lastAnswer();
  assert.match(html, /<b>Bold<\/b> and <code>code<\/code>/);
  assert.match(html, /<pre><code>let x = 1;<\/code><button class="copycode">Copy<\/button><\/pre>/, "code blocks have their own Copy button");
  assert.match(html, /^<p>391\.<\/p>/, "a number alone on a line stays (it isn't an empty list item)");
  assert.match(html, /<ol><li value="5">fifth<\/li><li value="6">sixth<\/li><\/ol>/, "numbered lists keep their numbers");
  assert.match(html, /&lt;img src=x onerror=/, "HTML from the AI is shown as text");
  assert.equal(await page.evaluate(() => window.hacked), undefined);
  const req = JSON.parse(seen.filter((s) => s.url.includes("streamGenerateContent")).at(-1).body);
  assert.equal(req.contents.at(-1).parts[0].text, "hi");
  assert.match(req.systemInstruction.parts[0].text, /You are Nova/);
  assert.deepEqual(req.generationConfig.thinkingConfig, { thinkingBudget: 0 }, "Flash-Lite: thinking off (fast)");
  assert.match(seen.at(-1).url, /gemini-3\.1-flash-lite:streamGenerateContent\?alt=sse/);
});

test("a picture goes to Gemini (made smaller, JPEG) and shows in the chat", async () => {
  const png = path.join(tmp, "pic.png");
  // A real 2000x1000 PNG, made by Chrome itself.
  const dataUrl = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 2000; c.height = 1000; c.getContext("2d").fillRect(0, 0, 50, 50); return c.toDataURL("image/png"); });
  writeFileSync(png, Buffer.from(dataUrl.split(",")[1], "base64"));
  const input = await page.$("#file");
  await input.uploadFile(png);
  await waitFor(() => page.$eval("#thumbs", (t) => t.children.length === 1));
  next.push({ chunks: ["A black square."] });
  await page.click("#send");
  await idle();
  const req = JSON.parse(seen.filter((s) => s.url.includes("streamGenerateContent")).at(-1).body);
  const parts = req.contents.at(-1).parts;
  assert.equal(parts[0].text, "What is in this picture?");
  assert.equal(parts[1].inline_data.mime_type, "image/jpeg");
  const size = await page.evaluate((d) => new Promise((r) => { const i = new Image(); i.onload = () => r([i.width, i.height]); i.src = `data:image/jpeg;base64,${d}`; }), parts[1].inline_data.data);
  assert.deepEqual(size, [1600, 800]);
  assert.equal(await page.$$eval(".msg.user img", (i) => i.length), 1);
});

test("free-tier limits: Nova waits when Google asks, and says plainly when today's limit is used up", async () => {
  next.push({ status: 429, body: JSON.stringify({ error: { message: "Resource exhausted", details: [{ retryDelay: "1s" }] } }) }, { chunks: ["After waiting."] });
  await say("again");
  await waitFor(async () => /wait 1 seconds/.test(await lastAnswer()));
  await idle();
  assert.match(await lastAnswer(), /After waiting\./);
  next.push({ status: 429, body: JSON.stringify({ error: { message: "Quota exceeded, GenerateRequestsPerDayPerProjectPerModel-FreeTier" } }) });
  await say("and again");
  await idle();
  assert.match(await lastAnswer(), /Today's free limit for this model is used up/);
  assert.ok(await page.$(".msg.ai:last-child button"), "with a Retry button");
});

test("chats are saved in the browser (without the pictures) and can be reopened and deleted", async () => {
  await page.click("#newChat");
  await page.reload();
  await waitFor(() => visible("#app"));
  assert.equal(await visible("#chats"), true, "on a wide screen the chats are always shown");
  const titles = await page.$$eval("#chatList .open", (b) => b.map((x) => x.textContent));
  assert.equal(titles[0], "hi");
  await page.click("#chatList .open");
  await waitFor(async () => /A black square\./.test(await page.$eval("#list", (l) => l.innerText)));
  assert.match(await page.$eval("#list", (l) => l.innerText), /1 picture\(s\) \(not saved\)/);
  const stored = await page.evaluate(() => localStorage.getItem("nova-lite:chats"));
  assert.ok(!stored.includes("base64") && stored.length < 5_000, "no picture data in storage");
  await page.click("#chatList .chat button.icon");
  assert.equal(await page.$$eval("#chatList .open", (b) => b.length), 0);
});

test("the page talks to no one but Google (Content-Security-Policy)", async () => {
  const blocked = await page.evaluate(() => fetch("https://example.com/").then(() => "sent", () => "blocked"));
  assert.equal(blocked, "blocked");
});
