/**
 * The season loop: every ET day from the draft's end to the crowning of the champion, played like the
 * production crons would (morning moves, NBA sync, injuries, tip-offs, live box scores, finals, then the
 * nightly matchup + trade jobs at 04:00 ET the next day).
 */
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { leagues, matchups, seasonResults, nbaGames, notifications, teams } from "@/db/schema";
import { getBracket, reseedPlayoffs } from "@/lib/playoffs/service";
import { adjustMatchupScore, computeMatchupTotals } from "@/lib/matchups/service";
import { getLeagueHistory, getOwnerPastSeasons } from "@/lib/seasons/service";
import { addDays, etStartOfDay } from "@/lib/nba/dates";
import { removeCutPlayers } from "@/lib/rosters/service";
import { at, checkpoint, eq as same, ok, rawRows, rejectsWith, timed, type Ctx } from "./context";
import { HOUR, MINUTE, insertScheduledGames, postponeGame, seasonGameDays, type SimGame } from "./nba-data";
import { adjustmentFor, loadOracleData, oracleStandings, oracleTeamTotal } from "./oracle";
import {
  assertNoCutPlayersRostered,
  dailyInvariants,
  dailyMoves,
  finalBatch,
  lateMoves,
  loadPeriods,
  loadRosters,
  midBatch,
  nightly,
  periodOf,
  r2,
  tipBatch,
  updateInjuries,
  verifyLateMoves,
  verifyPeriod,
  verifyStandings,
  type ScriptEv,
  type Season,
} from "./season-engine";
import { registerScripts } from "./season-scripts";

const REGULAR_SEASON_CHECKPOINT = "2027-01-26";
const PLAYOFF_CHECKPOINT = "2027-03-31";
const POSTPONE_DATE = "2026-12-12";
const COMPLETE_DATE = "2027-04-12";

export type SeasonOutcome = { championTeamId: string; runnerUpTeamId: string; season: Season; completedAt: Date; bracketText: string[] };

