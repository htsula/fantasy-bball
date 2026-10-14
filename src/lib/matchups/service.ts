/**
 * Matchup totals, period finalization and standings (milestone 6).
 *
 * Totals come from team-points.ts over the period's ET date range (00:00 ET on the start date
 * through 23:59:59 ET on the end date, by game tip-off) and are cached in matchup_team_totals.
 * Live totals are recomputed when the cache is older than ~60s. A period is FINAL only after:
 *   1. its last ET day is over (we are on a later ET date, so the nightly cron's correction sync
 *      has re-pulled the last day's finals), and
 *   2. every NBA game in the window is final/postponed (none scheduled or in progress).
 * Finalizing is idempotent and re-runnable: running it again recomputes from current stats (a
 * stat correction can change a score or even the winner) and refreshes the standings.
 */
import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { log } from "@/lib/log";
import {
  leagues,
  matchupAdjustments,
  matchupPeriods,
  matchups,
  matchupTeamTotals,
  nbaGames,
  nbaPlayers,
  playoffSlots,
  rosterEntries,
  standings as standingsTable,
  teams,
  users,
  type League,
  type Matchup,
  type MatchupPeriod,
  type Team,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { projectFinal, resolveMatchup, roundPoints } from "@/lib/fantasy/matchup";
import { loadProjections } from "@/lib/fantasy/projections";
import { parseStoredSettings, type LeagueSettings } from "@/lib/fantasy/settings";
import { computeStandings, type FinalMatchup, type StandingRow } from "@/lib/fantasy/standings";
import { teamGamePoints } from "@/lib/fantasy/team-points";
import { addDays, etDateString, etStartOfDay } from "@/lib/nba/dates";
import { logActivity } from "@/lib/activity/service";
import { notify as realNotify, type Notifier } from "@/lib/notifications/service";
import { roundLabel } from "@/lib/fantasy/bracket";
import { advancePlayoffs } from "@/lib/playoffs/service";

export type MatchupErrorCode = "not_found" | "forbidden" | "invalid_input";

export class MatchupError extends Error {
  constructor(public code: MatchupErrorCode, message = "Matchup not found.") {
    super(message);
  }
}

export type MatchupDeps = { notify?: Notifier };

export type TeamTotals = {
  teamId: string;
  /** Includes winBonus. */
  points: number;
  winBonus: number;
  gamesPlayed: number;
  gamesRemaining: number;
  projected: number;
  computedAt: Date;
};

export type MatchupTotals = { matchupId: string; home: TeamTotals; away: TeamTotals | null };

type Ctx = { matchup: Matchup; period: MatchupPeriod; league: League; settings: LeagueSettings };

export const TOTALS_MAX_AGE_SEC = 60;

const uuidOk = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

async function loadCtx(db: Db, matchupId: string): Promise<Ctx> {
  if (!uuidOk(matchupId)) throw new MatchupError("not_found");
  const [row] = await db
    .select({ matchup: matchups, period: matchupPeriods, league: leagues })
    .from(matchups)
    .innerJoin(matchupPeriods, eq(matchupPeriods.id, matchups.periodId))
    .innerJoin(leagues, eq(leagues.id, matchups.leagueId))
    .where(eq(matchups.id, matchupId));
  if (!row) throw new MatchupError("not_found");
  return { ...row, settings: parseStoredSettings(row.league.settings) };
}

export const loadMatchupContext = loadCtx;

/** Half-open [start, end) instants of a period: 00:00 ET of the first day to 00:00 ET after the last. */
export function periodWindow(period: Pick<MatchupPeriod, "startDate" | "endDate">) {
  return { start: etStartOfDay(period.startDate), end: etStartOfDay(addDays(period.endDate, 1)) };
}

// ---------------------------------------------------------------------------- score adjustments

async function adjustmentTotal(db: Db, matchupId: string, teamId: string): Promise<number> {
  const [r] = await db
    .select({ total: sql<number>`coalesce(sum(${matchupAdjustments.points}), 0)::float8` })
    .from(matchupAdjustments)
    .where(and(eq(matchupAdjustments.matchupId, matchupId), eq(matchupAdjustments.teamId, teamId)));
  return r?.total ?? 0;
}

export type AdjustmentRow = {
  id: string;
  matchupId: string;
  teamId: string;
  points: number;
  reason: string;
  actorUsername: string | null;
  createdAt: Date;
};

/** Every commissioner adjustment on a matchup, oldest first. */
export async function listMatchupAdjustments(db: Db, matchupId: string): Promise<AdjustmentRow[]> {
  if (!uuidOk(matchupId)) return [];
  return db
    .select({
      id: matchupAdjustments.id,
      matchupId: matchupAdjustments.matchupId,
      teamId: matchupAdjustments.teamId,
      points: matchupAdjustments.points,
      reason: matchupAdjustments.reason,
      actorUsername: users.username,
      createdAt: matchupAdjustments.createdAt,
    })
    .from(matchupAdjustments)
    .leftJoin(users, eq(users.id, matchupAdjustments.actorUserId))
    .where(eq(matchupAdjustments.matchupId, matchupId))
    .orderBy(asc(matchupAdjustments.createdAt), asc(matchupAdjustments.id));
}

export type LeagueAdjustmentRow = AdjustmentRow & { teamName: string; periodNumber: number; isPlayoff: boolean };

/** The league's most recent adjustments (commissioner page). */
export async function listLeagueAdjustments(db: Db, leagueId: string, limit = 20): Promise<LeagueAdjustmentRow[]> {
  return db
    .select({
      id: matchupAdjustments.id,
      matchupId: matchupAdjustments.matchupId,
      teamId: matchupAdjustments.teamId,
      points: matchupAdjustments.points,
      reason: matchupAdjustments.reason,
      actorUsername: users.username,
      createdAt: matchupAdjustments.createdAt,
      teamName: teams.name,
      periodNumber: matchupPeriods.number,
      isPlayoff: matchupPeriods.isPlayoff,
    })
    .from(matchupAdjustments)
    .innerJoin(teams, eq(teams.id, matchupAdjustments.teamId))
    .innerJoin(matchups, eq(matchups.id, matchupAdjustments.matchupId))
    .innerJoin(matchupPeriods, eq(matchupPeriods.id, matchups.periodId))
    .leftJoin(users, eq(users.id, matchupAdjustments.actorUserId))
    .where(eq(matchupAdjustments.leagueId, leagueId))
    .orderBy(desc(matchupAdjustments.createdAt), desc(matchupAdjustments.id))
    .limit(limit);
}

export const MAX_ADJUSTMENT = 10_000;

const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : fmt(n));

