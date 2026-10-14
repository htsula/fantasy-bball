import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityLog, nbaPlayers, users, type Team } from "@/db/schema";
import type { Db } from "@/db/types";
import {
  ACTIVITY_TYPES,
  isCommissionerType,
  listActivity,
  logActivity,
  parseFilter,
  typesForFilter,
  type ActivityType,
} from "@/lib/activity/service";
import { snakeTeam } from "@/lib/draft/engine";
import { makePick, undoLastPick } from "@/lib/draft/service";
import {
  createLeagueInvite,
  redeemLeagueInvite,
  removeTeam,
  renameTeam,
  updateSettings,
} from "@/lib/leagues/service";
import {
  addFreeAgent,
  commissionerAdd,
  commissionerDrop,
  commissionerRestore,
  dropPlayer,
  listTransactions,
  removeCutPlayers,
} from "@/lib/rosters/service";
import {
  acceptTrade,
  rejectTrade,
  commissionerApprove,
  commissionerReverse,
  commissionerVeto,
  forceCancelTrade,
  proposeTrade,
} from "@/lib/trades/service";
import { createTestDb } from "./helpers/db";
import { begin, captureNotifier, createAdmin, pickSnake, seedPlayers, setupLeague } from "./helpers/draft";
import { NOON, stock, tradeLeague, type TradeFixture } from "./helpers/trades";

let db: Db;
let close: () => Promise<void> | void;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

// League fixtures log their own setup (team_joined, settings_changed); tests look at what they did themselves.
const SETUP_NOISE: string[] = ["team_joined", "settings_changed"];
const rows = (leagueId: string, type?: ActivityType) =>
  db
    .select()
    .from(activityLog)
    .where(eq(activityLog.leagueId, leagueId))
    .orderBy(asc(activityLog.createdAt), asc(activityLog.id))
    .then((r) => (type ? r.filter((x) => x.type === type) : r.filter((x) => !SETUP_NOISE.includes(x.type))));

describe("activity vocabulary", () => {
  it("every type has a category and the commissioner filter lists exactly the commissioner-only types", () => {
    const commissioner = typesForFilter("commissioner");
    expect(commissioner.length).toBeGreaterThan(5);
    for (const t of Object.keys(ACTIVITY_TYPES)) {
      expect(commissioner.includes(t as ActivityType)).toBe(isCommissionerType(t));
    }
    expect(isCommissionerType("add")).toBe(false);
    expect(isCommissionerType("commissioner_add")).toBe(true);
    expect(isCommissionerType("score_adjustment")).toBe(true);
    expect(parseFilter("trade")).toBe("trade");
    expect(parseFilter("nonsense")).toBeUndefined();
  });
});

