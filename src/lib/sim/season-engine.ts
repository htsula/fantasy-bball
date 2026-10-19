/**
 * The day-by-day machinery of the season simulation: NBA games (tip-off snapshots, live box scores, finals),
 * injuries, free-agent behaviour, the nightly job, and the independent verification of every finalized period.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  gameRosterSnapshots,
  leagues,
  matchups,
  matchupTeamTotals,
  nbaGames,
  playerGameStats,
  rosterEntries,
  tradeItems,
  trades,
} from "@/db/schema";
import { getStandings, runNightlyMatchupJob } from "@/lib/matchups/service";
import { captureTipoffSnapshots } from "@/lib/nba/snapshots";
import { addFreeAgent, dropPlayer, getAddsToday } from "@/lib/rosters/service";
import { getSchedule } from "@/lib/leagues/service";
import { processDueTrades } from "@/lib/trades/service";
import { eq as same, ok, rawRows, timed, at, type Ctx, type Manager } from "./context";
import {
  finalScore,
  healthy,
  lineFp,
  MINUTE,
  planTeamGame,
  setHealth,
  statRow,
  chunked,
  type PlayerGame,
  type SimGame,
  type SimPlayer,
} from "./nba-data";
import { teamGamePoints } from "@/lib/fantasy/team-points";
import { adjustmentFor, loadOracleData, oracleStandings, oracleTeamTotal, type OracleGame } from "./oracle";

export type Period = { id: string; number: number; startDate: string; endDate: string; isPlayoff: boolean; round: number | null };
export type Plan = { home: PlayerGame[]; away: PlayerGame[]; score: { home: number; away: number } };
export type ScriptEv = { at: Date; label: string; run: () => Promise<void> };

export type Season = {
  ctx: Ctx;
  periods: Period[];
  gamesByDate: Map<string, SimGame[]>;
  plans: Map<number, Plan>;
  form: Map<number, { gp: number; fp: number }>;
  /** Injured player -> last ET date of the injury. */
  injuries: Map<number, string>;
  /** Oracle results of every verified regular-season period. */
  results: Map<number, OracleGame[]>;
  /** Oracle results of every verified playoff period. */
  playoffResults: Map<number, OracleGame[]>;
  /** Teams the random free-agent churn leaves alone on a date (they run a scripted test). */
  skipMoves: Map<string, Set<string>>;
  script: Map<string, ScriptEv[]>;
  /** Players the random free-agent churn must never drop. */
  noDrop: Set<number>;
  statusSeen: string;
  teamsList: { id: string; name: string }[];
  named: Map<string, string>;
  finalizedPeriods: Set<number>;
  /** Per-event counter so successive service calls inside one scripted event get increasing timestamps. */
  tickN: number;
  /** Nights the cron "did not run" (the next run catches up). */
  skipNightly: Set<string>;
  /** Roster moves made while games were in progress, verified at the end of the day. */
  lateMoves: LateMove[];
};

export type LateMove = { teamId: string; add: number; drop: number; at: Date; date: string; addGame: number | null; dropGame: number | null };

/** The simulated clock of the running event plus one more minute per call. */
export const tick = (s: Season) => new Date(s.ctx.now.getTime() + s.tickN++ * MINUTE);

export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export const periodOf = (s: Season, date: string) => s.periods.find((p) => p.startDate <= date && date <= p.endDate) ?? null;

export const formAvg = (s: Season, p: SimPlayer) => {
  const f = s.form.get(p.id);
  return ((f?.fp ?? 0) + (p.prevQ ?? 12) * 4) / ((f?.gp ?? 0) + 4);
};

export function addScript(s: Season, date: string, hhmm: string, label: string, run: () => Promise<void>) {
  const list = s.script.get(date) ?? [];
  list.push({ at: at(date, hhmm), label, run });
  s.script.set(date, list);
}

export async function loadPeriods(s: Season) {
  const { periods } = await getSchedule(s.ctx.db, s.ctx.leagueId);
  s.periods = periods.map((p) => ({ id: p.id, number: p.number, startDate: p.startDate, endDate: p.endDate, isPlayoff: p.isPlayoff, round: p.playoffRound }));
  s.teamsList = s.ctx.managers.map((m) => ({ id: m.teamId, name: m.teamName }));
}

