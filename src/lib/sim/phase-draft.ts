/** The async snake + wave draft for the simulation (2026-10-14 queues, 2026-10-16 start, done before opening night). */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { draftPicks, draftQueue, leagues, rosterEntries } from "@/db/schema";
import {
  addToQueue,
  getDraftByLeague,
  makePick,
  removeFromQueue,
  reorderQueue,
  restartDraft,
  startDraft,
  undoLastPick,
} from "@/lib/draft/service";
import { getDraftBoard, listDraftablePlayers } from "@/lib/draft/board";
import { waveTarget } from "@/lib/draft/engine";
import {
  getLeagueInviteInfo,
  joinLeague,
  listLeagueInvites,
  redeemLeagueInvite,
} from "@/lib/leagues/service";
import { etDateString, etHour } from "@/lib/nba/dates";
import { at, checkpoint, eq as same, ok, rejectsWith, timed, type Ctx, type Manager } from "./context";
import { MINUTE, HOUR, type SimPlayer } from "./nba-data";
import { LEAGUE_NAME } from "./phase-setup";

export type DraftRecord = { overall: number; teamId: string; playerId: number; byCommissioner: boolean };

type St = {
  clock: Date;
  pool: SimPlayer[];
  /** Everything ever picked in the CURRENT (post-restart) draft. */
  log: DraftRecord[];
  draftId: string;
  order: string[];
  picksBy: Map<string, number>;
};

const SNAKE_ROUNDS = 12;
const MAX_ROSTER = 32;

const baseValue = (p: SimPlayer) => p.prevQ ?? 8;

function eligiblePool(ctx: Ctx): SimPlayer[] {
  return ctx.world.players.filter((p) => p.active && p.nbaTeamId !== null).sort((a, b) => baseValue(b) - baseValue(a) || a.id - b.id);
}

/** Moves the clock forward by `ms`, skipping the night (11pm to 8am ET). */
function advance(st: St, ms: number, ctx: Ctx) {
  let t = new Date(st.clock.getTime() + ms);
  const h = etHour(t);
  if (h >= 23 || h < 8) {
    const date = h >= 23 ? etDateString(new Date(t.getTime() + 12 * HOUR)) : etDateString(t);
    t = new Date(at(date, "08:00").getTime() + ctx.rand.int(40) * MINUTE);
  }
  st.clock = t;
}

async function queueOf(ctx: Ctx, teamId: string): Promise<number[]> {
  const rows = await ctx.db.select().from(draftQueue).where(eq(draftQueue.teamId, teamId)).orderBy(asc(draftQueue.rank), asc(draftQueue.createdAt));
  return rows.map((r) => r.playerId);
}