describe("roster moves", () => {
  it("logs adds and drops by owners, commissioner moves with the commissioner as actor, and notifies the affected owner", async () => {
    const fx = await tradeLeague(db, 3, {}, 10, 40);
    const [a, b] = fx.others;
    const n = captureNotifier();
    const L = fx.league.id;

    const t = (m: number) => new Date(NOON.getTime() + m * 60_000);
    await addFreeAgent(db, { leagueId: L, teamId: a.id, playerId: 1, actorUserId: a.ownerId }, { now: t(0), notify: n.notify });
    await dropPlayer(db, { leagueId: L, teamId: a.id, playerId: 1, actorUserId: a.ownerId }, { now: t(1), notify: n.notify });
    await commissionerAdd(db, { leagueId: L, teamId: b.id, playerId: 2, actorUserId: fx.commish.ownerId }, { now: t(2), notify: n.notify });
    await commissionerDrop(db, { leagueId: L, teamId: b.id, playerId: 2, actorUserId: fx.commish.ownerId }, { now: t(3), notify: n.notify });

    const log = await rows(L);
    expect(log.map((r) => [r.type, r.actorUserId])).toEqual([
      ["add", a.ownerId],
      ["drop", a.ownerId],
      ["commissioner_add", fx.commish.ownerId],
      ["commissioner_drop", fx.commish.ownerId],
    ]);
    expect(log[2].summary).toContain(b.name);

    // Only the commissioner moves tell the affected owner (commissioner_actions).
    const told = n.calls.filter((c) => c.type === "commissioner_actions");
    expect(told).toHaveLength(2);
    expect(told.every((c) => c.userIds.length === 1 && c.userIds[0] === b.ownerId)).toBe(true);

    // The commissioner editing his own roster doesn't notify himself.
    const n2 = captureNotifier();
    await commissionerAdd(db, { leagueId: L, teamId: fx.commish.id, playerId: 3, actorUserId: fx.commish.ownerId }, { now: t(4), notify: n2.notify });
    expect(n2.calls.filter((c) => c.type === "commissioner_actions")).toHaveLength(0);
    expect((await rows(L, "commissioner_add")).at(-1)?.actorUserId).toBe(fx.commish.ownerId);
  });

  it("a failed move writes nothing; auto-drops log as a system action; restores log the commissioner", async () => {
    const fx = await tradeLeague(db, 3, {}, 10, 40);
    const [a] = fx.others;
    const L = fx.league.id;
    const n = captureNotifier();
    await expect(
      dropPlayer(db, { leagueId: L, teamId: a.id, playerId: 1, actorUserId: a.ownerId }, { now: NOON, notify: n.notify }),
    ).rejects.toThrow();
    expect(await rows(L)).toHaveLength(0);

    await stock(db, fx, a, [5, 6]);
    await db.update(nbaPlayers).set({ active: false }).where(eq(nbaPlayers.id, 5));
    await removeCutPlayers(db, { allRostersLoaded: true, now: NOON }, { notify: n.notify });
    const cut = await rows(L, "auto_drop");
    expect(cut).toHaveLength(1);
    expect(cut[0].actorUserId).toBeNull();
    expect(cut[0].summary).toContain(a.name);

    await db.update(nbaPlayers).set({ active: true }).where(eq(nbaPlayers.id, 5));
    const { rows: txns } = await listTransactions(db, L, { type: "auto_drop" });
    await commissionerRestore(db, { transactionId: txns[0].id, actorUserId: fx.commish.ownerId }, { now: NOON, notify: n.notify });
    const restored = await rows(L, "commissioner_restore");
    expect(restored).toHaveLength(1);
    expect(restored[0].actorUserId).toBe(fx.commish.ownerId);
  });
});

describe("trades", () => {
  async function standard(settings: Record<string, unknown>) {
    const fx = await tradeLeague(db, 4, settings, 10);
    const [a, b] = fx.others;
    await stock(db, fx, a, [1, 2, 3]);
    await stock(db, fx, b, [4, 5, 6]);
    return { fx, a, b };
  }
  const propose = (fx: TradeFixture, from: Team, to: Team, give: number[], get: number[]) =>
    proposeTrade(db, { leagueId: fx.league.id, proposerTeamId: from.id, receiverTeamId: to.id, give, get, actorUserId: from.ownerId }, { now: NOON, notify: captureNotifier().notify });

  it("logs the offer and the executed trade with the players each side receives", async () => {
    const { fx, a, b } = await standard({ tradeReview: "none" });
    const t = await propose(fx, a, b, [1], [4]);
    await acceptTrade(db, { tradeId: t.id, actorUserId: b.ownerId }, { now: new Date(NOON.getTime() + 60_000), notify: captureNotifier().notify });
    const log = await rows(fx.league.id);
    expect(log.map((r) => r.type)).toEqual(["trade_proposed", "trade_accepted", "trade_executed"]);
    expect(log[0].actorUserId).toBe(a.ownerId);
    expect(log[1].actorUserId).toBe(b.ownerId);
    expect(log[2].actorUserId).toBe(b.ownerId);
    expect(log[2].summary).toContain("Player 4");
    expect(log[2].summary).toContain("Player 1");
    expect((log[2].data as { tradeId: string }).tradeId).toBe(t.id);
  });

  it("logs a rejected offer", async () => {
    const { fx, a, b } = await standard({ tradeReview: "none" });
    const t = await propose(fx, a, b, [1], [4]);
    await rejectTrade(db, { tradeId: t.id, actorUserId: b.ownerId }, { now: new Date(NOON.getTime() + 60_000), notify: captureNotifier().notify });
    expect((await rows(fx.league.id)).map((r) => r.type)).toEqual(["trade_proposed", "trade_rejected"]);
  });

  it("logs every commissioner trade action with the commissioner as actor", async () => {
    const { fx, a, b } = await standard({ tradeReview: "commissioner", tradeReviewHours: 24 });
    const L = fx.league.id;
    const n = captureNotifier();
    const accepted = async (give: number[], get: number[]) => {
      const t = await propose(fx, a, b, give, get);
      await acceptTrade(db, { tradeId: t.id, actorUserId: b.ownerId }, { now: NOON, notify: n.notify });
      return t;
    };
    const veto = await accepted([1], [4]);
    await commissionerVeto(db, { tradeId: veto.id, actorUserId: fx.commish.ownerId, reason: "lopsided" }, { now: NOON, notify: n.notify });
    const approve = await accepted([2], [5]);
    await commissionerApprove(db, { tradeId: approve.id, actorUserId: fx.commish.ownerId }, { now: NOON, notify: n.notify });
    await commissionerReverse(db, { tradeId: approve.id, actorUserId: fx.commish.ownerId, reason: "mistake" }, { now: NOON, notify: n.notify });
    const open = await propose(fx, a, b, [3], [6]);
    await forceCancelTrade(db, { tradeId: open.id, actorUserId: fx.commish.ownerId, reason: "stale" }, { now: NOON, notify: n.notify });

    const commissionerRows = (await rows(L)).filter((r) => r.type.startsWith("trade_commissioner_"));
    expect(commissionerRows.map((r) => r.type).sort()).toEqual([
      "trade_commissioner_approved",
      "trade_commissioner_cancelled",
      "trade_commissioner_reversed",
      "trade_commissioner_vetoed",
    ]);
    expect(commissionerRows.every((r) => r.actorUserId === fx.commish.ownerId)).toBe(true);
    expect(commissionerRows.find((r) => r.type === "trade_commissioner_vetoed")?.data).toMatchObject({ reason: "lopsided" });
    // The approval also produced the executed-trade line.
    expect((await rows(L, "trade_executed")).length).toBeGreaterThanOrEqual(1);
  });
});

