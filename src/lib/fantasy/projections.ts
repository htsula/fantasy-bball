/** Fantasy projections: pure math lives in projection-math.ts; this adds the DB query helpers. */
import { eq, inArray, sql } from "drizzle-orm";
import { nbaPlayers } from "@/db/schema";
import type { Db } from "@/db/types";
import { etWeekRange } from "@/lib/nba/dates";
import { blendProjection, perGame, projectTotal } from "./projection-math";
import { playerAggregates, statsSeason } from "./stats-query";

export * from "./projection-math";

export type PlayerProjection = {
  playerId: number;
  seasonGames: number;
  seasonAvg: number | null;
  recentGames: number;
  recentAvg: number | null;
  /** Projected fantasy points per game. */
  projection: number | null;
};

/** Season/last-15-day averages and the blended projection per player (DNPs excluded). */
export async function loadProjections(
  db: Db,
  opts: { now?: Date; playerIds?: number[]; season?: number } = {},
): Promise<Map<number, PlayerProjection>> {
  const now = opts.now ?? new Date();
  const season = opts.season ?? (await statsSeason(db));
  const out = new Map<number, PlayerProjection>();
  if (season === null) return out;
  const agg = playerAggregates(db, { season, since: null, now });
  const rows = await db
    .select({
      playerId: agg.playerId,
      seasonGp: agg.seasonGp,
      seasonFp: agg.seasonFp,
      recentGp: agg.recentGp,
      recentFp: agg.recentFp,
    })
    .from(agg)
    .where(opts.playerIds ? inArray(agg.playerId, opts.playerIds) : undefined);
  for (const r of rows) {
    out.set(r.playerId, {
      playerId: r.playerId,
      seasonGames: r.seasonGp,
      seasonAvg: perGame(r.seasonFp, r.seasonGp),
      recentGames: r.recentGp,
      recentAvg: perGame(r.recentFp, r.recentGp),
      projection: blendProjection({
        seasonGames: r.seasonGp,
        seasonFantasyPoints: r.seasonFp,
        recentGames: r.recentGp,
        recentFantasyPoints: r.recentFp,
      }),
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
