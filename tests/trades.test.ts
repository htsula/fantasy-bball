import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leagues, notifications, rosterEntries, tradeBlock, tradeVotes, trades, transactions, type Team, type Trade } from "@/db/schema";
import type { Db } from "@/db/types";
import { teamGamePoints } from "@/lib/fantasy/team-points";
import { addFreeAgent, dropPlayer, removeCutPlayers } from "@/lib/rosters/service";
import {
  TradeError,
  acceptTrade,
  addToTradeBlock,
  cancelTrade,
  castVote,
  commissionerApprove,
  commissionerReverse,
  commissionerVeto,
  counterTrade,
  forceCancelTrade,
  getTrade,
  listLeagueTrades,
  listTradeBlock,
  listTradesForTeam,
  processDueTrades,
  proposeTrade,
  rejectTrade,
  removeFromTradeBlock,
} from "@/lib/trades/service";
import { nbaPlayers } from "@/db/schema";
import { createTestDb } from "./helpers/db";
import { captureNotifier } from "./helpers/draft";
import { boxScore, insertGame, snapshot } from "./helpers/rosters";
import { NOON, stock, tradeCode, tradeLeague, type TradeFixture } from "./helpers/trades";

let db: Db;
let close: () => Promise<void> | void;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

const HOUR = 3_600_000;
const at = (hours: number) => new Date(NOON.getTime() + hours * HOUR);

const propose = (
  fx: TradeFixture,
  from: Team,
  to: Team,
  give: number[],
  get: number[],
  extra: { now?: Date; message?: string; n?: ReturnType<typeof captureNotifier> } = {},
) =>
  proposeTrade(
    db,
    { leagueId: fx.league.id, proposerTeamId: from.id, receiverTeamId: to.id, give, get, message: extra.message, actorUserId: from.ownerId },
    { now: extra.now ?? NOON, notify: (extra.n ?? captureNotifier()).notify },
  );
const accept = (t: Trade | string, by: Team, now = NOON, n = captureNotifier()) =>
  acceptTrade(db, { tradeId: typeof t === "string" ? t : t.id, actorUserId: by.ownerId }, { now, notify: n.notify });
const status = async (t: Trade | string) =>
  (await db.select().from(trades).where(eq(trades.id, typeof t === "string" ? t : t.id)))[0].status;
const roster = async (team: Team) =>
  (
    await db
      .select({ p: rosterEntries.playerId })
      .from(rosterEntries)
      .where(and(eq(rosterEntries.teamId, team.id), isNull(rosterEntries.releasedAt)))
  )
    .map((r) => r.p)
    .sort((a, b) => a - b);

/** Two trading teams (A, B) plus the rest, with A owning 1-3 and B owning 4-6. */
async function standard(settings: Record<string, unknown> = { tradeReview: "none" }, count = 4, max = 10) {
  const fx = await tradeLeague(db, count, settings, max);
  const [a, b, c] = fx.others;
  await stock(db, fx, a, [1, 2, 3]);
  await stock(db, fx, b, [4, 5, 6]);
  await stock(db, fx, fx.commish, [7, 8]);
  return { fx, a, b, c, commish: fx.commish, d: fx.others[3] };
}

