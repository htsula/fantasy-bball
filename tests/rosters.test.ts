import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leagues, nbaPlayers, rosterEntries, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import {
  RosterError,
  addFreeAgent,
  commissionerAdd,
  commissionerDrop,
  commissionerRestore,
  dropPlayer,
  getAddsToday,
  listTransactions,
  removeCutPlayers,
  type RosterErrorCode,
} from "@/lib/rosters/service";
import { createTestDb } from "./helpers/db";
import { captureNotifier, seedPlayers, type DraftFixture } from "./helpers/draft";
import { rosterPlayer, seasonLeague } from "./helpers/rosters";

let db: Db;
let close: () => Promise<void> | void;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await seedPlayers(db, 30); // ids 1..30, all active on NBA teams
});
afterEach(async () => {
  await close();
});

const NOON = new Date("2026-11-02T17:00:00Z"); // noon ET, Nov 2
const code = async (p: Promise<unknown>): Promise<RosterErrorCode | "ok"> => {
  try {
    await p;
    return "ok";
  } catch (err) {
    if (err instanceof RosterError) return err.code;
    throw err;
  }
};

const ownerOf = (fx: DraftFixture, i: number) => fx.teams[i].ownerId;
const add = (fx: DraftFixture, team: number, playerId: number, extra: { dropPlayerId?: number; now?: Date } = {}, n = captureNotifier()) =>
  addFreeAgent(
    db,
    { leagueId: fx.league.id, teamId: fx.teams[team].id, playerId, dropPlayerId: extra.dropPlayerId, actorUserId: ownerOf(fx, team) },
    { now: extra.now ?? NOON, notify: n.notify },
  );
const active = async (fx: DraftFixture, team: number) =>
  (
    await db
      .select({ p: rosterEntries.playerId })
      .from(rosterEntries)
      .where(and(eq(rosterEntries.teamId, fx.teams[team].id), isNull(rosterEntries.releasedAt)))
  )
    .map((r) => r.p)
    .sort((a, b) => a - b);

