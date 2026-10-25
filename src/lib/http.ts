import "server-only";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { getBrowserConfig } from "./config";
import { extensionOrigin } from "./extension-origin";

/**
 * Rejects cross-site browser requests so other websites cannot use this
 * app as a proxy to the AI provider.
 */
export function isSameOrigin(req: Request): boolean {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  const origin = req.headers.get("origin");
  if (!origin) return true; // Non-browser clients (curl) and same-origin GETs.
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Requests from the Nova Browser Bridge side panel: the extension's exact origin AND the
 * pairing code (Authorization: Bearer <code>), which only the paired extension holds.
 */
export function extensionRequest(req: Request): "none" | "authorized" | "unauthorized" {
  if (req.headers.get("origin") !== extensionOrigin()) return "none";
  const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.get("authorization") ?? "");
  if (!m) return "unauthorized";
  let expected: string;
  try {
    expected = readFileSync(getBrowserConfig().tokenFile, "utf8").trim();
  } catch {
    return "unauthorized";
  }
  const a = Buffer.from(m[1]);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? "authorized" : "unauthorized";
}

/** One rule for API routes: the web app (same origin) or the paired extension; nothing else. */
export function checkClient(req: Request): Response | null {
  const ext = extensionRequest(req);
  if (ext === "authorized") return null;
  if (ext === "unauthorized") return jsonError("This Nova extension is not paired with this Nova server (pairing code missing or wrong).", 401);
  if (!isSameOrigin(req)) return jsonError("Cross-origin requests are not allowed.", 403);
  return null;
}

/** Identifies the caller for rate limiting. Proxy headers are only trusted when configured. */
export function clientKey(req: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    const ip = forwarded || req.headers.get("x-real-ip")?.trim();
    if (ip) return ip.slice(0, 64);
  }
  return "direct";
}

export function jsonError(message: string, status: number, headers: Record<string, string> = {}) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export class BodyTooLargeError extends Error {}

/** Reads a request body as text, aborting as soon as it exceeds `maxBytes`. */
export async function readBodyText(req: Request, maxBytes: number): Promise<string> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