describe("proposeTrade validation", () => {
  it("creates a proposal with items in both directions, a 7-day expiry, and notifies the receiver (trade_offers)", async () => {
    const { fx, a, b } = await standard();
    const n = captureNotifier();
    const t = await propose(fx, a, b, [1, 2], [4], { message: "fair?", n });
    expect(t.status).toBe("proposed");
    expect(t.message).toBe("fair?");
    expect(t.expiresAt.toISOString()).toBe("2026-11-09T17:00:00.000Z");
    const [row] = await listLeagueTrades(db, fx.league.id);
    expect(row.give.map((p) => p.playerId).sort()).toEqual([1, 2]);
    expect(row.get.map((p) => p.playerId)).toEqual([4]);
    expect(n.calls).toHaveLength(1);
    expect(n.calls[0]).toMatchObject({ type: "trade_offers", userIds: [b.ownerId] });
  });

  it("allows uneven and one-sided trades", async () => {
    const { fx, a, b } = await standard();
    expect(await tradeCode(propose(fx, a, b, [1, 2, 3], [4]))).toBe("ok");
    expect(await tradeCode(propose(fx, a, b, [], [5]))).toBe("ok");
    expect(await tradeCode(propose(fx, a, b, [1], []))).toBe("ok");
  });

  it("rejects empty, self, duplicate and wrongly owned players", async () => {
    const { fx, a, b, c } = await standard();
    expect(await tradeCode(propose(fx, a, b, [], []))).toBe("empty");
    expect(await tradeCode(propose(fx, a, a, [1], [2]))).toBe("same_team");
    expect(await tradeCode(propose(fx, a, b, [1, 1], [4]))).toBe("duplicate_player");
    expect(await tradeCode(propose(fx, a, b, [4], [5]))).toBe("not_your_player"); // 4 is B's
    expect(await tradeCode(propose(fx, a, b, [1], [2]))).toBe("not_their_player"); // 2 is mine
    expect(await tradeCode(propose(fx, a, b, [1], [30]))).toBe("not_their_player"); // free agent
    expect(await tradeCode(propose(fx, a, c, [1], [4]))).toBe("not_their_player"); // 4 is B's, not C's
    expect(await tradeCode(propose(fx, a, b, [1], [1]))).toBe("player_on_both_sides");
    expect(await tradeCode(propose(fx, a, b, [1], [4], { message: "x".repeat(501) }))).toBe("message_too_long");
  });

  it("can only be proposed by the proposing team's owner", async () => {
    const { fx, a, b } = await standard();
    const code = await tradeCode(
      proposeTrade(db, { leagueId: fx.league.id, proposerTeamId: a.id, receiverTeamId: b.id, give: [1], get: [4], actorUserId: b.ownerId }, { now: NOON, notify: captureNotifier().notify }),
    );
    expect(code).toBe("forbidden");
  });

  it("is only open while the league is in_season", async () => {
    const { fx, a, b } = await standard();
    for (const s of ["setup", "drafting", "playoffs", "complete"] as const) {
      await db.update(leagues).set({ status: s }).where(eq(leagues.id, fx.league.id));
      expect(await tradeCode(propose(fx, a, b, [1], [4]))).toBe("wrong_status");
    }
    await db.update(leagues).set({ status: "in_season" }).where(eq(leagues.id, fx.league.id));
    expect(await tradeCode(propose(fx, a, b, [1], [4]))).toBe("ok");
  });

  it("closes at the end of the deadline's ET day", async () => {
    const { fx, a, b } = await standard({ tradeReview: "none", tradeDeadline: "2026-11-10" });
    expect(await tradeCode(propose(fx, a, b, [1], [4], { now: new Date("2026-11-11T04:59:59Z") }))).toBe("ok");
    expect(await tradeCode(propose(fx, a, b, [1], [4], { now: new Date("2026-11-11T05:00:00Z") }))).toBe("deadline_passed");
  });
});