/**
 * Recomputes a FINAL matchup from current stats + adjustments and rewrites its result (no
 * notifications; the matchup was already announced). Refreshes the standings for regular-season
 * matchups. Playoff advancement is the caller's job (advancePlayoffs).
 */
async function refinalizeMatchup(db: Db, ctx: Ctx, now: Date): Promise<void> {
  const m = ctx.matchup;
  if (!m.homeTeamId) return;
  const totals = await calcMatchupTotals(db, { ...ctx, matchup: { ...m, status: "final" } }, now);
  await saveTotals(db, totals);
  const outcome = resolveMatchup(
    { homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId },
    { home: totals.home.points, away: totals.away?.points ?? null },
  );
  await db
    .update(matchups)
    .set({ status: "final", winnerTeamId: outcome.winnerTeamId, homePoints: outcome.homePoints, awayPoints: outcome.awayPoints })
    .where(eq(matchups.id, m.id));
  if (!ctx.period.isPlayoff) await refreshStandings(db, m.leagueId, now);
}

export type AdjustResult = { adjustment: AdjustmentRow; warnings: string[] };

/**
 * Commissioner only. Adds a signed point adjustment (with a required reason) to one team's score in
 * one matchup. The matchup's totals are recomputed right away; when it is already final its result
 * is rewritten and the standings refreshed. Playoff matchups also go through advancePlayoffs: the
 * bracket only changes while the next round hasn't started, otherwise a warning is returned and the
 * advancement stays as it is (fix it with the playoff winner override). Adjusting a regular-season
 * matchup after the bracket was seeded warns that the seeds were not recomputed.
 */