export async function runSeason(ctx: Ctx): Promise<SeasonOutcome> {
  const s: Season = {
    ctx,
    periods: [],
    gamesByDate: new Map(),
    plans: new Map(),
    form: new Map(),
    injuries: new Map(),
    results: new Map(),
    playoffResults: new Map(),
    script: new Map(),
    noDrop: new Set(),
    skipMoves: new Map(),
    statusSeen: "in_season",
    teamsList: [],
    named: new Map(),
    finalizedPeriods: new Set(),
    tickN: 0,
    skipNightly: new Set(["2026-12-21", "2027-01-18", "2027-01-19", "2027-01-20", "2027-01-21", "2027-04-05"]),
    lateMoves: [],
  };
  await loadPeriods(s);
  for (const g of ctx.world.games) s.gamesByDate.set(g.date, [...(s.gamesByDate.get(g.date) ?? []), g]);
  s.skipMoves.set("2026-10-21", new Set([ctx.managers[8].teamId, ctx.managers[9].teamId]));
  s.skipMoves.set("2026-10-22", new Set([ctx.managers[8].teamId]));
  s.skipMoves.set("2026-10-31", new Set([ctx.managers[10].teamId]));
  s.skipMoves.set("2026-11-01", new Set([ctx.managers[10].teamId]));
  s.skipMoves.set("2027-02-11", new Set([ctx.managers[13].teamId]));
  registerScripts(s);
  scheduleExtras(s);

  const firstDate = "2026-10-19";
  const sampleDays = new Set<string>();
  const gameDays = seasonGameDays();
  gameDays.forEach((d, i) => {
    if (i % 6 === 2) sampleDays.add(d);
  });
  const lateSnapDays = new Set<string>();
  gameDays.forEach((d, i) => {
    if (i % 9 === 4) lateSnapDays.add(d);
  });
  const lateDays = new Set<string>();
  gameDays.forEach((d, i) => {
    if (i % 5 === 1) lateDays.add(d);
  });
  sampleDays.add(REGULAR_SEASON_CHECKPOINT);
  sampleDays.add(PLAYOFF_CHECKPOINT);

  let completedAt: Date | null = null;
  for (let date = firstDate; date <= addDays(COMPLETE_DATE, 8); date = addDays(date, 1)) {
    const pre = date < "2026-10-20";
    const events: ScriptEv[] = [];
    if (date === POSTPONE_DATE) await postponeOneGame(s, date);

    if (!pre) {
      events.push({ at: at(date, "04:00"), label: "nightly", run: () => nightlyStep(s, date) });
      events.push({ at: at(date, "09:00"), label: "moves", run: () => dailyMoves(s, date) });
      events.push({
        at: at(date, "10:35"),
        label: "nba sync",
        run: async () => {
          await removeCutPlayers(ctx.db, { allRostersLoaded: true, now: ctx.now }, { notify: ctx.notify });
          await assertNoCutPlayersRostered(s, date);
        },
      });
      events.push({ at: at(date, "11:00"), label: "injuries", run: () => updateInjuries(s, date) });

      const games = s.gamesByDate.get(date) ?? [];
      const batches = new Map<number, SimGame[]>();
      for (const g of games) batches.set(g.startTime.getTime(), [...(batches.get(g.startTime.getTime()) ?? []), g]);
      const starts = [...batches.keys()].sort((a, b) => a - b);
      starts.forEach((start, idx) => {
        const batch = batches.get(start)!;
        const tip = new Date(start);
        const delay = idx === 1 && lateSnapDays.has(date) ? 25 : 2;
        events.push({ at: new Date(start + delay * MINUTE), label: `tip ${batch.length}`, run: () => tipBatch(s, batch, tip, delay) });
        events.push({ at: new Date(start + 90 * MINUTE), label: "mid", run: () => midBatch(s, batch) });
        events.push({ at: new Date(start + 150 * MINUTE), label: "final", run: () => finalBatch(s, batch, new Date(start + 150 * MINUTE)) });
        if (idx === 0 && lateDays.has(date)) {
          events.push({ at: at(date, "20:15"), label: "moves during games", run: () => lateMoves(s, date, ctx.now) });
        }
        if (idx === starts.length - 1 && sampleDays.has(date)) {
          events.push({ at: new Date(start + 120 * MINUTE), label: "live check", run: () => liveCheck(s, date) });
        }
      });
    }

    events.push(...(s.script.get(date) ?? []));
    if (date === REGULAR_SEASON_CHECKPOINT) {
      events.push({ at: at(date, "20:45"), label: "checkpoint regular-season", run: () => checkpoint(ctx, "regular-season", ctx.now, "games in progress, a trade under review, an open offer, unread chat") });
    }
    if (date === PLAYOFF_CHECKPOINT) {
      events.push({ at: at(date, "20:45"), label: "checkpoint playoffs", run: () => checkpoint(ctx, "playoffs", ctx.now, "playoff round 2, games in progress") });
    }
    if (date === COMPLETE_DATE) {
      events.push({
        at: at(date, "05:30"),
        label: "checkpoint complete",
        run: async () => {
          const [lg] = await ctx.db.select().from(leagues).where(eq(leagues.id, ctx.leagueId));
          same(ctx, lg.status, "complete", "the league is complete once the final week is finalized");
          await checkpoint(ctx, "complete", ctx.now, "champion crowned");
        },
      });
    }
    events.sort((a, b) => a.at.getTime() - b.at.getTime());
    for (const ev of events) {
      ctx.now = ev.at;
      s.tickN = 0;
      await ev.run();
    }
    await verifyLateMoves(s, date);
    await dailyInvariants(s, date);

    if (s.statusSeen === "complete") {
      completedAt = ctx.now;
      if (date >= COMPLETE_DATE) break;
    }
  }
  ok(ctx, completedAt, "the league completed");
  const outcome = await finalVerification(s);
  return { ...outcome, season: s, completedAt: completedAt! };
}

