// What Syntaz's installer does, shared by the Syntaz window (nova-app.mjs) and the text setup (setup.mjs).
// Only Node's own modules: this runs before anything is installed.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const win = process.platform === "win32";
export const mac = process.platform === "darwin";
/** Syntaz's own runtime files (process id, log); never shared. */
export const dataDir = path.join(root, ".nova");
// Tests point these at local stand-ins; normal use talks to Google and GitHub over https.
export const GEMINI = process.env.NOVA_SETUP_GEMINI_BASE || "https://generativelanguage.googleapis.com/v1beta/openai";
export const testing = !!process.env.NOVA_SETUP_GEMINI_BASE || process.env.NOVA_APP_TEST === "1";
export const LMSTUDIO = process.env.NOVA_SETUP_LMSTUDIO_BASE || "http://127.0.0.1:1234/v1";
export const REPO = "ben10-games/Nova-AI";
// Updates come from GitHub Releases: each release has one download per system (see scripts/make-release.mjs),
// so a Mac update never brings Windows files and the other way round.
export const RELEASE_ASSET = mac ? "Syntaz-for-Mac.zip" : win ? "Syntaz-for-Windows.zip" : "Syntaz-for-Linux.zip";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const UPDATE_ZIP = process.env.NOVA_UPDATE_ZIP || null; // tests
const UPDATE_VERSION_URL = process.env.NOVA_UPDATE_VERSION_URL || null; // tests
export const NOVA_PORT = Number(process.env.NOVA_APP_NOVA_PORT || 3000);
// Tried in this order; the first one this key may use becomes Syntaz's model. Measured October 2026:
// Flash-Lite does every Syntaz benchmark task and its free tier allows hundreds of requests a day, while
// the bigger Flash models allow only ~20 a day (a handful of tasks), so they come last.
export const GEMINI_MODELS = ["gemini-3.1-flash-lite", "gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-flash-latest"];

const home = () => process.env.NOVA_APP_HOME || os.homedir(); // tests use a scratch home

export async function http(url, { key, body, timeoutMs = 20_000 } = {}) {
  try {
    const res = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, text };
  } catch {
    return { status: 0, json: null, text: "" };
  }
}

export const looksLikeKey = (key) => /^[A-Za-z0-9_.-]{20,200}$/.test(key);

