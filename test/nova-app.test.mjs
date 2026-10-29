// The Nova window (setup/nova-app.mjs) in real Chrome, on a fresh copy of Nova (as GitHub's ZIP has it):
// install with a (stand-in) Gemini key, Nova running, shortcuts with the logo, stop/start, update, uninstall.
// Slow (installs and builds twice): npm run test:installer
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "./helpers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.NOVA_TEST_CHROME_BIN;
const KEY = "AQ.InstallerTestKey_abcdefghijklmnopqrstuvwxyz";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A friend's computer: none of the test-suite settings (e.g. NOVA_NEXT_DIST_DIR) leak into the install.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^NOVA_|^AI_|^MCP_|^LMSTUDIO_/.test(k)));

let tmp, app, home, appProc, url, browser, page, fake, novaPort;
const files = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).stdout.split("\n").filter(Boolean);

before(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "nova-app-test-"));
  app = path.join(tmp, "Nova-AI-main");
  home = path.join(tmp, "home");
  mkdirSync(path.join(home, "Desktop"), { recursive: true });
  for (const f of files) if (existsSync(path.join(root, f))) cpSync(path.join(root, f), path.join(app, f), { recursive: true });
  // A newer Nova for the update test, as GitHub would serve it.
  const zipDir = path.join(tmp, "zip", "Nova-AI-main");
  cpSync(app, zipDir, { recursive: true });
  const pkg = JSON.parse(readFileSync(path.join(zipDir, "package.json"), "utf8"));
  pkg.version = "9.9.9";
  writeFileSync(path.join(zipDir, "package.json"), JSON.stringify(pkg, null, 2));
  writeFileSync(path.join(zipDir, "UPDATED.txt"), "new version");
  spawnSync("python3", ["-I", "-c", "import shutil,sys; shutil.make_archive(sys.argv[1], 'zip', sys.argv[2], 'Nova-AI-main')", path.join(tmp, "update"), path.join(tmp, "zip")]);
  // Stand-ins for Google (key check) and GitHub (version + ZIP).
  fake = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.url === "/version") return res.end(JSON.stringify({ version: "9.9.9" }));
      if (req.url === "/update.zip") return res.end(readFileSync(path.join(tmp, "update.zip")));
      if (req.headers.authorization !== `Bearer ${KEY}`) return res.writeHead(400).end(JSON.stringify({ error: { message: "API key not valid" } }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(req.url.endsWith("/models") ? JSON.stringify({ data: [{ id: "models/gemini-3.1-flash-lite" }] }) : JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
    });
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${fake.address().port}`;
  novaPort = await freePort();
  appProc = spawn(process.execPath, [path.join(app, "setup", "nova-app.mjs")], {
    cwd: app,
    env: { ...cleanEnv(), NOVA_APP_TEST: "1", NOVA_APP_ALLOW_DELETE: "1", NOVA_APP_HOME: home, HOME: home, NOVA_SETUP_GEMINI_BASE: base, NOVA_UPDATE_VERSION_URL: `${base}/version`, NOVA_UPDATE_ZIP: `${base}/update.zip`, NOVA_APP_NOVA_PORT: String(novaPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  url = await new Promise((resolve, reject) => {
    let out = "";
    appProc.stdout.on("data", (d) => {
      out += d;
      const m = /NOVA_APP_URL=(\S+)/.exec(out);
      if (m) resolve(m[1]);
    });
    appProc.on("close", () => reject(new Error(`the Nova window program ended: ${out}`)));
  });
  const { default: puppeteer } = await import("puppeteer-core");
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  page = await browser.newPage();
  await page.setViewport({ width: 760, height: 900 });
});

after(async () => {
  await browser?.close();
  appProc?.kill();
  fake?.close();
  spawnSync(process.execPath, ["-e", `fetch("http://127.0.0.1:${novaPort}/api/pair").catch(()=>{})`]);
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const visible = (id) => page.$eval(`#${id}`, (e) => !e.hidden);
const text = (sel) => page.$eval(sel, (e) => e.innerText);
async function waitFor(fn, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {
      /* not yet */
    }
    await sleep(250);
  }
  throw new Error("timed out waiting");
}

test("only Nova's own window can use it: the secret and the exact address are required", async () => {
  const u = new URL(url);
  const noSecret = await fetch(`${u.origin}/api/state`, { method: "POST" });
  assert.equal(noSecret.status, 403);
  const wrongHost = await new Promise((resolve) => {
    http.request({ host: "127.0.0.1", port: u.port, path: "/", headers: { Host: `localhost:${u.port}` } }, (res) => resolve(res.statusCode)).end();
  });
  assert.equal(wrongHost, 403, "other host names (DNS rebinding) are refused");
});

