import { and, asc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { draftPicks, drafts, keepers, leagues, nbaPlayers, rosterEntries, seasonResults, teams } from "@/db/schema";
import type { Db } from "@/db/types";
import { getDraftBoard, listDraftablePlayers } from "@/lib/draft/board";
import { DraftError, getDraftByLeague, isDraftable, makePick, startDraft, undoLastPick } from "@/lib/draft/service";
import { generateSchedule, listLeagues, updateSettings, type LeagueError } from "@/lib/leagues/service";
import { parseStoredSettings } from "@/lib/fantasy/settings";
import {
  SeasonError,
  getKeeperView,
  getLeagueHistory,
  getLineage,
  getNextSeasonId,
  getOwnerPastSeasons,
  setKeepers,
  startNextSeason,
} from "@/lib/seasons/service";
import { createTestDb } from "./helpers/db";
import { captureNotifier, seedPlayers, type DraftFixture } from "./helpers/draft";
import { rosterPlayer, seasonLeague } from "./helpers/rosters";
import { snakeTeam } from "@/lib/draft/engine";

let db: Db;
let close: () => Promise<void> | void;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedPlayers(db, 60);
  await db.update(nbaPlayers).set({ active: false }).where(eq(nbaPlayers.id, 7));
});
afterAll(() => close());

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e) => (e instanceof SeasonError || e instanceof DraftError || (e as LeagueError)?.code ? (e as { code: string }).code : `other:${e}`),
  );

/**
 * A finished season: 2 teams, max roster 5, snake target 4 (2 snake rounds -> room for 3 keepers),
 * 2 keepers per team. Team 0 finished with players 1, 2, 3 (+ inactive 7 + released 8); team 1 with 4, 5, 6.
 */
async function finished(settings: Record<string, unknown> = {}): Promise<DraftFixture> {
  const fx = await seasonLeague(db, 2, { max: 5, status: "complete", settings: { snakeTarget: 4, keepers: 2, ...settings } });
  // Team 0 is a plain member, team 1 is the commissioner's.
  fx.teams.sort((x, y) => Number(x.ownerId === fx.admin.id) - Number(y.ownerId === fx.admin.id));
  fx.league = (await db.select().from(leagues).where(eq(leagues.id, fx.league.id)))[0];
  for (const [t, ids] of [[0, [1, 2, 3, 7]], [1, [4, 5, 6]]] as const) for (const id of ids) await rosterPlayer(db, fx, t, id);
  await rosterPlayer(db, fx, 0, 8, { releasedAt: new Date("2026-12-01T00:00:00Z") });
  return fx;
}

const commish = (fx: DraftFixture) => ({ id: fx.admin.id, isSiteAdmin: true });
const ownerOf = (fx: DraftFixture, i: number) => ({ id: fx.teams[i].ownerId, isSiteAdmin: false });

async function nextTeams(leagueId: string) {
  return db.select().from(teams).where(eq(teams.leagueId, leagueId)).orderBy(asc(teams.createdAt), asc(teams.name));
}

describe("startNextSeason", () => {
  it("creates the next season in setup with the same teams, owners and settings, linked back", async () => {
    const fx = await finished();
    const cap = captureNotifier();
    const next = await startNextSeason(db, commish(fx), fx.league.id, cap.deps);
    expect(next).toMatchObject({
      name: fx.league.name,
      season: fx.league.season + 1,
      commissionerId: fx.league.commissionerId,
      status: "setup",
      previousLeagueId: fx.league.id,
    });
    const before = parseStoredSettings(fx.league.settings);
    const after = parseStoredSettings(next.settings);
    expect(after).toEqual({ ...before, regularSeasonStart: null, regularSeasonEnd: null, tradeDeadline: null, keeperDeadline: null });
    expect(after.keepers).toBe(2);
    expect(after.snakeTarget).toBe(4);

    const old = await nextTeams(fx.league.id);
    const created = await nextTeams(next.id);
    expect(created).toHaveLength(2);
    for (const o of old) {
      const n = created.find((t) => t.previousTeamId === o.id)!;
      expect(n).toMatchObject({ name: o.name, abbrev: o.abbrev, ownerId: o.ownerId, leagueId: next.id });
      expect(n.id).not.toBe(o.id);
    }
    expect(await db.select().from(rosterEntries).where(eq(rosterEntries.leagueId, next.id))).toHaveLength(0);
    expect((await db.select().from(leagues).where(eq(leagues.id, fx.league.id)))[0].status).toBe("complete");
    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0]).toMatchObject({ type: "league_events", leagueId: next.id });
    expect(cap.calls[0].userIds.sort()).toEqual(old.map((t) => t.ownerId).sort());
    expect(await getNextSeasonId(db, fx.league.id)).toBe(next.id);
  });

  it("is commissioner only, needs a complete season, and only happens once", async () => {
    const fx = await finished();
    expect(await code(startNextSeason(db, ownerOf(fx, 0), fx.league.id))).toBe("forbidden");
    const live = await seasonLeague(db, 2, { status: "in_season" });
    expect(await code(startNextSeason(db, commish(live), live.league.id))).toBe("wrong_status");
    const next = await startNextSeason(db, commish(fx), fx.league.id);
    const err = await startNextSeason(db, commish(fx), fx.league.id).catch((e) => e);
    expect(err).toBeInstanceOf(SeasonError);
    expect(err).toMatchObject({ code: "already_started", nextLeagueId: next.id });
    expect(await code(startNextSeason(db, commish(fx), "not-a-uuid"))).toBe("not_found");
  });

  it("groups past and current seasons in the league list", async () => {
    const fx = await finished();
    const next = await startNextSeason(db, commish(fx), fx.league.id);
    const { mine } = await listLeagues(db, ownerOf(fx, 1));
    expect(mine.find((s) => s.league.id === fx.league.id)?.rolledOver).toBe(true);
    expect(mine.find((s) => s.league.id === next.id)?.rolledOver).toBe(false);
  });
});

