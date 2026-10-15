import { expect, test, type Page } from "@playwright/test";

/**
 * Uses the "Matchup League" built by scripts/seed-e2e-matchups.ts (no network, no draft):
 * Hoop Dreams (admin) vs Buckets (mfriend); period 1 totals are 48 vs 46, including +4 bonus rows
 * for a non-playing winner and a Sunday 10:30pm ET game that tipped off on Monday UTC.
 */
const CRON = { Authorization: "Bearer e2e-cron-secret" };

async function login(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: `Welcome, ${username}` })).toBeVisible();
}

const leagueNav = (page: Page, name: string) => page.getByRole("navigation", { name: "League" }).getByRole("link", { name });

test("matchup box score, scoreboard, finalization via cron, standings and result notifications", async ({ page, browser, request }) => {
  test.setTimeout(300_000);
  await login(page, "admin", "e2e-admin-password");
  await page.goto("/leagues");
  await page.getByRole("link", { name: /Matchup League/ }).first().click();
  await expect(page.getByRole("heading", { name: "Matchup League" })).toBeVisible();

  // Overview (in season): matchup card + standings snapshot.
  await expect(page.getByTestId("my-matchup-card")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("standings-snapshot")).toBeVisible();

  // ---- Scoreboard for period 1: both totals, not final yet
  await leagueNav(page, "Scoreboard").click();
  await expect(page).toHaveURL(/scoreboard/);
  await page.goto(page.url().split("?")[0] + "?period=1");
  await expect(page.getByTestId("scoreboard-title")).toHaveText("Week 1", { timeout: 60_000 });
  const card = page.getByTestId("scoreboard-matchup");
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId("scoreboard-team").filter({ hasText: "Hoop Dreams" }).getByTestId("scoreboard-points")).toHaveText("48.0");
  await expect(card.getByTestId("scoreboard-team").filter({ hasText: "Buckets" }).getByTestId("scoreboard-points")).toHaveText("46.0");
  await expect(card).toContainText("Pending final");

  // ---- Box score: totals, bonus rows for non-playing players, per-day tabs
  await card.getByRole("link", { name: "Box score" }).click();
  await expect(page.getByTestId("box-score")).toBeVisible({ timeout: 60_000 });
  const header = (team: string) => page.locator('[data-testid^="team-header-"]').filter({ hasText: team });
  await expect(header("Hoop Dreams").locator('[data-testid^="team-points-"]')).toHaveText("48.0");
  await expect(header("Hoop Dreams").locator('[data-testid^="team-bonus-"]')).toHaveText("Bonus 8");
  await expect(header("Hoop Dreams").locator('[data-testid^="team-played-"]')).toHaveText("6 played");
  await expect(header("Buckets").locator('[data-testid^="team-points-"]')).toHaveText("46.0");

  const row = (name: string) => page.getByTestId("player-row").filter({ hasText: name });
  await expect(row("E2E Bench Winner").getByTestId("bonus-cell")).toHaveText("+4");
  await expect(row("E2E Bench Winner").getByTestId("fp-cell")).toHaveText("4.0");
  await expect(row("E2E Injured Out").getByTestId("bonus-cell")).toHaveText("0");
  await expect(row("E2E Injured Out").getByTestId("fp-cell")).toHaveText("0.0");
  await expect(row("E2E Starter").getByTestId("fp-cell")).toHaveText("44.0"); // 30 + 4 + 10
  await expect(row("E2E Starter").getByTestId("bonus-cell")).toHaveText("+4");

  // The Wednesday tab: the first game only, with the final result and the live-style stat line.
  const wed = page.getByTestId("day-tab").nth(2);
  await wed.click();
  await expect(page.getByTestId("box-score")).toHaveAttribute("data-view", /\d{4}-\d{2}-\d{2}/);
  await expect(row("E2E Starter").getByTestId("fp-cell")).toHaveText("34.0");
  await expect(row("E2E Starter").getByTestId("game-cell")).toContainText("W 110-100 vs E2B");
  await expect(row("E2E Opp One").getByTestId("game-cell")).toContainText("L 100-110 @ E2A");
  // Sunday 10:30pm ET belongs to this Sunday, not Monday's period.
  await page.getByTestId("day-tab").nth(6).click();
  await expect(row("E2E Starter").getByTestId("fp-cell")).toHaveText("10.0");
  await expect(row("E2E Opp Two").getByTestId("bonus-cell")).toHaveText("+4");
  await page.getByTestId("period-total-tab").click();
  await expect(row("E2E Starter").getByTestId("fp-cell")).toHaveText("44.0");

  // Mobile: both teams side by side.
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.locator('[data-testid="box-home"]')).toBeVisible();
  await expect(page.locator('[data-testid="box-away"]')).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });

  // ---- Finalize through the cron endpoint (secured by CRON_SECRET)
  const unauthorized = await request.post("/api/cron/matchups");
  expect(unauthorized.status()).toBe(401);
  const res = await request.post("/api/cron/matchups", { headers: CRON });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.matchups.finalized).toBeGreaterThanOrEqual(2); // week 1 and the (empty) week 2
  expect(body.matchups.errors).toEqual([]);
  const again = await (await request.post("/api/cron/matchups", { headers: CRON })).json();
  expect(again.matchups.finalized).toBe(0); // idempotent

  // ---- Standings: Hoop Dreams 1-0-1 (win + empty week tie), Buckets 0-1-1
  await page.goto(page.url().replace(/matchup\/.*/, "standings"));
  const rows = page.getByTestId("standings-row");
  await expect(rows).toHaveCount(2, { timeout: 60_000 });
  await expect(rows.nth(0)).toContainText("Hoop Dreams");
  await expect(rows.nth(0).getByTestId("record")).toHaveText("1-0-1");
  await expect(rows.nth(0)).toContainText("T1"); // streak: the later (empty) week was a tie
  await expect(rows.nth(1).getByTestId("record")).toHaveText("0-1-1");

  // ---- Scoreboard + schedule now show the final result
  await page.goto(page.url().replace(/standings.*/, "scoreboard?period=1"));
  await expect(page.getByTestId("scoreboard-matchup")).toContainText("Final", { timeout: 60_000 });
  await page.goto(page.url().replace(/scoreboard.*/, "schedule"));
  await expect(page.getByTestId("matchup-score").first()).toHaveText("48 - 46");
  await expect(page.getByRole("link", { name: "Box score" }).first()).toBeVisible();

  // ---- Result notifications (in-app on by default)
  await page.goto("/notifications");
  await expect(page.getByText("You won 48-46 vs Buckets")).toBeVisible();
  const friendCtx = await browser.newContext();
  const friend = await friendCtx.newPage();
  await login(friend, "mfriend", "friend-password-1");
  await friend.goto("/notifications");
  await expect(friend.getByText("You lost 46-48 vs Hoop Dreams")).toBeVisible();
  await friendCtx.close();
});