// ------------------------------------------------------------------------------------ rosters

export async function loadRosters(s: Season) {
  const rows = await s.ctx.db
    .select({ teamId: rosterEntries.teamId, playerId: rosterEntries.playerId })
    .from(rosterEntries)
    .where(and(eq(rosterEntries.leagueId, s.ctx.leagueId), isNull(rosterEntries.releasedAt)));
  const byTeam = new Map<string, number[]>();
  const rostered = new Set<number>();
  for (const r of rows) {
    byTeam.set(r.teamId, [...(byTeam.get(r.teamId) ?? []), r.playerId]);
    rostered.add(r.playerId);
  }
  return { byTeam, rostered };
}

export async function openTradePlayers(s: Season): Promise<Set<number>> {
  const rows = await s.ctx.db
    .select({ playerId: tradeItems.playerId })
    .from(tradeItems)
    .innerJoin(trades, eq(trades.id, tradeItems.tradeId))
    .where(and(eq(trades.leagueId, s.ctx.leagueId), inArray(trades.status, ["proposed", "pending_review"])));
  return new Set(rows.map((r) => r.playerId));
}

export const freeAgents = (s: Season, rostered: Set<number>) =>
  s.ctx.world.players
    .filter((p) => p.active && p.nbaTeamId !== null && !rostered.has(p.id))
    .sort((a, b) => formAvg(s, b) - formAvg(s, a) || a.id - b.id);

/** Mid-value players of a roster that are safe to put in a trade (not in another open trade, not protected). */
export async function tradeablePlayers(s: Season, m: Manager, n: number): Promise<number[]> {
  const { byTeam } = await loadRosters(s);
  const busy = await openTradePlayers(s);
  const mine = (byTeam.get(m.teamId) ?? [])
    .filter((id) => !busy.has(id) && !s.noDrop.has(id))
    .map((id) => s.ctx.world.byId.get(id)!)
    .sort((a, b) => formAvg(s, b) - formAvg(s, a));
  const mid = mine.slice(4, 18);
  return s.ctx.rand.shuffle(mid).slice(0, n).map((p) => p.id);
}

// ------------------------------------------------------------------------------- free agency

/** One owner add (optionally with a drop) with bookkeeping. */
export async function addPlayer(s: Season, m: Manager, add: SimPlayer, drop: SimPlayer | null, when: Date) {
  const { ctx } = s;
  await addFreeAgent(ctx.db, { leagueId: ctx.leagueId, teamId: m.teamId, playerId: add.id, dropPlayerId: drop?.id ?? null, actorUserId: m.userId }, { now: when, notify: ctx.notify });
  ctx.counters.adds++;
  if (drop) ctx.counters.drops++;
}

/** The ordinary churn: a few teams swap their worst player for the best free agent. */
export async function leagueStatusNow(s: Season): Promise<string> {
  const [lg] = await s.ctx.db.select({ status: leagues.status }).from(leagues).where(eq(leagues.id, s.ctx.leagueId));
  return lg.status;
}