describe("respond: accept (review none)", () => {
  it("executes immediately: swaps rosters at one timestamp, logs grouped trade transactions, notifies", async () => {
    const { fx, a, b, c } = await standard();
    const t = await propose(fx, a, b, [1, 2], [4]);
    const n = captureNotifier();
    const res = await accept(t, b, at(1), n);
    expect(res.status).toBe("executed");
    expect(await roster(a)).toEqual([3, 4]);
    expect(await roster(b)).toEqual([1, 2, 5, 6]);

    const moved = await db.select().from(rosterEntries).where(eq(rosterEntries.acquiredVia, "trade"));
    expect(moved.map((m) => m.acquiredAt.getTime())).toEqual([at(1).getTime(), at(1).getTime(), at(1).getTime()]);
    const released = await db.select().from(rosterEntries).where(eq(rosterEntries.releasedVia, "trade"));
    expect(released).toHaveLength(3);
    expect(released.every((r) => r.releasedAt!.getTime() === at(1).getTime())).toBe(true);

    const txns = await db.select().from(transactions).where(eq(transactions.type, "trade"));
    expect(txns).toHaveLength(3);
    expect(new Set(txns.map((x) => x.groupId))).toEqual(new Set([t.id]));
    expect(txns.find((x) => x.playerId === 4)!.teamId).toBe(a.id);
    expect(txns.find((x) => x.playerId === 1)!.teamId).toBe(b.id);

    const [row] = await db.select().from(trades).where(eq(trades.id, t.id));
    expect(row.executedAt).toEqual(at(1));
    // Parties get trade_updates; everyone else a (in-app) league_transactions notice.
    const updates = n.calls.find((x) => x.type === "trade_updates")!;
    expect(updates.userIds.sort()).toEqual([a.ownerId, b.ownerId].sort());
    const league = n.calls.find((x) => x.type === "league_transactions")!;
    expect(league.userIds).not.toContain(a.ownerId);
    expect(league.userIds).toContain(c.ownerId);
  });

  it("only the receiver can accept, reject or counter; the proposer can't accept", async () => {
    const { fx, a, b, c } = await standard();
    const t = await propose(fx, a, b, [1], [4]);
    expect(await tradeCode(accept(t, a))).toBe("forbidden");
    expect(await tradeCode(accept(t, c))).toBe("forbidden");
    expect(await tradeCode(rejectTrade(db, { tradeId: t.id, actorUserId: a.ownerId }))).toBe("forbidden");
    expect(await tradeCode(counterTrade(db, { tradeId: t.id, give: [4], get: [1], actorUserId: c.ownerId }))).toBe("forbidden");
    expect(await tradeCode(accept(t, b))).toBe("ok");
    expect(await tradeCode(accept(t, b))).toBe("wrong_state");
  });

  it("a game tipping after execution scores for the new team; one before, for the old team", async () => {
    const { fx, a, b } = await standard();
    await insertGame(db, 1, at(-1), "final"); // before the trade
    await insertGame(db, 2, at(2), "final"); // after the trade
    for (const g of [1, 2]) {
      await snapshot(db, g, 1, 1);
      await boxScore(db, g, 1, 1, { pts: 10 });
    }
    const t = await propose(fx, a, b, [1], [4]);
    await accept(t, b, at(1));
    const gamesOf = async (team: Team) => (await teamGamePoints(db, team.id)).filter((r) => r.playerId === 1).map((r) => r.gameId);
    expect(await gamesOf(a)).toEqual([1]);
    expect(await gamesOf(b)).toEqual([2]);
  });

  it("a game tipping at the exact execution instant belongs to the new team (no double count)", async () => {
    const { fx, a, b } = await standard();
    await insertGame(db, 3, at(1), "in", 1, 2, null);
    await snapshot(db, 3, 1, 1);
    const t = await propose(fx, a, b, [1], [4]);
    await accept(t, b, at(1));
    expect((await teamGamePoints(db, a.id)).filter((r) => r.playerId === 1)).toHaveLength(0);
    expect((await teamGamePoints(db, b.id)).filter((r) => r.playerId === 1)).toHaveLength(1);
  });

  it("refuses to execute when a side would exceed the roster max (roster_full) and leaves the offer open", async () => {
    const { fx, a, b } = await standard({ tradeReview: "none" }, 4, 4);
    await stock(db, fx, b, [9]); // B now has 4 of 4
    const t = await propose(fx, a, b, [1, 2], [4]); // B would go to 5
    expect(await tradeCode(accept(t, b))).toBe("roster_full");
    expect(await status(t)).toBe("proposed");
    expect(await roster(b)).toEqual([4, 5, 6, 9]);
    // After dropping a player the same offer can be accepted.
    await dropPlayer(db, { leagueId: fx.league.id, teamId: b.id, playerId: 9, actorUserId: b.ownerId }, { now: NOON, notify: captureNotifier().notify });
    expect(await tradeCode(accept(t, b))).toBe("ok");
    expect(await roster(b)).toEqual([1, 2, 5, 6]);
  });

  it("allows a trade that leaves a full roster at the max (swap) and one that shrinks the other side", async () => {
    const { fx, a, b } = await standard({ tradeReview: "none" }, 4, 3);
    const t = await propose(fx, a, b, [1, 2], [4, 5]);
    expect(await tradeCode(accept(t, b))).toBe("ok");
    expect(await roster(a)).toEqual([3, 4, 5]);
  });

  it("rejects when the deadline has passed at accept time", async () => {
    const { fx, a, b } = await standard({ tradeReview: "none", tradeDeadline: "2026-11-03" });
    const t = await propose(fx, a, b, [1], [4]);
    expect(await tradeCode(accept(t, b, new Date("2026-11-04T05:00:00Z")))).toBe("deadline_passed");
    expect(await tradeCode(accept(t, b, new Date("2026-11-04T04:59:00Z")))).toBe("ok");
  });
});

