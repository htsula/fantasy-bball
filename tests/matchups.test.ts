import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leagues, matchupPeriods, matchups, matchupTeamTotals, nbaGames, notifications, playerGameStats, standings } from "@/db/schema";
import type { Db } from "@/db/types";
import { loadProjections } from "@/lib/fantasy/projections";
import {
  computeMatchupTotals,
  finalizePeriod,
  getCurrentPeriod,
  getMatchupTotals,
  getStandings,
  refreshStandings,
  runNightlyMatchupJob,
} from "@/lib/matchups/service";
import { createTestDb } from "./helpers/db";
import { captureNotifier, seedPlayers, type DraftFixture } from "./helpers/draft";
import { boxScore, insertGame, rosterPlayer, seasonLeague, snapshot } from "./helpers/rosters";

let db: Db;
let close: () => Promise<void> | void;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await seedPlayers(db, 12); // player i plays for NBA team i
});
afterEach(async () => {
  await close();
});

// Period 1: Mon 2026-10-19 .. Sun 2026-10-25 (EDT, UTC-4). Period 2: Oct 26 .. Nov 1.
const P1 = { number: 1, startDate: "2026-10-19", endDate: "2026-10-25" };
const P2 = { number: 2, startDate: "2026-10-26", endDate: "2026-11-01" };
const AFTER_P1 = new Date("2026-10-26T13:00:00Z"); // Monday 9am ET
const MID_P1 = new Date("2026-10-22T18:00:00Z");

async function period(fx: DraftFixture, p: typeof P1) {
  const [row] = await db.insert(matchupPeriods).values({ ...p, leagueId: fx.league.id }).returning();
  return row;
}
async function matchup(fx: DraftFixture, periodId: string, home: number, away: number | null) {
  const [row] = await db
    .insert(matchups)
    .values({ leagueId: fx.league.id, periodId, homeTeamId: fx.teams[home].id, awayTeamId: away === null ? null : fx.teams[away].id })
    .returning();
  return row;
}

/** Final game (home team 1 wins 110-100) with a snapshot + box score for the given players. */
async function scoredGame(gameId: number, start: Date, players: { id: number; nba: number; pts?: number; out?: boolean; dnp?: boolean }[], home = 1, away = 2) {
  await insertGame(db, gameId, start, "final", home, away);
  for (const p of players) {
    await snapshot(db, gameId, p.id, p.nba, p.out ? "Out" : null);
    if (!p.dnp) await boxScore(db, gameId, p.id, p.nba, { pts: p.pts ?? 20 });
  }
}

