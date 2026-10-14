import fs from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const E2E_DB = "pglite:./.pglite-e2e";
// Default: production build (`next build` + `next start`): no on-demand compiles, so timing matches deploys.
// E2E_DEV=1 runs against `next dev` instead (faster to start, slower per page; note it shares .next with a running dev server).
const DEV = process.env.E2E_DEV === "1";
const SERVER = DEV ? `npx next dev -p ${PORT}` : `npx next build && npx next start -p ${PORT}`;

// Start every run from an empty database (skip when re-evaluated inside a worker process).
if (!process.env.TEST_WORKER_INDEX) {
  fs.rmSync(".pglite-e2e", { recursive: true, force: true });
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  expect: { timeout: DEV ? 15_000 : 10_000 }, // dev server compiles routes on first hit
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Migrate + seed an admin and the NBA fixtures into a throwaway PGlite dir, then build + start the server on it.
    command: `npm run db:migrate && npm run create-admin -- --username admin && npm run db:seed-nba && npm run db:seed-e2e-matchups && npm run db:seed-e2e-trades && npm run db:seed-e2e-playoffs && npm run db:seed-e2e-social && ${SERVER}`,
    url: `http://localhost:${PORT}/login`,
    timeout: 420_000, // includes `next build`
    reuseExistingServer: false,
    env: {
      DATABASE_URL: E2E_DB,
      ADMIN_PASSWORD: "e2e-admin-password",
      NEXT_PUBLIC_APP_URL: `http://localhost:${PORT}`,
      CRON_SECRET: "e2e-cron-secret",
    },
  },
});