describe("reject, cancel, counter, expiry", () => {
  it("reject notifies the proposer; cancel by the proposer notifies the receiver; both are terminal", async () => {
    const { fx, a, b } = await standard();
    const t1 = await propose(fx, a, b, [1], [4]);
    const n1 = captureNotifier();
    await rejectTrade(db, { tradeId: t1.id, actorUserId: b.ownerId }, { now: NOON, notify: n1.notify });
    expect(await status(t1)).toBe("rejected");
    expect(n1.calls[0]).toMatchObject({ type: "trade_updates", userIds: [a.ownerId] });
    expect(await tradeCode(accept(t1, b))).toBe("wrong_state");

    const t2 = await propose(fx, a, b, [2], [5]);
    expect(await tradeCode(cancelTrade(db, { tradeId: t2.id, actorUserId: b.ownerId }))).toBe("forbidden");
    const n2 = captureNotifier();
    await cancelTrade(db, { tradeId: t2.id, actorUserId: a.ownerId }, { now: NOON, notify: n2.notify });
    expect(await status(t2)).toBe("cancelled");
    expect(n2.calls[0]).toMatchObject({ type: "trade_updates", userIds: [b.ownerId] });
    expect(await tradeCode(accept(t2, b))).toBe("wrong_state");
  });

  it("a counter creates a linked proposal in the other direction and marks the original countered", async () => {
    const { fx, a, b } = await standard();
    const t1 = await propose(fx, a, b, [1, 2], [4]);
    const n = captureNotifier();
    const t2 = await counterTrade(db, { tradeId: t1.id, give: [4, 5], get: [1], message: "how about", actorUserId: b.ownerId }, { now: at(1), notify: n.notify });
    expect(await status(t1)).toBe("countered");
    expect(t2).toMatchObject({ status: "proposed", counteredFrom: t1.id, proposerTeamId: b.id, receiverTeamId: a.id });
    expect(n.calls[0]).toMatchObject({ type: "trade_offers", userIds: [a.ownerId] });
    // The original can't be accepted any more; the counter can, and it can be countered again.
    expect(await tradeCode(accept(t1, b))).toBe("wrong_state");
    const t3 = await counterTrade(db, { tradeId: t2.id, give: [1], get: [4], actorUserId: a.ownerId }, { now: at(2), notify: n.notify });
    expect(t3.counteredFrom).toBe(t2.id);
    expect(await status(t2)).toBe("countered");
    await accept(t3, b, at(3));
    expect(await roster(a)).toEqual([2, 3, 4]);
    const detail = await getTrade(db, fx.league.id, t2.id, a.ownerId, at(3));
    expect(detail!.counteredBy).toBe(t3.id);
  });

  it("counter validates its own lists", async () => {
    const { fx, a, b } = await standard();
    const t = await propose(fx, a, b, [1], [4]);
    expect(await tradeCode(counterTrade(db, { tradeId: t.id, give: [1], get: [4], actorUserId: b.ownerId }))).toBe("not_your_player");
    expect(await tradeCode(counterTrade(db, { tradeId: t.id, give: [], get: [], actorUserId: b.ownerId }))).toBe("empty");
    expect(await status(t)).toBe("proposed"); // a failed counter doesn't consume the original
  });

  it("proposals expire after 7 days, lazily on action and via processDueTrades", async () => {
    const { fx, a, b } = await standard();
    const t1 = await propose(fx, a, b, [1], [4]);
    const t2 = await propose(fx, a, b, [2], [5]);
    const justBefore = at(7 * 24 - 0.01);
    expect((await processDueTrades(db, justBefore, { notify: captureNotifier().notify })).expired).toBe(0);
    // Accepting after the 7 days refuses and marks it expired (committed).
    expect(await tradeCode(accept(t1, b, at(7 * 24)))).toBe("expired");
    expect(await status(t1)).toBe("expired");
    const n = captureNotifier();
    const res = await processDueTrades(db, at(7 * 24), { notify: n.notify });
    expect(res.expired).toBe(1);
    expect(await status(t2)).toBe("expired");
    expect(n.calls[0].userIds.sort()).toEqual([a.ownerId, b.ownerId].sort());
    expect((await processDueTrades(db, at(8 * 24))).expired).toBe(0); // idempotent
  });
});

