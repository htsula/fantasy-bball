import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { invites, leagues, matchupPeriods, matchups, nbaGames, teams, users } from "@/db/schema";
import type { Db } from "@/db/types";
import { AuthError, createInvite, createUser } from "@/lib/auth/service";
import { parseStoredSettings } from "@/lib/fantasy/settings";
import {
  LeagueError,
  createLeague,
  createLeagueInvite,
  defaultSeasonDates,
  generateSchedule,
  getLeagueInviteInfo,
  getLeagueView,
  getSchedule,
  joinLeague,
  listLeagues,
  redeemLeagueInvite,
  removeTeam,
  renameTeam,
  updateSettings,
  type Actor,
} from "@/lib/leagues/service";
import { createTestDb } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
let admin: Actor;
let outsider: Actor;
let n = 0;

const actorOf = (u: { id: string; isSiteAdmin: boolean }): Actor => ({ id: u.id, isSiteAdmin: u.isSiteAdmin });
const newUser = async (prefix = "user") =>
  actorOf(await createUser(db, { username: `${prefix}${++n}`, password: "password123" }));
const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e) => (e instanceof LeagueError ? e.code : e instanceof AuthError ? e.code : `other:${e}`),
  );

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  admin = actorOf(await createUser(db, { username: "root", password: "password123", isSiteAdmin: true }));
  outsider = await newUser("outsider");
});
afterAll(() => close());

async function league(extra: Partial<{ name: string; season: number }> = {}) {
  return createLeague(db, admin, {
    name: extra.name ?? `League ${++n}`,
    season: extra.season ?? 2027,
    teamName: "Commish FC",
    teamAbbrev: "cfc",
  });
}

const LETTERS = "ABCDEFGHIJKLMNOP";

/** League with `count` teams (commissioner included) joined through real invites. */
async function leagueWithTeams(count: number) {
  const l = await league();
  for (let i = 1; i < count; i++) {
    const { token } = await createLeagueInvite(db, admin, l.id);
    await redeemLeagueInvite(db, {
      token,
      username: `m${++n}`,
      password: "password123",
      teamName: `Team ${i}`,
      teamAbbrev: `T${LETTERS[i]}X`,
    });
  }
  await updateSettings(db, admin, l.id, { regularSeasonStart: "2026-10-20", regularSeasonEnd: "2027-01-31", playoffTeams: 2 });
  return l;
}

describe("createLeague", () => {
  it("makes the creator commissioner with their own team and default settings", async () => {
    const l = await league({ name: "  Friends  " });
    expect(l).toMatchObject({ name: "Friends", season: 2027, status: "setup", commissionerId: admin.id });
    const view = await getLeagueView(db, admin, l.id);
    expect(view.teams).toHaveLength(1);
    expect(view.teams[0]).toMatchObject({ name: "Commish FC", abbrev: "CFC", ownerId: admin.id, ownerUsername: "root" });
    expect(view.isCommissioner).toBe(true);
    expect(view.settings.scoring.teamWin).toBe(4);
    expect(view.settings.rosterCap).toBe(50);
  });

  it("is site-admin only and validates input", async () => {
    expect(
      await code(createLeague(db, outsider, { name: "Nope", season: 2027, teamName: "Aa", teamAbbrev: "AAA" })),
    ).toBe("forbidden");
    const err = await createLeague(db, admin, { name: "x", season: 1, teamName: "T", teamAbbrev: "T1" }).catch((e) => e);
    expect(err).toBeInstanceOf(LeagueError);
    expect(Object.keys(err.fieldErrors).sort()).toEqual(["name", "season", "teamAbbrev", "teamName"]);
  });

  it("derives season dates from the NBA schedule when games are loaded", async () => {
    expect(await defaultSeasonDates(db, 2031)).toBeNull();
    const base = { homeTeamId: 1, awayTeamId: 2, season: 2031, seasonType: 2 };
    await db.insert(nbaGames).values([
      { id: 9001, ...base, startTime: new Date("2030-10-23T00:30:00Z") }, // Oct 22 ET
      { id: 9002, ...base, startTime: new Date("2031-04-14T02:00:00Z") }, // Apr 13 ET
      { id: 9003, ...base, seasonType: 1, startTime: new Date("2030-10-01T23:00:00Z") }, // preseason ignored
    ]);
    expect(await defaultSeasonDates(db, 2031)).toEqual({ start: "2030-10-22", end: "2031-04-13" });
    const l = await league({ season: 2031 });
    const s = parseStoredSettings(l.settings);
    expect(s.regularSeasonStart).toBe("2030-10-22");
    expect(s.regularSeasonEnd).toBe("2031-04-13");
  });
});

