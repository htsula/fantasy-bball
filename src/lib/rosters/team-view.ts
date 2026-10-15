/** Read model for the My Team page: roster grouped by NBA team with stats, today's game and points. */
import { and, asc, desc, eq, gte, isNull, lt, ne, sql } from "drizzle-orm";
import { leagues, nbaGames, nbaPlayers, nbaTeams, rosterEntries, teams } from "@/db/schema";
import type { Db } from "@/db/types";
import { loadProjections } from "@/lib/fantasy/projections";
import { parseStoredSettings } from "@/lib/fantasy/settings";
import { loadSeasonFantasy, seasonChoiceFor, type SeasonChoice } from "@/lib/fantasy/stats-query";
import { playerPointsForTeam, sumPoints } from "@/lib/fantasy/team-points";
import { addDays, etDateString, etDayRange, etWeekRange } from "@/lib/nba/dates";
import { leagueMaxRoster } from "./service";

export const TEAM_RANGES = ["season", "7", "15", "30"] as const;
export type TeamRange = (typeof TEAM_RANGES)[number];

export type TodayGame = {
  gameId: number;
  opponent: string;
  home: boolean;
  startTime: Date;
  status: "scheduled" | "in" | "final" | "postponed";
  statusDetail: string | null;
  teamScore: number | null;
  opponentScore: number | null;
};

export type RosterRow = {
  playerId: number;
  name: string;
  positions: string[];
  injuryStatus: string | null;
  injuryDetail: string | null;
  /** FP per game and total in the selected stats season, league scoring and win bonus included. */
  fpAvg: number | null;
  fpTotal: number | null;
  recentAvg: number | null;
  projection: number | null;
  /** What he earned for THIS fantasy team in the selected range. */
  games: number;
  totalFp: number;
  winBonusFp: number;
  todayGame: TodayGame | null;
};

export type NbaGroup = {
  nbaTeamId: number | null;
  abbrev: string;
  name: string;
  record: string | null;
  gamesThisWeek: number;
  rows: RosterRow[];
};

export type TeamRosterView = {
  /** Selected stats season and the seasons on offer (see seasonChoiceFor). */
  seasons: SeasonChoice;
  range: TeamRange;
  count: number;
  max: number;
  groups: NbaGroup[];
  totals: { statPoints: number; winBonus: number; total: number };
};

type RowsResult = { rows: Record<string, unknown>[] };

