import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nbaGames } from "@/db/schema";
import type { Db } from "@/db/types";
import { fantasyPoints } from "@/lib/fantasy/points";
import { gameFantasyPoints, isOut, normalizeInjuryStatus } from "@/lib/fantasy/scoring";
import { DEFAULT_SCORING } from "@/lib/fantasy/settings";
import { playerPointsForTeam, teamGamePoints, teamPointsByDay } from "@/lib/fantasy/team-points";
import { createTestDb } from "./helpers/db";
import { seedPlayers } from "./helpers/draft";
import { boxScore, insertGame, rosterPlayer, seasonLeague, snapshot } from "./helpers/rosters";

describe("isOut / normalizeInjuryStatus", () => {
  it("treats Out in any casing as out, and nothing else", () => {
    for (const s of ["Out", "OUT", " out ", "Out For Season", "out for season"]) expect(isOut(s)).toBe(true);
    for (const s of ["Day-To-Day", "Questionable", "Doubtful", "Probable", "Suspension", "Outlook", "", null, undefined]) {
      expect(isOut(s)).toBe(false);
    }
  });
  it("normalizes casing of known statuses and keeps unknown ones", () => {
    expect(normalizeInjuryStatus("OUT")).toBe("Out");
    expect(normalizeInjuryStatus("day-to-day")).toBe("Day-To-Day");
    expect(normalizeInjuryStatus("  Something  New ")).toBe("Something New");
    expect(normalizeInjuryStatus("")).toBeNull();
    expect(normalizeInjuryStatus(null)).toBeNull();
  });
});

describe("gameFantasyPoints (pure)", () => {
  const line = { pts: 20, reb: 5, ast: 3 }; // 20 + 5 + 6
  const base = { stats: line, teamWon: true, inSnapshot: true, injuryStatus: null };

  it("adds the win bonus to stat points", () => {
    expect(gameFantasyPoints(base, DEFAULT_SCORING)).toEqual({ statPoints: 31, winBonus: 4, total: 35 });
    expect(gameFantasyPoints(base, DEFAULT_SCORING).statPoints).toBe(fantasyPoints(line));
  });
  it("gives a 0-minute winner (no stat line) the bonus", () => {
    expect(gameFantasyPoints({ ...base, stats: null }, DEFAULT_SCORING)).toEqual({ statPoints: 0, winBonus: 4, total: 4 });
  });
  it("gives nothing to a loser's bench, an Out player, or a player missing from the snapshot", () => {
    expect(gameFantasyPoints({ ...base, stats: null, teamWon: false }, DEFAULT_SCORING).total).toBe(0);
    expect(gameFantasyPoints({ ...base, stats: null, injuryStatus: "Out" }, DEFAULT_SCORING).total).toBe(0);
    expect(gameFantasyPoints({ ...base, stats: null, inSnapshot: false }, DEFAULT_SCORING).total).toBe(0);
  });
  it("still counts stats when the bonus is denied", () => {
    expect(gameFantasyPoints({ ...base, teamWon: false }, DEFAULT_SCORING)).toEqual({ statPoints: 31, winBonus: 0, total: 31 });
    expect(gameFantasyPoints({ ...base, inSnapshot: false }, DEFAULT_SCORING).total).toBe(31);
  });
  it("keeps the bonus for day-to-day and suspended players", () => {
    for (const injuryStatus of ["Day-To-Day", "Questionable", "Suspension"]) {
      expect(gameFantasyPoints({ ...base, stats: null, injuryStatus }, DEFAULT_SCORING).winBonus).toBe(4);
    }
  });
  it("uses the league's team-win value", () => {
    expect(gameFantasyPoints({ ...base, stats: null }, { ...DEFAULT_SCORING, teamWin: 7 }).winBonus).toBe(7);
  });
});

// ---------------------------------------------------------------------------------------------

let db: Db;
let close: () => Promise<void> | void;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await seedPlayers(db, 12); // ids 1..12
});
afterEach(async () => {
  await close();
});

const TIP = new Date("2026-11-03T00:00:00Z"); // 7pm ET on Nov 2 (EST)

