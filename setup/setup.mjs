#!/usr/bin/env node
// Nova setup (Windows, macOS, Linux). Started by "Install Nova (Windows).bat" / "Install Nova (Mac).command".
// 1. Choose the AI: free Google Gemini (any PC) or LM Studio on this PC (strong GPU).
// 2. Check it works, write .env.local (stays on this PC, never uploaded).
// 3. Install and build Nova, then make a "Nova AI" shortcut (and optionally start Nova with the computer).
// Only Node's own modules are used: nothing is installed before step 3.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const configureOnly = args.has("--configure-only"); // tests: no install, build or shortcuts
const win = process.platform === "win32";
const mac = process.platform === "darwin";
// Tests point this at a local stand-in; normal use always talks to Google over https.
const GEMINI = process.env.NOVA_SETUP_GEMINI_BASE || "https://generativelanguage.googleapis.com/v1beta/openai";
const testing = !!process.env.NOVA_SETUP_GEMINI_BASE; // never opens pages or folders
const LMSTUDIO = "http://127.0.0.1:1234/v1";
// Tried in this order; the first one this key may use becomes Nova's model. Measured October 2026:
// Flash-Lite does every Nova benchmark task and its free tier allows hundreds of requests a day, while
// the bigger Flash models allow only ~20 a day (a handful of tasks), so they come last.
const GEMINI_MODELS = ["gemini-3.1-flash-lite", "gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-flash-latest"];

const say = (s = "") => process.stdout.write(`${s}\n`);
const step = (n, s) => say(`\n[${n}/4] ${s}`);
const fail = (s) => {
  say(`\n✖ ${s}`);
  process.exit(1);
};

// One readline for all answers (works with typed and piped input).
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
const lines = [];
const waiters = [];
rl.on("line", (l) => (waiters.length ? waiters.shift()(l) : lines.push(l)));
rl.on("close", () => waiters.splice(0).forEach((w) => w(null)));
function ask(question, { hidden = false } = {}) {
  process.stdout.write(question);
  let restore = null;
  if (hidden && process.stdin.isTTY) {
    // Don't echo the key on screen.
    const write = rl._writeToOutput;
    rl._writeToOutput = (s) => (/\r?\n/.test(s) ? rl.output.write("\n") : rl.output.write("*".repeat(s.length ? 1 : 0)));
    restore = () => (rl._writeToOutput = write);
  }
  return new Promise((resolve) => {
    const done = (l) => {
      restore?.();
      resolve(l === null ? "" : l.trim());
    };
    lines.length ? done(lines.shift()) : waiters.push(done);
  });
}

