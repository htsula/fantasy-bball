/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import {
  mapGameStatus,
  normalizeBoxscore,
  normalizeInjuries,
  normalizeNews,
  normalizeRoster,
  normalizeScoreboard,
  normalizeTeams,
  parseMinutes,
  splitMadeAttempted,
} from "@/lib/nba/espn";
import { FIXTURE_GAME_ID, readFixture } from "@/lib/nba/fixture-client";
import { mapPosition } from "@/lib/nba/positions";

describe("position mapping", () => {
  it("maps ESPN positions onto fantasy positions", () => {
    expect(mapPosition("PG")).toEqual(["PG"]);
    expect(mapPosition("G")).toEqual(["PG", "SG"]);
    expect(mapPosition("F")).toEqual(["SF", "PF"]);
    expect(mapPosition("C")).toEqual(["C"]);
    expect(mapPosition("G-F")).toEqual(["SG", "SF"]);
    expect(mapPosition("F-G")).toEqual(["SG", "SF"]);
    expect(mapPosition("F-C")).toEqual(["PF", "C"]);
    expect(mapPosition("C-F")).toEqual(["PF", "C"]);
    expect(mapPosition("PG-SG")).toEqual(["PG", "SG"]);
    expect(mapPosition("pf/c")).toEqual(["PF", "C"]);
  });
  it("returns [] for unknown or missing positions", () => {
    expect(mapPosition(undefined)).toEqual([]);
    expect(mapPosition("")).toEqual([]);
    expect(mapPosition("X")).toEqual([]);
  });
});

describe("primitives", () => {
  it("splits made-attempted", () => {
    expect(splitMadeAttempted("11-22")).toEqual([11, 22]);
    expect(splitMadeAttempted("0-0")).toEqual([0, 0]);
    expect(splitMadeAttempted("--")).toEqual([0, 0]);
    expect(splitMadeAttempted(undefined)).toEqual([0, 0]);
  });
  it("parses minutes", () => {
    expect(parseMinutes("34")).toBe(34);
    expect(parseMinutes("12:45")).toBe(13);
    expect(parseMinutes("--")).toBeNull();
    expect(parseMinutes(undefined)).toBeNull();
  });
  it("maps game statuses", () => {
    expect(mapGameStatus({ name: "STATUS_SCHEDULED", state: "pre" })).toBe("scheduled");
    expect(mapGameStatus({ name: "STATUS_IN_PROGRESS", state: "in" })).toBe("in");
    expect(mapGameStatus({ name: "STATUS_HALFTIME", state: "in" })).toBe("in");
    expect(mapGameStatus({ name: "STATUS_FINAL", state: "post", completed: true })).toBe("final");
    expect(mapGameStatus({ name: "STATUS_FINAL_OT", state: "post", completed: true })).toBe("final");
    expect(mapGameStatus({ name: "STATUS_POSTPONED", state: "post" })).toBe("postponed");
    expect(mapGameStatus({ name: "STATUS_CANCELED", state: "post" })).toBe("postponed");
    expect(mapGameStatus(undefined)).toBe("scheduled");
  });
});

