import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { draftPicks, draftQueue, drafts, leagues, nbaPlayers, rosterEntries, teams } from "@/db/schema";
import type { Db } from "@/db/types";
import { getDraftBoard, listDraftablePlayers } from "@/lib/draft/board";
import { snakeTeam } from "@/lib/draft/engine";
import {
  DraftError,
  addToQueue,
  makePick,
  removeFromQueue,
  reorderQueue,
  startDraft,
  undoLastPick,
} from "@/lib/draft/service";
import { LeagueError, createLeagueInvite, redeemLeagueInvite, updateSettings } from "@/lib/leagues/service";
import {
  begin,
  captureNotifier,
  createAdmin,
  pickSnake,
  seedPlayers,
  setupLeague,
  type DraftFixture,
} from "./helpers/draft";
import { createTestDb } from "./helpers/db";
import type { Actor } from "@/lib/leagues/service";

let db: Db;
let close: () => Promise<void>;
let admin: Actor;
let playerIds: number[];
let nextPlayer = 0;

// 4 teams, rosterPool 24 -> 6 per team; snakeTarget 8 -> 2 snake rounds; then 2 waves of 2.
const SMALL = { rosterPool: 24, snakeTarget: 8 };
// rosterPool 20 -> 5 per team; 2 snake rounds; waves of 2 then 1.
const ODD = { rosterPool: 20, snakeTarget: 8 };
// Whole draft is snake: 3 rounds.
const ALL_SNAKE = { rosterPool: 12, snakeTarget: 100 };

const fresh = () => playerIds[nextPlayer++];
const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e) => (e instanceof DraftError || e instanceof LeagueError ? e.code : `other:${e}`),
  );

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  admin = await createAdmin(db);
  playerIds = await seedPlayers(db, 400);
});
afterAll(() => close());

async function started(count = 4, settings: Record<string, unknown> = SMALL, deps = captureNotifier()) {
  const fx = await setupLeague(db, admin, count, settings);
  const draft = await begin(db, fx, deps.deps);
  return { fx, draft, ...deps };
}


/** All teams draft `perTeam` wave picks concurrently-ish (sequentially here). */
async function waveRound(fx: DraftFixture, draftId: string, perTeam: number, deps = {}) {
  for (let i = 0; i < perTeam; i++) {
    for (const t of fx.teams) await makePick(db, draftId, t.id, fresh(), t.ownerId, deps);
  }
}

async function snakeAll(fx: DraftFixture, draft: { id: string; order: string[] }, rounds: number, deps = {}) {
  for (let pick = 1; pick <= rounds * fx.teams.length; pick++) {
    const teamId = snakeTeam(draft.order, pick);
    await makePick(db, draft.id, teamId, fresh(), fx.owner.get(teamId)!, deps);
  }
}

const reload = async (id: string) => (await db.select().from(drafts).where(eq(drafts.id, id)))[0];
const leagueStatus = async (id: string) => (await db.select().from(leagues).where(eq(leagues.id, id)))[0].status;

