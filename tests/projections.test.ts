import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/types";
import { fantasyPoints } from "@/lib/fantasy/points";
import {
  blendProjection,
  loadGamesRemaining,
  loadProjections,
  perGame,
  projectTotal,
} from "@/lib/fantasy/projections";
import { getPlayerCard, listPlayers, PAGE_SIZE } from "@/lib/nba/players-query";
import type { GameRow, PlayerRow, StatRow } from "@/lib/nba/normalize";
import { applyInjuries, upsertGames, upsertPlayers, upsertStats, upsertTeams } from "@/lib/nba/sync";
import { createTestDb } from "./helpers/db";

describe("blendProjection (pure)", () => {
  it("blends 60/40 when there are at least 5 recent games", () => {
    const p = blendProjection({ seasonGames: 10, seasonFantasyPoints: 280, recentGames: 6, recentFantasyPoints: 240 });
    expect(p).toBeCloseTo(0.6 * 40 + 0.4 * 28);
  });
  it("uses the season average with fewer than 5 recent games", () => {
    const p = blendProjection({ seasonGames: 8, seasonFantasyPoints: 110, recentGames: 4, recentFantasyPoints: 200 });
    expect(p).toBeCloseTo(13.75);
  });
  it("is exactly the threshold at 5", () => {
    const p = blendProjection({ seasonGames: 5, seasonFantasyPoints: 100, recentGames: 5, recentFantasyPoints: 200 });
    expect(p).toBeCloseTo(0.6 * 40 + 0.4 * 20);
  });
  it("is null with no games", () => {
    expect(blendProjection({ seasonGames: 0, seasonFantasyPoints: 0, recentGames: 0, recentFantasyPoints: 0 })).toBeNull();
  });
  it("computes per-game averages and projected totals", () => {
    expect(perGame(30, 3)).toBe(10);
    expect(perGame(0, 0)).toBeNull();
    expect(projectTotal(20, 3)).toBe(60);
    expect(projectTotal(null, 3)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

const NOW = new Date("2026-03-18T15:00:00Z"); // Wed, ET week = Mon 03-16 .. Mon 03-23
let db: Db;
let close: () => Promise<void> | void;

const player = (id: number, name: string, teamId: number | null, positions: string[], extra: Partial<PlayerRow> = {}): PlayerRow => ({
  id, fullName: name, firstName: null, lastName: null, teamId, positions, espnPosition: positions[0] ?? null,
  jersey: null, headshotUrl: null, heightInches: null, weightLbs: null, age: null, birthDate: null,
  experienceYears: null, active: true, ...extra,
});

const game = (id: number, iso: string, status: GameRow["status"], extra: Partial<GameRow> = {}): GameRow => ({
  id, season: 2026, seasonType: 2, startTime: new Date(iso), homeTeamId: 1, awayTeamId: 2,
  homeScore: status === "scheduled" ? null : 100, awayScore: status === "scheduled" ? null : 90,
  status, statusDetail: null, period: null, clock: null, ...extra,
});

const stat = (gameId: number, playerId: number, pts: number, extra: Partial<StatRow> = {}): StatRow => ({
  gameId, playerId, teamId: 1, minutes: 30, fgm: 0, fga: 0, ftm: 0, fta: 0, tpm: 0, tpa: 0, reb: 0, oreb: 0, dreb: 0,
  ast: 0, stl: 0, blk: 0, to: 0, pf: 0, pts, dnp: false, dnpReason: null, ...extra,
});

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await upsertTeams(db, [
    { id: 1, abbrev: "ATL", name: "Hawks", location: "Atlanta", logo: null, color: null },
    { id: 2, abbrev: "BOS", name: "Celtics", location: "Boston", logo: null, color: null },
  ]);
  await upsertPlayers(
    db,
    [
      player(101, "Alpha Guard", 1, ["PG", "SG"]),
      player(102, "Bravo Wing", 1, ["SF", "PF"]),
      player(103, "Charlie Big", 2, ["C"]),
    ],
    "full",
  );
  // Alpha: 4 old games of 10 and 6 recent games of 40 (+ a recent DNP). Bravo: 5 old of 10, 3 recent of 20.
  const games: GameRow[] = [];
  const stats: StatRow[] = [];
  let gid = 1000;
  for (const d of ["01-05", "01-07", "01-09", "01-11"]) {
    games.push(game(++gid, `2026-${d}T00:00:00Z`, "final"));
    stats.push(stat(gid, 101, 10), stat(gid, 102, 10));
  }
  games.push(game(++gid, "2026-01-13T00:00:00Z", "final"));
  stats.push(stat(gid, 102, 10));
  for (const d of ["03-05", "03-07", "03-09", "03-11", "03-13", "03-15"]) {
    games.push(game(++gid, `2026-${d}T00:00:00Z`, "final"));
    stats.push(stat(gid, 101, 40));
    if (["03-11", "03-13", "03-15"].includes(d)) stats.push(stat(gid, 102, 20));
  }
  games.push(game(++gid, "2026-03-17T00:00:00Z", "final"));
  stats.push(stat(gid, 101, 0, { dnp: true, minutes: null, dnpReason: "REST" }));
  // Upcoming: Thu 03-19 and Sun 03-22 in the ET week, Wed 03-25 later, preseason ignored for season count.
  games.push(game(2001, "2026-03-19T23:00:00Z", "scheduled"));
  games.push(game(2002, "2026-03-22T23:00:00Z", "scheduled"));
  games.push(game(2003, "2026-03-25T23:00:00Z", "scheduled"));
  games.push(game(2004, "2026-03-25T23:00:00Z", "scheduled", { seasonType: 1, homeTeamId: 1, awayTeamId: 2 }));
  await upsertGames(db, games, NOW);
  await upsertStats(db, stats, NOW);
});
afterEach(async () => {
  await close();
});

describe("loadProjections", () => {
  it("computes season/recent averages excluding DNPs and blends them", async () => {
    const map = await loadProjections(db, { now: NOW });
    const alpha = map.get(101)!;
    expect(alpha).toMatchObject({ seasonGames: 10, recentGames: 6 });
    // Averages include the +4 win bonus (every game was a home win for team 1).
    expect(alpha.seasonAvg).toBeCloseTo(32);
    expect(alpha.recentAvg).toBeCloseTo(44);
    expect(alpha.statProjection).toBeCloseTo(35.2);
    expect(alpha.winBonusPerGame).toBeCloseTo(4); // team win% 1.0 x 4
    expect(alpha.projection).toBeCloseTo(39.2);

    const bravo = map.get(102)!;
    expect(bravo).toMatchObject({ seasonGames: 8, recentGames: 3 });
    expect(bravo.statProjection).toBeCloseTo(13.75); // too few recent games: season average
    expect(bravo.projection).toBeCloseTo(17.75);
    expect(map.has(103)).toBe(false);
  });

  it("can be limited to some players", async () => {
    const map = await loadProjections(db, { now: NOW, playerIds: [102] });
    expect([...map.keys()]).toEqual([102]);
  });
});

describe("win bonus in projections", () => {
  it("drops the expected bonus for a player who is currently Out", async () => {
    await applyInjuries(
      db,
      [{ playerId: 101, teamId: 1, status: "OUT", detail: "Knee", shortComment: "s", longComment: "l", date: NOW }],
      NOW,
    );
    const alpha = (await loadProjections(db, { now: NOW })).get(101)!;
    expect(alpha.winBonusPerGame).toBe(0);
    expect(alpha.projection).toBeCloseTo(35.2);
    // The SQL twin used by the Players table agrees.
    const row = (await listPlayers(db, { now: NOW })).rows.find((r) => r.id === 101)!;
    expect(row.proj).toBeCloseTo(35.2);
  });

  it("uses the team's win% (a day-to-day player keeps the bonus)", async () => {
    // Team 2 (BOS) lost every game above; give Charlie some stats there and check the 0 bonus.
    await upsertStats(db, [stat(1001, 103, 20, { teamId: 2 }), stat(1002, 103, 20, { teamId: 2 })], NOW);
    await applyInjuries(
      db,
      [{ playerId: 103, teamId: 2, status: "Day-To-Day", detail: "Ankle", shortComment: "s", longComment: "l", date: NOW }],
      NOW,
    );
    const charlie = (await loadProjections(db, { now: NOW })).get(103)!;
    expect(charlie.winBonusPerGame).toBe(0); // BOS win% is 0
    expect(charlie.seasonAvg).toBeCloseTo(20);
    expect(charlie.projection).toBeCloseTo(20);
  });

  it("approximates historical eligibility: coach's-decision DNP earns the bonus, injury DNP does not", async () => {
    await upsertGames(db, [game(3001, "2026-03-01T00:00:00Z", "final"), game(3002, "2026-03-02T00:00:00Z", "final")], NOW);
    await upsertStats(
      db,
      [
        stat(3001, 102, 0, { dnp: true, minutes: null, dnpReason: "DNP - Coach's Decision" }),
        stat(3002, 102, 0, { dnp: true, minutes: null, dnpReason: "Left knee soreness" }),
      ],
      NOW,
    );
    const before = (await listPlayers(db, { now: NOW })).rows.find((r) => r.id === 102)!;
    // Bravo: 8 played games (+4 each) plus one eligible DNP win: 8 x 10-or-20 stat points + 9 x 4.
    expect(before.gp).toBe(8);
    expect(before.fpTotal).toBe(fantasyPoints({ pts: 10 }) * 5 + fantasyPoints({ pts: 20 }) * 3 + 9 * 4);
  });
});

describe("loadGamesRemaining", () => {
  it("counts unplayed games this ET week and this season", async () => {
    const rem = await loadGamesRemaining(db, NOW);
    expect(rem.get(1)).toEqual({ week: 2, season: 3 });
    expect(rem.get(2)).toEqual({ week: 2, season: 3 });
  });
});

describe("listPlayers", () => {
  it("aggregates in SQL and sorts by total fantasy points by default", async () => {
    const res = await listPlayers(db, { now: NOW });
    expect(res.season).toBe(2026);
    expect(res.total).toBe(3);
    expect(res.rows.map((r) => r.fullName)).toEqual(["Alpha Guard", "Bravo Wing", "Charlie Big"]);
    const alpha = res.rows[0];
    expect(alpha).toMatchObject({ gp: 10, teamAbbrev: "ATL", positions: ["PG", "SG"] });
    expect(alpha.pts).toBeCloseTo(28);
    expect(alpha.fpTotal).toBe(320); // 280 stat points + 10 x 4 win bonus
    expect(alpha.fpAvg).toBeCloseTo(32);
    expect(alpha.min).toBeCloseTo(30);
    expect(alpha.proj).toBeCloseTo(39.2);
    // Players with no games come last with empty stats.
    expect(res.rows[2]).toMatchObject({ gp: 0, pts: null, fpTotal: null, proj: null });
  });

  it("matches the pure projection function", async () => {
    const res = await listPlayers(db, { now: NOW });
    const proj = await loadProjections(db, { now: NOW });
    for (const r of res.rows.filter((x) => x.gp > 0)) expect(r.proj).toBeCloseTo(proj.get(r.id)!.projection!);
  });

  it("supports last 7 / 15 / 30 day ranges", async () => {
    const gp = async (range: "7" | "15" | "30") =>
      (await listPlayers(db, { now: NOW, range })).rows.find((r) => r.id === 101)!.gp;
    expect(await gp("7")).toBe(2); // 03-13, 03-15 (03-11 00:00Z is before now-7d)
    expect(await gp("15")).toBe(6);
    expect(await gp("30")).toBe(6);
    const week = (await listPlayers(db, { now: NOW, range: "7" })).rows.find((r) => r.id === 101)!;
    expect(week.fpTotal).toBe(88);
    // Projection still uses full-season context regardless of range.
    expect(week.proj).toBeCloseTo(39.2);
  });

  it("filters by position, team, injury and health, and searches by name", async () => {
    await applyInjuries(
      db,
      [{ playerId: 102, teamId: 1, status: "Out", detail: "Knee", shortComment: "s", longComment: "l", date: NOW }],
      NOW,
    );
    const names = async (p: Parameters<typeof listPlayers>[1]) => (await listPlayers(db, { now: NOW, ...p })).rows.map((r) => r.fullName);
    expect(await names({ pos: "C" })).toEqual(["Charlie Big"]);
    expect(await names({ pos: "SG" })).toEqual(["Alpha Guard"]);
    expect(await names({ team: 2 })).toEqual(["Charlie Big"]);
    expect(await names({ inj: "out" })).toEqual(["Bravo Wing"]);
    expect(await names({ healthy: true })).toEqual(["Alpha Guard", "Charlie Big"]);
    expect(await names({ q: "wing" })).toEqual(["Bravo Wing"]);
    expect(await names({ q: "%" })).toEqual([]); // wildcard is escaped, not matched
    expect(await names({ pos: "XX" })).toHaveLength(3); // unknown position ignored
  });

  it("sorts by any column in either direction", async () => {
    const names = async (sort: Parameters<typeof listPlayers>[1]["sort"], dir: "asc" | "desc") =>
      (await listPlayers(db, { now: NOW, sort, dir })).rows.map((r) => r.fullName);
    expect(await names("name", "asc")).toEqual(["Alpha Guard", "Bravo Wing", "Charlie Big"]);
    expect(await names("name", "desc")).toEqual(["Charlie Big", "Bravo Wing", "Alpha Guard"]);
    expect(await names("proj", "desc")).toEqual(["Alpha Guard", "Bravo Wing", "Charlie Big"]);
    expect(await names("gp", "asc")).toEqual(["Bravo Wing", "Alpha Guard", "Charlie Big"]); // nulls last
    for (const k of ["min", "pts", "reb", "ast", "stl", "blk", "to", "tpm", "fgpct", "ftpct", "fpavg", "fptotal"] as const) {
      await expect(names(k, "desc")).resolves.toHaveLength(3);
    }
  });

  it("paginates 50 per page", async () => {
    await upsertPlayers(
      db,
      Array.from({ length: 120 }, (_, i) => player(5000 + i, `Filler ${String(i).padStart(3, "0")}`, 2, ["C"])),
      "full",
    );
    const p1 = await listPlayers(db, { now: NOW, sort: "name", dir: "asc" });
    expect(PAGE_SIZE).toBe(50);
    expect(p1).toMatchObject({ total: 123, pageCount: 3, page: 1 });
    expect(p1.rows).toHaveLength(50);
    const p3 = await listPlayers(db, { now: NOW, sort: "name", dir: "asc", page: 3 });
    expect(p3.rows).toHaveLength(23);
    const all = new Set([...p1.rows, ...(await listPlayers(db, { now: NOW, sort: "name", dir: "asc", page: 2 })).rows, ...p3.rows].map((r) => r.id));
    expect(all.size).toBe(123);
  });
});

describe("getPlayerCard", () => {
  it("returns averages, game log, schedule and projection", async () => {
    const card = (await getPlayerCard(db, 101, NOW))!;
    expect(card.player.fullName).toBe("Alpha Guard");
    expect(card.team?.abbrev).toBe("ATL");
    expect(card.averages).toMatchObject({ gp: 10 });
    expect(card.averages!.fpAvg).toBeCloseTo(32);
    expect(card.gameLog).toHaveLength(11);
    expect(card.gameLog[0]).toMatchObject({ opponent: "BOS", home: true, fantasyPoints: null }); // newest = the DNP
    expect(card.gameLog[1].fantasyPoints).toBe(fantasyPoints({ pts: 40 }));
    expect(card.schedule.map((s) => s.gameId)).toEqual([2001, 2002, 2003, 2004]);
    expect(card.projection?.projection).toBeCloseTo(39.2);
    expect(card.remaining).toEqual({ week: 2, season: 3 });
    expect(card.projectedTotals.week).toBeCloseTo(78.4);
  });

  it("returns null for unknown players", async () => {
    expect(await getPlayerCard(db, 999999, NOW)).toBeNull();
  });
});
