/** SQL aggregation of player_game_stats (DNPs excluded) shared by the players table, cards and projections. */
import { and, desc, eq, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { nbaGames, playerGameStats as s } from "@/db/schema";
import type { Db } from "@/db/types";
import { MIN_RECENT_GAMES, RECENT_DAYS } from "./projection-math";
import type { PointValues } from "./points";
import { DEFAULT_TEAM_WIN_BONUS } from "./settings";
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

/** Calendar guess of the NBA season (ESPN end year) for a date: July onwards belongs to the next season. */
export function calendarSeason(now: Date): number {
  return now.getUTCMonth() >= 6 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
}

/**
 * The current season (ESPN end year, 2027 = 2026-27): the newest regular-season schedule we hold,
 * but never behind the calendar, so in the offseason/preseason it is the upcoming season even when
 * its schedule has not been synced yet.
 */
export async function currentSeason(db: Db, now: Date = new Date()): Promise<number> {
  const [row] = await db
    .select({ season: sql<number | null>`max(${nbaGames.season})`.mapWith((v) => (v === null ? null : Number(v))) })
    .from(nbaGames)
    .where(eq(nbaGames.seasonType, 2));
  return Math.max(calendarSeason(now), row?.season ?? 0);
}

export const previousSeason = (current: number): number => current - 1;

/** Seasons (newest first) that have at least one final regular-season game. */
export async function seasonsWithData(db: Db): Promise<number[]> {
  const rows = await db
    .selectDistinct({ season: nbaGames.season })
    .from(nbaGames)
    .where(and(eq(nbaGames.seasonType, 2), eq(nbaGames.status, "final")))
    .orderBy(desc(nbaGames.season));
  return rows.map((r) => r.season);
}

export type SeasonChoice = {
  current: number;
  previous: number;
  /** Seasons that can be shown (have data), newest first: current, previous, else the latest one held. */
  options: number[];
  /** The season shown when none is requested: current if it has a final game, else previous, else the latest. */
  default: number | null;
  /** The season to show for a requested value (falls back to the default when not offered). */
  selected: number | null;
};

export async function resolveSeason(db: Db, now: Date = new Date(), requested?: number | null): Promise<SeasonChoice> {
  const [current, have] = await Promise.all([currentSeason(db, now), seasonsWithData(db)]);
  const previous = previousSeason(current);
  const options = [current, previous].filter((s) => have.includes(s));
  if (options.length === 0 && have.length > 0) options.push(have[0]); // stale data only: show the latest we have
  const def = options[0] ?? null;
  const selected = requested != null && options.includes(requested) ? requested : def;
  return { current, previous, options, default: def, selected };
}

export type AggregateOptions = {
  season: number;
  /** Only games starting at/after this instant count toward the range columns (null = whole season). */
  since: Date | null;
  now: Date;
  /** Restrict to one player (player card). */
  playerId?: number;
  /** Team-win bonus value used for the historical bonus columns (default +4). */
  teamWin?: number;
  /** Per-stat scoring values (league scoring); default scoring when omitted. */
  points?: PointValues;
};


/**
 * Historical win-bonus approximation. Tip-off snapshots only exist from milestone 5 on, so for
 * past games a player counts as bonus-eligible when he has a box-score row (he was on the team
 * sheet) and was not a DNP whose reason mentions an injury or illness (the closest proxy for
 * "listed Out"). A coach's decision, G-League assignment or suspension still earns it, as in the
 * real rules. The game must be final and the player's team must have won.
 */
const INJURY_REASON = "\\m(injur|ill|sick|sore|sprain|strain|surgery|concussion|health|rest|knee|ankle|hamstring|achilles|back|foot|calf|quad|shoulder|wrist|hip|groin|thigh|rib|elbow|finger|toe|hand|neck|eye|covid)";
export function bonusEligibleSql(): SQL<boolean> {
  return sql<boolean>`(not ${s.dnp} or coalesce(${s.dnpReason}, '') !~* ${INJURY_REASON})`;
}
export function teamWonSql(): SQL<boolean> {
  return sql<boolean>`(${nbaGames.status} = 'final' and ((${s.teamId} = ${nbaGames.homeTeamId} and ${nbaGames.homeScore} > ${nbaGames.awayScore}) or (${s.teamId} = ${nbaGames.awayTeamId} and ${nbaGames.awayScore} > ${nbaGames.homeScore})))`;
}

/** Fraction of a team's final regular-season games won in `season` (null with no games). */
export function teamWinPctSql(teamIdCol: SQL | AnyColumn, season: number): SQL<number | null> {
  return sql<number | null>`(select (count(*) filter (where (g.home_team_id = ${teamIdCol} and g.home_score > g.away_score) or (g.away_team_id = ${teamIdCol} and g.away_score > g.home_score)))::float8 / nullif(count(*), 0) from nba_games g where g.season = ${season} and g.season_type = 2 and g.status = 'final' and (g.home_team_id = ${teamIdCol} or g.away_team_id = ${teamIdCol}))`;
}

/**
 * Expected win bonus per game for a player: teamWin x his team's win% (0.5 with no games yet),
 * or 0 when he has no NBA team or is currently Out.
 */
export function expectedWinBonusSql(
  teamIdCol: SQL | AnyColumn,
  injuryCol: SQL | AnyColumn,
  season: number,
  teamWin = DEFAULT_TEAM_WIN_BONUS,
): SQL<number> {
  return sql<number>`(case when ${teamIdCol} is null or coalesce(${injuryCol}, '') ~* '^out\\y' then 0 else coalesce(${teamWinPctSql(teamIdCol, season)}, 0.5) * ${sql.raw(String(Number(teamWin)))} end)`;
}

const num = (e: SQL) => e.mapWith((v) => (v === null || v === undefined ? 0 : Number(v)));

/** Subquery: one row per player with range totals plus season / last-15-day fantasy aggregates. */
export function playerAggregates(db: Db, o: AggregateOptions) {
  const played = sql`not ${s.dnp}`;
  const inRange = o.since ? sql`${played} and ${nbaGames.startTime} >= ${o.since.toISOString()}::timestamptz` : played;
  const recentSince = new Date(o.now.getTime() - RECENT_DAYS * 86_400_000);
  const recent = sql`${played} and ${nbaGames.startTime} >= ${recentSince.toISOString()}::timestamptz`;
  const fp = fantasyPointsSql(o.points);
  const bonusValue = sql.raw(String(Number(o.teamWin ?? DEFAULT_TEAM_WIN_BONUS)));
  const eligible = bonusEligibleSql();
  const fantasyRow = sql`(${played} or ${eligible})`;
  const bonusRow = sql`(case when ${teamWonSql()} and ${eligible} then ${bonusValue} else 0 end)`;
  const fantasyIn = o.since ? sql`${fantasyRow} and ${nbaGames.startTime} >= ${o.since.toISOString()}::timestamptz` : fantasyRow;
  const fantasyRecent = sql`${fantasyRow} and ${nbaGames.startTime} >= ${recentSince.toISOString()}::timestamptz`;
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
      // Win-bonus-inclusive extras: games the player scored in (played, or bonus-eligible DNP) and
      // the approximate bonus points earned in them.
      fgp: num(sql`count(*) filter (where ${fantasyIn})`).as("fgp"),
      bonus: num(sql`sum(${bonusRow}) filter (where ${fantasyIn})`).as("t_bonus"),
      seasonFgp: num(sql`count(*) filter (where ${fantasyRow})`).as("season_fgp"),
      seasonBonus: num(sql`sum(${bonusRow}) filter (where ${fantasyRow})`).as("season_bonus"),
      recentFgp: num(sql`count(*) filter (where ${fantasyRecent})`).as("recent_fgp"),
      recentBonus: num(sql`sum(${bonusRow}) filter (where ${fantasyRecent})`).as("recent_bonus"),
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

/**
 * SQL twin of blendProjection plus the expected win bonus per game (see expectedWinBonusSql).
 * Used for sorting/display in the players table.
 */
export function projectionSql(agg: PlayerAggregates, winBonus: SQL<number> | number = 0): SQL<number | null> {
  const bonus = typeof winBonus === "number" ? sql.raw(String(winBonus)) : winBonus;
  return sql<number | null>`case
    when ${agg.seasonGp} is null or ${agg.seasonGp} = 0 then null
    when ${agg.recentGp} >= ${MIN_RECENT_GAMES}
      then 0.6 * (${agg.recentFp}::float8 / ${agg.recentGp}) + 0.4 * (${agg.seasonFp}::float8 / ${agg.seasonGp}) + ${bonus}
    else ${agg.seasonFp}::float8 / ${agg.seasonGp} + ${bonus}
  end`;
}

export type SeasonFantasyRow = {
  playerId: number;
  season: number;
  /** Games played (DNPs excluded). */
  gp: number;
  /** Games he scored in: played, or a bonus-eligible DNP. */
  fgp: number;
  minutes: number;
  /** Stat points only. */
  statFp: number;
  /** Approximate team-win bonus points (see bonusEligibleSql). */
  bonusFp: number;
  /** Stat points + win bonus. */
  totalFp: number;
  /** totalFp per game he scored in. */
  fpAvg: number | null;
};

/**
 * Per player and regular season fantasy totals in ONE aggregation. Totals include the approximated
 * win bonus; FP/G divides by games he scored in. Uses league scoring when given.
 */
export async function loadSeasonFantasy(
  db: Db,
  o: { seasons?: number[]; playerIds?: number[]; points?: PointValues; teamWin?: number } = {},
): Promise<SeasonFantasyRow[]> {
  if ((o.seasons && o.seasons.length === 0) || (o.playerIds && o.playerIds.length === 0)) return [];
  const played = sql`not ${s.dnp}`;
  const eligible = bonusEligibleSql();
  const fantasyRow = sql`(${played} or ${eligible})`;
  const bonusValue = sql.raw(String(Number(o.teamWin ?? DEFAULT_TEAM_WIN_BONUS)));
  const bonusRow = sql`(case when ${teamWonSql()} and ${eligible} then ${bonusValue} else 0 end)`;
  // coalesce: drizzle skips the mapWith decoder for NULLs, so default empty sums to 0 in SQL.
  const rows = await db
    .select({
      playerId: s.playerId,
      season: nbaGames.season,
      gp: num(sql`count(*) filter (where ${played})`),
      fgp: num(sql`count(*) filter (where ${fantasyRow})`),
      minutes: num(sql`coalesce(sum(${s.minutes}) filter (where ${played}), 0)`),
      statFp: num(sql`coalesce(sum(${fantasyPointsSql(o.points)}) filter (where ${played}), 0)`),
      bonusFp: num(sql`coalesce(sum(${bonusRow}) filter (where ${fantasyRow}), 0)`),
    })
    .from(s)
    .innerJoin(nbaGames, eq(nbaGames.id, s.gameId))
    .where(
      and(
        eq(nbaGames.seasonType, 2),
        o.seasons ? inArray(nbaGames.season, o.seasons) : undefined,
        o.playerIds ? inArray(s.playerId, o.playerIds) : undefined,
      ),
    )
    .groupBy(s.playerId, nbaGames.season);
  return rows.map((r) => {
    const totalFp = r.statFp + r.bonusFp;
    return { ...r, totalFp, fpAvg: r.fgp > 0 ? totalFp / r.fgp : null };
  });
}