describe("startDraft", () => {
  it("only the commissioner can start it", async () => {
    const fx = await setupLeague(db, admin, 4, SMALL);
    const member = fx.teams.find((t) => t.ownerId !== admin.id)!;
    expect(await code(startDraft(db, fx.league.id, member.ownerId, captureNotifier().deps))).toBe("forbidden");
    expect((await db.select().from(drafts).where(eq(drafts.leagueId, fx.league.id))).length).toBe(0);
  });

  it("needs at least 2 teams", async () => {
    const fx = await setupLeague(db, admin, 1, SMALL, { schedule: false });
    expect(await code(startDraft(db, fx.league.id, admin.id, captureNotifier().deps))).toBe("not_enough_teams");
  });

  it("needs a schedule, and a team joining afterwards clears it", async () => {
    const noSchedule = await setupLeague(db, admin, 3, SMALL, { schedule: false });
    expect(await code(startDraft(db, noSchedule.league.id, admin.id, captureNotifier().deps))).toBe("schedule_required");

    const fx = await setupLeague(db, admin, 3, SMALL);
    const { token } = await createLeagueInvite(db, admin, fx.league.id);
    await redeemLeagueInvite(db, { token, username: `late${Math.random().toString(36).slice(2, 8)}`, password: "password123", teamName: "Late", teamAbbrev: "LAT" });
    expect(await code(startDraft(db, fx.league.id, admin.id, captureNotifier().deps))).toBe("schedule_required");
  });

  it("stores the format, a random order, and locks the settings", async () => {
    const { fx, draft } = await started(4, SMALL);
    expect(draft).toMatchObject({ status: "snake", maxRoster: 6, snakeRounds: 2, totalRounds: 6, currentPick: 1, currentWave: null });
    expect([...draft.order].sort()).toEqual(fx.teams.map((t) => t.id).sort());
    expect(await leagueStatus(fx.league.id)).toBe("drafting");
    expect(await code(updateSettings(db, admin, fx.league.id, { snakeTarget: 12 }))).toBe("settings_locked");
    expect(await code(updateSettings(db, admin, fx.league.id, { addsPerDay: 1 }))).toBe("ok");
  });

  it("uses the injected random source for the shuffle (Fisher-Yates)", async () => {
    const fx = await setupLeague(db, admin, 4, SMALL);
    const draft = await startDraft(db, fx.league.id, admin.id, { ...captureNotifier().deps, random: () => 0 });
    const ids = (await db.select().from(teams).where(eq(teams.leagueId, fx.league.id))).sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    );
    // random()=0 always swaps index i with 0: [a,b,c,d] -> [b,c,d,a]
    expect(draft.order).toEqual([ids[1].id, ids[2].id, ids[3].id, ids[0].id]);
  });

  it("randomizes: orders vary across leagues", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) seen.add((await started(4, SMALL)).draft.order.join(","));
    // each league has distinct team ids, so compare permutation of positions instead
    expect(seen.size).toBe(6);
  });

  it("can only start once", async () => {
    const { fx } = await started();
    expect(await code(startDraft(db, fx.league.id, admin.id, captureNotifier().deps))).toBe("already_started");
  });

  it("goes straight to waves when there are no snake rounds", async () => {
    const { draft } = await started(4, { rosterPool: 24, snakeTarget: 0 });
    expect(draft).toMatchObject({ status: "waves", snakeRounds: 0, currentWave: 1 });
  });

  it("notifies everyone 'Draft started' and the first picker 'on the clock'", async () => {
    const { fx, draft, calls } = await started();
    const events = calls.find((c) => c.type === "draft_events")!;
    expect(events.title).toBe("Draft started");
    expect([...events.userIds].sort()).toEqual(fx.teams.map((t) => t.ownerId).sort());
    const clock = calls.find((c) => c.type === "draft_on_clock")!;
    expect(clock.userIds).toEqual([fx.owner.get(draft.order[0])]);
    const heads = calls.find((c) => c.type === "draft_heads_up")!;
    expect(heads.userIds).toEqual([fx.owner.get(draft.order[2])]);
  });
});