describe("history", () => {
  it("follows the chain both ways, lists champions and an owner's past finishes", async () => {
    const fx = await finished();
    const rows = fx.teams.map((t, i) => ({
      leagueId: fx.league.id,
      teamId: t.id,
      ownerUserId: t.ownerId,
      teamName: t.name,
      finalRank: i + 1,
      wins: 5 - i,
      losses: i,
      playoffResult: (i === 0 ? "champion" : "runner_up") as "champion" | "runner_up",
    }));
    await db.insert(seasonResults).values(rows);
    const s2 = await startNextSeason(db, commish(fx), fx.league.id);
    await db.update(leagues).set({ status: "complete" }).where(eq(leagues.id, s2.id));
    const s3 = await startNextSeason(db, commish(fx), s2.id);

    expect((await getLineage(db, s2.id)).map((l) => l.id)).toEqual([fx.league.id, s2.id, s3.id]);
    expect((await getLineage(db, fx.league.id)).map((l) => l.id)).toEqual([fx.league.id, s2.id, s3.id]);
    const history = await getLeagueHistory(db, s3.id);
    expect(history.map((h) => h.season)).toEqual([fx.league.season + 2, fx.league.season + 1, fx.league.season]);
    expect(history[2].champion).toMatchObject({ teamName: fx.teams[0].name });
    expect(history[2].results.map((r) => r.finalRank)).toEqual([1, 2]);
    expect(history[0].champion).toBeNull();

    const past = await getOwnerPastSeasons(db, s3.id, fx.teams[1].ownerId);
    expect(past).toHaveLength(1);
    expect(past[0]).toMatchObject({ finalRank: 2, playoffResult: "runner_up", season: fx.league.season });
  });
});