/** Misc scripted events that need the Season (injury star-outs, deadline probes, playoff re-seed probes). */
function scheduleExtras(s: Season) {
  const { ctx } = s;
  const { db, admin, world } = ctx;
  const addScript = (date: string, hhmm: string, label: string, run: () => Promise<void>) => {
    const list = s.script.get(date) ?? [];
    list.push({ at: at(date, hhmm), label, run });
    s.script.set(date, list);
  };

  // Week one: three rostered stars are Out and one is Day-To-Day, so the no-bonus rule is exercised early.
  addScript("2026-10-22", "11:05", "stars out", async () => {
    const rows = await rawRows(db, sql`select player_id from roster_entries where league_id = ${ctx.leagueId} and released_at is null`);
    const rostered = new Set(rows.map((r) => r.player_id as number));
    const stars = world.players.filter((p) => rostered.has(p.id) && p.active && p.health.status === null).sort((a, b) => b.q - a.q).slice(0, 4);
    const { setHealth } = await import("./nba-data");
    await setHealth(db, stars[0], { status: "Out", detail: "Knee soreness", untilDate: "2026-10-27" });
    await setHealth(db, stars[1], { status: "Out", detail: "Ankle sprain", untilDate: "2026-10-26" });
    await setHealth(db, stars[2], { status: "Out", detail: "Illness", untilDate: "2026-10-24" });
    await setHealth(db, stars[3], { status: "Day-To-Day", detail: "Back spasms", untilDate: "2026-10-23" });
    for (const [p, until] of [[stars[0], "2026-10-27"], [stars[1], "2026-10-26"], [stars[2], "2026-10-24"], [stars[3], "2026-10-23"]] as const) s.injuries.set(p.id, until);
  });

  // Playoff re-seed probes: allowed right after seeding, refused once round 1 has tipped off.
  addScript("2027-03-22", "05:00", "playoff seeding checks", async () => {
    await verifySeeding(s);
    const before = JSON.stringify((await getBracket(db, ctx.leagueId, ctx.now)).rounds[0].slots.map((x) => [x.teamA?.teamId, x.teamB?.teamId]));
    await reseedPlayoffs(db, { id: admin.userId, isSiteAdmin: true }, ctx.leagueId, ctx.now);
    const after = JSON.stringify((await getBracket(db, ctx.leagueId, ctx.now)).rounds[0].slots.map((x) => [x.teamA?.teamId, x.teamB?.teamId]));
    same(ctx, after, before, "re-seeding right after seeding changes nothing");
    await verifySeeding(s);
  });
  // Exact ties: a commissioner adjustment evens the score after the week's last game, before the night job finalizes it.
  // Regular season: a tie in the standings (half a win each). Playoffs: the better seed advances.
  addScript(addDays(s.periods.find((x) => x.number === 12)!.endDate, 1), "02:00", "force a regular-season tie", () => forceTie(s, 12, "regular"));
  addScript(addDays(s.periods.find((x) => x.number === 22)!.endDate, 1), "02:00", "force a playoff tie", () => forceTie(s, 22, "playoff"));
  addScript(addDays(s.periods.find((x) => x.number === 12)!.endDate, 1), "05:30", "regular-season tie finalized", () => checkTie(s, 12, "regular"));
  addScript(addDays(s.periods.find((x) => x.number === 22)!.endDate, 1), "05:30", "playoff tie finalized", () => checkTie(s, 22, "playoff"));
  addScript("2027-03-24", "10:00", "reseed refused after round 1 started", async () => {
    await rejectsWith(ctx, reseedPlayoffs(db, { id: admin.userId, isSiteAdmin: true }, ctx.leagueId, ctx.now), "round_started", "re-seeding after round 1 tipped off");
  });
}

// ---------------------------------------------------------------------------------------- steps