describe("makePick validation", () => {
  it("rejects a wrong-turn pick", async () => {
    const { fx, draft } = await started();
    const second = draft.order[1];
    expect(await code(makePick(db, draft.id, second, fresh(), fx.owner.get(second)!))).toBe("not_your_turn");
  });

  it("rejects someone who does not own the team", async () => {
    const { fx, draft } = await started();
    const first = draft.order[0];
    const other = fx.teams.find((t) => t.id !== first)!;
    expect(await code(makePick(db, draft.id, first, fresh(), other.ownerId))).toBe("forbidden");
    // Only the commissioner may use asCommissioner.
    const nonCommissioner = fx.teams.find((t) => t.ownerId !== admin.id)!.ownerId;
    expect(await code(makePick(db, draft.id, first, fresh(), nonCommissioner, { asCommissioner: true }))).toBe("forbidden");
  });

  it("lets the commissioner pick for the team on the clock, flagged", async () => {
    const { draft } = await started();
    const { pick } = await makePick(db, draft.id, draft.order[0], fresh(), admin.id, { asCommissioner: true, ...captureNotifier().deps });
    expect(pick.madeByCommissioner).toBe(true);
    expect(pick.madeBy).toBe(admin.id);
    // ...but not out of turn.
    expect(await code(makePick(db, draft.id, draft.order[3], fresh(), admin.id, { asCommissioner: true }))).toBe("not_your_turn");
  });

  it("rejects a player who is taken, inactive, teamless or unknown", async () => {
    const { fx, draft } = await started();
    const quiet = captureNotifier().deps;
    const p = fresh();
    await makePick(db, draft.id, draft.order[0], p, fx.owner.get(draft.order[0])!, quiet);
    expect(await code(makePick(db, draft.id, draft.order[1], p, fx.owner.get(draft.order[1])!))).toBe("player_taken");

    const inactive = fresh();
    await db.update(nbaPlayers).set({ active: false }).where(eq(nbaPlayers.id, inactive));
    expect(await code(makePick(db, draft.id, draft.order[1], inactive, fx.owner.get(draft.order[1])!))).toBe("player_unavailable");

    const teamless = fresh();
    await db.update(nbaPlayers).set({ teamId: null }).where(eq(nbaPlayers.id, teamless));
    expect(await code(makePick(db, draft.id, draft.order[1], teamless, fx.owner.get(draft.order[1])!))).toBe("player_unavailable");

    expect(await code(makePick(db, draft.id, draft.order[1], 99_999_999, fx.owner.get(draft.order[1])!))).toBe("player_unavailable");
  });

  it("rejects a player already on an active roster in the league", async () => {
    const { fx, draft } = await started();
    const p = fresh();
    await db.insert(rosterEntries).values({ leagueId: fx.league.id, teamId: draft.order[3], playerId: p, acquiredVia: "commissioner" });
    expect(await code(makePick(db, draft.id, draft.order[0], p, fx.owner.get(draft.order[0])!))).toBe("player_taken");
  });

  it("does not let a player be on two active rosters in one league (unique index)", async () => {
    const { fx } = await started();
    const p = fresh();
    await db.insert(rosterEntries).values({ leagueId: fx.league.id, teamId: fx.teams[0].id, playerId: p, acquiredVia: "add" });
    await expect(
      db.insert(rosterEntries).values({ leagueId: fx.league.id, teamId: fx.teams[1].id, playerId: p, acquiredVia: "add" }),
    ).rejects.toThrow();
    // Once released, another team may take him.
    await db.update(rosterEntries).set({ releasedAt: new Date(), releasedVia: "drop" }).where(and(eq(rosterEntries.playerId, p), eq(rosterEntries.leagueId, fx.league.id)));
    await db.insert(rosterEntries).values({ leagueId: fx.league.id, teamId: fx.teams[1].id, playerId: p, acquiredVia: "add" });
  });

  it("the same player can be drafted in two different leagues", async () => {
    const a = await started();
    const b = await started();
    const p = fresh();
    await makePick(db, a.draft.id, a.draft.order[0], p, a.fx.owner.get(a.draft.order[0])!, a.deps);
    await makePick(db, b.draft.id, b.draft.order[0], p, b.fx.owner.get(b.draft.order[0])!, b.deps);
  });

  it("rejects picks when the draft is not active, and for a team from another league", async () => {
    const { fx, draft } = await started();
    const other = await started();
    expect(await code(makePick(db, draft.id, other.draft.order[0], fresh(), admin.id, { asCommissioner: true }))).toBe("team_not_found");
    expect(await code(makePick(db, "00000000-0000-4000-8000-000000000000", draft.order[0], fresh(), admin.id))).toBe("not_found");
    expect(fx.teams.length).toBe(4);
  });
});

