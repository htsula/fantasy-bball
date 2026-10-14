/** Fantasy projections: pure math lives in projection-math.ts; this adds the DB query helpers. */
import { eq, inArray, sql } from "drizzle-orm";
import { nbaPlayers } from "@/db/schema";
import type { Db } from "@/db/types";
import { etWeekRange } from "@/lib/nba/dates";
import type { PointValues } from "./points";
import { blendProjection, perGame, projectTotal } from "./projection-math";
import { DEFAULT_TEAM_WIN_BONUS } from "./settings";
import { expectedWinBonusSql, playerAggregates, statsSeason } from "./stats-query";

export * from "./projection-math";

export type PlayerProjection = {
  playerId: number;
  /** Games played (DNPs excluded). */
  seasonGames: number;
  /** Fantasy points per game INCLUDING the (approximate, see stats-query.ts) win bonus. */
  seasonAvg: number | null;
  recentGames: number;
  /** Last-15-days average, win bonus included. */
  recentAvg: number | null;
  /** Blended projection from box-score stats only (no bonus). */
  statProjection: number | null;
  /** Expected win bonus per game: teamWin x team win% (0 when currently Out or without a team). */
  winBonusPerGame: number;
  /** Projected fantasy points per game: statProjection + winBonusPerGame. */
  projection: number | null;
};

/**
 * Season/last-15-day averages and the blended projection per player. Averages are per game the
 * player scored in (played, or a bonus-eligible DNP) and include the win bonus; the projection
 * adds the expected bonus on top of the stat-only blend (so the bonus isn't double counted).
 */
export async function loadProjections(
  db: Db,
  opts: { now?: Date; playerIds?: number[]; season?: number; teamWin?: number; points?: PointValues } = {},
): Promise<Map<number, PlayerProjection>> {
  const now = opts.now ?? new Date();
  const season = opts.season ?? (await statsSeason(db));
  const out = new Map<number, PlayerProjection>();
  if (season === null) return out;
  const teamWin = opts.teamWin ?? DEFAULT_TEAM_WIN_BONUS;
  const agg = playerAggregates(db, { season, since: null, now, teamWin, points: opts.points });
  const rows = await db
    .select({
      playerId: agg.playerId,
      seasonGp: agg.seasonGp,
      seasonFp: agg.seasonFp,
      recentGp: agg.recentGp,
      recentFp: agg.recentFp,
      seasonFgp: agg.seasonFgp,
      seasonBonus: agg.seasonBonus,
      recentFgp: agg.recentFgp,
      recentBonus: agg.recentBonus,
      bonusPerGame: expectedWinBonusSql(nbaPlayers.teamId, nbaPlayers.injuryStatus, season, teamWin),
    })
    .from(agg)
    .innerJoin(nbaPlayers, eq(nbaPlayers.id, agg.playerId))
    .where(opts.playerIds ? inArray(agg.playerId, opts.playerIds) : undefined);
  for (const r of rows) {
    const statProjection = blendProjection({
      seasonGames: r.seasonGp,
      seasonFantasyPoints: r.seasonFp,
      recentGames: r.recentGp,
      recentFantasyPoints: r.recentFp,
    });
    const winBonusPerGame = Number(r.bonusPerGame ?? 0);
    out.set(r.playerId, {
      playerId: r.playerId,
      seasonGames: r.seasonGp,
      seasonAvg: perGame(r.seasonFp + r.seasonBonus, r.seasonFgp),
      recentGames: r.recentGp,
      recentAvg: perGame(r.recentFp + r.recentBonus, r.recentFgp),
      statProjection,
      winBonusPerGame,
      projection: statProjection === null ? null : statProjection + winBonusPerGame,
    });
  }
  return out;
}

export type GamesRemaining = { week: number; season: number };

/**
 * Per team: games not yet final this fantasy week (Mon-Sun ET, any game type) and for the rest
 * of the season (regular season + playoffs only). Teams with none are omitted.
 */
export async function loadGamesRemaining(db: Db, now = new Date()): Promise<Map<number, GamesRemaining>> {
  const { end } = etWeekRange(now);
  const res = (await db.execute(sql`
    select team_id as "teamId",
           (count(*) filter (where start_time < ${end.toISOString()}::timestamptz))::int as week,
           (count(*) filter (where season_type in (2, 3)))::int as season
    from (
      select home_team_id as team_id, start_time, season_type from nba_games
        where status in ('scheduled', 'in') and start_time >= ${new Date(now.getTime() - 4 * 3_600_000).toISOString()}::timestamptz
      union all
      select away_team_id, start_time, season_type from nba_games
        where status in ('scheduled', 'in') and start_time >= ${new Date(now.getTime() - 4 * 3_600_000).toISOString()}::timestamptz
    ) g
    group by team_id
  `)) as unknown as { rows: { teamId: number; week: number; season: number }[] };
  return new Map(res.rows.map((r) => [Number(r.teamId), { week: Number(r.week), season: Number(r.season) }]));
}

/** Convenience: projected totals for a week/season given a per-game projection. */
export function projectedTotals(projection: number | null, remaining: GamesRemaining | undefined) {
  return {
    week: projectTotal(projection, remaining?.week ?? 0),
    season: projectTotal(projection, remaining?.season ?? 0),
  };
}

export async function playerTeamId(db: Db, playerId: number): Promise<number | null> {
  const [row] = await db.select({ teamId: nbaPlayers.teamId }).from(nbaPlayers).where(eq(nbaPlayers.id, playerId));
  return row?.teamId ?? null;
}
