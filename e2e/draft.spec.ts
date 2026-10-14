import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

const PASSWORD = "friend-password-1";

type Player = { page: Page; context: BrowserContext; abbrev: string; name: string; username: string };

async function newInvitee(browser: Browser, inviteUrl: string, username: string, name: string, abbrev: string): Promise<Player> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(inviteUrl);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password (min 8 characters)").fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByLabel("Team name").fill(name);
  await page.getByLabel("Team abbreviation (2-4 letters)").fill(abbrev);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId("team-row").first()).toBeVisible();
  return { page, context, abbrev, name, username };
}

/** Ids of the players currently listed in the available-players table. */
const listedIds = (page: Page) =>
  page.locator('[data-testid="player-row"]').evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset.playerId)));

const rosterCount = (page: Page) => page.getByTestId("my-roster-item").count();

/** Drafts the first listed player (the list hides picked players as soon as the board updates). */
async function draftFirst(page: Page, target: number) {
  await expect(page.getByTestId("draft-button").first()).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId("draft-button").first().click();
  await expect.poll(() => rosterCount(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(target);
}

/** Waits (briefly) for my roster to reach `count`; false when it didn't, e.g. the click lost a race. */
const reachedRoster = (page: Page, count: number) =>
  expect
    .poll(() => rosterCount(page), { timeout: 8_000 })
    .toBeGreaterThanOrEqual(count)
    .then(
      () => true,
      () => false,
    );

/** Drafts players with ids in residue class `slot` (mod 4) until my roster reaches `target`, so teams don't collide. */
async function draftUntil(page: Page, slot: number, target: number) {
  for (let guard = 0; guard < 12; guard++) {
    const have = await rosterCount(page);
    if (have >= target) return;
    await expect(page.getByTestId("draft-button").first()).toBeEnabled({ timeout: 30_000 });
    const ids = await listedIds(page);
    const id = ids.find((x) => x % 4 === slot) ?? ids[slot];
    try {
      // The row can vanish when the list refreshes (e.g. it was my previous pick): then re-read the list.
      await page.locator(`[data-player-id="${id}"]`).getByTestId("draft-button").click({ timeout: 4_000 });
    } catch {
      await page.waitForTimeout(1_000);
      continue;
    }
    if (!(await reachedRoster(page, have + 1))) await page.waitForTimeout(1_500);
  }
  expect(await rosterCount(page)).toBeGreaterThanOrEqual(target);
}

test("4-team draft: queue, snake, simultaneous waves, commissioner pick, completion", async ({ page: admin, browser }) => {
  test.setTimeout(600_000);

  // ---- Commissioner creates the league
  await admin.goto("/login");
  await admin.getByLabel("Username").fill("admin");
  await admin.getByLabel("Password").fill("e2e-admin-password");
  await admin.getByRole("button", { name: "Log in" }).click();
  await expect(admin.getByRole("heading", { name: "Welcome, admin" })).toBeVisible();
  await admin.goto("/leagues/new");
  await admin.getByLabel("League name").fill("Draft League");
  await admin.getByLabel("Team name").fill("Commish Crew");
  await admin.getByLabel("Abbreviation (2-4 letters)").fill("ccd");
  await admin.getByRole("button", { name: "Create league" }).click();
  await expect(admin.getByRole("heading", { name: "Draft League" })).toBeVisible();
  const leagueId = admin.url().match(/leagues\/([0-9a-f-]{36})/)![1];

  // ---- Three friends join through invite links
  const users: Player[] = [];
  const specs = [
    ["drafter1", "Alpha Squad", "UAA"],
    ["drafter2", "Bravo Boys", "UBB"],
    ["drafter3", "Charlie Crew", "UCC"],
  ] as const;
  // One reusable link serves all three friends.
  await admin.goto(`/leagues/${leagueId}/invite`);
  await admin.getByRole("button", { name: "Create invite link" }).click();
  const link = admin.getByLabel("Invite link");
  await expect(link).toHaveValue(/\/invite\//);
  const inviteUrl = await link.inputValue();
  for (const [username, name, abbrev] of specs) {
    users.push(await newInvitee(browser, inviteUrl, username, name, abbrev));
  }
  const admins: Player = { page: admin, context: admin.context(), abbrev: "CCD", name: "Commish Crew", username: "admin" };
  const all = [admins, ...users];

  // ---- Settings: 24-player pool -> 6 per team, snake target 8 -> 2 snake rounds, then 2 waves of 2
  await admin.goto(`/leagues/${leagueId}/settings`);
  await admin.getByLabel("Roster pool (total players)").fill("24");
  await admin.getByLabel("Snake picks target").fill("8");
  await admin.getByLabel("Regular season start").fill("2026-10-20");
  await admin.getByLabel("Regular season end").fill("2026-12-20");
  await admin.getByLabel("Playoff teams").selectOption("2");
  await admin.getByRole("button", { name: "Save settings" }).click();
  await expect(admin.getByText("Settings saved.")).toBeVisible();

  // ---- Starting without a schedule is blocked with a clear message
  await admin.goto(`/leagues/${leagueId}/draft`);
  await expect(admin.getByTestId("schedule-required")).toContainText("Generate the schedule first");
  await expect(admin.getByTestId("start-draft")).toBeDisabled();

  await admin.goto(`/leagues/${leagueId}/schedule`);
  await admin.getByRole("button", { name: "Generate schedule" }).click();
  await expect(admin.getByText("Schedule generated")).toBeVisible();

  // ---- Pre-draft: format preview and a queue
  await admin.goto(`/leagues/${leagueId}/draft`);
  const format = admin.getByTestId("draft-format");
  await expect(format).toContainText("Max roster");
  await expect(format).toContainText("6");
  await expect(admin.getByText("2 waves of 2")).toBeVisible();
  await expect(admin.getByTestId("start-draft")).toBeEnabled();

  const queuer = users[0].page;
  await queuer.goto(`/leagues/${leagueId}/draft`);
  await expect(queuer.getByText("Waiting for the commissioner to start the draft.")).toBeVisible();
  await expect(queuer.getByTestId("start-draft")).toHaveCount(0);
  // Default sort: last season's total FP, descending (players without a last season are listed last).
  await expect(queuer.getByTestId("player-row").first()).toBeVisible();
  await expect(queuer.getByRole("columnheader", { name: /^Last FP( ▼)?$/ }).first()).toHaveAttribute("aria-sort", "descending");
  const lastFps = (await queuer.locator('[data-testid="player-search"] [data-testid="last-fp"]').allTextContents())
    .map((t) => Number(t))
    .filter((n) => !Number.isNaN(n));
  expect(lastFps.length).toBeGreaterThan(0);
  expect(lastFps).toEqual([...lastFps].sort((a, b) => b - a));
  await queuer.getByTestId("queue-button").nth(0).click();
  await expect(queuer.getByTestId("queue-item")).toHaveCount(1);
  await queuer.getByTestId("queue-button").nth(0).click();
  await expect(queuer.getByTestId("queue-item")).toHaveCount(2);
  const queuedNames = await queuer.getByTestId("queue-item").locator("span.truncate").allTextContents();
  await queuer.getByRole("button", { name: `Move ${queuedNames[1]} up` }).click();
  await expect(queuer.getByTestId("queue-item").first()).toContainText(queuedNames[1]);

  // ---- Start (confirm dialog explains the randomized order)
  await admin.getByTestId("start-draft").click();
  await expect(admin.getByText("The draft order will be randomized")).toBeVisible();
  await admin.getByTestId("confirm-start-draft").click();
  await expect(admin.getByTestId("draft-status")).toContainText("Snake draft");
  await expect(admin.getByTestId("picks-grid")).toBeVisible();

  // Members see the live board and the clock.
  for (const u of users) {
    await u.page.goto(`/leagues/${leagueId}/draft`);
    await expect(u.page.getByTestId("on-the-clock")).toContainText("On the clock:");
  }
  // "Draft started" reached every member's in-app bell.
  await users[1].page.reload();
  await expect(users[1].page.getByTestId("bell-count")).toBeVisible();

  // ---- Snake: 2 rounds x 4 teams, strictly in order
  const orderInDraft = (await admin.locator('[data-testid="picks-grid"] thead th a').allTextContents()).map((t) => t.trim());
  expect([...orderInDraft].sort()).toEqual(["CCD", "UAA", "UBB", "UCC"]);
  const byAbbrev = new Map(all.map((p) => [p.abbrev, p]));
  const snakeOrder = [...orderInDraft, ...[...orderInDraft].reverse()];
  let usedQueue = false;
  for (let i = 0; i < snakeOrder.length; i++) {
    const picker = byAbbrev.get(snakeOrder[i])!;
    await expect(picker.page.getByTestId("your-turn")).toBeVisible({ timeout: 40_000 });
    // Someone else cannot draft right now.
    const other = all.find((p) => p !== picker)!;
    await expect(other.page.getByTestId("your-turn")).toHaveCount(0);
    await expect(other.page.getByTestId("draft-button").first()).toBeDisabled();
    const have = snakeOrder.slice(0, i + 1).filter((x) => x === picker.abbrev).length;
    if (picker === users[0] && !usedQueue && (await picker.page.getByTestId("draft-top-of-queue").count()) > 0) {
      usedQueue = true; // the queue shortcut drafts its top player
      await picker.page.getByTestId("draft-top-of-queue").click();
      await expect.poll(() => rosterCount(picker.page), { timeout: 15_000 }).toBeGreaterThanOrEqual(have);
    } else {
      await draftFirst(picker.page, have);
    }
  }

  // ---- Wave 1: everyone at once
  for (const p of all) await expect(p.page.getByTestId("wave-status")).toContainText("Wave 1", { timeout: 40_000 });
  for (const p of all) await expect(p.page.getByTestId("your-turn")).toBeVisible();

  // Two teams race for the very same player: exactly one wins.
  const [racerA, racerB] = [users[1], users[2]];
  await expect(racerA.page.getByTestId("draft-button").first()).toBeEnabled();
  await expect(racerB.page.getByTestId("draft-button").first()).toBeEnabled();
  const [idA, idB] = await Promise.all([listedIds(racerA.page), listedIds(racerB.page)]);
  const contested = idA.find((x) => idB.includes(x))!;
  await Promise.all([
    racerA.page.locator(`[data-player-id="${contested}"]`).getByTestId("draft-button").click(),
    racerB.page.locator(`[data-player-id="${contested}"]`).getByTestId("draft-button").click(),
  ]);
  const lost = (p: Player) => p.page.getByText(/just taken|just drafted or is already on a roster/).count();
  await expect.poll(async () => (await lost(racerA)) + (await lost(racerB)), { timeout: 15_000 }).toBeGreaterThan(0);

  // Everyone finishes wave 1 (4 picks each) concurrently.
  await Promise.all(all.map((p, i) => draftUntil(p.page, i, 4)));
  for (const p of all) await expect(p.page.getByTestId("wave-status")).toContainText("Wave 2", { timeout: 40_000 });

  // ---- Wave 2: one team stalls; the commissioner picks for it
  const idle = users[0];
  const active = all.filter((p) => p !== idle);
  await Promise.all(active.map((p) => draftUntil(p.page, all.indexOf(p), 6)));
  // Wait until the commissioner's board shows ONLY the idle team still owing picks. Picking while
  // other teams are still finishing races them for players (correctly rejected as "just taken"),
  // and their "(1 left)" would make the check below pass for the wrong team.
  await expect(admin.getByTestId("wave-status")).toContainText(`waiting on ${idle.name} (2 left).`, { timeout: 40_000 });

  await admin.getByText("Pick for team...").click();
  await admin.getByLabel("Team to pick for").selectOption({ label: `${idle.name} (2 left)` });
  await admin.getByTestId("commissioner-pick-button").first().click();
  await expect(admin.getByTestId("wave-status")).toContainText(`waiting on ${idle.name} (1 left).`, { timeout: 20_000 });
  // The list hides the player just picked as soon as the board updates, so a single click completes the draft.
  await expect(admin.getByTestId("commissioner-pick-button").first()).toBeEnabled();
  await admin.getByTestId("commissioner-pick-button").first().click();

  // ---- Complete: recap, rosters, league status
  for (const p of all) await expect(p.page.getByTestId("draft-recap")).toBeVisible({ timeout: 40_000 });
  await expect(admin.getByTestId("recap-team")).toHaveCount(4);
  await expect(admin.getByText("by commish").first()).toBeVisible();

  await admin.goto(`/leagues/${leagueId}`);
  await expect(admin.getByRole("heading", { name: "Draft League" }).locator("xpath=..").getByText("In season")).toBeVisible();
  await expect(admin.getByTestId("draft-card")).toHaveCount(0); // hidden once the draft is complete
  await expect(admin.getByTestId("standings-snapshot")).toBeVisible();

  await admin.goto(`/leagues/${leagueId}/draft`);
  await admin.getByTestId("recap-team").filter({ hasText: idle.name }).getByRole("link", { name: idle.name }).click();
  await expect(admin.getByTestId("roster-row")).toHaveCount(6, { timeout: 30_000 }); // first compile of the team page
  await expect(admin.getByTestId("roster-count")).toHaveText("6 / 6");

  // ---- Notifications: in-app list, mark all read
  const member = users[1].page;
  await member.goto("/notifications");
  await expect(member.getByText("Draft started").first()).toBeVisible();
  await expect(member.getByText("Draft complete").first()).toBeVisible();
  await expect(member.getByTestId("notification-item").first()).toHaveAttribute("data-unread", "true");
  await member.getByTestId("mark-all-read").click();
  await expect(member.getByTestId("bell-count")).toHaveCount(0);

  // ---- Push settings: no VAPID keys in e2e, so the page explains it
  await member.goto("/settings/notifications");
  await expect(member.getByText("What to notify me about")).toBeVisible();
  await expect(member.getByTestId("push-not-configured")).toBeVisible();

  for (const u of users) await u.context.close();
});
