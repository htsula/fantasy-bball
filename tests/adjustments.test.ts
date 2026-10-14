import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, matchupPeriods, matchups, playoffSlots, type Matchup } from "@/db/schema";
import type { Db } from "@/db/types";
import {
  MatchupError,
  adjustMatchupScore,
  computeMatchupTotals,
  finalizePeriod,
  getStandings,
  listMatchupAdjustments,
  runNightlyMatchupJob,
} from "@/lib/matchups/service";
import { getMatchupBoxScore } from "@/lib/matchups/box-score";
import { createTestDb } from "./helpers/db";
import { captureNotifier, seedPlayers } from "./helpers/draft";
import { planSeason, type SeasonPlan } from "./helpers/playoffs";

let db: Db;
let close: () => Promise<void> | void;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await seedPlayers(db, 12);
});
afterEach(async () => {
  await close();
});

const commissioner = (plan: SeasonPlan) => ({ id: plan.fx.admin.id });
const teamBy = (plan: SeasonPlan, i: number) => plan.fx.teams[i];

/** The matchup of period `n` that involves both team indexes. */
async function matchupOf(plan: SeasonPlan, n: number, a: number, b: number): Promise<Matchup> {
  const [p] = await db
    .select()
    .from(matchupPeriods)
    .where(and(eq(matchupPeriods.leagueId, plan.fx.league.id), eq(matchupPeriods.number, n)));
  const rows = await db.select().from(matchups).where(eq(matchups.periodId, p.id));
  const ids = [teamBy(plan, a).id, teamBy(plan, b).id];
  const m = rows.find((r) => ids.includes(r.homeTeamId!) && ids.includes(r.awayTeamId!));
  if (!m) throw new Error("no such matchup");
  return m;
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (err) {
    if (err instanceof MatchupError) return err.code;
    throw err;
  }
};

/** Finds a regular-season period where teams a and b meet (round robin: once). */
async function meeting(plan: SeasonPlan, a: number, b: number) {
  for (let n = 1; n <= plan.regular; n++) {
    try {
      return { n, m: await matchupOf(plan, n, a, b) };
    } catch {
      /* not this week */
    }
  }
  throw new Error("never meet");
}