describe("normalizeTeams", () => {
  it("returns all 30 teams", () => {
    const teams = normalizeTeams(readFixture("teams.json"));
    expect(teams).toHaveLength(30);
    expect(teams.find((t) => t.id === 1)).toMatchObject({
      abbrev: "ATL", name: "Hawks", location: "Atlanta", color: "c8102e",
    });
    expect(teams[0].logo).toMatch(/^https:\/\/a\.espncdn\.com\//);
  });
});

describe("normalizeRoster", () => {
  const { team, players } = normalizeRoster(readFixture("roster-1.json"));
  it("reads the team and players", () => {
    expect(team).toMatchObject({ id: 1, abbrev: "ATL" });
    expect(players.length).toBeGreaterThan(10);
    expect(players.every((p) => p.teamId === 1)).toBe(true);
  });
  it("maps bio fields and positions", () => {
    const nickeil = players.find((p) => p.id === 4278039)!;
    expect(nickeil).toMatchObject({
      fullName: "Nickeil Alexander-Walker",
      firstName: "Nickeil",
      lastName: "Alexander-Walker",
      espnPosition: "G",
      positions: ["PG", "SG"],
      jersey: "7",
      heightInches: 77,
      weightLbs: 205,
      birthDate: "1998-09-02",
      experienceYears: 8,
      active: true,
    });
    expect(nickeil.headshotUrl).toMatch(/4278039\.png$/);
  });
  it("handles the grouped (items) roster shape", () => {
    const flat = readFixture<{ athletes: unknown[]; team: unknown }>("roster-1.json");
    const grouped = { team: flat.team, athletes: [{ position: "x", items: flat.athletes }] };
    expect(normalizeRoster(grouped).players).toHaveLength(players.length);
  });
});

describe("normalizeScoreboard", () => {
  const { games, teams } = normalizeScoreboard(readFixture("scoreboard-20260310.json"));
  it("normalizes a day of final games", () => {
    expect(games).toHaveLength(11);
    expect(games.every((g) => g.status === "final")).toBe(true);
    const g = games.find((x) => x.id === FIXTURE_GAME_ID)!;
    expect(g).toMatchObject({
      season: 2026, seasonType: 2, homeTeamId: 20, awayTeamId: 29, homeScore: 139, awayScore: 129, status: "final",
    });
    expect(g.startTime.toISOString()).toBe("2026-03-10T23:00:00.000Z");
    expect(g.clock).toBeNull();
  });
  it("collects the teams it saw", () => {
    expect(teams.length).toBeGreaterThan(10);
    expect(teams.find((t) => t.id === 20)?.abbrev).toBe("PHI");
  });
  it("hides scores for scheduled games and exposes clock for live games", () => {
    const base = readFixture<{ events: Record<string, unknown>[] }>("scoreboard-20260310.json");
    const ev = structuredClone(base.events[0]) as any;
    ev.competitions[0].status = {
      clock: 301, displayClock: "5:01", period: 3,
      type: { name: "STATUS_IN_PROGRESS", state: "in", completed: false, shortDetail: "5:01 - 3rd" },
    };
    const live = normalizeScoreboard({ events: [ev] }).games[0];
    expect(live).toMatchObject({ status: "in", period: 3, clock: "5:01", homeScore: 139 });
    ev.competitions[0].status = { type: { name: "STATUS_SCHEDULED", state: "pre", completed: false } };
    const pre = normalizeScoreboard({ events: [ev] }).games[0];
    expect(pre).toMatchObject({ status: "scheduled", homeScore: null, awayScore: null, period: null });
  });
  it("skips malformed events instead of throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(normalizeScoreboard({ events: [{ id: "1" }, { nonsense: true }] }).games).toEqual([]);
    expect(normalizeScoreboard(null).games).toEqual([]);
    warn.mockRestore();
  });
});

