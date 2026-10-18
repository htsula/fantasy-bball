/**
 * The scripted events of the simulated season: every free-agency rule, every trade path, NBA events (trades,
 * waivers, signings, injuries), chat features, a stat correction and commissioner score adjustments. Each is
 * registered on a calendar date and runs inside the day loop at its time.
 */
import { and, eq } from "drizzle-orm";
import { messages, nbaPlayers, notifications, playerGameStats, rosterEntries, transactions, trades, matchups } from "@/db/schema";
import {
  chatUnreadCount,
  deleteMessage,
  editMessage,
  listPinned,
  markChatRead,
  postAnnouncement,
  postMessage,
  setPinned,
} from "@/lib/chat/service";
import { createLeagueInvite, generateSchedule, removeTeam, transferTeamOwnership, updateSettings } from "@/lib/leagues/service";
import { addToQueue, getDraftByLeague, makePick, restartDraft, startDraft, undoLastPick } from "@/lib/draft/service";
import { createUser } from "@/lib/auth/service";
import { LEAGUE_NAME, pw } from "./phase-setup";
import { adjustMatchupScore, computeMatchupTotals } from "@/lib/matchups/service";
import { listActivity } from "@/lib/activity/service";
import { markAllRead, setPref, unreadCount } from "@/lib/notifications/service";
import {
  commissionerAdd,
  commissionerDrop,
  commissionerRestore,
  dropPlayer,
  getAddsToday,
  listTransactions,
  removeCutPlayers,
  addFreeAgent,
} from "@/lib/rosters/service";
import {
  acceptTrade,
  addToTradeBlock,
  cancelTrade,
  castVote,
  commissionerApprove,
  commissionerReverse,
  commissionerVeto,
  counterTrade,
  forceCancelTrade,
  listTradeBlock,
  proposeTrade,
  rejectTrade,
  removeFromTradeBlock,
} from "@/lib/trades/service";
import { getLeagueView } from "@/lib/leagues/service";
import { addDays } from "@/lib/nba/dates";
import { teamGamePoints } from "@/lib/fantasy/team-points";
import { at, eq as same, ok, rejectsWith, type Manager } from "./context";
import { MINUTE, type SimPlayer } from "./nba-data";
import { loadOracleData } from "./oracle";
import {
  addPlayer,
  addScript,
  formAvg,
  tick,
  freeAgents,
  loadRosters,
  openTradePlayers,
  r2,
  tradeablePlayers,
  verifyPeriod,
  verifyStandings,
  type Season,
} from "./season-engine";
import { TRADE_DEADLINE } from "./phase-setup";

const tradeRow = async (s: Season, id: string) => (await s.ctx.db.select().from(trades).where(eq(trades.id, id)))[0];
const statusOf = async (s: Season, id: string) => (await tradeRow(s, id)).status;

/** All the scripted calendar events. */
export function registerScripts(s: Season) {
  freeAgencyRules(s);
  nbaEvents(s);
  tradeScenarios(s);
  chatScenarios(s);
  correctionsAndAdjustments(s);
  miscScenarios(s);
}

// ============================================================================ free agency rules

function freeAgencyRules(s: Season) {
  const { ctx } = s;
  const { db, admin } = ctx;
  const M = ctx.managers;
  const day = "2026-10-21";

  addScript(s, day, "09:10", "free-agency rules", async () => {
    const x = M[8];
    const y = M[9];
    const t = (min: number) => new Date(Date.UTC(2026, 9, 21, 13, 10 + min));
    const { byTeam, rostered } = await loadRosters(s);
    const roster = (byTeam.get(x.teamId) ?? []).map((id) => ctx.world.byId.get(id)!).sort((a, b) => formAvg(s, a) - formAvg(s, b));
    same(ctx, roster.length, 32, "team X starts the day full");
    const fa = freeAgents(s, rostered);
    const [a, b, c, d] = fa;
    const base = { leagueId: ctx.leagueId, actorUserId: x.userId };
    const retired = ctx.world.players.find((p) => !p.active)!;
    const teamless = ctx.world.players.find((p) => p.active && p.nbaTeamId === null)!;
    const add = (m: Manager, team: Manager, player: number, drop: number | null, min: number) =>
      addFreeAgent(db, { leagueId: ctx.leagueId, teamId: team.teamId, playerId: player, dropPlayerId: drop, actorUserId: m.userId }, { now: t(min), notify: ctx.notify });

    await rejectsWith(ctx, addFreeAgent(db, { ...base, teamId: x.teamId, playerId: a.id }, { now: t(1), notify: ctx.notify }), "roster_full", "adding to a full roster without a drop");
    await add(x, x, a.id, roster[0].id, 2); // drop-then-add in one action
    await add(x, x, b.id, roster[1].id, 3);
    ctx.counters.adds += 2;
    ctx.counters.drops += 2;
    await rejectsWith(ctx, add(x, x, c.id, roster[2].id, 4), "daily_limit_reached", "third add of the day");
    const adds = await getAddsToday(db, x.teamId, 2, t(5));
    same(ctx, [adds.used, adds.remaining, adds.limit], [2, 0, 2], "adds today after two adds");
    // The pair shares a group id: the add and its drop belong together.
    const rows = await db.select().from(transactions).where(and(eq(transactions.teamId, x.teamId), eq(transactions.etDate, day)));
    const addRow = rows.find((r) => r.type === "add" && r.playerId === a.id)!;
    const dropRow = rows.find((r) => r.type === "drop" && r.playerId === roster[0].id)!;
    ok(ctx, addRow.groupId !== null && addRow.groupId === dropRow.groupId, "add and drop share a group id");
    same(ctx, (await getAddsToday(db, x.teamId, 2, new Date(t(5).getTime() + 24 * 3_600_000))).used, 0, "adds reset on the next ET day");

    await rejectsWith(ctx, add(y, y, a.id, null, 6), "player_taken", "adding a player another team just added");
    await rejectsWith(ctx, add(y, y, retired.id, null, 7), "player_unavailable", "adding a retired player");
    await rejectsWith(ctx, add(y, y, teamless.id, null, 8), "player_unavailable", "adding a player on no NBA team");
    await rejectsWith(ctx, add(y, x, c.id, null, 9), "forbidden", "adding for someone else's team");
    await rejectsWith(ctx, dropPlayer(db, { leagueId: ctx.leagueId, teamId: y.teamId, playerId: a.id, actorUserId: y.userId }, { now: t(10) }), "not_on_roster", "dropping a player from another roster");
    await rejectsWith(ctx, dropPlayer(db, { leagueId: ctx.leagueId, teamId: y.teamId, playerId: 777, actorUserId: y.userId }, { now: t(10) }), "not_on_roster", "dropping an unknown player");

    // The commissioner bypasses the daily limit but not the roster maximum.
    await rejectsWith(ctx, commissionerAdd(db, { ...base, teamId: x.teamId, playerId: c.id, dropPlayerId: roster[2].id }, { now: t(11) }), "forbidden", "commissioner add by a non-commissioner");
    await commissionerAdd(db, { leagueId: ctx.leagueId, teamId: x.teamId, playerId: c.id, dropPlayerId: roster[2].id, actorUserId: admin.userId }, { now: t(12), notify: ctx.notify });
    ctx.counters.commissionerMoves++;
    await rejectsWith(ctx, commissionerAdd(db, { leagueId: ctx.leagueId, teamId: x.teamId, playerId: d.id, actorUserId: admin.userId }, { now: t(13) }), "roster_full", "commissioner add above the roster maximum");
    await commissionerDrop(db, { leagueId: ctx.leagueId, teamId: x.teamId, playerId: roster[3].id, actorUserId: admin.userId }, { now: t(14), notify: ctx.notify });
    ctx.counters.commissionerMoves++;
    const after = await db.select().from(transactions).where(and(eq(transactions.teamId, x.teamId), eq(transactions.etDate, day)));
    same(ctx, after.filter((r) => r.type === "add").length, 2, "commissioner add is not counted as an owner add");
    ok(ctx, after.some((r) => r.type === "commissioner_add") && after.some((r) => r.type === "commissioner_drop"), "commissioner moves are logged under their own types");
    ok(ctx, ctx.sent.some((n) => n.type === "commissioner_actions" && n.userIds.includes(x.userId)), "owner told about the commissioner's roster change");
    s.named.set("faRulesTeam", x.teamId);
  });

  // Draft and setup tools stay shut once the season is under way.
  addScript(s, day, "09:20", "setup tools are locked in season", async () => {
    const actor = { id: admin.userId, isSiteAdmin: true };
    const draft = (await getDraftByLeague(db, ctx.leagueId))!;
    const rules: [string, Promise<unknown>, string][] = [
      ["undoing a pick after rosters moved", undoLastPick(db, draft.id, admin.userId), "cannot_undo"],
      ["starting the draft again", startDraft(db, ctx.leagueId, admin.userId), "already_started"],
      ["restarting a finished draft", restartDraft(db, ctx.leagueId, admin.userId, LEAGUE_NAME), "cannot_restart"],
      ["queueing after the draft", addToQueue(db, M[2].teamId, ctx.world.players[0].id, M[2].userId), "draft_not_active"],
      ["picking after the draft", makePick(db, draft.id, M[2].teamId, ctx.world.players[0].id, M[2].userId), "draft_not_active"],
      ["changing the roster cap in season", updateSettings(db, actor, ctx.leagueId, { rosterCap: 40 }), "settings_locked"],
      ["changing the snake target in season", updateSettings(db, actor, ctx.leagueId, { snakeTarget: 100 }), "settings_locked"],
      ["generating a schedule in season", generateSchedule(db, actor, ctx.leagueId, { seed: "again" }), "wrong_status"],
      ["removing a team in season", removeTeam(db, actor, M[3].teamId), "wrong_status"],
      ["creating an invite in season", createLeagueInvite(db, actor, ctx.leagueId), "wrong_status"],
    ];
    for (const [what, p, code] of rules) await rejectsWith(ctx, p, code, what);
    // Settings that may change mid-season still can.
    const after = await updateSettings(db, actor, ctx.leagueId, { tradeReviewHours: 24, addsPerDay: 2 });
    same(ctx, [after.rosterCap, after.addsPerDay], [50, 2], "draft-locked settings unchanged");
  });

  // The daily add limit follows the ET calendar day, not 24 hours: two adds at 23:55 and two more at 00:05.
  addScript(s, "2026-10-31", "23:55", "adds just before midnight ET", async () => {
    const x = M[10];
    const { byTeam, rostered } = await loadRosters(s);
    const roster = (byTeam.get(x.teamId) ?? []).map((id) => ctx.world.byId.get(id)!).sort((a, b) => formAvg(s, a) - formAvg(s, b));
    const fa = freeAgents(s, rostered);
    await addPlayer(s, x, fa[0], roster[0], tick(s));
    await addPlayer(s, x, fa[1], roster[1], tick(s));
    s.named.set("midnight", JSON.stringify([fa[2].id, fa[3].id, fa[4].id, roster[2].id, roster[3].id, roster[4].id]));
    await rejectsWith(ctx, addPlayer(s, x, fa[2], roster[2], tick(s)), "daily_limit_reached", "third add before midnight");
  });
  addScript(s, "2026-11-01", "00:05", "adds just after midnight ET", async () => {
    const x = M[10];
    const [a, b, c, d, e2, f] = (JSON.parse(s.named.get("midnight")!) as number[]).map((id) => ctx.world.byId.get(id)!);
    await addPlayer(s, x, a, d, tick(s));
    await addPlayer(s, x, b, e2, tick(s));
    await rejectsWith(ctx, addPlayer(s, x, c, f, tick(s)), "daily_limit_reached", "third add after midnight");
    const used = await getAddsToday(db, x.teamId, 2, tick(s));
    same(ctx, used.used, 2, "the new ET day counts its own two adds");
  });

  addScript(s, "2026-10-22", "09:10", "free-agency rules, next day", async () => {
    const x = M[8];
    const { rostered, byTeam } = await loadRosters(s);
    same(ctx, (byTeam.get(x.teamId) ?? []).length, 31, "team X is a man short after the commissioner drop");
    const [a] = freeAgents(s, rostered);
    await addPlayer(s, x, a, null, new Date(Date.UTC(2026, 9, 22, 13, 10)));
    const adds = await getAddsToday(db, x.teamId, 2, new Date(Date.UTC(2026, 9, 22, 13, 11)));
    same(ctx, [adds.used, adds.remaining], [1, 1], "the daily limit reset overnight");
  });
}

