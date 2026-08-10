import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits .next/standalone with a self-contained server.js — keeps the
  // runtime image small and avoids shipping the full node_modules tree.
  output: "standalone",
  // better-sqlite3 is a native addon; it must stay external to the bundle.
  serverExternalPackages: ["better-sqlite3"],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
