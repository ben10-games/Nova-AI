import { resolveApproval } from "@/lib/agent/runs";
import { getRateLimitConfig } from "@/lib/config";
import { BodyTooLargeError, clientKey, checkClient, jsonError, readBodyText } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[0-9a-f-]{36}$/i;

/** Records the user's decision for a pending write action. */
export async function POST(req: Request) {
  const denied = checkClient(req);
  if (denied) return denied;
  if (!req.headers.get("content-type")?.includes("application/json")) return jsonError("Content-Type must be application/json.", 415);

  let body: { runId?: unknown; callId?: unknown; approved?: unknown };
  try {
    body = JSON.parse(await readBodyText(req, 4 * 1024));
  } catch (err) {
    if (err instanceof BodyTooLargeError) return jsonError("Request body is too large.", 413);
    return jsonError("Request body is not valid JSON.", 400);
  }
  if (!body || typeof body.runId !== "string" || !ID.test(body.runId) || typeof body.callId !== "string" || !ID.test(body.callId)) {
    return jsonError("Invalid run or action ID.", 400);
  }
  if (typeof body.approved !== "boolean") return jsonError("`approved` must be true or false.", 400);

  let owner: string;
  try {
    owner = clientKey(req, getRateLimitConfig().trustProxy);
  } catch {
    return jsonError("The server is misconfigured.", 503);
  }
  const result = resolveApproval(body.runId, body.callId, owner, body.approved);
  if (result === "not_found") return jsonError("This action is no longer waiting for approval.", 404);
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