describe("period totals", () => {
  it("assigns games to periods by ET tip-off, including the 10:30pm Sunday / Monday-UTC case", async () => {
    const fx = await seasonLeague(db, 2);
    const p1 = await period(fx, P1);
    const p2 = await period(fx, P2);
    const m1 = await matchup(fx, p1.id, 0, 1);
    const m2 = await matchup(fx, p2.id, 0, 1);
    await rosterPlayer(db, fx, 0, 1);
    const one = (id: number, iso: string) => scoredGame(id, new Date(iso), [{ id: 1, nba: 1 }]);
    await one(1, "2026-10-19T03:59:00Z"); // Sun Oct 18 23:59 ET -> before period 1
    await one(2, "2026-10-19T04:00:00Z"); // Mon Oct 19 00:00 ET exactly -> period 1
    await one(3, "2026-10-26T02:30:00Z"); // Sun Oct 25 22:30 ET (Monday UTC) -> period 1
    await one(4, "2026-10-26T03:59:00Z"); // Sun Oct 25 23:59 ET -> period 1
    await one(5, "2026-10-26T04:00:00Z"); // Mon Oct 26 00:00 ET -> period 2

    const t1 = await computeMatchupTotals(db, m1.id, AFTER_P1);
    expect(t1.home.points).toBe(72); // 3 games x (20 stat + 4 bonus)
    expect(t1.home.winBonus).toBe(12);
    expect(t1.home.gamesPlayed).toBe(3);
    expect(t1.away?.points).toBe(0);
    const t2 = await computeMatchupTotals(db, m2.id, AFTER_P1);
    expect(t2.home.points).toBe(24);
  });

  it("respects tip-off ownership: a player added after tip-off scores nothing for that game", async () => {
    const fx = await seasonLeague(db, 2);
    const p1 = await period(fx, P1);
    const m = await matchup(fx, p1.id, 0, 1);
    await scoredGame(1, new Date("2026-10-20T23:00:00Z"), [{ id: 1, nba: 1 }]);
    await rosterPlayer(db, fx, 0, 1, { acquiredAt: new Date("2026-10-20T22:00:00Z"), releasedAt: new Date("2026-10-21T12:00:00Z") });
    await rosterPlayer(db, fx, 1, 1, { acquiredAt: new Date("2026-10-21T12:00:00Z") });
    await scoredGame(2, new Date("2026-10-23T23:00:00Z"), [{ id: 1, nba: 1 }]);
    const t = await computeMatchupTotals(db, m.id, AFTER_P1);
    expect(t.home.points).toBe(24); // game 1 only
    expect(t.away?.points).toBe(24); // game 2 only
  });

  it("pays the win bonus to non-playing players, but not to Out players or losers", async () => {
    const fx = await seasonLeague(db, 2);
    const p1 = await period(fx, P1);
    const m = await matchup(fx, p1.id, 0, 1);
    for (const id of [1, 3, 4]) await rosterPlayer(db, fx, 0, id);
    await rosterPlayer(db, fx, 1, 2); // plays for the losing team 2
    // players 3 and 4 have NBA team 1 by seed order? seeded team = id, so override via snapshot team.
    await scoredGame(1, new Date("2026-10-20T23:00:00Z"), [
      { id: 1, nba: 1, pts: 10 },
      { id: 3, nba: 1, dnp: true }, // bench winner: +4 with 0 minutes
      { id: 4, nba: 1, dnp: true, out: true }, // Out at tip-off: nothing
      { id: 2, nba: 2, pts: 30 }, // loser: stats only
    ]);
    const t = await computeMatchupTotals(db, m.id, AFTER_P1);
    expect(t.home.points).toBe(14 + 4); // p1 10+4, p3 +4, p4 0
    expect(t.home.winBonus).toBe(8);
    expect(t.away?.points).toBe(30);
    expect(t.away?.winBonus).toBe(0);
  });

  it("counts stats live but the bonus only once the game is final", async () => {
    const fx = await seasonLeague(db, 2);
    const p1 = await period(fx, P1);
    const m = await matchup(fx, p1.id, 0, 1);
    await rosterPlayer(db, fx, 0, 1);
    await rosterPlayer(db, fx, 0, 3);
    const tip = new Date("2026-10-22T23:00:00Z");
    await insertGame(db, 1, tip, "in", 1, 2, [50, 40]);
    await snapshot(db, 1, 1, 1);
    await snapshot(db, 1, 3, 1);
    await boxScore(db, 1, 1, 1, { pts: 12 });
    const live = await computeMatchupTotals(db, m.id, new Date("2026-10-22T23:45:00Z"));
    expect(live.home.points).toBe(12); // no +4 yet, not even for the leader
    expect(live.home.winBonus).toBe(0);
    expect(live.home.gamesPlayed).toBe(2); // both rostered players are in the tip-off snapshot
    const [row] = await db.select().from(matchups).where(eq(matchups.id, m.id));
    expect(row.status).toBe("live");
    expect(row.homePoints).toBe(12);

    await db.update(nbaGames).set({ status: "final", homeScore: 110, awayScore: 100 }).where(eq(nbaGames.id, 1));
    const done = await computeMatchupTotals(db, m.id, new Date("2026-10-23T02:00:00Z"));
    expect(done.home.points).toBe(12 + 4 + 4);
    expect(done.home.winBonus).toBe(8);
  });

  it("reports games remaining for currently rostered players and a projection", async () => {
    const fx = await seasonLeague(db, 2);
    const p1 = await period(fx, P1);
    const m = await matchup(fx, p1.id, 0, 1);
    await rosterPlayer(db, fx, 0, 1);
    await rosterPlayer(db, fx, 0, 5);
    // history so a projection exists for player 1
    await scoredGame(1, new Date("2026-10-19T23:00:00Z"), [{ id: 1, nba: 1, pts: 20 }]);
    // future games in the period: team 1 plays twice, team 5 once, team 7 (nobody's) once
    await insertGame(db, 10, new Date("2026-10-23T23:00:00Z"), "scheduled", 1, 3);
    await insertGame(db, 11, new Date("2026-10-25T23:00:00Z"), "scheduled", 4, 1);
    await insertGame(db, 12, new Date("2026-10-24T23:00:00Z"), "scheduled", 5, 6);
    await insertGame(db, 13, new Date("2026-10-24T23:00:00Z"), "scheduled", 7, 8);
    // outside the period
    await insertGame(db, 14, new Date("2026-10-26T23:00:00Z"), "scheduled", 1, 3);
    await insertGame(db, 15, new Date("2026-10-23T23:00:00Z"), "scheduled", 1, 3);
    await db.update(nbaGames).set({ status: "postponed" }).where(eq(nbaGames.id, 15));

    const t = await computeMatchupTotals(db, m.id, MID_P1);
    expect(t.home.gamesPlayed).toBe(1);
    expect(t.home.gamesRemaining).toBe(3);
    const proj = await loadProjections(db, { playerIds: [1, 5], now: MID_P1 });
    const per1 = proj.get(1)?.projection ?? 0;
    const per5 = proj.get(5)?.projection ?? 0;
    expect(per1).toBeGreaterThan(0);
    expect(t.home.projected).toBeCloseTo(24 + 2 * per1 + per5, 1);
    expect(t.home.projected).toBeGreaterThan(t.home.points);
  });

  it("caches totals and only recomputes when stale", async () => {
    const fx = await seasonLeague(db, 2);
    const p1 = await period(fx, P1);
    const m = await matchup(fx, p1.id, 0, 1);
    await rosterPlayer(db, fx, 0, 1);
    await scoredGame(1, new Date("2026-10-20T23:00:00Z"), [{ id: 1, nba: 1 }]);
    const first = await getMatchupTotals(db, m.id, MID_P1);
    expect(first.home.points).toBe(24);
    await db.update(playerGameStats).set({ pts: 40 }).where(eq(playerGameStats.gameId, 1));
    const cached = await getMatchupTotals(db, m.id, new Date(MID_P1.getTime() + 30_000));
    expect(cached.home.points).toBe(24);
    const fresh = await getMatchupTotals(db, m.id, new Date(MID_P1.getTime() + 61_000));
    expect(fresh.home.points).toBe(44);
    expect(await db.select().from(matchupTeamTotals).where(eq(matchupTeamTotals.matchupId, m.id))).toHaveLength(2);
  });

  it("getCurrentPeriod finds the period containing today (ET)", async () => {
    const fx = await seasonLeague(db, 2);
    const p1 = await period(fx, P1);
    await period(fx, P2);
    expect((await getCurrentPeriod(db, fx.league.id, new Date("2026-10-26T02:30:00Z")))?.id).toBe(p1.id); // Sunday 10:30pm ET
    expect((await getCurrentPeriod(db, fx.league.id, new Date("2026-10-26T04:30:00Z")))?.number).toBe(2);
    expect(await getCurrentPeriod(db, fx.league.id, new Date("2026-12-01T12:00:00Z"))).toBeNull();
  });
});