// ================================================================================== NBA events

/** The NBA cuts a player. ESPN may clear his team, mark him inactive, or both: the app must treat each as cut. */
async function waive(s: Season, p: SimPlayer, when: Date, how: "both" | "no-team" | "inactive" = "both") {
  const { ctx } = s;
  if (how !== "no-team") p.active = false;
  if (how !== "inactive") p.nbaTeamId = null;
  await ctx.db.update(nbaPlayers).set({ ...(how !== "inactive" ? { teamId: null } : {}), ...(how !== "no-team" ? { active: false } : {}) }).where(eq(nbaPlayers.id, p.id));
  const res = await removeCutPlayers(ctx.db, { allRostersLoaded: true, now: when }, { notify: ctx.notify });
  return res;
}

function nbaEvents(s: Season) {
  const { ctx } = s;
  const { db, rand, admin, world } = ctx;
  const M = ctx.managers;
  const rosteredMid = async (m: Manager) => {
    const { byTeam } = await loadRosters(s);
    const busy = await openTradePlayers(s);
    const mine = (byTeam.get(m.teamId) ?? []).filter((id) => !busy.has(id)).map((id) => world.byId.get(id)!).sort((a, b) => formAvg(s, b) - formAvg(s, a));
    return mine[Math.floor(mine.length / 2)];
  };

  // A real sync that doesn't see every roster must not mass-drop anybody.
  addScript(s, "2026-11-10", "10:35", "removeCutPlayers is a no-op when not all rosters loaded", async () => {
    const res = await removeCutPlayers(db, { allRostersLoaded: false, now: tick(s) }, { notify: ctx.notify });
    same(ctx, res, { dropped: 0, skipped: true }, "partial sync skips auto-drops");
  });

  // NBA trade: two rostered players swap NBA teams; later tip-off snapshots carry the new teams.
  addScript(s, "2026-11-17", "10:30", "NBA trade", async () => {
    const owners = [M[5], M[6]];
    const [p1, p2] = await Promise.all(owners.map((m) => rosteredMid(m)));
    const [t1, t2] = [p1.nbaTeamId, p2.nbaTeamId];
    ok(ctx, t1 !== t2, "NBA trade partners are on different teams");
    p1.nbaTeamId = t2;
    p2.nbaTeamId = t1;
    await db.update(nbaPlayers).set({ teamId: t2 }).where(eq(nbaPlayers.id, p1.id));
    await db.update(nbaPlayers).set({ teamId: t1 }).where(eq(nbaPlayers.id, p2.id));
    s.named.set("nbaTradedPlayer", String(p1.id));
  });

  // NBA waives a rostered player: the app auto-drops him and tells the owner.
  addScript(s, "2026-12-08", "10:30", "NBA waives a rostered player", async () => {
    const owner = M[3];
    const p = await rosteredMid(owner);
    const when = tick(s);
    const res = await waive(s, p, when);
    same(ctx, res, { dropped: 1, skipped: false }, "one rostered player auto-dropped");
    ctx.counters.autoDrops++;
    const [entry] = await db.select().from(rosterEntries).where(and(eq(rosterEntries.playerId, p.id), eq(rosterEntries.teamId, owner.teamId)));
    same(ctx, [entry.releasedVia, entry.releasedAt?.getTime()], ["auto_drop", when.getTime()], "roster entry released by the auto-drop");
    const [txn] = await db.select().from(transactions).where(and(eq(transactions.playerId, p.id), eq(transactions.type, "auto_drop")));
    ok(ctx, txn && txn.actorUserId === null, "auto_drop transaction logged with no actor");
    ok(ctx, ctx.sent.some((n) => n.type === "roster_auto_drop" && n.userIds[0] === owner.userId), "owner notified of the auto-drop");
    const feed = await listActivity(db, ctx.leagueId, { limit: 5 });
    ok(ctx, feed.entries.some((e) => e.type === "auto_drop"), "auto-drop in the activity log");
    s.named.set("waivedPlayer", String(p.id));
    s.named.set("waivedTxn", txn.id);
    s.named.set("waivedOwner", owner.teamId);
    ok(ctx, (await removeCutPlayers(db, { allRostersLoaded: true, now: when }, { notify: ctx.notify })).dropped === 0, "a second sync drops nobody");
  });

  // He signs elsewhere; the commissioner restores the auto-drop (making room first if the team refilled).
  addScript(s, "2026-12-12", "10:30", "waived player re-signs, commissioner restores", async () => {
    const p = world.byId.get(Number(s.named.get("waivedPlayer")))!;
    const owner = M.find((m) => m.teamId === s.named.get("waivedOwner"))!;
    const when = tick(s);
    p.active = true;
    p.nbaTeamId = world.teams[3].id;
    await db.update(nbaPlayers).set({ teamId: p.nbaTeamId, active: true }).where(eq(nbaPlayers.id, p.id));
    const { byTeam } = await loadRosters(s);
    const roster = byTeam.get(owner.teamId) ?? [];
    if (roster.length >= 32) {
      const busy = await openTradePlayers(s);
      const worst = roster.filter((id) => !busy.has(id)).map((id) => world.byId.get(id)!).sort((a, b) => formAvg(s, a) - formAvg(s, b))[0];
      await commissionerDrop(db, { leagueId: ctx.leagueId, teamId: owner.teamId, playerId: worst.id, actorUserId: admin.userId }, { now: when, notify: ctx.notify });
      ctx.counters.commissionerMoves++;
    }
    const txnId = s.named.get("waivedTxn")!;
    await rejectsWith(ctx, commissionerRestore(db, { transactionId: txnId, actorUserId: owner.userId }, { now: when }), "forbidden", "restore by a non-commissioner");
    await commissionerRestore(db, { transactionId: txnId, actorUserId: admin.userId }, { now: when, notify: ctx.notify });
    ctx.counters.commissionerMoves++;
    const [entry] = await db.select().from(rosterEntries).where(and(eq(rosterEntries.playerId, p.id), eq(rosterEntries.teamId, owner.teamId)));
    same(ctx, entry.releasedAt, null, "restored player is back on the roster entry that was auto-dropped");
    await rejectsWith(ctx, commissionerRestore(db, { transactionId: txnId, actorUserId: admin.userId }, { now: when }), "not_restorable", "restoring twice");
  });

  // Steady NBA activity: a trade between two teams roughly every twelve days (rostered or not) ...
  for (let k = 0; k < 13; k++) {
    const date = addDays("2026-11-24", k * 12);
    addScript(s, date, "10:20", "random NBA trade", async () => {
      const pool = world.players.filter((p) => p.active && p.nbaTeamId !== null);
      const p1 = rand.pick(pool);
      const p2 = rand.pick(pool.filter((p) => p.nbaTeamId !== p1.nbaTeamId));
      const [t1, t2] = [p1.nbaTeamId, p2.nbaTeamId];
      p1.nbaTeamId = t2;
      p2.nbaTeamId = t1;
      await db.update(nbaPlayers).set({ teamId: t2 }).where(eq(nbaPlayers.id, p1.id));
      await db.update(nbaPlayers).set({ teamId: t1 }).where(eq(nbaPlayers.id, p2.id));
    });
  }
  // ... and a few more rostered players cut, each auto-dropped and reported to his owner.
  for (const date of ["2026-12-30", "2027-01-31", "2027-02-25", "2027-03-11", "2027-03-26"]) {
    addScript(s, date, "10:25", "random NBA waiver", async () => {
      const { byTeam } = await loadRosters(s);
      const busy = await openTradePlayers(s);
      const owner = rand.pick(M);
      const mine = (byTeam.get(owner.teamId) ?? []).filter((id) => !busy.has(id) && !s.noDrop.has(id)).map((id) => world.byId.get(id)!).sort((a, b) => formAvg(s, a) - formAvg(s, b));
      const p = mine[rand.int(Math.min(6, mine.length))];
      const how = (["both", "no-team", "inactive"] as const)[ctx.rand.int(3)];
      const res = await waive(s, p, tick(s), how);
      same(ctx, res, { dropped: 1, skipped: false }, `${date}: the cut player was auto-dropped (${how})`);
      ctx.counters.autoDrops++;
      ok(ctx, ctx.sent.some((n) => n.type === "roster_auto_drop" && n.userIds[0] === owner.userId && n.title.includes(p.name)), "owner told which player was cut");
    });
  }

  // Two free-agent signings from the NBA: a breakout player appears and is grabbed the same day.
  for (const [date, q, nm] of [["2027-01-13", 41, "Breakout Pat"], ["2027-02-01", 37, "Sudden Sam"]] as const) {
    addScript(s, date, "10:30", `NBA signs ${nm}`, async () => {
      const id = world.nextId.player++;
      const team = rand.pick(world.teams);
      const p: SimPlayer = { id, name: `${nm} Quillfeather`, nbaTeamId: team.id, q, prevQ: null, rookie: true, active: true, positions: ["SG", "SF"], health: { status: null, detail: null, untilDate: null } };
      world.players.push(p);
      world.byId.set(id, p);
      await db.insert(nbaPlayers).values({ id, fullName: p.name, firstName: nm.split(" ")[0], lastName: `${nm.split(" ")[1]} Quillfeather`, teamId: team.id, positions: p.positions, active: true });
      const { rostered } = await loadRosters(s);
      ok(ctx, !rostered.has(id), "a new signing starts as a free agent");
      s.named.set(`signing:${date}`, String(id));
    });
    addScript(s, date, "10:50", `${nm} gets picked up`, async () => {
      const p = world.byId.get(Number(s.named.get(`signing:${date}`)))!;
      const { byTeam } = await loadRosters(s);
      const busy = await openTradePlayers(s);
      const taker = M.filter((m) => m.teamId !== s.named.get("faRulesTeam"))[(date === "2027-01-13" ? 6 : 11)];
      const roster = (byTeam.get(taker.teamId) ?? []).map((id) => world.byId.get(id)!).filter((x) => !busy.has(x.id)).sort((a, b) => formAvg(s, a) - formAvg(s, b));
      const adds = await getAddsToday(db, taker.teamId, 2, tick(s));
      if (adds.remaining <= 0) throw new Error("taker is out of adds; pick another manager");
      await addPlayer(s, taker, p, (byTeam.get(taker.teamId) ?? []).length >= 32 ? roster[0] : null, tick(s));
      const { rostered } = await loadRosters(s);
      ok(ctx, rostered.has(p.id), "signing picked up");
    });
  }
}