async function forceTie(s: Season, number: number, mode: "regular" | "playoff") {
  const { ctx } = s;
  const period = s.periods.find((x) => x.number === number)!;
  const rows = (await ctx.db.select().from(matchups).where(eq(matchups.periodId, period.id))).filter((m) => m.homeTeamId && m.awayTeamId);
  ok(ctx, rows.length > 0 && rows.every((m) => m.status !== "final"), "the week is over but not finalized yet");
  const data = await loadOracleData(ctx.db, ctx.leagueId, period.startDate, period.endDate);
  const scored = rows.map((m) => {
    const home = oracleTeamTotal(data, m.homeTeamId!).points + adjustmentFor(data, m.id, m.homeTeamId!);
    const away = oracleTeamTotal(data, m.awayTeamId!).points + adjustmentFor(data, m.id, m.awayTeamId!);
    return { m, home, away, margin: Math.abs(home - away) };
  });
  // Playoffs: prefer a game the LOWER seed (away) is winning, so the tie visibly sends the better seed through.
  const pool = mode === "playoff" && scored.some((x) => x.away > x.home) ? scored.filter((x) => x.away > x.home) : scored;
  const pick = pool.filter((x) => x.margin > 0).sort((a, b) => a.margin - b.margin)[0];
  const trailing = pick.home < pick.away ? pick.m.homeTeamId! : pick.m.awayTeamId!;
  await adjustMatchupScore(ctx.db, { id: ctx.admin.userId }, pick.m.id, trailing, pick.margin, "Scoring correction: evening up the matchup.", { now: ctx.now, notify: ctx.notify });
  const totals = await computeMatchupTotals(ctx.db, pick.m.id, ctx.now);
  same(ctx, totals.home.points, totals.away!.points, "the adjustment produced an exact tie");
  s.named.set(`tie:${number}`, pick.m.id);
  s.named.set(`tie:${number}:awayWasLeading`, String(pick.away > pick.home));
  ctx.counters.forcedTies++;
}

async function checkTie(s: Season, number: number, mode: "regular" | "playoff") {
  const { ctx } = s;
  const [m] = await ctx.db.select().from(matchups).where(eq(matchups.id, s.named.get(`tie:${number}`)!));
  same(ctx, [m.status, m.winnerTeamId, m.homePoints === m.awayPoints], ["final", null, true], "a tied matchup is final with no winner");
  if (mode === "regular") {
    const oracle = await verifyStandings(s, "with a tie in the standings");
    ok(ctx, oracle.filter((r) => r.t > 0).length >= 2, "both teams of the tie carry a T in the standings");
    const owners = [m.homeTeamId, m.awayTeamId].map((t) => ctx.managers.find((x) => x.teamId === t)!.userId);
    ok(ctx, ctx.sent.filter((n) => n.type === "matchup_results" && n.body.startsWith("You tied") && owners.includes(n.userIds[0])).length === 2, "both owners were told they tied");
  } else {
    const bracket = await getBracket(ctx.db, ctx.leagueId, ctx.now);
    const slot = bracket.rounds[0].slots.find((x) => [x.teamA?.teamId, x.teamB?.teamId].includes(m.homeTeamId!) && [x.teamA?.teamId, x.teamB?.teamId].includes(m.awayTeamId!))!;
    same(ctx, slot.winnerTeamId, m.homeTeamId, "a tied playoff game goes to the higher seed (the home team)");
  }
}

async function postponeOneGame(s: Season, date: string) {
  const { ctx } = s;
  const games = s.gamesByDate.get(date) ?? [];
  const g = games[games.length - 1];
  await postponeGame(ctx.db, g.id);
  s.gamesByDate.set(date, games.filter((x) => x.id !== g.id));
  const days = seasonGameDays();
  let d = addDays(date, 3);
  while (days.includes(d) && (s.gamesByDate.get(d) ?? []).some((x) => x.home === g.home || x.away === g.home || x.home === g.away || x.away === g.away)) d = addDays(d, 1);
  ok(ctx, days.includes(d), "makeup date inside the season");
  const makeup: SimGame = { id: ctx.world.nextId.game++, season: g.season, seasonType: 2, startTime: new Date(etStartOfDay(d).getTime() + 19 * HOUR), date: d, home: g.home, away: g.away };
  await insertScheduledGames(ctx.db, [makeup]);
  s.gamesByDate.set(d, [...(s.gamesByDate.get(d) ?? []), makeup]);
  ctx.world.games.push(makeup);
  ctx.findings.push(`Game ${g.id} on ${date} was postponed and replayed on ${d} as game ${makeup.id}.`);
}