describe("finalizePeriod", () => {
  async function twoTeamFinal() {
    const fx = await seasonLeague(db, 2);
    const p1 = await period(fx, P1);
    const m = await matchup(fx, p1.id, 0, 1);
    await rosterPlayer(db, fx, 0, 1); // NBA team 1 (winner)
    await rosterPlayer(db, fx, 1, 2); // NBA team 2 (loser)
    await scoredGame(1, new Date("2026-10-20T23:00:00Z"), [
      { id: 1, nba: 1, pts: 20 },
      { id: 2, nba: 2, pts: 30 },
    ]);
    return { fx, p1, m };
  }

  it("waits for the period to end and for every NBA game to be final", async () => {
    const { fx, p1, m } = await twoTeamFinal();
    expect(await finalizePeriod(db, fx.league.id, p1.id, MID_P1)).toEqual({ status: "not_ready", reason: "not_over" });
    await insertGame(db, 9, new Date("2026-10-25T23:00:00Z"), "in", 5, 6, [10, 10]);
    expect(await finalizePeriod(db, fx.league.id, p1.id, AFTER_P1)).toEqual({ status: "not_ready", reason: "games_pending" });
    await db.update(nbaGames).set({ status: "final", homeScore: 90, awayScore: 80 }).where(eq(nbaGames.id, 9));
    const r = await finalizePeriod(db, fx.league.id, p1.id, AFTER_P1);
    expect(r.status).toBe("finalized");
    const [row] = await db.select().from(matchups).where(eq(matchups.id, m.id));
    expect(row.status).toBe("final");
  });

  it("sets winner, points, status and standings, and notifies owners once", async () => {
    const { fx, p1, m } = await twoTeamFinal();
    const cap = captureNotifier();
    const r = await finalizePeriod(db, fx.league.id, p1.id, AFTER_P1, cap.deps);
    expect(r).toMatchObject({ status: "finalized", matchups: 1, changed: 1 });
    const [row] = await db.select().from(matchups).where(eq(matchups.id, m.id));
    expect(row).toMatchObject({ status: "final", homePoints: 24, awayPoints: 30, winnerTeamId: fx.teams[1].id });
    // Standings cache
    const table = await db.select().from(standings).where(eq(standings.leagueId, fx.league.id));
    expect(table).toHaveLength(2);
    const winner = table.find((t) => t.teamId === fx.teams[1].id)!;
    expect([winner.wins, winner.losses, winner.rank, winner.streak]).toEqual([1, 0, 1, "W1"]);
    const read = await getStandings(db, fx.league.id);
    expect(read.map((s) => s.teamId)).toEqual([fx.teams[1].id, fx.teams[0].id]);
    // Notifications
    expect(cap.calls).toHaveLength(2);
    const bodies = new Map(cap.calls.map((c) => [c.userIds[0], c]));
    const homeOwner = bodies.get(fx.teams[0].ownerId)!;
    expect(homeOwner.type).toBe("matchup_results");
    expect(homeOwner.body).toBe(`You lost 24-30 vs ${fx.teams[1].name}`);
    expect(bodies.get(fx.teams[1].ownerId)!.body).toBe(`You won 30-24 vs ${fx.teams[0].name}`);
    expect(homeOwner.url).toBe(`/leagues/${fx.league.id}/matchup/${m.id}`);
  });

  it("is idempotent: finalizing again changes and notifies nothing", async () => {
    const { fx, p1, m } = await twoTeamFinal();
    const cap = captureNotifier();
    await finalizePeriod(db, fx.league.id, p1.id, AFTER_P1, cap.deps);
    const again = await finalizePeriod(db, fx.league.id, p1.id, new Date(AFTER_P1.getTime() + 3_600_000), cap.deps);
    expect(again).toMatchObject({ status: "refinalized", changed: 0 });
    expect(cap.calls).toHaveLength(2);
    expect(await db.select().from(standings)).toHaveLength(2);
    const [row] = await db.select().from(matchups).where(eq(matchups.id, m.id));
    expect(row.winnerTeamId).toBe(fx.teams[1].id);
  });

  it("recomputes after a stat correction (winner can flip) without re-notifying", async () => {
    const { fx, p1, m } = await twoTeamFinal();
    const cap = captureNotifier();
    await finalizePeriod(db, fx.league.id, p1.id, AFTER_P1, cap.deps);
    await db.update(playerGameStats).set({ pts: 20 }).where(and(eq(playerGameStats.gameId, 1), eq(playerGameStats.playerId, 2)));
    const r = await finalizePeriod(db, fx.league.id, p1.id, new Date(AFTER_P1.getTime() + 86_400_000), cap.deps);
    expect(r).toMatchObject({ status: "refinalized", changed: 1 });
    const [row] = await db.select().from(matchups).where(eq(matchups.id, m.id));
    expect(row).toMatchObject({ homePoints: 24, awayPoints: 20, winnerTeamId: fx.teams[0].id });
    const [home] = await db.select().from(standings).where(eq(standings.teamId, fx.teams[0].id));
    expect([home.wins, home.losses]).toEqual([1, 0]);
    expect(cap.calls).toHaveLength(2);
  });

  it("records ties and leaves byes without a winner or any W/L", async () => {
    const fx = await seasonLeague(db, 3);
    const p1 = await period(fx, P1);
    const m = await matchup(fx, p1.id, 0, 1);
    const bye = await matchup(fx, p1.id, 2, null);
    await rosterPlayer(db, fx, 0, 2);
    await rosterPlayer(db, fx, 1, 4);
    await rosterPlayer(db, fx, 2, 6);
    await scoredGame(1, new Date("2026-10-20T23:00:00Z"), [
      { id: 2, nba: 2, pts: 25 },
      { id: 4, nba: 4, pts: 25 },
      { id: 6, nba: 6, pts: 99 },
    ]);
    const cap = captureNotifier();
    await finalizePeriod(db, fx.league.id, p1.id, AFTER_P1, cap.deps);
    const [tie] = await db.select().from(matchups).where(eq(matchups.id, m.id));
    expect(tie).toMatchObject({ status: "final", winnerTeamId: null, homePoints: 25, awayPoints: 25 });
    const [b] = await db.select().from(matchups).where(eq(matchups.id, bye.id));
    expect(b).toMatchObject({ status: "final", winnerTeamId: null, awayPoints: null });
    const table = await getStandings(db, fx.league.id);
    const byeTeam = table.find((s) => s.teamId === fx.teams[2].id)!;
    expect([byeTeam.wins, byeTeam.losses, byeTeam.ties, byeTeam.pointsFor]).toEqual([0, 0, 0, 0]);
    const tied = table.find((s) => s.teamId === fx.teams[0].id)!;
    expect([tied.wins, tied.losses, tied.ties, tied.streak]).toEqual([0, 0, 1, "T1"]);
    expect(cap.calls).toHaveLength(2); // no notification for the bye
    expect(cap.calls[0].body).toContain("tied 25-25");
  });
});