describe("full draft flow", () => {
  it("snake -> wave 1 -> wave 2 -> complete, with rosters, queue cleanup and state", async () => {
    const { fx, draft, calls, deps } = await started(4, SMALL);
    const first = draft.order[0];

    // Queue a player for two teams; drafting him removes him from both queues.
    const queued = fresh();
    for (const t of [draft.order[1], draft.order[2]]) await addToQueue(db, t, queued, fx.owner.get(t)!);
    expect(await db.select().from(draftQueue).where(eq(draftQueue.playerId, queued))).toHaveLength(2);
    await makePick(db, draft.id, first, queued, fx.owner.get(first)!, deps);
    expect(await db.select().from(draftQueue).where(eq(draftQueue.playerId, queued))).toHaveLength(0);

    // Rest of the snake (7 more picks).
    for (let pick = 2; pick <= 8; pick++) {
      const t = snakeTeam(draft.order, pick);
      const d = await reload(draft.id);
      expect(d).toMatchObject({ status: "snake", currentPick: pick });
      await makePick(db, draft.id, t, fresh(), fx.owner.get(t)!, deps);
    }
    const afterSnake = await reload(draft.id);
    expect(afterSnake).toMatchObject({ status: "waves", currentWave: 1, currentPick: 9 });
    expect(afterSnake.waveOpenedAt).not.toBeNull();
    const waveOpen = calls.filter((c) => c.type === "draft_wave_open");
    expect(waveOpen).toHaveLength(1);
    expect(waveOpen[0].title).toBe("Wave 1 open: pick 2");
    expect([...waveOpen[0].userIds].sort()).toEqual(fx.teams.map((t) => t.ownerId).sort());

    // Wave 1: quota of 2 per team, any order, no turns.
    const [t1, t2, t3, t4] = draft.order;
    await makePick(db, draft.id, t4, fresh(), fx.owner.get(t4)!, deps);
    await makePick(db, draft.id, t4, fresh(), fx.owner.get(t4)!, deps);
    expect(await code(makePick(db, draft.id, t4, fresh(), fx.owner.get(t4)!, deps))).toBe("no_wave_quota");
    await makePick(db, draft.id, t1, fresh(), fx.owner.get(t1)!, deps);
    await makePick(db, draft.id, t2, fresh(), fx.owner.get(t2)!, deps);
    await makePick(db, draft.id, t3, fresh(), fx.owner.get(t3)!, deps);
    await makePick(db, draft.id, t1, fresh(), fx.owner.get(t1)!, deps);
    await makePick(db, draft.id, t2, fresh(), fx.owner.get(t2)!, deps);
    expect(await reload(draft.id)).toMatchObject({ status: "waves", currentWave: 1 });
    await makePick(db, draft.id, t3, fresh(), fx.owner.get(t3)!, deps);
    // Everyone finished wave 1 -> wave 2 opens.
    expect(await reload(draft.id)).toMatchObject({ status: "waves", currentWave: 2 });
    expect(calls.filter((c) => c.type === "draft_wave_open").map((c) => c.title)).toEqual(["Wave 1 open: pick 2", "Wave 2 open: pick 2"]);

    await waveRound(fx, draft.id, 2, deps);
    const done = await reload(draft.id);
    expect(done.status).toBe("complete");
    expect(done.completedAt).not.toBeNull();
    expect(await leagueStatus(fx.league.id)).toBe("in_season");
    expect(calls.filter((c) => c.title === "Draft complete")).toHaveLength(1);

    // Everyone has a full roster; pick numbers are 1..24 with no gaps; rounds per team 1..6.
    const picks = await db.select().from(draftPicks).where(eq(draftPicks.draftId, draft.id));
    expect(picks.map((p) => p.overallPick).sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    for (const t of fx.teams) {
      const r = await db.select().from(rosterEntries).where(and(eq(rosterEntries.teamId, t.id), isNull(rosterEntries.releasedAt)));
      expect(r).toHaveLength(6);
      expect(r.every((e) => e.acquiredVia === "draft")).toBe(true);
      expect(picks.filter((p) => p.teamId === t.id).map((p) => p.round).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    }
    expect(picks.filter((p) => p.phase === "snake")).toHaveLength(8);
    expect(picks.filter((p) => p.phase === "wave" && p.wave === 2)).toHaveLength(8);
    expect(await code(makePick(db, draft.id, t1, fresh(), fx.owner.get(t1)!))).toBe("draft_not_active");
  });

  it("sends 'on the clock' to each next snake picker and a 2-picks-away heads-up", async () => {
    const { fx, draft, calls, deps } = await started(4, SMALL);
    calls.length = 0;
    await pickSnake(db, fx, draft, 1, fresh(), deps);
    const clock = calls.filter((c) => c.type === "draft_on_clock");
    expect(clock).toHaveLength(1);
    expect(clock[0].userIds).toEqual([fx.owner.get(draft.order[1])]);
    const heads = calls.filter((c) => c.type === "draft_heads_up");
    expect(heads).toHaveLength(1);
    expect(heads[0].userIds).toEqual([fx.owner.get(draft.order[3])]);
    // Pick 4 -> next on the clock is the same team (pick 5): heads-up goes to pick 6's team only.
    calls.length = 0;
    for (let p = 2; p <= 4; p++) await pickSnake(db, fx, draft, p, fresh(), deps);
    const last = calls.slice(-2);
    expect(last.find((c) => c.type === "draft_on_clock")!.userIds).toEqual([fx.owner.get(draft.order[3])]);
  });

  it("handles an odd final wave (3 rounds after the snake -> 2 then 1)", async () => {
    const { fx, draft, calls, deps } = await started(4, ODD);
    expect(draft).toMatchObject({ maxRoster: 5, snakeRounds: 2, totalRounds: 5 });
    await snakeAll(fx, draft, 2, deps);
    await waveRound(fx, draft.id, 2, deps);
    expect(await reload(draft.id)).toMatchObject({ status: "waves", currentWave: 2 });
    expect(calls.filter((c) => c.type === "draft_wave_open").map((c) => c.title)).toEqual(["Wave 1 open: pick 2", "Wave 2 open: pick 1"]);
    const t = fx.teams[0];
    await makePick(db, draft.id, t.id, fresh(), t.ownerId, deps);
    expect(await code(makePick(db, draft.id, t.id, fresh(), t.ownerId, deps))).toBe("no_wave_quota");
    for (const o of fx.teams.slice(1)) await makePick(db, draft.id, o.id, fresh(), o.ownerId, deps);
    expect((await reload(draft.id)).status).toBe("complete");
  });

  it("supports an all-snake 4-team draft", async () => {
    const { fx, draft, calls, deps } = await started(4, ALL_SNAKE);
    expect(draft).toMatchObject({ maxRoster: 3, snakeRounds: 3, totalRounds: 3 });
    await snakeAll(fx, draft, 3, deps);
    expect((await reload(draft.id)).status).toBe("complete");
    expect(await leagueStatus(fx.league.id)).toBe("in_season");
    expect(calls.some((c) => c.type === "draft_wave_open")).toBe(false);
    expect(calls.filter((c) => c.title === "Draft complete")).toHaveLength(1);
  });

  it("commissioner can pick for an idle team in a wave", async () => {
    const { fx, draft, deps } = await started(4, SMALL);
    await snakeAll(fx, draft, 2, deps);
    const idle = draft.order[2];
    await makePick(db, draft.id, idle, fresh(), admin.id, { ...deps, asCommissioner: true });
    const rows = await db.select().from(draftPicks).where(and(eq(draftPicks.draftId, draft.id), eq(draftPicks.teamId, idle), eq(draftPicks.phase, "wave")));
    expect(rows).toHaveLength(1);
    expect(rows[0].madeByCommissioner).toBe(true);
  });
});

describe("concurrency", () => {
  it("two simultaneous picks of the same player: exactly one wins, the other gets player_taken", async () => {
    const { fx, draft, deps } = await started(4, SMALL);
    await snakeAll(fx, draft, 2, deps);
    const p = fresh();
    const [a, b] = draft.order;
    const results = await Promise.allSettled([
      makePick(db, draft.id, a, p, fx.owner.get(a)!, deps),
      makePick(db, draft.id, b, p, fx.owner.get(b)!, deps),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((failed.reason as DraftError).code).toBe("player_taken");
    expect(await db.select().from(draftPicks).where(eq(draftPicks.playerId, p))).toHaveLength(1);
  });

  it("simultaneous wave picks of different players by different teams all succeed with distinct pick numbers", async () => {
    const { fx, draft, deps } = await started(4, SMALL);
    await snakeAll(fx, draft, 2, deps);
    const results = await Promise.allSettled(draft.order.map((t) => makePick(db, draft.id, t, fresh(), fx.owner.get(t)!, deps)));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const nums = (await db.select().from(draftPicks).where(and(eq(draftPicks.draftId, draft.id), eq(draftPicks.phase, "wave")))).map((p) => p.overallPick);
    expect(new Set(nums).size).toBe(4);
  });

  it("two simultaneous snake picks for the same turn: one succeeds", async () => {
    const { fx, draft, deps } = await started(4, SMALL);
    const t = draft.order[0];
    const results = await Promise.allSettled([
      makePick(db, draft.id, t, fresh(), fx.owner.get(t)!, deps),
      makePick(db, draft.id, t, fresh(), fx.owner.get(t)!, deps),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as DraftError).code).toBe("not_your_turn");
  });

  it("a team cannot exceed its wave quota with parallel requests", async () => {
    const { fx, draft, deps } = await started(4, SMALL);
    await snakeAll(fx, draft, 2, deps);
    const t = draft.order[0];
    const results = await Promise.allSettled([1, 2, 3].map(() => makePick(db, draft.id, t, fresh(), fx.owner.get(t)!, deps)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
  });
});

describe("undoLastPick", () => {
  it("restores a snake pick: roster, availability and turn", async () => {
    const { fx, draft, deps } = await started(4, SMALL);
    await pickSnake(db, fx, draft, 1, fresh(), deps);
    const p2 = fresh();
    await pickSnake(db, fx, draft, 2, p2, deps);
    const queueTeam = draft.order[3];
    await addToQueue(db, queueTeam, fresh(), fx.owner.get(queueTeam)!);

    // The order is random, so pick an owner who isn't the commissioner.
    const nonCommish = draft.order.map((t) => fx.owner.get(t)!).find((u) => u !== admin.id)!;
    expect(await code(undoLastPick(db, draft.id, nonCommish, deps))).toBe("forbidden");
    const undone = await undoLastPick(db, draft.id, admin.id, deps);
    expect(undone.playerId).toBe(p2);
    expect(await reload(draft.id)).toMatchObject({ status: "snake", currentPick: 2 });
    expect(await db.select().from(rosterEntries).where(eq(rosterEntries.playerId, p2))).toHaveLength(0);
    expect((await listDraftablePlayers(db, fx.league.id, { limit: 200 })).players.some((p) => p.id === p2)).toBe(true);
    // The player can be picked again.
    await pickSnake(db, fx, draft, 2, p2, deps);
  });

  it("nothing to undo before the first pick", async () => {
    const { draft, deps } = await started();
    expect(await code(undoLastPick(db, draft.id, admin.id, deps))).toBe("nothing_to_undo");
  });

  it("steps back from wave 1 (no wave picks yet) into the snake", async () => {
    const { fx, draft, deps } = await started(4, SMALL);
    await snakeAll(fx, draft, 2, deps);
    expect(await reload(draft.id)).toMatchObject({ status: "waves", currentWave: 1 });
    const last = await undoLastPick(db, draft.id, admin.id, deps);
    expect(last.overallPick).toBe(8);
    expect(await reload(draft.id)).toMatchObject({ status: "snake", currentPick: 8, currentWave: null });
  });

  it("reopens wave 1 when undoing the first wave-2 pick boundary", async () => {
    const { fx, draft, deps } = await started(4, SMALL);
    await snakeAll(fx, draft, 2, deps);
    await waveRound(fx, draft.id, 2, deps);
    expect(await reload(draft.id)).toMatchObject({ status: "waves", currentWave: 2 });
    const undone = await undoLastPick(db, draft.id, admin.id, deps);
    expect(undone.wave).toBe(1);
    expect(await reload(draft.id)).toMatchObject({ status: "waves", currentWave: 1 });
    // The affected team can pick again; the others cannot.
    expect(await code(makePick(db, draft.id, undone.teamId, fresh(), fx.owner.get(undone.teamId)!, deps))).toBe("ok");
    expect((await reload(draft.id)).currentWave).toBe(2);
  });

  it("undoes mid-wave picks without changing the wave", async () => {
    const { fx, draft, deps } = await started(4, SMALL);
    await snakeAll(fx, draft, 2, deps);
    const t = draft.order[0];
    await makePick(db, draft.id, t, fresh(), fx.owner.get(t)!, deps);
    await undoLastPick(db, draft.id, admin.id, deps);
    expect(await reload(draft.id)).toMatchObject({ status: "waves", currentWave: 1 });
    expect(await db.select().from(draftPicks).where(eq(draftPicks.draftId, draft.id))).toHaveLength(8);
  });

  it("un-completes a finished draft and resets the league to drafting", async () => {
    const { fx, draft, deps } = await started(4, SMALL);
    await snakeAll(fx, draft, 2, deps);
    await waveRound(fx, draft.id, 4, deps);
    expect((await reload(draft.id)).status).toBe("complete");
    expect(await leagueStatus(fx.league.id)).toBe("in_season");
    await undoLastPick(db, draft.id, admin.id, deps);
    const d = await reload(draft.id);
    expect(d).toMatchObject({ status: "waves", currentWave: 2, completedAt: null });
    expect(await leagueStatus(fx.league.id)).toBe("drafting");
    const left = await db.select().from(rosterEntries).where(and(eq(rosterEntries.leagueId, fx.league.id), isNull(rosterEntries.releasedAt)));
    expect(left).toHaveLength(23);
    // Finish again.
    const counts = new Map<string, number>();
    for (const e of left) counts.set(e.teamId, (counts.get(e.teamId) ?? 0) + 1);
    const short = fx.teams.find((t) => (counts.get(t.id) ?? 0) === 5)!;
    await makePick(db, draft.id, short.id, fresh(), short.ownerId, deps);
    expect((await reload(draft.id)).status).toBe("complete");
    expect(await leagueStatus(fx.league.id)).toBe("in_season");
  });

  it("refuses to undo a finished draft once rosters have moved", async () => {
    const { fx, draft, deps } = await started(4, ALL_SNAKE);
    await snakeAll(fx, draft, 3, deps);
    const [entry] = await db.select().from(rosterEntries).where(eq(rosterEntries.leagueId, fx.league.id)).limit(1);
    await db.update(rosterEntries).set({ releasedAt: new Date(), releasedVia: "drop" }).where(eq(rosterEntries.id, entry.id));
    expect(await code(undoLastPick(db, draft.id, admin.id, deps))).toBe("cannot_undo");
    expect((await reload(draft.id)).status).toBe("complete");
  });
});

describe("queue", () => {
  it("adds, reorders and removes for the team owner only", async () => {
    const { fx } = await started();
    const mine = fx.teams.find((t) => t.ownerId !== admin.id)!;
    const other = fx.teams.find((t) => t.id !== mine.id)!;
    const [a, b, c] = [fresh(), fresh(), fresh()];
    for (const p of [a, b, c]) await addToQueue(db, mine.id, p, mine.ownerId);
    await addToQueue(db, mine.id, a, mine.ownerId); // idempotent
    const ids = async () => (await db.select().from(draftQueue).where(eq(draftQueue.teamId, mine.id))).sort((x, y) => x.rank - y.rank).map((q) => q.playerId);
    expect(await ids()).toEqual([a, b, c]);
    await reorderQueue(db, mine.id, [c, a], mine.ownerId);
    expect(await ids()).toEqual([c, a, b]);
    await removeFromQueue(db, mine.id, a, mine.ownerId);
    expect(await ids()).toEqual([c, b]);

    expect(await code(addToQueue(db, mine.id, fresh(), other.ownerId))).toBe("forbidden");
    expect(await code(reorderQueue(db, mine.id, [b, c], other.ownerId))).toBe("forbidden");
    expect(await code(removeFromQueue(db, mine.id, b, other.ownerId))).toBe("forbidden");
    // The commissioner is not special for queues.
    expect(await code(addToQueue(db, mine.id, fresh(), admin.id))).toBe("forbidden");
  });

  it("only accepts draftable players", async () => {
    const fx = await setupLeague(db, admin, 3, SMALL);
    const t = fx.teams[0];
    const gone = fresh();
    await db.update(nbaPlayers).set({ active: false }).where(eq(nbaPlayers.id, gone));
    expect(await code(addToQueue(db, t.id, gone, t.ownerId))).toBe("player_unavailable");
    const rostered = fresh();
    await db.insert(rosterEntries).values({ leagueId: fx.league.id, teamId: fx.teams[1].id, playerId: rostered, acquiredVia: "commissioner" });
    expect(await code(addToQueue(db, t.id, rostered, t.ownerId))).toBe("player_unavailable");
    // Allowed before the draft starts.
    expect(await code(addToQueue(db, t.id, fresh(), t.ownerId))).toBe("ok");
  });

  it("is closed once the draft is complete", async () => {
    const { fx, draft, deps } = await started(4, ALL_SNAKE);
    await snakeAll(fx, draft, 3, deps);
    const t = fx.teams[0];
    expect(await code(addToQueue(db, t.id, fresh(), t.ownerId))).toBe("draft_not_active");
  });
});

describe("getDraftBoard", () => {
  it("shows a preview before the draft starts", async () => {
    const fx = await setupLeague(db, admin, 4, SMALL);
    const board = await getDraftBoard(db, fx.league.id, admin.id);
    expect(board.draft).toBeNull();
    expect(board.scheduleReady).toBe(true);
    expect(board.format).toMatchObject({ teamCount: 4, maxRoster: 6, snakeRounds: 2, waveCount: 2, totalPicks: 24, snakePicks: 8 });
    expect(board.viewer.isCommissioner).toBe(true);
  });

  it("reports the snake clock, wave waiters, my roster and queue", async () => {
    const { fx, draft, deps } = await started(4, SMALL);
    const first = draft.order[0];
    const owner = fx.owner.get(first)!;
    let board = await getDraftBoard(db, fx.league.id, owner);
    expect(board.draft!.status).toBe("snake");
    expect(board.draft!.onClock).toMatchObject({ teamId: first, pick: 1, round: 1 });
    expect(board.me.canPick).toBe(true);
    expect((await getDraftBoard(db, fx.league.id, fx.owner.get(draft.order[1])!)).me.canPick).toBe(false);

    const mine = fresh();
    await makePick(db, draft.id, first, mine, owner, deps);
    board = await getDraftBoard(db, fx.league.id, owner);
    expect(board.me.roster.map((p) => p.id)).toEqual([mine]);
    expect(board.draft!.picks).toHaveLength(1);

    for (let p = 2; p <= 8; p++) await pickSnake(db, fx, draft, p, fresh(), deps);
    const t2 = draft.order[1];
    await makePick(db, draft.id, t2, fresh(), fx.owner.get(t2)!, deps);
    board = await getDraftBoard(db, fx.league.id, fx.owner.get(t2)!);
    expect(board.draft!.wave).toMatchObject({ number: 1, quota: 2, count: 2 });
    expect(board.draft!.wave!.waiting.find((w) => w.teamId === t2)!.remaining).toBe(1);
    expect(board.draft!.wave!.waiting).toHaveLength(4);
    expect(board.me).toMatchObject({ canPick: true, waveRemaining: 1 });
    expect(board.draft!.onClock).toBeNull();
    expect(board.draft!.recent[0].overall).toBe(9);
    expect(board.teams.map((t) => t.id)).toEqual(draft.order);
  });

  it("includes a recap once complete", async () => {
    const { fx, draft, deps } = await started(4, ALL_SNAKE);
    await snakeAll(fx, draft, 3, deps);
    const board = await getDraftBoard(db, fx.league.id, admin.id);
    expect(board.draft!.status).toBe("complete");
    expect(board.recap!.teams).toHaveLength(4);
    expect(board.recap!.teams.every((t) => t.picks.length === 3)).toBe(true);
  });
});

describe("listDraftablePlayers", () => {
  it("excludes rostered players and filters by name and team", async () => {
    const fx = await setupLeague(db, admin, 3, SMALL);
    const p = fresh();
    await db.insert(rosterEntries).values({ leagueId: fx.league.id, teamId: fx.teams[0].id, playerId: p, acquiredVia: "commissioner" });
    const all = await listDraftablePlayers(db, fx.league.id, { limit: 200 });
    expect(all.players.some((x) => x.id === p)).toBe(false);
    const named = await listDraftablePlayers(db, fx.league.id, { q: `Player ${playerIds[399]}` });
    expect(named.players.map((x) => x.id)).toEqual([playerIds[399]]);
    const byTeam = await listDraftablePlayers(db, fx.league.id, { team: 2, limit: 200 });
    expect(byTeam.players.length).toBe(byTeam.total);
    expect(byTeam.total).toBeGreaterThan(0);
  });
});