describe("commissioner review", () => {
  const review = { tradeReview: "commissioner", tradeReviewHours: 24 };

  it("accept goes to pending_review with a window and asks the commissioner (trade_review)", async () => {
    const { fx, a, b, commish } = await standard(review);
    const t = await propose(fx, a, b, [1], [4]);
    const n = captureNotifier();
    expect((await accept(t, b, at(1), n)).status).toBe("pending_review");
    const [row] = await db.select().from(trades).where(eq(trades.id, t.id));
    expect(row.reviewEndsAt).toEqual(at(25));
    expect(await roster(a)).toEqual([1, 2, 3]); // nothing moved yet
    expect(n.calls.find((x) => x.type === "trade_review")).toMatchObject({ userIds: [commish.ownerId] });
    expect(n.calls.find((x) => x.type === "trade_updates")).toMatchObject({ userIds: [a.ownerId] });
  });

  it("approve executes now; only the commissioner may approve or veto", async () => {
    const { fx, a, b, c, commish } = await standard(review);
    const t = await propose(fx, a, b, [1], [4]);
    await accept(t, b, at(1));
    expect(await tradeCode(commissionerApprove(db, { tradeId: t.id, actorUserId: c.ownerId }))).toBe("forbidden");
    expect(await tradeCode(commissionerVeto(db, { tradeId: t.id, actorUserId: a.ownerId }))).toBe("forbidden");
    await commissionerApprove(db, { tradeId: t.id, actorUserId: commish.ownerId }, { now: at(2), notify: captureNotifier().notify });
    expect(await status(t)).toBe("executed");
    expect(await roster(a)).toEqual([2, 3, 4]);
  });

  it("veto records the reason, notifies both parties and moves nobody", async () => {
    const { fx, a, b, commish } = await standard(review);
    const t = await propose(fx, a, b, [1], [4]);
    await accept(t, b, at(1));
    const n = captureNotifier();
    await commissionerVeto(db, { tradeId: t.id, actorUserId: commish.ownerId, reason: "lopsided" }, { now: at(2), notify: n.notify });
    const [row] = await db.select().from(trades).where(eq(trades.id, t.id));
    expect(row.status).toBe("vetoed");
    expect(row.resolvedReason).toContain("lopsided");
    expect(n.calls[0].userIds.sort()).toEqual([a.ownerId, b.ownerId].sort());
    expect(await roster(a)).toEqual([1, 2, 3]);
    expect(await tradeCode(commissionerApprove(db, { tradeId: t.id, actorUserId: commish.ownerId }))).toBe("wrong_state");
  });

  it("the commissioner may approve a trade they are a party to; it is logged on the trade and its transactions", async () => {
    const { fx, a, commish } = await standard(review);
    const t = await propose(fx, a, commish, [1], [7]);
    await accept(t, commish, at(1));
    await commissionerApprove(db, { tradeId: t.id, actorUserId: commish.ownerId }, { now: at(2), notify: captureNotifier().notify });
    const [row] = await db.select().from(trades).where(eq(trades.id, t.id));
    expect(row.status).toBe("executed");
    expect(row.resolvedReason).toContain("party");
    const txns = await db.select().from(transactions).where(eq(transactions.type, "trade"));
    expect(txns.every((x) => x.note?.includes("party"))).toBe(true);
  });

  it("auto-approves (executes) when the window ends without action, not before", async () => {
    const { fx, a, b } = await standard(review);
    const t = await propose(fx, a, b, [1], [4]);
    await accept(t, b, at(1));
    expect((await processDueTrades(db, at(24.99), { notify: captureNotifier().notify })).executed).toBe(0);
    expect(await status(t)).toBe("pending_review");
    const n = captureNotifier();
    const res = await processDueTrades(db, at(25), { notify: n.notify });
    expect(res.executed).toBe(1);
    expect(await status(t)).toBe("executed");
    expect(await roster(b)).toEqual([1, 5, 6]);
    const [row] = await db.select().from(trades).where(eq(trades.id, t.id));
    expect(row.executedAt).toEqual(at(25));
    expect(n.calls.some((x) => x.type === "trade_updates")).toBe(true);
  });

  it("a trade accepted before the deadline still executes after the deadline passes", async () => {
    const { fx, a, b } = await standard({ ...review, tradeDeadline: "2026-11-02" });
    const t = await propose(fx, a, b, [1], [4]);
    await accept(t, b, at(1));
    await processDueTrades(db, at(30), { notify: captureNotifier().notify }); // Nov 3 ET
    expect(await status(t)).toBe("executed");
  });

  it("at window end a trade that no longer fits is invalidated rather than left pending", async () => {
    const { fx, a, b } = await standard({ ...review }, 4, 4);
    const t = await propose(fx, a, b, [1, 2], [4]);
    await accept(t, b, at(1));
    await stock(db, fx, b, [9]); // B fills up during the review
    const n = captureNotifier();
    const res = await processDueTrades(db, at(25), { notify: n.notify });
    expect(res.invalidated).toBe(1);
    expect(await status(t)).toBe("invalidated");
    expect(n.calls[0]).toMatchObject({ type: "trade_updates" });
    // Manual approval of such a trade fails instead, leaving it pending.
    const t2 = await propose(fx, a, b, [1, 2], [4], { now: at(30) });
    await accept(t2, b, at(31));
    expect(await tradeCode(commissionerApprove(db, { tradeId: t2.id, actorUserId: fx.commish.ownerId }, { now: at(32) }))).toBe("roster_full");
    expect(await status(t2)).toBe("pending_review");
  });
});

describe("league vote", () => {
  const vote = { tradeReview: "league_vote", tradeReviewHours: 24, vetoVotesNeeded: 2 };
  const cast = (t: Trade, by: Team, v: "veto" | "approve" = "veto", now = at(2), n = captureNotifier()) =>
    castVote(db, { tradeId: t.id, actorUserId: by.ownerId, vote: v }, { now, notify: n.notify });

  it("asks only the non-party teams to vote, in-app only", async () => {
    const { fx, a, b, c, commish } = await standard(vote, 5);
    const t = await propose(fx, a, b, [1], [4]);
    const n = captureNotifier();
    await accept(t, b, at(1), n);
    const ask = n.calls.find((x) => x.type === "trade_review")!;
    expect(ask.userIds.sort()).toEqual([c.ownerId, commish.ownerId, fx.others[3].ownerId].sort());
    expect(ask.skipPush).toBe(true);
  });

  it("vetoes immediately at the threshold; parties and repeat voters can't vote", async () => {
    const { fx, a, b, c, commish } = await standard(vote, 5);
    const t = await propose(fx, a, b, [1], [4]);
    await accept(t, b, at(1));
    expect(await tradeCode(cast(t, a))).toBe("not_eligible");
    expect(await tradeCode(cast(t, b))).toBe("not_eligible");
    expect((await cast(t, c)).status).toBe("pending_review");
    expect(await tradeCode(cast(t, c))).toBe("already_voted");
    const n = captureNotifier();
    const res = await cast(t, commish, "veto", at(3), n);
    expect(res).toMatchObject({ status: "vetoed", vetoVotes: 2, threshold: 2 });
    expect(await status(t)).toBe("vetoed");
    expect(await roster(a)).toEqual([1, 2, 3]);
    expect(n.calls[0].userIds.sort()).toEqual([a.ownerId, b.ownerId].sort());
  });

  it("approve votes are stored but don't count toward a veto", async () => {
    const { fx, a, b, c, commish } = await standard(vote, 5);
    const t = await propose(fx, a, b, [1], [4]);
    await accept(t, b, at(1));
    await cast(t, c, "approve");
    expect((await cast(t, commish, "veto")).status).toBe("pending_review");
    const rows = await db.select().from(tradeVotes).where(eq(tradeVotes.tradeId, t.id));
    expect(rows.map((r) => r.vote).sort()).toEqual(["approve", "veto"]);
  });

  it("caps the threshold at the number of eligible voters (4 needed, 1 voter)", async () => {
    const { fx, a, b } = await standard({ ...vote, vetoVotesNeeded: 4 }, 3);
    const t = await propose(fx, a, b, [1], [4]);
    await accept(t, b, at(1));
    const res = await cast(t, fx.commish);
    expect(res).toMatchObject({ status: "vetoed", threshold: 1 });
  });

  it("executes at window end when not vetoed, and voting closes then", async () => {
    const { fx, a, b, c } = await standard(vote, 5);
    const t = await propose(fx, a, b, [1], [4]);
    await accept(t, b, at(1));
    await cast(t, c);
    expect(await tradeCode(cast(t, fx.commish, "veto", at(25)))).toBe("review_closed");
    const res = await processDueTrades(db, at(25), { notify: captureNotifier().notify });
    expect(res.executed).toBe(1);
    expect(await roster(a)).toEqual([2, 3, 4]);
  });

  it("commissioner approve/veto are not available in league_vote mode", async () => {
    const { fx, a, b, commish } = await standard(vote, 5);
    const t = await propose(fx, a, b, [1], [4]);
    await accept(t, b, at(1));
    expect(await tradeCode(commissionerApprove(db, { tradeId: t.id, actorUserId: commish.ownerId }))).toBe("wrong_state");
    // ...but the commissioner can still force-cancel.
    await forceCancelTrade(db, { tradeId: t.id, actorUserId: commish.ownerId, reason: "x" }, { now: at(2), notify: captureNotifier().notify });
    expect(await status(t)).toBe("cancelled");
  });
});