describe("standings with head-to-head tiebreaks (DB)", () => {
  it("falls through a 3-way head-to-head cycle to points for", async () => {
    const fx = await seasonLeague(db, 3);
    // T0 beats T1, T1 beats T2, T2 beats T0: everyone is 1-1 and 1-1 head to head, so points for decides.
    const plan: [typeof P1, number, number, number, number][] = [
      [{ number: 1, startDate: "2026-10-19", endDate: "2026-10-25" }, 0, 1, 30, 20],
      [{ number: 2, startDate: "2026-10-26", endDate: "2026-11-01" }, 1, 2, 30, 20],
      [{ number: 3, startDate: "2026-11-02", endDate: "2026-11-08" }, 2, 0, 200, 10],
    ];
    for (const [p, home, away, hp, ap] of plan) {
      const per = await period(fx, p);
      await matchup(fx, per.id, home, away);
      await db
        .update(matchups)
        .set({ status: "final", homePoints: hp, awayPoints: ap, winnerTeamId: fx.teams[hp > ap ? home : away].id })
        .where(eq(matchups.periodId, per.id));
    }
    const rows = await refreshStandings(db, fx.league.id);
    // PF: T0 30+10=40, T1 20+30=50, T2 20+200=220 -> T2, T1, T0
    expect(rows.map((r) => r.teamId)).toEqual([fx.teams[2].id, fx.teams[1].id, fx.teams[0].id]);
  });
});

