/**
 * Key UI flows at 16-team / 32-man scale, one set per checkpoint. Each checkpoint database is a disposable copy, so the
 * flows mutate it freely. Runs after crawl.spec.ts (file order), so the crawl always sees the untouched data.
 */
import { expect, test, type Page } from "@playwright/test";
import type { LeagueMeta, SimUserMeta } from "../scripts/sim/common";
import { CP, meta, newSession, record, type Session } from "./lib";

const L = meta.league;
const userOfTeam = (l: LeagueMeta, teamId: string): SimUserMeta => {
  const t = l.teams.find((x) => x.id === teamId)!;
  return meta.users.find((u) => u.userId === t.ownerId)!;
};
const snakeIdx = (n: number, teams: number) => {
  const round = Math.floor((n - 1) / teams);
  const pos = (n - 1) % teams;
  return round % 2 === 0 ? pos : teams - 1 - pos;
};
const only = (...cps: string[]) => test.skip(!cps.includes(CP), `flows for ${cps.join("/")} only`);

/** Logs a flow step into the results (so the summary shows what was exercised) and fails fast with the page errors. */
function step(s: Session, name: string, started: number, extra: string[] = []) {
  const problems = [...s.buffer, ...extra];
  s.buffer.length = 0;
  record({ cp: CP, role: "flow", name, url: s.page.url().replace(/^https?:\/\/[^/]+/, ""), finalPath: "", status: 200, ttfbMs: null, loadMs: Date.now() - started, ok: problems.length === 0, problems });
  expect(problems, `${name}: browser errors`).toEqual([]);
}

const leagueNav = (page: Page, name: string) => page.getByRole("navigation", { name: "League" }).getByRole("link", { name });