async function liveCheck(s: Season, date: string) {
  const { ctx } = s;
  const period = periodOf(s, date);
  if (!period) return;
  const rows = (await ctx.db.select().from(matchups).where(eq(matchups.periodId, period.id))).filter((m) => m.homeTeamId && m.awayTeamId && m.status !== "final");
  if (rows.length === 0) return;
  const data = await loadOracleData(ctx.db, ctx.leagueId, period.startDate, period.endDate);
  const live = await ctx.db.select().from(nbaGames).where(and(inArray(nbaGames.status, ["in"])));
  const upcoming = await ctx.db
    .select({ home: nbaGames.homeTeamId, away: nbaGames.awayTeamId })
    .from(nbaGames)
    .where(and(eq(nbaGames.status, "scheduled"), gte(nbaGames.startTime, etStartOfDay(period.startDate)), lt(nbaGames.startTime, etStartOfDay(addDays(period.endDate, 1)))));
  const { byTeam } = await loadRosters(s);
  // Games left = scheduled NBA games of the period for the players on the roster right now.
  const gamesLeft = (teamId: string) =>
    (byTeam.get(teamId) ?? []).reduce((n, id) => {
      const nba = ctx.world.byId.get(id)?.nbaTeamId;
      return n + (nba === null || nba === undefined ? 0 : upcoming.filter((g) => g.home === nba || g.away === nba).length);
    }, 0);
  for (const m of rows) {
    const totals = await timed(ctx, "matchup.liveTotals", () => computeMatchupTotals(ctx.db, m.id, ctx.now));
    const home = r2(oracleTeamTotal(data, m.homeTeamId!).points + adjustmentFor(data, m.id, m.homeTeamId!));
    const away = r2(oracleTeamTotal(data, m.awayTeamId!).points + adjustmentFor(data, m.id, m.awayTeamId!));
    same(ctx, [totals.home.points, totals.away?.points], [home, away], `${date}: live totals equal the oracle mid-game (${live.length} games in progress)`);
    same(ctx, [totals.home.gamesPlayed, totals.away?.gamesPlayed], [oracleTeamTotal(data, m.homeTeamId!).rows, oracleTeamTotal(data, m.awayTeamId!).rows], `${date}: games played (player-games that scored)`);
    same(ctx, [totals.home.gamesRemaining, totals.away?.gamesRemaining], [gamesLeft(m.homeTeamId!), gamesLeft(m.awayTeamId!)], `${date}: games remaining for the current rosters`);
    for (const t of [totals.home, totals.away!]) {
      ok(ctx, t.projected >= t.points - 0.011, `${date}: projection never below the points already scored`);
      if (t.gamesRemaining === 0) same(ctx, t.projected, t.points, `${date}: nothing left to project`);
    }
    ctx.counters.liveChecks++;
  }
}