describe("nightly cron hook", () => {
  it("finalizes ended periods only after all their games are final, and skips leagues not in season", async () => {
    const fx = await seasonLeague(db, 2);
    const p1 = await period(fx, P1);
    const p2 = await period(fx, P2);
    const m1 = await matchup(fx, p1.id, 0, 1);
    const m2 = await matchup(fx, p2.id, 0, 1);
    await rosterPlayer(db, fx, 0, 1);
    await scoredGame(1, new Date("2026-10-20T23:00:00Z"), [{ id: 1, nba: 1 }]);
    await insertGame(db, 2, new Date("2026-10-31T23:00:00Z"), "scheduled", 1, 2); // period 2 not over

    const cap = captureNotifier();
    const night1 = await runNightlyMatchupJob(db, AFTER_P1, cap.deps);
    expect(night1).toMatchObject({ leagues: 1, finalized: 1, pending: 0 });
    expect((await db.select().from(matchups).where(eq(matchups.id, m1.id)))[0].status).toBe("final");
    expect((await db.select().from(matchups).where(eq(matchups.id, m2.id)))[0].status).not.toBe("final");

    // Period 1 gets a late straggler game still in progress after its last day: not final yet.
    const fx2 = await seasonLeague(db, 2);
    const q1 = await period(fx2, P1);
    const qm = await matchup(fx2, q1.id, 0, 1);
    await insertGame(db, 3, new Date("2026-10-25T23:30:00Z"), "in", 5, 6, [50, 50]);
    const night2 = await runNightlyMatchupJob(db, AFTER_P1, cap.deps);
    expect(night2.pending).toBe(1);
    expect((await db.select().from(matchups).where(eq(matchups.id, qm.id)))[0].status).not.toBe("final");

    // Once the straggler is final the next night finalizes it.
    await db.update(nbaGames).set({ status: "final", homeScore: 100, awayScore: 90 }).where(eq(nbaGames.id, 3));
    const night3 = await runNightlyMatchupJob(db, new Date(AFTER_P1.getTime() + 86_400_000), cap.deps);
    expect(night3.finalized).toBe(1);
    expect((await db.select().from(matchups).where(eq(matchups.id, qm.id)))[0].status).toBe("final");

    // A league that is not in season is skipped.
    await db.update(leagues).set({ status: "setup" }).where(eq(leagues.id, fx2.league.id));
    await db.update(matchups).set({ status: "scheduled" }).where(eq(matchups.id, qm.id));
    const night4 = await runNightlyMatchupJob(db, new Date(AFTER_P1.getTime() + 2 * 86_400_000), cap.deps);
    expect((await db.select().from(matchups).where(eq(matchups.id, qm.id)))[0].status).toBe("scheduled");
    expect(night4.leagues).toBe(1);
  });

  it("sends nothing the second night and notifications land with the right type", async () => {
    const fx = await seasonLeague(db, 2);
    const p1 = await period(fx, P1);
    await matchup(fx, p1.id, 0, 1);
    await rosterPlayer(db, fx, 0, 1);
    await scoredGame(1, new Date("2026-10-20T23:00:00Z"), [{ id: 1, nba: 1 }]);
    // real notify(): in-app rows for both owners (default prefs on)
    await runNightlyMatchupJob(db, AFTER_P1);
    await runNightlyMatchupJob(db, new Date(AFTER_P1.getTime() + 86_400_000));
    const rows = await db.select().from(notifications).where(eq(notifications.type, "matchup_results"));
    expect(rows).toHaveLength(2);
  });
});
