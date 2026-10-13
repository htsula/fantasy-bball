/** Read-side queries for the Players table and the player card. */
import { and, asc, desc, eq, gte, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  nbaGames,
  nbaInjuries,
  nbaNews,
  nbaPlayers as p,
  nbaTeams,
  playerGameStats as s,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { fantasyPoints } from "@/lib/fantasy/points";
import { loadGamesRemaining, loadProjections, projectedTotals } from "@/lib/fantasy/projections";
import { playerAggregates, projectionSql, statsSeason } from "@/lib/fantasy/stats-query";
import { FANTASY_POSITIONS } from "./positions";

export const RANGES = ["season", "7", "15", "30"] as const;
export type Range = (typeof RANGES)[number];
export const PAGE_SIZE = 50;

export const SORT_KEYS = [
  "name", "gp", "min", "pts", "reb", "ast", "stl", "blk", "to", "tpm", "fgpct", "ftpct", "fpavg", "proj", "fptotal",
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export type PlayerListParams = {
  q?: string;
  pos?: string;
  team?: number;
  inj?: string;
  healthy?: boolean;
  range?: Range;
  sort?: SortKey;
  dir?: "asc" | "desc";
  page?: number;
  now?: Date;
};

export function rangeSince(range: Range, now: Date): Date | null {
  return range === "season" ? null : new Date(now.getTime() - Number(range) * 86_400_000);
}

const escapeLike = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listPlayers(db: Db, params: PlayerListParams) {
  const now = params.now ?? new Date();
  const range = params.range ?? "season";
  const season = (await statsSeason(db)) ?? 0;
  const agg = playerAggregates(db, { season, since: rangeSince(range, now), now });
  const proj = projectionSql(agg);

  const where: (SQL | undefined)[] = [eq(p.active, true)];
  if (params.q?.trim()) where.push(ilike(p.fullName, `%${escapeLike(params.q.trim())}%`));
  if ((FANTASY_POSITIONS as readonly string[]).includes(params.pos ?? "")) where.push(sql`${params.pos} = any(${p.positions})`);
  if (params.team) where.push(eq(p.teamId, params.team));
  if (params.healthy) where.push(isNull(p.injuryStatus));
  else if (params.inj) where.push(sql`lower(${p.injuryStatus}) = lower(${params.inj})`);
  const cond = and(...where);

  const dir = params.dir === "asc" ? asc : desc;
  const perGame = (total: SQL | typeof agg.pts) => sql`${total}::float8 / nullif(${agg.gp}, 0)`;
  const sortExpr: Record<SortKey, SQL | typeof p.fullName | typeof agg.gp> = {
    name: p.fullName,
    gp: agg.gp,
    min: perGame(agg.min),
    pts: perGame(agg.pts),
    reb: perGame(agg.reb),
    ast: perGame(agg.ast),
    stl: perGame(agg.stl),
    blk: perGame(agg.blk),
    to: perGame(agg.to),
    tpm: perGame(agg.tpm),
    fgpct: sql`${agg.fgm}::float8 / nullif(${agg.fga}, 0)`,
    ftpct: sql`${agg.ftm}::float8 / nullif(${agg.fta}, 0)`,
    fpavg: perGame(agg.fpTotal),
    proj,
    fptotal: agg.fpTotal,
  };
  const sort = params.sort && params.sort in sortExpr ? params.sort : "fptotal";
  const primary = sort === "name" ? (params.dir === "desc" ? desc : asc)(sortExpr.name) : sql`${dir(sortExpr[sort] as SQL)} nulls last`;

  const page = Math.max(1, params.page ?? 1);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: p.id,
        fullName: p.fullName,
        positions: p.positions,
        injuryStatus: p.injuryStatus,
        injuryDetail: p.injuryDetail,
        headshotUrl: p.headshotUrl,
        teamAbbrev: nbaTeams.abbrev,
        gp: agg.gp,
        min: agg.min,
        pts: agg.pts,
        reb: agg.reb,
        ast: agg.ast,
        stl: agg.stl,
        blk: agg.blk,
        to: agg.to,
        tpm: agg.tpm,
        fgm: agg.fgm,
        fga: agg.fga,
        ftm: agg.ftm,
        fta: agg.fta,
        fpTotal: agg.fpTotal,
        proj,
      })
      .from(p)
      .leftJoin(nbaTeams, eq(nbaTeams.id, p.teamId))
      .leftJoin(agg, eq(agg.playerId, p.id))
      .where(cond)
      .orderBy(primary, asc(p.fullName), asc(p.id))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db.select({ total: sql<number>`count(*)::int` }).from(p).where(cond),
  ]);

  return {
    season: season || null,
    page,
    total,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    rows: rows.map((r) => {
      const gp = r.gp ?? 0;
      const avg = (v: number | null) => (gp > 0 && v !== null ? v / gp : null);
      return {
        id: r.id,
        fullName: r.fullName,
        positions: r.positions,
        injuryStatus: r.injuryStatus,
        injuryDetail: r.injuryDetail,
        teamAbbrev: r.teamAbbrev,
        gp,
        min: avg(r.min),
        pts: avg(r.pts),
        reb: avg(r.reb),
        ast: avg(r.ast),
        stl: avg(r.stl),
        blk: avg(r.blk),
        to: avg(r.to),
        tpm: avg(r.tpm),
        fgPct: r.fga ? (r.fgm ?? 0) / r.fga : null,
        ftPct: r.fta ? (r.ftm ?? 0) / r.fta : null,
        fpAvg: avg(r.fpTotal),
        proj: r.proj === null ? null : Number(r.proj),
        fpTotal: gp > 0 ? (r.fpTotal ?? 0) : null,
      };
    }),
  };
}

