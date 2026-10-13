import fs from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const E2E_DB = "pglite:./.pglite-e2e";

// Start every run from an empty database (skip when re-evaluated inside a worker process).
if (!process.env.TEST_WORKER_INDEX) {
  fs.rmSync(".pglite-e2e", { recursive: true, force: true });
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Migrate + seed an admin into a throwaway PGlite dir, then start the dev server on it.
    command: `npm run db:migrate && npm run create-admin -- --username admin && npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    timeout: 180_000,
    reuseExistingServer: false,
    env: {
      DATABASE_URL: E2E_DB,
      ADMIN_PASSWORD: "e2e-admin-password",
      NEXT_PUBLIC_APP_URL: `http://localhost:${PORT}`,
      CRON_SECRET: "e2e-cron-secret",
    },
  },
});
