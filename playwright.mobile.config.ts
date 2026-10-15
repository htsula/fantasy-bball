import fs from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/**
 * Mobile pass: every main page on a demo league, at iPhone-ish (390x844) and Android (412x915) sizes in light mode (the
 * app is light only). Saves screenshots to ./screenshots/<project>/ (gitignored) and fails on horizontal page overflow.
 * Run: npm run e2e:mobile   (E2E_DEV=1 for `next dev` instead of a production build)
 */
const PORT = 3101;
const DEV = process.env.E2E_DEV === "1";
const DB = "pglite:./.pglite-mobile";

if (!process.env.TEST_WORKER_INDEX) {
  fs.rmSync(".pglite-mobile", { recursive: true, force: true });
  fs.rmSync("screenshots", { recursive: true, force: true });
}

const iphone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: devices["iPhone 13"].userAgent };
const android = { ...devices["Pixel 7"], viewport: { width: 412, height: 915 } };

export default defineConfig({
  testDir: "./e2e-mobile",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 300_000,
  expect: { timeout: 15_000 },
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "iphone-light", use: { ...iphone, colorScheme: "light" } },
    { name: "android-light", use: { ...android, colorScheme: "light" } },
  ],
  webServer: {
    command: `npm run db:migrate && npm run db:seed && ${DEV ? `npx next dev -p ${PORT}` : `npx next build && npx next start -p ${PORT}`}`,
    url: `http://localhost:${PORT}/login`,
    timeout: 420_000,
    reuseExistingServer: false,
    env: { DATABASE_URL: DB, NEXT_PUBLIC_APP_URL: `http://localhost:${PORT}`, CRON_SECRET: "mobile-cron-secret" },
  },
});
