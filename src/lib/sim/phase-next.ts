/** Rollover into the next season: new league from the finished one, keepers, a new schedule and a draft with keepers. */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { draftPicks, draftQueue, keepers, leagues, nbaPlayers, rosterEntries, seasonResults, teams } from "@/db/schema";
import { addToQueue, getDraftByLeague, makePick, startDraft } from "@/lib/draft/service";
import { listDraftablePlayers, getDraftBoard } from "@/lib/draft/board";
import { snakeTeam, waveTarget } from "@/lib/draft/engine";
import { addDays } from "@/lib/nba/dates";
import { addFreeAgent } from "@/lib/rosters/service";
import { generateSchedule, getLeagueView, getSchedule, listLeagueInvites, transferCommissioner, updateSettings } from "@/lib/leagues/service";
import { getBracket, overridePlayoffWinner } from "@/lib/playoffs/service";
import {
  getKeeperView,
  getLeagueHistory,
  getNextSeasonId,
  getOwnerPastSeasons,
  setKeepers,
  startNextSeason,
} from "@/lib/seasons/service";
import { at, checkpoint, eq as same, ok, rejectsWith, type Ctx, type Manager } from "./context";
import { NEXT_SEASON, buildSchedule, insertScheduledGames, nextSeasonGameDays } from "./nba-data";
import { LEAGUE_NAME } from "./phase-setup";