test("install with buttons: welcome → key check → progress → Nova running, shortcuts with the Nova logo", { timeout: 900_000 }, async () => {
  await page.goto(url);
  await waitFor(() => visible("welcome"));
  assert.equal(await page.$eval("header img", (i) => i.naturalWidth > 0), true, "the Nova logo shows");
  await page.click("#startSetup");
  await waitFor(() => visible("choose"));
  assert.equal(await page.$eval("#install", (b) => b.disabled), true, "can't install before the check");
  await page.type("#key", "AQ.WrongKey_000000000000000000000000000");
  await page.click("#check");
  await waitFor(async () => /doesn't work/.test(await text("#checkMsg")));
  assert.equal(await page.$eval("#install", (b) => b.disabled), true);
  await page.$eval("#key", (i) => (i.value = ""));
  await page.type("#key", KEY);
  await page.click("#check");
  await waitFor(async () => /✓ The key works\. Nova will use gemini-3\.1-flash-lite\./.test(await text("#checkMsg")));
  await page.click("#install");
  await waitFor(() => visible("working"));
  await waitFor(async () => /Building Nova/.test(await text("#steps")));
  await waitFor(async () => /Nova is installed ✓/.test(await text("#workTitle")), 600_000);
  assert.equal((await text("#steps")).split("\n").filter((l) => l.startsWith("✓")).length, 5, await text("#steps"));
  await page.click("#workContinue");
  await waitFor(async () => (await visible("home")) && /Nova is running/.test(await text("#runText")), 60_000);
  assert.match(await text("#aiText"), /Google Gemini · gemini-3\.1-flash-lite/);
  assert.equal(await text("#extFolder"), path.join(app, "chrome-extension"));
  // Nova itself answers, with the key from the window's check (never shown on the page).
  const status = await (await fetch(`http://127.0.0.1:${novaPort}/api/pair`)).status;
  assert.equal(status, 403, "Nova is up (pairing only for the extension)");
  assert.ok(readFileSync(path.join(app, ".env.local"), "utf8").includes(`AI_API_KEY=${KEY}`));
  assert.ok(!(await page.content()).includes(KEY), "the key is not in the page");
  // Shortcuts (Linux: menu entry, desktop, start at login) with the Nova logo.
  for (const f of [path.join(home, ".local", "share", "applications", "nova-ai.desktop"), path.join(home, "Desktop", "nova-ai.desktop"), path.join(home, ".config", "autostart", "nova-ai.desktop")]) {
    const d = readFileSync(f, "utf8");
    assert.match(d, new RegExp(`Icon=${path.join(app, "setup", "assets", "nova-256.png").replace(/[.]/g, "\\.")}`));
    assert.match(d, /Name=Nova AI/);
  }
  assert.match(readFileSync(path.join(home, ".config", "autostart", "nova-ai.desktop"), "utf8"), /--background/);
  await page.screenshot({ path: path.join(os.tmpdir(), "nova-window-home.png") });
});

test("stop and start Nova with the button", { timeout: 120_000 }, async () => {
  await page.click("#startStop");
  await waitFor(async () => /Nova is stopped/.test(await text("#runText")), 30_000);
  await page.click("#startStop");
  await waitFor(async () => /Nova is running/.test(await text("#runText")), 60_000);
});

test("update: a newer version is offered and installed; settings are kept", { timeout: 900_000 }, async () => {
  await waitFor(async () => /A new version is ready: 9\.9\.9 \(you have \d+\.\d+\.\d+\)/.test(await text("#updText")));
  await page.click("#update");
  await waitFor(() => visible("working"));
  await waitFor(async () => /Nova is up to date ✓/.test(await text("#workTitle")), 600_000);
  assert.equal(readFileSync(path.join(app, "UPDATED.txt"), "utf8"), "new version");
  assert.ok(readFileSync(path.join(app, ".env.local"), "utf8").includes(`AI_API_KEY=${KEY}`), "the key survived the update");
  await page.click("#workContinue");
  await waitFor(async () => /You have the newest version \(9\.9\.9\)/.test(await text("#updText")) && /Nova is running/.test(await text("#runText")), 60_000);
});

test("uninstall: shortcuts, start-at-login, pairing code and (if chosen) the files are removed", { timeout: 120_000 }, async () => {
  mkdirSync(path.join(home, ".config", "nova-browser"), { recursive: true });
  await page.click("#toUninstall");
  await waitFor(() => visible("uninstall"));
  assert.equal(await page.$eval("#removeFiles", (c) => c.checked), true);
  await page.click("#doUninstall");
  await waitFor(() => visible("removed"));
  for (const f of [path.join(home, ".local", "share", "applications", "nova-ai.desktop"), path.join(home, "Desktop", "nova-ai.desktop"), path.join(home, ".config", "autostart", "nova-ai.desktop"), path.join(home, ".config", "nova-browser")]) {
    assert.ok(!existsSync(f), `${f} removed`);
  }
  await waitFor(async () => {
    try {
      await fetch(`http://127.0.0.1:${novaPort}/api/pair`);
      return false;
    } catch {
      return true;
    }
  }, 30_000);
  await waitFor(() => !existsSync(app), 15_000);
});
