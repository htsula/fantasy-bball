import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / wasm packages that must not be bundled.
  serverExternalPackages: ["@node-rs/argon2", "@electric-sql/pglite"],
  async headers() {
    return [
      // The service worker must never be served from a stale HTTP cache, or updates would not reach installed apps.
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }, { key: "Service-Worker-Allowed", value: "/" }] },
    ];
  },
};

export default nextConfig;