export async function runNextSeason(ctx: Ctx, champion: { teamId: string; runnerUpTeamId: string }) {
  const { db, rand, admin } = ctx;
  const actor = { id: admin.userId, isSiteAdmin: true };
  const outsider = ctx.managers[3];

  // ---- commissioner tools after the title: override the final's winner and put it back, hand the league over and back
  const bracket0 = await getBracket(db, ctx.leagueId, at("2027-04-13", "09:00"));
  const finalSlot = bracket0.rounds[2].slots[0];
  const [champId, runnerId] = [bracket0.champion!.teamId, bracket0.runnerUp!.teamId];
  await rejectsWith(ctx, overridePlayoffWinner(db, { id: outsider.userId }, finalSlot.id, runnerId, "nope", at("2027-04-13", "09:05")), "forbidden", "playoff override by a non-commissioner");
  await rejectsWith(ctx, overridePlayoffWinner(db, actor, finalSlot.id, ctx.managers[7].teamId, "wrong team", at("2027-04-13", "09:06")), "invalid_input", "override with a team outside the game");
  await overridePlayoffWinner(db, actor, finalSlot.id, runnerId, "Sim: checking the override tool, restored right after.", at("2027-04-13", "09:10"), { notify: ctx.notify });
  const flipped = await getBracket(db, ctx.leagueId, at("2027-04-13", "09:11"));
  same(ctx, [flipped.champion?.teamId, flipped.runnerUp?.teamId, flipped.rounds[2].slots[0].overridden], [runnerId, champId, true], "the override changed the champion");
  same(ctx, (await db.select().from(seasonResults).where(and(eq(seasonResults.leagueId, ctx.leagueId), eq(seasonResults.finalRank, 1))))[0].teamId, runnerId, "season results follow the override");
  await overridePlayoffWinner(db, actor, finalSlot.id, champId, "Sim: restored.", at("2027-04-13", "09:20"), { notify: ctx.notify });
  same(ctx, (await db.select().from(seasonResults).where(and(eq(seasonResults.leagueId, ctx.leagueId), eq(seasonResults.finalRank, 1))))[0].teamId, champId, "and back again");

  const ownerBefore = ctx.managers[1];
  await rejectsWith(ctx, transferCommissioner(db, { id: ownerBefore.userId, isSiteAdmin: false }, ctx.leagueId, ownerBefore.teamId, { now: at("2027-04-14", "09:00") }), "forbidden", "commissioner transfer by a non-commissioner");
  await rejectsWith(ctx, transferCommissioner(db, actor, ctx.leagueId, ctx.managers[0].teamId, { now: at("2027-04-14", "09:01") }), "already_commissioner", "transfer to the current commissioner");
  await transferCommissioner(db, actor, ctx.leagueId, ownerBefore.teamId, { now: at("2027-04-14", "09:02"), notify: ctx.notify });
  await rejectsWith(ctx, updateSettings(db, actor, ctx.leagueId, { addsPerDay: 3 }), "forbidden", "the former commissioner changing settings");
  await rejectsWith(ctx, listLeagueInvites(db, actor, ctx.leagueId), "forbidden", "the former commissioner reading invites");
  ok(ctx, (await getLeagueView(db, { id: ownerBefore.userId, isSiteAdmin: false }, ctx.leagueId)).isCommissioner, "the new commissioner has the tools");
  await transferCommissioner(db, { id: ownerBefore.userId, isSiteAdmin: false }, ctx.leagueId, ctx.managers[0].teamId, { now: at("2027-04-14", "09:03"), notify: ctx.notify });
  ok(ctx, (await getLeagueView(db, actor, ctx.leagueId)).isCommissioner, "and the original commissioner is back");

  // ---- roll the league over
  const when = at("2027-04-20", "10:00");
  await rejectsWith(ctx, startNextSeason(db, { id: outsider.userId }, ctx.leagueId, { notify: ctx.notify }), "forbidden", "next season started by a non-commissioner");
  const next = await startNextSeason(db, actor, ctx.leagueId, { notify: ctx.notify });
  ctx.nextLeagueId = next.id;
  same(ctx, [next.season, next.status, next.name, next.commissionerId, next.previousLeagueId], [NEXT_SEASON, "setup", LEAGUE_NAME, admin.userId, ctx.leagueId], "next league shape");
  await rejectsWith(ctx, startNextSeason(db, actor, ctx.leagueId, { notify: ctx.notify }), "already_started", "starting the next season twice");
  same(ctx, await getNextSeasonId(db, ctx.leagueId), next.id, "old league points at the new one");
  const [old] = await db.select().from(leagues).where(eq(leagues.id, ctx.leagueId));
  same(ctx, old.status, "complete", "the finished league stays complete");
  const nextTeams = await db.select().from(teams).where(eq(teams.leagueId, next.id));
  same(ctx, nextTeams.length, 16, "all 16 teams carried over");
  const newTeamOf = new Map<string, string>(); // old team id -> new team id
  for (const m of ctx.managers) {
    const t = nextTeams.find((x) => x.previousTeamId === m.teamId);
    ok(ctx, t, `${m.teamName} carried over`);
    same(ctx, [t.ownerId, t.name, t.abbrev], [m.userId, m.teamName, m.abbrev], `${m.teamName} keeps owner, name and abbreviation`);
    newTeamOf.set(m.teamId, t.id);
  }
  const nextSettings = (await getLeagueView(db, actor, next.id)).settings;
  same(ctx, [nextSettings.regularSeasonStart, nextSettings.regularSeasonEnd, nextSettings.tradeDeadline, nextSettings.playoffTeams, nextSettings.keepers], [null, null, null, 8, 2], "dates cleared, other settings kept");
  ok(ctx, ctx.sent.filter((n) => n.title === "New season").at(-1)!.userIds.length === 16, "all owners told about the new season");
  ok(ctx, (await db.select().from(rosterEntries).where(eq(rosterEntries.leagueId, next.id))).length === 0, "rosters do not carry over");
  await rejectsWith(ctx, addFreeAgent(db, { leagueId: next.id, teamId: newTeamOf.get(ctx.managers[1].teamId)!, playerId: ctx.world.players[0].id, actorUserId: ctx.managers[1].userId }, { now: when }), "wrong_status", "free agency before the new draft is complete");

  // ---- the 2027-28 NBA schedule arrives from the sync
  const days = nextSeasonGameDays();
  const games = buildSchedule(rand, ctx.world.teams, days, NEXT_SEASON, ctx.world.nextId.game, { gamesTotal: 1230 });
  ctx.world.nextId.game += games.length + 10;
  await insertScheduledGames(db, games);

  // ---- keepers
  await updateSettings(db, actor, next.id, { keeperDeadline: "2027-05-01" });
  const nextActor = (m: Manager) => ({ id: m.userId, isSiteAdmin: m.isSiteAdmin });
  const mgrs = ctx.managers;
  const candidatesOf = async (m: Manager) => (await getKeeperView(db, nextActor(m), next.id, at("2027-04-22", "09:00"))).teams.find((t) => t.teamId === newTeamOf.get(m.teamId))!.candidates;
  const view0 = await getKeeperView(db, nextActor(mgrs[2]), next.id, at("2027-04-22", "09:00"));
  const viewAll = await getKeeperView(db, actor, next.id, at("2027-04-22", "09:00"));
  same(ctx, viewAll.teams.length, 16, "the commissioner sees every team in the keeper view");
  same(ctx, [view0.enabled, view0.limit, view0.open, view0.deadline, view0.teams.length], [true, 2, true, "2027-05-01", 1], "keeper view for an owner");
  const chosen = new Map<string, number[]>();
  for (const [i, m] of mgrs.entries()) {
    if (i > 11) continue; // four teams keep nobody
    const cands = await candidatesOf(m);
    ok(ctx, cands.length > 0, `${m.teamName} has keeper candidates (last season's roster)`);
    const ids = cands.slice(0, i % 3 === 0 ? 1 : 2).map((c) => c.id);
    await setKeepers(db, nextActor(m), newTeamOf.get(m.teamId)!, ids, at("2027-04-23", "09:00"));
    chosen.set(m.teamId, ids);
  }
  // Limits and eligibility.
  const m5 = mgrs[5];
  const cands5 = await candidatesOf(m5);
  await rejectsWith(ctx, setKeepers(db, nextActor(m5), newTeamOf.get(m5.teamId)!, cands5.slice(0, 3).map((c) => c.id), at("2027-04-23", "10:00")), "too_many", "three keepers with a limit of two");
  const foreign = (await db.select().from(rosterEntries).where(and(eq(rosterEntries.teamId, mgrs[6].teamId), isNull(rosterEntries.releasedAt))))[0].playerId;
  await rejectsWith(ctx, setKeepers(db, nextActor(m5), newTeamOf.get(m5.teamId)!, [foreign], at("2027-04-23", "10:01")), "ineligible", "keeping another team's player");
  await rejectsWith(ctx, setKeepers(db, nextActor(mgrs[7]), newTeamOf.get(m5.teamId)!, [cands5[0].id], at("2027-04-23", "10:02")), "forbidden", "setting another owner's keepers");
  same(ctx, (await db.select().from(keepers).where(eq(keepers.teamId, newTeamOf.get(m5.teamId)!))).map((k) => k.playerId), chosen.get(m5.teamId), "failed attempts left the keepers alone");
  // After the deadline only the commissioner can change them.
  await rejectsWith(ctx, setKeepers(db, nextActor(mgrs[13]), newTeamOf.get(mgrs[13].teamId)!, [(await candidatesOf(mgrs[13]))[0].id], at("2027-05-02", "09:00")), "deadline_passed", "owner changing keepers after the deadline");
  const cands13 = await candidatesOf(mgrs[13]);
  await setKeepers(db, actor, newTeamOf.get(mgrs[13].teamId)!, [cands13[0].id], at("2027-05-02", "09:05"));
  chosen.set(mgrs[13].teamId, [cands13[0].id]);
  const kept = await db.select().from(keepers).where(eq(keepers.leagueId, next.id));
  same(ctx, kept.length, [...chosen.values()].flat().length, "keeper rows");

  // A keeper the NBA releases before the draft is dropped by startDraft.
  const staleTeam = mgrs[2];
  const staleId = chosen.get(staleTeam.teamId)![0];
  const stalePlayer = ctx.world.byId.get(staleId)!;
  stalePlayer.active = false;
  stalePlayer.nbaTeamId = null;
  await db.update(nbaPlayers).set({ active: false, teamId: null }).where(eq(nbaPlayers.id, staleId));
  chosen.set(staleTeam.teamId, chosen.get(staleTeam.teamId)!.filter((id) => id !== staleId));

  const history = await getLeagueHistory(db, next.id);
  same(ctx, history.map((h) => h.season), [NEXT_SEASON, 2027], "history lists both seasons");
  const past = await getOwnerPastSeasons(db, next.id, mgrs.find((m) => m.teamId === champion.teamId)!.userId);
  same(ctx, [past.length, past[0].season, past[0].finalRank, past[0].playoffResult], [1, 2027, 1, "champion"], "owner's past seasons show the title");

  // ---- schedule for the new season (dates come from the 2027-28 NBA schedule)
  await generateSchedule(db, actor, next.id, { seed: `next-${ctx.seed}` });
  await assertNextSchedule(ctx, next.id);

  await checkpoint(ctx, "next-season", at("2027-05-02", "12:00"), "2028 league in setup: 16 teams carried over, keepers set, schedule generated");

  // ---- the second draft, with keepers
  const draftAt = at("2027-10-10", "09:00");
  // A few queues for the new draft; a retired keeper can't be queued.
  const pool = ctx.world.players.filter((p) => p.active && p.nbaTeamId !== null && !kept.some((k) => k.playerId === p.id)).sort((a, b) => b.q - a.q);
  await addToQueue(db, newTeamOf.get(mgrs[1].teamId)!, pool[5].id, mgrs[1].userId);
  await rejectsWith(ctx, addToQueue(db, newTeamOf.get(mgrs[1].teamId)!, stalePlayer.id, mgrs[1].userId), "player_unavailable", "queueing the released player");
  const d = await startDraft(db, next.id, admin.userId, { now: draftAt, random: (n) => rand.int(n), notify: ctx.notify });
  const survivors = [...chosen.values()].flat();
  const entries = await db.select().from(rosterEntries).where(and(eq(rosterEntries.leagueId, next.id), isNull(rosterEntries.releasedAt)));
  same(ctx, entries.length, survivors.length, "keepers became roster entries (the released one was dropped)");
  ok(ctx, entries.every((e) => e.acquiredVia === "keeper" && e.acquiredAt.getTime() === draftAt.getTime()), "keeper entries are acquired via keeper at draft start");
  same(ctx, (await db.select().from(keepers).where(eq(keepers.leagueId, next.id))).length, survivors.length, "stale keeper row removed");
  const queued = await db.select().from(draftQueue).where(inArray(draftQueue.playerId, survivors));
  same(ctx, queued.length, 0, "keepers are not in any queue");
  same(ctx, [d.status, d.currentPick, d.maxRoster, d.snakeRounds], ["snake", 1, 32, 12], "second draft starts in the snake with keepers");
  const board = await getDraftBoard(db, next.id, mgrs[1].userId);
  same(ctx, Object.values(board.keeperCounts).reduce((a, b) => a + b, 0), survivors.length, "board shows the keeper counts");
  const list = await listDraftablePlayers(db, next.id, { limit: 200, now: draftAt });
  ok(ctx, list.players.every((p) => !survivors.includes(p.id)), "keepers are not draftable");
  const keeperPlayerId = survivors[0];
  const first = mgrs.find((m) => newTeamOf.get(m.teamId) === snakeTeam(d.order, 1))!;
  await rejectsWith(ctx, makePick(db, d.id, newTeamOf.get(first.teamId)!, keeperPlayerId, first.userId, { now: draftAt }), "player_taken", "drafting a keeper");

  await checkpoint(ctx, "next-season-draft", draftAt, "2028 draft started with keepers on the rosters, no picks yet");

  // Run the whole draft quickly: snake, then waves where keeper teams owe fewer picks.
  let clock = new Date(draftAt.getTime() + 60_000);
  const poolIds = pool.map((p) => p.id).filter((id) => id !== stalePlayer.id);
  const taken = new Set<number>(survivors);
  const nextId = (): number => {
    while (taken.has(poolIds[0])) poolIds.shift();
    return poolIds.shift()!;
  };
  const byNewTeam = new Map(mgrs.map((m) => [newTeamOf.get(m.teamId)!, m]));
  for (let pick = 1; pick <= 192; pick++) {
    const dr = (await getDraftByLeague(db, next.id))!;
    same(ctx, [dr.status, dr.currentPick], ["snake", pick], "keepers do not shift the snake");
    const tid = snakeTeam(dr.order, pick);
    const id = nextId();
    taken.add(id);
    await makePick(db, dr.id, tid, id, byNewTeam.get(tid)!.userId, { now: clock, notify: ctx.notify });
    clock = new Date(clock.getTime() + 30_000);
  }
  let dr = (await getDraftByLeague(db, next.id))!;
  same(ctx, [dr.status, dr.currentWave], ["waves", 1], "snake over, wave 1 open");
  // A team with two keepers has already reached wave 1's target (12 snake + 2 keepers): it owes nothing.
  const twoKeepers = [...chosen.entries()].find(([, ids]) => ids.length === 2)![0];
  await rejectsWith(ctx, makePick(db, dr.id, newTeamOf.get(twoKeepers)!, nextId(), mgrs.find((m) => m.teamId === twoKeepers)!.userId, { now: clock }), "no_wave_quota", "a team with two keepers picking in wave 1");
  taken.clear();
  survivors.forEach((id) => taken.add(id));
  (await db.select({ id: draftPicks.playerId }).from(draftPicks).where(eq(draftPicks.draftId, dr.id))).forEach((r) => taken.add(r.id));
  poolIds.length = 0;
  poolIds.push(...pool.map((p) => p.id).filter((id) => !taken.has(id) && id !== stalePlayer.id));
  for (let guard = 0; guard < 14; guard++) {
    dr = (await getDraftByLeague(db, next.id))!;
    if (dr.status !== "waves") break;
    const target = waveTarget({ snakeRounds: 12, totalRounds: 32, waveSize: 2 }, dr.currentWave!);
    for (const tid of rand.shuffle(dr.order)) {
      const have = (await db.select({ n: sql<number>`count(*)::int` }).from(rosterEntries).where(and(eq(rosterEntries.teamId, tid), isNull(rosterEntries.releasedAt))))[0].n;
      for (let k = have; k < target; k++) {
        const id = nextId();
        taken.add(id);
        await makePick(db, dr.id, tid, id, byNewTeam.get(tid)!.userId, { now: clock, notify: ctx.notify });
        clock = new Date(clock.getTime() + 20_000);
      }
    }
  }
  dr = (await getDraftByLeague(db, next.id))!;
  same(ctx, dr.status, "complete", "second draft complete");
  const counts = await db
    .select({ teamId: rosterEntries.teamId, n: sql<number>`count(*)::int` })
    .from(rosterEntries)
    .where(and(eq(rosterEntries.leagueId, next.id), isNull(rosterEntries.releasedAt)))
    .groupBy(rosterEntries.teamId);
  ok(ctx, counts.length === 16 && counts.every((c) => c.n === 32), "every team at 32 (keepers plus picks)");
  const picks = await db.select().from(draftPicks).where(eq(draftPicks.draftId, dr.id)).orderBy(asc(draftPicks.overallPick));
  same(ctx, picks.length, 512 - survivors.length, "keepers displaced wave picks one for one");
  same(ctx, new Set([...picks.map((p) => p.playerId), ...survivors]).size, 512, "512 distinct players on rosters");
  same(ctx, (await db.select().from(leagues).where(eq(leagues.id, next.id)))[0].status, "in_season", "second league is in season");
  return { nextLeagueId: next.id, keepers: survivors.length };
}

async function assertNextSchedule(ctx: Ctx, leagueId: string) {
  const { periods } = await getSchedule(ctx.db, leagueId);
  const regular = periods.filter((p) => !p.isPlayoff);
  ok(ctx, regular.length >= 20, "a full regular season of weekly periods");
  same(ctx, periods.filter((p) => p.isPlayoff).length, 3, "three playoff periods");
  same(ctx, [periods[0].startDate, periods[periods.length - 1].endDate], ["2027-10-19", "2028-04-09"], "season dates come from the 2027-28 NBA schedule");
  const merged = periods.filter((p) => Date.parse(p.endDate) - Date.parse(p.startDate) > 6 * 86_400_000);
  same(ctx, merged.map((p) => [p.startDate, p.endDate]), [["2028-02-14", "2028-02-27"]], "the 2028 All-Star break merged two weeks");
  periods.forEach((p, i) => {
    if (i > 0) same(ctx, p.startDate, addDays(periods[i - 1].endDate, 1), "periods are contiguous");
    if (!p.isPlayoff) same(ctx, p.matchups.length, 8, "eight matchups a week");
  });
}
