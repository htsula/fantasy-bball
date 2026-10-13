import { expect, test } from "@playwright/test";

test("admin invites a friend who redeems the link and lands on home", async ({ page, browser }) => {
  // Admin logs in and generates an invite link.
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/); // middleware redirect
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("e2e-admin-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Welcome, admin" })).toBeVisible();

  await page.goto("/admin");
  await page.getByRole("button", { name: "Generate invite link" }).click();
  const link = page.getByLabel("Generated link");
  await expect(link).toHaveValue(/\/invite\//);
  const inviteUrl = await link.inputValue();

  // A fresh browser context (no cookies) redeems it.
  const friend = await browser.newContext();
  const fp = await friend.newPage();
  await fp.goto(inviteUrl);
  await fp.getByLabel("Username").fill("newbie");
  await fp.getByLabel("Password (min 8 characters)").fill("friend-password-1");
  await fp.getByLabel("Confirm password").fill("friend-password-1");
  await fp.getByRole("button", { name: "Create account" }).click();
  await expect(fp.getByRole("heading", { name: "Welcome, newbie" })).toBeVisible();
  await expect(fp.getByRole("link", { name: "Admin" })).toHaveCount(0);

  // The invite is single-use.
  await fp.context().clearCookies();
  await fp.goto(inviteUrl);
  await expect(fp.getByText("already been used")).toBeVisible();
  await friend.close();
});

test("seeded NBA data: players table, player card game log, scoreboard and admin sync panel", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("e2e-admin-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Welcome, admin" })).toBeVisible();

  // Nav links.
  await page.getByRole("link", { name: "Players" }).click();
  await expect(page).toHaveURL(/\/players/);
  await expect(page.getByRole("heading", { name: "Players" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Admin" })).toBeVisible();

  // Search for a player from the seeded box score and open the card.
  await page.getByLabel("Search name").fill("Prosper");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/q=Prosper/);
  const row = page.getByRole("row", { name: /Olivier-Maxence Prosper/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText("MEM");
  await row.getByRole("link", { name: "Olivier-Maxence Prosper" }).click();

  await expect(page.getByRole("heading", { name: "Olivier-Maxence Prosper" })).toBeVisible();
  await expect(page.getByText("Game log")).toBeVisible();
  const logRow = page.getByRole("row", { name: /Mar 10/ });
  await expect(logRow).toContainText("@ PHI");
  await expect(logRow).toContainText("L 139-129");

  // Filters: an injured seeded player appears under the injury filter and disappears with healthy-only.
  await page.goto("/players?inj=Day-To-Day");
  await expect(page.getByRole("row", { name: /Keshon Gilbert/ })).toBeVisible();
  await page.goto("/players?inj=Day-To-Day&healthy=1");
  await expect(page.getByRole("row", { name: /Keshon Gilbert/ })).toHaveCount(0);

  // Scoreboard for the seeded day.
  await page.getByRole("link", { name: "NBA Scoreboard" }).click();
  await page.goto("/nba/scoreboard?date=2026-03-10");
  await expect(page.getByTestId("game-card")).toHaveCount(11);
  await expect(page.getByText("Philadelphia 76ers").first()).toBeVisible();

  // Admin: data sync panel.
  await page.goto("/admin");
  await expect(page.getByText("Data sync")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run syncDaily now" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run syncLive now" })).toBeVisible();
});

test("cron routes reject missing credentials and accept the secret", async ({ request }) => {
  expect((await request.get("/api/cron/live")).status()).toBe(401);
  expect((await request.get("/api/cron/daily")).status()).toBe(401);
  const res = await request.post("/api/cron/live", { headers: { authorization: "Bearer e2e-cron-secret" } });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.live.skipped).toBeTruthy(); // seeded games are long over: fast no-op, no ESPN call
});
