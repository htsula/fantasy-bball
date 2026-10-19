import { defineConfig } from "@playwright/test";

/**
 * Browser pass over the simulated 16-team league (see README, "League simulation"). Not run directly: `npm run e2e:sim`
 * restores one checkpoint database at a time, starts a production server on it (with the simulated clock) and runs
 * these specs against it with SIM_CHECKPOINT / SIM_BASE_URL set. There is no webServer here on purpose.
 */
export default defineConfig({
  testDir: "./e2e-sim",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: Number(process.env.SIM_TEST_TIMEOUT ?? 300_000), // per test; the longest crawl (all pages as one visitor) takes ~2 min
  expect: { timeout: 20_000 },
  retries: 0,
  use: { baseURL: process.env.SIM_BASE_URL, trace: "off" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