describe("keeper selection", () => {
  async function nextSeason(settings: Record<string, unknown> = {}) {
    const fx = await finished(settings);
    const next = await startNextSeason(db, commish(fx), fx.league.id);
    const [t0, t1] = await nextTeams(next.id);
    const byOwner = (ownerId: string) => (t0.ownerId === ownerId ? t0 : t1);
    return { fx, next, team0: byOwner(fx.teams[0].ownerId), team1: byOwner(fx.teams[1].ownerId) };
  }

  it("offers last season's final roster, minus inactive and released players, to the owner only", async () => {
    const { fx, next, team0 } = await nextSeason();
    const mine = await getKeeperView(db, ownerOf(fx, 0), next.id);
    expect(mine).toMatchObject({ enabled: true, limit: 2, open: true, isCommissioner: false });
    expect(mine.teams).toHaveLength(1);
    expect(mine.teams[0].teamId).toBe(team0.id);
    expect(mine.teams[0].candidates.map((p) => p.id).sort()).toEqual([1, 2, 3]); // not 7 (inactive) or 8 (released)
    const all = await getKeeperView(db, commish(fx), next.id);
    expect(all.teams).toHaveLength(2);
  });

  it("saves, replaces and limits keepers", async () => {
    const { fx, next, team0 } = await nextSeason();
    const me = ownerOf(fx, 0);
    expect(await setKeepers(db, me, team0.id, [1, 2])).toEqual([1, 2]);
    expect(await setKeepers(db, me, team0.id, [3])).toEqual([3]);
    expect((await db.select().from(keepers).where(eq(keepers.teamId, team0.id))).map((k) => k.playerId)).toEqual([3]);
    expect(await code(setKeepers(db, me, team0.id, [1, 2, 3]))).toBe("too_many");
    expect((await getKeeperView(db, me, next.id)).teams[0].selected).toEqual([3]); // unchanged by the failure
    expect(await setKeepers(db, me, team0.id, [])).toEqual([]);
  });

  it("rejects ineligible players: other teams, inactive, released, unknown", async () => {
    const { fx, team0 } = await nextSeason();
    const me = ownerOf(fx, 0);
    expect(await code(setKeepers(db, me, team0.id, [4]))).toBe("ineligible"); // the other franchise's player
    expect(await code(setKeepers(db, me, team0.id, [7]))).toBe("ineligible"); // inactive
    expect(await code(setKeepers(db, me, team0.id, [8]))).toBe("ineligible"); // released before season end
    expect(await code(setKeepers(db, me, team0.id, [999]))).toBe("ineligible");
    // A player who was cut from the NBA since becomes ineligible too.
    await db.update(nbaPlayers).set({ teamId: null }).where(eq(nbaPlayers.id, 2));
    expect(await code(setKeepers(db, me, team0.id, [2]))).toBe("ineligible");
    await db.update(nbaPlayers).set({ teamId: 2 }).where(eq(nbaPlayers.id, 2));
    expect(await code(setKeepers(db, me, team0.id, [2]))).toBe("ok");
  });

  it("lets only the owner or the commissioner edit, and honors the deadline for owners", async () => {
    const { fx, next, team0, team1 } = await nextSeason();
    expect(await code(setKeepers(db, ownerOf(fx, 0), team1.id, [4]))).toBe("forbidden"); // another member's team
    expect(await code(setKeepers(db, commish(fx), team0.id, [1]))).toBe("ok"); // commissioner edits any team
    expect(await code(setKeepers(db, ownerOf(fx, 1), team1.id, [4, 5]))).toBe("ok");

    await updateSettings(db, commish(fx), next.id, { keeperDeadline: "2026-11-01" });
    const late = new Date("2026-11-02T15:00:00Z");
    const ok = new Date("2026-11-01T15:00:00Z");
    expect(await code(setKeepers(db, ownerOf(fx, 0), team0.id, [1], late))).toBe("deadline_passed");
    expect(await code(setKeepers(db, commish(fx), team0.id, [1], late))).toBe("ok");
    expect(await code(setKeepers(db, ownerOf(fx, 0), team0.id, [2], ok))).toBe("ok");
  });

  it("is unavailable without keepers in the settings and validates the setting against roster space", async () => {
    const { fx, next, team0 } = await nextSeason({ keepers: 0 });
    expect(await code(setKeepers(db, ownerOf(fx, 0), team0.id, [1]))).toBe("keepers_disabled");
    expect((await getKeeperView(db, ownerOf(fx, 0), next.id)).enabled).toBe(false);
    // 2 teams, snake target 4 -> room for 3: 4 keepers per team is too many.
    const err = await updateSettings(db, commish(fx), next.id, { keepers: 4 }).catch((e: LeagueError) => e);
    expect(err).toMatchObject({ code: "invalid_input", fieldErrors: { keepers: [expect.stringContaining("at most 3")] } });
    expect((await updateSettings(db, commish(fx), next.id, { keepers: 3 })).keepers).toBe(3);
    // With the default draft settings and 2 teams the whole draft is snake: no room at all.
    const flat = await seasonLeague(db, 2, { status: "setup" });
    expect(await code(updateSettings(db, commish(flat), flat.league.id, { keepers: 1 }))).toBe("invalid_input");
  });
});