export async function listFilterOptions(db: Db) {
  const [teams, statuses] = await Promise.all([
    db.select({ id: nbaTeams.id, abbrev: nbaTeams.abbrev, name: nbaTeams.name, location: nbaTeams.location }).from(nbaTeams).orderBy(nbaTeams.abbrev),
    db
      .selectDistinct({ status: p.injuryStatus })
      .from(p)
      .where(sql`${p.injuryStatus} is not null`)
      .orderBy(p.injuryStatus),
  ]);
  return { teams, injuryStatuses: statuses.map((r) => r.status!).filter(Boolean) };
}

// ---------------------------------------------------------------------------------------------

export async function getPlayerCard(db: Db, playerId: number, now = new Date()) {
  const [row] = await db
    .select({ player: p, team: nbaTeams })
    .from(p)
    .leftJoin(nbaTeams, eq(nbaTeams.id, p.teamId))
    .where(eq(p.id, playerId));
  if (!row) return null;
  const { player, team } = row;

  const season = await statsSeason(db);
  const teams = new Map((await db.select().from(nbaTeams)).map((t) => [t.id, t]));

  const [injury] = await db.select().from(nbaInjuries).where(eq(nbaInjuries.playerId, playerId));

  let averages: {
    gp: number; min: number; pts: number; reb: number; ast: number; stl: number; blk: number; to: number; tpm: number;
    fgPct: number | null; ftPct: number | null; fpAvg: number; fpTotal: number;
  } | null = null;
  if (season !== null) {
    const agg = playerAggregates(db, { season, since: null, now, playerId });
    const [a] = await db.select().from(agg);
    if (a && a.gp > 0) {
      averages = {
        gp: a.gp,
        min: a.min / a.gp,
        pts: a.pts / a.gp,
        reb: a.reb / a.gp,
        ast: a.ast / a.gp,
        stl: a.stl / a.gp,
        blk: a.blk / a.gp,
        to: a.to / a.gp,
        tpm: a.tpm / a.gp,
        fgPct: a.fga ? a.fgm / a.fga : null,
        ftPct: a.fta ? a.ftm / a.fta : null,
        fpAvg: a.fpTotal / a.gp,
        fpTotal: a.fpTotal,
      };
    }
  }

  const logRows = await db
    .select({ stat: s, game: nbaGames })
    .from(s)
    .innerJoin(nbaGames, eq(nbaGames.id, s.gameId))
    .where(eq(s.playerId, playerId))
    .orderBy(desc(nbaGames.startTime))
    .limit(30);
  const gameLog = logRows.map(({ stat, game }) => {
    const home = stat.teamId === game.homeTeamId;
    const oppId = home ? game.awayTeamId : game.homeTeamId;
    return {
      gameId: game.id,
      date: game.startTime,
      opponent: teams.get(oppId)?.abbrev ?? "?",
      home,
      result: game.status === "final" && game.homeScore !== null && game.awayScore !== null
        ? `${(home ? game.homeScore > game.awayScore : game.awayScore > game.homeScore) ? "W" : "L"} ${game.homeScore}-${game.awayScore}`
        : null,
      stat,
      fantasyPoints: stat.dnp ? null : fantasyPoints(stat),
    };
  });

  let schedule: { gameId: number; date: Date; opponent: string; home: boolean }[] = [];
  if (player.teamId !== null) {
    const upcoming = await db
      .select()
      .from(nbaGames)
      .where(
        and(
          or(eq(nbaGames.homeTeamId, player.teamId), eq(nbaGames.awayTeamId, player.teamId)),
          inArray(nbaGames.status, ["scheduled", "in"]),
          gte(nbaGames.startTime, new Date(now.getTime() - 4 * 3_600_000)),
        ),
      )
      .orderBy(asc(nbaGames.startTime))
      .limit(7);
    schedule = upcoming.map((g) => {
      const home = g.homeTeamId === player.teamId;
      return { gameId: g.id, date: g.startTime, opponent: teams.get(home ? g.awayTeamId : g.homeTeamId)?.abbrev ?? "?", home };
    });
  }

  const news = await db
    .select()
    .from(nbaNews)
    .where(sql`${playerId} = any(${nbaNews.relatedPlayerIds})`)
    .orderBy(desc(nbaNews.published))
    .limit(6);

  const projection = (await loadProjections(db, { now, playerIds: [playerId], season: season ?? undefined })).get(playerId) ?? null;
  const remaining = player.teamId !== null ? (await loadGamesRemaining(db, now)).get(player.teamId) : undefined;

  return {
    player,
    team: team ?? null,
    injury: injury ?? null,
    season,
    averages,
    gameLog,
    schedule,
    news,
    projection,
    remaining: remaining ?? { week: 0, season: 0 },
    projectedTotals: projectedTotals(projection?.projection ?? null, remaining),
  };
}