async function chooseFor(ctx: Ctx, st: St, m: Manager): Promise<SimPlayer> {
  if (m.style === "queue") {
    const q = await queueOf(ctx, m.teamId);
    for (const id of q) {
      const p = st.pool.find((x) => x.id === id);
      if (p) return p;
    }
  }
  const scan = st.pool.slice(0, 14);
  if (m.style === "sleeper") {
    // Knows the rookies: also looks at the breakout rookies hiding down the list.
    scan.push(...st.pool.slice(14).filter((p) => p.rookie).slice(0, 12));
  }
  let best = scan[0];
  let bestScore = -Infinity;
  for (const p of scan) {
    const base = m.style === "sleeper" && p.rookie ? p.q * 0.85 : baseValue(p);
    const score = base * (0.88 + ctx.rand.next() * 0.24);
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

async function doPick(ctx: Ctx, st: St, m: Manager, p: SimPlayer, byCommissioner: boolean) {
  const res = await timed(ctx, "draft.makePick", () =>
    makePick(ctx.db, st.draftId, m.teamId, p.id, byCommissioner ? ctx.admin.userId : m.userId, {
      asCommissioner: byCommissioner,
      now: st.clock,
      notify: ctx.notify,
    }),
  );
  ctx.counters.picks++;
  if (byCommissioner) ctx.counters.commissionerPicks++;
  st.pool.splice(st.pool.indexOf(p), 1);
  st.picksBy.set(m.teamId, (st.picksBy.get(m.teamId) ?? 0) + 1);
  st.log.push({ overall: res.pick.overallPick, teamId: m.teamId, playerId: p.id, byCommissioner });
  same(ctx, res.pick.overallPick, st.log.length, "overall pick number is sequential");
  return res;
}

const snakeIdx = (n: number, teamCount: number) => {
  const round = Math.floor((n - 1) / teamCount);
  const pos = (n - 1) % teamCount;
  return round % 2 === 0 ? pos : teamCount - 1 - pos;
};

async function buildQueues(ctx: Ctx) {
  const { db, rand } = ctx;
  const top = eligiblePool(ctx).slice(0, 70);
  for (const m of ctx.managers.filter((x) => x.style === "queue")) {
    const picks = rand.shuffle(top).slice(0, 12);
    for (const p of picks) await addToQueue(db, m.teamId, p.id, m.userId);
    // The owner re-orders by his own taste and removes one entry he changed his mind about.
    await reorderQueue(db, m.teamId, [...picks].sort((a, b) => baseValue(b) - baseValue(a)).map((p) => p.id), m.userId);
    await removeFromQueue(db, m.teamId, picks[0].id, m.userId);
    const q = await queueOf(ctx, m.teamId);
    same(ctx, q.length, 11, `${m.username} queue length after a removal`);
    ok(ctx, !q.includes(picks[0].id), "removed player left the queue");
    const expected = [...picks].filter((p) => p.id !== picks[0].id).sort((a, b) => baseValue(b) - baseValue(a)).map((p) => p.id);
    same(ctx, q, expected, `${m.username} queue order follows reorderQueue`);
  }
  const some = ctx.managers[3];
  const retired = ctx.world.players.find((p) => !p.active)!;
  const teamless = ctx.world.players.find((p) => p.active && p.nbaTeamId === null)!;
  await rejectsWith(ctx, addToQueue(db, some.teamId, retired.id, some.userId), "player_unavailable", "queueing an inactive player");
  await rejectsWith(ctx, addToQueue(db, some.teamId, teamless.id, some.userId), "player_unavailable", "queueing a player on no NBA team");
  await rejectsWith(ctx, addToQueue(db, some.teamId, top[0].id, ctx.managers[4].userId), "forbidden", "queueing for someone else's team");
}

export async function runDraft(ctx: Ctx): Promise<{ draftId: string; order: string[]; log: DraftRecord[]; finishedAt: Date }> {
  const { db, rand, admin } = ctx;
  const actor = { id: admin.userId, isSiteAdmin: true };
  const manager = (teamId: string) => ctx.managers.find((m) => m.teamId === teamId)!;
  const st: St = { clock: at("2026-10-16", "09:00"), pool: eligiblePool(ctx), log: [], draftId: "", order: [], picksBy: new Map(), };
  ok(ctx, st.pool.length >= 512 + 60, "enough draftable players for 512 picks plus a free-agent pool");

  await buildQueues(ctx);
  await rejectsWith(ctx, restartDraft(db, ctx.leagueId, admin.userId, LEAGUE_NAME), "cannot_restart", "restarting a draft that never started");

  // ---- start, five picks, restart, start again
  const start = async () => {
    const d = await startDraft(db, ctx.leagueId, admin.userId, { now: st.clock, random: (n) => rand.int(n), notify: ctx.notify });
    st.draftId = d.id;
    st.order = d.order;
    st.log = [];
    st.picksBy = new Map();
    st.pool = eligiblePool(ctx);
    same(ctx, [d.status, d.currentPick, d.maxRoster, d.snakeRounds, d.totalRounds], ["snake", 1, MAX_ROSTER, SNAKE_ROUNDS, MAX_ROSTER], "draft shape for 16 teams");
    same(ctx, new Set(d.order).size, 16, "draft order has all 16 teams");
    same(ctx, new Set(d.order.filter((t) => ctx.managers.some((m) => m.teamId === t))).size, 16, "draft order only holds league teams");
    const [lg] = await db.select().from(leagues).where(eq(leagues.id, ctx.leagueId));
    same(ctx, lg.status, "drafting", "league is drafting");
    const first = manager(d.order[0]);
    ok(ctx, ctx.sent.some((n) => n.type === "draft_on_clock" && n.userIds[0] === first.userId), "pick 1 owner was notified");
    ok(ctx, ctx.sent.some((n) => n.type === "draft_events" && n.title === "Draft started" && n.userIds.length === 16), "everyone was told the draft started");
    return d;
  };
  await start();
  await rejectsWith(ctx, startDraft(db, ctx.leagueId, admin.userId, { now: st.clock }), "already_started", "starting twice");

  // Invites are closed while the draft runs.
  const links = await listLeagueInvites(db, actor, ctx.leagueId, st.clock);
  ok(ctx, links.every((l) => l.status === "closed" || l.status === "revoked"), "all invite links closed once the draft starts");
  const open = links.find((l) => l.token && l.status === "closed")!;
  await rejectsWith(ctx, redeemLeagueInvite(db, { token: open.token!, username: "latejoiner", password: "late-pass-1", teamName: "Late Team", teamAbbrev: "LTE" }, st.clock), "wrong_status", "joining after the draft started");
  await rejectsWith(ctx, joinLeague(db, { id: ctx.nonMember!.userId, isSiteAdmin: false }, { token: open.token!, teamName: "Late Team", teamAbbrev: "LTE" }, st.clock), "wrong_status", "existing user joining after the draft started");
  same(ctx, (await getLeagueInviteInfo(db, open.token!, st.clock)).status, "valid", "info for a closed link still resolves (league is not in setup)");

  for (let i = 0; i < 5; i++) {
    const d = (await getDraftByLeague(db, ctx.leagueId))!;
    const m = manager(st.order[snakeIdx(d.currentPick, 16)]);
    await doPick(ctx, st, m, await chooseFor(ctx, st, m), false);
    advance(st, 4 * MINUTE, ctx);
  }
  await rejectsWith(ctx, restartDraft(db, ctx.leagueId, admin.userId, "Not The Name"), "confirm_mismatch", "restart needs the league name");
  await rejectsWith(ctx, restartDraft(db, ctx.leagueId, ctx.managers[2].userId, LEAGUE_NAME), "forbidden", "non-commissioner restarting");
  advance(st, 3 * HOUR, ctx);
  const queuesBefore = await Promise.all(ctx.managers.filter((m) => m.style === "queue").map(async (m) => (await queueOf(ctx, m.teamId)).length));
  const restarted = await restartDraft(db, ctx.leagueId, admin.userId, LEAGUE_NAME.toUpperCase(), { now: st.clock, notify: ctx.notify });
  same(ctx, restarted.picksRemoved, 5, "restart removed the five picks");
  same(ctx, (await db.select().from(draftPicks)).length, 0, "no picks left after a restart");
  same(ctx, (await db.select().from(rosterEntries).where(eq(rosterEntries.leagueId, ctx.leagueId))).length, 0, "no roster entries left after a restart");
  same(ctx, (await getDraftByLeague(db, ctx.leagueId)), null, "draft row removed by the restart");
  same(ctx, (await db.select().from(leagues).where(eq(leagues.id, ctx.leagueId)))[0].status, "setup", "league back in setup");
  const queuesAfter = await Promise.all(ctx.managers.filter((m) => m.style === "queue").map(async (m) => (await queueOf(ctx, m.teamId)).length));
  ok(ctx, queuesAfter.every((n, i) => n <= queuesBefore[i]) && queuesAfter.some((n) => n > 0), "queues survive a restart (minus players picked)");
  advance(st, 20 * MINUTE, ctx);
  const second = await start();
  ok(ctx, second.order.length === 16, "restarted draft has a fresh order");

  // ---- snake
  let stallRounds = 0;
  let probed = false;
  let undone = false;
  let checked = 0;
  const snakeTotal = 16 * SNAKE_ROUNDS;
  for (let guard = 0; guard < snakeTotal + 10; guard++) {
    const d = (await getDraftByLeague(db, ctx.leagueId))!;
    if (d.status !== "snake") break;
    const n = d.currentPick;
    const m = manager(st.order[snakeIdx(n, 16)]);
    same(ctx, d.currentPick, st.log.length + 1, "draft pointer matches the picks made");

    if (!probed && n === 20) {
      probed = true;
      const other = ctx.managers.find((x) => x.teamId !== m.teamId && !x.stalled)!;
      const ghost = st.pool[0];
      await rejectsWith(ctx, makePick(db, st.draftId, other.teamId, ghost.id, other.userId, { now: st.clock, notify: ctx.notify }), "not_your_turn", "picking out of turn");
      await rejectsWith(ctx, makePick(db, st.draftId, m.teamId, ghost.id, other.userId, { now: st.clock, notify: ctx.notify }), "forbidden", "picking for someone else's team");
      await rejectsWith(ctx, makePick(db, st.draftId, m.teamId, ctx.world.players.find((p) => !p.active)!.id, m.userId, { now: st.clock, notify: ctx.notify }), "player_unavailable", "picking a retired player");
      await rejectsWith(ctx, makePick(db, st.draftId, m.teamId, ctx.world.players.find((p) => p.active && p.nbaTeamId === null)!.id, m.userId, { now: st.clock, notify: ctx.notify }), "player_unavailable", "picking a player on no NBA team");
      await rejectsWith(ctx, makePick(db, st.draftId, m.teamId, 12345, m.userId, { now: st.clock, notify: ctx.notify }), "player_unavailable", "picking an unknown player id");
      await rejectsWith(ctx, makePick(db, st.draftId, m.teamId, st.log[0].playerId, m.userId, { now: st.clock, notify: ctx.notify }), "player_taken", "picking a drafted player");
      // The commissioner can't act for a team without saying so, but can with asCommissioner.
      if (m.userId !== admin.userId) {
        await rejectsWith(ctx, makePick(db, st.draftId, m.teamId, ghost.id, admin.userId, { now: st.clock, notify: ctx.notify }), "forbidden", "commissioner picking without asCommissioner");
      }
    }

    const round = Math.floor((n - 1) / 16) + 1;
    const noticesBefore = ctx.sent.length;
    const stallNow = m.stalled && [3, 6, 10].includes(round) && stallRounds < 6;
    if (stallNow) {
      stallRounds++;
      advance(st, 2 * HOUR, ctx);
      await doPick(ctx, st, m, st.pool[0], true);
    } else {
      await doPick(ctx, st, m, await chooseFor(ctx, st, m), false);
    }

    // Snake order rules checked as we go: round 2 reverses, etc.
    const picked = st.log[st.log.length - 1];
    same(ctx, picked.teamId, st.order[snakeIdx(picked.overall, 16)], `pick ${picked.overall} belongs to the right team`);

    // Heads-up: after pick k the clock is on k+1; whoever picks at k+3 hears he is close, unless he picks at k+1 or k+2.
    {
      const k = picked.overall;
      const fresh = ctx.sent.slice(noticesBefore).filter((x) => x.type === "draft_heads_up");
      const ahead = k + 3;
      let expected: string[] = [];
      if (k + 1 <= snakeTotal && ahead <= snakeTotal) {
        const target = st.order[snakeIdx(ahead, 16)];
        const soon = new Set([st.order[snakeIdx(k + 1, 16)], st.order[snakeIdx(k + 2, 16)]]);
        if (!soon.has(target)) expected = [manager(target).userId];
      }
      same(ctx, fresh.map((x) => x.userIds[0]), expected, `heads-up after pick ${k}`);
    }

    if (picked.overall < snakeTotal) {
      const next = manager(st.order[snakeIdx(picked.overall + 1, 16)]);
      const recent = ctx.sent.slice(-4);
      ok(ctx, recent.some((x) => x.type === "draft_on_clock" && x.userIds.length === 1 && x.userIds[0] === next.userId), `pick ${picked.overall + 1} owner was told he is on the clock`);
    }

    if (!undone && picked.overall === 40) {
      undone = true;
      const before = ctx.counters.picks;
      const undonePick = await undoLastPick(db, st.draftId, admin.userId, { now: st.clock, notify: ctx.notify });
      same(ctx, undonePick.playerId, picked.playerId, "undo removed the last pick");
      same(ctx, (await getDraftByLeague(db, ctx.leagueId))!.currentPick, 40, "pointer rolled back");
      same(ctx, (await db.select().from(rosterEntries).where(and(eq(rosterEntries.playerId, picked.playerId), isNull(rosterEntries.releasedAt)))).length, 0, "undone player is a free agent again");
      ctx.counters.picks = before - 1;
      const player = ctx.world.byId.get(picked.playerId)!;
      st.pool.push(player);
      st.pool.sort((a, b) => baseValue(b) - baseValue(a) || a.id - b.id);
      st.log.pop();
      st.picksBy.set(picked.teamId, (st.picksBy.get(picked.teamId) ?? 1) - 1);
      ok(ctx, ctx.sent.some((x) => x.title === "Pick undone"), "owner told about the undo");
      const m2 = manager(picked.teamId);
      await doPick(ctx, st, m2, st.pool.find((p) => p.id !== player.id)!, false); // changed his mind
    }

    if (st.log.length === 100) await checkpoint(ctx, "draft-snake", st.clock, "after pick 100 of 192");
    if (st.log.length % 48 === 0 && checked < 4) {
      checked++;
      const list = await listDraftablePlayers(db, ctx.leagueId, { limit: 60, now: st.clock });
      same(ctx, list.total, ctx.world.players.filter((p) => p.active && p.nbaTeamId !== null).length - st.log.length, "draftable list excludes picked players");
      const fps = list.players.map((p) => p.fp).filter((x): x is number => x !== null);
      ok(ctx, fps.every((v, i) => i === 0 || fps[i - 1] >= v), "draft list is sorted by last-season FP");
      ok(ctx, list.players.slice(0, 10).every((p) => p.fp !== null), "top of the draft list has last-season FP");
    }
    advance(st, (2 + rand.int(7)) * MINUTE, ctx);
  }
  same(ctx, st.log.length, snakeTotal, "snake produced 192 picks");

  // ---- waves
  let d = (await getDraftByLeague(db, ctx.leagueId))!;
  same(ctx, [d.status, d.currentWave], ["waves", 1], "snake ends in wave 1");
  ok(ctx, ctx.sent.filter((n) => n.type === "draft_wave_open").length >= 1, "wave open notice sent");
  let waveProbed = false;
  let raceProbed = false;
  let wavesCheckpoint = false;
  for (let guard = 0; guard < 12; guard++) {
    d = (await getDraftByLeague(db, ctx.leagueId))!;
    if (d.status !== "waves") break;
    const wave = d.currentWave!;
    const target = waveTarget({ snakeRounds: SNAKE_ROUNDS, totalRounds: MAX_ROSTER, waveSize: 2 }, wave);
    const slots = rand.shuffle(ctx.managers.flatMap((m) => Array.from({ length: Math.max(0, target - (st.picksBy.get(m.teamId) ?? 0)) }, () => m)));
    same(ctx, slots.length, 32, `wave ${wave} owes 2 picks per team`);
    const waveStart = st.log.length;
    advance(st, 15 * MINUTE, ctx);
    for (const m of slots.filter((x) => !x.stalled)) {
      if (wave === 2 && !raceProbed && st.log.length > waveStart && st.log[st.log.length - 1].teamId !== m.teamId) {
        // Two owners race for the same player: the loser's click is rejected and he picks again.
        raceProbed = true;
        await rejectsWith(ctx, makePick(db, st.draftId, m.teamId, st.log[st.log.length - 1].playerId, m.userId, { now: st.clock, notify: ctx.notify }), "player_taken", "wave pick of a player just taken");
      }
      await doPick(ctx, st, m, await chooseFor(ctx, st, m), false);
      if (!waveProbed && (st.picksBy.get(m.teamId) ?? 0) === target) {
        waveProbed = true;
        await rejectsWith(ctx, makePick(db, st.draftId, m.teamId, st.pool[0].id, m.userId, { now: st.clock, notify: ctx.notify }), "no_wave_quota", "picking past the wave quota");
        await rejectsWith(ctx, makePick(db, st.draftId, m.teamId, st.log[0].playerId, ctx.managers.find((x) => x.teamId !== m.teamId)!.userId, { now: st.clock, notify: ctx.notify }), "forbidden", "wave pick for someone else's team");
      }
      advance(st, (15 + rand.int(45)) * 1000, ctx);
      if (wave === 3 && !wavesCheckpoint && st.log.length - waveStart === 16) {
        wavesCheckpoint = true;
        await checkpoint(ctx, "draft-waves", st.clock, "wave 3, half the picks in");
      }
    }
    // Stalled teams: the commissioner picks their quota once the wave has been waiting.
    const stalledSlots = slots.filter((x) => x.stalled);
    if (stalledSlots.length) {
      advance(st, 45 * MINUTE, ctx);
      for (const m of stalledSlots) await doPick(ctx, st, m, st.pool[0], true);
    }
    const after = (await getDraftByLeague(db, ctx.leagueId))!;
    if (after.status === "waves") ok(ctx, after.currentWave === wave + 1, "wave advanced once everyone finished");
    advance(st, 20 * MINUTE, ctx);
  }

  // ---- verification of the finished draft
  d = (await getDraftByLeague(db, ctx.leagueId))!;
  same(ctx, d.status, "complete", "draft complete");
  const picks = await db.select().from(draftPicks).where(eq(draftPicks.draftId, st.draftId)).orderBy(asc(draftPicks.overallPick));
  same(ctx, picks.length, 512, "512 picks in total");
  same(ctx, new Set(picks.map((p) => p.playerId)).size, 512, "no player drafted twice");
  picks.forEach((p, i) => {
    same(ctx, p.overallPick, i + 1, "pick numbers 1..512");
    if (i < snakeTotal) {
      same(ctx, [p.teamId, p.phase, p.round], [d.order[snakeIdx(i + 1, 16)], "snake", Math.floor(i / 16) + 1], `snake pick ${i + 1}`);
    } else {
      same(ctx, p.phase, "wave", `pick ${i + 1} is a wave pick`);
    }
  });
  // Round 2 is round 1 reversed, round 3 forward again.
  same(ctx, picks.slice(16, 32).map((p) => p.teamId), picks.slice(0, 16).map((p) => p.teamId).reverse(), "round 2 reverses round 1");
  same(ctx, picks.slice(32, 48).map((p) => p.teamId), picks.slice(0, 16).map((p) => p.teamId), "round 3 repeats round 1");
  same(ctx, picks.map((p) => [p.overallPick, p.teamId, p.playerId]), st.log.map((p) => [p.overall, p.teamId, p.playerId]), "stored picks equal the picks the sim made");
  const rosterCounts = await db
    .select({ teamId: rosterEntries.teamId, n: sql<number>`count(*)::int` })
    .from(rosterEntries)
    .where(and(eq(rosterEntries.leagueId, ctx.leagueId), isNull(rosterEntries.releasedAt)))
    .groupBy(rosterEntries.teamId);
  same(ctx, rosterCounts.length, 16, "every team has players");
  ok(ctx, rosterCounts.every((r) => r.n === MAX_ROSTER), "every team is at 32");
  const [lg] = await db.select().from(leagues).where(eq(leagues.id, ctx.leagueId));
  same(ctx, lg.status, "in_season", "league status is in_season after the draft");
  ok(ctx, ctx.sent.filter((n) => n.type === "draft_events" && n.title === "Draft complete").length === 1, "draft complete notice sent once");
  // Every owner got an on-the-clock notice for each of his snake picks (12 plus the undo re-pick) and a notice per wave.
  const perOwner = new Map<string, number>();
  for (const n of ctx.sent) if (n.type === "draft_on_clock") perOwner.set(n.userIds[0], (perOwner.get(n.userIds[0]) ?? 0) + 1);
  ok(ctx, ctx.managers.every((m) => (perOwner.get(m.userId) ?? 0) >= SNAKE_ROUNDS), "every owner was notified for each snake pick");
  ok(ctx, ctx.sent.filter((n) => n.type === "draft_wave_open").length === 10, "ten wave-open notices");

  // The board loaders on the finished draft.
  const board = await getDraftBoard(db, ctx.leagueId, ctx.managers[0].userId);
  same(ctx, board.draft?.status, "complete", "board shows a complete draft");
  same(ctx, board.draft?.picks.length, 512, "board lists all picks");
  return { draftId: st.draftId, order: st.order, log: st.log, finishedAt: st.clock };
}
