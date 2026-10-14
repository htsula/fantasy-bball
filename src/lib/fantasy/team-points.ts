/**
 * Fantasy points per fantasy team, per game / day / player. This is what matchups (M6) use.
 *
 * Ownership rule: a game's points belong to the fantasy team that rostered the player AT THAT
 * GAME'S TIP-OFF, i.e. roster_entries.acquired_at <= game.start_time < coalesce(released_at, inf).
 * A game contributes when the player has a stat row (live or final) and/or is in the game's
 * tip-off snapshot (so non-playing players still earn the win bonus). The scoring itself lives in
 * scoring.ts; this module only gathers the facts.
 *
 * Statuses: stats count as soon as a game is in progress; the win bonus needs a final game.
 *
 * Performance: driven by the team's roster entries (index roster_entries_team_idx), games in the
 * date window (nba_games_start_time_idx) and primary-key lookups into snapshots and stats.
 */
import { and, asc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { gameRosterSnapshots as snap, leagues, nbaGames as g, playerGameStats as st, rosterEntries as re, teams } from "@/db/schema";
import type { Db } from "@/db/types";
import { addDays, etDateString, etStartOfDay } from "@/lib/nba/dates";
import { parseStoredSettings, type ScoringValues } from "./settings";
import { gameFantasyPoints } from "./scoring";

export type TeamGamePoints = {
  gameId: number;
  /** ET calendar date of the tip-off. */
  date: string;
  startTime: Date;
  gameStatus: "in" | "final";
  playerId: number;
  nbaTeamId: number;
  /** Player has a box-score row for the game (live or final). */
  hasStats: boolean;
  inSnapshot: boolean;
  lateSnapshot: boolean;
  injuryStatus: string | null;
  teamWon: boolean;
  statPoints: number;
  winBonus: number;
  total: number;
};

export type DateWindow = {
  /** ET dates, inclusive. Omit either end for an open range. */
  from?: string | null;
  to?: string | null;
};

export async function scoringForTeam(db: Db, teamId: string): Promise<ScoringValues> {
  const [row] = await db
    .select({ settings: leagues.settings })
    .from(teams)
    .innerJoin(leagues, eq(leagues.id, teams.leagueId))
    .where(eq(teams.id, teamId));
  return parseStoredSettings(row?.settings).scoring;
}

/** One row per (game, player) the team owned at tip-off that produced stats and/or a snapshot. */
export async function teamGamePoints(
  db: Db,
  teamId: string,
  window: DateWindow = {},
  opts: { scoring?: ScoringValues } = {},
): Promise<TeamGamePoints[]> {
  const scoring = opts.scoring ?? (await scoringForTeam(db, teamId));
  const rows = await db
    .select({
      gameId: g.id,
      startTime: g.startTime,
      gameStatus: g.status,
      homeTeamId: g.homeTeamId,
      awayTeamId: g.awayTeamId,
      homeScore: g.homeScore,
      awayScore: g.awayScore,
      playerId: re.playerId,
      snapTeamId: snap.nbaTeamId,
      snapPlayerId: snap.playerId,
      late: snap.late,
      injuryStatus: snap.injuryStatus,
      stat: st,
    })
    .from(re)
    .innerJoin(
      g,
      and(
        inArray(g.status, ["in", "final"]),
        sql`${re.acquiredAt} <= ${g.startTime}`,
        or(sql`${re.releasedAt} is null`, sql`${re.releasedAt} > ${g.startTime}`),
      ),
    )
    .leftJoin(snap, and(eq(snap.gameId, g.id), eq(snap.playerId, re.playerId)))
    .leftJoin(st, and(eq(st.gameId, g.id), eq(st.playerId, re.playerId)))
    .where(
      and(
        eq(re.teamId, teamId),
        window.from ? gte(g.startTime, etStartOfDay(window.from)) : undefined,
        window.to ? lt(g.startTime, etStartOfDay(addDays(window.to, 1))) : undefined,
        or(sql`${snap.playerId} is not null`, sql`${st.id} is not null`),
      ),
    )
    .orderBy(asc(g.startTime), asc(g.id), asc(re.playerId));

  return rows.map((r): TeamGamePoints => {
    const nbaTeamId = r.snapPlayerId !== null ? r.snapTeamId! : r.stat!.teamId;
    const side = nbaTeamId === r.homeTeamId ? "home" : "away";
    const final = r.gameStatus === "final" && r.homeScore !== null && r.awayScore !== null;
    const teamWon = final && (side === "home" ? r.homeScore! > r.awayScore! : r.awayScore! > r.homeScore!);
    const score = gameFantasyPoints(
      { stats: r.stat && !r.stat.dnp ? r.stat : null, teamWon, inSnapshot: r.snapPlayerId !== null, injuryStatus: r.injuryStatus },
      scoring,
    );
    return {
      gameId: r.gameId,
      date: etDateString(r.startTime),
      startTime: r.startTime,
      gameStatus: r.gameStatus as "in" | "final",
      playerId: r.playerId,
      nbaTeamId,
      hasStats: r.stat !== null,
      inSnapshot: r.snapPlayerId !== null,
      lateSnapshot: r.late ?? false,
      injuryStatus: r.injuryStatus,
      teamWon,
      ...score,
    };
  });
}

export type TeamDayPoints = { date: string; games: number; statPoints: number; winBonus: number; total: number };

/** Team totals per ET day (days without any scoring rows are omitted), ascending. */
export async function teamPointsByDay(
  db: Db,
  teamId: string,
  from?: string | null,
  to?: string | null,
  opts: { scoring?: ScoringValues } = {},
): Promise<TeamDayPoints[]> {
  const rows = await teamGamePoints(db, teamId, { from, to }, opts);
  const days = new Map<string, TeamDayPoints & { gameIds: Set<number> }>();
  for (const r of rows) {
    const d = days.get(r.date) ?? { date: r.date, games: 0, statPoints: 0, winBonus: 0, total: 0, gameIds: new Set<number>() };
    d.gameIds.add(r.gameId);
    d.statPoints += r.statPoints;
    d.winBonus += r.winBonus;
    d.total += r.total;
    d.games = d.gameIds.size;
    days.set(r.date, d);
  }
  return [...days.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ date: d.date, games: d.games, statPoints: d.statPoints, winBonus: d.winBonus, total: d.total }));
}

export type PlayerTeamPoints = {
  playerId: number;
  /** Games that scored for this team (a stat row and/or the snapshot). */
  games: number;
  statPoints: number;
  winBonus: number;
  total: number;
};

/** What each player has earned for this team in the window (only for games he scored for it). */
export async function playerPointsForTeam(
  db: Db,
  teamId: string,
  from?: string | null,
  to?: string | null,
  opts: { scoring?: ScoringValues } = {},
): Promise<Map<number, PlayerTeamPoints>> {
  const rows = await teamGamePoints(db, teamId, { from, to }, opts);
  const out = new Map<number, PlayerTeamPoints>();
  for (const r of rows) {
    const p = out.get(r.playerId) ?? { playerId: r.playerId, games: 0, statPoints: 0, winBonus: 0, total: 0 };
    p.games += 1;
    p.statPoints += r.statPoints;
    p.winBonus += r.winBonus;
    p.total += r.total;
    out.set(r.playerId, p);
  }
  return out;
}

export function sumPoints(rows: Iterable<{ statPoints: number; winBonus: number; total: number }>) {
  const t = { statPoints: 0, winBonus: 0, total: 0 };
  for (const r of rows) {
    t.statPoints += r.statPoints;
    t.winBonus += r.winBonus;
    t.total += r.total;
  }
  return t;
}