export async function adjustMatchupScore(
  db: Db,
  actor: { id: string },
  matchupId: string,
  teamId: string,
  pointsRaw: number,
  reasonRaw: string,
  deps: MatchupDeps & { now?: Date } = {},
): Promise<AdjustResult> {
  const now = deps.now ?? new Date();
  const ctx = await loadCtx(db, matchupId);
  const { matchup, period, league } = ctx;
  if (league.commissionerId !== actor.id) throw new MatchupError("forbidden", "Only the commissioner can adjust scores.");
  if (teamId !== matchup.homeTeamId && teamId !== matchup.awayTeamId) {
    throw new MatchupError("invalid_input", "That team isn't in this matchup.");
  }
  if (typeof pointsRaw !== "number" || !Number.isFinite(pointsRaw)) throw new MatchupError("invalid_input", "Enter the number of points.");
  const points = roundPoints(pointsRaw);
  if (points === 0) throw new MatchupError("invalid_input", "An adjustment of 0 changes nothing.");
  if (Math.abs(points) > MAX_ADJUSTMENT) throw new MatchupError("invalid_input", `Adjustments can be at most ${MAX_ADJUSTMENT} points.`);
  const reason = String(reasonRaw ?? "").trim();
  if (reason.length < 3) throw new MatchupError("invalid_input", "Give a reason (at least 3 characters): everyone in the league can see it.");
  if (reason.length > 300) throw new MatchupError("invalid_input", "The reason can be at most 300 characters.");

  const [team] = await db.select().from(teams).where(eq(teams.id, teamId));
  const label = period.isPlayoff ? `playoff week ${period.number}` : `week ${period.number}`;
  const inserted = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(matchupAdjustments)
      .values({ leagueId: league.id, matchupId, teamId, points, reason, actorUserId: actor.id, createdAt: now })
      .returning();
    await logActivity(tx, {
      leagueId: league.id,
      actorUserId: actor.id,
      type: "score_adjustment",
      summary: `Commissioner adjusted ${team?.name ?? "a team"} by ${signed(points)} in ${label}: ${reason}`,
      data: { matchupId, teamId, points, reason, adjustmentId: row.id, url: `/leagues/${league.id}/matchup/${matchupId}` },
      now,
    });
    return row;
  });

  const warnings: string[] = [];
  if (matchup.status === "final") {
    await refinalizeMatchup(db, ctx, now);
    if (period.isPlayoff) {
      const adv = await advancePlayoffs(db, league.id, now);
      warnings.push(...adv.warnings);
    } else {
      const [slots] = await db.select({ n: sql<number>`count(*)::int` }).from(playoffSlots).where(eq(playoffSlots.leagueId, league.id));
      if (slots.n > 0) {
        warnings.push(
          "The playoff bracket was already seeded, so it was NOT recomputed from the new standings. Use Re-seed on the playoffs page if round 1 hasn't started.",
        );
      }
    }
  } else {
    await computeMatchupTotals(db, matchupId, now);
  }

  if (team && team.ownerId !== actor.id) {
    await (deps.notify ?? realNotify)(db, {
      userIds: [team.ownerId],
      leagueId: league.id,
      type: "commissioner_actions",
      title: "Commissioner adjusted your score",
      body: `${team.name} ${signed(points)} in ${label}: ${reason}`,
      url: `/leagues/${league.id}/matchup/${matchupId}`,
    });
  }
  const [actorRow] = await db.select({ username: users.username }).from(users).where(eq(users.id, actor.id));
  return { adjustment: { ...inserted, actorUsername: actorRow?.username ?? null }, warnings };
}

// -------------------------------------------------------------------------------------- totals