describe("teamGamePoints (tip-off ownership + win bonus)", () => {
  // Game 1: NBA team 1 (home) beat NBA team 2.
  it("covers every bonus case from the plan", async () => {
    const fx = await seasonLeague(db, 2);
    await insertGame(db, 1, TIP, "final", 1, 2);
    const winnerBench = 1; // NBA team 1, no stat row (0 minutes), in snapshot -> +4
    const winnerOut = 2; // NBA team 1, snapshot says OUT, played anyway -> stats only
    const loser = 3; // NBA team 2, played -> stats only, no bonus
    const tradedAway = 4; // not in the snapshot and no stats -> no row at all
    const lateSnap = 5; // snapshot flagged late still counts
    const notInSnapButPlayed = 6; // stats exist but not in snapshot -> stats only
    for (const id of [winnerBench, winnerOut, loser, tradedAway, lateSnap, notInSnapButPlayed]) {
      await rosterPlayer(db, fx, 0, id);
    }
    await snapshot(db, 1, winnerBench, 1);
    await snapshot(db, 1, winnerOut, 1, "OUT");
    await snapshot(db, 1, loser, 2);
    await snapshot(db, 1, lateSnap, 1, "Day-To-Day", true);
    await boxScore(db, 1, winnerOut, 1, { pts: 10 });
    await boxScore(db, 1, loser, 2, { pts: 10 });
    await boxScore(db, 1, notInSnapButPlayed, 1, { pts: 10 });

    const rows = await teamGamePoints(db, fx.teams[0].id);
    const by = new Map(rows.map((r) => [r.playerId, r]));
    expect(by.get(winnerBench)).toMatchObject({ statPoints: 0, winBonus: 4, total: 4, hasStats: false, inSnapshot: true });
    expect(by.get(winnerOut)).toMatchObject({ statPoints: 10, winBonus: 0, total: 10 });
    expect(by.get(loser)).toMatchObject({ statPoints: 10, winBonus: 0, teamWon: false });
    expect(by.has(tradedAway)).toBe(false);
    expect(by.get(lateSnap)).toMatchObject({ winBonus: 4, lateSnapshot: true, injuryStatus: "Day-To-Day" });
    expect(by.get(notInSnapButPlayed)).toMatchObject({ statPoints: 10, winBonus: 0, inSnapshot: false });
  });

  it("gives a player added before tip-off the game, and not a player dropped before it", async () => {
    const fx = await seasonLeague(db, 2);
    await insertGame(db, 1, TIP, "final", 1, 2);
    await snapshot(db, 1, 1, 1);
    await snapshot(db, 1, 2, 2);
    await boxScore(db, 1, 1, 1, { pts: 10 });
    await boxScore(db, 1, 2, 2, { pts: 10 });
    // Player 1: added at 6pm ET (23:00Z) for the 7pm game by team 0.
    await rosterPlayer(db, fx, 0, 1, { acquiredAt: new Date("2026-11-02T23:00:00Z"), via: "add" });
    // Player 2: team 1 dropped him at 5:30pm ET, before tip-off.
    await rosterPlayer(db, fx, 1, 2, { releasedAt: new Date("2026-11-02T22:30:00Z") });

    expect((await teamGamePoints(db, fx.teams[0].id)).map((r) => r.playerId)).toEqual([1]);
    expect(await teamGamePoints(db, fx.teams[1].id)).toEqual([]);
  });

  it("splits one player's games between teams at the tip-off instant", async () => {
    const fx = await seasonLeague(db, 2);
    await insertGame(db, 1, TIP, "final", 1, 2);
    await insertGame(db, 2, new Date("2026-11-04T00:00:00Z"), "final", 1, 2);
    for (const gid of [1, 2]) {
      await snapshot(db, gid, 1, 1);
      await boxScore(db, gid, 1, 1, { pts: 10 });
    }
    const swap = new Date("2026-11-03T12:00:00Z"); // between the two games
    await rosterPlayer(db, fx, 0, 1, { releasedAt: swap });
    await rosterPlayer(db, fx, 1, 1, { acquiredAt: swap, via: "add" });
    expect((await teamGamePoints(db, fx.teams[0].id)).map((r) => r.gameId)).toEqual([1]);
    expect((await teamGamePoints(db, fx.teams[1].id)).map((r) => r.gameId)).toEqual([2]);
  });

  it("owns at the exact tip-off instant on acquisition but not on release", async () => {
    await insertGame(db, 3, TIP, "final", 1, 2);
    await snapshot(db, 3, 1, 1);
    const acquiredAtTip = await seasonLeague(db, 2);
    await rosterPlayer(db, acquiredAtTip, 0, 1, { acquiredAt: TIP });
    expect(await teamGamePoints(db, acquiredAtTip.teams[0].id)).toHaveLength(1);
    const releasedAtTip = await seasonLeague(db, 2);
    await rosterPlayer(db, releasedAtTip, 0, 1, { releasedAt: TIP });
    expect(await teamGamePoints(db, releasedAtTip.teams[0].id)).toHaveLength(0);
  });

  it("counts live stats during a game but pays the bonus only once it is final", async () => {
    const fx = await seasonLeague(db, 2);
    await insertGame(db, 1, TIP, "in", 1, 2, [60, 50]);
    await snapshot(db, 1, 1, 1);
    await snapshot(db, 1, 3, 1);
    await boxScore(db, 1, 1, 1, { pts: 12 });
    await rosterPlayer(db, fx, 0, 1);
    await rosterPlayer(db, fx, 0, 3);

    let rows = await teamGamePoints(db, fx.teams[0].id);
    expect(rows.map((r) => [r.playerId, r.statPoints, r.winBonus, r.gameStatus])).toEqual([
      [1, 12, 0, "in"],
      [3, 0, 0, "in"],
    ]);

    await db.update(nbaGames).set({ status: "final" }).where(eq(nbaGames.id, 1));
    rows = await teamGamePoints(db, fx.teams[0].id);
    expect(rows.map((r) => [r.playerId, r.total])).toEqual([
      [1, 16],
      [3, 4],
    ]);
  });

  it("ignores scheduled games", async () => {
    const fx = await seasonLeague(db, 2);
    await insertGame(db, 1, TIP, "scheduled", 1, 2);
    await rosterPlayer(db, fx, 0, 1);
    await snapshot(db, 1, 1, 1);
    expect(await teamGamePoints(db, fx.teams[0].id)).toEqual([]);
  });

  it("uses the league's scoring values and aggregates by day and player", async () => {
    const fx = await seasonLeague(db, 2, { settings: { scoring: { teamWin: 10, pts: 2 } } });
    await insertGame(db, 1, TIP, "final", 1, 2); // ET Nov 2
    await insertGame(db, 2, new Date("2026-11-04T00:00:00Z"), "final", 1, 2); // ET Nov 3
    await rosterPlayer(db, fx, 0, 1);
    await rosterPlayer(db, fx, 0, 3);
    for (const gid of [1, 2]) {
      await snapshot(db, gid, 1, 1);
      await snapshot(db, gid, 3, 1);
    }
    await boxScore(db, 1, 1, 1, { pts: 5 });

    const days = await teamPointsByDay(db, fx.teams[0].id);
    expect(days).toEqual([
      { date: "2026-11-02", games: 1, statPoints: 10, winBonus: 20, total: 30 },
      { date: "2026-11-03", games: 1, statPoints: 0, winBonus: 20, total: 20 },
    ]);
    expect(await teamPointsByDay(db, fx.teams[0].id, "2026-11-03", "2026-11-03")).toHaveLength(1);
    expect(await teamPointsByDay(db, fx.teams[0].id, "2026-11-04", null)).toEqual([]);

    const players = await playerPointsForTeam(db, fx.teams[0].id);
    expect(players.get(1)).toMatchObject({ games: 2, statPoints: 10, winBonus: 20, total: 30 });
    expect(players.get(3)).toMatchObject({ games: 2, statPoints: 0, winBonus: 20, total: 20 });
  });
});