describe("drafting with keepers", () => {
  /** Team 0 keeps 2 players, team 1 none. max roster 5, 2 snake rounds, waves of 2. */
  async function ready(keep0 = [1, 2], keep1: number[] = []) {
    const { fx, next, team0, team1 } = await (async () => {
      const f = await finished();
      const n = await startNextSeason(db, commish(f), f.league.id);
      const [a, b] = await nextTeams(n.id);
      return { fx: f, next: n, team0: a.ownerId === f.teams[0].ownerId ? a : b, team1: a.ownerId === f.teams[0].ownerId ? b : a };
    })();
    await updateSettings(db, commish(fx), next.id, { regularSeasonStart: "2026-10-19", regularSeasonEnd: "2027-01-31" });
    await generateSchedule(db, commish(fx), next.id, { seed: "k" });
    if (keep0.length) await setKeepers(db, ownerOf(fx, 0), team0.id, keep0);
    if (keep1.length) await setKeepers(db, ownerOf(fx, 1), team1.id, keep1);
    const owner = new Map([
      [team0.id, team0.ownerId],
      [team1.id, team1.ownerId],
    ]);
    return { fx, next, team0, team1, owner };
  }

  let pool = 20;
  const fresh = () => pool++;

  it("places keepers on rosters, removes them from the pool and queues", async () => {
    const { fx, next, team0, team1 } = await ready();
    const cap = captureNotifier();
    const draft = await startDraft(db, next.id, fx.admin.id, cap.deps);
    const rows = await db.select().from(rosterEntries).where(and(eq(rosterEntries.leagueId, next.id), isNull(rosterEntries.releasedAt)));
    expect(rows.map((r) => [r.teamId, r.playerId, r.acquiredVia]).sort()).toEqual(
      [[team0.id, 1, "keeper"], [team0.id, 2, "keeper"]].sort(),
    );
    expect(await isDraftable(db, next.id, 1)).toBe(false);
    expect(await isDraftable(db, next.id, 3)).toBe(true);
    const pool = await listDraftablePlayers(db, next.id, { limit: 200 });
    expect(pool.players.some((p) => p.id === 1 || p.id === 2)).toBe(false);
    expect(await code(makePick(db, draft.id, team1.id, 1, team1.ownerId))).not.toBe("ok"); // taken, and not his turn or taken
    const board = await getDraftBoard(db, next.id, fx.teams[0].ownerId);
    expect(board.keeperCounts).toEqual({ [team0.id]: 2 });
    expect(board.me.keepers.map((p) => p.id).sort()).toEqual([1, 2]);
    expect(board.me.roster.map((p) => p.id)).toEqual(expect.arrayContaining([1, 2]));
  });

  it("each team drafts max roster minus its keepers: the keeper team skips a wave pick, snake stays equal", async () => {
    const { fx, next, team0, team1, owner } = await ready();
    const draft = await startDraft(db, next.id, fx.admin.id, captureNotifier().deps);
    expect(draft).toMatchObject({ maxRoster: 5, snakeRounds: 2, totalRounds: 5 });

    // Snake: 2 rounds x 2 teams, everyone picks (keepers don't change the snake).
    for (let n = 1; n <= 4; n++) {
      const t = snakeTeam(draft.order, n);
      await makePick(db, draft.id, t, fresh(), owner.get(t)!);
    }
    let d = (await getDraftByLeague(db, next.id))!;
    expect(d).toMatchObject({ status: "waves", currentWave: 1 });

    // Wave 1: team 0 (2 keepers) already has 4 of the 4 players due, so it owes nothing; team 1 owes 2.
    expect(await code(makePick(db, draft.id, team0.id, fresh(), team0.ownerId))).toBe("no_wave_quota");
    let board = await getDraftBoard(db, next.id, team1.ownerId);
    expect(board.draft?.wave?.waiting).toEqual([{ teamId: team1.id, remaining: 2 }]);
    await makePick(db, draft.id, team1.id, fresh(), team1.ownerId);
    await makePick(db, draft.id, team1.id, fresh(), team1.ownerId);
    d = (await getDraftByLeague(db, next.id))!;
    expect(d).toMatchObject({ status: "waves", currentWave: 2 });

    // Wave 2 (the odd last one): one pick each.
    board = await getDraftBoard(db, next.id, team1.ownerId);
    expect(board.draft?.wave?.waiting.sort((a, b) => a.teamId.localeCompare(b.teamId))).toEqual(
      [{ teamId: team0.id, remaining: 1 }, { teamId: team1.id, remaining: 1 }].sort((a, b) => a.teamId.localeCompare(b.teamId)),
    );
    await makePick(db, draft.id, team0.id, fresh(), team0.ownerId);
    expect((await getDraftByLeague(db, next.id))!.status).toBe("waves");
    expect(await code(makePick(db, draft.id, team0.id, fresh(), team0.ownerId))).toBe("no_wave_quota");
    await makePick(db, draft.id, team1.id, fresh(), team1.ownerId);

    d = (await getDraftByLeague(db, next.id))!;
    expect(d.status).toBe("complete");
    expect((await db.select().from(leagues).where(eq(leagues.id, next.id)))[0].status).toBe("in_season");
    const picks = await db.select().from(draftPicks).where(eq(draftPicks.draftId, draft.id));
    expect(picks.filter((p) => p.teamId === team0.id)).toHaveLength(3); // 5 - 2 keepers
    expect(picks.filter((p) => p.teamId === team1.id)).toHaveLength(5);
    const rosters = await db.select().from(rosterEntries).where(and(eq(rosterEntries.leagueId, next.id), isNull(rosterEntries.releasedAt)));
    expect(rosters.filter((r) => r.teamId === team0.id)).toHaveLength(5);
    expect(rosters.filter((r) => r.teamId === team1.id)).toHaveLength(5);
  });

  it("undo works with keepers: it never removes a keeper and re-derives the wave", async () => {
    const { fx, next, team0, team1, owner } = await ready();
    const draft = await startDraft(db, next.id, fx.admin.id, captureNotifier().deps);
    for (let n = 1; n <= 4; n++) {
      const t = snakeTeam(draft.order, n);
      await makePick(db, draft.id, t, fresh(), owner.get(t)!);
    }
    await makePick(db, draft.id, team1.id, fresh(), team1.ownerId);
    await makePick(db, draft.id, team1.id, fresh(), team1.ownerId);
    await makePick(db, draft.id, team0.id, fresh(), team0.ownerId);
    await makePick(db, draft.id, team1.id, fresh(), team1.ownerId);
    expect((await getDraftByLeague(db, next.id))!.status).toBe("complete");

    // Undo the final pick: back in wave 2 with team 1 owing a pick.
    await undoLastPick(db, draft.id, fx.admin.id, captureNotifier().deps);
    expect(await getDraftByLeague(db, next.id)).toMatchObject({ status: "waves", currentWave: 2 });
    expect((await db.select().from(leagues).where(eq(leagues.id, next.id)))[0].status).toBe("drafting");
    // Undo the keeper team's wave-2 pick too, then wave 1's second pick: wave 1 again, team 1 still owes 1.
    await undoLastPick(db, draft.id, fx.admin.id, captureNotifier().deps);
    await undoLastPick(db, draft.id, fx.admin.id, captureNotifier().deps);
    expect(await getDraftByLeague(db, next.id)).toMatchObject({ status: "waves", currentWave: 1 });
    const board = await getDraftBoard(db, next.id, team1.ownerId);
    expect(board.draft?.wave?.waiting).toEqual([{ teamId: team1.id, remaining: 1 }]);
    // Keepers are untouched, and undoing everything stops at the keepers.
    for (let i = 0; i < 5; i++) await undoLastPick(db, draft.id, fx.admin.id, captureNotifier().deps);
    expect(await code(undoLastPick(db, draft.id, fx.admin.id))).toBe("nothing_to_undo");
    const kept = await db.select().from(rosterEntries).where(and(eq(rosterEntries.teamId, team0.id), isNull(rosterEntries.releasedAt)));
    expect(kept.map((r) => [r.playerId, r.acquiredVia]).sort()).toEqual([[1, "keeper"], [2, "keeper"]]);
    expect(await getDraftByLeague(db, next.id)).toMatchObject({ status: "snake", currentPick: 1 });
  });

  it("drops a keeper who is no longer an active NBA player when the draft starts", async () => {
    const { fx, next, team0 } = await ready([1, 2]);
    await db.update(nbaPlayers).set({ teamId: null }).where(eq(nbaPlayers.id, 2));
    await startDraft(db, next.id, fx.admin.id, captureNotifier().deps);
    expect((await db.select().from(keepers).where(eq(keepers.teamId, team0.id))).map((k) => k.playerId)).toEqual([1]);
    const rows = await db.select().from(rosterEntries).where(eq(rosterEntries.leagueId, next.id));
    expect(rows.map((r) => r.playerId)).toEqual([1]);
    await db.update(nbaPlayers).set({ teamId: 2 }).where(eq(nbaPlayers.id, 2));
  });

  it("refuses to start when a team has more keepers than roster space allows", async () => {
    const { fx, next, team0 } = await ready([1]);
    await db.insert(keepers).values([2, 3, 12].map((playerId) => ({ leagueId: next.id, teamId: team0.id, playerId })));
    expect(await code(startDraft(db, next.id, fx.admin.id, captureNotifier().deps))).toBe("keepers_invalid");
    expect((await db.select().from(drafts).where(eq(drafts.leagueId, next.id)))).toHaveLength(0);
    expect((await db.select().from(leagues).where(eq(leagues.id, next.id)))[0].status).toBe("setup");
  });

  it("locks keepers once the draft has started", async () => {
    const { fx, next, team0 } = await ready([1]);
    await startDraft(db, next.id, fx.admin.id, captureNotifier().deps);
    expect(await code(setKeepers(db, commish(fx), team0.id, [2]))).toBe("wrong_status");
    expect(await code(updateSettings(db, commish(fx), next.id, { keepers: 1 }))).toBe("settings_locked");
  });
});