export async function dailyMoves(s: Season, date: string) {
  const { ctx } = s;
  if ((await leagueStatusNow(s)) === "complete") return; // free agency closes with the season
  const { rand } = ctx;
  const { byTeam, rostered } = await loadRosters(s);
  const busy = await openTradePlayers(s);
  const fa = freeAgents(s, rostered).slice(0, 40);
  const skip = s.skipMoves.get(date) ?? new Set<string>();
  const teamsToday = rand.shuffle(ctx.managers.filter((m) => !skip.has(m.teamId))).slice(0, rand.between(5, 10));
  let minute = 0;
  for (const m of teamsToday) {
    const adds = rand.chance(0.3) ? 2 : 1;
    for (let k = 0; k < adds; k++) {
      const roster = (byTeam.get(m.teamId) ?? []).map((id) => ctx.world.byId.get(id)!);
      const droppable = roster.filter((p) => !busy.has(p.id) && !s.noDrop.has(p.id)).sort((a, b) => formAvg(s, a) - formAvg(s, b));
      const candidate = fa.find(() => rand.chance(0.55)) ?? fa[0];
      if (!candidate || droppable.length === 0) continue;
      const worst = droppable[0];
      if (formAvg(s, candidate) <= formAvg(s, worst)) continue;
      const when = new Date(at(date, "09:00").getTime() + ++minute * 2 * MINUTE);
      const full = roster.length >= 32;
      const dropToo = full || rand.chance(0.4);
      await addPlayer(s, m, candidate, dropToo ? worst : null, when);
      fa.splice(fa.indexOf(candidate), 1);
      byTeam.set(m.teamId, [...roster.map((p) => p.id).filter((id) => !(dropToo && id === worst.id)), candidate.id]);
    }
    if (rand.chance(0.04)) {
      // A pure drop: the team plays a man short until it adds again.
      const roster = (byTeam.get(m.teamId) ?? []).map((id) => ctx.world.byId.get(id)!).filter((p) => !busy.has(p.id) && !s.noDrop.has(p.id));
      const worst = roster.sort((a, b) => formAvg(s, a) - formAvg(s, b))[0];
      if (worst) {
        await dropPlayer(ctx.db, { leagueId: ctx.leagueId, teamId: m.teamId, playerId: worst.id, actorUserId: m.userId }, { now: new Date(at(date, "09:00").getTime() + ++minute * 2 * MINUTE), notify: ctx.notify });
        ctx.counters.drops++;
        byTeam.set(m.teamId, (byTeam.get(m.teamId) ?? []).filter((id) => id !== worst.id));
      }
    }
  }
}

// -------------------------------------------------------------------------------------- injuries

const BODY = ["Ankle sprain", "Knee soreness", "Hamstring strain", "Illness", "Back spasms", "Wrist", "Hip", "Calf strain"];

export async function updateInjuries(s: Season, date: string) {
  const { ctx } = s;
  const { rand } = ctx;
  for (const [id, until] of [...s.injuries]) {
    if (until < date) {
      await setHealth(ctx.db, ctx.world.byId.get(id)!, healthy());
      s.injuries.delete(id);
    }
  }
  const pool = ctx.world.players.filter((p) => p.active && p.nbaTeamId !== null && p.q >= 12 && p.health.status === null);
  for (const p of pool) {
    const roll = rand.next();
    const set = async (status: string, days: number) => {
      const until = addDaysStr(date, days);
      await setHealth(ctx.db, p, { status, detail: rand.pick(BODY), untilDate: until });
      s.injuries.set(p.id, until);
    };
    if (roll < 0.0030) await set(rand.pick(["Out", "Out", "Out", "Out", "Out", "Out", "OUT", "out"]), rand.between(3, 14));
    else if (roll < 0.00305) await set("Out For Season", 200);
    else if (roll < 0.0033) await set("Suspension", rand.between(1, 5));
    else if (roll < 0.0075) await set(rand.pick(["Day-To-Day", "Day-To-Day", "Day to Day"]), rand.between(0, 2));
    else if (roll < 0.0100) await set("Questionable", rand.between(0, 1));
    else if (roll < 0.0115) await set("Doubtful", rand.between(0, 2));
  }
}

const addDaysStr = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// ------------------------------------------------------------------------------------- games

