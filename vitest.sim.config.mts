import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Long-running league simulation (`npm run sim`). Kept out of `npm test`: it takes minutes. */
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/sim/**/*.sim.ts"],
    testTimeout: 3_600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
