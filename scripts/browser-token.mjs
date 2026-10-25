// Prints the pairing code to paste into the Nova Browser Bridge extension.
// The code is created by Nova the first time the "browser" MCP server starts.
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const file = process.env.NOVA_BROWSER_TOKEN_FILE ?? path.join(os.homedir(), ".config", "nova-browser", "token");
if (!existsSync(file)) {
  console.error("No pairing code yet. Add browser to MCP_SERVERS in .env.local, start Nova (npm run dev), open it in the browser once, then run this again.");
  process.exit(1);
}
console.log(readFileSync(file, "utf8").trim());
