// Shared helpers for the integration tests.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The production build to test: ".next", or another folder via NOVA_NEXT_DIST_DIR (e.g. while `npm run dev` uses .next).
export const distDir = /^\.next-[a-z0-9-]+$/.test(process.env.NOVA_NEXT_DIST_DIR ?? "") ? process.env.NOVA_NEXT_DIST_DIR : ".next";
if (!existsSync(path.join(root, distDir, "BUILD_ID"))) {
  throw new Error(`No production build found in ${distDir}. Run \`npm run build\` (with the same NOVA_NEXT_DIST_DIR) before \`npm test\`.`);
}

export const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

export async function startApp(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "production", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(base + "/api/status", { headers: env.BASIC_AUTH_USER ? { Authorization: basic(env.BASIC_AUTH_USER, env.BASIC_AUTH_PASSWORD) } : {} });
      return { base, child, logs: () => logs };
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  child.kill();
  throw new Error("App did not start:\n" + logs);
}

export const basic = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
export const json = { "Content-Type": "application/json" };
export const chatBody = (content, extra = {}) => JSON.stringify({ messages: [{ role: "user", content }], ...extra });