describe("invalidation", () => {
  it("executing a trade invalidates other open trades that share a player, and tells both parties", async () => {
    const { fx, a, b, c } = await standard();
    const t1 = await propose(fx, a, b, [1], [4]);
    const t2 = await propose(fx, a, c, [1], []); // the same player offered to someone else
    const t3 = await propose(fx, b, c, [5], []); // unrelated
    const n = captureNotifier();
    await accept(t1, b, at(1), n);
    expect(await status(t1)).toBe("executed");
    expect(await status(t2)).toBe("invalidated");
    expect(await status(t3)).toBe("proposed");
    const inv = n.calls.filter((x) => x.type === "trade_updates" && x.title === "Trade no longer valid");
    expect(inv).toHaveLength(1);
    expect(inv[0].userIds.sort()).toEqual([a.ownerId, c.ownerId].sort());
  });

  it("dropping a player invalidates open (proposed and pending_review) trades containing him", async () => {
    const { fx, a, b, c } = await standard({ tradeReview: "commissioner", tradeReviewHours: 24 });
    const open = await propose(fx, a, b, [1], [4]);
    const reviewing = await propose(fx, a, c, [2], []);
    await accept(reviewing, c, at(1));
    const other = await propose(fx, b, c, [5], []);
    const n = captureNotifier();
    await dropPlayer(db, { leagueId: fx.league.id, teamId: a.id, playerId: 1, actorUserId: a.ownerId }, { now: at(2), notify: n.notify });
    expect(await status(open)).toBe("invalidated");
    expect(await status(reviewing)).toBe("pending_review");
    await dropPlayer(db, { leagueId: fx.league.id, teamId: a.id, playerId: 2, actorUserId: a.ownerId }, { now: at(2), notify: n.notify });
    expect(await status(reviewing)).toBe("invalidated");
    expect(await status(other)).toBe("proposed");
    expect(n.calls.filter((x) => x.title === "Trade no longer valid").map((x) => x.userIds.sort())).toEqual([
      [a.ownerId, b.ownerId].sort(),
      [a.ownerId, c.ownerId].sort(),
    ]);
  });

  it("dropping a player in a free-agent add (add + drop) invalidates too", async () => {
    const { fx, a, b } = await standard();
    const t = await propose(fx, a, b, [1], [4]);
    await addFreeAgent(
      db,
      { leagueId: fx.league.id, teamId: a.id, playerId: 30, dropPlayerId: 1, actorUserId: a.ownerId },
      { now: NOON, notify: captureNotifier().notify },
    );
    expect(await status(t)).toBe("invalidated");
  });

  it("an NBA auto-drop invalidates open trades containing the cut player", async () => {
    const { fx, a, b } = await standard();
    const t = await propose(fx, a, b, [1], [4]);
    await db.update(nbaPlayers).set({ teamId: null, active: false }).where(eq(nbaPlayers.id, 4));
    await removeCutPlayers(db, { allRostersLoaded: true, now: at(1) }, { notify: captureNotifier().notify });
    expect(await status(t)).toBe("invalidated");
  });

  it("accepting a stale trade (player already gone) invalidates it with players_moved", async () => {
    const { fx, a, b } = await standard();
    const t = await propose(fx, a, b, [1], [4]);
    // Simulate a player leaving without going through the hooked services.
    await db.update(rosterEntries).set({ releasedAt: at(1), releasedVia: "drop" }).where(and(eq(rosterEntries.playerId, 1), isNull(rosterEntries.releasedAt)));
    expect(await tradeCode(accept(t, b, at(2)))).toBe("players_moved");
    expect(await status(t)).toBe("invalidated");
    expect(await roster(b)).toEqual([4, 5, 6]);
  });

  it("two simultaneous accepts of trades sharing a player: one executes, the other is invalidated", async () => {
    const { fx, a, b, c } = await standard();
    const t1 = await propose(fx, a, b, [1], [4]);
    const t2 = await propose(fx, a, c, [1], []);
    const results = await Promise.allSettled([accept(t1, b, at(1)), accept(t2, c, at(1))]);
    const statuses = [await status(t1), await status(t2)].sort();
    expect(statuses).toEqual(["executed", "invalidated"]);
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(failed).toHaveLength(1);
    expect((failed[0].reason as TradeError).code).toBe("players_moved");
    expect(failed[0].reason).toBeInstanceOf(TradeError);
    const holders = await db
      .select()
      .from(rosterEntries)
      .where(and(eq(rosterEntries.playerId, 1), isNull(rosterEntries.releasedAt)));
    expect(holders).toHaveLength(1);
  });
});

