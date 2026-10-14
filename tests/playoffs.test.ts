import { and, asc, eq, isNotNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leagues, matchups, notifications, playerGameStats, playoffSlots, seasonResults } from "@/db/schema";
import type { Db } from "@/db/types";
import { runNightlyMatchupJob } from "@/lib/matchups/service";
import { PlayoffError, getBracket, overridePlayoffWinner, reseedPlayoffs } from "@/lib/playoffs/service";
import { createTestDb } from "./helpers/db";
import { captureNotifier, seedPlayers } from "./helpers/draft";
import { insertGame } from "./helpers/rosters";
import { planSeason, type SeasonPlan } from "./helpers/playoffs";

let db: Db;
let close: () => Promise<void> | void;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await seedPlayers(db, 12); // player i plays for NBA team i
});
afterEach(async () => {
  await close();
});

const idxOf = (plan: SeasonPlan, id: string | null) => (id ? plan.fx.teams.findIndex((t) => t.id === id) : null);

/** [round, slot, teamA index, teamB index, winner index] for every slot. */
async function bracket(plan: SeasonPlan) {
  const rows = await db
    .select()
    .from(playoffSlots)
    .where(eq(playoffSlots.leagueId, plan.fx.league.id))
    .orderBy(asc(playoffSlots.round), asc(playoffSlots.slot));
  return rows.map((s) => [s.round, s.slot, idxOf(plan, s.teamAId), idxOf(plan, s.teamBId), idxOf(plan, s.winnerTeamId)]);
}

const playoffMatchups = (plan: SeasonPlan) =>
  db
    .select()
    .from(matchups)
    .where(and(eq(matchups.leagueId, plan.fx.league.id), isNotNull(matchups.playoffSlotId)));

const leagueStatus = async (plan: SeasonPlan) =>
  (await db.select().from(leagues).where(eq(leagues.id, plan.fx.league.id)))[0].status;

const slot = async (plan: SeasonPlan, round: number, n: number) =>
  (await db.select().from(playoffSlots).where(and(eq(playoffSlots.leagueId, plan.fx.league.id), eq(playoffSlots.round, round), eq(playoffSlots.slot, n))))[0];

describe("seeding", () => {
  it("does nothing until every regular-season matchup is final", async () => {
    const plan = await planSeason(db, { teams: 4, playoffTeams: 4 });
    const r = await runNightlyMatchupJob(db, plan.after(plan.regular - 1));
    expect(r.playoffsSeeded).toBe(0);
    expect(await bracket(plan)).toEqual([]);
    expect(await leagueStatus(plan)).toBe("in_season");
  });

  it("seeds 4 teams from the final standings: 1v4 and 2v3, better seed at home, owners told", async () => {
    const plan = await planSeason(db, { teams: 4, playoffTeams: 4 });
    const cap = captureNotifier();
    const r = await runNightlyMatchupJob(db, plan.after(plan.regular), cap.deps);
    expect(r).toMatchObject({ errors: [], finalized: plan.regular, playoffsSeeded: 1, playoffMatchups: 2 });
    expect(await leagueStatus(plan)).toBe("playoffs");
    expect(await bracket(plan)).toEqual([
      [1, 0, 0, 3, null],
      [1, 1, 1, 2, null],
      [2, 0, null, null, null],
    ]);
    const ms = await playoffMatchups(plan);
    expect(ms).toHaveLength(2);
    const [a] = ms.filter((m) => m.homeTeamId === plan.fx.teams[0].id);
    expect(a.awayTeamId).toBe(plan.fx.teams[3].id);
    const seedNotes = cap.calls.filter((c) => c.type === "league_events");
    expect(seedNotes).toHaveLength(4);
    expect(seedNotes.find((c) => c.userIds[0] === plan.fx.teams[2].ownerId)?.body).toContain("#3 seed");
  });

  it("2 teams: a single final", async () => {
    const plan = await planSeason(db, { teams: 2, playoffTeams: 2 });
    await runNightlyMatchupJob(db, plan.after(plan.regular));
    expect(await bracket(plan)).toEqual([[1, 0, 0, 1, null]]);
    expect(await playoffMatchups(plan)).toHaveLength(1);
  });

  it("6 teams: seeds 1 and 2 bypass round 1 (no matchup rows) and wait for the 4/5 and 3/6 winners", async () => {
    const plan = await planSeason(db, { teams: 6, playoffTeams: 6 });
    await runNightlyMatchupJob(db, plan.after(plan.regular));
    expect(await bracket(plan)).toEqual([
      [1, 0, 0, null, 0], // seed 1: bye, advances at once
      [1, 1, 3, 4, null],
      [1, 2, 1, null, 1], // seed 2: bye
      [1, 3, 2, 5, null],
      [2, 0, 0, null, null], // seed 1 already waiting for the 4/5 winner
      [2, 1, 1, null, null],
      [3, 0, null, null, null],
    ]);
    const ms = await playoffMatchups(plan);
    expect(ms).toHaveLength(2); // only 4v5 and 3v6 are played
    expect(ms.some((m) => m.homeTeamId === plan.fx.teams[0].id)).toBe(false);
    expect(await leagueStatus(plan)).toBe("playoffs");
  });

  it("8 teams: 1v8, 4v5, 2v7, 3v6", async () => {
    const plan = await planSeason(db, { teams: 8, playoffTeams: 8 });
    await runNightlyMatchupJob(db, plan.after(plan.regular));
    expect((await bracket(plan)).filter((b) => b[0] === 1)).toEqual([
      [1, 0, 0, 7, null],
      [1, 1, 3, 4, null],
      [1, 2, 1, 6, null],
      [1, 3, 2, 5, null],
    ]);
    expect(await playoffMatchups(plan)).toHaveLength(4);
  });

  it("with fewer playoff teams than teams, the others miss the playoffs and play nothing", async () => {
    const plan = await planSeason(db, { teams: 6, playoffTeams: 4 });
    await runNightlyMatchupJob(db, plan.after(plan.regular));
    const playing = new Set((await playoffMatchups(plan)).flatMap((m) => [m.homeTeamId, m.awayTeamId]));
    expect([...playing].map((id) => idxOf(plan, id)).sort()).toEqual([0, 1, 2, 3]);
  });
});