const inList = (ids: number[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `);

export function rangeFromDate(range: TeamRange, now: Date): string | null {
  return range === "season" ? null : addDays(etDateString(now), -(Number(range) - 1));
}

export async function loadTeamRoster(
  db: Db,
  input: { leagueId: string; teamId: string; range?: TeamRange; now?: Date; season?: number | null },
): Promise<TeamRosterView> {
  const now = input.now ?? new Date();
  const [league] = await db.select().from(leagues).where(eq(leagues.id, input.leagueId));
  const [team] = await db.select().from(teams).where(and(eq(teams.id, input.teamId), eq(teams.leagueId, input.leagueId)));
  if (!league || !team) throw new Error("team not found");
  const settings = parseStoredSettings(league.settings);
  const seasons = await seasonChoiceFor(db, league.season, now, input.season);
  // 7/15/30-day ranges look back from today, so they only apply to the current season.
  const range = seasons.selected === seasons.current ? (input.range ?? "season") : "season";

  const entries = await db
    .select({
      playerId: nbaPlayers.id,
      name: nbaPlayers.fullName,
      positions: nbaPlayers.positions,
      injuryStatus: nbaPlayers.injuryStatus,
      injuryDetail: nbaPlayers.injuryDetail,
      nbaTeamId: nbaPlayers.teamId,
    })
    .from(rosterEntries)
    .innerJoin(nbaPlayers, eq(nbaPlayers.id, rosterEntries.playerId))
    .where(and(eq(rosterEntries.teamId, team.id), isNull(rosterEntries.releasedAt)))
    .orderBy(asc(nbaPlayers.fullName));

  const playerIds = entries.map((e) => e.playerId);
  const nbaTeamIds = [...new Set(entries.map((e) => e.nbaTeamId).filter((t): t is number => t !== null))];
  const today = etDateString(now);
  const from = rangeFromDate(range, now);

  const [max, projections, seasonRows, points, nbaTeamRows] = await Promise.all([
    leagueMaxRoster(db, league),
    playerIds.length ? loadProjections(db, { playerIds, now, teamWin: settings.scoring.teamWin, points: settings.scoring }) : new Map(),
    playerIds.length
      ? loadSeasonFantasy(db, { seasons: [seasons.selected], playerIds, points: settings.scoring, teamWin: settings.scoring.teamWin })
      : [],
    playerPointsForTeam(db, team.id, from, today),
    nbaTeamIds.length ? db.select().from(nbaTeams) : Promise.resolve([]),
  ]);
  const nbaTeamById = new Map(nbaTeamRows.map((t) => [t.id, t]));
  const seasonFp = new Map(seasonRows.map((r) => [r.playerId, r]));

  // Records, this week's game counts and today's games for the NBA teams on this roster.
  const records = new Map<number, string>();
  const weekGames = new Map<number, number>();
  const todayGames = new Map<number, TodayGame>();
  if (nbaTeamIds.length) {
    const ids = inList(nbaTeamIds);
    const rec = (await db.execute(sql`
      select team_id as "teamId", (count(*) filter (where won))::int as w, (count(*) filter (where not won))::int as l
      from (
        select home_team_id as team_id, home_score > away_score as won from nba_games
          where season = ${league.season} and season_type = 2 and status = 'final' and home_team_id in (${ids})
        union all
        select away_team_id, away_score > home_score from nba_games
          where season = ${league.season} and season_type = 2 and status = 'final' and away_team_id in (${ids})
      ) g group by team_id
    `)) as unknown as RowsResult;
    for (const r of rec.rows) records.set(Number(r.teamId), `${Number(r.w)}-${Number(r.l)}`);

    const week = etWeekRange(now);
    const weekRows = await db
      .select({ home: nbaGames.homeTeamId, away: nbaGames.awayTeamId })
      .from(nbaGames)
      .where(and(gte(nbaGames.startTime, week.start), lt(nbaGames.startTime, week.end), ne(nbaGames.status, "postponed")));
    for (const g of weekRows) {
      for (const id of [g.home, g.away]) if (nbaTeamIds.includes(id)) weekGames.set(id, (weekGames.get(id) ?? 0) + 1);
    }

    const day = etDayRange(today);
    const dayRows = await db
      .select()
      .from(nbaGames)
      .where(and(gte(nbaGames.startTime, day.start), lt(nbaGames.startTime, day.end), ne(nbaGames.status, "postponed")))
      .orderBy(desc(nbaGames.startTime));
    for (const g of dayRows) {
      for (const [id, oppId, isHome] of [
        [g.homeTeamId, g.awayTeamId, true],
        [g.awayTeamId, g.homeTeamId, false],
      ] as const) {
        if (!nbaTeamIds.includes(id)) continue;
        todayGames.set(id, {
          gameId: g.id,
          opponent: nbaTeamById.get(oppId)?.abbrev ?? "?",
          home: isHome,
          startTime: g.startTime,
          status: g.status,
          statusDetail: g.statusDetail,
          teamScore: isHome ? g.homeScore : g.awayScore,
          opponentScore: isHome ? g.awayScore : g.homeScore,
        });
      }
    }
  }

  const groups = new Map<number | null, NbaGroup>();
  for (const e of entries) {
    const proj = projections.get(e.playerId);
    const pts = points.get(e.playerId);
    const stat = seasonFp.get(e.playerId);
    const nbaTeam = e.nbaTeamId !== null ? nbaTeamById.get(e.nbaTeamId) : undefined;
    const group =
      groups.get(e.nbaTeamId) ??
      ({
        nbaTeamId: e.nbaTeamId,
        abbrev: nbaTeam?.abbrev ?? "FA",
        name: nbaTeam ? `${nbaTeam.location} ${nbaTeam.name}` : "No NBA team",
        record: e.nbaTeamId !== null ? (records.get(e.nbaTeamId) ?? "0-0") : null,
        gamesThisWeek: e.nbaTeamId !== null ? (weekGames.get(e.nbaTeamId) ?? 0) : 0,
        rows: [],
      } satisfies NbaGroup);
    group.rows.push({
      playerId: e.playerId,
      name: e.name,
      positions: e.positions,
      injuryStatus: e.injuryStatus,
      injuryDetail: e.injuryDetail,
      fpAvg: stat?.fpAvg ?? null,
      fpTotal: stat && stat.fgp > 0 ? stat.totalFp : null,
      recentAvg: proj?.recentAvg ?? null,
      projection: proj?.projection ?? null,
      games: pts?.games ?? 0,
      totalFp: pts?.total ?? 0,
      winBonusFp: pts?.winBonus ?? 0,
      todayGame: e.nbaTeamId !== null ? (todayGames.get(e.nbaTeamId) ?? null) : null,
    });
    groups.set(e.nbaTeamId, group);
  }
  const list = [...groups.values()].sort((a, b) => a.abbrev.localeCompare(b.abbrev));
  for (const g of list) g.rows.sort((a, b) => (b.fpAvg ?? -1) - (a.fpAvg ?? -1) || a.name.localeCompare(b.name));

  return {
    seasons,
    range,
    count: entries.length,
    max,
    groups: list,
    // Includes points from players since dropped: they were this team's when the games tipped.
    totals: sumPoints(points.values()),
  };
}
