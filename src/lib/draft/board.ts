/**
 * Draft read models. Everything returned is JSON-safe (dates as ISO strings) because the board is
 * polled through a route handler as well as rendered on the server.
 */
import { and, asc, desc, eq, ilike, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { draftPicks, draftQueue, leagues, matchups, nbaPlayers, nbaTeams, rosterEntries, teams, users } from "@/db/schema";
import type { Db } from "@/db/types";
import { loadProjections } from "@/lib/fantasy/projections";
import { maxRoster, snakeRounds as computeSnakeRounds, waves as computeWaves } from "@/lib/fantasy/roster-size";
import { parseStoredSettings } from "@/lib/fantasy/settings";
import { FANTASY_POSITIONS } from "@/lib/nba/positions";
import {
  pickInRound,
  snakeRoundOf,
  snakeTeam,
  totalPicks,
  waveCount,
  waveQuota,
  waveRemaining,
  type DraftConfig,
} from "./engine";
import { DraftError, getDraftByLeague } from "./service";

export type BoardPlayer = {
  id: number;
  name: string;
  positions: string[];
  nbaTeam: string | null;
  injuryStatus: string | null;
  injuryDetail: string | null;
  /** Season fantasy points per game (default scoring), null when no games. */
  avg: number | null;
  /** Projected fantasy points per game. */
  proj: number | null;
};

export type BoardTeam = { id: string; name: string; abbrev: string; ownerId: string; ownerUsername: string };

export type BoardPick = {
  overall: number;
  round: number;
  phase: "snake" | "wave";
  wave: number | null;
  teamId: string;
  player: BoardPlayer;
  madeByCommissioner: boolean;
  at: string;
};

export type DraftFormat = {
  teamCount: number;
  maxRoster: number;
  snakeRounds: number;
  totalRounds: number;
  waveSize: number;
  waveCount: number;
  fullWaves: number;
  lastWaveSize: number;
  totalPicks: number;
  snakePicks: number;
};

export type DraftBoard = {
  leagueId: string;
  leagueName: string;
  leagueStatus: string;
  serverTime: string;
  viewer: { userId: string; teamId: string | null; isCommissioner: boolean };
  format: DraftFormat;
  scheduleReady: boolean;
  /** Draft order once started; creation order before. */
  teams: BoardTeam[];
  draft: null | {
    id: string;
    status: "pending" | "snake" | "waves" | "complete";
    startedAt: string | null;
    completedAt: string | null;
    onClock: null | { teamId: string; pick: number; round: number; pickInRound: number; since: string };
    wave: null | {
      number: number;
      count: number;
      quota: number;
      openedAt: string | null;
      /** Teams that still owe picks in this wave, with how many. */
      waiting: { teamId: string; remaining: number }[];
    };
    picks: BoardPick[];
    recent: BoardPick[];
  };
  me: {
    /** True when I could pick right now (my snake turn, or wave quota left). */
    canPick: boolean;
    /** Wave picks I still owe in the current wave. */
    waveRemaining: number | null;
    roster: BoardPlayer[];
    queue: BoardPlayer[];
  };
  recap: null | { teams: { teamId: string; picks: BoardPick[]; projectedTotal: number }[] };
};

export async function loadBoardPlayers(db: Db, playerIds: number[]): Promise<Map<number, BoardPlayer>> {
  const out = new Map<number, BoardPlayer>();
  if (playerIds.length === 0) return out;
  const unique = [...new Set(playerIds)];
  const [rows, projections] = await Promise.all([
    db
      .select({
        id: nbaPlayers.id,
        name: nbaPlayers.fullName,
        positions: nbaPlayers.positions,
        injuryStatus: nbaPlayers.injuryStatus,
        injuryDetail: nbaPlayers.injuryDetail,
        nbaTeam: nbaTeams.abbrev,
      })
      .from(nbaPlayers)
      .leftJoin(nbaTeams, eq(nbaTeams.id, nbaPlayers.teamId))
      .where(inArray(nbaPlayers.id, unique)),
    loadProjections(db, { playerIds: unique }),
  ]);
  for (const r of rows) {
    const p = projections.get(r.id);
    out.set(r.id, { ...r, avg: p?.seasonAvg ?? null, proj: p?.projection ?? null });
  }
  return out;
}

/** Players still draftable in this league, best projection first. */
export async function listDraftablePlayers(
  db: Db,
  leagueId: string,
  params: { q?: string; pos?: string; team?: number; limit?: number; offset?: number } = {},
): Promise<{ total: number; players: BoardPlayer[] }> {
  const where: (SQL | undefined)[] = [
    eq(nbaPlayers.active, true),
    sql`${nbaPlayers.teamId} is not null`,
    sql`not exists (select 1 from ${rosterEntries} re where re.league_id = ${leagueId} and re.player_id = ${nbaPlayers.id} and re.released_at is null)`,
  ];
  const q = params.q?.trim();
  if (q) where.push(ilike(nbaPlayers.fullName, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
  if ((FANTASY_POSITIONS as readonly string[]).includes(params.pos ?? "")) where.push(sql`${params.pos} = any(${nbaPlayers.positions})`);
  if (params.team) where.push(eq(nbaPlayers.teamId, params.team));

  const [rows, projections] = await Promise.all([
    db
      .select({
        id: nbaPlayers.id,
        name: nbaPlayers.fullName,
        positions: nbaPlayers.positions,
        injuryStatus: nbaPlayers.injuryStatus,
        injuryDetail: nbaPlayers.injuryDetail,
        nbaTeam: nbaTeams.abbrev,
      })
      .from(nbaPlayers)
      .leftJoin(nbaTeams, eq(nbaTeams.id, nbaPlayers.teamId))
      .where(and(...where)),
    loadProjections(db),
  ]);
  const players: BoardPlayer[] = rows.map((r) => {
    const p = projections.get(r.id);
    return { ...r, avg: p?.seasonAvg ?? null, proj: p?.projection ?? null };
  });
  players.sort((a, b) => {
    if (a.proj === null && b.proj !== null) return 1;
    if (b.proj === null && a.proj !== null) return -1;
    if (a.proj !== null && b.proj !== null && a.proj !== b.proj) return b.proj - a.proj;
    return a.name.localeCompare(b.name) || a.id - b.id;
  });
  const offset = Math.max(0, params.offset ?? 0);
  const limit = Math.min(200, Math.max(1, params.limit ?? 50));
  return { total: players.length, players: players.slice(offset, offset + limit) };
}

export async function getDraftBoard(db: Db, leagueId: string, viewerUserId: string): Promise<DraftBoard> {
  const [league] = await db.select().from(leagues).where(eq(leagues.id, leagueId));
  if (!league) throw new DraftError("not_found");
  const draft = await getDraftByLeague(db, leagueId);
  const settings = parseStoredSettings(league.settings);

  const teamRows = await db
    .select({ team: teams, ownerUsername: users.username })
    .from(teams)
    .innerJoin(users, eq(users.id, teams.ownerId))
    .where(eq(teams.leagueId, leagueId))
    .orderBy(asc(teams.createdAt), asc(teams.id));
  let boardTeams: BoardTeam[] = teamRows.map((r) => ({
    id: r.team.id,
    name: r.team.name,
    abbrev: r.team.abbrev,
    ownerId: r.team.ownerId,
    ownerUsername: r.ownerUsername,
  }));
  if (draft) {
    const byId = new Map(boardTeams.map((t) => [t.id, t]));
    boardTeams = draft.order.map((id) => byId.get(id)).filter((t): t is BoardTeam => Boolean(t));
  }
  const n = boardTeams.length;
  const myTeam = boardTeams.find((t) => t.ownerId === viewerUserId) ?? null;

  // Format: locked values once started, live preview from settings before.
  const max = draft ? draft.maxRoster : maxRoster(n, settings);
  const snake = draft ? draft.snakeRounds : computeSnakeRounds(n, settings);
  const plan = computeWaves(n, settings);
  const cfg: DraftConfig = { teamCount: Math.max(n, 1), snakeRounds: snake, totalRounds: max, waveSize: settings.waveSize };
  const format: DraftFormat = {
    teamCount: n,
    maxRoster: max,
    snakeRounds: snake,
    totalRounds: max,
    waveSize: settings.waveSize,
    waveCount: waveCount(cfg),
    fullWaves: plan.fullWaves,
    lastWaveSize: plan.lastWaveSize,
    totalPicks: totalPicks({ teamCount: n, totalRounds: max }),
    snakePicks: n * snake,
  };

  const sched = await db
    .select({ home: matchups.homeTeamId, away: matchups.awayTeamId })
    .from(matchups)
    .where(eq(matchups.leagueId, leagueId));
  const scheduled = new Set(sched.flatMap((m) => [m.home, m.away]).filter((x): x is string => x !== null));
  const scheduleReady = n >= 2 && boardTeams.every((t) => scheduled.has(t.id));

  const base = {
    leagueId,
    leagueName: league.name,
    leagueStatus: league.status,
    serverTime: new Date().toISOString(),
    viewer: { userId: viewerUserId, teamId: myTeam?.id ?? null, isCommissioner: league.commissionerId === viewerUserId },
    format,
    scheduleReady,
    teams: boardTeams,
  };

  // The viewer's queue (also shown before the draft starts).
  const queueRows = myTeam
    ? await db.select().from(draftQueue).where(eq(draftQueue.teamId, myTeam.id)).orderBy(asc(draftQueue.rank), asc(draftQueue.createdAt))
    : [];

  if (!draft) {
    const players = await loadBoardPlayers(db, queueRows.map((q) => q.playerId));
    return {
      ...base,
      draft: null,
      me: {
        canPick: false,
        waveRemaining: null,
        roster: [],
        queue: queueRows.map((q) => players.get(q.playerId)).filter((p): p is BoardPlayer => Boolean(p)),
      },
      recap: null,
    };
  }

  const pickRows = await db.select().from(draftPicks).where(eq(draftPicks.draftId, draft.id)).orderBy(asc(draftPicks.overallPick));
  const players = await loadBoardPlayers(db, [...pickRows.map((p) => p.playerId), ...queueRows.map((q) => q.playerId)]);
  const picks: BoardPick[] = pickRows.flatMap((p) => {
    const player = players.get(p.playerId);
    return player
      ? [{
          overall: p.overallPick,
          round: p.round,
          phase: p.phase,
          wave: p.wave,
          teamId: p.teamId,
          player,
          madeByCommissioner: p.madeByCommissioner,
          at: p.createdAt.toISOString(),
        }]
      : [];
  });

  const counts = new Map<string, number>(boardTeams.map((t) => [t.id, 0]));
  for (const p of pickRows) counts.set(p.teamId, (counts.get(p.teamId) ?? 0) + 1);
  const lastAt = pickRows.length ? pickRows[pickRows.length - 1].createdAt : (draft.startedAt ?? draft.createdAt);

  let onClock: NonNullable<DraftBoard["draft"]>["onClock"] = null;
  let wave: NonNullable<DraftBoard["draft"]>["wave"] = null;
  let canPick = false;
  let myWaveRemaining: number | null = null;
  if (draft.status === "snake") {
    const teamId = snakeTeam(draft.order, draft.currentPick);
    onClock = {
      teamId,
      pick: draft.currentPick,
      round: snakeRoundOf(draft.currentPick, n),
      pickInRound: pickInRound(draft.currentPick, n),
      since: lastAt.toISOString(),
    };
    canPick = myTeam?.id === teamId;
  } else if (draft.status === "waves") {
    const w = draft.currentWave ?? 1;
    const waiting = draft.order
      .map((teamId) => ({ teamId, remaining: waveRemaining(cfg, w, counts.get(teamId) ?? 0) }))
      .filter((x) => x.remaining > 0);
    wave = {
      number: w,
      count: format.waveCount,
      quota: waveQuota(cfg, w),
      openedAt: draft.waveOpenedAt?.toISOString() ?? null,
      waiting,
    };
    myWaveRemaining = myTeam ? (waiting.find((x) => x.teamId === myTeam.id)?.remaining ?? 0) : null;
    canPick = (myWaveRemaining ?? 0) > 0;
  }

  const myPicks = picks.filter((p) => p.teamId === myTeam?.id);
  const recap =
    draft.status === "complete"
      ? {
          teams: boardTeams.map((t) => {
            const tp = picks.filter((p) => p.teamId === t.id);
            return { teamId: t.id, picks: tp, projectedTotal: tp.reduce((s, p) => s + (p.player.proj ?? 0), 0) };
          }),
        }
      : null;

  return {
    ...base,
    draft: {
      id: draft.id,
      status: draft.status,
      startedAt: draft.startedAt?.toISOString() ?? null,
      completedAt: draft.completedAt?.toISOString() ?? null,
      onClock,
      wave,
      picks,
      recent: [...picks].reverse().slice(0, 10),
    },
    me: {
      canPick,
      waveRemaining: myWaveRemaining,
      roster: myPicks.map((p) => p.player),
      queue: queueRows.map((q) => players.get(q.playerId)).filter((p): p is BoardPlayer => Boolean(p)),
    },
    recap,
  };
}

/** Active roster of a team (any league phase), with NBA team, positions, injury and average. */
export async function getTeamRoster(db: Db, teamId: string): Promise<BoardPlayer[]> {
  const rows = await db
    .select({ playerId: rosterEntries.playerId })
    .from(rosterEntries)
    .where(and(eq(rosterEntries.teamId, teamId), isNull(rosterEntries.releasedAt)))
    .orderBy(desc(rosterEntries.acquiredAt));
  const players = await loadBoardPlayers(db, rows.map((r) => r.playerId));
  const list = rows.map((r) => players.get(r.playerId)).filter((p): p is BoardPlayer => Boolean(p));
  return list.sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1) || a.name.localeCompare(b.name));
}
