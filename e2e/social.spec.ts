import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Uses the "Social League" built by scripts/seed-e2e-social.ts: admin (commissioner, "Chat Crew"),
 * sfriend ("Hoopers") and newguy (no team). No NBA games, so all scores start at 0-0.
 */
const CRON = { Authorization: "Bearer e2e-cron-secret" };

async function login(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: `Welcome, ${username}` })).toBeVisible();
}

async function openLeague(page: Page) {
  await page.goto("/leagues");
  await page.getByRole("link", { name: /Social League/ }).first().click();
  await expect(page.getByRole("heading", { name: "Social League" })).toBeVisible();
  return page.url().split("/leagues/")[1].split(/[/?]/)[0];
}

async function session(browser: Browser, username: string, password: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, username, password);
  return { ctx, page };
}

test("announcement, chat mention, score adjustment, ownership transfer and the activity log", async ({ page, browser, request }) => {
  test.setTimeout(420_000);
  await login(page, "admin", "e2e-admin-password");
  const leagueId = await openLeague(page);
  const base = `/leagues/${leagueId}`;

  // ---- Commissioner posts an announcement
  await page.getByTestId("nav-commissioner").click();
  await expect(page.getByRole("heading", { name: "Commissioner tools" })).toBeVisible({ timeout: 60_000 });
  await page.getByLabel("Announcement").fill("Trade deadline is Friday. Be nice.");
  await page.getByTestId("send-announcement").click();
  await expect(page.getByText("Announcement sent to every member")).toBeVisible();

  // ---- A member sees it on the overview and in the bell/notification list
  const friend = await session(browser, "sfriend", "social-pass-1");
  await friend.page.goto(base);
  await expect(friend.page.getByTestId("latest-announcement")).toContainText("Trade deadline is Friday", { timeout: 60_000 });
  await friend.page.goto("/notifications");
  await expect(friend.page.getByText("Announcement from admin")).toBeVisible();

  // ---- Members chat with an @mention; the mentioned member gets a notification
  await friend.page.goto(`${base}/chat`);
  await expect(friend.page.getByTestId("chat-list")).toBeVisible({ timeout: 60_000 });
  await expect(friend.page.getByTestId("chat-message").filter({ hasText: "Trade deadline is Friday" })).toHaveAttribute("data-kind", "announcement");
  await friend.page.getByTestId("chat-input").fill("hey @admin check <b>this</b> https://example.com/x");
  await friend.page.getByTestId("chat-send").click();
  const mine = friend.page.getByTestId("chat-message").filter({ hasText: "hey @admin" });
  await expect(mine).toBeVisible();
  await expect(mine).toContainText("<b>this</b>"); // rendered as text, not markup
  await expect(mine.locator("a[href='https://example.com/x']")).toHaveCount(1);
  await expect(mine.locator("b")).toHaveCount(0);

  await page.goto("/notifications");
  await expect(page.getByText("sfriend mentioned you")).toBeVisible();
  await page.goto(`${base}/chat`);
  await expect(page.getByTestId("chat-message").filter({ hasText: "hey @admin" })).toBeVisible({ timeout: 60_000 });
  await page.goto(base);
  await expect(page.getByTestId("chat-preview")).toContainText("hey @admin");

  // ---- Score adjustment: Hoopers +50 in week 1 beats Chat Crew
  await page.goto(`${base}/commissioner`);
  const form = page.getByTestId("score-adjust");
  await form.getByLabel("Period").selectOption({ label: "Week 1" });
  await form.getByLabel("Matchup").selectOption({ index: 1 });
  await form.getByLabel("Team to adjust").selectOption({ label: "Hoopers" });
  await form.getByLabel("Points (+ or -)").fill("50");
  await form.getByLabel("Reason").fill("Missed stat correction");
  await page.getByTestId("apply-adjustment").click();
  await expect(page.getByText("Adjustment saved. Totals were recalculated.")).toBeVisible();
  await expect(page.getByTestId("recent-adjustments")).toContainText("Missed stat correction");

  // The matchup page shows the adjustment line and the total.
  await page.goto(`${base}/scoreboard?period=1`);
  await page.getByTestId("scoreboard-matchup").getByRole("link", { name: "Box score" }).click();
  await expect(page.getByTestId("box-score")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("adjustment-line")).toContainText("Commissioner adjustment +50.0 (Missed stat correction)");
  await expect(page.getByTestId("period-total-away").or(page.getByTestId("period-total-home"))).toHaveText("50.0");

  // Finalize through the cron endpoint, then the standings show Hoopers on top with the win.
  const res = await request.post("/api/cron/matchups", { headers: CRON });
  expect(res.ok()).toBeTruthy();
  await page.goto(`${base}/standings`);
  const rows = page.getByTestId("standings-row");
  await expect(rows).toHaveCount(2, { timeout: 60_000 });
  await expect(rows.nth(0)).toContainText("Hoopers");
  await expect(rows.nth(0).getByTestId("record")).toHaveText(/^1-0/);

  // ---- Transfer ownership of Hoopers to newguy
  await page.goto(`${base}/commissioner`);
  const hoopers = page.getByTestId("commissioner-team").filter({ hasText: "Hoopers" });
  await hoopers.getByLabel("New owner of Hoopers").fill("newguy");
  await hoopers.getByRole("button", { name: "Transfer Hoopers" }).click();
  await expect(page.getByText("Hoopers now belongs to newguy.")).toBeVisible();
  await expect(hoopers).toContainText("owner newguy");

  // sfriend lost access; newguy now owns the team.
  await friend.page.goto(base);
  await expect(friend.page.getByRole("heading", { name: "Social League" })).toHaveCount(0);
  const guy = await session(browser, "newguy", "newguy-pass-1");
  await guy.page.goto(base);
  await expect(guy.page.getByRole("heading", { name: "Social League" })).toBeVisible({ timeout: 60_000 });
  await guy.page.goto("/notifications");
  await expect(guy.page.getByText("You were given a team")).toBeVisible();
  await guy.ctx.close();
  await friend.ctx.close();

  // ---- The activity page lists these with the commissioner's name
  await page.goto(`${base}/activity`);
  const list = page.getByTestId("activity-list");
  for (const type of ["announcement", "score_adjustment", "team_owner_transferred"]) {
    const row = list.locator(`[data-type="${type}"]`).first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row.getByTestId("activity-actor")).toHaveText("by admin");
  }
  await expect(list.locator('[data-type="score_adjustment"]').first()).toContainText("Missed stat correction");
  await page.getByLabel("Type").selectOption("commissioner");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(list.locator('[data-type="team_joined"]')).toHaveCount(0);
  await expect(list.locator('[data-type="score_adjustment"]').first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Transactions (adds and drops)" })).toBeVisible();
});