describe("access control", () => {
  it("only members and site admins can view a league", async () => {
    const l = await league();
    expect(await code(getLeagueView(db, outsider, l.id))).toBe("forbidden");
    expect(await code(getLeagueView(db, admin, l.id))).toBe("ok");
    expect(await code(getLeagueView(db, admin, "not-a-uuid"))).toBe("not_found");
    const member = await newUser();
    const { token } = await createLeagueInvite(db, admin, l.id);
    await joinLeague(db, member, { token, teamName: "Members", teamAbbrev: "MEM" });
    expect(await code(getLeagueView(db, member, l.id))).toBe("ok");
    const lists = await listLeagues(db, member);
    expect(lists.mine.map((s) => s.league.id)).toEqual([l.id]);
    expect(lists.others).toEqual([]);
    expect((await listLeagues(db, outsider)).mine).toEqual([]);
  });

  it("non-commissioners can't edit settings, invite, schedule or remove teams", async () => {
    const l = await leagueWithTeams(3);
    const member = (await getLeagueView(db, admin, l.id)).teams[1];
    const m: Actor = { id: member.ownerId, isSiteAdmin: false };
    expect(await code(updateSettings(db, m, l.id, { addsPerDay: 3 }))).toBe("forbidden");
    expect(await code(createLeagueInvite(db, m, l.id))).toBe("forbidden");
    expect(await code(generateSchedule(db, m, l.id))).toBe("forbidden");
    expect(await code(removeTeam(db, m, member.id))).toBe("forbidden");
    expect(await code(updateSettings(db, outsider, l.id, { addsPerDay: 3 }))).toBe("forbidden");
  });
});

describe("settings", () => {
  it("merges partial updates and validates", async () => {
    const l = await league();
    const next = await updateSettings(db, admin, l.id, { addsPerDay: 3, scoring: { ast: 3 }, tradeReview: "league_vote" });
    expect(next.addsPerDay).toBe(3);
    expect(next.scoring.ast).toBe(3);
    expect(next.scoring.pts).toBe(1);
    expect(next.scoring.teamWin).toBe(4);
    const err = await updateSettings(db, admin, l.id, { playoffTeams: 5, scoring: { pts: "x" } }).catch((e) => e);
    expect(err.code).toBe("invalid_input");
    expect(Object.keys(err.fieldErrors)).toEqual(expect.arrayContaining(["playoffTeams", "scoring.pts"]));
    // Failed updates change nothing.
    const [row] = await db.select().from(leagues).where(eq(leagues.id, l.id));
    expect(parseStoredSettings(row.settings).addsPerDay).toBe(3);
  });

  it("locks roster/draft fields after setup but keeps scoring editable", async () => {
    const l = await league();
    await updateSettings(db, admin, l.id, { snakeTarget: 100 });
    await db.update(leagues).set({ status: "drafting" }).where(eq(leagues.id, l.id));
    expect(await code(updateSettings(db, admin, l.id, { snakeTarget: 120 }))).toBe("settings_locked");
    expect(await code(updateSettings(db, admin, l.id, { rosterCap: 40 }))).toBe("settings_locked");
    expect(await code(updateSettings(db, admin, l.id, { waveSize: 3 }))).toBe("settings_locked");
    expect(await code(updateSettings(db, admin, l.id, { rosterPool: 600 }))).toBe("settings_locked");
    expect(await code(updateSettings(db, admin, l.id, { snakeTarget: 100, addsPerDay: 1, scoring: { stl: 5 } }))).toBe("ok");
    const [row] = await db.select().from(leagues).where(eq(leagues.id, l.id));
    const s = parseStoredSettings(row.settings);
    expect(s).toMatchObject({ snakeTarget: 100, addsPerDay: 1 });
    expect(s.scoring.stl).toBe(5);
  });
});

