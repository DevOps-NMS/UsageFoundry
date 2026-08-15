import type { NextConfig } from "next";

/**
 * Baseline response headers.
 *
 * There were none at all, which is what made the session cookie's exposure
 * worse than the cookie itself: no HSTS, so a first request over plain HTTP
 * against a TLS deployment is not upgraded; no framing policy, so the app can
 * be embedded and its controls clicked through; no `nosniff`, so a response
 * body can be re-interpreted as a script.
 *
 * `Strict-Transport-Security` is sent unconditionally because a browser ignores
 * it over plain HTTP by specification, so a loopback install pays nothing for
 * it. Deliberately without `includeSubDomains` or `preload`: this app does not
 * know what else lives on the registrable domain it is deployed under, and both
 * of those are decisions with a two-year tail that belong to whoever runs the
 * terminator, not to a default in an image.
 *
 * `frame-ancestors 'none'` is the CSP way of saying it and covers browsers that
 * have dropped `X-Frame-Options`; the header itself stays for the ones that
 * have not. This is not a full content policy — a script-src for this app would
 * have to cover Next's own inline bootstrap and the pre-paint theme script, and
 * a policy written without measuring that is a blank page.
 */
const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  // The run pages carry branch names and folder paths in the URL; a full
  // referrer on any outbound link would hand those to whoever is on the end.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  // Emits .next/standalone with a self-contained server.js — keeps the
  // runtime image small and avoids shipping the full node_modules tree.
  output: "standalone",
  // better-sqlite3 is a native addon; it must stay external to the bundle.
  serverExternalPackages: ["better-sqlite3"],
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