describe("addFreeAgent", () => {
  it("adds a free agent, logs the transaction and tells the other owners (in-app type)", async () => {
    const fx = await seasonLeague(db, 3);
    const n = captureNotifier();
    await add(fx, 0, 1, {}, n);
    expect(await active(fx, 0)).toEqual([1]);
    const [t] = await db.select().from(transactions);
    expect(t).toMatchObject({ type: "add", playerId: 1, teamId: fx.teams[0].id, actorUserId: ownerOf(fx, 0), etDate: "2026-11-02" });
    expect(n.calls).toHaveLength(1);
    expect(n.calls[0]).toMatchObject({ type: "league_transactions", leagueId: fx.league.id });
    expect(n.calls[0].userIds.sort()).toEqual([ownerOf(fx, 1), ownerOf(fx, 2)].sort());
    const [entry] = await db.select().from(rosterEntries);
    expect(entry).toMatchObject({ acquiredVia: "add", acquiredAt: NOON });
  });

  it("is rejected outside in_season/playoffs", async () => {
    for (const status of ["setup", "drafting", "complete"] as const) {
      const fx = await seasonLeague(db, 2);
      await db.update(leagues).set({ status }).where(eq(leagues.id, fx.league.id));
      expect(await code(add(fx, 0, 1))).toBe("wrong_status");
    }
    const playoffs = await seasonLeague(db, 2, { status: "playoffs" });
    expect(await code(add(playoffs, 0, 2))).toBe("ok");
  });

  it("only lets the team's owner add", async () => {
    const fx = await seasonLeague(db, 2);
    const err = await code(
      addFreeAgent(db, { leagueId: fx.league.id, teamId: fx.teams[0].id, playerId: 1, actorUserId: ownerOf(fx, 1) }, { now: NOON, notify: captureNotifier().notify }),
    );
    expect(err).toBe("forbidden");
  });

  it("rejects inactive players, players without an NBA team, and players already rostered", async () => {
    const fx = await seasonLeague(db, 2);
    await db.update(nbaPlayers).set({ active: false }).where(eq(nbaPlayers.id, 1));
    await db.update(nbaPlayers).set({ teamId: null }).where(eq(nbaPlayers.id, 2));
    expect(await code(add(fx, 0, 1))).toBe("player_unavailable");
    expect(await code(add(fx, 0, 2))).toBe("player_unavailable");
    expect(await code(add(fx, 0, 9999))).toBe("player_unavailable");
    await add(fx, 1, 3);
    expect(await code(add(fx, 0, 3))).toBe("player_taken");
    // The same player in another league is unaffected.
    const other = await seasonLeague(db, 2);
    expect(await code(add(other, 0, 3))).toBe("ok");
  });

  it("lets exactly one of two teams win a simultaneous add of the same player", async () => {
    const fx = await seasonLeague(db, 2);
    const results = await Promise.allSettled([add(fx, 0, 7), add(fx, 1, 7)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(RosterError);
    expect((rejected.reason as RosterError).code).toBe("player_taken");
    const holders = await db.select().from(rosterEntries).where(and(eq(rosterEntries.playerId, 7), isNull(rosterEntries.releasedAt)));
    expect(holders).toHaveLength(1);
  });

  it("limits a team to 2 adds per ET day, resets at midnight ET, and ignores drops and other teams", async () => {
    const fx = await seasonLeague(db, 2, { max: 10 });
    const lateNight = new Date("2026-11-03T04:30:00Z"); // 11:30pm ET Nov 2
    await add(fx, 0, 1, { now: lateNight });
    await add(fx, 0, 2, { now: lateNight });
    expect(await code(add(fx, 0, 3, { now: lateNight }))).toBe("daily_limit_reached");
    const adds = await getAddsToday(db, fx.teams[0].id, 2, lateNight);
    expect(adds).toMatchObject({ used: 2, remaining: 0, limit: 2 });
    expect(adds.resetsAt.toISOString()).toBe("2026-11-03T05:00:00.000Z"); // midnight EST

    // The other team has its own allowance.
    expect(await code(add(fx, 1, 4, { now: lateNight }))).toBe("ok");

    // Drops are unlimited and don't free up an add.
    await dropPlayer(db, { leagueId: fx.league.id, teamId: fx.teams[0].id, playerId: 1, actorUserId: ownerOf(fx, 0) }, { now: lateNight, notify: captureNotifier().notify });
    expect(await code(add(fx, 0, 3, { now: lateNight }))).toBe("daily_limit_reached");

    // Thirty minutes later it is Nov 3 in ET: the allowance is back.
    const afterMidnight = new Date("2026-11-03T05:00:00Z");
    expect((await getAddsToday(db, fx.teams[0].id, 2, afterMidnight)).remaining).toBe(2);
    expect(await code(add(fx, 0, 3, { now: afterMidnight }))).toBe("ok");
    expect(await code(add(fx, 0, 5, { now: afterMidnight }))).toBe("ok");
    expect(await code(add(fx, 0, 6, { now: afterMidnight }))).toBe("daily_limit_reached");
  });

  it("honours the addsPerDay league setting", async () => {
    const fx = await seasonLeague(db, 2, { max: 10, settings: { addsPerDay: 1 } });
    await add(fx, 0, 1);
    expect(await code(add(fx, 0, 2))).toBe("daily_limit_reached");
  });

  it("rejects an add at the roster max but allows add + drop as one action", async () => {
    const fx = await seasonLeague(db, 2, { max: 3 }); // 2 teams, cap 3
    const earlier = new Date("2026-10-30T17:00:00Z");
    for (const id of [1, 2, 3]) await rosterPlayer(db, fx, 0, id);
    expect(await code(add(fx, 0, 10, { now: earlier }))).toBe("roster_full");

    expect(await code(add(fx, 0, 10, { dropPlayerId: 99 }))).toBe("not_on_roster");
    expect(await code(add(fx, 0, 10, { dropPlayerId: 20 }))).toBe("not_on_roster");
    expect(await active(fx, 0)).toEqual([1, 2, 3]);

    await add(fx, 0, 10, { dropPlayerId: 2 });
    expect(await active(fx, 0)).toEqual([1, 3, 10]);
    const txns = await db.select().from(transactions);
    expect(txns.map((t) => t.type).sort()).toEqual(["add", "drop"]);
    expect(new Set(txns.map((t) => t.groupId)).size).toBe(1);
    expect(txns[0].groupId).toBeTruthy();
    // The drop doesn't use up the allowance; the add does.
    expect((await getAddsToday(db, fx.teams[0].id, 2, NOON)).used).toBe(1);
    const released = await db.select().from(rosterEntries).where(eq(rosterEntries.playerId, 2));
    expect(released[0]).toMatchObject({ releasedVia: "drop" });
    expect(released[0].releasedAt).toEqual(NOON);
  });

  it("allows a team under the max to add without dropping, but never exceed it", async () => {
    const fx = await seasonLeague(db, 2, { max: 3 });
    await add(fx, 0, 1);
    await add(fx, 0, 2);
    await add(fx, 0, 3, { now: new Date("2026-11-03T17:00:00Z") });
    expect(await code(add(fx, 0, 4, { now: new Date("2026-11-03T17:05:00Z") }))).toBe("roster_full");
  });

  it("derives the max from the formula for the league's team count (cap 50, pool 520)", async () => {
    const fx = await seasonLeague(db, 2, { max: 50 });
    // 2 teams -> min(50, 260) = 50: a roster of 49 still has room.
    expect(await code(add(fx, 0, 1))).toBe("ok");
  });
});

describe("dropPlayer", () => {
  it("drops an owned player and logs it; rejects other teams' players and non-owners", async () => {
    const fx = await seasonLeague(db, 2);
    await rosterPlayer(db, fx, 0, 1);
    await rosterPlayer(db, fx, 1, 2);
    const drop = (team: number, playerId: number, actor = ownerOf(fx, team)) =>
      dropPlayer(db, { leagueId: fx.league.id, teamId: fx.teams[team].id, playerId, actorUserId: actor }, { now: NOON, notify: captureNotifier().notify });
    expect(await code(drop(0, 2))).toBe("not_on_roster");
    expect(await code(drop(0, 1, ownerOf(fx, 1)))).toBe("forbidden");
    expect(await code(drop(0, 1))).toBe("ok");
    expect(await code(drop(0, 1))).toBe("not_on_roster");
    expect(await active(fx, 0)).toEqual([]);
    const [t] = await db.select().from(transactions);
    expect(t).toMatchObject({ type: "drop", playerId: 1 });
    // The dropped player is a free agent again.
    expect(await code(add(fx, 1, 1))).toBe("ok");
  });

  it("is blocked while the league is not in season", async () => {
    const fx = await seasonLeague(db, 2, { status: "setup" });
    await rosterPlayer(db, fx, 0, 1);
    expect(
      await code(dropPlayer(db, { leagueId: fx.league.id, teamId: fx.teams[0].id, playerId: 1, actorUserId: ownerOf(fx, 0) }, { notify: captureNotifier().notify })),
    ).toBe("wrong_status");
  });
});

describe("commissioner moves", () => {
  it("bypasses the daily limit but not the roster max, and logs commissioner_* types", async () => {
    const fx = await seasonLeague(db, 2, { max: 4 });
    const commish = fx.league.commissionerId;
    const cadd = (playerId: number, dropPlayerId?: number, actor = commish) =>
      commissionerAdd(db, { leagueId: fx.league.id, teamId: fx.teams[1].id, playerId, dropPlayerId, actorUserId: actor }, { now: NOON, notify: captureNotifier().notify });
    expect(await code(cadd(1, undefined, ownerOf(fx, 1)))).toBe("forbidden"); // a normal owner
    for (const id of [1, 2, 3, 4]) expect(await code(cadd(id))).toBe("ok"); // 4 > the 2/day limit
    expect(await code(cadd(5))).toBe("roster_full");
    expect(await code(cadd(5, 1))).toBe("ok");
    const types = (await db.select().from(transactions)).map((t) => t.type);
    expect(types.filter((t) => t === "commissioner_add")).toHaveLength(5);
    expect(types).toContain("commissioner_drop");
    expect(types).not.toContain("add");
    // Commissioner adds don't consume the owner's allowance.
    expect((await getAddsToday(db, fx.teams[1].id, 2, NOON)).used).toBe(0);
    const [entry] = await db.select().from(rosterEntries).where(eq(rosterEntries.playerId, 5));
    expect(entry.acquiredVia).toBe("commissioner");

    await commissionerDrop(db, { leagueId: fx.league.id, teamId: fx.teams[1].id, playerId: 2, actorUserId: commish }, { now: NOON, notify: captureNotifier().notify });
    expect(await active(fx, 1)).toEqual([3, 4, 5]);
  });
});

describe("removeCutPlayers", () => {
  async function setup() {
    const fx = await seasonLeague(db, 2);
    await rosterPlayer(db, fx, 0, 1);
    await rosterPlayer(db, fx, 0, 2);
    await rosterPlayer(db, fx, 1, 3);
    await rosterPlayer(db, fx, 1, 4);
    await db.update(nbaPlayers).set({ active: false, teamId: null }).where(eq(nbaPlayers.id, 1));
    await db.update(nbaPlayers).set({ teamId: null }).where(eq(nbaPlayers.id, 3));
    return fx;
  }

  it("does nothing unless every roster loaded", async () => {
    const fx = await setup();
    const n = captureNotifier();
    expect(await removeCutPlayers(db, { allRostersLoaded: false, now: NOON }, { notify: n.notify })).toEqual({ dropped: 0, skipped: true });
    expect(await active(fx, 0)).toEqual([1, 2]);
    expect(await db.select().from(transactions)).toHaveLength(0);
    expect(n.calls).toHaveLength(0);
  });

  it("releases cut players, logs auto_drop and notifies the owners", async () => {
    const fx = await setup();
    const n = captureNotifier();
    expect(await removeCutPlayers(db, { allRostersLoaded: true, now: NOON }, { notify: n.notify })).toEqual({ dropped: 2, skipped: false });
    expect(await active(fx, 0)).toEqual([2]);
    expect(await active(fx, 1)).toEqual([4]);
    const txns = await db.select().from(transactions);
    expect(txns.map((t) => [t.type, t.actorUserId]).sort()).toEqual([
      ["auto_drop", null],
      ["auto_drop", null],
    ]);
    expect(n.calls.map((c) => [c.type, c.userIds]).sort()).toEqual(
      [
        ["roster_auto_drop", [ownerOf(fx, 0)]],
        ["roster_auto_drop", [ownerOf(fx, 1)]],
      ].sort(),
    );
    const released = await db.select().from(rosterEntries).where(eq(rosterEntries.playerId, 1));
    expect(released[0]).toMatchObject({ releasedVia: "auto_drop" });
    // Idempotent.
    expect(await removeCutPlayers(db, { allRostersLoaded: true, now: NOON }, { notify: n.notify })).toEqual({ dropped: 0, skipped: false });
    expect(n.calls).toHaveLength(2);
  });

  it("also clears players cut during the draft phases", async () => {
    const fx = await seasonLeague(db, 2, { status: "setup" });
    await rosterPlayer(db, fx, 0, 1);
    await db.update(nbaPlayers).set({ teamId: null }).where(eq(nbaPlayers.id, 1));
    expect((await removeCutPlayers(db, { allRostersLoaded: true, now: NOON }, { notify: captureNotifier().notify })).dropped).toBe(1);
  });
});

describe("commissionerRestore", () => {
  async function cutOne() {
    const fx = await seasonLeague(db, 2, { max: 2 });
    await rosterPlayer(db, fx, 0, 1);
    await db.update(nbaPlayers).set({ active: false, teamId: null }).where(eq(nbaPlayers.id, 1));
    await removeCutPlayers(db, { allRostersLoaded: true, now: NOON }, { notify: captureNotifier().notify });
    const [txn] = await db.select().from(transactions).where(and(eq(transactions.type, "auto_drop"), eq(transactions.leagueId, fx.league.id)));
    return { fx, txn };
  }
  const restore = (fx: DraftFixture, transactionId: string, actor = fx.league.commissionerId) =>
    commissionerRestore(db, { transactionId, actorUserId: actor }, { now: NOON, notify: captureNotifier().notify });

  it("puts the player back on the same team and can't be done twice", async () => {
    const { fx, txn } = await cutOne();
    expect((await listTransactions(db, fx.league.id)).rows[0].restorable).toBe(true);
    expect(await code(restore(fx, txn.id, ownerOf(fx, 1)))).toBe("forbidden");
    expect(await code(restore(fx, txn.id))).toBe("ok");
    expect(await active(fx, 0)).toEqual([1]);
    expect(await code(restore(fx, txn.id))).toBe("not_restorable");
    const logged = await db.select().from(transactions).where(eq(transactions.type, "commissioner_add"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ groupId: txn.id, playerId: 1 });
    expect((await listTransactions(db, fx.league.id)).rows.every((r) => !r.restorable)).toBe(true);
  });

  it("needs roster space and a still-unrostered player", async () => {
    const { fx, txn } = await cutOne();
    await rosterPlayer(db, fx, 0, 5);
    await rosterPlayer(db, fx, 0, 6); // max 2 -> full
    expect(await code(restore(fx, txn.id))).toBe("roster_full");

    const other = await cutOne();
    // Someone else already holds the player (e.g. re-signed and added elsewhere).
    await db.update(nbaPlayers).set({ active: true, teamId: 3 }).where(eq(nbaPlayers.id, 1));
    await rosterPlayer(db, other.fx, 1, 1);
    expect(await code(restore(other.fx, other.txn.id))).toBe("not_restorable");
  });

  it("rejects ids that are not auto-drops", async () => {
    const fx = await seasonLeague(db, 2);
    await add(fx, 0, 1);
    const [t] = await db.select().from(transactions);
    expect(await code(restore(fx, t.id))).toBe("not_restorable");
    expect(await code(restore(fx, "not-a-uuid"))).toBe("not_restorable");
  });
});

describe("listTransactions", () => {
  it("filters by team and type and paginates newest first", async () => {
    const fx = await seasonLeague(db, 2, { max: 10 });
    await add(fx, 0, 1, { now: new Date("2026-11-02T17:00:00Z") });
    await add(fx, 1, 2, { now: new Date("2026-11-02T18:00:00Z") });
    await dropPlayer(db, { leagueId: fx.league.id, teamId: fx.teams[0].id, playerId: 1, actorUserId: ownerOf(fx, 0) }, { now: new Date("2026-11-02T19:00:00Z"), notify: captureNotifier().notify });
    const all = await listTransactions(db, fx.league.id);
    expect(all.total).toBe(3);
    expect(all.rows.map((r) => r.type)).toEqual(["drop", "add", "add"]);
    expect(all.rows[0]).toMatchObject({ playerName: "Player 1", teamName: fx.teams[0].name });
    expect((await listTransactions(db, fx.league.id, { teamId: fx.teams[1].id })).rows).toHaveLength(1);
    expect((await listTransactions(db, fx.league.id, { type: "drop" })).rows).toHaveLength(1);
    expect((await listTransactions(db, fx.league.id, { limit: 1, offset: 1 })).rows[0].type).toBe("add");
  });

  it("counts and paginates a trade as ONE entry, never splitting its rows across pages", async () => {
    const fx = await seasonLeague(db, 2, { max: 10 });
    await add(fx, 0, 1, { now: new Date("2026-11-02T17:00:00Z") });
    const group = "11111111-1111-4111-8111-111111111111";
    const when = new Date("2026-11-02T18:00:00Z");
    await db.insert(transactions).values(
      [3, 4, 5, 6].map((playerId, i) => ({
        leagueId: fx.league.id,
        teamId: fx.teams[i % 2].id,
        type: "trade" as const,
        playerId,
        groupId: group,
        etDate: "2026-11-02",
        createdAt: new Date(when.getTime() + i * 1000),
      })),
    );
    await add(fx, 1, 2, { now: new Date("2026-11-02T19:00:00Z") });
    const all = await listTransactions(db, fx.league.id);
    expect(all.total).toBe(3); // add, one trade (4 rows), add
    const page1 = await listTransactions(db, fx.league.id, { limit: 2, offset: 0 });
    const page2 = await listTransactions(db, fx.league.id, { limit: 2, offset: 2 });
    expect(page1.rows.map((r) => r.type)).toEqual(["add", "trade", "trade", "trade", "trade"]);
    expect(page2.rows.map((r) => r.type)).toEqual(["add"]);
  });
});