async function calcTeamTotals(db: Db, ctx: Ctx, teamId: string, now: Date): Promise<TeamTotals> {
  const { period, settings } = ctx;
  const final = ctx.matchup.status === "final";
  const rows = await teamGamePoints(db, teamId, { from: period.startDate, to: period.endDate }, { scoring: settings.scoring });
  let points = 0;
  let winBonus = 0;
  for (const r of rows) {
    points += r.total;
    winBonus += r.winBonus;
  }
  // Commissioner corrections count toward the score (and so toward results, standings and playoffs).
  points += await adjustmentTotal(db, ctx.matchup.id, teamId);

  // Remaining = scheduled games in the period for the players CURRENTLY on the roster.
  let gamesRemaining = 0;
  let projected = points;
  const periodOver = etDateString(now) > period.endDate;
  if (!final && !periodOver) {
    const { start, end } = periodWindow(period);
    const remaining = await db
      .select({ playerId: rosterEntries.playerId, gameId: nbaGames.id })
      .from(rosterEntries)
      .innerJoin(nbaPlayers, eq(nbaPlayers.id, rosterEntries.playerId))
      .innerJoin(
        nbaGames,
        and(
          eq(nbaGames.status, "scheduled"),
          gte(nbaGames.startTime, start),
          lt(nbaGames.startTime, end),
          sql`(${nbaGames.homeTeamId} = ${nbaPlayers.teamId} or ${nbaGames.awayTeamId} = ${nbaPlayers.teamId})`,
        ),
      )
      .where(and(eq(rosterEntries.teamId, teamId), sql`${rosterEntries.releasedAt} is null`));
    gamesRemaining = remaining.length;
    if (remaining.length) {
      const ids = [...new Set(remaining.map((r) => r.playerId))];
      const proj = await loadProjections(db, { playerIds: ids, now, teamWin: settings.scoring.teamWin, points: settings.scoring });
      projected = projectFinal(
        points,
        remaining.map((r) => proj.get(r.playerId)?.projection ?? 0),
      );
    }
  }
  return {
    teamId,
    points: roundPoints(points),
    winBonus: roundPoints(winBonus),
    gamesPlayed: rows.length,
    gamesRemaining,
    projected: roundPoints(projected),
    computedAt: now,
  };
}

async function calcMatchupTotals(db: Db, ctx: Ctx, now: Date): Promise<MatchupTotals> {
  const { matchup } = ctx;
  if (!matchup.homeTeamId) throw new MatchupError("not_found");
  const [home, away] = await Promise.all([
    calcTeamTotals(db, ctx, matchup.homeTeamId, now),
    matchup.awayTeamId ? calcTeamTotals(db, ctx, matchup.awayTeamId, now) : Promise.resolve(null),
  ]);
  return { matchupId: matchup.id, home, away };
}

async function saveTotals(db: Db, totals: MatchupTotals) {
  const rows = [totals.home, totals.away].filter((t): t is TeamTotals => t !== null);
  for (const t of rows) {
    const values = {
      matchupId: totals.matchupId,
      teamId: t.teamId,
      points: t.points,
      winBonus: t.winBonus,
      gamesPlayed: t.gamesPlayed,
      gamesRemaining: t.gamesRemaining,
      projected: t.projected,
      computedAt: t.computedAt,
    };
    await db
      .insert(matchupTeamTotals)
      .values(values)
      .onConflictDoUpdate({
        target: [matchupTeamTotals.matchupId, matchupTeamTotals.teamId],
        set: {
          points: values.points,
          winBonus: values.winBonus,
          gamesPlayed: values.gamesPlayed,
          gamesRemaining: values.gamesRemaining,
          projected: values.projected,
          computedAt: values.computedAt,
        },
      });
  }
}

/**
 * Recomputes both teams' totals from box scores and snapshots, caches them, and (while the
 * matchup is not final) keeps matchups.status/home_points/away_points current.
 */
export async function computeMatchupTotals(db: Db, matchupId: string, now = new Date()): Promise<MatchupTotals> {
  const ctx = await loadCtx(db, matchupId);
  const totals = await calcMatchupTotals(db, ctx, now);
  await saveTotals(db, totals);
  if (ctx.matchup.status !== "final") {
    const started = totals.home.gamesPlayed + (totals.away?.gamesPlayed ?? 0) > 0;
    await db
      .update(matchups)
      .set({
        status: started ? "live" : "scheduled",
        homePoints: totals.home.points,
        awayPoints: totals.away?.points ?? null,
      })
      .where(and(eq(matchups.id, matchupId), ne(matchups.status, "final")));
  }
  return totals;
}