describe("advancement and completion", () => {
  it("decides round 1, fills the final, then crowns the champion and completes the league", async () => {
    const plan = await planSeason(db, { teams: 4, playoffTeams: 4 });
    const cap = captureNotifier();
    await runNightlyMatchupJob(db, plan.after(plan.regular), cap.deps);

    const r2 = await runNightlyMatchupJob(db, plan.after(plan.regular + 1), cap.deps);
    expect(r2).toMatchObject({ errors: [], playoffGamesDecided: 2, playoffMatchups: 1, leaguesCompleted: 0 });
    expect(await bracket(plan)).toEqual([
      [1, 0, 0, 3, 0],
      [1, 1, 1, 2, 1],
      [2, 0, 0, 1, null],
    ]);
    expect(await leagueStatus(plan)).toBe("playoffs");

    const r3 = await runNightlyMatchupJob(db, plan.after(plan.regular + 2), cap.deps);
    expect(r3).toMatchObject({ errors: [], playoffGamesDecided: 1, leaguesCompleted: 1 });
    expect(await leagueStatus(plan)).toBe("complete");
    expect((await bracket(plan))[2]).toEqual([2, 0, 0, 1, 0]);

    const champs = cap.calls.filter((c) => c.title.endsWith("champions"));
    expect(champs).toHaveLength(1);
    expect(champs[0]).toMatchObject({ type: "league_events", body: `${plan.fx.teams[0].name} are champions!` });
    expect(champs[0].userIds.sort()).toEqual(plan.fx.teams.map((t) => t.ownerId).sort());

    const results = await db.select().from(seasonResults).where(eq(seasonResults.leagueId, plan.fx.league.id)).orderBy(asc(seasonResults.finalRank));
    expect(results.map((x) => [x.finalRank, idxOf(plan, x.teamId), x.playoffResult])).toEqual([
      [1, 0, "champion"],
      [2, 1, "runner_up"],
      [3, 2, "semifinal"],
      [4, 3, "semifinal"],
    ]);
    expect(results[0]).toMatchObject({ wins: 3, losses: 0, ownerUserId: plan.fx.teams[0].ownerId, teamName: plan.fx.teams[0].name });
    expect(results[3].losses).toBe(3);

    // A complete league isn't processed any more.
    const again = await runNightlyMatchupJob(db, plan.after(plan.regular + 3), cap.deps);
    expect(again.leagues).toBe(0);
  });

  it("6 teams: byes advance, the 4/5 and 3/6 winners meet seeds 1 and 2, and results rank the exits", async () => {
    const plan = await planSeason(db, { teams: 6, playoffTeams: 6 });
    for (let n = plan.regular; n <= plan.regular + 3; n++) await runNightlyMatchupJob(db, plan.after(n));
    expect(await leagueStatus(plan)).toBe("complete");
    expect(await bracket(plan)).toEqual([
      [1, 0, 0, null, 0],
      [1, 1, 3, 4, 3],
      [1, 2, 1, null, 1],
      [1, 3, 2, 5, 2],
      [2, 0, 0, 3, 0],
      [2, 1, 1, 2, 1],
      [3, 0, 0, 1, 0],
    ]);
    const results = await db.select().from(seasonResults).where(eq(seasonResults.leagueId, plan.fx.league.id)).orderBy(asc(seasonResults.finalRank));
    expect(results.map((x) => [idxOf(plan, x.teamId), x.playoffResult])).toEqual([
      [0, "champion"],
      [1, "runner_up"],
      [2, "semifinal"],
      [3, "semifinal"],
      [4, "quarterfinal"],
      [5, "quarterfinal"],
    ]);
  });

  it("a 2-period round is decided on the combined points of both periods", async () => {
    // Team 3 beats team 0 in the first period, but team 0 wins the second by far more.
    const pts = (w: number, i: number) => {
      if (w === 4 && i === 0) return 10;
      if (w === 4 && i === 3) return 100;
      if (w === 5 && i === 0) return 200;
      if (w === 5 && i === 3) return 10;
      return 100 - 10 * i;
    };
    const plan = await planSeason(db, { teams: 4, playoffTeams: 4, roundLength: 2, pts });
    expect(plan.regular).toBe(3);
    await runNightlyMatchupJob(db, plan.after(3));
    const legs = (await playoffMatchups(plan)).filter((m) => m.homeTeamId === plan.fx.teams[0].id);
    expect(legs).toHaveLength(2); // one matchup per period of the round
    expect((await bracket(plan))[0]).toEqual([1, 0, 0, 3, null]);

    await runNightlyMatchupJob(db, plan.after(4));
    expect((await bracket(plan))[0]).toEqual([1, 0, 0, 3, null]); // second period still to play
    const afterFirst = await playoffMatchups(plan);
    expect(afterFirst.filter((m) => m.status === "final")).toHaveLength(2); // both slots' first legs

    const r = await runNightlyMatchupJob(db, plan.after(5));
    expect(r.playoffGamesDecided).toBe(2);
    expect((await bracket(plan))[0]).toEqual([1, 0, 0, 3, 0]); // 14+204 vs 100+10
    expect((await playoffMatchups(plan)).filter((m) => m.homeTeamId === plan.fx.teams[0].id && m.awayTeamId === plan.fx.teams[1].id)).toHaveLength(2);
    const view = await getBracket(db, plan.fx.league.id, plan.after(5));
    expect(view.rounds[0].slots[0]).toMatchObject({ scoreA: 218, scoreB: 110 });
    expect(view.rounds[0].slots[0].legs).toHaveLength(2);
  });

  it("an exact tie goes to the higher seed", async () => {
    // Round-1 week (4): both sides total 50 (the odd NBA team earns +4 as the winner).
    const pts = (w: number, i: number) => (w === 4 ? (i % 2 === 0 ? 46 : 50) : 100 - 10 * i);
    const plan = await planSeason(db, { teams: 4, playoffTeams: 4, pts });
    await runNightlyMatchupJob(db, plan.after(3));
    await runNightlyMatchupJob(db, plan.after(4));
    expect((await bracket(plan)).slice(0, 2)).toEqual([
      [1, 0, 0, 3, 0], // seed 1 over seed 4
      [1, 1, 1, 2, 1], // seed 2 over seed 3
    ]);
    const [m] = (await playoffMatchups(plan)).filter((x) => x.homeTeamId === plan.fx.teams[0].id);
    expect(m.winnerTeamId).toBeNull(); // the matchup itself is a tie
  });
});