async function nightlyStep(s: Season, date: string) {
  const { ctx } = s;
  if (s.skipNightly.has(date)) {
    ctx.findings.push(`The 04:00 cron did not run on ${date}; the next night caught up.`);
    return;
  }
  const pending = s.periods.filter((p) => p.endDate < date && !s.finalizedPeriods.has(p.number));
  const resultsBefore = ctx.sent.filter((n) => n.type === "matchup_results").length;
  const { res, due } = await nightly(s, ctx.now);
  // The cron may fire twice (retries, overlapping runs): a second run changes nothing and notifies nobody again.
  if (pending.length > 0 || due.expired + due.executed + due.vetoed + due.invalidated > 0) {
    const sentBefore = ctx.sent.length;
    const again = await nightly(s, ctx.now);
    same(ctx, [again.res.finalized, again.res.playoffsSeeded, again.res.playoffMatchups, again.res.playoffGamesDecided, again.res.leaguesCompleted], [0, 0, 0, 0, 0], "a repeated night job does nothing new");
    same(ctx, [again.due.expired, again.due.executed, again.due.vetoed, again.due.invalidated], [0, 0, 0, 0], "a repeated trade job does nothing new");
    const fresh = ctx.sent.slice(sentBefore).filter((n) => n.type === "matchup_results" || n.type === "league_events" || n.type === "trade_updates");
    same(ctx, fresh.length, 0, "a repeated night job sends no second notification");
  }
  let expectedNotices = 0;
  let finalizedNow = 0;
  for (const ended of pending) {
    const rows = await ctx.db.select().from(matchups).where(eq(matchups.periodId, ended.id));
    if (rows.length === 0) continue; // a playoff week whose matchups don't exist yet
    ok(ctx, rows.every((r) => r.status === "final"), `period ${ended.number} is final after the night that followed it`);
    expectedNotices += rows.filter((r) => r.awayTeamId).length * 2;
    await verifyPeriod(s, ended, { requireFinal: true });
    s.finalizedPeriods.add(ended.number);
    finalizedNow++;
    if (ended.number === 21) same(ctx, res.playoffsSeeded, 1, "the playoffs were seeded by the night job after the last regular week");
  }
  if (finalizedNow === 0) return;
  ok(ctx, res.finalized >= 1, "nightly job finalized the ended period(s)");
  same(ctx, ctx.sent.filter((n) => n.type === "matchup_results").length - resultsBefore, expectedNotices, "one result notification per team per matchup, once");
  const lastEnded = pending.filter((p) => s.finalizedPeriods.has(p.number)).at(-1)!;
  if (!lastEnded.isPlayoff) await verifyStandings(s, `after period ${lastEnded.number}`);
  else await verifyBracket(s);
}

// ----------------------------------------------------------------------------------- the bracket

type Expected = { teamA: string; teamB: string; seedA: number; seedB: number; winner: string | null; scoreA: number | null; scoreB: number | null };

/** The bracket recomputed from the oracle's standings and verified playoff results. */
function expectedBracket(s: Season): Expected[][] {
  const all = [...s.results.values()].flat();
  const standings = oracleStandings(s.teamsList, all);
  const top = standings.slice(0, 8);
  const seed = new Map(top.map((r) => [r.teamId, r.rank]));
  const rounds: Expected[][] = [];
  let entrants: { id: string }[][] = [[1, 8], [4, 5], [2, 7], [3, 6]].map(([a, b]) => [{ id: top[a - 1].teamId }, { id: top[b - 1].teamId }]);
  for (let r = 1; r <= 3; r++) {
    const periodGames = s.playoffResults.get(21 + r) ?? [];
    const row: Expected[] = [];
    const next: { id: string }[] = [];
    for (const [a, b] of entrants) {
      const g = periodGames.find((x) => (x.home === a.id && x.away === b.id) || (x.home === b.id && x.away === a.id));
      let scoreA: number | null = null;
      let scoreB: number | null = null;
      let winner: string | null = null;
      if (g) {
        scoreA = g.home === a.id ? g.hp : g.ap;
        scoreB = g.home === a.id ? g.ap : g.hp;
        if (Math.round(scoreA * 100) !== Math.round(scoreB * 100)) winner = scoreA > scoreB ? a.id : b.id;
        else winner = seed.get(a.id)! <= seed.get(b.id)! ? a.id : b.id;
      }
      row.push({ teamA: a.id, teamB: b.id, seedA: seed.get(a.id)!, seedB: seed.get(b.id)!, winner, scoreA, scoreB });
      next.push({ id: winner ?? "" });
    }
    rounds.push(row);
    if (next.some((n) => n.id === "")) break;
    entrants = [];
    for (let i = 0; i < next.length; i += 2) entrants.push([next[i], next[i + 1]]);
  }
  return rounds;
}