// ============================================================================================ setup
test.describe("setup", () => {
  only("setup");

  test("a new user joins through the league invite link", async ({ browser }) => {
    const s = await newSession(browser, "flow", null, { login: false });
    const t0 = Date.now();
    await s.page.goto(`/invite/${L.invites.active}`);
    await expect(s.page.getByText("You're invited")).toBeVisible();
    await expect(s.page.getByText(`join ${L.name}`)).toBeVisible();
    await s.page.getByLabel("Username").fill("uiguy");
    await s.page.getByLabel("Password (min 8 characters)").fill("ui-guy-pass-1");
    await s.page.getByLabel("Confirm password").fill("ui-guy-pass-1");
    await s.page.getByLabel("Team name").fill("UI Guys");
    await s.page.getByLabel("Team abbreviation (2-4 letters)").fill("UIG");
    await s.page.getByRole("button", { name: "Create account" }).click();
    await expect(s.page.getByTestId("team-row").filter({ hasText: "UI Guys" })).toBeVisible({ timeout: 60_000 });
    await expect(s.page.getByTestId("team-row")).toHaveCount(17);
    step(s, "flow: redeem league invite", t0);
    await s.context.close();
  });

  test("commissioner: settings save, schedule regenerates, invite link created and revoked", async ({ browser }) => {
    const s = await newSession(browser, "flow", meta.commissioner);
    const { page } = s;
    let t0 = Date.now();
    await page.goto(`/leagues/${L.id}/settings`);
    await page.getByLabel("Trade deadline (optional)").fill("2027-03-05");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible({ timeout: 30_000 });
    step(s, "flow: save settings", t0);

    // A new team cleared the schedule: the schedule page offers to build it again (17 teams, odd: byes).
    t0 = Date.now();
    await page.goto(`/leagues/${L.id}/schedule`);
    await page.getByRole("button", { name: "Generate schedule" }).click();
    await expect(page.getByText("Schedule generated")).toBeVisible({ timeout: 60_000 });
    await page.goto(`/leagues/${L.id}/schedule`);
    await expect(page.getByTestId("schedule-period").first()).toBeVisible();
    expect(await page.getByTestId("schedule-period").count()).toBeGreaterThanOrEqual(24);
    step(s, "flow: generate schedule", t0);

    t0 = Date.now();
    await page.goto(`/leagues/${L.id}/invite`);
    const before = await page.getByTestId("invite-row").count();
    // One link is active, so the button offers a replacement (the old link is turned off by default).
    await page.getByRole("button", { name: /Create (new|invite) link/ }).click();
    await expect(page.getByLabel("Invite link")).toHaveValue(/\/invite\//, { timeout: 30_000 });
    await expect(page.getByTestId("invite-member").filter({ hasText: "UI Guys" })).toHaveCount(1); // listed under the link it joined through
    await page.getByRole("button", { name: "Revoke" }).first().click();
    await expect(page.getByText("Revoked").first()).toBeVisible({ timeout: 30_000 });
    expect(await page.getByTestId("invite-row").count()).toBeGreaterThanOrEqual(before);
    step(s, "flow: create and revoke an invite link", t0);
    await s.context.close();
  });
});

// ============================================================================== draft (snake)
test.describe("draft snake", () => {
  only("draft-snake");
  test("on-the-clock owner queues and picks; another owner cannot; commissioner picks for the team on the clock", async ({ browser }) => {
    const d = L.draft!;
    const onClockTeam = d.order[snakeIdx(d.currentPick, d.order.length)];
    const owner = userOfTeam(L, onClockTeam);
    const bystander = meta.users.find((u) => u.role === "member" && u.teamId && u.teamId !== onClockTeam)!;
    const a = await newSession(browser, "flow", owner);
    const b = await newSession(browser, "flow", bystander);
    let t0 = Date.now();
    await a.page.goto(`/leagues/${L.id}/draft`);
    await expect(a.page.getByTestId("your-turn")).toBeVisible({ timeout: 60_000 });
    const picks = async (p: Page) => Number(((await p.getByTestId("draft-status").textContent()) ?? "").match(/(\d+)\/\d+ picks/)![1]);
    const before = await picks(a.page);
    await a.page.getByTestId("queue-button").first().click();
    await expect(a.page.getByTestId("queue-item").first()).toBeVisible({ timeout: 20_000 });
    step(a, "flow: queue a player", t0);

    t0 = Date.now();
    await b.page.goto(`/leagues/${L.id}/draft`);
    await expect(b.page.getByTestId("draft-status")).toBeVisible({ timeout: 60_000 });
    await expect(b.page.getByTestId("your-turn")).toHaveCount(0);
    await expect(b.page.getByTestId("draft-button").first()).toBeDisabled({ timeout: 60_000 });
    step(b, "flow: a bystander cannot pick", t0);

    t0 = Date.now();
    await a.page.getByTestId("draft-button").first().click();
    await expect.poll(() => picks(a.page), { timeout: 30_000 }).toBe(before + 1);
    await expect(a.page.getByTestId("your-turn")).toHaveCount(0, { timeout: 30_000 });
    step(a, "flow: make a pick", t0);

    // The commissioner picks for whoever is on the clock now (a stalled team).
    const c = await newSession(browser, "flow", meta.commissioner);
    t0 = Date.now();
    await c.page.goto(`/leagues/${L.id}/draft`);
    await expect(c.page.getByTestId("commissioner-controls")).toBeVisible({ timeout: 60_000 });
    const mid = await picks(c.page);
    await c.page.getByTestId("pick-for-team").locator("summary").click();
    await c.page.getByLabel("Team to pick for").selectOption({ index: 1 });
    await c.page.getByTestId("commissioner-pick-button").first().click();
    await expect.poll(() => picks(c.page), { timeout: 30_000 }).toBe(mid + 1);
    step(c, "flow: commissioner picks for the team on the clock", t0);
    for (const s of [a, b, c]) await s.context.close();
  });
});

// =============================================================================== draft (waves)
test.describe("draft waves", () => {
  only("draft-waves");
  test("a wave pick through the draft room", async ({ browser }) => {
    // Any member who still owes a wave pick; the board lists who is waiting.
    const c = await newSession(browser, "flow", meta.commissioner);
    await c.page.goto(`/leagues/${L.id}/draft`);
    const waiting = await c.page.getByTestId("wave-status").textContent();
    const team = L.teams.find((t) => t.ownerUsername !== "commish" && waiting?.includes(t.name))!;
    const owner = userOfTeam(L, team.id);
    const s = await newSession(browser, "flow", owner);
    const t0 = Date.now();
    await s.page.goto(`/leagues/${L.id}/draft`);
    await expect(s.page.getByTestId("your-turn")).toBeVisible({ timeout: 60_000 });
    const picks = async () => Number(((await s.page.getByTestId("draft-status").textContent()) ?? "").match(/(\d+)\/\d+ picks/)![1]);
    const before = await picks();
    await s.page.getByTestId("draft-button").first().click();
    await expect.poll(picks, { timeout: 30_000 }).toBe(before + 1);
    step(s, "flow: wave pick", t0);
    await s.context.close();
    await c.context.close();
  });
});

// ============================================================================ regular season
test.describe("regular season", () => {
  only("regular-season");
  const member = meta.member;
  const myTeam = L.teams.find((t) => t.ownerId === member.userId)!;
  const other = L.teams.find((t) => t.id !== myTeam.id && t.ownerUsername !== "commish")!;

  test("free agency: add with a drop on a full roster, then the daily limit", async ({ browser }) => {
    const s = await newSession(browser, "flow", member);
    const { page } = s;
    await page.goto(`/leagues/${L.id}/players`);
    const left = async () => Number(((await page.getByTestId("adds-left").textContent()) ?? "").match(/(\d)\/2/)![1]);
    await expect(page.getByTestId("adds-left")).toBeVisible({ timeout: 60_000 });
    let t0 = Date.now();
    let guard = 0;
    while ((await left()) > 0 && guard++ < 3) {
      const before = await left();
      await page.getByTestId("player-row").first().getByTestId("add-button").click();
      const dialogDrop = page.getByTestId("drop-select");
      if (await dialogDrop.count()) {
        await expect(page.getByRole("dialog")).toContainText("Your roster is full");
        await expect(page.getByTestId("confirm-add")).toBeDisabled();
        await dialogDrop.selectOption({ index: 1 });
        await page.getByTestId("confirm-add").click();
      }
      await expect.poll(left, { timeout: 30_000 }).toBe(before - 1);
    }
    step(s, "flow: free-agent adds (with drop when full)", t0);
    t0 = Date.now();
    await page.getByTestId("player-row").first().getByTestId("add-button").click();
    if (await page.getByTestId("drop-select").count()) {
      await page.getByTestId("drop-select").selectOption({ index: 1 });
      await page.getByTestId("confirm-add").click();
    }
    await expect(page.getByTestId("roster-error")).toContainText("used all of its adds for today", { timeout: 30_000 });
    step(s, "flow: third add hits the daily limit", t0);
    await s.context.close();
  });

  test("trade: propose, accept as the other owner, approve as commissioner; trade block", async ({ browser }) => {
    const a = await newSession(browser, "flow", member);
    const bUser = userOfTeam(L, other.id);
    const b = await newSession(browser, "flow", bUser);
    const c = await newSession(browser, "flow", meta.commissioner);
    let t0 = Date.now();
    await a.page.goto(`/leagues/${L.id}/trades/new?with=${other.id}`);
    await expect(a.page.getByTestId("trade-builder")).toBeVisible({ timeout: 60_000 });
    await a.page.getByTestId("give-picker").locator("input[type=checkbox]").first().check();
    await a.page.getByTestId("get-picker").locator("input[type=checkbox]").first().check();
    await a.page.locator("#trade-message").fill("browser pass: swap one for one");
    await a.page.getByTestId("submit-trade").click();
    await expect(a.page.getByTestId("trade-detail")).toHaveAttribute("data-status", "proposed", { timeout: 60_000 });
    const tradeId = a.page.url().match(/trades\/([0-9a-f-]{36})/)![1];
    step(a, "flow: propose a trade", t0);

    t0 = Date.now();
    await b.page.goto(`/leagues/${L.id}/trades/${tradeId}`);
    await b.page.getByTestId("accept-trade").click();
    await expect(b.page.getByTestId("trade-status")).toHaveText("Under review", { timeout: 60_000 });
    step(b, "flow: accept as the other owner", t0);

    t0 = Date.now();
    await c.page.goto(`/leagues/${L.id}/trades/${tradeId}`);
    await c.page.getByTestId("approve-trade").click();
    await expect(c.page.getByTestId("trade-status")).toHaveText("Completed", { timeout: 60_000 });
    step(c, "flow: commissioner approves", t0);

    // Trade block from My Team.
    t0 = Date.now();
    await a.page.goto(`/leagues/${L.id}/teams/${myTeam.id}`);
    // A player who is not on the block yet; re-found by id because the button changes once he is.
    const pid = await a.page.getByTestId("roster-row").filter({ has: a.page.getByTestId("block-button") }).first().getAttribute("data-player-id");
    const row = a.page.locator(`[data-testid="roster-row"][data-player-id="${pid}"]`);
    const name = ((await row.locator("a").first().textContent()) ?? "").trim();
    await row.getByTestId("block-button").click();
    await expect(row.getByTestId("on-block-badge")).toBeVisible({ timeout: 30_000 });
    await a.page.goto(`/leagues/${L.id}/trades/block`);
    await expect(a.page.getByTestId("block-entry").filter({ hasText: name })).toBeVisible();
    step(a, "flow: trade block", t0);
    for (const s of [a, b, c]) await s.context.close();
  });

  test("chat @mention notifies the recipient; notifications can be marked read", async ({ browser }) => {
    const a = await newSession(browser, "flow", member);
    const c = await newSession(browser, "flow", meta.commissioner);
    const t0 = Date.now();
    await a.page.goto(`/leagues/${L.id}/chat`);
    await expect(a.page.getByTestId("chat-list")).toBeVisible({ timeout: 60_000 });
    await a.page.getByTestId("chat-input").fill(`hey @${meta.commissioner.username} browser pass says hi`);
    await a.page.getByTestId("chat-send").click();
    await expect(a.page.getByTestId("chat-message").filter({ hasText: "browser pass says hi" })).toBeVisible({ timeout: 30_000 });
    await c.page.goto("/notifications");
    await expect(c.page.getByText(`${member.username} mentioned you`).first()).toBeVisible({ timeout: 30_000 });
    step(c, "flow: chat mention notification", t0);

    const t1 = Date.now();
    await a.page.goto("/notifications");
    await expect(a.page.getByTestId("notification-item").first()).toBeVisible({ timeout: 30_000 });
    await a.page.getByTestId("mark-all-read").click();
    await expect(a.page.getByTestId("bell-count")).toHaveCount(0, { timeout: 30_000 });
    step(a, "flow: mark notifications read", t1);
    for (const s of [a, c]) await s.context.close();
  });

  test("matchup box score day toggles", async ({ browser }) => {
    const s = await newSession(browser, "flow", member);
    const t0 = Date.now();
    await s.page.goto(`/leagues/${L.id}/matchup/${L.matchups.current}`);
    await expect(s.page.getByTestId("box-score")).toBeVisible({ timeout: 60_000 });
    const total = (await s.page.getByTestId("box-score").getAttribute("data-view")) ?? "";
    const tabs = s.page.getByTestId("day-tab");
    expect(await tabs.count()).toBeGreaterThanOrEqual(7);
    await tabs.nth(2).click();
    await expect(s.page.getByTestId("box-score")).toHaveAttribute("data-view", /\d{4}-\d{2}-\d{2}/);
    await tabs.nth(5).click();
    await expect(s.page.getByTestId("box-score")).toHaveAttribute("data-view", /\d{4}-\d{2}-\d{2}/);
    await s.page.getByTestId("period-total-tab").click();
    await expect(s.page.getByTestId("box-score")).toHaveAttribute("data-view", total || "total");
    step(s, "flow: box score day toggles", t0);
    await s.context.close();
  });

  test("commissioner adjusts a past week's score", async ({ browser }) => {
    const c = await newSession(browser, "flow", meta.commissioner);
    const t0 = Date.now();
    await c.page.goto(`/leagues/${L.id}/commissioner`);
    const form = c.page.getByTestId("score-adjust");
    await form.getByLabel("Period").selectOption({ label: "Week 3" });
    await form.getByLabel("Matchup").selectOption({ index: 1 });
    await form.getByLabel("Team to adjust").selectOption({ index: 1 });
    await form.getByLabel("Points (+ or -)").fill("12.5");
    await form.getByLabel("Reason").fill("Browser pass: stat correction");
    await c.page.getByTestId("apply-adjustment").click();
    await expect(c.page.getByText("Adjustment saved. Totals were recalculated.")).toBeVisible({ timeout: 60_000 });
    await expect(c.page.getByTestId("recent-adjustments")).toContainText("Browser pass: stat correction");
    step(c, "flow: commissioner score adjustment", t0);
    await c.context.close();
  });
});

// ================================================================================== playoffs
test.describe("playoffs", () => {
  only("playoffs");
  test("bracket and a playoff matchup render", async ({ browser }) => {
    const s = await newSession(browser, "flow", meta.member);
    const t0 = Date.now();
    await s.page.goto(`/leagues/${L.id}/playoffs`);
    await expect(s.page.getByTestId("bracket")).toBeVisible({ timeout: 60_000 });
    expect(await s.page.getByTestId("bracket-slot").count()).toBe(7);
    expect(await s.page.getByTestId("bracket-round").count()).toBe(3);
    expect(await s.page.getByTestId("seed").count()).toBeGreaterThanOrEqual(8);
    await s.page.goto(`/leagues/${L.id}/matchup/${L.matchups.playoff}`);
    await expect(s.page.getByTestId("box-score")).toBeVisible({ timeout: 60_000 });
    step(s, "flow: bracket and playoff matchup", t0);
    await s.context.close();
  });
});

// =================================================================================== complete
test.describe("complete", () => {
  only("complete");
  test("history shows the champion; the commissioner starts the next season", async ({ browser }) => {
    const m = await newSession(browser, "flow", meta.member);
    let t0 = Date.now();
    await m.page.goto(`/leagues/${L.id}/history`);
    await expect(m.page.getByTestId("champions-list")).toContainText(L.champion!, { timeout: 60_000 });
    const rows = m.page.getByTestId("result-row");
    await expect(rows).toHaveCount(16);
    await expect(rows.first()).toContainText(L.champion!);
    await expect(rows.first()).toContainText("Champion");
    await expect(rows.nth(1)).toContainText(L.runnerUp!);
    step(m, "flow: history shows the 2026-27 result", t0);
    await m.context.close();

    const c = await newSession(browser, "flow", meta.commissioner);
    t0 = Date.now();
    await c.page.goto(`/leagues/${L.id}/history`);
    await c.page.getByTestId("start-next-season").click();
    await expect(c.page).not.toHaveURL(new RegExp(L.id), { timeout: 60_000 });
    await expect(c.page.getByRole("heading", { name: L.name })).toBeVisible();
    await expect(c.page.getByTestId("team-row")).toHaveCount(16);
    step(c, "flow: start the next season", t0);
    await c.context.close();
  });
});

// ================================================================================ next season
test.describe("next season", () => {
  only("next-season");
  const N = meta.next!;
  test("keepers: owners are locked after the deadline, the commissioner saves within the limit; invite page works", async ({ browser }) => {
    const member = meta.users.find((u) => u.role === "member" && N.teams.some((t) => t.ownerId === u.userId && !(N.keepers[t.id]?.length)));
    const team = N.teams.find((t) => t.ownerId === member!.userId)!;
    const formOf = (p: Page) => p.getByRole("form", { name: `Keepers for ${team.name}` });

    // The checkpoint is the day after the keeper deadline: the owner can look but not change.
    const s = await newSession(browser, "flow", member!);
    let t0 = Date.now();
    await s.page.goto(`/leagues/${N.id}/keepers`);
    await expect(s.page.getByText("The keeper deadline has passed")).toBeVisible({ timeout: 60_000 });
    await expect(formOf(s.page).getByTestId("keeper-row").first()).toBeVisible();
    await expect(formOf(s.page).getByRole("checkbox").first()).toBeDisabled();
    step(s, "flow: keepers locked for the owner after the deadline", t0);
    await s.context.close();

    // The commissioner can always edit: two keepers for that team, the rest lock at the limit.
    const k = await newSession(browser, "flow", meta.commissioner);
    t0 = Date.now();
    await k.page.goto(`/leagues/${N.id}/keepers`);
    const form = formOf(k.page);
    await expect(form.getByTestId("keeper-row").first()).toBeVisible({ timeout: 60_000 });
    const boxes = form.getByRole("checkbox");
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await expect(form.getByTestId("keeper-count")).toHaveText("2 of 2 selected");
    await expect(boxes.nth(2)).toBeDisabled();
    await form.getByTestId("save-keepers").click();
    await expect(k.page.getByText("Saved 2 keepers")).toBeVisible({ timeout: 30_000 });
    await k.page.reload();
    await expect(formOf(k.page).getByRole("checkbox").nth(0)).toBeChecked();
    await expect(formOf(k.page).getByRole("checkbox").nth(1)).toBeChecked();
    step(k, "flow: commissioner saves keepers (limit 2)", t0);
    await k.context.close();

    const c = await newSession(browser, "flow", meta.commissioner);
    const t1 = Date.now();
    await c.page.goto(`/leagues/${N.id}/invite`);
    await c.page.getByRole("button", { name: "Create invite link" }).click();
    await expect(c.page.getByLabel("Invite link")).toHaveValue(/\/invite\//, { timeout: 30_000 });
    step(c, "flow: next-season invite link", t1);
    await c.context.close();
  });
});

// ========================================================================== next season draft
test.describe("next season draft", () => {
  only("next-season-draft");
  const N = meta.next!;
  test("the draft room shows keepers on the roster", async ({ browser }) => {
    const team = N.teams.find((t) => (N.keepers[t.id]?.length ?? 0) > 0 && t.ownerUsername !== "commish")!;
    const owner = userOfTeam(N, team.id);
    const s = await newSession(browser, "flow", owner);
    const t0 = Date.now();
    await s.page.goto(`/leagues/${N.id}/draft`);
    await expect(s.page.getByTestId("draft-status")).toBeVisible({ timeout: 60_000 });
    await expect(s.page.getByTestId("my-roster-item")).toHaveCount(N.keepers[team.id].length, { timeout: 30_000 });
    for (const name of N.keepers[team.id]) await expect(s.page.getByTestId("my-roster")).toContainText(name);
    step(s, "flow: keepers on the draft roster", t0);
    await s.context.close();
  });
});

void leagueNav;