export async function tipBatch(s: Season, games: SimGame[], tip: Date, delayMin = 2) {
  const { ctx } = s;
  const { db, world, rand } = ctx;
  const now = new Date(tip.getTime() + delayMin * MINUTE);
  const ids = games.map((g) => g.id);
  await db.update(nbaGames).set({ status: "in", period: 1, clock: "11:02", statusDetail: "1st Quarter", homeScore: 0, awayScore: 0 }).where(inArray(nbaGames.id, ids));
  const snap = await timed(ctx, "snapshots.capture", () => captureTipoffSnapshots(db, now, ids));
  let expected = 0;
  for (const g of games) {
    const home = planTeamGame(rand, world.players, g.home, 1);
    const away = planTeamGame(rand, world.players, g.away, 1);
    const activeCount = world.players.filter((p) => p.active && (p.nbaTeamId === g.home || p.nbaTeamId === g.away)).length;
    expected += activeCount;
    const teamOf = (id: number) => world.teams.find((t) => t.id === id)!;
    s.plans.set(g.id, { home, away, score: finalScore(rand, teamOf(g.home), teamOf(g.away)) });
  }
  same(ctx, [snap.games, snap.rows], [games.length, expected], `tip-off snapshot of ${games.length} games holds every active player of both teams`);
  const [late] = await db.select({ n: sql<number>`count(*)::int` }).from(gameRosterSnapshots).where(and(inArray(gameRosterSnapshots.gameId, ids), eq(gameRosterSnapshots.late, true)));
  same(ctx, late.n, delayMin >= 10 ? expected : 0, delayMin >= 10 ? "a sync that ran 25 minutes after tip-off marks its snapshots late" : "snapshots taken at tip-off are not late");
}

export async function midBatch(s: Season, games: SimGame[]) {
  const { db } = s.ctx;
  const rows: (typeof playerGameStats.$inferInsert)[] = [];
  for (const g of games) {
    const plan = s.plans.get(g.id)!;
    for (const pg of [...plan.home, ...plan.away]) if (!pg.dnp) rows.push(statRow(g.id, pg, 0.55));
    await db
      .update(nbaGames)
      .set({ period: 3, clock: "5:12", statusDetail: "3rd Quarter", homeScore: Math.floor(plan.score.home * 0.62), awayScore: Math.floor(plan.score.away * 0.62) })
      .where(eq(nbaGames.id, g.id));
  }
  await db.delete(playerGameStats).where(inArray(playerGameStats.gameId, games.map((g) => g.id)));
  await chunked(rows, 300, (c) => db.insert(playerGameStats).values(c));
}

export async function finalBatch(s: Season, games: SimGame[], at0: Date) {
  const { ctx } = s;
  const { db } = ctx;
  const rows: (typeof playerGameStats.$inferInsert)[] = [];
  for (const g of games) {
    const plan = s.plans.get(g.id)!;
    for (const pg of [...plan.home, ...plan.away]) {
      rows.push(statRow(g.id, pg));
      if (!pg.dnp && pg.line) {
        const f = s.form.get(pg.player.id) ?? { gp: 0, fp: 0 };
        f.gp++;
        f.fp += lineFp(pg.line);
        s.form.set(pg.player.id, f);
      }
    }
    await db
      .update(nbaGames)
      .set({ status: "final", homeScore: plan.score.home, awayScore: plan.score.away, period: 4, clock: "0:00", statusDetail: "Final", finishedAt: at0, statsFinal: true, statsSyncedAt: at0 })
      .where(eq(nbaGames.id, g.id));
    s.plans.delete(g.id);
  }
  await db.delete(playerGameStats).where(inArray(playerGameStats.gameId, games.map((g) => g.id)));
  await chunked(rows, 300, (c) => db.insert(playerGameStats).values(c));
  ctx.counters.gamesPlayed += games.length;
}

// ---------------------------------------------------------------------------------- verification

/**
 * Recomputes a period from raw rows and compares every matchup with the app's stored result (points,
 * winner, cached team totals). Regular periods also update the sim's own record of results.
 */