// ==================================================================================== trades

function tradeScenarios(s: Season) {
  const { ctx } = s;
  const { db, admin } = ctx;
  const M = ctx.managers;
  const lg = ctx.leagueId;
  const notify = ctx.notify;

  type T = { id: string; a: Manager; b: Manager; give: number[]; get: number[] };
  const propose = async (a: Manager, b: Manager, nGive: number, nGet: number, when: Date, message: string | null = null): Promise<T> => {
    const give = await tradeablePlayers(s, a, nGive);
    const get = await tradeablePlayers(s, b, nGet);
    const trade = await proposeTrade(db, { leagueId: lg, proposerTeamId: a.teamId, receiverTeamId: b.teamId, give, get, message, actorUserId: a.userId }, { now: when, notify });
    ctx.counters.tradesProposed++;
    same(ctx, trade.status, "proposed", "new trade is proposed");
    ok(ctx, ctx.sent.some((n) => n.type === "trade_offers" && n.userIds[0] === b.userId), "receiver got the offer notification");
    return { id: trade.id, a, b, give, get };
  };
  const onTeam = async (teamId: string) => new Set((await loadRosters(s)).byTeam.get(teamId) ?? []);
  const assertSwapped = async (t: T, done: boolean) => {
    const [ra, rb] = [await onTeam(t.a.teamId), await onTeam(t.b.teamId)];
    ok(ctx, t.give.every((id) => (done ? rb.has(id) && !ra.has(id) : ra.has(id) && !rb.has(id))), `give players ${done ? "moved to" : "stayed with"} the receiver`);
    ok(ctx, t.get.every((id) => (done ? ra.has(id) && !rb.has(id) : rb.has(id) && !ra.has(id))), `get players ${done ? "moved to" : "stayed with"} the proposer`);
  };
  const reg = (date: string, hhmm: string, label: string, run: () => Promise<void>) => addScript(s, date, hhmm, label, run);

  // ---- T1: accepted under commissioner review, approved by the commissioner (who is a party).
  let t1: T;
  reg("2026-11-03", "09:30", "T1 propose", async () => {
    t1 = await propose(M[0], M[4], 2, 2, tick(s), "Two-for-two, fair value.");
  });
  reg("2026-11-03", "11:00", "T1 accept", async () => {
    await rejectsWith(ctx, acceptTrade(db, { tradeId: t1.id, actorUserId: t1.a.userId }, { now: tick(s) }), "forbidden", "proposer accepting his own offer");
    const res = await acceptTrade(db, { tradeId: t1.id, actorUserId: t1.b.userId }, { now: tick(s), notify });
    same(ctx, res.status, "pending_review", "commissioner review mode holds the trade");
    ok(ctx, ctx.sent.some((n) => n.type === "trade_review" && n.userIds[0] === admin.userId), "commissioner asked to review");
    await assertSwapped(t1, false);
  });
  reg("2026-11-04", "10:00", "T1 approve", async () => {
    await rejectsWith(ctx, commissionerApprove(db, { tradeId: t1.id, actorUserId: t1.b.userId }, { now: tick(s) }), "forbidden", "approval by a non-commissioner");
    await commissionerApprove(db, { tradeId: t1.id, actorUserId: admin.userId }, { now: tick(s), notify });
    same(ctx, await statusOf(s, t1.id), "executed", "approved trade executed");
    ctx.counters.tradesExecuted++;
    await assertSwapped(t1, true);
    await rejectsWith(ctx, commissionerApprove(db, { tradeId: t1.id, actorUserId: admin.userId }, { now: tick(s) }), "wrong_state", "approving twice");
    const rows = await db.select().from(transactions).where(and(eq(transactions.groupId, t1.id), eq(transactions.type, "trade")));
    same(ctx, rows.length, t1.give.length + t1.get.length, "one trade transaction per player moved");
  });

  // ---- T2: commissioner veto.
  let t2: T;
  reg("2026-11-09", "09:30", "T2 propose+accept", async () => {
    t2 = await propose(M[5], M[6], 1, 1, tick(s));
    await acceptTrade(db, { tradeId: t2.id, actorUserId: t2.b.userId }, { now: tick(s), notify });
    same(ctx, await statusOf(s, t2.id), "pending_review", "T2 under review");
  });
  reg("2026-11-10", "10:00", "T2 veto", async () => {
    await commissionerVeto(db, { tradeId: t2.id, actorUserId: admin.userId, reason: "Looks lopsided." }, { now: tick(s), notify });
    same(ctx, await statusOf(s, t2.id), "vetoed", "vetoed trade");
    await assertSwapped(t2, false);
    ok(ctx, ctx.sent.some((n) => n.title === "Trade vetoed" && n.userIds.includes(t2.a.userId) && n.userIds.includes(t2.b.userId)), "both parties told about the veto");
  });

  // ---- T3: rejected by the receiver.
  let t3: T;
  reg("2026-11-12", "09:30", "T3 propose, reject", async () => {
    t3 = await propose(M[7], M[8], 1, 1, tick(s));
    await rejectsWith(ctx, rejectTrade(db, { tradeId: t3.id, actorUserId: t3.a.userId }, { now: tick(s) }), "forbidden", "proposer rejecting his own offer");
    await rejectTrade(db, { tradeId: t3.id, actorUserId: t3.b.userId }, { now: tick(s), notify });
    same(ctx, await statusOf(s, t3.id), "rejected", "rejected trade");
    await rejectsWith(ctx, acceptTrade(db, { tradeId: t3.id, actorUserId: t3.b.userId }, { now: tick(s) }), "wrong_state", "accepting a rejected offer");
  });

  // ---- T4: counter, accept the counter, nobody reviews: auto-approved by the nightly trade job.
  let t4: T;
  let t4c: string;
  reg("2026-11-17", "09:30", "T4 propose, counter, accept counter", async () => {
    t4 = await propose(M[9], M[10], 2, 2, tick(s));
    const mineBack = await tradeablePlayers(s, t4.b, 1);
    const counter = await counterTrade(db, { tradeId: t4.id, give: mineBack, get: t4.give.slice(0, 1), message: "How about one for one?", actorUserId: t4.b.userId }, { now: tick(s), notify });
    t4c = counter.id;
    ctx.counters.tradesProposed++;
    same(ctx, await statusOf(s, t4.id), "countered", "original marked countered");
    ok(ctx, counter.counteredFrom === t4.id, "counter links to the original");
    await acceptTrade(db, { tradeId: counter.id, actorUserId: t4.a.userId }, { now: tick(s), notify });
    same(ctx, await statusOf(s, counter.id), "pending_review", "counter under review");
    s.named.set("t4c", counter.id);
    s.named.set("t4give", JSON.stringify(mineBack));
  });
  reg("2026-11-19", "05:00", "T4 auto-approved by the nightly job", async () => {
    const row = await tradeRow(s, t4c);
    same(ctx, row.status, "executed", "unanswered review executes when the window ends (nightly 04:00)");
    ok(ctx, (row.resolvedReason ?? "").includes("approved automatically"), "resolved reason says approved automatically");
    ctx.counters.tradesExecuted++;
    const back = JSON.parse(s.named.get("t4give")!) as number[];
    const ra = await onTeam(t4.a.teamId);
    ok(ctx, back.every((id) => ra.has(id)), "countering team's player went to the original proposer");
  });

  // ---- T5: proposer cancels.
  reg("2026-11-20", "09:30", "T5 propose, cancel", async () => {
    const t5 = await propose(M[11], M[12], 1, 1, tick(s));
    await rejectsWith(ctx, cancelTrade(db, { tradeId: t5.id, actorUserId: t5.b.userId }, { now: tick(s) }), "forbidden", "receiver cancelling");
    await cancelTrade(db, { tradeId: t5.id, actorUserId: t5.a.userId }, { now: tick(s), notify });
    same(ctx, await statusOf(s, t5.id), "cancelled", "cancelled trade");
  });

  // ---- T6: never answered: expires seven days later via the nightly trade job. T6b: accepted just after expiry.
  let t6: T;
  let t6b: T;
  reg("2026-11-22", "11:00", "T6 propose", async () => {
    t6 = await propose(M[13], M[14], 1, 1, tick(s));
  });
  reg("2026-11-24", "11:00", "T6b propose", async () => {
    t6b = await propose(M[13], M[15], 1, 1, tick(s));
  });
  reg("2026-11-30", "05:00", "T6 expired by the job", async () => {
    // Created Nov 22 11:00 ET; the Nov 29 04:00 run is too early, the Nov 30 04:00 run expires it.
    same(ctx, await statusOf(s, t6.id), "expired", "unanswered offer expired after 7 days");
    ok(ctx, ctx.sent.some((n) => n.title === "Trade offer expired" && n.userIds.includes(t6.a.userId)), "parties told it expired");
  });
  reg("2026-11-29", "05:00", "T6 still open on day 7 morning", async () => {
    same(ctx, await statusOf(s, t6.id), "proposed", "offer is still open before its 7 days are up");
  });
  reg("2026-12-01", "12:00", "T6b accept after expiry", async () => {
    await rejectsWith(ctx, acceptTrade(db, { tradeId: t6b.id, actorUserId: t6b.b.userId }, { now: tick(s) }), "expired", "accepting an expired offer");
    same(ctx, await statusOf(s, t6b.id), "expired", "lazy expiry on accept");
  });

  // ---- League vote mode: one trade passes, one is vetoed by votes.
  reg("2026-12-14", "09:00", "switch to league vote", async () => {
    await updateSettings(db, { id: admin.userId, isSiteAdmin: true }, lg, { tradeReview: "league_vote" });
  });
  let t7: T;
  reg("2026-12-15", "09:30", "T7 propose+accept, votes", async () => {
    t7 = await propose(M[2], M[3], 1, 1, tick(s));
    const res = await acceptTrade(db, { tradeId: t7.id, actorUserId: t7.b.userId }, { now: tick(s), notify });
    same(ctx, res.status, "pending_review", "vote mode: pending review");
    const voters = M.filter((m) => m.teamId !== t7.a.teamId && m.teamId !== t7.b.teamId);
    const v1 = await castVote(db, { tradeId: t7.id, actorUserId: voters[0].userId, vote: "veto" }, { now: tick(s), notify });
    await castVote(db, { tradeId: t7.id, actorUserId: voters[1].userId, vote: "approve" }, { now: tick(s), notify });
    const v3 = await castVote(db, { tradeId: t7.id, actorUserId: voters[2].userId, vote: "veto" }, { now: tick(s), notify });
    same(ctx, [v1.vetoVotes, v3.vetoVotes, v3.threshold, v3.status], [1, 2, 4, "pending_review"], "two vetoes of four needed leave the trade pending");
    await rejectsWith(ctx, castVote(db, { tradeId: t7.id, actorUserId: voters[0].userId, vote: "veto" }, { now: tick(s) }), "already_voted", "voting twice");
    await rejectsWith(ctx, castVote(db, { tradeId: t7.id, actorUserId: t7.a.userId, vote: "veto" }, { now: tick(s) }), "not_eligible", "a party voting");
    await rejectsWith(ctx, commissionerApprove(db, { tradeId: t7.id, actorUserId: admin.userId }, { now: tick(s) }), "wrong_state", "commissioner approval is not available in vote mode");
    ok(ctx, ctx.sent.some((n) => n.type === "trade_review" && n.title === "Vote on a trade" && n.userIds.length === 14), "14 eligible voters told");
  });
  reg("2026-12-16", "11:00", "T7 vote after the window", async () => {
    const voters = M.filter((m) => m.teamId !== t7.a.teamId && m.teamId !== t7.b.teamId);
    await rejectsWith(ctx, castVote(db, { tradeId: t7.id, actorUserId: voters[5].userId, vote: "veto" }, { now: tick(s) }), "review_closed", "voting after the review window");
  });
  reg("2026-12-17", "05:00", "T7 executed", async () => {
    same(ctx, await statusOf(s, t7.id), "executed", "trade with too few vetoes executes when the window ends");
    ctx.counters.tradesExecuted++;
    await assertSwapped(t7, true);
  });
  let t8: T;
  reg("2026-12-18", "09:30", "T8 vetoed by votes", async () => {
    t8 = await propose(M[4], M[8], 1, 1, tick(s));
    await acceptTrade(db, { tradeId: t8.id, actorUserId: t8.b.userId }, { now: tick(s), notify });
    const voters = M.filter((m) => m.teamId !== t8.a.teamId && m.teamId !== t8.b.teamId);
    let last = { status: "pending_review", vetoVotes: 0, threshold: 0 };
    for (let i = 0; i < 4; i++) {
      last = await castVote(db, { tradeId: t8.id, actorUserId: voters[i].userId, vote: "veto" }, { now: tick(s), notify });
      if (i < 3) same(ctx, last.status, "pending_review", `after ${i + 1} vetoes the trade is still pending`);
    }
    same(ctx, [last.status, last.vetoVotes], ["vetoed", 4], "the fourth veto kills the trade");
    await assertSwapped(t8, false);
  });
  reg("2026-12-28", "09:00", "back to commissioner review", async () => {
    await updateSettings(db, { id: admin.userId, isSiteAdmin: true }, lg, { tradeReview: "commissioner" });
  });

  // ---- T9: invalidated because a player was dropped; T9b: invalidated because the NBA cut a player.
  reg("2027-01-04", "09:20", "T9 dropped player invalidates", async () => {
    const t9 = await propose(M[2], M[6], 1, 1, tick(s));
    await acceptTrade(db, { tradeId: t9.id, actorUserId: t9.b.userId }, { now: tick(s), notify });
    same(ctx, await statusOf(s, t9.id), "pending_review", "T9 under review");
    await dropPlayer(db, { leagueId: lg, teamId: t9.a.teamId, playerId: t9.give[0], actorUserId: t9.a.userId }, { now: tick(s), notify });
    ctx.counters.drops++;
    same(ctx, await statusOf(s, t9.id), "invalidated", "dropping a traded player voids the trade");
    ok(ctx, ctx.sent.some((n) => n.title === "Trade no longer valid" && n.userIds.includes(t9.b.userId)), "other side told");
    await rejectsWith(ctx, acceptTrade(db, { tradeId: t9.id, actorUserId: t9.b.userId }, { now: tick(s) }), "players_moved", "accepting an invalidated trade");
    await rejectsWith(ctx, commissionerApprove(db, { tradeId: t9.id, actorUserId: admin.userId }, { now: tick(s) }), "wrong_state", "approving an invalidated trade");
  });
  reg("2027-01-04", "09:40", "T9b propose", async () => {
    const t9b = await propose(M[7], M[8], 1, 1, tick(s));
    s.named.set("t9b", t9b.id);
    s.named.set("t9bPlayer", String(t9b.get[0]));
  });
  reg("2027-01-04", "10:31", "T9b NBA cuts a traded player", async () => {
    const p = ctx.world.byId.get(Number(s.named.get("t9bPlayer")))!;
    const res = await waive(s, p, tick(s));
    same(ctx, res.dropped, 1, "cut player auto-dropped");
    ctx.counters.autoDrops++;
    same(ctx, await statusOf(s, s.named.get("t9b")!), "invalidated", "an open offer including a cut player is invalidated");
    const row = await tradeRow(s, s.named.get("t9b")!);
    ok(ctx, (row.resolvedReason ?? "").includes("cut by the NBA"), "reason mentions the NBA cut");
  });

  // ---- T10: commissioner force-cancels a trade under review.
  reg("2027-01-11", "09:30", "T10 force cancel", async () => {
    const t10 = await propose(M[9], M[10], 1, 1, tick(s));
    await acceptTrade(db, { tradeId: t10.id, actorUserId: t10.b.userId }, { now: tick(s), notify });
    await rejectsWith(ctx, forceCancelTrade(db, { tradeId: t10.id, actorUserId: t10.a.userId }, { now: tick(s) }), "forbidden", "force-cancel by a non-commissioner");
    await forceCancelTrade(db, { tradeId: t10.id, actorUserId: admin.userId, reason: "Players are injured." }, { now: tick(s), notify });
    same(ctx, await statusOf(s, t10.id), "cancelled", "force-cancelled");
    await rejectsWith(ctx, forceCancelTrade(db, { tradeId: t10.id, actorUserId: admin.userId }, { now: tick(s) }), "wrong_state", "force-cancelling twice");
  });

  // ---- T12: approve then reverse within 48 hours.
  let t12: T;
  reg("2027-01-12", "09:30", "T12 approve", async () => {
    t12 = await propose(M[11], M[12], 2, 2, tick(s));
    await addToTradeBlock(db, { leagueId: lg, teamId: t12.a.teamId, playerId: t12.give[0], note: "Shopping him", actorUserId: t12.a.userId }, { now: tick(s) });
    await acceptTrade(db, { tradeId: t12.id, actorUserId: t12.b.userId }, { now: tick(s), notify });
    await commissionerApprove(db, { tradeId: t12.id, actorUserId: admin.userId }, { now: tick(s), notify });
    ctx.counters.tradesExecuted++;
    await assertSwapped(t12, true);
    for (const id of [...t12.give, ...t12.get]) s.noDrop.add(id); // keep them put so the reversal below is possible
    const view = await getLeagueView(db, { id: t12.a.userId, isSiteAdmin: false }, lg);
    ok(ctx, !(await listTradeBlock(db, view.league)).some((b) => b.playerId === t12.give[0]), "a traded player leaves the trade block");
  });
  reg("2027-01-13", "09:30", "T12 reverse", async () => {
    await rejectsWith(ctx, commissionerReverse(db, { tradeId: t12.id, actorUserId: t12.a.userId }, { now: tick(s) }), "forbidden", "reversal by a non-commissioner");
    const reversal = await commissionerReverse(db, { tradeId: t12.id, actorUserId: admin.userId, reason: "Mistaken lineup." }, { now: tick(s), notify });
    same(ctx, reversal.kind, "reversal", "reversal record");
    same(ctx, await statusOf(s, t12.id), "reversed", "original marked reversed");
    await assertSwapped(t12, false);
    await rejectsWith(ctx, commissionerReverse(db, { tradeId: t12.id, actorUserId: admin.userId }, { now: tick(s) }), "not_reversible", "reversing twice");
    await rejectsWith(ctx, commissionerReverse(db, { tradeId: t4c, actorUserId: admin.userId }, { now: tick(s) }), "not_reversible", "reversing a trade older than 48 hours");
    for (const id of [...t12.give, ...t12.get]) s.noDrop.delete(id);
  });

  // ---- Trade block.
  reg("2027-01-20", "10:00", "trade block", async () => {
    const [a, b] = [M[4], M[5]];
    const mine = await tradeablePlayers(s, a, 3);
    await addToTradeBlock(db, { leagueId: lg, teamId: a.teamId, playerId: mine[0], note: "Open to offers", actorUserId: a.userId }, { now: tick(s) });
    await addToTradeBlock(db, { leagueId: lg, teamId: a.teamId, playerId: mine[1], note: null, actorUserId: a.userId }, { now: tick(s) });
    const theirs = await tradeablePlayers(s, b, 1);
    await addToTradeBlock(db, { leagueId: lg, teamId: b.teamId, playerId: theirs[0], note: "Make me an offer", actorUserId: b.userId }, { now: tick(s) });
    await rejectsWith(ctx, addToTradeBlock(db, { leagueId: lg, teamId: a.teamId, playerId: theirs[0], actorUserId: a.userId }, { now: tick(s) }), "not_on_roster", "blocking a player not on the roster");
    await rejectsWith(ctx, addToTradeBlock(db, { leagueId: lg, teamId: a.teamId, playerId: mine[2], actorUserId: b.userId }, { now: tick(s) }), "forbidden", "blocking for someone else's team");
    const view = await getLeagueView(db, { id: a.userId, isSiteAdmin: false }, lg);
    let block = await listTradeBlock(db, view.league);
    same(ctx, block.length >= 3, true, "three players on the block");
    await removeFromTradeBlock(db, { leagueId: lg, teamId: a.teamId, playerId: mine[1], actorUserId: a.userId });
    block = await listTradeBlock(db, view.league, { teamId: a.teamId });
    same(ctx, block.map((x) => x.playerId), [mine[0]], "removed player left the block");
    s.noDrop.add(mine[0]);
  });

  // ---- Left open for the regular-season checkpoint: a proposed offer and a trade under review.
  reg("2027-01-25", "11:00", "T13 proposed", async () => {
    const t13 = await propose(M[13], M[14], 1, 1, tick(s), "Throw-in swap, take a look.");
    s.named.set("t13", t13.id);
  });
  reg("2027-01-26", "09:20", "T14 under review", async () => {
    const t14 = await propose(M[2], M[3], 2, 2, tick(s));
    await acceptTrade(db, { tradeId: t14.id, actorUserId: t14.b.userId }, { now: tick(s), notify });
    s.named.set("t14", t14.id);
    same(ctx, await statusOf(s, t14.id), "pending_review", "T14 waiting for the commissioner at the checkpoint");
  });
  reg("2027-01-27", "10:00", "T14 approved", async () => {
    await commissionerApprove(db, { tradeId: s.named.get("t14")!, actorUserId: admin.userId }, { now: tick(s), notify });
    ctx.counters.tradesExecuted++;
  });

  // ---- Roster limit: a 1-for-2 trade that would put a team over 32 can't go through until he drops somebody.
  const ensureFull = async (m: Manager, when: Date) => {
    const { byTeam, rostered } = await loadRosters(s);
    let n = (byTeam.get(m.teamId) ?? []).length;
    const fa = freeAgents(s, rostered);
    while (n < 32) {
      await commissionerAdd(db, { leagueId: lg, teamId: m.teamId, playerId: fa.shift()!.id, actorUserId: admin.userId }, { now: when, notify });
      ctx.counters.commissionerMoves++;
      n++;
    }
  };
  reg("2027-02-09", "09:30", "T18 over the roster maximum, fixed by a drop", async () => {
    const [a, b] = [M[11], M[12]];
    await ensureFull(a, tick(s));
    const t18 = await propose(a, b, 1, 2, tick(s), "Consolidating.");
    await acceptTrade(db, { tradeId: t18.id, actorUserId: b.userId }, { now: tick(s), notify });
    await rejectsWith(ctx, commissionerApprove(db, { tradeId: t18.id, actorUserId: admin.userId }, { now: tick(s) }), "roster_full", "approving a trade that puts a team over the maximum");
    same(ctx, await statusOf(s, t18.id), "pending_review", "the trade waits for the owner to make room");
    const { byTeam } = await loadRosters(s);
    const busy = await openTradePlayers(s);
    const spare = (byTeam.get(a.teamId) ?? []).filter((id) => !busy.has(id) && !s.noDrop.has(id))[0];
    await dropPlayer(db, { leagueId: lg, teamId: a.teamId, playerId: spare, actorUserId: a.userId }, { now: tick(s), notify });
    ctx.counters.drops++;
    await commissionerApprove(db, { tradeId: t18.id, actorUserId: admin.userId }, { now: tick(s), notify });
    same(ctx, await statusOf(s, t18.id), "executed", "executed once the roster fits");
    ctx.counters.tradesExecuted++;
    await assertSwapped(t18, true);
    same(ctx, (await loadRosters(s)).byTeam.get(a.teamId)?.length, 32, "proposer back at the maximum");
  });
  reg("2027-02-10", "09:30", "T19 over the roster maximum, nobody fixes it", async () => {
    const [a, b] = [M[13], M[14]];
    await ensureFull(a, tick(s));
    const t19 = await propose(a, b, 1, 2, tick(s));
    await acceptTrade(db, { tradeId: t19.id, actorUserId: b.userId }, { now: tick(s), notify });
    s.named.set("t19", t19.id);
  });
  reg("2027-02-12", "05:00", "T19 invalidated when the review window ends", async () => {
    const row = await tradeRow(s, s.named.get("t19")!);
    same(ctx, row.status, "invalidated", "a trade that still doesn't fit when its window ends is invalidated");
    ok(ctx, (row.resolvedReason ?? "").includes("roster maximum"), "reason mentions the roster maximum");
  });

  // ---- The same player offered to two teams: the first deal to go through voids the other.
  reg("2027-02-24", "09:30", "T20 one player, two offers", async () => {
    const [a, b, c] = [M[4], M[7], M[9]];
    const mine = await tradeablePlayers(s, a, 2);
    const hisB = (await tradeablePlayers(s, b, 1))[0];
    const hisC = (await tradeablePlayers(s, c, 1))[0];
    const toB = await proposeTrade(db, { leagueId: lg, proposerTeamId: a.teamId, receiverTeamId: b.teamId, give: [mine[0]], get: [hisB], actorUserId: a.userId }, { now: tick(s), notify });
    const toC = await proposeTrade(db, { leagueId: lg, proposerTeamId: a.teamId, receiverTeamId: c.teamId, give: [mine[0]], get: [hisC], actorUserId: a.userId }, { now: tick(s), notify });
    ctx.counters.tradesProposed += 2;
    await acceptTrade(db, { tradeId: toB.id, actorUserId: b.userId }, { now: tick(s), notify });
    await acceptTrade(db, { tradeId: toC.id, actorUserId: c.userId }, { now: tick(s), notify });
    same(ctx, [await statusOf(s, toB.id), await statusOf(s, toC.id)], ["pending_review", "pending_review"], "both offers wait for the commissioner");
    await commissionerApprove(db, { tradeId: toB.id, actorUserId: admin.userId }, { now: tick(s), notify });
    ctx.counters.tradesExecuted++;
    same(ctx, [await statusOf(s, toB.id), await statusOf(s, toC.id)], ["executed", "invalidated"], "the second offer is voided once the player has moved");
    await rejectsWith(ctx, commissionerApprove(db, { tradeId: toC.id, actorUserId: admin.userId }, { now: tick(s) }), "wrong_state", "approving the voided offer");
  });

  // ---- A trade approved while games are in progress: games that already tipped off stay with the old owner.
  let t21: T;
  reg("2027-03-01", "09:30", "T21 propose+accept", async () => {
    // Players whose NBA teams tip off before the approval time, so the ownership rule has something to decide.
    const early = new Set((s.gamesByDate.get("2027-03-01") ?? []).filter((g) => g.startTime.getTime() < at("2027-03-01", "20:31").getTime()).flatMap((g) => [g.home, g.away]));
    const pickEarly = async (m: Manager, n: number) => {
      const { byTeam } = await loadRosters(s);
      const busy = await openTradePlayers(s);
      const ids = (byTeam.get(m.teamId) ?? []).filter((id) => !busy.has(id) && !s.noDrop.has(id) && early.has(ctx.world.byId.get(id)!.nbaTeamId ?? -1));
      ok(ctx, ids.length >= n, "enough early-game players to trade");
      return ctx.rand.shuffle(ids).slice(0, n);
    };
    const [a, b] = [M[3], M[4]];
    const [give, get] = [await pickEarly(a, 2), await pickEarly(b, 2)];
    const row = await proposeTrade(db, { leagueId: lg, proposerTeamId: a.teamId, receiverTeamId: b.teamId, give, get, actorUserId: a.userId }, { now: tick(s), notify });
    ctx.counters.tradesProposed++;
    t21 = { id: row.id, a, b, give, get };
    await acceptTrade(db, { tradeId: t21.id, actorUserId: t21.b.userId }, { now: tick(s), notify });
  });
  reg("2027-03-01", "20:31", "T21 approved mid-slate", async () => {
    await commissionerApprove(db, { tradeId: t21.id, actorUserId: admin.userId }, { now: ctx.now, notify });
    ctx.counters.tradesExecuted++;
    s.named.set("t21at", String(ctx.now.getTime()));
  });
  reg("2027-03-01", "23:55", "T21 ownership of tonight's games", async () => {
    const approvedAt = Number(s.named.get("t21at"));
    const day = "2027-03-01";
    const rowsA = await teamGamePoints(db, t21.a.teamId, { from: day, to: day });
    const rowsB = await teamGamePoints(db, t21.b.teamId, { from: day, to: day });
    const has = (rows: typeof rowsA, playerId: number, gameId: number) => rows.some((r) => r.playerId === playerId && r.gameId === gameId);
    const started = (s.gamesByDate.get(day) ?? []).filter((g) => g.startTime.getTime() < approvedAt);
    const gameOf = (nba: number | null) => started.find((g) => g.home === nba || g.away === nba)?.id ?? null;
    let checked = 0;
    for (const id of t21.give) {
      const g = gameOf(ctx.world.byId.get(id)!.nbaTeamId);
      if (g === null) continue;
      ok(ctx, has(rowsA, id, g) && !has(rowsB, id, g), `player ${id} tipped off for the proposer before the approval: the game stays with the proposer`);
      checked++;
    }
    for (const id of t21.get) {
      const g = gameOf(ctx.world.byId.get(id)!.nbaTeamId);
      if (g === null) continue;
      ok(ctx, has(rowsB, id, g) && !has(rowsA, id, g), `player ${id} tipped off for the receiver before the approval: the game stays with the receiver`);
      checked++;
    }
    ok(ctx, checked > 0, "at least one traded player had a game before the approval");
  });

  // ---- Deadline (March 4, inclusive).
  let t16: T;
  reg("2027-03-03", "09:30", "T16 propose before the deadline", async () => {
    t16 = await propose(M[5], M[6], 1, 1, tick(s));
  });
  reg("2027-03-03", "10:00", "T17 accepted just before the deadline", async () => {
    const t17 = await propose(M[7], M[8], 1, 1, tick(s));
    s.named.set("t17", t17.id);
  });
  reg("2027-03-04", "18:00", "T17 accepted on deadline day", async () => {
    const id = s.named.get("t17")!;
    const [t] = await db.select().from(trades).where(eq(trades.id, id));
    const b = M.find((m) => m.teamId === t.receiverTeamId)!;
    const res = await acceptTrade(db, { tradeId: id, actorUserId: b.userId }, { now: tick(s), notify });
    same(ctx, res.status, "pending_review", "accepted on the deadline day itself");
  });
  reg("2027-03-05", "10:00", "after the deadline", async () => {
    same(ctx, TRADE_DEADLINE, "2027-03-04", "deadline setting");
    await rejectsWith(ctx, acceptTrade(db, { tradeId: t16.id, actorUserId: t16.b.userId }, { now: tick(s) }), "deadline_passed", "accepting after the deadline");
    await rejectsWith(ctx, counterTrade(db, { tradeId: t16.id, give: await tradeablePlayers(s, t16.b, 1), get: t16.give.slice(0, 1), actorUserId: t16.b.userId }, { now: tick(s) }), "deadline_passed", "countering after the deadline");
    const g = await tradeablePlayers(s, M[9], 1);
    const r = await tradeablePlayers(s, M[10], 1);
    await rejectsWith(ctx, proposeTrade(db, { leagueId: lg, proposerTeamId: M[9].teamId, receiverTeamId: M[10].teamId, give: g, get: r, actorUserId: M[9].userId }, { now: tick(s) }), "deadline_passed", "proposing after the deadline");
    await rejectTrade(db, { tradeId: t16.id, actorUserId: t16.b.userId }, { now: tick(s), notify }); // rejecting is still allowed
    same(ctx, await statusOf(s, t16.id), "rejected", "rejecting after the deadline is allowed");
  });
  reg("2027-03-06", "05:00", "T17 executes after the deadline", async () => {
    same(ctx, await statusOf(s, s.named.get("t17")!), "executed", "a trade accepted before the deadline still executes after it");
    ctx.counters.tradesExecuted++;
  });
  reg("2027-03-23", "10:00", "no trades in the playoffs", async () => {
    const g = await tradeablePlayers(s, M[9], 1);
    const r = await tradeablePlayers(s, M[10], 1);
    await rejectsWith(ctx, proposeTrade(db, { leagueId: lg, proposerTeamId: M[9].teamId, receiverTeamId: M[10].teamId, give: g, get: r, actorUserId: M[9].userId }, { now: tick(s) }), "wrong_status", "trade proposal during the playoffs");
  });
}