function fromRow(r: typeof matchupTeamTotals.$inferSelect): TeamTotals {
  return {
    teamId: r.teamId,
    points: r.points,
    winBonus: r.winBonus,
    gamesPlayed: r.gamesPlayed,
    gamesRemaining: r.gamesRemaining,
    projected: r.projected,
    computedAt: r.computedAt,
  };
}

/** Cached totals when fresh (or the matchup is final), otherwise recomputed. */
export async function getMatchupTotals(
  db: Db,
  matchupId: string,
  now = new Date(),
  opts: { maxAgeSec?: number } = {},
): Promise<MatchupTotals> {
  const ctx = await loadCtx(db, matchupId);
  const cached = await db.select().from(matchupTeamTotals).where(eq(matchupTeamTotals.matchupId, matchupId));
  const home = cached.find((c) => c.teamId === ctx.matchup.homeTeamId);
  const away = cached.find((c) => c.teamId === ctx.matchup.awayTeamId);
  const complete = Boolean(home) && (ctx.matchup.awayTeamId === null || Boolean(away));
  if (complete && home) {
    const maxAgeMs = (opts.maxAgeSec ?? TOTALS_MAX_AGE_SEC) * 1000;
    const newest = Math.min(...[home, away].filter(Boolean).map((r) => r!.computedAt.getTime()));
    if (ctx.matchup.status === "final" || now.getTime() - newest < maxAgeMs) {
      return { matchupId, home: fromRow(home), away: away ? fromRow(away) : null };
    }
  }
  return computeMatchupTotals(db, matchupId, now);
}

// -------------------------------------------------------------------------------------- periods

/** The period containing today's ET date, or null (before the first / after the last period). */
export async function getCurrentPeriod(db: Db, leagueId: string, now = new Date()): Promise<MatchupPeriod | null> {
  const today = etDateString(now);
  const [p] = await db
    .select()
    .from(matchupPeriods)
    .where(
      and(
        eq(matchupPeriods.leagueId, leagueId),
        sql`${matchupPeriods.startDate} <= ${today}`,
        sql`${matchupPeriods.endDate} >= ${today}`,
      ),
    )
    .limit(1);
  return p ?? null;
}

/** Current period, else the next upcoming one, else the last one. Null when there is no schedule. */
export async function getFocusPeriod(db: Db, leagueId: string, now = new Date()): Promise<MatchupPeriod | null> {
  const current = await getCurrentPeriod(db, leagueId, now);
  if (current) return current;
  const today = etDateString(now);
  const [next] = await db
    .select()
    .from(matchupPeriods)
    .where(and(eq(matchupPeriods.leagueId, leagueId), sql`${matchupPeriods.startDate} > ${today}`))
    .orderBy(asc(matchupPeriods.number))
    .limit(1);
  if (next) return next;
  const [last] = await db
    .select()
    .from(matchupPeriods)
    .where(eq(matchupPeriods.leagueId, leagueId))
    .orderBy(sql`${matchupPeriods.number} desc`)
    .limit(1);
  return last ?? null;
}

export async function getMatchupForTeam(db: Db, periodId: string, teamId: string): Promise<Matchup | null> {
  const rows = await db.select().from(matchups).where(eq(matchups.periodId, periodId));
  return rows.find((m) => m.homeTeamId === teamId || m.awayTeamId === teamId) ?? null;
}

export type PeriodReadiness = { ready: boolean; reason?: "not_over" | "games_pending" };

/** Has the period's last ET day passed and are all of its NBA games settled? */
export async function periodReadiness(db: Db, period: MatchupPeriod, now: Date): Promise<PeriodReadiness> {
  if (etDateString(now) <= period.endDate) return { ready: false, reason: "not_over" };
  const { start, end } = periodWindow(period);
  const [pending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nbaGames)
    .where(and(gte(nbaGames.startTime, start), lt(nbaGames.startTime, end), inArray(nbaGames.status, ["scheduled", "in"])));
  return pending.n > 0 ? { ready: false, reason: "games_pending" } : { ready: true };
}

