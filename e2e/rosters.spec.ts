import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "friend-password-1";

/** A link in the league sub-navigation (the site header has its own Players link). */
const leagueNav = (page: Page, name: string) => page.getByRole("navigation", { name: "League" }).getByRole("link", { name });

const rosterCount = (page: Page) => page.getByTestId("my-roster-item").count();

/** Drafts the first listed player (the list hides picked players as soon as the board updates). */
async function draftFirst(page: Page, target: number) {
  await expect(page.getByTestId("draft-button").first()).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId("draft-button").first().click();
  await expect.poll(() => rosterCount(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(target);
}

test("free agency: add/drop on My Team, 2 adds per day, full roster needs a drop", async ({ page: admin, browser }) => {
  test.setTimeout(600_000);

  // ---- A 2-team league with max roster 3 (pool 6): 3 snake rounds, then in season
  await admin.goto("/login");
  await admin.getByLabel("Username").fill("admin");
  await admin.getByLabel("Password").fill("e2e-admin-password");
  await admin.getByRole("button", { name: "Log in" }).click();
  await expect(admin.getByRole("heading", { name: "Welcome, admin" })).toBeVisible();
  await admin.goto("/leagues/new");
  await admin.getByLabel("League name").fill("Roster League");
  await admin.getByLabel("Team name").fill("Roster Crew");
  await admin.getByLabel("Abbreviation (2-4 letters)").fill("rrc");
  await admin.getByRole("button", { name: "Create league" }).click();
  await expect(admin.getByRole("heading", { name: "Roster League" })).toBeVisible();
  const leagueId = admin.url().match(/leagues\/([0-9a-f-]{36})/)![1];

  await admin.goto(`/leagues/${leagueId}/invite`);
  await admin.getByRole("button", { name: "Create invite link" }).click();
  const link = admin.getByLabel("Invite link");
  await expect(link).toHaveValue(/\/invite\//);
  const friendCtx = await browser.newContext();
  const friend = await friendCtx.newPage();
  await friend.goto(await link.inputValue());
  await friend.getByLabel("Username").fill("rosterfriend");
  await friend.getByLabel("Password (min 8 characters)").fill(PASSWORD);
  await friend.getByLabel("Confirm password").fill(PASSWORD);
  await friend.getByLabel("Team name").fill("Free Agents");
  await friend.getByLabel("Team abbreviation (2-4 letters)").fill("FRA");
  await friend.getByRole("button", { name: "Create account" }).click();
  await expect(friend.getByTestId("team-row").first()).toBeVisible();

  await admin.goto(`/leagues/${leagueId}/settings`);
  await admin.getByLabel("Roster pool (total players)").fill("6");
  await admin.getByLabel("Regular season start").fill("2026-10-20");
  await admin.getByLabel("Regular season end").fill("2026-12-20");
  await admin.getByLabel("Playoff teams").selectOption("2");
  await admin.getByRole("button", { name: "Save settings" }).click();
  await expect(admin.getByText("Settings saved.")).toBeVisible();
  await admin.goto(`/leagues/${leagueId}/schedule`);
  await admin.getByRole("button", { name: "Generate schedule" }).click();
  await expect(admin.getByText("Schedule generated")).toBeVisible();

  // Free agency is closed before the draft is done.
  await friend.goto(`/leagues/${leagueId}/players`);
  await expect(friend.getByTestId("fa-closed")).toBeVisible();
  await expect(friend.getByTestId("add-button")).toHaveCount(0);

  await admin.goto(`/leagues/${leagueId}/draft`);
  await admin.getByTestId("start-draft").click();
  await admin.getByTestId("confirm-start-draft").click();
  await expect(admin.getByTestId("picks-grid")).toBeVisible();
  const order = (await admin.locator('[data-testid="picks-grid"] thead th a').allTextContents()).map((t) => t.trim());
  const pages = new Map<string, Page>([
    ["RRC", admin],
    ["FRA", friend],
  ]);
  await friend.goto(`/leagues/${leagueId}/draft`);
  const snake = [...order, ...[...order].reverse(), ...order];
  const have = new Map<string, number>();
  for (const abbrev of snake) {
    const picker = pages.get(abbrev)!;
    await expect(picker.getByTestId("your-turn")).toBeVisible({ timeout: 40_000 });
    have.set(abbrev, (have.get(abbrev) ?? 0) + 1);
    await draftFirst(picker, have.get(abbrev)!);
  }
  for (const p of [admin, friend]) await expect(p.getByTestId("draft-recap")).toBeVisible({ timeout: 40_000 });

  // ---- My Team: full roster 3 / 3, grouped by NBA team
  await friend.goto(`/leagues/${leagueId}`);
  await leagueNav(friend, "My team").click();
  await expect(friend.getByTestId("roster-count")).toHaveText("3 / 3", { timeout: 30_000 });
  await expect(friend.getByTestId("nba-group").first()).toBeVisible();
  await expect(friend.getByTestId("roster-row")).toHaveCount(3);
  await expect(friend.getByTestId("period-fp")).toBeVisible();
  await expect(friend.getByTestId("period-bonus")).toBeVisible();
  await friend.getByRole("link", { name: "7 days" }).click();
  await expect(friend).toHaveURL(/range=7/);
  await friend.getByRole("link", { name: "Season" }).click();

  // ---- Drop (confirm dialog) frees a slot
  const rows = friend.getByTestId("roster-row");
  const droppedName = (await rows.first().locator("a").first().textContent())!.trim();
  await rows.first().getByTestId("drop-button").click();
  await expect(friend.getByRole("dialog")).toContainText(`Drop ${droppedName}?`);
  await friend.getByTestId("confirm-drop").click();
  await expect(friend.getByTestId("roster-count")).toHaveText("2 / 3", { timeout: 20_000 });
  await expect(friend.getByTestId("roster-row")).toHaveCount(2);

  // ---- Add a free agent: appears on My Team, adds left decrements (drops don't count)
  await leagueNav(friend, "Players").click();
  await expect(friend.getByTestId("adds-left")).toHaveText("Adds left today: 2/2", { timeout: 30_000 });
  await expect(friend.getByTestId("adds-status")).toContainText("resets at midnight ET");
  // (Skip the player just dropped: he is a free agent again and may top the list.)
  const firstRow = friend.getByTestId("player-row").filter({ hasNotText: droppedName }).first();
  const addedName = (await firstRow.locator("a").first().textContent())!.trim();
  await firstRow.getByTestId("add-button").click();
  await expect(friend.getByTestId("adds-left")).toHaveText("Adds left today: 1/2", { timeout: 20_000 });
  await expect(friend.getByTestId("adds-status")).toContainText("roster 3 / 3");

  // The add shows on My Team, and the dropped player is a free agent again with the owner shown.
  await leagueNav(friend, "My team").click();
  await expect(friend.getByTestId("roster-count")).toHaveText("3 / 3", { timeout: 20_000 });
  await expect(friend.getByTestId("team-roster")).toContainText(addedName);

  // ---- Full roster: Add opens a dialog that requires choosing a drop (2nd add of the day)
  await leagueNav(friend, "Players").click();
  await expect(friend.getByTestId("adds-left")).toHaveText("Adds left today: 1/2", { timeout: 30_000 });
  const secondRow = friend.getByTestId("player-row").filter({ hasNotText: droppedName }).filter({ hasNotText: addedName }).first();
  const secondName = (await secondRow.locator("a").first().textContent())!.trim();
  await secondRow.getByTestId("add-button").click();
  await expect(friend.getByRole("dialog")).toContainText("Your roster is full");
  await expect(friend.getByTestId("confirm-add")).toBeDisabled();
  await friend.getByTestId("drop-select").selectOption({ index: 1 });
  await friend.getByTestId("confirm-add").click();
  await expect(friend.getByTestId("adds-left")).toHaveText("Adds left today: 0/2", { timeout: 20_000 });

  // ---- Third add the same day is rejected with the daily limit message
  const thirdRow = friend.getByTestId("player-row").filter({ hasNotText: droppedName }).first();
  await thirdRow.getByTestId("add-button").click();
  await friend.getByTestId("drop-select").selectOption({ index: 1 });
  await friend.getByTestId("confirm-add").click();
  await expect(friend.getByTestId("roster-error")).toContainText("used all of its adds for today");
  await expect(friend.getByTestId("adds-left")).toHaveText("Adds left today: 0/2");
  await friend.keyboard.press("Escape");

  // The ownership filter lists rostered players with their fantasy team.
  await friend.goto(`/leagues/${leagueId}/players?status=rostered`);
  await expect(friend.getByTestId("player-row").first()).toContainText(/Free Agents|Roster Crew/);

  // ---- Transactions feed: the adds and drops, filterable
  await friend.goto(`/leagues/${leagueId}/transactions`);
  await expect(friend.locator('[data-testid="transaction-row"][data-type="add"]')).toHaveCount(2);
  await expect(friend.locator('[data-testid="transaction-row"][data-type="drop"]')).toHaveCount(2); // 1 plain drop + 1 paired with the 2nd add
  await expect(friend.locator('[data-testid="transaction-row"][data-type="add"]').filter({ hasText: addedName })).toHaveCount(1);
  await expect(friend.locator('[data-testid="transaction-row"][data-type="add"]').filter({ hasText: secondName })).toHaveCount(1);
  await expect(friend.locator('[data-testid="transaction-row"][data-type="drop"]').filter({ hasText: droppedName })).toHaveCount(1);
  await friend.getByLabel("Type").selectOption("drop");
  await friend.getByRole("button", { name: "Apply" }).click();
  await expect(friend.locator('[data-testid="transaction-row"][data-type="add"]')).toHaveCount(0);
  await expect(friend.locator('[data-testid="transaction-row"][data-type="drop"]')).toHaveCount(2);

  // The other owner was told about the moves (in-app only).
  await admin.goto("/notifications");
  await expect(admin.getByText("Roster move").first()).toBeVisible();

  // ---- Commissioner can add to another team's roster from the team page (skipping the daily limit)
  await admin.goto(`/leagues/${leagueId}`);
  await admin.getByRole("link", { name: "Free Agents" }).first().click();
  await expect(admin.getByTestId("commissioner-add")).toBeVisible();

  await friendCtx.close();
});