describe("commissioner reverse and force-cancel", () => {
  async function executed(settings: Record<string, unknown> = { tradeReview: "none" }) {
    const ctx = await standard(settings);
    const t = await propose(ctx.fx, ctx.a, ctx.b, [1, 2], [4]);
    await accept(t, ctx.b, at(1));
    if ((await status(t)) !== "executed") await processDueTrades(db, at(30), { notify: captureNotifier().notify });
    return { ...ctx, t };
  }

  it("reverses within 48 hours: players go back, a reversal record and commissioner transactions are written", async () => {
    const { fx, a, b, commish, t } = await executed();
    const n = captureNotifier();
    const rev = await commissionerReverse(db, { tradeId: t.id, actorUserId: commish.ownerId, reason: "mistake" }, { now: at(1 + 47), notify: n.notify });
    expect(rev.kind).toBe("reversal");
    expect(await status(t)).toBe("reversed");
    const [orig] = await db.select().from(trades).where(eq(trades.id, t.id));
    expect(orig.reversedByTradeId).toBe(rev.id);
    expect(await roster(a)).toEqual([1, 2, 3]);
    expect(await roster(b)).toEqual([4, 5, 6]);
    const txns = await db.select().from(transactions).where(eq(transactions.groupId, rev.id));
    expect(txns.map((x) => x.type).sort()).toEqual(["commissioner_add", "commissioner_add", "commissioner_add", "commissioner_drop", "commissioner_drop", "commissioner_drop"]);
    expect(n.calls[0]).toMatchObject({ type: "trade_updates" });
    expect(n.calls[0].userIds.sort()).toEqual([a.ownerId, b.ownerId].sort());
    // Reversal records are excluded from "real" trades lists on request and can't be reversed again.
    expect(await tradeCode(commissionerReverse(db, { tradeId: t.id, actorUserId: commish.ownerId }, { now: at(2) }))).toBe("not_reversible");
    expect(await tradeCode(commissionerReverse(db, { tradeId: rev.id, actorUserId: commish.ownerId }, { now: at(2) }))).toBe("not_reversible");
    expect((await listLeagueTrades(db, fx.league.id, { excludeReversals: true })).some((x) => x.id === rev.id)).toBe(false);
  });

  it("refuses after 48 hours, to non-commissioners, and when a player has moved on", async () => {
    const { fx, a, b, c, commish, t } = await executed();
    expect(await tradeCode(commissionerReverse(db, { tradeId: t.id, actorUserId: a.ownerId }, { now: at(2) }))).toBe("forbidden");
    expect(await tradeCode(commissionerReverse(db, { tradeId: t.id, actorUserId: commish.ownerId }, { now: at(1 + 48.01) }))).toBe("not_reversible");
    // Player 4 (now on A) is traded on to C.
    const t2 = await propose(fx, a, c, [4], []);
    await accept(t2, c, at(3));
    expect(await tradeCode(commissionerReverse(db, { tradeId: t.id, actorUserId: commish.ownerId }, { now: at(4) }))).toBe("not_reversible");
    expect(await status(t)).toBe("executed");
    void b;
  });

  it("force-cancel works on proposed and pending trades, for the commissioner only", async () => {
    const { fx, a, b, c, commish } = await standard({ tradeReview: "commissioner", tradeReviewHours: 24 });
    const t1 = await propose(fx, a, b, [1], [4]);
    const t2 = await propose(fx, a, b, [2], [5]);
    await accept(t2, b, at(1));
    expect(await tradeCode(forceCancelTrade(db, { tradeId: t1.id, actorUserId: c.ownerId }))).toBe("forbidden");
    const n = captureNotifier();
    await forceCancelTrade(db, { tradeId: t1.id, actorUserId: commish.ownerId, reason: "spam" }, { now: at(2), notify: n.notify });
    await forceCancelTrade(db, { tradeId: t2.id, actorUserId: commish.ownerId }, { now: at(2), notify: n.notify });
    expect(await status(t1)).toBe("cancelled");
    expect(await status(t2)).toBe("cancelled");
    expect(await tradeCode(forceCancelTrade(db, { tradeId: t1.id, actorUserId: commish.ownerId }))).toBe("wrong_state");
  });
});