export type FinalizeResult =
  | { status: "not_ready"; reason: "not_over" | "games_pending" }
  | { status: "finalized" | "refinalized"; matchups: number; changed: number };

/**
 * Locks a period's results. See the module comment for the readiness rules. Safe to call
 * repeatedly: a second call recomputes (picking up stat corrections) and only reports/changes what
 * differs. Owners are notified exactly once, when a matchup first becomes final.
 */
export async function finalizePeriod(
  db: Db,
  leagueId: string,
  periodId: string,
  now = new Date(),
  deps: MatchupDeps = {},
): Promise<FinalizeResult> {
  const [period] = await db
    .select()
    .from(matchupPeriods)
    .where(and(eq(matchupPeriods.id, periodId), eq(matchupPeriods.leagueId, leagueId)));
  if (!period) throw new MatchupError("not_found", "Period not found.");
  const readiness = await periodReadiness(db, period, now);
  if (!readiness.ready) return { status: "not_ready", reason: readiness.reason! };

  const rows = await db.select().from(matchups).where(eq(matchups.periodId, periodId));
  const [league] = await db.select().from(leagues).where(eq(leagues.id, leagueId));
  const settings = parseStoredSettings(league.settings);
  const teamRows = await db.select().from(teams).where(eq(teams.leagueId, leagueId));
  const teamById = new Map(teamRows.map((t) => [t.id, t]));

  let changed = 0;
  let wasFinal = 0;
  const toNotify: { matchup: Matchup; winnerTeamId: string | null; home: number; away: number }[] = [];

  for (const m of rows) {
    if (!m.homeTeamId) continue;
    const ctx: Ctx = { matchup: { ...m, status: "final" }, period, league, settings }; // "final": no projections
    const totals = await calcMatchupTotals(db, ctx, now);
    await saveTotals(db, totals);
    const outcome = resolveMatchup(
      { homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId },
      { home: totals.home.points, away: totals.away?.points ?? null },
    );
    const same =
      m.status === "final" &&
      m.homePoints === outcome.homePoints &&
      m.awayPoints === outcome.awayPoints &&
      m.winnerTeamId === outcome.winnerTeamId;
    if (m.status === "final") wasFinal++;
    if (same) continue;
    // Conditional on the previous status so a concurrent finalizer can't both claim the transition.
    const [updated] = await db
      .update(matchups)
      .set({ status: "final", winnerTeamId: outcome.winnerTeamId, homePoints: outcome.homePoints, awayPoints: outcome.awayPoints })
      .where(and(eq(matchups.id, m.id), eq(matchups.status, m.status)))
      .returning({ id: matchups.id });
    if (!updated) continue;
    changed++;
    if (m.status !== "final" && !outcome.bye) {
      toNotify.push({ matchup: m, winnerTeamId: outcome.winnerTeamId, home: outcome.homePoints, away: outcome.awayPoints! });
    }
  }

  if (!period.isPlayoff) await refreshStandings(db, leagueId, now);

  const send = deps.notify ?? realNotify;
  const [{ rounds }] = await db
    .select({ rounds: sql<number>`coalesce(max(${matchupPeriods.playoffRound}), 0)::int` })
    .from(matchupPeriods)
    .where(eq(matchupPeriods.leagueId, leagueId));
  for (const n of toNotify) {
    const home = teamById.get(n.matchup.homeTeamId!);
    const away = teamById.get(n.matchup.awayTeamId!);
    if (!home || !away) continue;
    const label = period.isPlayoff ? `Playoffs: ${playoffRoundName(period.playoffRound, rounds)}` : `Week ${period.number}`;
    for (const [mine, theirs, myPts, theirPts] of [
      [home, away, n.home, n.away],
      [away, home, n.away, n.home],
    ] as [Team, Team, number, number][]) {
      const verb = n.winnerTeamId === null ? "tied" : n.winnerTeamId === mine.id ? "won" : "lost";
      await send(db, {
        userIds: [mine.ownerId],
        leagueId,
        type: "matchup_results",
        title: `${label} final`,
        body: `You ${verb} ${fmt(myPts)}-${fmt(theirPts)} vs ${theirs.name}`,
        url: `/leagues/${leagueId}/matchup/${n.matchup.id}`,
      });
    }
  }

  return { status: wasFinal === rows.length && rows.length > 0 ? "refinalized" : "finalized", matchups: rows.length, changed };
}

