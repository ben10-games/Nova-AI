import { readFileSync } from "node:fs";
import { buildRegistry } from "@/lib/agent/tools";
import { getAgentConfig, getBrowserConfig, getMcpConfig } from "@/lib/config";
import { jsonError } from "@/lib/http";
import { extensionOrigin } from "@/lib/extension-origin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/**
 * One-click pairing for the Nova side panel: hands the pairing code to the Nova extension only
 * (its fixed origin, which web pages can't fake) and only on Nova's own computer address. Anything
 * that could send a forged origin from this computer can already read the code's file.
 */
export async function GET(req: Request) {
  if (req.headers.get("origin") !== extensionOrigin()) return jsonError("Only the Nova extension can pair.", 403);
  if (!LOOPBACK.test(req.headers.get("host") ?? "")) return jsonError("Pairing works only on this computer (127.0.0.1).", 403);
  if (process.env.BASIC_AUTH_USER || process.env.BASIC_AUTH_PASSWORD) return jsonError("Automatic pairing is off while basic auth is on.", 403);
  let tokenFile: string;
  try {
    if (!getMcpConfig().servers.some((s) => s.id === "browser")) return jsonError("Browser control is off: add browser to MCP_SERVERS in .env.local.", 409);
    tokenFile = getBrowserConfig().tokenFile;
  } catch {
    return jsonError("Browser control is not configured on the server.", 503);
  }
  const read = () => {
    try {
      const t = readFileSync(tokenFile, "utf8").trim();
      return /^[0-9a-f]{64}$/.test(t) ? t : null;
    } catch {
      return null;
    }
  };
  let token = read();
  if (!token) {
    // The browser server creates the code when it first starts.
    try {
      await buildRegistry(getAgentConfig());
    } catch {
      /* reported below */
    }
    token = read();
  }
  if (!token) return jsonError("Nova's browser server hasn't started yet. Try again in a moment.", 503);
  return Response.json({ token }, { headers: { "Cache-Control": "no-store" } });
}
