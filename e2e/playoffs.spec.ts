import { expect, test, type Page } from "@playwright/test";
import { addDays, etWeekRange } from "../src/lib/nba/dates";

/**
 * Uses "Playoff League" from scripts/seed-e2e-playoffs.ts: 4 teams, 4 weekly periods in the future
 * (2 regular, a semifinal week, a final week), fixed weekly scores Hoop Squad 44, Alpha Squad 30,
 * Beta Squad 24, Gamma Squad 10. Time is moved with the cron route's ?now= test hook (PGlite only).
 */
const CRON = { Authorization: "Bearer e2e-cron-secret" };
const FIRST_WEEK = addDays(etWeekRange(new Date()).startDate, 7);
/** Noon ET-ish on the Monday after period n (1-based) ends. */
const after = (n: number) => `${addDays(FIRST_WEEK, 7 * n)}T16:00:00Z`;

async function login(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: `Welcome, ${username}` })).toBeVisible();
}

const leagueNav = (page: Page, name: string) => page.getByRole("navigation", { name: "League" }).getByRole("link", { name });

test("playoffs: seeding, rounds, champion, history, next season and keepers", async ({ page, request }) => {
  test.setTimeout(600_000);
  await login(page, "admin", "e2e-admin-password");
  await page.goto("/leagues");
  await page.getByRole("link", { name: /Playoff League/ }).first().click();
  await expect(page.getByRole("heading", { name: "Playoff League" })).toBeVisible();
  const leagueId = page.url().match(/leagues\/([0-9a-f-]{36})/)![1];
  const cron = async (n: number) => {
    const res = await request.post(`/api/cron/matchups?leagueId=${leagueId}&now=${encodeURIComponent(after(n))}`, { headers: CRON });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.matchups.errors).toEqual([]);
    return body.matchups as { playoffsSeeded: number; playoffMatchups: number; playoffGamesDecided: number; leaguesCompleted: number };
  };

  // ---- Before the regular season ends: no bracket yet, just the cut line
  await leagueNav(page, "Playoffs").click();
  await expect(page.getByTestId("bracket-empty")).toContainText("top 4 teams");

  // ---- Regular season over: bracket seeded from the standings, round 1 matchups created
  const seeded = await cron(2);
  expect(seeded).toMatchObject({ playoffsSeeded: 1, playoffMatchups: 2 });
  await page.reload();
  await expect(page.getByTestId("bracket")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Playoffs", { exact: true }).first()).toBeVisible(); // status badge
  const rounds = page.getByTestId("bracket-round");
  await expect(rounds).toHaveCount(2);
  await expect(rounds.nth(0)).toContainText("Semifinal");
  await expect(rounds.nth(1)).toContainText("Final");
  const semis = rounds.nth(0).getByTestId("bracket-slot");
  await expect(semis).toHaveCount(2);
  await expect(semis.nth(0).getByTestId("bracket-team")).toHaveText([/1\s*Hoop Squad/, /4\s*Gamma Squad/]);
  await expect(semis.nth(1).getByTestId("bracket-team")).toHaveText([/2\s*Alpha Squad/, /3\s*Beta Squad/]);
  await expect(rounds.nth(1).getByTestId("bracket-team").first()).toHaveText("TBD");
  // The re-seed tool is offered to the commissioner before round 1 starts.
  await expect(page.getByTestId("reseed-button")).toBeVisible();

  // A second run changes nothing.
  expect(await cron(2)).toMatchObject({ playoffsSeeded: 0, playoffMatchups: 0, playoffGamesDecided: 0 });

  // ---- Semifinals played and finalized: winners advance, the final is set
  const decided = await cron(3);
  expect(decided).toMatchObject({ playoffGamesDecided: 2, playoffMatchups: 1, leaguesCompleted: 0 });
  await page.reload();
  await expect(semis.nth(0).getByTestId("bracket-team").first().getByTestId("bracket-score")).toHaveText("44.0", { timeout: 60_000 });
  await expect(semis.nth(0).getByTestId("bracket-team").nth(1).getByTestId("bracket-score")).toHaveText("10.0");
  await expect(semis.nth(0).locator('[data-winner="true"]')).toContainText("Hoop Squad");
  await expect(semis.nth(1).locator('[data-winner="true"]')).toContainText("Alpha Squad");
  const final = rounds.nth(1).getByTestId("bracket-slot");
  await expect(final.getByTestId("bracket-team")).toHaveText([/1\s*Hoop Squad/, /2\s*Alpha Squad/]);
  await expect(page.getByTestId("champion")).toHaveCount(0);
  await expect(page.getByTestId("reseed-button")).toHaveCount(0); // too late once round 1 is final

  // Matchup pages handle playoff matchups: labelled by round.
  await semis.nth(0).getByRole("link", { name: "Box score" }).click();
  await expect(page.getByRole("heading", { name: "Semifinal" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("box-score")).toBeVisible({ timeout: 60_000 });
  await page.goBack();

  // ---- Final played: champion, league complete, everyone notified
  expect(await cron(4)).toMatchObject({ playoffGamesDecided: 1, leaguesCompleted: 1 });
  await page.reload();
  await expect(page.getByTestId("champion")).toContainText("Hoop Squad are champions!", { timeout: 60_000 });
  await expect(page.getByText("Complete", { exact: true }).first()).toBeVisible();
  expect(await cron(4)).toMatchObject({ playoffsSeeded: 0, leaguesCompleted: 0 });
  await page.goto("/notifications");
  await expect(page.getByText("Hoop Squad are champions!").first()).toBeVisible();

  // Mobile: rounds stack vertically.
  await page.goBack();
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.getByTestId("bracket")).toBeVisible();
  const [semiBox, finalBox] = await Promise.all([rounds.nth(0).boundingBox(), rounds.nth(1).boundingBox()]);
  expect(finalBox!.y).toBeGreaterThan(semiBox!.y + semiBox!.height - 1);
  await page.setViewportSize({ width: 1280, height: 800 });

  // ---- History: the champion is listed, with final standings
  await leagueNav(page, "History").click();
  await expect(page.getByTestId("champion-row")).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId("champion-row")).toContainText("Hoop Squad");
  const results = page.getByTestId("season-card").first().getByTestId("result-row");
  await expect(results).toHaveCount(4);
  await expect(results.nth(0)).toContainText("Hoop Squad");
  await expect(results.nth(0)).toContainText("Champion");
  await expect(results.nth(1)).toContainText("Alpha Squad");
  await expect(results.nth(1)).toContainText("Runner-up");
  await expect(results.nth(3)).toContainText("Gamma Squad");

  // ---- Commissioner starts the next season: same teams, status setup
  await page.getByTestId("start-next-season").click();
  await expect(page).not.toHaveURL(new RegExp(leagueId), { timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Playoff League" })).toBeVisible();
  await expect(page.getByText("Setup", { exact: true }).first()).toBeVisible();
  const rows = page.getByTestId("team-row");
  await expect(rows).toHaveCount(4);
  for (const name of ["Hoop Squad", "Alpha Squad", "Beta Squad", "Gamma Squad"]) {
    await expect(rows.filter({ hasText: name })).toHaveCount(1);
  }
  const nextId = page.url().match(/leagues\/([0-9a-f-]{36})/)![1];
  expect(nextId).not.toBe(leagueId);

  // The old season now sits under "Past seasons".
  await page.goto("/leagues");
  await expect(page.getByTestId("past-seasons")).toContainText("Playoff League");

  // ---- Keepers: the owner picks a keeper from last season's roster (the inactive player is not offered)
  await page.goto(`/leagues/${nextId}`);
  await leagueNav(page, "Keepers").click();
  await expect(page.getByRole("heading", { name: "Keepers" })).toBeVisible();
  const mine = page.getByRole("form", { name: "Keepers for Hoop Squad" });
  await expect(mine.getByTestId("keeper-row")).toHaveCount(1, { timeout: 60_000 });
  await expect(mine).toContainText("E3 Star One");
  await expect(mine).not.toContainText("E3 Cut One");
  await mine.getByRole("checkbox", { name: "Keep E3 Star One" }).check();
  await expect(mine.getByTestId("keeper-count")).toHaveText("1 of 1 selected");
  await mine.getByTestId("save-keepers").click();
  await expect(page.getByText("Saved 1 keeper")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("form", { name: "Keepers for Hoop Squad" }).getByRole("checkbox", { name: "Keep E3 Star One" })).toBeChecked();

  // The draft lobby reflects the keeper.
  await leagueNav(page, "Draft").click();
  await expect(page.getByTestId("keepers-card")).toContainText("E3 Star One", { timeout: 60_000 });

  // Team pages show the owner's past finishes.
  await page.goto(`/leagues/${nextId}`);
  await page.getByTestId("team-row").filter({ hasText: "Hoop Squad" }).getByRole("link", { name: "Hoop Squad" }).click();
  await expect(page.getByTestId("past-season-row")).toContainText("Champion", { timeout: 60_000 });

  // A member (not the commissioner) sees only their own team on the keepers page.
  const ctx = await page.context().browser()!.newContext();
  const friend = await ctx.newPage();
  await login(friend, "pfriend1", "friend-password-1");
  await friend.goto(`/leagues/${nextId}/keepers`);
  await expect(friend.getByTestId("keepers-team")).toHaveCount(1, { timeout: 60_000 });
  await expect(friend.getByRole("form", { name: "Keepers for Alpha Squad" })).toBeVisible();
  await ctx.close();
});