const playoffRoundName = (round: number | null, rounds: number) => (round ? roundLabel(round, rounds) : "round");

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export type NightlyResult = {
  leagues: number;
  finalized: number;
  refinalized: number;
  pending: number;
  errors: string[];
  /** Playoffs (milestone 8). */
  playoffsSeeded: number;
  playoffMatchups: number;
  playoffGamesDecided: number;
  leaguesCompleted: number;
  warnings: string[];
};

export const emptyNightlyResult = (errors: string[] = []): NightlyResult => ({
  leagues: 0,
  finalized: 0,
  refinalized: 0,
  pending: 0,
  errors,
  playoffsSeeded: 0,
  playoffMatchups: 0,
  playoffGamesDecided: 0,
  leaguesCompleted: 0,
  warnings: [],
});

/** Corrections can land for a few days after a period; keep re-finalizing this long. */
export const CORRECTION_WINDOW_DAYS = 3;

/**
 * Nightly job (runs from /api/cron/daily after the NBA syncs): for every league in season,
 * finalizes ended periods that are not final yet (and re-finalizes the ones that ended within the
 * correction window), advances the playoffs (seeds the bracket once every regular-season period is
 * final, decides finished rounds, creates the next round's matchups, and completes the league after
 * the final), then refreshes the standings cache. Everything is idempotent, so a missed night just
 * catches up on the next one. `opts.leagueId` limits the run to one league.
 */