describe("draft", () => {
  it("logs the start, commissioner picks and undos (with actor), and the completion; normal picks are not logged", async () => {
    const admin = await createAdmin(db);
    const ids = await seedPlayers(db, 20);
    const fx = await setupLeague(db, admin, 2, { rosterPool: 4, snakeTarget: 100 });
    const L = fx.league.id;
    const n = captureNotifier();
    const draft = await begin(db, fx, n.deps);

    await pickSnake(db, fx, draft, 1, ids[0], n.deps); // a normal pick
    const t2 = snakeTeam(draft.order, 2);
    await makePick(db, draft.id, t2, ids[1], admin.id, { asCommissioner: true, notify: n.notify });
    await undoLastPick(db, draft.id, admin.id, n.deps);
    await makePick(db, draft.id, t2, ids[1], fx.owner.get(t2)!, { notify: n.notify });
    await pickSnake(db, fx, draft, 3, ids[2], n.deps);
    await pickSnake(db, fx, draft, 4, ids[3], n.deps);

    const log = await rows(L);
    expect(log.map((r) => r.type).sort()).toEqual(["draft_commissioner_pick", "draft_completed", "draft_started", "draft_undo"]);
    const actorOf = (t: ActivityType) => log.find((r) => r.type === t)!.actorUserId;
    expect(actorOf("draft_started")).toBe(admin.id);
    expect(actorOf("draft_commissioner_pick")).toBe(admin.id);
    expect(actorOf("draft_undo")).toBe(admin.id);
    expect(actorOf("draft_completed")).toBeNull();
  });
});

