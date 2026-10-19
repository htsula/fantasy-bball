/** Fast checks on the pieces of the league simulation (the oracle and the NBA world), so the guard itself is guarded. */
import { describe, expect, it } from "vitest";
import {
  ALL_STAR_BREAK,
  buildSchedule,
  buildWorld,
  lineFp,
  nextSeasonGameDays,
  planTeamGame,
  seasonGameDays,
  statLine,
} from "@/lib/sim/nba-data";
import { oracleStandings, oracleTeamTotal, type OracleData } from "@/lib/sim/oracle";
import { makeRng } from "@/lib/sim/rng";

describe("simulated NBA calendar", () => {
  it("runs from opening night to April 11 without Thanksgiving, Christmas Eve or the All-Star break", () => {
    const days = seasonGameDays();
    expect(days[0]).toBe("2026-10-20");
    expect(days[days.length - 1]).toBe("2027-04-11");
    for (const off of ["2026-11-26", "2026-12-24", "2027-02-12", "2027-02-14", "2027-02-17"]) expect(days).not.toContain(off);
    expect(days).toContain("2027-02-11");
    expect(days).toContain("2027-02-18");
    expect(days).toHaveLength(166);
    expect(ALL_STAR_BREAK.start).toBe("2027-02-12");
    const next = nextSeasonGameDays();
    expect(next[0]).toBe("2027-10-19");
    expect(next).not.toContain("2028-02-20");
  });

  it("deals about 82 games per team, never two a day", () => {
    const rand = makeRng(3);
    const world = buildWorld(rand);
    const games = buildSchedule(rand, world.teams, seasonGameDays(), 2027, 1, { gamesTotal: 1230 });
    expect(games).toHaveLength(1230);
    const perTeam = new Map<number, number>();
    const perDay = new Set<string>();
    for (const g of games) {
      for (const t of [g.home, g.away]) {
        perTeam.set(t, (perTeam.get(t) ?? 0) + 1);
        const key = `${g.date}:${t}`;
        expect(perDay.has(key)).toBe(false);
        perDay.add(key);
      }
      expect(g.home).not.toBe(g.away);
    }
    expect(perTeam.size).toBe(30);
    for (const n of perTeam.values()) {
      expect(n).toBeGreaterThanOrEqual(80);
      expect(n).toBeLessThanOrEqual(84);
    }
    expect(games.filter((g) => g.date === "2026-10-20")).toHaveLength(2);
  });

  it("builds ~600 usable players plus retired and teamless extras, none with real names", () => {
    const world = buildWorld(makeRng(1));
    const usable = world.players.filter((p) => p.active && p.nbaTeamId !== null);
    expect(usable).toHaveLength(600);
    expect(world.players.filter((p) => !p.active)).toHaveLength(8);
    expect(world.players.filter((p) => p.nbaTeamId === null)).toHaveLength(12);
    expect(new Set(world.players.map((p) => p.name)).size).toBe(world.players.length);
    expect(usable.filter((p) => p.rookie).length).toBe(30);
    for (const t of world.teams) expect(usable.filter((p) => p.nbaTeamId === t.id)).toHaveLength(20);
  });

  it("writes coherent box scores", () => {
    const rand = makeRng(11);
    for (let i = 0; i < 2000; i++) {
      const l = statLine(rand.next() * 60, 5 + rand.int(35), rand);
      expect(l.pts).toBe(2 * (l.fgm - l.tpm) + 3 * l.tpm + l.ftm);
      expect(l.fga).toBeGreaterThanOrEqual(l.fgm);
      expect(l.fta).toBeGreaterThanOrEqual(l.ftm);
      expect(l.tpa).toBeGreaterThanOrEqual(l.tpm);
      expect(l.fgm).toBeGreaterThanOrEqual(l.tpm);
      expect(l.oreb + l.dreb).toBe(l.reb);
    }
    expect(lineFp({ pts: 20, reb: 10, ast: 5, stl: 2, blk: 1, to: 3, fgm: 8, fga: 18, ftm: 2, fta: 3, tpm: 2 })).toBe(20 + 10 + 10 + 8 + 4 - 6 + 16 - 18 + 2 - 3 + 2);
  });

  it("an Out player produces no stats and a deep bench player is a coach's decision", () => {
    const rand = makeRng(5);
    const world = buildWorld(rand);
    const team = world.teams[0].id;
    const star = world.players.filter((p) => p.nbaTeamId === team).sort((a, b) => b.q - a.q)[0];
    star.health = { status: "Out", detail: "Ankle", untilDate: null };
    for (let i = 0; i < 30; i++) {
      const plan = planTeamGame(rand, world.players, team, 1);
      expect(plan.find((p) => p.player.id === star.id && !p.dnp)).toBeUndefined();
      expect(plan.filter((p) => !p.dnp).length).toBeGreaterThanOrEqual(10);
    }
  });
});

