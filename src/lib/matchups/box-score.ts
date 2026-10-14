/**
 * Read model for the matchup page: both teams' players with fantasy points (stat points + win
 * bonus) for one ET day or for the whole period, the day's NBA game and stat line.
 * Everything is JSON-serializable (dates as ISO strings) so the API route can return it as is.
 */
import { and, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { matchups, nbaGames, nbaPlayers, nbaTeams, playerGameStats, rosterEntries, teams } from "@/db/schema";
import type { Db } from "@/db/types";
import { teamGamePoints, type TeamGamePoints } from "@/lib/fantasy/team-points";
import { roundPoints } from "@/lib/fantasy/matchup";
import { addDays, etDateString, etDayRange } from "@/lib/nba/dates";
import { getMatchupTotals, listMatchupAdjustments, loadMatchupContext, type TeamTotals } from "./service";

export type BoxView = "total" | string; // "total" or an ET date inside the period

export type BoxGame = {
  gameId: number;
  opponent: string;
  home: boolean;
  status: "scheduled" | "in" | "final" | "postponed";
  startTime: string;
  teamScore: number | null;
  opponentScore: number | null;
  period: number | null;
  clock: string | null;
  statusDetail: string | null;
};

export type BoxLine = {
  min: number;
  pts: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  to: number;
  tpm: number;
  fgm: number;
  fga: number;
  ftm: number;
  fta: number;
};

export type BoxPlayer = {
  playerId: number;
  name: string;
  positions: string[];
  nbaAbbrev: string;
  injuryStatus: string | null;
  /** Day view only: his NBA team's game that day (null = no game). */
  game: BoxGame | null;
  /** Day view: that game's line. Period view: the sum over the period's games. */
  line: BoxLine | null;
  /** Games that scored for this fantasy team in the selected view. */
  games: number;
  statPoints: number;
  winBonus: number;
  total: number;
  /** Currently on this fantasy team's roster. */
  rostered: boolean;
};

export type BoxTeam = {
  teamId: string;
  name: string;
  abbrev: string;
  totals: Omit<TeamTotals, "computedAt"> & { computedAt: string };
  /** Points in the selected view (equals totals.points in the period view). */
  viewPoints: number;
  viewWinBonus: number;
  /** Commissioner adjustments for the whole period (they count in the period total, not in a single day). */
  adjustments: BoxAdjustment[];
  adjustmentTotal: number;
  players: BoxPlayer[];
};

export type BoxAdjustment = { id: string; points: number; reason: string; actorUsername: string | null; createdAt: string };

export type MatchupBoxScore = {
  matchup: { id: string; status: "scheduled" | "live" | "final"; winnerTeamId: string | null };
  period: { number: number; startDate: string; endDate: string; isPlayoff: boolean; playoffRound: number | null };
  view: BoxView;
  days: string[];
  today: string;
  home: BoxTeam;
  away: BoxTeam | null;
  anyLive: boolean;
  generatedAt: string;
};

const num = (n: number | null | undefined) => n ?? 0;

function emptyLine(): BoxLine {
  return { min: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, to: 0, tpm: 0, fgm: 0, fga: 0, ftm: 0, fta: 0 };
}

export function periodDays(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  for (let d = startDate; d <= endDate && out.length < 60; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Default selection: today when the period is running, else the whole period. */
export function defaultView(period: { startDate: string; endDate: string }, today: string): BoxView {
  return today >= period.startDate && today <= period.endDate ? today : "total";
}

export function parseView(raw: string | null | undefined, period: { startDate: string; endDate: string }, today: string): BoxView {
  if (raw === "total") return "total";
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) && raw >= period.startDate && raw <= period.endDate) return raw;
  return defaultView(period, today);
}

export async function getMatchupBoxScore(
  db: Db,
  matchupId: string,
  view: BoxView | null,
  now = new Date(),
): Promise<MatchupBoxScore> {
  const ctx = await loadMatchupContext(db, matchupId);
  const { matchup, period, settings } = ctx;
  const today = etDateString(now);
  const resolvedView = view === null ? defaultView(period, today) : parseView(view, period, today);
  const totals = await getMatchupTotals(db, matchupId, now);
  const final = matchup.status === "final";

  const adjustmentRows = await listMatchupAdjustments(db, matchupId);
  const teamRows = await db.select().from(teams).where(eq(teams.leagueId, matchup.leagueId));
  const teamById = new Map(teamRows.map((t) => [t.id, t]));
  const nbaTeamRows = await db.select({ id: nbaTeams.id, abbrev: nbaTeams.abbrev }).from(nbaTeams);
  const abbrevOf = new Map(nbaTeamRows.map((t) => [t.id, t.abbrev]));

  // The games of the selected day (all of them: players with no scoring row still show their game).
  const dayGames =
    resolvedView === "total"
      ? []
      : await (async () => {
          const { start, end } = etDayRange(resolvedView);
          return db.select().from(nbaGames).where(and(gte(nbaGames.startTime, start), lt(nbaGames.startTime, end)));
        })();

  async function buildTeam(teamId: string, t: TeamTotals): Promise<BoxTeam> {
    const team = teamById.get(teamId);
    const rows = await teamGamePoints(db, teamId, { from: period.startDate, to: period.endDate }, { scoring: settings.scoring });
    const shown: TeamGamePoints[] = resolvedView === "total" ? rows : rows.filter((r) => r.date === resolvedView);

    const current = final
      ? []
      : await db
          .select({ playerId: rosterEntries.playerId })
          .from(rosterEntries)
          .where(and(eq(rosterEntries.teamId, teamId), isNull(rosterEntries.releasedAt)));
    const currentIds = new Set(current.map((c) => c.playerId));
    const playerIds = [...new Set([...rows.map((r) => r.playerId), ...currentIds])];

    const info = playerIds.length
      ? await db
          .select({
            id: nbaPlayers.id,
            name: nbaPlayers.fullName,
            positions: nbaPlayers.positions,
            teamId: nbaPlayers.teamId,
            injuryStatus: nbaPlayers.injuryStatus,
          })
          .from(nbaPlayers)
          .where(inArray(nbaPlayers.id, playerIds))
      : [];

    const gameIds = [...new Set(shown.map((r) => r.gameId))];
    const stats = gameIds.length
      ? await db
          .select()
          .from(playerGameStats)
          .where(and(inArray(playerGameStats.gameId, gameIds), inArray(playerGameStats.playerId, playerIds)))
      : [];
    const statKey = (g: number, p: number) => `${g}:${p}`;
    const statBy = new Map(stats.map((s) => [statKey(s.gameId, s.playerId), s]));

    const players: BoxPlayer[] = info.map((p) => {
      const mine = shown.filter((r) => r.playerId === p.id);
      const nbaTeamId = mine[mine.length - 1]?.nbaTeamId ?? rows.filter((r) => r.playerId === p.id).pop()?.nbaTeamId ?? p.teamId;
      let game: BoxGame | null = null;
      if (resolvedView !== "total" && nbaTeamId !== null) {
        const g = dayGames.find((x) => x.homeTeamId === nbaTeamId || x.awayTeamId === nbaTeamId);
        if (g) {
          const home = g.homeTeamId === nbaTeamId;
          game = {
            gameId: g.id,
            opponent: abbrevOf.get(home ? g.awayTeamId : g.homeTeamId) ?? "?",
            home,
            status: g.status,
            startTime: g.startTime.toISOString(),
            teamScore: home ? g.homeScore : g.awayScore,
            opponentScore: home ? g.awayScore : g.homeScore,
            period: g.period,
            clock: g.clock,
            statusDetail: g.statusDetail,
          };
        }
      }
      let line: BoxLine | null = null;
      for (const r of mine) {
        const s = statBy.get(statKey(r.gameId, p.id));
        if (!s || s.dnp) continue;
        line ??= emptyLine();
        line.min += num(s.minutes);
        line.pts += s.pts;
        line.reb += s.reb;
        line.ast += s.ast;
        line.stl += s.stl;
        line.blk += s.blk;
        line.to += s.to;
        line.tpm += s.tpm;
        line.fgm += s.fgm;
        line.fga += s.fga;
        line.ftm += s.ftm;
        line.fta += s.fta;
      }
      const statPoints = mine.reduce((a, r) => a + r.statPoints, 0);
      const winBonus = mine.reduce((a, r) => a + r.winBonus, 0);
      return {
        playerId: p.id,
        name: p.name,
        positions: p.positions,
        nbaAbbrev: nbaTeamId !== null ? (abbrevOf.get(nbaTeamId) ?? "-") : "FA",
        injuryStatus: p.injuryStatus,
        game,
        line,
        games: mine.length,
        statPoints: roundPoints(statPoints),
        winBonus: roundPoints(winBonus),
        total: roundPoints(statPoints + winBonus),
        rostered: currentIds.has(p.id),
      };
    });
    players.sort(
      (a, b) =>
        Number(b.game !== null || b.games > 0) - Number(a.game !== null || a.games > 0) ||
        b.total - a.total ||
        a.name.localeCompare(b.name),
    );
    const viewPoints = roundPoints(players.reduce((a, p) => a + p.total, 0));
    const viewWinBonus = roundPoints(players.reduce((a, p) => a + p.winBonus, 0));
    return {
      teamId,
      name: team?.name ?? "Unknown team",
      abbrev: team?.abbrev ?? "?",
      totals: { ...t, computedAt: t.computedAt.toISOString() },
      viewPoints,
      viewWinBonus,
      adjustments: adjustmentRows
        .filter((a) => a.teamId === teamId)
        .map((a) => ({ id: a.id, points: a.points, reason: a.reason, actorUsername: a.actorUsername, createdAt: a.createdAt.toISOString() })),
      adjustmentTotal: roundPoints(adjustmentRows.filter((a) => a.teamId === teamId).reduce((acc, a) => acc + a.points, 0)),
      players,
    };
  }

  const [home, away] = await Promise.all([
    buildTeam(totals.home.teamId, totals.home),
    totals.away ? buildTeam(totals.away.teamId, totals.away) : Promise.resolve(null),
  ]);
  const anyLive = !final && (await anyGameLiveNow(db, period, now));

  // Re-read: totals computation may have moved the matchup to "live".
  const [fresh] = await db
    .select({ status: matchups.status, winnerTeamId: matchups.winnerTeamId })
    .from(matchups)
    .where(eq(matchups.id, matchupId));

  return {
    matchup: { id: matchupId, status: fresh?.status ?? matchup.status, winnerTeamId: fresh?.winnerTeamId ?? matchup.winnerTeamId },
    period: {
      number: period.number,
      startDate: period.startDate,
      endDate: period.endDate,
      isPlayoff: period.isPlayoff,
      playoffRound: period.playoffRound,
    },
    view: resolvedView,
    days: periodDays(period.startDate, period.endDate),
    today,
    home,
    away,
    anyLive,
    generatedAt: now.toISOString(),
  };
}

/** Is any NBA game in progress right now (so the "Period total" view keeps polling)? */
async function anyGameLiveNow(db: Db, period: { startDate: string; endDate: string }, now: Date): Promise<boolean> {
  const today = etDateString(now);
  if (today < period.startDate || today > period.endDate) return false;
  const { start, end } = etDayRange(today);
  const rows = await db
    .select({ id: nbaGames.id })
    .from(nbaGames)
    .where(and(gte(nbaGames.startTime, start), lt(nbaGames.startTime, end), eq(nbaGames.status, "in")))
    .limit(1);
  return rows.length > 0;
}