describe("invites and teams", () => {
  it("new user redeems a league invite: user and team created together", async () => {
    const l = await league();
    const { token } = await createLeagueInvite(db, admin, l.id);
    const info = await getLeagueInviteInfo(db, token);
    expect(info).toMatchObject({ status: "valid", league: { id: l.id, name: l.name } });
    const { user, team } = await redeemLeagueInvite(db, {
      token,
      username: "newbie",
      password: "password123",
      teamName: "Newbies",
      teamAbbrev: "nbs",
    });
    expect(team).toMatchObject({ leagueId: l.id, ownerId: user.id, abbrev: "NBS" });
    expect((await getLeagueView(db, admin, l.id)).teams.map((t) => t.name)).toEqual(["Commish FC", "Newbies"]);
    expect((await getLeagueInviteInfo(db, token)).status).toBe("used");
    const again = { token, username: "again", password: "password123", teamName: "Again", teamAbbrev: "AGN" };
    expect(await code(redeemLeagueInvite(db, again))).toBe("invalid_invite");
  });

  it("rolls back the user when the team or username is rejected, keeping the invite", async () => {
    const l = await league();
    const { token } = await createLeagueInvite(db, admin, l.id);
    const base = { token, password: "password123" };
    expect(await code(redeemLeagueInvite(db, { ...base, username: "ghost1", teamName: "commish fc", teamAbbrev: "GGG" }))).toBe("name_taken");
    expect(await code(redeemLeagueInvite(db, { ...base, username: "ghost2", teamName: "Ghosts", teamAbbrev: "cfc" }))).toBe("abbrev_taken");
    expect(await code(redeemLeagueInvite(db, { ...base, username: "root", teamName: "Ghosts", teamAbbrev: "GHO" }))).toBe("username_taken");
    expect(await code(redeemLeagueInvite(db, { ...base, username: "ghost3", teamName: "G", teamAbbrev: "G" }))).toBe("invalid_input");
    expect((await getLeagueInviteInfo(db, token)).status).toBe("valid");
    expect(await db.select().from(teams).where(eq(teams.leagueId, l.id))).toHaveLength(1);
    expect((await db.select().from(users)).filter((u) => u.username.startsWith("ghost"))).toHaveLength(0);
  });

  it("lets an existing user join with a new team", async () => {
    const l = await league();
    const u = await newUser("joiner");
    const { token } = await createLeagueInvite(db, admin, l.id);
    const team = await joinLeague(db, u, { token, teamName: "Joiners", teamAbbrev: "JNR" });
    expect(team.ownerId).toBe(u.id);
    const [inv] = await db.select().from(invites).where(eq(invites.leagueId, l.id));
    expect(inv.usedBy).toBe(u.id);
  });

  it("allows one team per user per league and unique names/abbrevs (case-insensitive)", async () => {
    const l = await league();
    const u = await newUser("dup");
    const v = await newUser("dup");
    const t1 = (await createLeagueInvite(db, admin, l.id)).token;
    await joinLeague(db, u, { token: t1, teamName: "Dupes", teamAbbrev: "DUP" });
    const t2 = (await createLeagueInvite(db, admin, l.id)).token;
    expect(await code(joinLeague(db, u, { token: t2, teamName: "Second", teamAbbrev: "SEC" }))).toBe("already_on_team");
    expect(await code(joinLeague(db, v, { token: t2, teamName: "DUPES", teamAbbrev: "DPX" }))).toBe("name_taken");
    expect(await code(joinLeague(db, v, { token: t2, teamName: "Other", teamAbbrev: "dup" }))).toBe("abbrev_taken");
    expect(await code(joinLeague(db, v, { token: t2, teamName: "Other", teamAbbrev: "OTH" }))).toBe("ok");
    // The same user can be on teams in different leagues, and the same names are fine elsewhere.
    const l2 = await league();
    const t3 = (await createLeagueInvite(db, admin, l2.id)).token;
    expect(await code(joinLeague(db, u, { token: t3, teamName: "Dupes", teamAbbrev: "DUP" }))).toBe("ok");
  });

  it("enforces one team per user per league in the database too", async () => {
    const l = await league();
    await expect(
      db.insert(teams).values({ leagueId: l.id, name: "Second Team", abbrev: "SND", ownerId: admin.id }),
    ).rejects.toThrow();
  });

  it("rejects site-level and expired invites for league joins", async () => {
    const u = await newUser();
    const site = await createInvite(db, { createdBy: admin.id });
    expect(await code(joinLeague(db, u, { token: site.token, teamName: "Site", teamAbbrev: "STE" }))).toBe("invalid_invite");
    expect(await getLeagueInviteInfo(db, site.token)).toMatchObject({ status: "valid", league: null });
    const l = await league();
    const past = new Date(Date.now() - 8 * 86_400_000);
    const old = await createLeagueInvite(db, admin, l.id, past);
    expect(await code(joinLeague(db, u, { token: old.token, teamName: "Old", teamAbbrev: "OLD" }))).toBe("invalid_invite");
  });

  it("stops joins and invites after setup", async () => {
    const l = await league();
    const { token } = await createLeagueInvite(db, admin, l.id);
    await db.update(leagues).set({ status: "drafting" }).where(eq(leagues.id, l.id));
    expect(await code(joinLeague(db, await newUser(), { token, teamName: "Late", teamAbbrev: "LTE" }))).toBe("wrong_status");
    expect(await code(createLeagueInvite(db, admin, l.id))).toBe("wrong_status");
  });

  it("renames teams (owner or commissioner) and removes them (commissioner, setup only)", async () => {
    const l = await leagueWithTeams(3);
    const view = await getLeagueView(db, admin, l.id);
    const [commish, a, b] = view.teams;
    const owner: Actor = { id: a.ownerId, isSiteAdmin: false };
    expect((await renameTeam(db, owner, a.id, { name: "Renamed" })).name).toBe("Renamed");
    expect(await code(renameTeam(db, owner, b.id, { name: "Hijack" }))).toBe("forbidden");
    expect(await code(renameTeam(db, admin, b.id, { name: "Renamed" }))).toBe("name_taken");
    expect(await code(renameTeam(db, admin, b.id, { name: "By Commish", abbrev: "BYC" }))).toBe("ok");
    expect(await code(renameTeam(db, owner, a.id, { name: "renamed" }))).toBe("ok"); // own name, new case

    expect(await code(removeTeam(db, admin, commish.id))).toBe("cannot_remove_commissioner");
    await generateSchedule(db, admin, l.id, { seed: "s" });
    await removeTeam(db, admin, b.id);
    expect((await getLeagueView(db, admin, l.id)).teams).toHaveLength(2);
    expect((await getSchedule(db, l.id)).periods).toHaveLength(0); // stale schedule cleared
    await db.update(leagues).set({ status: "in_season" }).where(eq(leagues.id, l.id));
    expect(await code(removeTeam(db, admin, a.id))).toBe("wrong_status");
  });
});