// ======================================================================================== chat

function chatScenarios(s: Season) {
  const { ctx } = s;
  const { db, admin, rand } = ctx;
  const M = ctx.managers;
  const lg = ctx.leagueId;
  const etNoon = (date: string, hhmm: string) => at(date, hhmm);
  const say = async (m: Manager, body: string, when: Date) => {
    const row = await postMessage(db, { id: m.userId }, lg, { body }, { now: when, notify: ctx.notify });
    ctx.counters.chatMessages++;
    return row;
  };
  const mentionedBy = (user: Manager) => ctx.sent.filter((n) => n.type === "chat_mentions" && n.userIds.includes(user.userId)).length;

  addScript(s, "2026-10-19", "20:00", "mentions", async () => {
    const before = [mentionedBy(M[4]), mentionedBy(M[5]), mentionedBy(M[6])];
    await say(M[2], "Great draft everyone. @MGR05 you stole my guy, @mgr06 nice value, @ghostuser who?", etNoon("2026-10-19", "20:00"));
    same(ctx, [mentionedBy(M[4]) - before[0], mentionedBy(M[5]) - before[1], mentionedBy(M[6]) - before[2]], [1, 1, 0], "mentions are case-insensitive and only reach members");
    await setPref(db, M[7].userId, "chat_messages", { inApp: true });
    await say(M[3], "Anyone else keeping an eye on the injury report?", etNoon("2026-10-19", "20:05"));
    const got = await db.select().from(notifications).where(and(eq(notifications.userId, M[7].userId), eq(notifications.type, "chat_messages")));
    ok(ctx, got.length >= 1, "an opted-in member gets every chat message in-app");
    const none = await db.select().from(notifications).where(and(eq(notifications.userId, M[8].userId), eq(notifications.type, "chat_messages")));
    same(ctx, none.length, 0, "chat_messages is off by default");
  });

  addScript(s, "2026-11-05", "09:00", "edit, delete, pin, announce", async () => {
    const t0 = etNoon("2026-11-05", "09:00");
    const m1 = await say(M[2], "Anyone want to trade a bigg man?", t0);
    const edited = await editMessage(db, { id: M[2].userId }, m1.id, "Anyone want to trade a big man?", { now: new Date(t0.getTime() + 5 * MINUTE) });
    ok(ctx, edited.editedAt !== null && edited.body.includes("big man?"), "author edited within 15 minutes");
    await rejectsWith(ctx, editMessage(db, { id: M[3].userId }, m1.id, "Hacked", { now: new Date(t0.getTime() + 6 * MINUTE) }), "forbidden", "editing someone else's message");
    await rejectsWith(ctx, editMessage(db, { id: M[2].userId }, m1.id, "Too late", { now: new Date(t0.getTime() + 20 * MINUTE) }), "edit_window_closed", "editing after 15 minutes");
    const m2 = await say(M[3], "Oops wrong league chat", new Date(t0.getTime() + 7 * MINUTE));
    await deleteMessage(db, { id: M[3].userId }, m2.id, { now: new Date(t0.getTime() + 8 * MINUTE) });
    await rejectsWith(ctx, deleteMessage(db, { id: M[3].userId }, m2.id, { now: new Date(t0.getTime() + 9 * MINUTE) }), "not_found", "deleting twice");
    const m3 = await say(M[4], "this league is rigged", new Date(t0.getTime() + 10 * MINUTE));
    await rejectsWith(ctx, deleteMessage(db, { id: M[5].userId }, m3.id, { now: new Date(t0.getTime() + 11 * MINUTE) }), "forbidden", "deleting someone else's message");
    await deleteMessage(db, { id: admin.userId }, m3.id, { now: new Date(t0.getTime() + 12 * MINUTE) });
    const ann = await postAnnouncement(db, { id: admin.userId }, lg, "Reminder: the trade deadline is March 4 and the commissioner reviews every trade.", { now: new Date(t0.getTime() + 13 * MINUTE), notify: ctx.notify });
    await rejectsWith(ctx, postAnnouncement(db, { id: M[2].userId }, lg, "Fake news", { now: new Date(t0.getTime() + 14 * MINUTE) }), "forbidden", "announcement by a non-commissioner");
    same(ctx, ctx.sent.filter((n) => n.type === "league_announcements").at(-1)!.userIds.length, 15, "announcement reaches the 15 other members");
    await rejectsWith(ctx, setPinned(db, { id: M[2].userId }, ann.id, true, { now: t0 }), "forbidden", "pinning by a member");
    await setPinned(db, { id: admin.userId }, ann.id, true, { now: new Date(t0.getTime() + 15 * MINUTE) });
    ok(ctx, (await listPinned(db, { id: M[2].userId }, lg)).some((m) => m.id === ann.id), "pinned message listed");
    await setPinned(db, { id: admin.userId }, ann.id, false, { now: new Date(t0.getTime() + 16 * MINUTE) });
    ok(ctx, !(await listPinned(db, { id: M[2].userId }, lg)).some((m) => m.id === ann.id), "unpinned message gone from the pins");
    await setPinned(db, { id: admin.userId }, ann.id, true, { now: new Date(t0.getTime() + 17 * MINUTE) });
    // Unread counters: the author reads up to now, the rest still see everything since their last read.
    await markChatRead(db, M[6].userId, lg, new Date(t0.getTime() + 30 * MINUTE));
    await say(M[2], "Thanks for the reminder.", new Date(t0.getTime() + 31 * MINUTE));
    same(ctx, await chatUnreadCount(db, M[6].userId, lg), 1, "one message since the last read");
    same(ctx, await chatUnreadCount(db, M[2].userId, lg), 0, "posting marks the poster as read");
    await markChatRead(db, M[6].userId, lg, new Date(t0.getTime() + 32 * MINUTE));
    same(ctx, await chatUnreadCount(db, M[6].userId, lg), 0, "read again");
  });

  addScript(s, "2026-11-06", "12:00", "chat rate limit", async () => {
    const t0 = etNoon("2026-11-06", "12:00");
    for (let i = 0; i < 10; i++) await say(M[10], `spam ${i}`, new Date(t0.getTime() + i * 2000));
    await rejectsWith(ctx, say(M[10], "spam 11", new Date(t0.getTime() + 25_000)), "rate_limited", "the 11th message within a minute");
    await say(M[10], "ok sorry", new Date(t0.getTime() + 2 * MINUTE));
  });

  // Weekly chatter: a few messages from random members, some mentioning someone.
  for (let week = 0; week < 24; week++) {
    const date = new Date(Date.UTC(2026, 9, 26) + week * 7 * 86_400_000).toISOString().slice(0, 10);
    addScript(s, date, "13:00", "weekly chatter", async () => {
      const t0 = etNoon(date, "13:00");
      const n = rand.between(2, 4);
      for (let i = 0; i < n; i++) {
        const from = rand.pick(M);
        const target = rand.pick(M.filter((x) => x.userId !== from.userId));
        const body = rand.chance(0.4) ? `@${target.username} that trade offer is a joke` : rand.pick(["Who is hot this week?", "Streaming the 9th guy again.", "I need a miracle from my bench.", "This schedule is brutal."]);
        const before = mentionedBy(target);
        await say(from, body, new Date(t0.getTime() + i * 3 * MINUTE));
        if (body.startsWith("@")) same(ctx, mentionedBy(target) - before, 1, "weekly mention notified its target");
      }
      // Half the league opens the chat now and then.
      for (const m of rand.shuffle(M).slice(0, 7)) await markChatRead(db, m.userId, lg, new Date(t0.getTime() + 30 * MINUTE));
    });
  }

  addScript(s, "2027-01-26", "19:00", "unread chat for the checkpoint", async () => {
    const t0 = etNoon("2027-01-26", "19:00");
    await markChatRead(db, M[4].userId, lg, new Date(t0.getTime() - 60 * MINUTE));
    await say(M[5], "Anyone seen that trade offer from @" + M[4].username + "?", new Date(t0.getTime() - 40 * MINUTE));
    await say(M[6], "Playoff race is wild already.", new Date(t0.getTime() - 20 * MINUTE));
    const unread = await chatUnreadCount(db, M[4].userId, lg);
    const rows = await db.select().from(messages).where(eq(messages.leagueId, lg));
    ok(ctx, unread >= 2 && unread <= rows.length, "unread chat for the checkpoint");
    s.named.set("unreadUser", M[4].userId);
    await markAllRead(db, M[13].userId);
    same(ctx, await unreadCount(db, M[13].userId), 0, "markAllRead clears notifications");
  });
}