export async function verifyPeriod(s: Season, period: Period, opts: { requireFinal: boolean }) {
  const { ctx } = s;
  const { db } = ctx;
  const rows = await db.select().from(matchups).where(eq(matchups.periodId, period.id));
  const data = await loadOracleData(db, ctx.leagueId, period.startDate, period.endDate);
  const games: OracleGame[] = [];
  let checked = 0;
  for (const m of rows) {
    if (!m.homeTeamId || !m.awayTeamId) continue;
    if (m.status !== "final") {
      ok(ctx, !opts.requireFinal, `period ${period.number} matchup ${m.id} should be final but is ${m.status}`);
      continue;
    }
    const home = r2(oracleTeamTotal(data, m.homeTeamId).points + adjustmentFor(data, m.id, m.homeTeamId));
    const away = r2(oracleTeamTotal(data, m.awayTeamId).points + adjustmentFor(data, m.id, m.awayTeamId));
    same(ctx, [m.homePoints, m.awayPoints], [home, away], `period ${period.number}: stored matchup totals equal the oracle`);
    const winner = Math.round(home * 100) === Math.round(away * 100) ? null : home > away ? m.homeTeamId : m.awayTeamId;
    same(ctx, m.winnerTeamId, winner, `period ${period.number}: winner`);
    const cached = await db.select().from(matchupTeamTotals).where(eq(matchupTeamTotals.matchupId, m.id));
    same(ctx, cached.map((c) => [c.teamId, c.points]).sort(), [[m.homeTeamId, home], [m.awayTeamId, away]].sort(), `period ${period.number}: cached totals`);
    games.push({ period: period.number, home: m.homeTeamId, away: m.awayTeamId, hp: home, ap: away });
    checked++;
  }
  ctx.counters.oracleMatchups += checked;
  if (period.isPlayoff) s.playoffResults.set(period.number, games);
  else s.results.set(period.number, games);
  return games;
}

/** The app's standings (cached table) must equal the oracle's from the periods verified so far. */
export async function verifyStandings(s: Season, label: string) {
  const { ctx } = s;
  const all = [...s.results.values()].flat();
  const oracle = oracleStandings(s.teamsList, all);
  const app = await getStandings(ctx.db, ctx.leagueId);
  same(ctx, app.length, 16, `${label}: standings rows`);
  oracle.forEach((o, i) => {
    const a = app[i];
    same(ctx, [a.rank, a.teamId, a.wins, a.losses, a.ties, r2(a.pointsFor), r2(a.pointsAgainst), a.streak, a.gamesBack], [i + 1, o.teamId, o.w, o.l, o.t, r2(o.pf), r2(o.pa), o.streak, o.gamesBack], `${label}: standings row ${i + 1} (${o.name})`);
  });
  return oracle;
}

// ---------------------------------------------------------------------------------- invariants

const STATUS_ORDER = ["setup", "drafting", "in_season", "playoffs", "complete"];

export async function dailyInvariants(s: Season, date: string) {
  const { ctx } = s;
  const { db } = ctx;
  const dupes = await rawRows(db, sql`select player_id from roster_entries where league_id = ${ctx.leagueId} and released_at is null group by player_id having count(*) > 1`);
  same(ctx, dupes.length, 0, `${date}: no player on two teams`);
  const big = await rawRows(db, sql`select team_id, count(*)::int as n from roster_entries where league_id = ${ctx.leagueId} and released_at is null group by team_id having count(*) > 32`);
  same(ctx, big.length, 0, `${date}: no roster above 32`);
  const adds = await rawRows(db, sql`select team_id, count(*)::int as n from transactions where league_id = ${ctx.leagueId} and type = 'add' and et_date = ${date} group by team_id having count(*) > 2`);
  same(ctx, adds.length, 0, `${date}: at most 2 owner adds per team per ET day`);
  const bad = await rawRows(db, sql`select id from roster_entries where league_id = ${ctx.leagueId} and released_at is not null and released_at < acquired_at`);
  same(ctx, bad.length, 0, `${date}: no roster entry released before it was acquired`);
  const [lg] = await db.select({ status: leagues.status }).from(leagues).where(eq(leagues.id, ctx.leagueId));
  ok(ctx, STATUS_ORDER.indexOf(lg.status) >= STATUS_ORDER.indexOf(s.statusSeen), `${date}: league status went backwards (${s.statusSeen} -> ${lg.status})`);
  s.statusSeen = lg.status;
}

/** After the NBA sync: nobody on a roster may be cut (inactive or without an NBA team). */
export async function assertNoCutPlayersRostered(s: Season, date: string) {
  const { ctx } = s;
  const res = await rawRows(ctx.db, 
    sql`select re.player_id from roster_entries re join nba_players p on p.id = re.player_id where re.league_id = ${ctx.leagueId} and re.released_at is null and (p.active = false or p.team_id is null)`,
  );
  same(ctx, res.length, 0, `${date}: cut players were auto-dropped`);
}

