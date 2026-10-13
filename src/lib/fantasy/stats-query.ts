/** SQL aggregation of player_game_stats (DNPs excluded) shared by the players table, cards and projections. */
import { and, eq, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { nbaGames, playerGameStats as s } from "@/db/schema";
import type { Db } from "@/db/types";
import { MIN_RECENT_GAMES, RECENT_DAYS } from "./projection-math";
import { fantasyPointsSql } from "./sql";

/**
 * The "stats season": season of the latest final regular-season game we hold. Before opening
 * night this is last season, so the Players page is useful for draft prep.
 */
export async function statsSeason(db: Db): Promise<number | null> {
  const [row] = await db
    .select({ season: sql<number | null>`max(${nbaGames.season})`.mapWith((v) => (v === null ? null : Number(v))) })
    .from(nbaGames)
    .where(and(eq(nbaGames.seasonType, 2), eq(nbaGames.status, "final")));
  return row?.season ?? null;
}

export type AggregateOptions = {
  season: number;
  /** Only games starting at/after this instant count toward the range columns (null = whole season). */
  since: Date | null;
  now: Date;
  /** Restrict to one player (player card). */
  playerId?: number;
};

const num = (e: SQL) => e.mapWith((v) => (v === null || v === undefined ? 0 : Number(v)));

/** Subquery: one row per player with range totals plus season / last-15-day fantasy aggregates. */
export function playerAggregates(db: Db, o: AggregateOptions) {
  const played = sql`not ${s.dnp}`;
  const inRange = o.since ? sql`${played} and ${nbaGames.startTime} >= ${o.since.toISOString()}::timestamptz` : played;
  const recentSince = new Date(o.now.getTime() - RECENT_DAYS * 86_400_000);
  const recent = sql`${played} and ${nbaGames.startTime} >= ${recentSince.toISOString()}::timestamptz`;
  const fp = fantasyPointsSql();
  const sumIn = (col: SQL | AnyColumn) => num(sql`sum(${col}) filter (where ${inRange})`);

  return db
    .select({
      playerId: s.playerId,
      gp: num(sql`count(*) filter (where ${inRange})`).as("gp"),
      min: sumIn(s.minutes).as("t_min"),
      pts: sumIn(s.pts).as("t_pts"),
      reb: sumIn(s.reb).as("t_reb"),
      ast: sumIn(s.ast).as("t_ast"),
      stl: sumIn(s.stl).as("t_stl"),
      blk: sumIn(s.blk).as("t_blk"),
      to: sumIn(s.to).as("t_to"),
      tpm: sumIn(s.tpm).as("t_tpm"),
      fgm: sumIn(s.fgm).as("t_fgm"),
      fga: sumIn(s.fga).as("t_fga"),
      ftm: sumIn(s.ftm).as("t_ftm"),
      fta: sumIn(s.fta).as("t_fta"),
      fpTotal: sumIn(fp).as("t_fp"),
      seasonGp: num(sql`count(*) filter (where ${played})`).as("season_gp"),
      seasonFp: num(sql`sum(${fp}) filter (where ${played})`).as("season_fp"),
      recentGp: num(sql`count(*) filter (where ${recent})`).as("recent_gp"),
      recentFp: num(sql`sum(${fp}) filter (where ${recent})`).as("recent_fp"),
    })
    .from(s)
    .innerJoin(nbaGames, eq(nbaGames.id, s.gameId))
    .where(
      and(
        eq(nbaGames.season, o.season),
        eq(nbaGames.seasonType, 2),
        o.playerId !== undefined ? eq(s.playerId, o.playerId) : undefined,
      ),
    )
    .groupBy(s.playerId)
    .as("agg");
}

export type PlayerAggregates = ReturnType<typeof playerAggregates>;

/** SQL twin of blendProjection (used for sorting/display in the players table). */
export function projectionSql(agg: PlayerAggregates): SQL<number | null> {
  return sql<number | null>`case
    when ${agg.seasonGp} is null or ${agg.seasonGp} = 0 then null
    when ${agg.recentGp} >= ${MIN_RECENT_GAMES}
      then 0.6 * (${agg.recentFp}::float8 / ${agg.recentGp}) + 0.4 * (${agg.seasonFp}::float8 / ${agg.seasonGp})
    else ${agg.seasonFp}::float8 / ${agg.seasonGp}
  end`;
}