// ================================================================== corrections / adjustments

function correctionsAndAdjustments(s: Season) {
  const { ctx } = s;
  const { db, admin } = ctx;
  const periodStarting = (date: string) => s.periods.find((p) => p.startDate === date)!;

  // Stat correction one day after week 5 (Nov 16-22) ended, inside the 3-day window: the next nightly run re-finalizes it.
  addScript(s, "2026-11-23", "15:00", "stat correction", async () => {
    const p = periodStarting("2026-11-16");
    const rows = (await db.select().from(matchups).where(eq(matchups.periodId, p.id))).filter((m) => m.status === "final" && m.homeTeamId && m.awayTeamId);
    same(ctx, rows.length, 8, "week 5 finalized on Nov 23");
    const lastDay = await loadOracleData(db, ctx.leagueId, p.endDate, p.endDate);
    const ordered = rows.map((m) => ({ m, margin: Math.abs((m.homePoints ?? 0) - (m.awayPoints ?? 0)) })).sort((a, b) => a.margin - b.margin);
    for (const { m, margin } of ordered) {
      const loser = (m.homePoints ?? 0) < (m.awayPoints ?? 0) ? m.homeTeamId! : m.awayTeamId!;
      for (const g of lastDay.games) {
        for (const e of lastDay.entries.filter((x) => x.teamId === loser && x.from <= g.start && (x.to === null || x.to > g.start))) {
          const st = lastDay.stats.get(`${g.id}:${e.playerId}`);
          if (!st || st.dnp || g.status !== "final") continue;
          const bump = Math.ceil(margin) + 9;
          await db.update(playerGameStats).set({ pts: st.pts + bump }).where(and(eq(playerGameStats.gameId, g.id), eq(playerGameStats.playerId, e.playerId)));
          s.named.set("correctionMatchup", m.id);
          s.named.set("correctionWinner", loser);
          s.named.set("correctionOld", JSON.stringify([m.homePoints, m.awayPoints, m.winnerTeamId]));
          return;
        }
      }
    }
    throw new Error("no matchup had a corrected-able player on the last day");
  });
  addScript(s, "2026-11-24", "05:00", "stat correction re-finalized", async () => {
    const [m] = await db.select().from(matchups).where(eq(matchups.id, s.named.get("correctionMatchup")!));
    const old = JSON.parse(s.named.get("correctionOld")!) as [number, number, string | null];
    same(ctx, m.winnerTeamId, s.named.get("correctionWinner")!, "the correction flipped the winner and the nightly job re-finalized the week");
    ok(ctx, old[2] !== m.winnerTeamId, "winner differs from before the correction");
    const p = periodStarting("2026-11-16");
    await verifyPeriod(s, p, { requireFinal: true });
    await verifyStandings(s, "after the stat correction");
  });

  // Commissioner adjustments: one on a finished week, one on a live week.
  addScript(s, "2026-12-08", "10:00", "adjustment on a final week", async () => {
    const p = periodStarting("2026-11-30");
    const rows = (await db.select().from(matchups).where(eq(matchups.periodId, p.id))).filter((m) => m.status === "final");
    const closest = rows.map((m) => ({ m, margin: Math.abs((m.homePoints ?? 0) - (m.awayPoints ?? 0)) })).sort((a, b) => a.margin - b.margin)[0];
    const m = closest.m;
    const loserId = (m.homePoints ?? 0) < (m.awayPoints ?? 0) ? m.homeTeamId! : m.awayTeamId!;
    const stranger = ctx.managers.find((x) => x.userId !== admin.userId && x.teamId !== m.homeTeamId && x.teamId !== m.awayTeamId)!;
    await rejectsWith(ctx, adjustMatchupScore(db, { id: stranger.userId }, m.id, loserId, 5, "Not my call to make"), "forbidden", "adjustment by a non-commissioner");
    await rejectsWith(ctx, adjustMatchupScore(db, { id: admin.userId }, m.id, loserId, 0, "Nothing to change"), "invalid_input", "zero adjustment");
    await rejectsWith(ctx, adjustMatchupScore(db, { id: admin.userId }, m.id, loserId, 5, "no"), "invalid_input", "reason too short");
    await rejectsWith(ctx, adjustMatchupScore(db, { id: admin.userId }, m.id, stranger.teamId, 5, "Wrong team here"), "invalid_input", "team not in the matchup");
    const res = await adjustMatchupScore(db, { id: admin.userId }, m.id, loserId, Math.ceil(closest.margin) + 12.5, "Game stats were missing for a postponed game.", { now: tick(s), notify: ctx.notify });
    same(ctx, res.warnings, [], "adjusting a regular-season week before the playoffs warns about nothing");
    const [after] = await db.select().from(matchups).where(eq(matchups.id, m.id));
    same(ctx, after.winnerTeamId, loserId, "adjustment flipped the result");
    await verifyPeriod(s, p, { requireFinal: true });
    await verifyStandings(s, "after the adjustment to a final week");
    const owner = ctx.managers.find((x) => x.teamId === loserId)!;
    if (owner.userId !== admin.userId) ok(ctx, ctx.sent.some((n) => n.title === "Commissioner adjusted your score" && n.userIds[0] === owner.userId), "owner told about the adjustment");
  });
  addScript(s, "2026-12-16", "12:00", "adjustment on a live week", async () => {
    const p = periodStarting("2026-12-14");
    const rows = (await db.select().from(matchups).where(eq(matchups.periodId, p.id))).filter((m) => m.homeTeamId && m.awayTeamId);
    const m = rows[3];
    await computeMatchupTotals(db, m.id, tick(s));
    const before = (await db.select().from(matchups).where(eq(matchups.id, m.id)))[0];
    ok(ctx, before.status !== "final", "week 9 is still live on Dec 16");
    await adjustMatchupScore(db, { id: admin.userId }, m.id, m.awayTeamId!, -15, "Penalty for a late lineup change.", { now: tick(s), notify: ctx.notify });
    const after = (await db.select().from(matchups).where(eq(matchups.id, m.id)))[0];
    ok(ctx, after.status !== "final" && r2((after.awayPoints ?? 0) - (before.awayPoints ?? 0)) === -15, "live adjustment applied to the running total");
  });
}