describe("adjustments on a live matchup", () => {
  it("count in the totals (cached and recomputed), are listed, and show up in the box score", async () => {
    const plan = await planSeason(db, { teams: 4, playoffTeams: 4 });
    const { n, m } = await meeting(plan, 0, 1);
    const now = plan.after(n - 1);
    const base = await computeMatchupTotals(db, m.id, now);
    const t0 = teamBy(plan, 1); // a member (the commissioner is never notified about himself)
    const homePts = (t: typeof base) => (t.home.teamId === t0.id ? t.home.points : t.away!.points);

    const n1 = captureNotifier();
    const res = await adjustMatchupScore(db, commissioner(plan), m.id, t0.id, 25.5, "  Stat correction  ", { notify: n1.notify, now });
    expect(res.warnings).toEqual([]);
    expect(res.adjustment).toMatchObject({ points: 25.5, reason: "Stat correction" });

    const after = await computeMatchupTotals(db, m.id, now);
    expect(homePts(after)).toBeCloseTo(homePts(base) + 25.5, 5);
    // Negative adjustments stack.
    await adjustMatchupScore(db, commissioner(plan), m.id, t0.id, -5, "Illegal add", { notify: n1.notify, now: new Date(now.getTime() + 1000) });
    expect(homePts(await computeMatchupTotals(db, m.id, now))).toBeCloseTo(homePts(base) + 20.5, 5);

    expect((await listMatchupAdjustments(db, m.id)).map((a) => a.points)).toEqual([25.5, -5]);
    const box = await getMatchupBoxScore(db, m.id, "total", now);
    const side = box.home.teamId === t0.id ? box.home : box.away!;
    expect(side.adjustmentTotal).toBeCloseTo(20.5, 5);
    expect(side.adjustments.map((a) => a.reason)).toEqual(["Stat correction", "Illegal add"]);
    expect(side.adjustments[0].actorUsername).toBeTruthy();

    // The affected owner is told; the log records the commissioner as actor.
    const told = n1.calls.filter((c) => c.type === "commissioner_actions");
    expect(told).toHaveLength(2);
    expect(told.every((c) => c.userIds[0] === t0.ownerId)).toBe(true);
    const log = await db.select().from(activityLog).where(eq(activityLog.type, "score_adjustment"));
    expect(log).toHaveLength(2);
    expect(log.every((l) => l.actorUserId === plan.fx.admin.id)).toBe(true);
    expect(log[0].summary).toContain("Stat correction");
  });

  it("validates input and permissions", async () => {
    const plan = await planSeason(db, { teams: 4, playoffTeams: 4 });
    const { n, m } = await meeting(plan, 1, 2);
    const now = plan.after(n - 1);
    const t1 = teamBy(plan, 1);
    const member = { id: t1.ownerId };
    const n1 = captureNotifier();
    const go = (actor: { id: string }, team: string, pts: number, reason: string) =>
      adjustMatchupScore(db, actor, m.id, team, pts, reason, { notify: n1.notify, now });
    expect(await code(go(member, t1.id, 5, "I deserve it"))).toBe("forbidden");
    expect(await code(go(commissioner(plan), teamBy(plan, 3).id, 5, "wrong team"))).toBe("invalid_input");
    expect(await code(go(commissioner(plan), t1.id, 0, "nothing"))).toBe("invalid_input");
    expect(await code(go(commissioner(plan), t1.id, Number.NaN, "nan"))).toBe("invalid_input");
    expect(await code(go(commissioner(plan), t1.id, 99999, "huge"))).toBe("invalid_input");
    expect(await code(go(commissioner(plan), t1.id, 5, "  "))).toBe("invalid_input");
    expect(await code(go(commissioner(plan), t1.id, 5, "x".repeat(301)))).toBe("invalid_input");
    expect(await code(adjustMatchupScore(db, commissioner(plan), "not-a-uuid", t1.id, 5, "reason"))).toBe("not_found");
    expect(await listMatchupAdjustments(db, m.id)).toEqual([]);
    expect(n1.calls).toHaveLength(0);
  });
});

describe("adjustments, finalization and standings", () => {
  it("an adjustment made before finalization decides the result and the standings", async () => {
    const plan = await planSeason(db, { teams: 4, playoffTeams: 4 });
    const { n, m } = await meeting(plan, 0, 3); // team 0 normally crushes team 3
    const strong = teamBy(plan, 0);
    const weak = teamBy(plan, 3);
    await adjustMatchupScore(db, commissioner(plan), m.id, weak.id, 500, "Awarded points", { notify: captureNotifier().notify, now: plan.after(n - 1) });

    const r = await finalizePeriod(db, plan.fx.league.id, m.periodId, plan.after(n), captureNotifier().deps);
    expect(r.status).toBe("finalized");
    const [row] = await db.select().from(matchups).where(eq(matchups.id, m.id));
    expect(row.winnerTeamId).toBe(weak.id);
    const standings = await getStandings(db, plan.fx.league.id);
    const weakRow = standings.find((s) => s.teamId === weak.id)!;
    expect(weakRow.wins).toBeGreaterThanOrEqual(1);
    expect(weakRow.pointsFor).toBeGreaterThan(500);
    expect(standings.find((s) => s.teamId === strong.id)!.losses).toBeGreaterThanOrEqual(1);
  });

  it("adjusting an already-final matchup rewrites the result and refreshes the standings", async () => {
    const plan = await planSeason(db, { teams: 4, playoffTeams: 4 });
    const { n, m } = await meeting(plan, 0, 3);
    const strong = teamBy(plan, 0);
    const weak = teamBy(plan, 3);
    await finalizePeriod(db, plan.fx.league.id, m.periodId, plan.after(n), captureNotifier().deps);
    expect((await db.select().from(matchups).where(eq(matchups.id, m.id)))[0].winnerTeamId).toBe(strong.id);
    const before = (await getStandings(db, plan.fx.league.id)).find((s) => s.teamId === weak.id)!;

    const res = await adjustMatchupScore(db, commissioner(plan), m.id, weak.id, 500, "Scorekeeper error", { notify: captureNotifier().notify, now: plan.after(n) });
    expect(res.warnings).toEqual([]); // not a playoff matchup and no bracket yet
    const [row] = await db.select().from(matchups).where(eq(matchups.id, m.id));
    expect(row.status).toBe("final");
    expect(row.winnerTeamId).toBe(weak.id);
    const after = (await getStandings(db, plan.fx.league.id)).find((s) => s.teamId === weak.id)!;
    expect(after.wins).toBe(before.wins + 1);
    expect(after.pointsFor).toBeGreaterThan(before.pointsFor + 499);

    // The nightly re-finalization keeps the adjustment.
    await runNightlyMatchupJob(db, plan.after(n), captureNotifier().deps);
    expect((await db.select().from(matchups).where(eq(matchups.id, m.id)))[0].winnerTeamId).toBe(weak.id);
  });
});

