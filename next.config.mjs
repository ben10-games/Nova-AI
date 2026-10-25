const isDev = process.env.NODE_ENV !== "production";

// The browser only ever talks to this app's own origin; the AI provider is called server-side.
const csp = [
  "default-src 'self'",
  // Next.js injects inline bootstrap scripts; dev mode also needs eval for fast refresh.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Normally ".next". Tests can build or run a second dev server in another folder (e.g. ".next-devtest").
  distDir: /^\.next-[a-z0-9-]+$/.test(process.env.NOVA_NEXT_DIST_DIR ?? "") ? process.env.NOVA_NEXT_DIST_DIR : ".next",
  reactStrictMode: true,
  poweredByHeader: false,
  // Hide the floating Next.js "N" dev-tools button shown during `npm run dev`.
  devIndicators: false,
  async headers() {
    const headers = [
      { key: "Content-Security-Policy", value: csp },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    ];
    // Browsers ignore HSTS over plain http, so this is harmless for local production testing.
    if (!isDev) headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" });
    return [{ source: "/:path*", headers }];
  },
};

export default nextConfig;