export async function runNightlyMatchupJob(
  db: Db,
  now = new Date(),
  deps: MatchupDeps = {},
  opts: { leagueId?: string } = {},
): Promise<NightlyResult> {
  const result = emptyNightlyResult();
  const active = await db
    .select()
    .from(leagues)
    .where(
      and(inArray(leagues.status, ["in_season", "playoffs"]), opts.leagueId ? eq(leagues.id, opts.leagueId) : undefined),
    );
  const today = etDateString(now);
  const recent = addDays(today, -CORRECTION_WINDOW_DAYS);
  for (const league of active) {
    result.leagues++;
    try {
      // Finalize ended periods, then advance the playoffs (seed / next round / complete). Advancing
      // can create matchups for a period that already ended, so repeat until nothing changes. Each
      // period is handled once per run.
      const handled = new Set<string>();
      for (let pass = 0; pass < 8; pass++) {
        const ended = await db
          .select()
          .from(matchupPeriods)
          .where(and(eq(matchupPeriods.leagueId, league.id), sql`${matchupPeriods.endDate} < ${today}`))
          .orderBy(asc(matchupPeriods.number));
        for (const p of ended) {
          if (handled.has(p.id)) continue;
          const rows = await db.select({ status: matchups.status }).from(matchups).where(eq(matchups.periodId, p.id));
          if (rows.length === 0) continue; // playoff periods before their matchups exist
          handled.add(p.id);
          const allFinal = rows.every((r) => r.status === "final");
          if (allFinal && p.endDate < recent) continue;
          const r = await finalizePeriod(db, league.id, p.id, now, deps);
          if (r.status === "not_ready") {
            if (!allFinal) result.pending++;
          } else if (r.status === "finalized") result.finalized++;
          else result.refinalized++;
        }
        const adv = await advancePlayoffs(db, league.id, now, deps);
        if (adv.seeded) result.playoffsSeeded++;
        result.playoffMatchups += adv.matchupsCreated;
        result.playoffGamesDecided += adv.slotsDecided;
        if (adv.completed) result.leaguesCompleted++;
        result.warnings.push(...adv.warnings);
        if (!adv.progressed) break;
      }
      await refreshStandings(db, league.id, now);
    } catch (err) {
      log.error("matchups.nightly_failed", { leagueId: league.id }, err);
      result.errors.push(`${league.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

// ------------------------------------------------------------------------------------ standings

async function loadFinalMatchups(db: Db, leagueId: string): Promise<FinalMatchup[]> {
  const rows = await db
    .select({
      number: matchupPeriods.number,
      home: matchups.homeTeamId,
      away: matchups.awayTeamId,
      homePoints: matchups.homePoints,
      awayPoints: matchups.awayPoints,
    })
    .from(matchups)
    .innerJoin(matchupPeriods, eq(matchupPeriods.id, matchups.periodId))
    .where(and(eq(matchups.leagueId, leagueId), eq(matchups.status, "final"), eq(matchupPeriods.isPlayoff, false)));
  return rows
    .filter((r) => r.home && r.away && r.homePoints !== null && r.awayPoints !== null)
    .map((r) => ({
      periodNumber: r.number,
      homeTeamId: r.home!,
      awayTeamId: r.away,
      homePoints: r.homePoints!,
      awayPoints: r.awayPoints,
    }));
}

/** Recomputes the league standings from final regular-season matchups and caches them. */
export async function refreshStandings(db: Db, leagueId: string, now = new Date()): Promise<StandingRow[]> {
  const teamRows = await db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.leagueId, leagueId));
  const rows = computeStandings(teamRows, await loadFinalMatchups(db, leagueId));
  await db.transaction(async (tx) => {
    await tx.delete(standingsTable).where(eq(standingsTable.leagueId, leagueId));
    if (rows.length) {
      await tx.insert(standingsTable).values(
        rows.map((r) => ({
          leagueId,
          teamId: r.teamId,
          wins: r.wins,
          losses: r.losses,
          ties: r.ties,
          pointsFor: r.pointsFor,
          pointsAgainst: r.pointsAgainst,
          streak: r.streak,
          rank: r.rank,
          computedAt: now,
        })),
      );
    }
  });
  return rows;
}

/**
 * Standings for display: the cached table when it covers every team, otherwise computed on the
 * fly (a brand-new league has no cache until its first period is finalized).
 */
export async function getStandings(db: Db, leagueId: string): Promise<StandingRow[]> {
  const teamRows = await db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.leagueId, leagueId));
  const cached = await db.select().from(standingsTable).where(eq(standingsTable.leagueId, leagueId)).orderBy(asc(standingsTable.rank));
  if (cached.length === teamRows.length && cached.length > 0) {
    const names = new Map(teamRows.map((t) => [t.id, t.name]));
    const lead = cached[0];
    return cached.map((c) => {
      const gp = c.wins + c.losses + c.ties;
      return {
        teamId: c.teamId,
        name: names.get(c.teamId) ?? "Unknown team",
        wins: c.wins,
        losses: c.losses,
        ties: c.ties,
        gamesPlayed: gp,
        winPct: gp ? (c.wins + c.ties / 2) / gp : 0,
        pointsFor: c.pointsFor,
        pointsAgainst: c.pointsAgainst,
        streak: c.streak,
        rank: c.rank,
        gamesBack: (lead.wins - lead.losses - (c.wins - c.losses)) / 2,
      };
    });
  }
  return computeStandings(teamRows, await loadFinalMatchups(db, leagueId));
}

// ------------------------------------------------------------------------------------ scoreboard

export type ScoreboardEntry = {
  matchup: Matchup;
  totals: MatchupTotals;
};

/** Every matchup of a period with (freshly cached) totals. */
export async function getPeriodScoreboard(db: Db, periodId: string, now = new Date()): Promise<ScoreboardEntry[]> {
  const rows = await db.select().from(matchups).where(eq(matchups.periodId, periodId));
  const entries = await Promise.all(
    rows
      .filter((m) => m.homeTeamId)
      .map(async (m) => ({ matchup: m, totals: await getMatchupTotals(db, m.id, now) })),
  );
  // Re-read so status/winner reflect any live update done while computing.
  const fresh = new Map((await db.select().from(matchups).where(eq(matchups.periodId, periodId))).map((m) => [m.id, m]));
  return entries.map((e) => ({ ...e, matchup: fresh.get(e.matchup.id) ?? e.matchup }));
}