describe("normalizeBoxscore", () => {
  const { game, players, stats } = normalizeBoxscore(readFixture("summary-401810791.json"));

  it("reads the game header", () => {
    expect(game).toMatchObject({ id: FIXTURE_GAME_ID, status: "final", homeScore: 139, awayScore: 129 });
  });

  it("parses labels into stat columns incl. made-attempted splits", () => {
    const prosper = stats.find((s) => s.playerId === 4595400)!;
    // ["21","11","4-6","1-1","2-3","6","0","2","2","1","2","4","2","+8"] under
    // MIN PTS FG 3PT FT REB AST TO STL BLK OREB DREB PF +/-
    expect(prosper).toMatchObject({
      gameId: FIXTURE_GAME_ID, teamId: 29, minutes: 21, pts: 11, fgm: 4, fga: 6, tpm: 1, tpa: 1, ftm: 2, fta: 3,
      reb: 6, ast: 0, to: 2, stl: 2, blk: 1, oreb: 2, dreb: 4, pf: 2, dnp: false, dnpReason: null,
    });
  });

  it("finds columns by label, not by position", () => {
    const raw = readFixture<any>("summary-401810791.json");
    const group = raw.boxscore.players[0].statistics[0];
    const order = group.labels.map((_: string, i: number) => i).reverse();
    group.labels = order.map((i: number) => group.labels[i]);
    for (const a of group.athletes) a.stats = a.stats.length ? order.map((i: number) => a.stats[i]) : a.stats;
    const reordered = normalizeBoxscore(raw).stats;
    const id = Number(group.athletes.find((a: any) => a.stats.length).athlete.id);
    expect(reordered.find((s) => s.playerId === id)).toEqual(stats.find((s) => s.playerId === id));
  });

  it("flags DNPs with zeroed lines and a reason", () => {
    const dnps = stats.filter((s) => s.dnp);
    expect(dnps.length).toBeGreaterThanOrEqual(2);
    for (const s of dnps) {
      expect(s).toMatchObject({ minutes: null, pts: 0, fga: 0, reb: 0, to: 0 });
      expect(s.dnpReason).toBeTruthy();
    }
    expect(dnps.some((s) => s.dnpReason === "RIGHT CALF STRAIN")).toBe(true);
  });

  it("returns placeholder players for everyone in the box score", () => {
    expect(players.length).toBe(stats.length);
    const prosper = players.find((p) => p.id === 4595400)!;
    expect(prosper).toMatchObject({ fullName: "Olivier-Maxence Prosper", teamId: 29, espnPosition: "F", positions: ["SF", "PF"] });
  });

  it("treats a 0-minute all-zero line as DNP", () => {
    const raw = readFixture<any>("summary-401810791.json");
    const a = raw.boxscore.players[0].statistics[0].athletes[0];
    a.didNotPlay = false;
    a.stats = ["0", "0", "0-0", "0-0", "0-0", "0", "0", "0", "0", "0", "0", "0", "0", "0"];
    const s = normalizeBoxscore(raw).stats.find((x) => x.playerId === Number(a.athlete.id))!;
    expect(s.dnp).toBe(true);
  });

  it("returns nothing (and does not throw) for an unusable payload", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(normalizeBoxscore({ boxscore: "nope" }).stats).toEqual([]);
    expect(normalizeBoxscore(undefined).stats).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("normalizeInjuries", () => {
  const rows = normalizeInjuries(readFixture("injuries.json"));
  it("extracts player id from the player link and keeps comments", () => {
    const gilbert = rows.find((r) => r.playerId === 4585618)!;
    expect(gilbert).toMatchObject({ teamId: 1, status: "Day-To-Day", detail: "Knee - Tendinitis" });
    expect(gilbert.shortComment).toContain("Gilbert (knee)");
    expect(gilbert.longComment).toContain("patella tendinitis");
    expect(gilbert.date?.toISOString()).toBe("2026-10-12T21:36:00.000Z");
  });
  it("returns one row per player", () => {
    expect(new Set(rows.map((r) => r.playerId)).size).toBe(rows.length);
    expect(rows.length).toBeGreaterThan(5);
  });
});

describe("normalizeNews", () => {
  const rows = normalizeNews(readFixture("news.json"));
  it("maps articles and related ids", () => {
    expect(rows.length).toBeGreaterThan(5);
    const a = rows.find((r) => r.id === "50176173")!;
    expect(a.headline).toContain("Pritchard");
    expect(a.relatedPlayerIds).toEqual([4066354]);
    expect(a.relatedTeamIds).toEqual([2]);
    expect(a.link).toMatch(/^https:\/\/www\.espn\.com\/nba\/story/);
    expect(a.image).toMatch(/^https:\/\/a\.espncdn\.com\//);
    expect(a.published.toISOString()).toBe("2026-10-13T20:03:01.000Z");
  });
});