describe("idempotency and corrections", () => {
  it("running the job again creates no matchups, notifications or duplicate rows", async () => {
    const plan = await planSeason(db, { teams: 4, playoffTeams: 4 });
    const cap = captureNotifier();
    const at = plan.after(plan.regular + 1);
    await runNightlyMatchupJob(db, plan.after(plan.regular), cap.deps);
    await runNightlyMatchupJob(db, at, cap.deps);
    const before = { m: (await playoffMatchups(plan)).length, s: (await bracket(plan)).length, n: cap.calls.length };
    const again = await runNightlyMatchupJob(db, at, cap.deps);
    expect(again).toMatchObject({ playoffsSeeded: 0, playoffMatchups: 0, playoffGamesDecided: 0, errors: [] });
    expect({ m: (await playoffMatchups(plan)).length, s: (await bracket(plan)).length, n: cap.calls.length }).toEqual(before);
    expect(before.m).toBe(3);
  });

  it("a stat correction that flips round 1 after round 2 started warns and leaves the bracket alone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const plan = await planSeason(db, { teams: 4, playoffTeams: 4 });
    const at = plan.after(plan.regular + 1);
    await runNightlyMatchupJob(db, plan.after(plan.regular));
    await runNightlyMatchupJob(db, at);
    const before = await playoffMatchups(plan);
    expect(before).toHaveLength(3);

    // Team 0's player scores nothing in round 1 after all: team 3 would win that slot.
    await db.update(playerGameStats).set({ pts: 0 }).where(eq(playerGameStats.playerId, 1));
    const r = await runNightlyMatchupJob(db, new Date(at.getTime() + 86_400_000));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    expect(await playoffMatchups(plan)).toHaveLength(3); // nothing duplicated
    expect((await bracket(plan))[0]).toEqual([1, 0, 0, 3, 0]); // winner unchanged, for the commissioner to fix
    expect((await bracket(plan))[2]).toEqual([2, 0, 0, 1, null]);
    warn.mockRestore();
  });
});