describe("read models", () => {
  it("lists trades per team and returns detail with stats, votes and review info", async () => {
    const { fx, a, b, c } = await standard({ tradeReview: "league_vote", tradeReviewHours: 24, vetoVotesNeeded: 2 }, 5);
    const t = await propose(fx, a, b, [1, 2], [4], { message: "hi" });
    await propose(fx, b, c, [5], []);
    expect(await listTradesForTeam(db, fx.league.id, a.id)).toHaveLength(1);
    expect(await listTradesForTeam(db, fx.league.id, b.id)).toHaveLength(2);
    expect(await listTradesForTeam(db, fx.league.id, c.id, { statuses: ["executed"] })).toHaveLength(0);
    await accept(t, b, at(1));
    await castVote(db, { tradeId: t.id, actorUserId: c.ownerId, vote: "veto" }, { now: at(2), notify: captureNotifier().notify });
    const d = (await getTrade(db, fx.league.id, t.id, c.ownerId, at(2)))!;
    expect(d.trade.status).toBe("pending_review");
    expect(d.trade.vetoVotes).toBe(1);
    expect(d.myVote).toBe("veto");
    expect(d.vetoThreshold).toBe(2);
    expect(d.eligibleVoters).toBe(3);
    expect(d.players.map((p) => p.playerId)).toEqual([1, 2, 4]);
    expect(d.players.find((p) => p.playerId === 4)).toMatchObject({ fromTeamId: b.id, toTeamId: a.id });
    expect(await getTrade(db, fx.league.id, "not-a-uuid", null)).toBeNull();
    expect(await getTrade(db, "00000000-0000-4000-8000-000000000000", t.id, null)).toBeNull();
  });
});

describe("trade block", () => {
  it("owners list and unlist their own players; others cannot; traded players leave the block", async () => {
    const { fx, a, b } = await standard();
    const add = (team: Team, playerId: number, by = team, note?: string) =>
      addToTradeBlock(db, { leagueId: fx.league.id, teamId: team.id, playerId, note, actorUserId: by.ownerId }, { now: NOON });
    expect(await tradeCode(add(a, 4))).toBe("not_on_roster");
    expect(await tradeCode(add(a, 1, b))).toBe("forbidden");
    await add(a, 1, a, "need a big");
    await add(a, 1, a, "updated note"); // upsert
    await add(a, 2);
    let block = await listTradeBlock(db, fx.league);
    expect(block.map((e) => e.playerId).sort()).toEqual([1, 2]);
    expect(block.find((e) => e.playerId === 1)).toMatchObject({ note: "updated note", teamId: a.id });
    expect(await tradeCode(removeFromTradeBlock(db, { leagueId: fx.league.id, teamId: a.id, playerId: 2, actorUserId: b.ownerId }))).toBe("forbidden");
    await removeFromTradeBlock(db, { leagueId: fx.league.id, teamId: a.id, playerId: 2, actorUserId: a.ownerId });
    // Player 1 is traded away: gone from the block.
    const t = await propose(fx, a, b, [1], [4]);
    await accept(t, b, at(1));
    block = await listTradeBlock(db, fx.league);
    expect(block).toHaveLength(0);
    expect(await db.select().from(tradeBlock)).toHaveLength(0);
  });

  it("hides entries whose player was dropped even if the row lingers", async () => {
    const { fx, a } = await standard();
    await addToTradeBlock(db, { leagueId: fx.league.id, teamId: a.id, playerId: 3, actorUserId: a.ownerId });
    await db.update(rosterEntries).set({ releasedAt: NOON, releasedVia: "drop" }).where(and(eq(rosterEntries.playerId, 3), isNull(rosterEntries.releasedAt)));
    expect(await listTradeBlock(db, fx.league)).toHaveLength(0);
  });
});

describe("in-app notifications end to end", () => {
  it("writes real in-app notification rows for an offer using the default notifier", async () => {
    const { fx, a, b } = await standard();
    await proposeTrade(db, { leagueId: fx.league.id, proposerTeamId: a.id, receiverTeamId: b.id, give: [1], get: [4], actorUserId: a.ownerId }, { now: NOON });
    const rows = await db.select().from(notifications).where(eq(notifications.userId, b.ownerId));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("trade_offers");
    expect(rows[0].url).toContain(`/leagues/${fx.league.id}/trades/`);
  });
});
