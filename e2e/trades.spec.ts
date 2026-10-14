import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Uses "Trade League" (commissioner review) and "Vote League" (league vote, 2 vetoes cancel) from
 * scripts/seed-e2e-trades.ts. Each team owns 4 players named "<Team name> <n>", roster max 10.
 */
const PASSWORD = "trade-password-1";

async function loginAs(browser: Browser, username: string, password = PASSWORD): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: `Welcome, ${username}` })).toBeVisible();
  return page;
}

/** Opens a league from /leagues and returns its id. */
async function openLeague(page: Page, name: RegExp): Promise<string> {
  await page.goto("/leagues");
  await page.getByRole("link", { name }).first().click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  return page.url().match(/leagues\/([0-9a-f-]{36})/)![1];
}

const tradeIdFromUrl = (page: Page) => page.url().match(/trades\/([0-9a-f-]{36})/)![1];
const pick = (page: Page, name: string) => page.getByRole("checkbox", { name: `Select ${name}`, exact: true });

/** Roster rows of the signed-in user's own team ("My team" in the league nav). */
async function myRoster(page: Page, leagueId: string): Promise<string[]> {
  await page.goto(`/leagues/${leagueId}`);
  await page.getByRole("navigation", { name: "League" }).getByRole("link", { name: "My team" }).click();
  await expect(page.getByTestId("team-roster")).toBeVisible({ timeout: 60_000 });
  return page.getByTestId("roster-row").evaluateAll((rows) => rows.map((r) => (r.textContent ?? "").trim()));
}