async function verifySeeding(s: Season) {
  const { ctx } = s;
  const [lg] = await ctx.db.select().from(leagues).where(eq(leagues.id, ctx.leagueId));
  same(ctx, lg.status, "playoffs", "league is in the playoffs after seeding");
  const oracle = oracleStandings(s.teamsList, [...s.results.values()].flat());
  const bracket = await getBracket(ctx.db, ctx.leagueId, ctx.now);
  ok(ctx, bracket.seeded, "bracket seeded");
  same(ctx, bracket.rounds.length, 3, "three playoff rounds");
  const r1 = bracket.rounds[0].slots.map((x) => [x.teamA?.teamId, x.teamA?.seed, x.teamB?.teamId, x.teamB?.seed]);
  const want = [[1, 8], [4, 5], [2, 7], [3, 6]].map(([a, b]) => [oracle[a - 1].teamId, a, oracle[b - 1].teamId, b]);
  same(ctx, r1, want, "round 1 pairs the top 8 by the oracle's standings (1v8, 4v5, 2v7, 3v6)");
  const top8 = new Set(oracle.slice(0, 8).map((r) => r.teamId));
  const p22 = s.periods.find((p) => p.number === 22)!;
  const ms = await ctx.db.select().from(matchups).where(eq(matchups.periodId, p22.id));
  same(ctx, ms.length, 4, "four round-1 matchups");
  for (const m of ms) {
    ok(ctx, top8.has(m.homeTeamId!) && top8.has(m.awayTeamId!), "only playoff teams play");
    const hs = oracle.find((r) => r.teamId === m.homeTeamId)!.rank;
    const as = oracle.find((r) => r.teamId === m.awayTeamId)!.rank;
    ok(ctx, hs < as, "the better seed is the home team");
  }
  for (const r of oracle.slice(0, 8)) {
    const owner = ctx.managers.find((m) => m.teamId === r.teamId)!;
    ok(ctx, ctx.sent.some((n) => n.title === "You made the playoffs" && n.userIds[0] === owner.userId), `${r.name} told he made the playoffs`);
  }
  ok(ctx, ctx.sent.filter((n) => n.title === "You made the playoffs").length === 8, "exactly eight playoff notices");
}

async function verifyBracket(s: Season) {
  const { ctx } = s;
  const expected = expectedBracket(s);
  const bracket = await getBracket(ctx.db, ctx.leagueId, ctx.now);
  expected.forEach((round, ri) => {
    round.forEach((e, si) => {
      const got = bracket.rounds[ri].slots[si];
      same(ctx, [got.teamA?.teamId, got.teamB?.teamId], [e.teamA, e.teamB], `bracket round ${ri + 1} slot ${si + 1} teams`);
      if (e.winner) {
        same(ctx, got.winnerTeamId, e.winner, `bracket round ${ri + 1} slot ${si + 1} winner`);
        same(ctx, [got.scoreA, got.scoreB], [e.scoreA, e.scoreB], `bracket round ${ri + 1} slot ${si + 1} score`);
      }
    });
  });
}

// ------------------------------------------------------------------------------ final checks

