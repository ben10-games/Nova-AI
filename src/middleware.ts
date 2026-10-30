import { NextResponse, type NextRequest } from "next/server";
import { extensionOrigin } from "./lib/extension-origin";

/** CORS only for the Syntaz Browser Bridge side panel, only on the API. The routes still require its pairing code. */
function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

/**
 * Optional site-wide HTTP Basic authentication, enabled by setting both
 * BASIC_AUTH_USER and BASIC_AUTH_PASSWORD on the server. It protects the UI
 * and the API (and therefore your AI provider budget) with one shared login.
 * It is not per-user accounts: conversations stay in each visitor's browser.
 */

function safeEqual(a: string, b: string): boolean {
  // Constant-time comparison so response timing doesn't reveal the password.
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export function middleware(req: NextRequest) {
  const origin = req.headers.get("origin");
  const fromExtension = !!origin && origin === extensionOrigin() && req.nextUrl.pathname.startsWith("/api/");
  if (fromExtension && req.method === "OPTIONS") return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
  const pass = () => {
    const res = NextResponse.next();
    if (fromExtension) for (const [k, v] of Object.entries(corsHeaders(origin))) res.headers.set(k, v);
    return res;
  };

  const user = process.env.BASIC_AUTH_USER;
  const password = process.env.BASIC_AUTH_PASSWORD;
  if (!user && !password) return pass();

  if (!user || !password) {
    // Fail closed on half-configured auth rather than silently leaving the site open.
    return new NextResponse("Access protection is misconfigured: set both BASIC_AUTH_USER and BASIC_AUTH_PASSWORD.", {
      status: 503,
    });
  }

  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const sep = decoded.indexOf(":");
      if (sep >= 0 && safeEqual(decoded.slice(0, sep), user) && safeEqual(decoded.slice(sep + 1), password)) {
        return pass();
      }
    } catch {
      /* malformed header */
    }
  }

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Syntaz AI", charset="UTF-8"', "Cache-Control": "no-store" },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
