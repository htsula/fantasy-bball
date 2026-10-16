import { expect, test } from "@playwright/test";

// A phone-sized, touch device: no page may scroll sideways, and the header controls must be easy to tap.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const overflow = (page: import("@playwright/test").Page) =>
  page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));

test("main pages have no horizontal page overflow at 390px and the header is tappable", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/login");
  const login = await overflow(page);
  expect(login.scroll, "login page").toBeLessThanOrEqual(login.client);

  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("e2e-admin-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Welcome, admin" })).toBeVisible();

  // Header controls: >= 40px tall tap targets, and the nav scrolls inside itself instead of widening the page.
  for (const target of [
    page.getByRole("navigation", { name: "Main" }).getByRole("link").first(),
    page.getByTestId("notification-bell"),
    page.getByRole("button", { name: "Log out" }),
  ]) {
    const box = await target.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(39.5);
  }

  await page.goto("/leagues");
  const href = await page.locator("a[href^='/leagues/']").filter({ hasText: "Matchup League" }).first().getAttribute("href");
  const base = href!.match(/\/leagues\/[0-9a-f-]{36}/)![0];

  const urls = [
    "/",
    "/leagues",
    "/players",
    "/nba/scoreboard?date=2026-03-10",
    "/notifications",
    "/settings/notifications",
    "/admin",
    base,
    `${base}/players`,
    `${base}/draft`,
    `${base}/matchup`,
    `${base}/scoreboard`,
    `${base}/standings`,
    `${base}/schedule`,
    `${base}/playoffs`,
    `${base}/history`,
    `${base}/trades`,
    `${base}/trades/new`,
    `${base}/trades/block`,
    `${base}/transactions`,
    `${base}/activity`,
    `${base}/chat`,
    `${base}/commissioner`,
    `${base}/settings`,
    `${base}/invite`,
  ];
  const wide: string[] = [];
  for (const url of urls) {
    await page.goto(url);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(300);
    const o = await overflow(page);
    if (o.scroll > o.client) wide.push(`${url}: ${o.scroll}px > ${o.client}px`);
  }
  expect(wide, wide.join("\n")).toEqual([]);

  // Key values stay on screen without sideways scrolling: FP on the box score, FP/G and Add on the players list.
  const inView = async (loc: import("@playwright/test").Locator, what: string) => {
    await expect(loc, what).toBeVisible();
    const box = await loc.boundingBox();
    expect(box!.x + box!.width, what).toBeLessThanOrEqual(390);
    expect(box!.x, what).toBeGreaterThanOrEqual(0);
  };
  await page.goto(`${base}/matchup`);
  await expect(page.getByTestId("box-score")).toBeVisible({ timeout: 60_000 });
  const boxTable = page.locator('[data-testid^="box-"] table:visible').first();
  // On phones the FP column header shows the team's matchup score instead of "FP".
  await inView(boxTable.getByTestId(/^table-score-/), "box score score header");
  await inView(boxTable.getByTestId("fp-cell").first(), "box score FP cell");
  await inView(boxTable.getByTestId("view-total-home").or(boxTable.getByTestId("view-total-away")).first(), "box score total");

  await page.goto(`${base}/players`);
  await expect(page.getByTestId("player-row").first()).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Sort by" })).toBeVisible();
  await inView(page.getByRole("columnheader", { name: /^FP(\/G)?$/ }).first(), "players FP header");
  await inView(page.getByTestId("mobile-value").first(), "players FP/G cell");
  await inView(page.getByRole("button", { name: /^Add/ }).first(), "players Add button");
  // ...and nothing is clipped inside the table's own scroll container either.
  const clip = await page.locator('[data-slot="table-container"]').first().evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
    cells: [...el.querySelectorAll("tbody tr:first-child td")].map((td) => Math.round(td.getBoundingClientRect().width)),
  }));
  expect(clip.scroll, JSON.stringify(clip)).toBeLessThanOrEqual(clip.client);

  // A league page's sub-navigation is one scrollable row (not a wrapping wall of links).
  await page.goto(base);
  const nav = page.getByRole("navigation", { name: "League" });
  const { sw, cw, h } = await nav.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, h: el.getBoundingClientRect().height }));
  expect(sw).toBeGreaterThan(cw);
  expect(h).toBeLessThan(60);
});

test("unknown pages show a friendly not-found page, not a blank error", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("e2e-admin-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Welcome, admin" })).toBeVisible();
  await page.goto("/leagues/00000000-0000-4000-8000-000000000000");
  await expect(page.getByTestId("not-found-view")).toBeVisible();
  await page.goto("/definitely-not-a-page");
  await expect(page.getByTestId("not-found-view")).toBeVisible();
});

test("the offline page and service worker are served", async ({ request }) => {
  const offline = await request.get("/offline.html");
  expect(offline.status()).toBe(200);
  expect(await offline.text()).toContain("You're offline");
  const sw = await request.get("/sw.js");
  expect(sw.status()).toBe(200);
  expect(sw.headers()["cache-control"]).toContain("no-cache");
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest).toMatchObject({ display: "standalone", start_url: "/", scope: "/", short_name: "Hoops" });
  expect(manifest.icons.some((i: { purpose?: string; sizes: string }) => i.purpose === "maskable" && i.sizes === "512x512")).toBe(true);
});