describe("settings and teams", () => {
  it("logs what changed in the settings (and nothing when nothing changed)", async () => {
    const admin = await createAdmin(db);
    const fx = await setupLeague(db, admin, 2);
    const L = fx.league.id;
    const before = (await rows(L, "settings_changed")).length;
    await updateSettings(db, admin, L, { addsPerDay: 2 }); // same as before... but setupLeague set other keys, so make it a no-op
    expect((await rows(L, "settings_changed")).length).toBe(before);
    await updateSettings(db, admin, L, { addsPerDay: 5, scoring: { pts: 2 } });
    const log = await rows(L, "settings_changed");
    const last = log.at(-1)!;
    expect(last.actorUserId).toBe(admin.id);
    expect(last.summary).toContain("addsPerDay");
    expect(last.summary).toContain("pts 1 to 2");
    const changes = (last.data as { changes: { key: string; from: unknown; to: unknown }[] }).changes;
    expect(changes.find((c) => c.key === "addsPerDay")).toMatchObject({ from: 2, to: 5 });
  });

  it("logs renames (owner vs commissioner), joins and removals", async () => {
    const admin = await createAdmin(db);
    const fx = await setupLeague(db, admin, 3);
    const L = fx.league.id;
    const member = fx.teams.find((t) => t.ownerId !== admin.id)!;
    const memberActor = { id: member.ownerId, isSiteAdmin: false };

    await renameTeam(db, memberActor, member.id, { name: "Renamed By Owner" });
    await renameTeam(db, admin, member.id, { name: "Renamed By Boss", abbrev: "RBB" });
    await renameTeam(db, admin, member.id, { name: "Renamed By Boss", abbrev: "RBB" }); // no change: no log

    const { token } = await createLeagueInvite(db, admin, L);
    const joined = await redeemLeagueInvite(db, { token, username: "newbie", password: "password123", teamName: "Newbies", teamAbbrev: "NEW" });
    await removeTeam(db, admin, joined.team.id);

    const log = await rows(L);
    const byType = (t: ActivityType) => log.filter((r) => r.type === t);
    expect(byType("team_renamed")).toHaveLength(1);
    expect(byType("team_renamed")[0].actorUserId).toBe(member.ownerId);
    expect(byType("commissioner_team_edit")).toHaveLength(1);
    expect(byType("commissioner_team_edit")[0].actorUserId).toBe(admin.id);
    expect((await rows(L, "team_joined")).length).toBe(3); // two from setupLeague's invites, plus newbie
    expect(byType("team_removed")).toHaveLength(1);
    expect(byType("team_removed")[0]).toMatchObject({ actorUserId: admin.id });
  });
});

describe("listActivity", () => {
  it("filters by category and commissioner-only, joins actor usernames and paginates newest first", async () => {
    const admin = await createAdmin(db);
    const fx = await setupLeague(db, admin, 2);
    const L = fx.league.id;
    const [other] = await db.select().from(users).where(eq(users.id, fx.teams.find((t) => t.ownerId !== admin.id)!.ownerId));
    const base = Date.now();
    const log = (type: ActivityType, actor: string | null, i: number) =>
      logActivity(db, { leagueId: L, actorUserId: actor, type, summary: `entry ${i}`, now: new Date(base + i * 1000) });
    await log("add", other.id, 1);
    await log("commissioner_add", admin.id, 2);
    await log("trade_executed", other.id, 3);
    await log("score_adjustment", admin.id, 4);
    await log("auto_drop", null, 5);

    const all = await listActivity(db, L, { limit: 100 });
    const mine = all.entries.filter((e) => e.summary.startsWith("entry"));
    expect(mine.map((e) => e.summary)).toEqual(["entry 5", "entry 4", "entry 3", "entry 2", "entry 1"]);
    expect(mine[0].actorUsername).toBeNull();
    expect(mine[1].actorUsername).toBe((await db.select().from(users).where(eq(users.id, admin.id)))[0].username);

    const commissioner = await listActivity(db, L, { filter: "commissioner", limit: 100 });
    expect(commissioner.entries.filter((e) => e.summary.startsWith("entry")).map((e) => e.type).sort()).toEqual(["commissioner_add", "score_adjustment"]);
    const roster = await listActivity(db, L, { filter: "roster", limit: 100 });
    expect(roster.entries.filter((e) => e.summary.startsWith("entry")).map((e) => e.type).sort()).toEqual(["add", "auto_drop", "commissioner_add"]);

    const page = await listActivity(db, L, { limit: 2, offset: 0 });
    expect(page.entries).toHaveLength(2);
    expect(page.total).toBe(all.total);
  });

  it("is scoped to the league", async () => {
    const admin = await createAdmin(db);
    const a = await setupLeague(db, admin, 2);
    const b = await setupLeague(db, admin, 2);
    await logActivity(db, { leagueId: a.league.id, actorUserId: admin.id, type: "announcement", summary: "only in A" });
    expect((await listActivity(db, b.league.id)).entries.some((e) => e.summary === "only in A")).toBe(false);
    expect((await listActivity(db, a.league.id)).entries.some((e) => e.summary === "only in A")).toBe(true);
  });
});