/** Checks a Gemini key and picks the model. { ok, values } or { ok: false, error } (plain words). */
export async function checkGemini(rawKey) {
  const key = String(rawKey || "").replace(/\s+/g, "");
  if (!looksLikeKey(key)) return { ok: false, error: "That doesn't look like an API key. Copy the whole key from Google's page and paste it." };
  const list = await http(`${GEMINI}/models`, { key });
  if (list.status === 0) return { ok: false, error: "Can't reach Google. Check your internet connection and try again." };
  if (list.status !== 200) return { ok: false, error: "Google says this key doesn't work. Copy it again (the whole key) and paste it." };
  const offered = new Set((list.json?.data ?? []).map((m) => String(m.id ?? "").replace(/^models\//, "")));
  const usable = [];
  let effort = "none"; // thinking off = much faster answers; kept only if the first model accepts it
  for (const model of GEMINI_MODELS.filter((m) => offered.size === 0 || offered.has(m))) {
    const ask = (extra) => http(`${GEMINI}/chat/completions`, { key, body: { model, messages: [{ role: "user", content: "Reply with: OK" }], max_tokens: 20, ...extra } });
    let r = await ask(usable.length === 0 || effort ? { reasoning_effort: "none" } : {});
    if (r.status === 400 && usable.length === 0) {
      r = await ask({});
      if (r.status === 200) effort = "";
    }
    if (r.status === 200) usable.push(model);
    if (usable.length >= 2) break;
  }
  if (!usable.length) return { ok: false, error: "The key works, but none of Gemini's free models answered right now (daily limit, or not available in your country). Try again later." };
  return {
    ok: true,
    model: usable[0],
    values: {
      AI_BASE_URL: GEMINI,
      AI_API_KEY: key,
      AI_PROVIDER: "openai-compatible",
      AI_PROVIDER_NAME: "Google Gemini",
      AI_MODEL: usable[0],
      AI_MODELS: usable.join(","),
      AI_CONTEXT_LENGTH: "32768",
      AI_MAX_OUTPUT_TOKENS: "4096",
      AI_REASONING_EFFORT: effort,
    },
  };
}

// Providers you pay for yourself (your own API key and billing). Tests point the addresses at stand-ins.
export const PAID = {
  openai: { name: "OpenAI", base: process.env.NOVA_SETUP_OPENAI_BASE || "https://api.openai.com/v1", keys: "https://platform.openai.com/api-keys", billing: "https://platform.openai.com/settings/organization/billing/overview", chat: /^(gpt-|o\d|chatgpt-)/i },
  anthropic: { name: "Anthropic (Claude)", base: process.env.NOVA_SETUP_ANTHROPIC_BASE || "https://api.anthropic.com", keys: "https://platform.claude.com/settings/keys", billing: "https://platform.claude.com/settings/billing", chat: /^claude-/i },
  xai: { name: "xAI (Grok)", base: process.env.NOVA_SETUP_XAI_BASE || "https://api.x.ai/v1", keys: "https://console.x.ai/", billing: "https://console.x.ai/", chat: /^grok-/i },
};
const released = (m) => (typeof m.created === "number" ? m.created : Date.parse(m.created_at ?? "") / 1000 || 0);
const NOT_CHAT = /embed|whisper|tts|dall-e|moderation|rerank|transcribe|image|imagine|audio|realtime|search|vision-preview|computer-use/i;
// Claude: the current models, best first (the list you pick from keeps any others the key offers).
const CLAUDE_FIRST = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

async function paidHttp(provider, pathPart, key, body) {
  const p = PAID[provider];
  const headers = provider === "anthropic"
    ? { "x-api-key": key, "anthropic-version": "2023-06-01", ...(body ? { "Content-Type": "application/json" } : {}) }
    : { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) };
  try {
    const res = await fetch(`${p.base}${provider === "anthropic" ? "/v1" : ""}${pathPart}`, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text };
  } catch {
    return { status: 0, json: null, text: "" };
  }
}

function paidProblem(provider, r) {
  const p = PAID[provider];
  if (r.status === 0) return `Can't reach ${p.name}. Check your internet connection and try again.`;
  if (r.status === 401 || r.status === 403 || (r.status === 400 && /api.?key|incorrect|invalid/i.test(r.text))) return `${p.name} says this key doesn't work. Copy the whole key again and paste it.`;
  if (r.status === 402 || /insufficient_quota|credit balance|billing|exceeded your current quota|spending limit/i.test(r.text)) return `The key works, but this ${p.name} account has no credit. Add a payment method or buy credits (${p.billing}), then try again.`;
  if (r.status === 429) return `${p.name} says: too many requests right now. Wait a minute and try again.`;
  return `${p.name} answered with an error (HTTP ${r.status}). Try again in a moment.`;
}

/**
 * Checks a paid key: lists the models it may use, best first, and asks the first one a tiny question (a
 * fraction of a cent) so a key without credit is caught now. { ok, model, models, values } or { ok: false, error }.
 */
export async function checkPaid(provider, rawKey, wantModel = "") {
  const p = PAID[provider];
  if (!p) return { ok: false, error: "Unknown AI provider." };
  const key = String(rawKey || "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9_.\-]{20,300}$/.test(key)) return { ok: false, error: `That doesn't look like a ${p.name} API key. Copy the whole key and paste it.` };
  const list = await paidHttp(provider, provider === "anthropic" ? "/models?limit=100" : "/models", key);
  if (list.status !== 200) return { ok: false, error: paidProblem(provider, list) };
  let models = (list.json?.data ?? [])
    .filter((m) => typeof m?.id === "string" && p.chat.test(m.id) && !NOT_CHAT.test(m.id) && !m.deprecated_at)
    .sort((a, b) => released(b) - released(a)) // newest first
    .map((m) => m.id);
  if (provider === "anthropic") models = [...CLAUDE_FIRST.filter((m) => models.includes(m)), ...models.filter((m) => !CLAUDE_FIRST.includes(m))];
  if (!models.length) return { ok: false, error: `The key works, but ${p.name} offers it no chat models.` };
  const model = models.includes(wantModel) ? wantModel : models[0];
  const test = provider === "anthropic"
    ? await paidHttp(provider, "/messages", key, { model, max_tokens: 1024, messages: [{ role: "user", content: "Reply with: OK" }] })
    : await paidHttp(provider, "/chat/completions", key, { model, messages: [{ role: "user", content: "Reply with: OK" }] });
  if (test.status !== 200) return { ok: false, error: paidProblem(provider, test), models };
  return {
    ok: true,
    model,
    models: models.slice(0, 20),
    values: {
      AI_BASE_URL: p.base,
      AI_API_KEY: key,
      AI_PROVIDER: provider === "anthropic" ? "anthropic" : "openai-compatible",
      AI_PROVIDER_NAME: p.name,
      AI_MODEL: "",
      // The chosen model first (Syntaz's default), then a few others to switch to in the side panel.
      AI_MODELS: [model, ...models.filter((m) => m !== model)].slice(0, 6).join(","),
      // Bounded on purpose: you pay per token, and Syntaz's pages fit well in this.
      AI_CONTEXT_LENGTH: "32768",
      AI_MAX_OUTPUT_TOKENS: provider === "anthropic" ? "16000" : "4096",
      AI_REASONING_EFFORT: "",
    },
  };
}

export async function checkLmStudio() {
  const r = await http(`${LMSTUDIO}/models`, { timeoutMs: 5_000 });
  if (r.status !== 200) return { ok: false, error: "LM Studio isn't answering. Open LM Studio → Developer → Start Server, load a model, and try again." };
  return { ok: true, values: { AI_BASE_URL: LMSTUDIO, AI_API_KEY: "", AI_PROVIDER: "lmstudio", AI_PROVIDER_NAME: "LM Studio", AI_MODEL: "", AI_MODELS: "", AI_CONTEXT_LENGTH: "", AI_MAX_OUTPUT_TOKENS: "2048", AI_REASONING_EFFORT: "" } };
}

const envFile = () => path.join(root, ".env.local");

export function writeEnv(ai) {
  const file = envFile();
  if (existsSync(file)) copyFileSync(file, path.join(root, ".env.local.before-setup")); // keep the old settings
  const values = { ...ai, AI_AGENT_MODE: "json", MCP_SERVERS: "browser", NOVA_ACTIONS_ENABLED: "true", WORKSPACE_DIR: "", RATE_LIMIT_MAX: "120", RATE_LIMIT_CONCURRENT: "3" };
  const text = ["# Written by Syntaz's setup. Stays on this computer; never share or upload this file.", ...Object.entries(values).map(([k, v]) => `${k}=${v}`), ""].join("\n");
  writeFileSync(file, text, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows */
  }
}

/** The AI settings shown in the Syntaz window (never the key). */
export function readSettings() {
  try {
    const env = Object.fromEntries(
      readFileSync(envFile(), "utf8")
        .split(/\r?\n/)
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    return { provider: env.AI_PROVIDER_NAME || (env.AI_PROVIDER === "lmstudio" ? "LM Studio" : "AI provider"), model: env.AI_MODEL || "", hasKey: !!env.AI_API_KEY };
  } catch {
    return null;
  }
}

/**
 * The environment for what setup starts, with this Node's folder on PATH: right after Node.js was installed,
 * the setup window doesn't know where "node" is yet (Windows: '"node"' is not recognized).
 */
export function withNodeOnPath() {
  const env = { ...process.env };
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH"; // "Path" on Windows
  env[key] = [path.dirname(process.execPath), env[key]].filter(Boolean).join(path.delimiter);
  return env;
}

function npmCli() {
  const dir = path.dirname(process.execPath);
  return [path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"), path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")].find(existsSync) ?? null;
}

/** Runs a program; each output line goes to onLine (or straight to this window). Resolves to success. */
function run(cmd, argv, onLine, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd: root, env: withNodeOnPath(), windowsHide: true, stdio: onLine ? ["ignore", "pipe", "pipe"] : "inherit", ...opts });
    if (onLine) {
      let buf = "";
      const feed = (d) => {
        buf += d;
        const parts = buf.split(/\r?\n|\r/);
        buf = parts.pop();
        parts.filter((l) => l.trim()).forEach((l) => onLine(l));
      };
      child.stdout.on("data", feed);
      child.stderr.on("data", feed);
    }
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/** npm that comes with this Node (works even when a fresh install isn't on PATH yet). */
export function npm(argv, onLine) {
  const cli = npmCli();
  return cli ? run(process.execPath, [cli, ...argv], onLine) : run(win ? "npm.cmd" : "npm", argv, onLine, { shell: win });
}

export const installPackages = (onLine) => npm(["ci", "--no-audit", "--no-fund", "--loglevel=error"], onLine);

/** Builds Syntaz with this Node directly (no npm script, so nothing depends on PATH). */
export function build(onLine) {
  return run(process.execPath, [path.join(root, "node_modules", "next", "dist", "bin", "next"), "build"], onLine);
}

/** A developer's copy (a Git checkout): updating or deleting it from the Syntaz window could destroy work. */
export const isDevCopy = () => existsSync(path.join(root, ".git"));

export const isInstalled = () => existsSync(path.join(root, ".next", "BUILD_ID")) && existsSync(path.join(root, "node_modules", "next"));
export const version = () => {
  try {
    return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
};

/** Version numbers like 1.2.3: is `a` newer than `b`? */
export function newer(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

// GitHub allows 60 unsigned checks an hour per internet address, and the Syntaz window refreshes every few
// seconds: the answer is remembered for 15 minutes (a failed check for 2).
let releaseCache = null;
const RELEASE_TTL = 15 * 60_000;
const RELEASE_RETRY = 2 * 60_000;

/** The newest release: { version, zip } (zip = this system's download), or null if none can be found. */
export async function latestRelease({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && releaseCache && now - releaseCache.at < (releaseCache.value ? RELEASE_TTL : RELEASE_RETRY)) return releaseCache.value;
  const value = await fetchLatestRelease();
  releaseCache = { at: now, value };
  return value;
}

async function fetchLatestRelease() {
  if (UPDATE_VERSION_URL) {
    const r = await http(UPDATE_VERSION_URL, { timeoutMs: 10_000 });
    return r.status === 200 && typeof r.json?.version === "string" ? { version: r.json.version, zip: UPDATE_ZIP } : null;
  }
  const r = await http(RELEASES_API, { timeoutMs: 10_000 });
  const tag = typeof r.json?.tag_name === "string" ? r.json.tag_name.replace(/^v/i, "") : null;
  const asset = Array.isArray(r.json?.assets) ? r.json.assets.find((a) => a && a.name === RELEASE_ASSET) : null;
  return r.status === 200 && tag && /^\d+\.\d+\.\d+$/.test(tag) && asset?.browser_download_url ? { version: tag, zip: asset.browser_download_url } : null;
}

export async function latestVersion() {
  return (await latestRelease())?.version ?? null;
}

// ---------------------------------------------------------------------------
// Running Syntaz (in the background, no window)
// ---------------------------------------------------------------------------

const pidFile = () => path.join(dataDir, "nova.pid");

export async function isRunning() {
  try {
    await fetch(`http://127.0.0.1:${NOVA_PORT}/api/pair`, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

export async function startNova() {
  if (await isRunning()) return true;
  if (!isInstalled()) return false;
  mkdirSync(dataDir, { recursive: true });
  const log = openSync(path.join(dataDir, "nova.log"), "a");
  const child = spawn(process.execPath, [path.join(root, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", String(NOVA_PORT)], {
    cwd: root,
    env: withNodeOnPath(),
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  writeFileSync(pidFile(), String(child.pid));
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isRunning()) return true;
  }
  return false;
}

export async function stopNova() {
  let pid = null;
  try {
    pid = Number(readFileSync(pidFile(), "utf8"));
  } catch {
    /* not started by Syntaz's window */
  }
  if (pid) {
    try {
      if (win) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      else process.kill(pid);
    } catch {
      /* already gone */
    }
    rmSync(pidFile(), { force: true });
  }
  for (let i = 0; i < 20 && (await isRunning()); i++) await new Promise((r) => setTimeout(r, 250));
  return !(await isRunning());
}

// ---------------------------------------------------------------------------
// Updates: GitHub's ZIP of Syntaz, unpacked over this folder (settings kept)
// ---------------------------------------------------------------------------

/** Unpacks a ZIP (stored or deflated entries, like GitHub's) into `dest`; returns the file count. */
export function unzip(buffer, dest) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP file");
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  const base = path.resolve(dest);
  let files = 0;
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error("damaged ZIP file");
    const method = buffer.readUInt16LE(p + 10);
    const size = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const attrs = buffer.readUInt32LE(p + 38);
    const local = buffer.readUInt32LE(p + 42);
    const name = buffer.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    const target = path.resolve(base, name);
    if (target !== base && !target.startsWith(base + path.sep)) throw new Error("unsafe path in ZIP");
    if (name.endsWith("/")) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + size);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error("unsupported ZIP compression");
    mkdirSync(path.dirname(target), { recursive: true });
    const mode = (attrs >>> 16) & 0o777;
    writeFileSync(target, data, mode ? { mode } : {});
    files++;
  }
  return files;
}

/** What an update replaces: everything except settings, runtime files and installed packages. */
const KEEP = new Set([".env.local", ".env.local.before-setup", ".nova", "node_modules", ".git"]);

/** Downloads the newest Syntaz and puts it over this folder. Settings (.env.local) are kept. */
export async function downloadUpdate(onLine = () => {}) {
  if (isDevCopy()) return { ok: false, error: "This Syntaz folder is a developer copy (it has .git): update it with git pull instead." };
  onLine("Downloading the newest Syntaz…");
  const release = await latestRelease({ fresh: true });
  if (!release?.zip) return { ok: false, error: "Couldn't find the newest Syntaz on GitHub. Try again later." };
  let res;
  try {
    res = await fetch(release.zip, { signal: AbortSignal.timeout(180_000) });
  } catch {
    return { ok: false, error: "Can't download the update. Check your internet connection." };
  }
  if (!res.ok) return { ok: false, error: `The update download failed (HTTP ${res.status}).` };
  const zip = Buffer.from(await res.arrayBuffer());
  const temp = path.join(os.tmpdir(), `nova-update-${process.pid}-${Date.now()}`);
  try {
    unzip(zip, temp);
    const top = readdirSync(temp).filter((n) => statSync(path.join(temp, n)).isDirectory());
    const src = top.length === 1 ? path.join(temp, top[0]) : temp;
    if (!existsSync(path.join(src, "package.json")) || !existsSync(path.join(src, "setup", "nova-app.mjs"))) return { ok: false, error: "The download doesn't look like Syntaz." };
    onLine("Replacing Syntaz's files (your settings are kept)…");
    for (const name of readdirSync(root)) if (!KEEP.has(name)) rmSync(path.join(root, name), { recursive: true, force: true });
    for (const name of readdirSync(src)) if (!KEEP.has(name)) cpSync(path.join(src, name), path.join(root, name), { recursive: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `The update couldn't be unpacked (${err.message}).` };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Shortcuts with the Syntaz logo, start with the computer, uninstall entry
// ---------------------------------------------------------------------------

const appScript = () => path.join(root, "setup", "nova-app.mjs");

/** Runs a PowerShell script without quoting trouble (Windows). */
function powershell(script) {
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true });
  return r.status === 0;
}
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

function windowsShortcut(folder, extraArgs) {
  const launcher = path.join(root, "setup", "windows", "launch.ps1");
  const args = `-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${launcher}"${extraArgs ? ` ${extraArgs}` : ""}`;
  return powershell(
    `$f=[Environment]::GetFolderPath(${psq(folder)}); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $f 'Syntaz AI.lnk'));` +
      ` $s.TargetPath=(Join-Path $env:WINDIR 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'); $s.Arguments=${psq(args)};` +
      ` $s.WorkingDirectory=${psq(root)}; $s.IconLocation=${psq(path.join(root, "setup", "assets", "nova.ico") + ",0")}; $s.WindowStyle=7; $s.Description='Syntaz AI'; $s.Save()`,
  );
}

function macApp(dir, extraArgs = "") {
  const app = path.join(dir, "Syntaz AI.app");
  rmSync(app, { recursive: true, force: true });
  mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
  copyFileSync(path.join(root, "setup", "assets", "nova.icns"), path.join(app, "Contents", "Resources", "nova.icns"));
  writeFileSync(
    path.join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>CFBundleName</key><string>Syntaz AI</string>\n<key>CFBundleDisplayName</key><string>Syntaz AI</string>\n<key>CFBundleIdentifier</key><string>ai.novaryn.nova</string>\n<key>CFBundleExecutable</key><string>nova</string>\n<key>CFBundleIconFile</key><string>nova</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n<key>CFBundleShortVersionString</key><string>${version()}</string>\n</dict></plist>\n`,
  );
  writeFileSync(
    path.join(app, "Contents", "MacOS", "nova"),
    `#!/bin/bash\n# Opens the Syntaz window (and starts Syntaz). Made by Syntaz's installer.\nnohup ${JSON.stringify(process.execPath)} ${JSON.stringify(appScript())} ${extraArgs} >/dev/null 2>&1 &\n`,
    { mode: 0o755 },
  );
  return app;
}

function linuxDesktopFile(file, extraArgs = "") {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `[Desktop Entry]\nType=Application\nName=Syntaz AI\nComment=Syntaz AI in Chrome's side panel\nExec="${process.execPath}" "${appScript()}" ${extraArgs}\nIcon=${path.join(root, "setup", "assets", "nova-256.png")}\nTerminal=false\nCategories=Utility;\n`,
    { mode: 0o755 },
  );
}

/** Where shortcuts go (also what uninstall removes). */
export function shortcutPaths() {
  const h = home();
  if (mac) return { app: path.join(h, "Applications", "Syntaz AI.app"), desktop: path.join(h, "Desktop", "Syntaz AI.app"), autostart: path.join(h, "Library", "LaunchAgents", "ai.novaryn.nova.plist") };
  if (!win) return { app: path.join(h, ".local", "share", "applications", "nova-ai.desktop"), desktop: path.join(h, "Desktop", "nova-ai.desktop"), autostart: path.join(h, ".config", "autostart", "nova-ai.desktop") };
  return {};
}

// Before the rename (Syntaz used to be "Nova AI"), shortcuts had the old name: an update replaces them.
const LEGACY_NAME = "Nova AI";

/** Was starting with the computer switched on (under the old or the new name)? An update keeps it. */
function autostartWasOn() {
  if (win) return powershell(`$f=[Environment]::GetFolderPath('Startup'); if ((Test-Path (Join-Path $f 'Syntaz AI.lnk')) -or (Test-Path (Join-Path $f '${LEGACY_NAME}.lnk'))) { exit 0 } else { exit 1 }`);
  return existsSync(shortcutPaths().autostart);
}

/** Removes shortcuts that still have the old name (Nova AI). */
function removeLegacyShortcuts() {
  if (win) {
    powershell(`foreach ($f in 'Desktop','Programs','Startup') { $p = Join-Path ([Environment]::GetFolderPath($f)) '${LEGACY_NAME}.lnk'; if (Test-Path $p) { Remove-Item -Force $p } }`);
  } else if (mac) {
    for (const dir of [path.join(home(), "Applications"), path.join(home(), "Desktop")]) rmSync(path.join(dir, `${LEGACY_NAME}.app`), { recursive: true, force: true });
  }
}

/** Desktop + Start menu / Applications shortcut with the Syntaz logo, and optionally start with the computer. */
export function createShortcuts({ autostart }) {
  const done = [];
  autostart = autostart || autostartWasOn(); // an update never switches it off
  removeLegacyShortcuts();
  if (win) {
    if (windowsShortcut("Desktop")) done.push("desktop");
    if (windowsShortcut("Programs")) done.push("Start menu");
    if (autostart && windowsShortcut("Startup", "-Background")) done.push("start with Windows");
    // Listed in Settings → Apps, with the Syntaz logo and an Uninstall button.
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NovaAI";
    const uninstall = `"${path.join(process.env.WINDIR || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")}" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${path.join(root, "setup", "windows", "launch.ps1")}" -Uninstall`;
    const reg = (name, type, value) => spawnSync("reg", ["add", key, "/v", name, "/t", type, "/d", value, "/f"], { stdio: "ignore", windowsHide: true }).status === 0;
    if (
      reg("DisplayName", "REG_SZ", "Syntaz AI") &&
      reg("DisplayIcon", "REG_SZ", path.join(root, "setup", "assets", "nova.ico")) &&
      reg("DisplayVersion", "REG_SZ", version()) &&
      reg("Publisher", "REG_SZ", "Novaryn") &&
      reg("InstallLocation", "REG_SZ", root) &&
      reg("UninstallString", "REG_SZ", uninstall) &&
      reg("NoModify", "REG_DWORD", "1") &&
      reg("NoRepair", "REG_DWORD", "1")
    )
      done.push("Apps list");
    return done;
  }
  const p = shortcutPaths();
  if (mac) {
    macApp(path.dirname(p.app));
    done.push("Applications");
    mkdirSync(path.dirname(p.desktop), { recursive: true });
    macApp(path.dirname(p.desktop));
    done.push("desktop");
    if (autostart) {
      mkdirSync(path.dirname(p.autostart), { recursive: true });
      const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      writeFileSync(
        p.autostart,
        `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>ai.novaryn.nova</string>\n<key>ProgramArguments</key><array><string>${esc(process.execPath)}</string><string>${esc(appScript())}</string><string>--background</string></array>\n<key>WorkingDirectory</key><string>${esc(root)}</string>\n<key>RunAtLoad</key><true/>\n</dict></plist>\n`,
      );
      done.push("start at login");
    }
    return done;
  }
  linuxDesktopFile(p.app);
  done.push("applications menu");
  if (existsSync(path.dirname(p.desktop))) {
    linuxDesktopFile(p.desktop);
    done.push("desktop");
  }
  if (autostart) {
    linuxDesktopFile(p.autostart, "--background");
    done.push("start at login");
  }
  return done;
}

/** Removes shortcuts, start-with-computer, the Apps entry and Syntaz's pairing code. Files stay unless asked. */
export async function uninstall({ removeFiles }) {
  await stopNova();
  removeLegacyShortcuts();
  if (win) {
    powershell(
      `foreach ($f in 'Desktop','Programs','Startup') { $p = Join-Path ([Environment]::GetFolderPath($f)) 'Syntaz AI.lnk'; if (Test-Path $p) { Remove-Item -Force $p } }`,
    );
    spawnSync("reg", ["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NovaAI", "/f"], { stdio: "ignore", windowsHide: true });
  } else {
    const p = shortcutPaths();
    if (mac && existsSync(p.autostart)) spawnSync("launchctl", ["unload", p.autostart], { stdio: "ignore" });
    for (const f of [p.app, p.desktop, p.autostart]) rmSync(f, { recursive: true, force: true });
  }
  rmSync(path.join(home(), ".config", "nova-browser"), { recursive: true, force: true }); // the pairing code
  if (removeFiles && !isDevCopy()) scheduleFolderRemoval();
  return true;
}

/** Deletes the Syntaz folder after this program has exited (a running program can't delete its own folder). */
function scheduleFolderRemoval() {
  if (testing && !process.env.NOVA_APP_ALLOW_DELETE) return;
  const script = win
    ? ["cmd", ["/c", `ping -n 4 127.0.0.1 >nul & rmdir /s /q "${root}"`]]
    : ["/bin/sh", ["-c", `sleep 3; rm -rf ${JSON.stringify(root)}`]];
  spawn(script[0], script[1], { detached: true, stdio: "ignore", windowsHide: true, cwd: os.tmpdir() }).unref();
}

/** Opens a web page, a folder, or Chrome's extensions page. */
export function open(what) {
  if (testing) return true;
  if (what === "extensions") {
    const chrome = findBrowser(["chrome"]);
    if (chrome) {
      spawn(chrome, ["chrome://extensions"], { detached: true, stdio: "ignore" }).unref();
      return true;
    }
    return false;
  }
  const target = what === "folder" ? path.join(root, "chrome-extension") : what;
  const [cmd, argv] = win ? ["explorer", [target]] : mac ? ["open", [target]] : ["xdg-open", [target]];
  if (win && /^https?:/.test(target)) spawn("cmd", ["/c", "start", "", target], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  else spawn(cmd, argv, { detached: true, stdio: "ignore" }).unref();
  return true;
}

/** Chrome (or Edge on Windows) for Syntaz's own window. */
export function findBrowser(kinds = ["chrome", "edge"]) {
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA || "";
  const candidates = {
    chrome: win
      ? [path.join(pf, "Google", "Chrome", "Application", "chrome.exe"), path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"), path.join(local, "Google", "Chrome", "Application", "chrome.exe")]
      : mac
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", path.join(home(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome")]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
    edge: win ? [path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"), path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe")] : mac ? ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"] : [],
  };
  for (const k of kinds) for (const c of candidates[k] || []) if (c && existsSync(c)) return c;
  return null;
}
