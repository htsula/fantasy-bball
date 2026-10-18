/**
 * Visits every page and the JSON API routes of the checkpoint database as four kinds of visitor: signed out, a
 * non-member, a regular member and the commissioner (site admin). One test per visitor; each collects every problem
 * and fails with the full list at the end.
 */
import { expect, test } from "@playwright/test";
import { CP, failures, meta, newSession, visit, type Expect, type Session } from "./lib";
import { leaguePages, sitePages, teamOf } from "./pages";

const leagues = [meta.league, ...(meta.next ? [meta.next] : [])];
const BASE = process.env.SIM_BASE_URL ?? "http://localhost:3300";

/** Pages every visitor can read the same way (auth pages). */
function authPages(): { name: string; url: string; exp: Expect }[] {
  const l = meta.league;
  const t = meta.tokens;
  const inviteOpen = l.status === "setup";
  return [
    { name: "login", url: "/login", exp: { text: ["Log in"], shot: "login" } },
    {
      name: "league-invite",
      url: `/invite/${l.invites.active ?? l.invites.closed ?? "x"}`,
      exp: inviteOpen ? { text: [l.name] } : { text: ["League closed"] },
    },
    { name: "league-invite-revoked", url: `/invite/${l.invites.revoked ?? "revoked-token"}`, exp: { text: [/turned off by the commissioner|isn't valid/] } },
    { name: "site-invite", url: `/invite/${t.siteValid}`, exp: { text: ["You're invited"] } },
    { name: "site-invite-used", url: `/invite/${t.siteUsed}`, exp: { text: ["already been used"] } },
    { name: "invite-garbage", url: "/invite/not-a-real-token", exp: { text: ["isn't valid"] } },
    { name: "reset", url: `/reset/${t.resetValid}`, exp: { text: ["Set a new password"] } },
    { name: "reset-used", url: `/reset/${t.resetUsed}`, exp: { text: ["already been used"] } },
    { name: "reset-garbage", url: "/reset/not-a-real-token", exp: { text: ["isn't valid"] } },
  ];
}

async function apiGet(s: Session, name: string, url: string, want: number, check?: (body: unknown) => string | null, noBody = false) {
  // The middleware sends cookie-less requests (API included) to /login; do not follow it.
  const res = await s.context.request.get(`${BASE}${url}`, { maxRedirects: 0 });
  const problems: string[] = [];
  if (res.status() !== want) problems.push(`status ${res.status()}, expected ${want}`);
  let body: unknown = null;
  if (noBody) {
    if (!(res.headers().location ?? "").includes("/login")) problems.push("expected a redirect to /login");
  } else {
    try {
      body = await res.json();
    } catch {
      problems.push("response is not JSON");
    }
  }
  if (check && problems.length === 0) {
    const p = check(body);
    if (p) problems.push(p);
  }
  const rec = { cp: CP, role: s.role, name: `api ${name}`, url, finalPath: url, status: res.status(), ttfbMs: null, loadMs: 0, ok: problems.length === 0, problems };
  s.records.push(rec);
  (await import("./lib")).record(rec);
}

function apiRoutes(s: Session, forMember: boolean) {
  const l = meta.league;
  const jobs: Promise<void>[] = [];
  void jobs;
  return [
    ["chat", `/api/leagues/${l.id}/chat`, forMember ? 200 : 403, (b: unknown) => (forMember && !Array.isArray((b as { messages?: unknown }).messages) ? "no messages array" : null)],
    ["chat unread", `/api/leagues/${l.id}/chat/unread`, forMember ? 200 : 200, (b: unknown) => (typeof (b as { count?: unknown }).count === "number" ? null : "no count")],
    [
      "draft board",
      `/api/leagues/${l.id}/draft/board`,
      forMember ? 200 : 404,
      (b: unknown) => {
        if (!forMember) return null;
        // The server must believe it is the checkpoint's instant (clock shim reached the rendering code).
        const t = Date.parse((b as { serverTime?: string }).serverTime ?? "");
        return Math.abs(t - Date.parse(meta.now)) < 3 * 3_600_000 ? null : `server clock is ${(b as { serverTime?: string }).serverTime}, expected about ${meta.now}`;
      },
    ],
    ["draft players", `/api/leagues/${l.id}/draft/players?size=10`, forMember ? 200 : 404, (b: unknown) => (forMember && !Array.isArray((b as { players?: unknown }).players) ? "no players array" : null)],
    ...(l.matchups.current ? [["matchup", `/api/leagues/${l.id}/matchups/${l.matchups.current}`, forMember ? 200 : 404, null], ["matchup total", `/api/leagues/${l.id}/matchups/${l.matchups.current}?view=total`, forMember ? 200 : 404, null]] : []),
    ["notifications unread", "/api/notifications/unread", 200, (b: unknown) => (typeof (b as { count?: unknown }).count === "number" ? null : "no count")],
  ] as [string, string, number, ((b: unknown) => string | null) | null][];
}

test.describe(`checkpoint ${CP}`, () => {
  test("signed out", async ({ browser }) => {
    const s = await newSession(browser, "signed-out", null, { login: false });
    for (const p of authPages()) await visit(s, p.name, p.url, p.exp);
    // Everything behind the login is gated by the middleware.
    const gated = ["/", "/leagues", "/players", "/nba/scoreboard", "/notifications", "/admin", "/leagues/new"];
    for (const l of leagues) {
      gated.push(`/leagues/${l.id}`, `/leagues/${l.id}/standings`, `/leagues/${l.id}/draft`, `/leagues/${l.id}/chat`);
      if (l.matchups.current) gated.push(`/leagues/${l.id}/matchup/${l.matchups.current}`);
    }
    for (const u of gated) await visit(s, `gated ${u.replace(/[0-9a-f-]{36}/g, "id")}`, u, { redirect: /^\/login/, noOverflow: true });
    await visit(s, "not-found (signed out)", "/definitely-not-a-page", { redirect: /^\/login/, noOverflow: true });
    for (const [name, url] of [["chat", `/api/leagues/${meta.league.id}/chat`], ["draft board", `/api/leagues/${meta.league.id}/draft/board`], ["notifications unread", "/api/notifications/unread"]]) {
      await apiGet(s, name, url, 307, () => null, true);
    }
    // Cron endpoints need the bearer secret.
    const bad = await s.context.request.get(`${BASE}/api/cron/trades`);
    expect(bad.status()).toBe(401);
    expect(failures(s.records)).toEqual([]);
    await s.context.close();
  });

  test("non-member", async ({ browser }) => {
    const user = meta.nonMember;
    const s = await newSession(browser, "non-member", user);
    for (const p of sitePages(user, "non-member")) await visit(s, p.name, p.url, p.exp);
    // A signed-in stranger sees auth pages too, and 404 for every league page.
    await visit(s, "not-found", "/definitely-not-a-page", { notFound: true, noOverflow: true });
    await visit(s, "player-unknown", "/players/1", { notFound: true, noOverflow: true });
    for (const l of leagues) {
      for (const p of leaguePages(l, l.teams[0].id)) await visit(s, `${l.season} ${p.name}`, p.url, p.member.notFound || p.member.redirect ? { notFound: true, noOverflow: true } : { notFound: true, noOverflow: true });
    }
    for (const [name, url, , ] of apiRoutes(s, false)) {
      const want = apiRoutes(s, false).find((r) => r[0] === name)![2];
      const check = apiRoutes(s, false).find((r) => r[0] === name)![3];
      await apiGet(s, name, url, want, check ?? undefined);
    }
    expect(failures(s.records)).toEqual([]);
    await s.context.close();
  });

  for (const who of ["member", "commissioner"] as const) {
    test(who, async ({ browser }) => {
      const user = who === "member" ? meta.member : meta.commissioner;
      const s = await newSession(browser, who, user);
      const sp = sitePages(user, who);
      for (const p of sp) await visit(s, p.name, p.url, p.exp);
      const league = meta.league;
      const globalIds = league.playerIds;
      if (globalIds.rostered) await visit(s, "player-rostered", `/players/${globalIds.rostered}`, { text: ["Fantasy by season"], shot: "player" });
      if (globalIds.freeAgent) await visit(s, "player-free-agent", `/players/${globalIds.freeAgent}`, { text: ["Fantasy by season"] });
      if (globalIds.retired) await visit(s, "player-retired", `/players/${globalIds.retired}`, {});
      await visit(s, "player-unknown", "/players/1", { notFound: true, noOverflow: true });
      await visit(s, "not-found", "/definitely-not-a-page", { notFound: true, noOverflow: true });
      for (const p of authPages().slice(1)) await visit(s, p.name, p.url, p.exp.text?.includes("Log in") ? p.exp : { ...p.exp, shot: undefined });

      for (const l of leagues) {
        const mine = teamOf(l, user).id;
        for (const p of leaguePages(l, mine)) await visit(s, `${l.season} ${p.name}`, p.url, who === "member" ? p.member : p.commissioner);
      }
      for (const [name, url, , ] of apiRoutes(s, true)) {
        const r = apiRoutes(s, true).find((x) => x[0] === name)!;
        await apiGet(s, name, url, r[2], r[3] ?? undefined);
      }
      expect(failures(s.records)).toEqual([]);
      await s.context.close();
    });
  }

  test("cron endpoints", async ({ browser }) => {
    const s = await newSession(browser, "flow", null, { login: false });
    const headers = { Authorization: `Bearer ${process.env.CRON_SECRET}` };
    const trades = await s.context.request.get(`${BASE}/api/cron/trades`, { headers });
    expect(trades.status()).toBe(200);
    expect((await trades.json()).ok).toBe(true);
    if (CP === "regular-season" || CP === "playoffs") {
      const res = await s.context.request.get(`${BASE}/api/cron/matchups?now=${encodeURIComponent(meta.now)}&leagueId=${meta.league.id}`, { headers });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.matchups.errors).toEqual([]);
      expect(body.matchups.leagues).toBe(1);
    }
    await s.context.close();
  });
});
