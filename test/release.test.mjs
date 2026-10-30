// The release downloads (scripts/make-release.py): one per system, each with only its own setup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("release ZIPs: Mac gets the Mac app (executable), Windows the .bat (CRLF), no tests, all in a 'Syntaz AI' folder", () => {
  const out = mkdtempSync(path.join(os.tmpdir(), "nova-release-"));
  try {
    const r = spawnSync("python3", ["-I", path.join(root, "scripts", "make-release.py"), "--out", out], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    // The ZIP listing as Python sees it: name, Unix mode, and whether the file has Windows line endings.
    const list = (zip) =>
      JSON.parse(
        spawnSync("python3", ["-I", "-c", "import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps([[i.filename, (i.external_attr>>16)&0o777, b'\\r\\n' in z.read(i)] for i in z.infolist()]))", path.join(out, zip)], { encoding: "utf8" }).stdout,
      );
    const mac = list("Syntaz-for-Mac.zip");
    const windows = list("Syntaz-for-Windows.zip");
    const linux = list("Syntaz-for-Linux.zip");
    for (const entries of [mac, windows, linux]) {
      assert.ok(entries.every(([n]) => n.startsWith("Syntaz AI/")), "everything is inside the Syntaz AI folder");
      assert.ok(!entries.some(([n]) => n.startsWith("Syntaz AI/test/")), "no tests");
      assert.ok(entries.some(([n]) => n === "Syntaz AI/setup/nova-app.mjs"));
      assert.ok(entries.some(([n]) => n === "Syntaz AI/chrome-extension/manifest.json"));
    }
    const launcher = mac.find(([n]) => n === "Syntaz AI/Syntaz Setup.app/Contents/MacOS/nova-setup");
    assert.ok(launcher, "the Mac app is in the Mac download");
    assert.ok(launcher[1] & 0o100, "its launcher is executable");
    assert.equal(launcher[2], false, "with Unix line endings");
    assert.ok(!mac.some(([n]) => n.endsWith(".bat") || n.includes("setup/windows/")), "no Windows files for Mac");
    const bat = windows.find(([n]) => n === "Syntaz AI/Syntaz Setup (Windows).bat");
    assert.ok(bat && bat[2], "the Windows setup is there, with Windows line endings");
    assert.ok(windows.find(([n]) => n === "Syntaz AI/setup/windows/launch.ps1")[2]);
    assert.ok(!windows.some(([n]) => n.includes("Syntaz Setup.app/")), "no Mac app for Windows");
    assert.ok(!linux.some(([n]) => n.endsWith(".bat") || n.includes(".app/")));
    assert.deepEqual(readdirSync(out).sort(), ["Syntaz-Lite.html", "Syntaz-for-Linux.zip", "Syntaz-for-Mac.zip", "Syntaz-for-Windows.zip"], "only the four Syntaz downloads");
    const lite = readFileSync(path.join(out, "Syntaz-Lite.html"), "utf8");
    assert.match(lite, /<title>Syntaz Lite<\/title>/, "Syntaz Lite as its own download");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
