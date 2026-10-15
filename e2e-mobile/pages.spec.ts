import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Walks every main page of the demo data (see src/lib/leagues/seed-demo.ts) at phone sizes, saves a full-page
 * screenshot of each into ./screenshots/<project>/ and fails when a page scrolls sideways.
 */

type Target = { name: string; url: string };

/** Elements wider than the viewport: helps find the culprit of a horizontal overflow. */
async function overflow(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const over = doc.scrollWidth - doc.clientWidth;
    if (over <= 0) return { over: 0, culprits: [] as string[] };
    const culprits: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      if (r.right > doc.clientWidth + 1 && r.width > 0) {
        culprits.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${String(el.className).slice(0, 60)} right=${Math.round(r.right)}`);
        if (culprits.length >= 5) break;
      }
    }
    return { over, culprits };
  });
}

async function hrefs(page: Page, url: string, pattern: RegExp): Promise<string[]> {
  await page.goto(url);
  const all = await page.locator("a[href]").evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).getAttribute("href") ?? ""));
  return [...new Set(all.filter((h) => pattern.test(h)))];
}

test("every main page fits a phone and looks right", async ({ page, browser }, info) => {
  const dir = path.join("screenshots", info.project.name);
  fs.mkdirSync(dir, { recursive: true });

  const failures: string[] = [];
  const visit = async (t: Target) => {
    await page.goto(t.url);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(700); // client-side data (SWR) settles
    const o = await overflow(page);
    if (o.over > 0) failures.push(`${t.name} (${t.url}): page is ${o.over}px wider than the screen; ${o.culprits.join(" | ")}`);
    await page.screenshot({ path: path.join(dir, `${t.name}.png`), fullPage: true });
  };

  // ---- Signed out: login and invite redemption
  const anon = await browser.newContext({ ...info.project.use });
  const ap = await anon.newPage();

  await page.goto("/login");
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Welcome, admin" })).toBeVisible();

  // ---- Discover ids from the pages themselves
  await page.goto("/leagues");
  const leagueHref = async (name: string) =>
    (await page.getByRole("link", { name, exact: false }).first().getAttribute("href"))!.match(/\/leagues\/[0-9a-f-]{36}/)![0];
  const demo = await page.locator("a[href^='/leagues/']").filter({ hasText: /^Demo League/ }).first().getAttribute("href");
  const base = demo!.match(/\/leagues\/[0-9a-f-]{36}/)![0];
  const stageBase = async (title: string) => {
    await page.goto("/leagues");
    return (await page.locator("a[href^='/leagues/']").filter({ hasText: title }).first().getAttribute("href"))!.match(/\/leagues\/[0-9a-f-]{36}/)![0];
  };
  const pre = await stageBase("Draft Night: Not Started");
  const snake = await stageBase("Draft Night: Snake");
  const waves = await stageBase("Draft Night: Waves");
  void leagueHref;

  const myTeam = (await hrefs(page, base, new RegExp(`^${base}/teams/[0-9a-f-]{36}$`)))[0];
  const playerCard = (await hrefs(page, `${base}/players`, /^\/players\/\d+/))[0] ?? "/players/9500001";
  const trade = (await hrefs(page, `${base}/trades`, new RegExp(`^${base}/trades/[0-9a-f-]{36}$`)))[0];
  await page.goto(`${base}/matchup`);
  await page.waitForURL(/\/matchup\/[0-9a-f-]{36}/);
  const matchup = new URL(page.url()).pathname;

  // An invite link for the not-started league (not redeemed)
  await page.goto(`${pre}/invite`);
  const link = page.getByLabel("Invite link");
  if ((await link.count()) === 0) await page.getByRole("button", { name: "Create invite link" }).click();
  const invite = new URL(await link.inputValue());

  const targets: Target[] = [
    { name: "home", url: "/" },
    { name: "leagues-list", url: "/leagues" },
    { name: "league-overview", url: base },
    { name: "my-team", url: myTeam },
    { name: "league-players", url: `${base}/players` },
    { name: "players-global", url: "/players" },
    { name: "player-card", url: playerCard },
    { name: "draft-complete", url: `${base}/draft` },
    { name: "draft-predraft", url: `${pre}/draft` },
    { name: "draft-snake", url: `${snake}/draft` },
    { name: "draft-waves", url: `${waves}/draft` },
    { name: "matchup", url: matchup },
    { name: "scoreboard", url: `${base}/scoreboard` },
    { name: "nba-scoreboard", url: "/nba/scoreboard?date=2026-03-10" },
    { name: "league-nba-scoreboard", url: `${base}/nba-scoreboard` },
    { name: "standings", url: `${base}/standings` },
    { name: "schedule", url: `${base}/schedule` },
    { name: "playoffs", url: `${base}/playoffs` },
    { name: "history", url: `${base}/history` },
    { name: "keepers", url: `${base}/keepers` },
    { name: "trades-hub", url: `${base}/trades` },
    { name: "trade-builder", url: `${base}/trades/new` },
    ...(trade ? [{ name: "trade-detail", url: trade }] : []),
    { name: "trade-block", url: `${base}/trades/block` },
    { name: "transactions", url: `${base}/transactions` },
    { name: "activity", url: `${base}/activity` },
    { name: "chat", url: `${base}/chat` },
    { name: "commissioner", url: `${base}/commissioner` },
    { name: "settings", url: `${base}/settings` },
    { name: "invite", url: `${pre}/invite` },
    { name: "notifications", url: "/notifications" },
    { name: "notification-settings", url: "/settings/notifications" },
    { name: "admin", url: "/admin" },
  ];
  for (const t of targets) await visit(t);

  // Signed-out pages in the other context
  for (const t of [
    { name: "login", url: "/login" },
    { name: "invite-redeem", url: invite.pathname },
  ]) {
    await ap.goto(t.url);
    await ap.waitForLoadState("domcontentloaded");
    const o = await overflow(ap);
    if (o.over > 0) failures.push(`${t.name} (${t.url}): page is ${o.over}px wider than the screen; ${o.culprits.join(" | ")}`);
    await ap.screenshot({ path: path.join(dir, `${t.name}.png`), fullPage: true });
  }
  await anon.close();

  expect(failures, failures.join("\n")).toEqual([]);
});
