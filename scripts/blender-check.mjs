// Read-only check that Syntaz can reach the Syntaz Blender Bridge in your running Blender.
// Usage: npm run blender:check   (uses NOVA_BLENDER_PORT / NOVA_BLENDER_TOKEN_FILE if set)
import { readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const port = Number(process.env.NOVA_BLENDER_PORT ?? 9890);
const tokenFile = process.env.NOVA_BLENDER_TOKEN_FILE ?? path.join(os.homedir(), ".config", "nova-blender", "token");

function call(command) {
  const token = readFileSync(tokenFile, "utf8").trim();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let buffer = "";
    socket.setTimeout(15_000, () => socket.destroy(new Error("timed out")));
    socket.on("connect", () => socket.write(JSON.stringify({ id: 1, token, command, params: {} }) + "\n"));
    socket.on("data", (d) => {
      buffer += d;
      if (buffer.includes("\n")) {
        socket.end();
        resolve(JSON.parse(buffer));
      }
    });
    socket.on("error", reject);
  });
}

try {
  const ping = await call("ping");
  if (!ping.ok) throw new Error(ping.error);
  console.log(`PASS  connected to Syntaz Blender Bridge ${ping.result.bridge} in Blender ${ping.result.blender} (127.0.0.1:${port})`);
  const scene = await call("scene_info");
  if (!scene.ok) throw new Error(scene.error);
  console.log(`PASS  scene "${scene.result.scene}" has ${scene.result.object_count} objects: ${scene.result.objects.map((o) => o.name).join(", ")}`);
} catch (err) {
  console.error(`FAIL  ${err.code === "ENOENT" ? "no token file - press Start in Blender (sidebar > Syntaz)" : err.code === "ECONNREFUSED" ? "nothing listening - is Blender open with the bridge started?" : err.message}`);
  process.exit(1);
}