async function http(url, { key, body, timeoutMs = 20_000 } = {}) {
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

async function chooseGemini() {
  say("\nNova uses Google's free Gemini AI. You need a free API key (takes 2 minutes):");
  say("  1. A page opens: sign in with your Google account.");
  say('  2. Click "Create API key", then copy the key.');
  say("  3. Paste it here (it is saved only on this computer).");
  if (!configureOnly && !testing) openUrl("https://aistudio.google.com/apikey");
  for (let tries = 0; tries < 3; tries++) {
    const key = (await ask("\nPaste your Gemini API key and press Enter: ", { hidden: true })).replace(/\s+/g, "");
    if (!key) fail("No key entered. Run the setup again when you have your key.");
    if (!/^[A-Za-z0-9_.-]{20,200}$/.test(key)) {
      say("That doesn't look like an API key (it should be one long word of letters and numbers). Try again.");
      continue;
    }
    say("Checking the key…");
    const list = await http(`${GEMINI}/models`, { key });
    if (list.status === 0) fail("Can't reach Google. Check your internet connection and run the setup again.");
    if (list.status !== 200) {
      say("Google says this key doesn't work. Copy it again (the whole key) and paste it.");
      continue;
    }
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
    if (!usable.length) fail("The key works, but none of Gemini's free models answered right now (daily limit, or not available in your country). Try again later.");
    say(`✔ The key works. Nova will use ${usable[0]}.`);
    return {
      AI_BASE_URL: GEMINI,
      AI_API_KEY: key,
      AI_PROVIDER: "openai-compatible",
      AI_PROVIDER_NAME: "Google Gemini",
      AI_MODEL: usable[0],
      AI_MODELS: usable.join(","),
      AI_CONTEXT_LENGTH: "32768",
      AI_MAX_OUTPUT_TOKENS: "4096",
      AI_REASONING_EFFORT: effort,
    };
  }
  fail("The key didn't work three times. Make a new key on the page that opened, then run the setup again.");
}

async function chooseLmStudio() {
  say("\nChecking LM Studio on this computer (it must be open, with its server started and a model loaded)…");
  const r = await http(`${LMSTUDIO}/models`, { timeoutMs: 5_000 });
  if (r.status !== 200) fail("LM Studio isn't answering at 127.0.0.1:1234. Open LM Studio → Developer → Start Server, load a model, and run the setup again.");
  say("✔ LM Studio is running.");
  return { AI_BASE_URL: LMSTUDIO, AI_API_KEY: "", AI_PROVIDER: "lmstudio", AI_PROVIDER_NAME: "LM Studio", AI_MODEL: "", AI_MODELS: "", AI_CONTEXT_LENGTH: "", AI_MAX_OUTPUT_TOKENS: "2048", AI_REASONING_EFFORT: "" };
}

function writeEnv(ai) {
  const file = path.join(root, ".env.local");
  if (existsSync(file)) copyFileSync(file, path.join(root, ".env.local.before-setup")); // keep the old settings
  const values = {
    ...ai,
    AI_AGENT_MODE: "json",
    MCP_SERVERS: "browser",
    NOVA_ACTIONS_ENABLED: "true",
    WORKSPACE_DIR: "",
    RATE_LIMIT_MAX: "120",
    RATE_LIMIT_CONCURRENT: "3",
  };
  const text = [
    "# Written by Nova's setup (setup/setup.mjs). Stays on this computer; never share or upload this file.",
    ...Object.entries(values).map(([k, v]) => `${k}=${v}`),
    "",
  ].join("\n");
  writeFileSync(file, text, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows */
  }
}

/** npm that comes with this Node (works even when a fresh install isn't on PATH yet). */
function npm(argv) {
  const dir = path.dirname(process.execPath);
  const cli = [path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"), path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")].find(existsSync);
  const r = cli
    ? spawnSync(process.execPath, [cli, ...argv], { cwd: root, stdio: "inherit" })
    : spawnSync(win ? "npm.cmd" : "npm", argv, { cwd: root, stdio: "inherit", shell: win });
  return r.status === 0;
}

function openUrl(url) {
  const [cmd, argv] = win ? ["cmd", ["/c", "start", "", url]] : mac ? ["open", [url]] : ["xdg-open", [url]];
  spawnSync(cmd, argv, { stdio: "ignore" });
}