describe("adjustments and the playoffs", () => {
  it("before a round is final the bracket simply follows the adjusted score", async () => {
    const plan = await planSeason(db, { teams: 4, playoffTeams: 4 });
    await runNightlyMatchupJob(db, plan.after(plan.regular), captureNotifier().deps); // seeds the bracket
    const m = await matchupOf(plan, plan.regular + 1, 0, 3);
    await adjustMatchupScore(db, commissioner(plan), m.id, teamBy(plan, 3).id, 1000, "Forfeit", { notify: captureNotifier().notify, now: plan.after(plan.regular) });
    await runNightlyMatchupJob(db, plan.after(plan.regular + 1), captureNotifier().deps);
    const [slot] = await db
      .select()
      .from(playoffSlots)
      .where(and(eq(playoffSlots.leagueId, plan.fx.league.id), eq(playoffSlots.round, 1), eq(playoffSlots.slot, 0)));
    expect(slot.winnerTeamId).toBe(teamBy(plan, 3).id);
  });

  it("after the next round started it warns and leaves the advancement unchanged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const plan = await planSeason(db, { teams: 4, playoffTeams: 4 });
    await runNightlyMatchupJob(db, plan.after(plan.regular), captureNotifier().deps);
    await runNightlyMatchupJob(db, plan.after(plan.regular + 1), captureNotifier().deps);
    const m = await matchupOf(plan, plan.regular + 1, 0, 3);
    expect(m.status).toBe("final");

    const res = await adjustMatchupScore(db, commissioner(plan), m.id, teamBy(plan, 3).id, 1000, "Late fix", { notify: captureNotifier().notify, now: plan.after(plan.regular + 1) });
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatch(/next round has already started/);
    // The matchup result itself changed, the bracket did not.
    expect((await db.select().from(matchups).where(eq(matchups.id, m.id)))[0].winnerTeamId).toBe(teamBy(plan, 3).id);
    const [slot] = await db
      .select()
      .from(playoffSlots)
      .where(and(eq(playoffSlots.leagueId, plan.fx.league.id), eq(playoffSlots.round, 1), eq(playoffSlots.slot, 0)));
    expect(slot.winnerTeamId).toBe(teamBy(plan, 0).id);
    warn.mockRestore();
  });

  it("warns that seeds were not recomputed when a regular-season matchup is adjusted after seeding", async () => {
    const plan = await planSeason(db, { teams: 4, playoffTeams: 4 });
    await runNightlyMatchupJob(db, plan.after(plan.regular), captureNotifier().deps);
    const { n, m } = await meeting(plan, 0, 1);
    const res = await adjustMatchupScore(db, commissioner(plan), m.id, teamBy(plan, 1).id, 10, "Fix", { notify: captureNotifier().notify, now: plan.after(plan.regular) });
    expect(n).toBeGreaterThan(0);
    expect(res.warnings.join(" ")).toMatch(/already seeded/);
  });
});