describe("simulation oracle", () => {
  const T = (id: string) => ({ id, name: id.toUpperCase() });
  const g = (period: number, home: string, away: string, hp: number, ap: number) => ({ period, home, away, hp, ap });

  it("ranks by win percentage, a tie counting as half a win", () => {
    const rows = oracleStandings([T("a"), T("b"), T("c")], [g(1, "a", "b", 100, 90), g(2, "a", "c", 100, 100), g(3, "b", "c", 120, 80)]);
    expect(rows.map((r) => [r.teamId, r.w, r.l, r.t, r.rank])).toEqual([
      ["a", 1, 0, 1, 1],
      ["b", 1, 1, 0, 2],
      ["c", 0, 1, 1, 3],
    ]);
    expect(rows.map((r) => r.streak)).toEqual(["T1", "W1", "L1"]);
    expect(rows[0].gamesBack).toBe(0);
    expect(rows[2].gamesBack).toBe(1);
  });

  it("breaks ties by head-to-head inside the tied group before points for", () => {
    // a and b are both 1-1; a beat b, but b has far more points for.
    const rows = oracleStandings([T("a"), T("b"), T("c"), T("d")], [g(1, "a", "b", 100, 90), g(2, "c", "a", 110, 80), g(3, "b", "d", 500, 10)]);
    expect(rows.map((r) => r.teamId)).toEqual(["c", "a", "b", "d"]);
  });

  it("without a mutual game points for decide, then points against (lower is better), then the name", () => {
    const rows = oracleStandings([T("a"), T("b"), T("c"), T("d")], [g(1, "a", "c", 100, 90), g(1, "b", "d", 150, 90)]);
    expect(rows.map((r) => r.teamId)).toEqual(["b", "a", "c", "d"]);
    // c and d both lost scoring 90 and 90: c allowed 100, d allowed 150, so c ranks higher.
    expect(rows.slice(2).map((r) => [r.teamId, r.pa])).toEqual([["c", 100], ["d", 150]]);
    expect(oracleStandings([T("y"), T("x")], []).map((r) => r.teamId)).toEqual(["x", "y"]);
  });

  it("scores a game for whoever rostered the player at tip-off, with the win bonus unless Out", () => {
    const tip = Date.UTC(2026, 10, 3, 0, 0);
    const stat = (pts: number, dnp = false) => ({ dnp, teamId: 1, pts, reb: 0, ast: 0, stl: 0, blk: 0, to: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, tpm: 0 });
    const data: OracleData = {
      games: [
        { id: 1, start: tip, status: "final", home: 1, away: 2, hs: 110, as: 100 },
        { id: 2, start: tip + 3_600_000, status: "in", home: 1, away: 3, hs: 50, as: 40 },
      ],
      snaps: new Map([
        ["1:10", { nbaTeamId: 1, status: null }],
        ["1:11", { nbaTeamId: 1, status: "Out" }],
        ["1:12", { nbaTeamId: 1, status: "Day-To-Day" }],
        ["1:13", { nbaTeamId: 2, status: null }],
        ["2:10", { nbaTeamId: 1, status: null }],
      ]),
      stats: new Map([
        ["1:10", stat(20)],
        ["1:11", stat(0, true)],
        ["1:12", stat(0, true)],
        ["2:10", stat(8)],
      ]),
      entries: [
        { teamId: "A", playerId: 10, from: tip - 1000, to: null },
        { teamId: "A", playerId: 11, from: tip - 1000, to: null },
        { teamId: "A", playerId: 12, from: tip - 1000, to: null },
        { teamId: "B", playerId: 13, from: tip - 1000, to: tip + 1 }, // dropped right after tip-off
        { teamId: "C", playerId: 10, from: tip + 1, to: null }, // acquired right after tip-off: gets nothing from game 1
      ],
      adjustments: [],
    };
    // Player 10: 20 + 4 (final win); 11: Out, no bonus; 12: Day-To-Day dnp still gets the bonus; game 2 is live: stats only.
    expect(oracleTeamTotal(data, "A")).toEqual({ points: 20 + 4 + 0 + 4 + 8, winBonus: 8, rows: 4 });
    expect(oracleTeamTotal(data, "B")).toEqual({ points: 0, winBonus: 0, rows: 1 }); // lost, kept the game he was rostered for
    expect(oracleTeamTotal(data, "C")).toEqual({ points: 8, winBonus: 0, rows: 1 }); // only the later game
  });
});
