#!/usr/bin/env node
// The Nova window: install, start/stop, change the AI, update and uninstall Nova, with buttons instead of a
// command prompt. A small server on this computer only (127.0.0.1, random port, random secret per launch)
// shows setup/app/index.html in a Chrome/Edge app window with the Nova logo.
//   node setup/nova-app.mjs               open the Nova window (and start Nova if it's installed)
//   node setup/nova-app.mjs --background  just start Nova (used when the computer starts)
//   node setup/nova-app.mjs --uninstall   open the window on the uninstall page
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import * as lib from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const page = path.join(lib.root, "setup", "app", "index.html");
const FILES = { "/nova.png": [path.join(lib.root, "setup", "assets", "nova-256.png"), "image/png"], "/favicon.ico": [path.join(lib.root, "setup", "assets", "nova.ico"), "image/x-icon"] };

if (args.has("--background")) {
  await lib.startNova();
  process.exit(0);
}

const secret = randomBytes(24).toString("hex");
let pending = null; // values of the AI check, used by the next install/change
let job = null; // { kind, steps, step, status, error, log, notes }
let lastSeen = Date.now();

function startJob(kind, steps, work) {
  job = { kind, steps, step: 0, status: "running", error: "", log: [], notes: [] };
  const j = job;
  const log = (line) => {
    j.log.push(String(line).slice(0, 300));
    if (j.log.length > 200) j.log.shift();
  };
  const next = (i) => (j.step = i);
  work({ log, next, note: (n) => j.notes.push(n) })
    .then((err) => {
      j.status = err ? "failed" : "done";
      j.error = err || "";
    })
    .catch((e) => {
      j.status = "failed";
      j.error = `Something went wrong: ${e.message}`;
    });
}

async function state() {
  const latest = lib.isDevCopy() ? null : await lib.latestVersion();
  return {
    installed: lib.isInstalled(),
    settings: lib.readSettings(),
    running: await lib.isRunning(),
    version: lib.version(),
    latest,
    updateAvailable: !!latest && lib.newer(latest, lib.version()),
    devCopy: lib.isDevCopy(),
    platform: process.platform,
    extensionFolder: path.join(lib.root, "chrome-extension"),
    job,
    page: args.has("--uninstall") ? "uninstall" : null,
  };
}

async function api(route, body) {
  switch (route) {
    case "state":
      return state();
    case "check": {
      const r = body.provider === "lmstudio" ? await lib.checkLmStudio() : await lib.checkGemini(body.key);
      pending = r.ok ? r.values : null;
      return { ok: r.ok, error: r.error || "", model: r.model || "" };
    }
    case "install":
      if (!pending) return { ok: false, error: "Check the AI first." };
      if (job?.status === "running") return { ok: false, error: "Nova is busy. Wait for it to finish." };
      startJob("install", ["Saving your settings", "Downloading Nova's parts", "Building Nova", "Adding the Nova shortcuts", "Starting Nova"], async ({ log, next, note }) => {
        lib.writeEnv(pending);
        next(1);
        if (!(await lib.installPackages(log))) return "Downloading Nova's parts failed. Check your internet connection and try again.";
        next(2);
        if (!(await lib.build(log))) return "Building Nova failed. Try again; if it keeps failing, send the details to whoever gave you Nova.";
        next(3);
        lib.createShortcuts({ autostart: body.autostart !== false }).forEach((s) => note(s));
        next(4);
        if (!(await lib.startNova())) return "Nova was installed but didn't start. Click Start Nova.";
        next(5);
        return null;
      });
      return { ok: true };
    case "change-ai":
      if (!pending) return { ok: false, error: "Check the AI first." };
      lib.writeEnv(pending);
      await lib.stopNova();
      return { ok: await lib.startNova() };
    case "start":
      return { ok: await lib.startNova() };
    case "stop":
      return { ok: await lib.stopNova() };
    case "update":
      if (job?.status === "running") return { ok: false, error: "Nova is busy. Wait for it to finish." };
      if (lib.isDevCopy()) return { ok: false, error: "This is a developer copy: update it with git pull." };
      startJob("update", ["Stopping Nova", "Downloading the newest Nova", "Downloading Nova's parts", "Building Nova", "Starting Nova"], async ({ log, next }) => {
        await lib.stopNova();
        next(1);
        const d = await lib.downloadUpdate(log);
        if (!d.ok) return d.error;
        next(2);
        if (!(await lib.installPackages(log))) return "Downloading Nova's parts failed. Check your internet connection and try again.";
        next(3);
        if (!(await lib.build(log))) return "Building Nova failed. Try updating again.";
        lib.createShortcuts({ autostart: false });
        next(4);
        if (!(await lib.startNova())) return "Nova was updated but didn't start. Click Start Nova.";
        next(5);
        return null;
      });
      return { ok: true };
    case "uninstall":
      await lib.uninstall({ removeFiles: body.removeFiles === true });
      setTimeout(() => process.exit(0), 1500); // the window shows "Removed" first
      return { ok: true, filesRemoved: body.removeFiles === true && !lib.isDevCopy() };
    case "open":
      return { ok: lib.open(body.what === "key" ? "https://aistudio.google.com/apikey" : body.what === "node" ? "https://nodejs.org/en/download" : body.what === "folder" ? "folder" : "extensions") };
    case "bye":
      setTimeout(() => (job?.status === "running" ? null : process.exit(0)), 300);
      return { ok: true };
    default:
      return null;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  // Only this window: the exact address (no other host names) and, for actions, the secret.
  if (req.headers.host !== `127.0.0.1:${server.address().port}`) {
    res.writeHead(403).end();
    return;
  }
  lastSeen = Date.now();
  if (req.method === "GET" && (url.pathname === "/" || FILES[url.pathname])) {
    const [file, type] = url.pathname === "/" ? [page, "text/html; charset=utf-8"] : FILES[url.pathname];
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline' 'self'; script-src 'unsafe-inline' 'self'; img-src 'self'" });
    res.end(readFileSync(file));
    return;
  }
  const m = /^\/api\/([a-z-]+)$/.exec(url.pathname);
  if (!m || req.method !== "POST" || req.headers["x-nova-secret"] !== secret) {
    res.writeHead(m ? 403 : 404).end();
    return;
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) return res.writeHead(413).end();
  }
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    /* empty */
  }
  const out = await api(m[1], body);
  if (out === null) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(out));
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const address = `http://127.0.0.1:${server.address().port}/#${secret}`;
mkdirSync(lib.dataDir, { recursive: true });
writeFileSync(path.join(lib.dataDir, "window.json"), JSON.stringify({ pid: process.pid }));

if (lib.isInstalled()) lib.startNova(); // opening Nova's window also starts Nova

if (lib.testing) {
  process.stdout.write(`NOVA_APP_URL=${address}\n`);
} else {
  const browser = lib.findBrowser();
  if (browser) {
    // Its own small window (no tabs or address bar), with a separate profile so it never touches your Chrome
    // (kept outside the Nova folder, so uninstalling can delete that folder while the window is open).
    spawn(browser, [`--app=${address}`, `--user-data-dir=${path.join(os.tmpdir(), "nova-ai-window")}`, "--no-first-run", "--no-default-browser-check", "--window-size=760,720"], { detached: true, stdio: "ignore" }).unref();
  } else lib.open(address);
}

// Closes itself when the window has been closed for a while (and nothing is running).
setInterval(() => {
  if (Date.now() - lastSeen > 25_000 && job?.status !== "running") process.exit(0);
}, 5_000).unref?.();