describe("commissioner tools", () => {
  const commissioner = (plan: SeasonPlan) => ({ id: plan.fx.admin.id });

  it("re-seeds from the current standings, only before round 1 starts", async () => {
    const plan = await planSeason(db, { teams: 4, playoffTeams: 4 });
    const at = plan.after(plan.regular);
    await runNightlyMatchupJob(db, at);
    const first = await bracket(plan);
    expect(first[0]).toEqual([1, 0, 0, 3, null]);

    // A data fix: team 3 actually beat team 2 in week 1, which changes the standings.
    const reg = await db.select().from(matchups).where(eq(matchups.status, "final"));
    const wk = reg.find((m) => [m.homeTeamId, m.awayTeamId].every((t) => t === plan.fx.teams[2].id || t === plan.fx.teams[3].id));
    expect(wk).toBeTruthy();
    await db
      .update(matchups)
      .set({ winnerTeamId: plan.fx.teams[3].id, homePoints: wk!.homeTeamId === plan.fx.teams[3].id ? 500 : 1, awayPoints: wk!.homeTeamId === plan.fx.teams[3].id ? 1 : 500 })
      .where(eq(matchups.id, wk!.id));

    const stranger = { id: plan.fx.teams[1].ownerId };
    await expect(reseedPlayoffs(db, stranger, plan.fx.league.id, at)).rejects.toMatchObject({ code: "forbidden" });
    const seeded = await reseedPlayoffs(db, commissioner(plan), plan.fx.league.id, at);
    expect(seeded).toHaveLength(4);
    const second = await bracket(plan);
    expect(second).not.toEqual(first);
    expect(await playoffMatchups(plan)).toHaveLength(2); // rebuilt, not duplicated
    // 1v4 and 2v3 of the NEW standings
    const order = seeded.map((s) => idxOf(plan, s.teamId));
    expect(second.slice(0, 2)).toEqual([
      [1, 0, order[0], order[3], null],
      [1, 1, order[1], order[2], null],
    ]);

    // Once an NBA game of round 1 has tipped off it is too late.
    const thursday = new Date(`${plan.periodStart(plan.regular + 1)}T12:00:00Z`);
    thursday.setUTCDate(thursday.getUTCDate() + 3);
    await insertGame(db, 5000, new Date(thursday.getTime() - 3_600_000), "final", 9, 10);
    await expect(reseedPlayoffs(db, commissioner(plan), plan.fx.league.id, thursday)).rejects.toMatchObject({ code: "round_started" });
  });

  it("refuses to re-seed once a round-1 matchup is final", async () => {
    const plan = await planSeason(db, { teams: 4, playoffTeams: 4 });
    await runNightlyMatchupJob(db, plan.after(plan.regular));
    await runNightlyMatchupJob(db, plan.after(plan.regular + 1));
    await expect(reseedPlayoffs(db, commissioner(plan), plan.fx.league.id, plan.after(plan.regular + 1))).rejects.toBeInstanceOf(PlayoffError);
  });

  it("overrides a winner (logged), moves it forward, and the nightly job leaves it alone", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const plan = await planSeason(db, { teams: 4, playoffTeams: 4 });
    await runNightlyMatchupJob(db, plan.after(plan.regular));
    const s0 = await slot(plan, 1, 0);
    const t3 = plan.fx.teams[3].id;
    const t0 = plan.fx.teams[0].id;

    await expect(overridePlayoffWinner(db, { id: plan.fx.teams[1].ownerId }, s0.id, t3)).rejects.toMatchObject({ code: "forbidden" });
    await expect(overridePlayoffWinner(db, commissioner(plan), s0.id, plan.fx.teams[2].id)).rejects.toMatchObject({ code: "invalid_input" });
    const final0 = await slot(plan, 2, 0);
    await expect(overridePlayoffWinner(db, commissioner(plan), final0.id, t3)).rejects.toMatchObject({ code: "invalid_input" }); // no teams yet

    const done = await overridePlayoffWinner(db, commissioner(plan), s0.id, t3, "Box score was wrong");
    expect(done).toMatchObject({ winnerTeamId: t3, overridden: true, overriddenBy: plan.fx.admin.id, overrideNote: "Box score was wrong" });
    expect(done.overriddenAt).toBeInstanceOf(Date);
    expect((await slot(plan, 2, 0)).teamAId).toBe(t3);
    expect((await slot(plan, 2, 0)).seedA).toBe(4);

    // Round 1 plays out: the overridden slot keeps its override even though team 0 outscored team 3.
    await runNightlyMatchupJob(db, plan.after(plan.regular + 1));
    expect((await bracket(plan))[0]).toEqual([1, 0, 0, 3, 3]);
    expect((await bracket(plan))[2]).toEqual([2, 0, 3, 1, null]);
    const finalMatchups = (await playoffMatchups(plan)).filter((m) => m.playoffSlotId === final0.id);
    expect(finalMatchups).toHaveLength(1);
    expect(finalMatchups[0].homeTeamId).toBe(plan.fx.teams[1].id); // seed 2 hosts seed 4

    // Changing it back while the final is unplayed rebuilds that matchup.
    await overridePlayoffWinner(db, commissioner(plan), s0.id, t0);
    const rebuilt = (await playoffMatchups(plan)).filter((m) => m.playoffSlotId === final0.id);
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0].id).not.toBe(finalMatchups[0].id);
    expect(rebuilt[0].homeTeamId).toBe(t0);
  });

  it("refuses to override under a decided next round, and a final override rewrites the results", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const plan = await planSeason(db, { teams: 4, playoffTeams: 4 });
    const cap = captureNotifier();
    for (let n = plan.regular; n <= plan.regular + 2; n++) await runNightlyMatchupJob(db, plan.after(n), cap.deps);
    expect(await leagueStatus(plan)).toBe("complete");

    const s0 = await slot(plan, 1, 0);
    await expect(overridePlayoffWinner(db, commissioner(plan), s0.id, plan.fx.teams[3].id)).rejects.toMatchObject({ code: "downstream_started" });

    const final = await slot(plan, 2, 0);
    await overridePlayoffWinner(db, commissioner(plan), final.id, plan.fx.teams[1].id, "Late stat fix");
    const champion = await db.select().from(seasonResults).where(and(eq(seasonResults.leagueId, plan.fx.league.id), eq(seasonResults.playoffResult, "champion")));
    expect(champion.map((c) => c.teamId)).toEqual([plan.fx.teams[1].id]);
    expect(cap.calls.filter((c) => c.title.endsWith("champions"))).toHaveLength(1); // no second announcement
  });

  it("completes the league when the commissioner decides the final by hand", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const plan = await planSeason(db, { teams: 2, playoffTeams: 2 });
    const cap = captureNotifier();
    await runNightlyMatchupJob(db, plan.after(plan.regular), cap.deps);
    const final = await slot(plan, 1, 0);
    await overridePlayoffWinner(db, commissioner(plan), final.id, plan.fx.teams[1].id, "Forfeit", plan.after(plan.regular), cap.deps);
    expect(await leagueStatus(plan)).toBe("complete");
    expect(cap.calls.some((c) => c.body === `${plan.fx.teams[1].name} are champions!`)).toBe(true);
  });
});

describe("notifications", () => {
  it("writes league_events rows through the real notifier (in-app on by default)", async () => {
    const plan = await planSeason(db, { teams: 2, playoffTeams: 2 });
    await runNightlyMatchupJob(db, plan.after(plan.regular));
    await runNightlyMatchupJob(db, plan.after(plan.regular + 1));
    const rows = await db.select().from(notifications).where(eq(notifications.type, "league_events"));
    expect(rows.filter((r) => r.body.endsWith("are champions!"))).toHaveLength(2); // one per owner
    expect(rows.filter((r) => r.title === "You made the playoffs")).toHaveLength(2);
  });
});

