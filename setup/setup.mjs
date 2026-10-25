#!/usr/bin/env node
// Nova setup in a terminal (Linux, or anyone who prefers text). Most people use the Nova window instead:
// "Nova Setup (Windows).bat", "Nova Setup.app" (Mac) or `node setup/nova-app.mjs`.
// 1. Choose the AI: free Google Gemini (any PC) or LM Studio on this PC (strong GPU).
// 2. Check it works, write .env.local (stays on this PC, never uploaded).
// 3. Install and build Nova, then add the Nova shortcuts.
import path from "node:path";
import readline from "node:readline";
import * as lib from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const configureOnly = args.has("--configure-only"); // tests: no install, build or shortcuts

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

async function chooseGemini() {
  say("\nNova uses Google's free Gemini AI. You need a free API key (takes 2 minutes):");
  say("  1. A page opens: sign in with your Google account.");
  say('  2. Click "Create API key", then copy the key.');
  say("  3. Paste it here (it is saved only on this computer).");
  if (!configureOnly) lib.open("https://aistudio.google.com/apikey");
  for (let tries = 0; tries < 3; tries++) {
    const key = (await ask("\nPaste your Gemini API key and press Enter: ", { hidden: true })).replace(/\s+/g, "");
    if (!key) fail("No key entered. Run the setup again when you have your key.");
    if (!lib.looksLikeKey(key)) {
      say("That doesn't look like an API key (it should be one long word of letters and numbers). Try again.");
      continue;
    }
    say("Checking the key…");
    const r = await lib.checkGemini(key);
    if (r.ok) {
      say(`✔ The key works. Nova will use ${r.model}.`);
      return r.values;
    }
    if (/Can't reach|none of Gemini's/.test(r.error)) fail(r.error);
    say(r.error);
  }
  fail("The key didn't work three times. Make a new key on the page that opened, then run the setup again.");
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
  let ai;
  if (choice === "2") {
    say("\nChecking LM Studio on this computer…");
    const r = await lib.checkLmStudio();
    if (!r.ok) fail(r.error);
    say("✔ LM Studio is running.");
    ai = r.values;
  } else ai = await chooseGemini();

  step(2, "Saving the settings");
  lib.writeEnv(ai);
  say("✔ Saved in .env.local (only on this computer).");
  if (configureOnly) {
    rl.close();
    return;
  }

  step(3, "Installing Nova (a few minutes the first time)…");
  if (!(await lib.installPackages())) fail("Installing failed. Check your internet connection and run the setup again.");
  say("Building Nova…");
  if (!(await lib.build())) fail("Building Nova failed. Run the setup again; if it keeps failing, send the error above to whoever gave you Nova.");

  step(4, "Finishing");
  const auto = (await ask("Start Nova by itself when you log in? (Y/n): ")).toLowerCase();
  const made = lib.createShortcuts({ autostart: auto !== "n" && auto !== "no" });
  rl.close();
  if (made.length) say(`✔ Nova AI added: ${made.join(", ")}.`);
  say(lib.isInstalled() && (await lib.startNova()) ? "✔ Nova is running." : "Start Nova from the Nova AI shortcut.");
  say("\nLast step, once: in Chrome open chrome://extensions, turn on Developer mode, click Load unpacked and choose:");
  say(`  ${path.join(lib.root, "chrome-extension")}`);
  say("Then click the puzzle icon → pin Nova AI. Nova connects by itself.");
  process.exit(0);
}

main().catch((err) => fail(`Setup stopped: ${err && err.message ? err.message : err}`));