test("2-for-1 offer, counter, accept, commissioner approval, rosters swap, feed and notifications", async ({ browser }) => {
  test.setTimeout(600_000);

  // ---- A (talpha) offers Alpha Club 1 + 2 for Bravo Club 1
  const a = await loginAs(browser, "talpha");
  const leagueId = await openLeague(a, /Trade League/);
  await a.getByRole("navigation", { name: "League" }).getByRole("link", { name: "Trades" }).click();
  await expect(a).toHaveURL(/\/trades$/);
  await a.getByTestId("new-trade").click();
  await a.getByTestId("partner-select").selectOption({ label: "Bravo Club" });
  await expect(a).toHaveURL(/with=/);
  await pick(a, "Alpha Club 1").check();
  await pick(a, "Alpha Club 2").check();
  await pick(a, "Bravo Club 1").check();
  await expect(a.getByTestId("my-roster-after")).toContainText("3 / 10");
  await expect(a.getByTestId("their-roster-after")).toContainText("5 / 10");
  await a.locator("#trade-message").fill("two for one?");
  await a.getByTestId("submit-trade").click();
  await expect(a.getByTestId("trade-detail")).toHaveAttribute("data-status", "proposed", { timeout: 60_000 });
  const firstTrade = tradeIdFromUrl(a);
  await expect(a.getByTestId("cancel-trade")).toBeVisible(); // the proposer can cancel
  await expect(a.getByTestId("accept-trade")).toHaveCount(0);

  // ---- B (tbravo) sees the badge and the offer, then counters
  const b = await loginAs(browser, "tbravo");
  await b.goto(`/leagues/${leagueId}`);
  await expect(b.getByTestId("nav-trades-badge")).toHaveText("1");
  await b.getByTestId("nav-trades").click();
  await expect(b.getByTestId("trade-card")).toHaveCount(1);
  await b.getByTestId("trade-link").click();
  await expect(b.getByTestId("trade-message")).toContainText("two for one?");
  await expect(b.getByTestId("accept-trade")).toBeVisible();
  await b.getByTestId("counter-trade").click();
  // Prefilled mirror image: I give Bravo Club 1, I get Alpha Club 1 and 2. Make it 2-for-2.
  await expect(pick(b, "Bravo Club 1")).toBeChecked({ timeout: 60_000 });
  await expect(pick(b, "Alpha Club 1")).toBeChecked();
  await expect(pick(b, "Alpha Club 2")).toBeChecked();
  await pick(b, "Bravo Club 2").check();
  await b.getByTestId("submit-trade").click();
  await expect(b.getByTestId("trade-detail")).toHaveAttribute("data-status", "proposed", { timeout: 60_000 });
  const counterTrade = tradeIdFromUrl(b);
  expect(counterTrade).not.toBe(firstTrade);
  await b.goto(`/leagues/${leagueId}/trades/${firstTrade}`);
  await expect(b.getByTestId("trade-status")).toHaveText("Countered");

  // ---- A gets a bell notification, accepts the counter -> commissioner review
  await a.goto("/notifications");
  await expect(a.getByText("Counteroffer from Bravo Club")).toBeVisible();
  await a.goto(`/leagues/${leagueId}/trades/${counterTrade}`);
  await expect(a.getByTestId("give-table")).toContainText("Bravo Club 1");
  await a.getByTestId("accept-trade").click();
  await expect(a.getByTestId("trade-status")).toHaveText("Under review", { timeout: 60_000 });
  await expect(a.getByTestId("countdown")).toContainText("Window ends");
  expect(await myRoster(a, leagueId)).toHaveLength(4); // nothing moved yet

  // ---- The commissioner (admin) is asked to review and approves
  const admin = await loginAs(browser, "admin", "e2e-admin-password");
  await admin.goto("/notifications");
  await expect(admin.getByText("Trade needs your review").first()).toBeVisible();
  await admin.goto(`/leagues/${leagueId}/trades/${counterTrade}`);
  await expect(admin.getByTestId("review-card")).toContainText("Commissioner review");
  await admin.getByTestId("approve-trade").click();
  await expect(admin.getByTestId("trade-status")).toHaveText("Completed", { timeout: 60_000 });

  // ---- Rosters swapped on the team pages
  const alpha = await myRoster(a, leagueId);
  expect(alpha).toHaveLength(4);
  expect(alpha.join("|")).toContain("Bravo Club 1");
  expect(alpha.join("|")).toContain("Bravo Club 2");
  expect(alpha.join("|")).toContain("Alpha Club 3");
  expect(alpha.join("|")).not.toContain("Alpha Club 1");
  const bravo = await myRoster(b, leagueId);
  expect(bravo.join("|")).toContain("Alpha Club 1");
  expect(bravo.join("|")).not.toContain("Bravo Club 2");

  // ---- Transactions feed groups the trade
  await a.goto(`/leagues/${leagueId}/transactions`);
  const row = a.locator('[data-testid="transaction-row"][data-type="trade"]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Alpha Club receives");
  await expect(row).toContainText("Bravo Club 1");

  // ---- Notifications: both parties were told, the executed trade is in the bell feed
  await a.goto("/notifications");
  await expect(a.getByText("Trade completed").first()).toBeVisible();
  await b.goto("/notifications");
  await expect(b.getByText("Trade completed").first()).toBeVisible();

  // ---- History tab lists both the countered original and the completed counter
  await a.goto(`/leagues/${leagueId}/trades?tab=history`);
  await expect(a.getByTestId("trade-card")).toHaveCount(2);

  // ---- Commissioner can reverse within 48h
  await admin.goto(`/leagues/${leagueId}/trades/${counterTrade}`);
  await admin.getByTestId("reverse-trade").click();
  await expect(admin.getByTestId("trade-status")).toHaveText("Reversed", { timeout: 60_000 });
  expect((await myRoster(a, leagueId)).join("|")).toContain("Alpha Club 1");

  for (const p of [a, b, admin]) await p.context().close();
});

test("league-vote trade is vetoed by votes; trade block and propose-from-team-page work", async ({ browser }) => {
  test.setTimeout(600_000);

  const a = await loginAs(browser, "vote-a");
  const leagueId = await openLeague(a, /Vote League/);

  // ---- Trade block: list a player from My Team; visible on the block page
  await a.getByRole("navigation", { name: "League" }).getByRole("link", { name: "My team" }).click();
  await expect(a.getByTestId("team-roster")).toBeVisible({ timeout: 60_000 });
  const rowA2 = a.getByTestId("roster-row").filter({ hasText: "Vote Alpha 2" });
  await rowA2.getByTestId("block-button").click();
  await expect(rowA2.getByTestId("on-block-badge")).toBeVisible({ timeout: 30_000 });
  await a.goto(`/leagues/${leagueId}/trades/block`);
  await expect(a.getByTestId("block-entry")).toHaveCount(1);
  await expect(a.getByTestId("block-entry")).toContainText("Vote Alpha 2");

  // ---- Propose from the other team's page (the block shows on their roster too)
  const b = await loginAs(browser, "vote-b");
  await b.goto(`/leagues/${leagueId}/trades/block`);
  await expect(b.getByTestId("block-entry")).toContainText("Vote Alpha 2");
  await b.getByTestId("trade-for-block").click();
  await expect(pick(b, "Vote Alpha 2")).toBeChecked({ timeout: 60_000 });
  await pick(b, "Vote Bravo 1").check();
  await b.getByTestId("submit-trade").click();
  await expect(b.getByTestId("trade-detail")).toHaveAttribute("data-status", "proposed", { timeout: 60_000 });
  const tradeId = tradeIdFromUrl(b);

  // ---- A accepts -> pending league vote
  await a.goto(`/leagues/${leagueId}/trades/${tradeId}`);
  await a.getByTestId("accept-trade").click();
  await expect(a.getByTestId("trade-status")).toHaveText("Under review", { timeout: 60_000 });
  await expect(a.getByTestId("review-card")).toContainText("League vote");
  await expect(a.getByTestId("vote-veto")).toHaveCount(0); // a party can't vote

  // ---- C votes from the hub's League tab; then the commissioner's vote reaches the threshold
  const c = await loginAs(browser, "vote-c");
  await c.goto(`/leagues/${leagueId}`);
  await c.goto(`/leagues/${leagueId}/trades?tab=league`);
  await expect(c.getByTestId("tab-count-league")).toHaveText("1");
  await c.getByTestId("vote-veto").click();
  await expect(c.getByTestId("vote-veto")).toHaveCount(0, { timeout: 30_000 });
  await c.goto(`/leagues/${leagueId}/trades/${tradeId}`);
  await expect(c.getByTestId("veto-count")).toContainText("1 of 2");
  await expect(c.getByTestId("trade-status")).toHaveText("Under review");

  const admin = await loginAs(browser, "admin", "e2e-admin-password");
  await admin.goto(`/leagues/${leagueId}/trades/${tradeId}`);
  await expect(admin.getByTestId("review-card")).toContainText("League vote");
  await admin.getByTestId("vote-veto").click();
  await expect(admin.getByTestId("trade-status")).toHaveText("Vetoed", { timeout: 60_000 });

  // ---- Nothing moved
  expect((await myRoster(a, leagueId)).join("|")).toContain("Vote Alpha 2");
  await a.goto("/notifications");
  await expect(a.getByText("Trade vetoed").first()).toBeVisible();

  for (const p of [a, b, c, admin]) await p.context().close();
});