async function finalVerification(s: Season): Promise<Omit<SeasonOutcome, "season" | "completedAt">> {
  const { ctx } = s;
  const { db } = ctx;
  // Every period once more from raw rows (catches anything that drifted after its own verification).
  for (const p of s.periods) {
    const rows = await db.select().from(matchups).where(eq(matchups.periodId, p.id));
    if (rows.length === 0) continue;
    await verifyPeriod(s, p, { requireFinal: true });
  }
  const standings = await verifyStandings(s, "final");
  await verifyBracket(s);

  const [lg] = await db.select().from(leagues).where(eq(leagues.id, ctx.leagueId));
  same(ctx, lg.status, "complete", "league complete");
  const bracket = await getBracket(db, ctx.leagueId, ctx.now);
  ok(ctx, bracket.champion && bracket.runnerUp, "bracket names a champion and a runner-up");
  const expected = expectedBracket(s);
  same(ctx, expected.length, 3, "all three rounds were played");
  const fin = expected[2][0];
  same(ctx, bracket.champion!.teamId, fin.winner, "champion = winner of the final");
  same(ctx, bracket.runnerUp!.teamId, fin.winner === fin.teamA ? fin.teamB : fin.teamA, "runner-up = the other finalist");

  // season_results: ranks 1..16 unique, champion/runner-up first, then semifinal and quarterfinal exits by regular-season rank.
  const rows = await db.select().from(seasonResults).where(eq(seasonResults.leagueId, ctx.leagueId)).orderBy(asc(seasonResults.finalRank));
  same(ctx, rows.map((r) => r.finalRank), Array.from({ length: 16 }, (_, i) => i + 1), "final ranks 1..16");
  same(ctx, new Set(rows.map((r) => r.teamId)).size, 16, "one result per team");
  const rank = new Map(standings.map((r) => [r.teamId, r.rank]));
  const semis = expected[1].flatMap((e) => (e.winner === e.teamA ? [e.teamB] : [e.teamA])).sort((a, b) => rank.get(a)! - rank.get(b)!);
  const quarters = expected[0].flatMap((e) => (e.winner === e.teamA ? [e.teamB] : [e.teamA])).sort((a, b) => rank.get(a)! - rank.get(b)!);
  const missed = standings.slice(8).map((r) => r.teamId);
  const loser = fin.winner === fin.teamA ? fin.teamB : fin.teamA;
  same(ctx, rows.map((r) => r.teamId), [fin.winner, loser, ...semis, ...quarters, ...missed], "season results ordered champion, runner-up, semifinalists, quarterfinalists, the rest");
  same(ctx, rows.slice(0, 2).map((r) => r.playoffResult), ["champion", "runner_up"], "champion and runner-up flagged");
  same(ctx, rows.slice(2, 4).map((r) => r.playoffResult), ["semifinal", "semifinal"], "semifinal exits");
  same(ctx, rows.slice(4, 8).map((r) => r.playoffResult), ["quarterfinal", "quarterfinal", "quarterfinal", "quarterfinal"], "quarterfinal exits");
  same(ctx, rows.slice(8).map((r) => r.playoffResult), Array(8).fill("missed"), "missed the playoffs");
  for (const r of rows) {
    const o = standings.find((x) => x.teamId === r.teamId)!;
    same(ctx, [r.wins, r.losses, r.ties, r2(r.pointsFor), r2(r.pointsAgainst)], [o.w, o.l, o.t, r2(o.pf), r2(o.pa)], `season result record of ${o.name}`);
  }
  // Champion notifications reached all 16 owners.
  const champNotices = ctx.sent.filter((n) => n.type === "league_events" && n.title.endsWith("champions"));
  same(ctx, champNotices.length, 1, "one champions notice");
  same(ctx, champNotices[0].userIds.length, 16, "champions notice goes to all 16 owners");
  const stored = await db.select().from(notifications).where(and(eq(notifications.leagueId, ctx.leagueId), eq(notifications.type, "league_events")));
  ok(ctx, stored.filter((n) => n.title.endsWith("champions")).length === 16, "16 champion notifications stored");

  // History readers.
  const history = await getLeagueHistory(db, ctx.leagueId);
  same(ctx, history[0].champion?.teamName, ctx.managers.find((m) => m.teamId === fin.winner)!.teamName, "history shows the champion");
  const champOwner = ctx.managers.find((m) => m.teamId === fin.winner)!;
  const pastSeasons = await getOwnerPastSeasons(db, ctx.leagueId, champOwner.userId);
  same(ctx, pastSeasons, [], "no earlier seasons for the first season of the league");

  // Cross-checks on the scenario: win-bonus exclusions really happened.
  const outSnaps = await rawRows(db, sql`select count(*)::int as n from game_roster_snapshots where injury_status = 'Out'`);
  const dtdSnaps = await rawRows(db, sql`select count(*)::int as n from game_roster_snapshots where injury_status = 'Day-To-Day'`);
  ok(ctx, (outSnaps[0].n as number) > 0 && (dtdSnaps[0].n as number) > 0, "snapshots recorded Out and Day-To-Day players");
  const teamRows = await db.select().from(teams).where(eq(teams.leagueId, ctx.leagueId));
  same(ctx, teamRows.length, 16, "16 teams at the end");
  const bracketText = bracket.rounds.map((r) => `${r.label}: ${r.slots.map((x) => `${x.teamA?.name} (${x.scoreA ?? "-"}) v ${x.teamB?.name} (${x.scoreB ?? "-"})`).join(" | ")}`);
  return { championTeamId: fin.winner!, runnerUpTeamId: loser, bracketText };
}