describe("generateSchedule", () => {
  it("persists periods and a full set of matchups, replacing any earlier schedule", async () => {
    const l = await leagueWithTeams(5);
    const r = await generateSchedule(db, admin, l.id, { seed: "one" });
    // 2026-10-20 (Tue) .. 2027-01-31 (Sun): 15 periods, the last being the single playoff round
    expect(r.regularPeriods + r.playoffPeriods).toBe(15);
    expect(r.playoffPeriods).toBe(1);
    expect(r.notices.join(" ")).toMatch(/NBA schedule isn't loaded/);

    const sched = await getSchedule(db, l.id);
    expect(sched.periods).toHaveLength(15);
    expect(sched.periods[0]).toMatchObject({ number: 1, startDate: "2026-10-20", endDate: "2026-10-25", isPlayoff: false });
    expect(sched.periods.at(-1)).toMatchObject({ isPlayoff: true, playoffRound: 1, endDate: "2027-01-31" });
    for (const p of sched.periods.filter((p) => !p.isPlayoff)) {
      const ids = p.matchups.flatMap((m) => [m.homeTeamId, m.awayTeamId]).filter(Boolean);
      expect(new Set(ids).size).toBe(5); // 2 games + 1 bye: every team exactly once
      expect(p.matchups.filter((m) => m.awayTeamId === null)).toHaveLength(1);
      expect(p.matchups.every((m) => m.homeTeamId !== m.awayTeamId)).toBe(true);
    }
    expect(sched.periods.at(-1)!.matchups).toEqual([]); // playoff matchups are created later

    await generateSchedule(db, admin, l.id, { seed: "two" });
    expect(await db.select().from(matchupPeriods).where(eq(matchupPeriods.leagueId, l.id))).toHaveLength(15);
    expect(await db.select().from(matchups).where(eq(matchups.leagueId, l.id))).toHaveLength(14 * 3);
  });

  it("uses the NBA schedule for dates and merges the All-Star break when games are loaded", async () => {
    const l = await league({ season: 2040 });
    for (let i = 0; i < 3; i++) {
      const { token } = await createLeagueInvite(db, admin, l.id);
      await redeemLeagueInvite(db, {
        token,
        username: `nba${++n}`,
        password: "password123",
        teamName: `Nba ${i}`,
        teamAbbrev: `NB${LETTERS[i]}`,
      });
    }
    // Daily games Oct 20 2039 .. Mar 2 2040 (noon UTC = same ET day), with an empty gap Jan 12-17.
    const rows = [];
    let id = 50_000;
    for (let d = new Date("2039-10-20T17:00:00Z"); d <= new Date("2040-03-02T17:00:00Z"); d = new Date(d.getTime() + 86_400_000)) {
      const day = d.toISOString().slice(0, 10);
      if (day >= "2040-01-12" && day <= "2040-01-17") continue;
      rows.push({ id: id++, season: 2040, seasonType: 2, homeTeamId: 1, awayTeamId: 2, startTime: d });
    }
    await db.insert(nbaGames).values(rows);
    // The league was created before games existed, so its stored dates are null and fall back to the NBA schedule.
    const r = await generateSchedule(db, admin, l.id, { seed: "s" });
    expect(r.notices.join(" ")).toMatch(/taken from the NBA schedule/);
    const sched = await getSchedule(db, l.id);
    expect(sched.periods[0].startDate).toBe("2039-10-20");
    expect(sched.periods.at(-1)!.endDate).toBe("2040-03-02");
    // Jan 9 2040 is a Monday; the gap crosses the Sunday Jan 15 boundary, so two weeks merge.
    expect(sched.periods.some((p) => p.startDate === "2040-01-09" && p.endDate === "2040-01-22")).toBe(true);
  });

  it("explains why it can't generate", async () => {
    const solo = await league();
    expect(await code(generateSchedule(db, admin, solo.id))).toBe("not_enough_teams");

    const l = await leagueWithTeams(3);
    await updateSettings(db, admin, l.id, { playoffTeams: 4 });
    expect(await code(generateSchedule(db, admin, l.id))).toBe("playoff_teams_exceed_teams");
    await updateSettings(db, admin, l.id, { playoffTeams: 2, regularSeasonStart: null, regularSeasonEnd: null });
    expect(await code(generateSchedule(db, admin, l.id))).toBe("dates_required");
    await updateSettings(db, admin, l.id, { regularSeasonStart: "2026-10-20", regularSeasonEnd: "2026-10-25" });
    expect(await code(generateSchedule(db, admin, l.id))).toBe("season_too_short");
    await db.update(leagues).set({ status: "drafting" }).where(eq(leagues.id, l.id));
    expect(await code(generateSchedule(db, admin, l.id))).toBe("wrong_status");
  });
});