// ------------------------------------------------------------------------------------- nightly

export type NightlySummary = Awaited<ReturnType<typeof runNightlyMatchupJob>>;

/** The cron: nightly matchup job then due trades, at 04:00 ET. */
export async function nightly(s: Season, now: Date) {
  const { ctx } = s;
  const res = await timed(ctx, "nightly.matchups", () => runNightlyMatchupJob(ctx.db, now, { notify: ctx.notify }));
  same(ctx, res.errors, [], "nightly job reported no errors");
  same(ctx, res.pending, 0, "nightly job left no pending periods");
  const due = await timed(ctx, "nightly.trades", () => processDueTrades(ctx.db, now, { notify: ctx.notify }));
  same(ctx, due.errors, [], "trade job reported no errors");
  return { res, due };
}

// ------------------------------------------------------------------------- moves during games

/**
 * Two teams add a free agent and drop a player after their NBA games have tipped off. Ownership of a game's
 * points is decided at tip-off, so the new team must not get today's game and the old team must keep it.
 */
export async function lateMoves(s: Season, date: string, when: Date) {
  const { ctx } = s;
  if ((await leagueStatusNow(s)) === "complete") return;
  const { rand } = ctx;
  const started = (s.gamesByDate.get(date) ?? []).filter((g) => g.startTime.getTime() < when.getTime());
  if (started.length === 0) return;
  const teamsPlaying = new Set(started.flatMap((g) => [g.home, g.away]));
  const gameOf = (nbaTeam: number | null) => started.find((g) => g.home === nbaTeam || g.away === nbaTeam)?.id ?? null;
  const { byTeam, rostered } = await loadRosters(s);
  const busy = await openTradePlayers(s);
  const fa = freeAgents(s, rostered).filter((p) => p.nbaTeamId !== null && teamsPlaying.has(p.nbaTeamId));
  for (const m of rand.shuffle(ctx.managers).slice(0, 3)) {
    if (s.skipMoves.get(date)?.has(m.teamId)) continue;
    const adds = await getAddsToday(ctx.db, m.teamId, 2, when);
    const roster = (byTeam.get(m.teamId) ?? []).map((id) => ctx.world.byId.get(id)!);
    const droppable = roster.filter((p) => p.nbaTeamId !== null && teamsPlaying.has(p.nbaTeamId) && !busy.has(p.id) && !s.noDrop.has(p.id) && p.health.status !== "Out");
    if (adds.remaining <= 0 || fa.length === 0 || droppable.length === 0) continue;
    const add = fa.shift()!;
    const drop = droppable.sort((a, b) => formAvg(s, a) - formAvg(s, b))[0];
    await addPlayer(s, m, add, drop, when);
    s.lateMoves.push({ teamId: m.teamId, add: add.id, drop: drop.id, at: when, date, addGame: gameOf(add.nbaTeamId), dropGame: gameOf(drop.nbaTeamId) });
    byTeam.set(m.teamId, [...roster.map((p) => p.id).filter((id) => id !== drop.id), add.id]);
    break;
  }
}

/** After the day's games: the app credits today's game to whoever had the player at tip-off. */
export async function verifyLateMoves(s: Season, date: string) {
  const { ctx } = s;
  for (const mv of s.lateMoves.filter((x) => x.date === date)) {
    const mine = await teamGamePoints(ctx.db, mv.teamId, { from: date, to: date });
    if (mv.addGame !== null) {
      same(ctx, mine.some((r) => r.playerId === mv.add && r.gameId === mv.addGame), false, `${date}: a player added after tip-off earns nothing from that game for the new team`);
    }
    if (mv.dropGame !== null) {
      same(ctx, mine.some((r) => r.playerId === mv.drop && r.gameId === mv.dropGame), true, `${date}: a player dropped after tip-off still earns that game for the old team`);
    }
    ctx.counters.lateMoves++;
  }
}