// ======================================================================================== misc

function miscScenarios(s: Season) {
  const { ctx } = s;
  const { db } = ctx;
  const M = ctx.managers;

  // A flaky manager is replaced: the commissioner gives his team (roster, history, open trades) to a new account.
  addScript(s, "2027-02-20", "10:00", "team ownership transfer", async () => {
    const old = M[14];
    const actor = { id: ctx.admin.userId, isSiteAdmin: true };
    const fresh = await createUser(db, { username: "newguy", password: pw(18) });
    await rejectsWith(ctx, transferTeamOwnership(db, { id: old.userId, isSiteAdmin: false }, old.teamId, "newguy", { now: tick(s) }), "forbidden", "ownership transfer by a non-commissioner");
    await rejectsWith(ctx, transferTeamOwnership(db, actor, old.teamId, "nobody-here", { now: tick(s) }), "user_not_found", "transfer to an unknown user");
    await rejectsWith(ctx, transferTeamOwnership(db, actor, old.teamId, M[5].username, { now: tick(s) }), "already_on_team", "transfer to someone who already has a team");
    await rejectsWith(ctx, transferTeamOwnership(db, actor, old.teamId, old.username, { now: tick(s) }), "same_owner", "transfer to the current owner");
    await rejectsWith(ctx, transferTeamOwnership(db, actor, M[0].teamId, "newguy", { now: tick(s) }), "cannot_transfer_commissioner_team", "giving away the commissioner's team");
    const rosterBefore = (await loadRosters(s)).byTeam.get(old.teamId)!.length;
    const team = await transferTeamOwnership(db, actor, old.teamId, "newguy", { now: tick(s), notify: ctx.notify });
    same(ctx, [team.ownerId, team.name], [fresh.id, old.teamName], "the team changed hands with its name");
    same(ctx, (await loadRosters(s)).byTeam.get(old.teamId)!.length, rosterBefore, "the roster went with the team");
    ok(ctx, ctx.sent.some((n) => n.title === "You were given a team" && n.userIds[0] === fresh.id), "new owner told");
    ok(ctx, ctx.sent.some((n) => n.title === "You no longer own a team" && n.userIds[0] === old.userId), "old owner told");
    await rejectsWith(ctx, getLeagueView(db, { id: old.userId, isSiteAdmin: false }, ctx.leagueId), "forbidden", "the former owner viewing the league");
    ctx.extraUsers.push({ username: old.username, password: old.password, userId: old.userId, teamId: null, teamName: null, role: "non-member", isSiteAdmin: false });
    Object.assign(old, { username: "newguy", password: pw(18), userId: fresh.id });
  });

  addScript(s, "2027-02-02", "11:00", "transactions feed", async () => {
    const all = await listTransactions(db, ctx.leagueId, { limit: 50 });
    ok(ctx, all.total > 20, "transactions feed has history");
    const trades2 = await listTransactions(db, ctx.leagueId, { type: "trade", limit: 10 });
    ok(ctx, trades2.rows.every((r) => r.type === "trade"), "type filter works");
    const mine = await listTransactions(db, ctx.leagueId, { teamId: M[4].teamId, limit: 10 });
    ok(ctx, mine.rows.every((r) => r.teamId === M[4].teamId), "team filter works");
    const page2 = await listTransactions(db, ctx.leagueId, { limit: 10, offset: 10 });
    same(ctx, page2.total, all.total, "pagination keeps the total");
  });
}