function powershell(command) {
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function shortcuts(autostart) {
  if (win) {
    const target = path.join(root, "Start Nova (Windows).bat").replace(/'/g, "''");
    const make = (folder, name, minimized) =>
      powershell(
        `$f=[Environment]::GetFolderPath('${folder}'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $f '${name}.lnk')); $s.TargetPath='${target}'; $s.WorkingDirectory='${root.replace(/'/g, "''")}'; $s.WindowStyle=${minimized ? 7 : 1}; $s.Save(); 'ok'`,
      );
    say(make("Desktop", "Nova AI", false) ? '✔ "Nova AI" shortcut on your desktop.' : "(Couldn't make a desktop shortcut: start Nova with \"Start Nova (Windows).bat\" in this folder.)");
    if (autostart) say(make("Startup", "Nova AI", true) ? "✔ Nova starts by itself (minimized) when you log in." : "(Couldn't add Nova to startup.)");
    return;
  }
  if (mac) {
    const launcher = path.join(os.homedir(), "Desktop", "Nova AI.command");
    writeFileSync(launcher, `#!/bin/bash\ncd ${JSON.stringify(root)} && exec ./"Start Nova (Mac).command"\n`, { mode: 0o755 });
    say('✔ "Nova AI" on your desktop (double-click to start Nova).');
    if (autostart) {
      const agents = path.join(os.homedir(), "Library", "LaunchAgents");
      mkdirSync(agents, { recursive: true });
      const plist = path.join(agents, "ai.nova.server.plist");
      const next = path.join(root, "node_modules", "next", "dist", "bin", "next");
      const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      writeFileSync(
        plist,
        `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>ai.nova.server</string>\n<key>ProgramArguments</key><array><string>${esc(process.execPath)}</string><string>${esc(next)}</string><string>start</string><string>-H</string><string>127.0.0.1</string><string>-p</string><string>3000</string></array>\n<key>WorkingDirectory</key><string>${esc(root)}</string>\n<key>RunAtLoad</key><true/>\n</dict></plist>\n`,
      );
      spawnSync("launchctl", ["unload", plist], { stdio: "ignore" });
      say(spawnSync("launchctl", ["load", plist], { stdio: "ignore" }).status === 0 ? "✔ Nova starts by itself when you log in (and is starting now)." : "(Couldn't add Nova to login items.)");
    }
    return;
  }
  say(`Start Nova with:  cd ${JSON.stringify(root)} && npm run start:local`);
}

async function main() {
  say("==============================");
  say("  Nova AI setup");
  say("==============================");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 18 || (major === 18 && minor < 18)) fail(`Nova needs a newer Node.js (this is ${process.versions.node}). Install the LTS version from https://nodejs.org and run the setup again.`);

  step(1, "Which AI should Nova use?");
  say("  1 = Google Gemini, free (recommended: fast on any computer, needs internet)");
  say("  2 = LM Studio on this computer (private, needs a strong graphics card)");
  const choice = (await ask("Type 1 or 2 and press Enter [1]: ")) || "1";
  const ai = choice === "2" ? await chooseLmStudio() : await chooseGemini();

  step(2, "Saving the settings");
  writeEnv(ai);
  say("✔ Saved in .env.local (only on this computer).");
  if (configureOnly) {
    rl.close();
    return;
  }

  step(3, "Installing Nova (a few minutes the first time)…");
  if (!npm(["ci", "--no-audit", "--no-fund", "--loglevel=error"])) fail("Installing failed. Check your internet connection and run the setup again.");
  say("Building Nova…");
  if (!npm(["run", "build"])) fail("Building Nova failed. Run the setup again; if it keeps failing, send the error above to whoever gave you Nova.");

  step(4, "Finishing");
  const auto = (await ask("Start Nova by itself when you log in? (Y/n): ")).toLowerCase();
  shortcuts(auto !== "n" && auto !== "no");
  rl.close();
  say("\n==============================");
  say("  Last step: add Nova to Chrome (once)");
  say("==============================");
  say("  1. In Chrome, open:  chrome://extensions");
  say('  2. Turn on "Developer mode" (top right).');
  say('  3. Click "Load unpacked" and choose this folder:');
  say(`       ${path.join(root, "chrome-extension")}`);
  say("  4. Click the puzzle icon → pin Nova, then click the Nova icon.");
  say("Nova connects by itself. Tip: in the Nova panel, ⚙ → turn on \"Let Nova see the page\".");
  if (testing) return;
  if (win) spawnSync("explorer", [path.join(root, "chrome-extension")], { stdio: "ignore" });
  else if (mac) spawnSync("open", [path.join(root, "chrome-extension")], { stdio: "ignore" });
}

main().catch((err) => fail(`Setup stopped: ${err && err.message ? err.message : err}`));
