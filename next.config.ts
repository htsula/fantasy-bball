import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / wasm packages that must not be bundled.
  serverExternalPackages: ["@node-rs/argon2", "@electric-sql/pglite"],
};

export default nextConfig;
