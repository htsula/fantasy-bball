/**
 * Season history, rollover and keepers (milestone 8).
 *
 * Every season is its own `leagues` row; leagues.previous_league_id links a season to the one
 * before it and teams.previous_team_id links the same franchise across seasons. Final results are
 * written to season_results when a league completes (see playoffs/service.ts).
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { log } from "@/lib/log";
import {
  keepers,
  leagues,
  nbaPlayers,
  rosterEntries,
  seasonResults,
  teams,
  users,
  type League,
  type PlayoffResult,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { loadBoardPlayers, type BoardPlayer } from "@/lib/draft/board";
import { keepersRoom } from "@/lib/fantasy/roster-size";
import { parseStoredSettings } from "@/lib/fantasy/settings";
import { etDateString } from "@/lib/nba/dates";
import { notify as realNotify, type Notifier } from "@/lib/notifications/service";

export type SeasonActor = { id: string; isSiteAdmin?: boolean };

export type SeasonErrorCode =
  | "not_found"
  | "forbidden"
  | "wrong_status"
  | "already_started"
  | "keepers_disabled"
  | "deadline_passed"
  | "too_many"
  | "ineligible"
  | "invalid_input";

const MESSAGES: Record<SeasonErrorCode, string> = {
  not_found: "Not found.",
  forbidden: "You don't have permission to do that.",
  wrong_status: "That isn't possible in this league's current phase.",
  already_started: "The next season has already been started.",
  keepers_disabled: "This league has no keepers (set Keepers per team in settings).",
  deadline_passed: "The keeper deadline has passed. Ask the commissioner to make changes.",
  too_many: "You picked more keepers than allowed.",
  ineligible: "Keepers must come from last season's final roster and still be on an active NBA roster.",
  invalid_input: "Invalid request.",
};

export class SeasonError extends Error {
  constructor(
    public code: SeasonErrorCode,
    message?: string,
    public nextLeagueId?: string,
  ) {
    super(message ?? MESSAGES[code]);
  }
}

const uuidOk = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

async function loadLeague(db: Db, leagueId: string): Promise<League> {
  if (!uuidOk(leagueId)) throw new SeasonError("not_found", "League not found.");
  const [league] = await db.select().from(leagues).where(eq(leagues.id, leagueId));
  if (!league) throw new SeasonError("not_found", "League not found.");
  return league;
}

// ------------------------------------------------------------------------------------ rollover

export type NextSeasonDeps = { notify?: Notifier };

/**
 * Commissioner only, league must be complete. Creates next season's league in "setup": same name and
 * commissioner, season + 1, settings copied with every date cleared (they re-derive from the new NBA
 * schedule when the schedule is generated), and a new team for every team with the same owner, name
 * and abbreviation, linked through previous_team_id. Rosters do not carry over (except keepers,
 * chosen later). Owners can rename teams; the commissioner can remove teams and invite new ones
 * with the normal league invite flow.
 */
export async function startNextSeason(db: Db, actor: SeasonActor, leagueId: string, deps: NextSeasonDeps = {}): Promise<League> {
  const created = await db.transaction(async (tx) => {
    if (!uuidOk(leagueId)) throw new SeasonError("not_found", "League not found.");
    const [league] = await tx.select().from(leagues).where(eq(leagues.id, leagueId)).for("update");
    if (!league) throw new SeasonError("not_found", "League not found.");
    if (league.commissionerId !== actor.id) throw new SeasonError("forbidden");
    if (league.status !== "complete") throw new SeasonError("wrong_status", "The season must be complete before starting the next one.");
    const [existing] = await tx.select({ id: leagues.id }).from(leagues).where(eq(leagues.previousLeagueId, leagueId));
    if (existing) throw new SeasonError("already_started", undefined, existing.id);

    const settings = {
      ...parseStoredSettings(league.settings),
      regularSeasonStart: null,
      regularSeasonEnd: null,
      tradeDeadline: null,
      keeperDeadline: null,
    };
    const [next] = await tx
      .insert(leagues)
      .values({
        name: league.name,
        season: league.season + 1,
        commissionerId: league.commissionerId,
        status: "setup",
        settings,
        previousLeagueId: league.id,
      })
      .returning();
    const old = await tx.select().from(teams).where(eq(teams.leagueId, league.id)).orderBy(asc(teams.createdAt), asc(teams.id));
    if (old.length) {
      await tx
        .insert(teams)
        .values(old.map((t) => ({ leagueId: next.id, name: t.name, abbrev: t.abbrev, ownerId: t.ownerId, previousTeamId: t.id })));
    }
    return { next, owners: old.map((t) => t.ownerId) };
  });

  const send = deps.notify ?? realNotify;
  try {
    await send(db, {
      userIds: created.owners,
      leagueId: created.next.id,
      type: "league_events",
      title: "New season",
      body: `${created.next.name} is set up for the next season. Check your team and keepers.`,
      url: `/leagues/${created.next.id}`,
    });
  } catch (err) {
    log.error("seasons.notification_failed", {}, err);
  }
  return created.next;
}

// ------------------------------------------------------------------------------------ history

type LineageLeague = Pick<League, "id" | "name" | "season" | "status" | "previousLeagueId">;

/** All seasons of the league's lineage, oldest first (follows previous_league_id both ways). */
export async function getLineage(db: Db, leagueId: string): Promise<LineageLeague[]> {
  const cols = { id: leagues.id, name: leagues.name, season: leagues.season, status: leagues.status, previousLeagueId: leagues.previousLeagueId };
  const [start] = await db.select(cols).from(leagues).where(eq(leagues.id, leagueId));
  if (!start) return [];
  const chain: LineageLeague[] = [start];
  const seen = new Set([start.id]);
  for (let cur = start; cur.previousLeagueId && !seen.has(cur.previousLeagueId); ) {
    const [prev] = await db.select(cols).from(leagues).where(eq(leagues.id, cur.previousLeagueId));
    if (!prev) break;
    chain.unshift(prev);
    seen.add(prev.id);
    cur = prev;
  }
  for (let cur = start; ; ) {
    const [next] = await db.select(cols).from(leagues).where(eq(leagues.previousLeagueId, cur.id));
    if (!next || seen.has(next.id)) break;
    chain.push(next);
    seen.add(next.id);
    cur = next;
  }
  return chain;
}

export type SeasonResultRow = {
  teamId: string | null;
  ownerUserId: string | null;
  ownerUsername: string | null;
  teamName: string;
  finalRank: number;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  playoffResult: PlayoffResult;
};

export type SeasonSummary = {
  leagueId: string;
  name: string;
  season: number;
  status: League["status"];
  /** Null until the season completes. */
  champion: { teamName: string; ownerUsername: string | null } | null;
  results: SeasonResultRow[];
};

/** Seasons of the lineage, newest first, with champions and final standings. */
export async function getLeagueHistory(db: Db, leagueId: string): Promise<SeasonSummary[]> {
  const chain = await getLineage(db, leagueId);
  if (chain.length === 0) return [];
  const rows = await db
    .select({ r: seasonResults, username: users.username })
    .from(seasonResults)
    .leftJoin(users, eq(users.id, seasonResults.ownerUserId))
    .where(inArray(seasonResults.leagueId, chain.map((l) => l.id)))
    .orderBy(asc(seasonResults.finalRank));
  return chain
    .map((l): SeasonSummary => {
      const results = rows
        .filter((x) => x.r.leagueId === l.id)
        .map((x) => ({
          teamId: x.r.teamId,
          ownerUserId: x.r.ownerUserId,
          ownerUsername: x.username,
          teamName: x.r.teamName,
          finalRank: x.r.finalRank,
          wins: x.r.wins,
          losses: x.r.losses,
          ties: x.r.ties,
          pointsFor: x.r.pointsFor,
          pointsAgainst: x.r.pointsAgainst,
          playoffResult: x.r.playoffResult,
        }));
      const champ = results.find((r) => r.playoffResult === "champion");
      return {
        leagueId: l.id,
        name: l.name,
        season: l.season,
        status: l.status,
        champion: champ ? { teamName: champ.teamName, ownerUsername: champ.ownerUsername } : null,
        results,
      };
    })
    .sort((a, b) => b.season - a.season);
}

export type PastSeason = {
  leagueId: string;
  leagueName: string;
  season: number;
  teamName: string;
  finalRank: number;
  playoffResult: PlayoffResult;
  wins: number;
  losses: number;
  ties: number;
};

/** An owner's finishes in the earlier seasons of this league's lineage (excluding `leagueId`). */
export async function getOwnerPastSeasons(db: Db, leagueId: string, ownerUserId: string): Promise<PastSeason[]> {
  const chain = (await getLineage(db, leagueId)).filter((l) => l.id !== leagueId);
  if (chain.length === 0) return [];
  const rows = await db
    .select({ r: seasonResults, league: leagues })
    .from(seasonResults)
    .innerJoin(leagues, eq(leagues.id, seasonResults.leagueId))
    .where(and(inArray(seasonResults.leagueId, chain.map((l) => l.id)), eq(seasonResults.ownerUserId, ownerUserId)));
  return rows
    .map(({ r, league }) => ({
      leagueId: league.id,
      leagueName: league.name,
      season: league.season,
      teamName: r.teamName,
      finalRank: r.finalRank,
      playoffResult: r.playoffResult,
      wins: r.wins,
      losses: r.losses,
      ties: r.ties,
    }))
    .sort((a, b) => b.season - a.season);
}

/** Id of the season that follows this league, if one was started. */
export async function getNextSeasonId(db: Db, leagueId: string): Promise<string | null> {
  const [next] = await db.select({ id: leagues.id }).from(leagues).where(eq(leagues.previousLeagueId, leagueId));
  return next?.id ?? null;
}

// ------------------------------------------------------------------------------------ keepers

export type KeeperTeamView = {
  teamId: string;
  teamName: string;
  ownerUsername: string;
  /** Players from the previous season's final roster who are still active on an NBA roster. */
  candidates: BoardPlayer[];
  selected: number[];
};

export type KeeperView = {
  enabled: boolean;
  /** Keepers allowed per team: the setting, capped by roster space after the snake rounds. */
  limit: number;
  deadline: string | null;
  deadlinePassed: boolean;
  /** Setup phase only. */
  open: boolean;
  isCommissioner: boolean;
  /** Teams the viewer may edit: their own, or every team for the commissioner. */
  teams: KeeperTeamView[];
};

async function candidatePlayerIds(db: Db, previousTeamId: string | null): Promise<number[]> {
  if (!previousTeamId) return [];
  const rows = await db
    .select({ id: nbaPlayers.id })
    .from(rosterEntries)
    .innerJoin(nbaPlayers, eq(nbaPlayers.id, rosterEntries.playerId))
    .where(
      and(
        eq(rosterEntries.teamId, previousTeamId),
        isNull(rosterEntries.releasedAt),
        eq(nbaPlayers.active, true),
        sql`${nbaPlayers.teamId} is not null`,
      ),
    );
  return rows.map((r) => r.id);
}

export async function getKeeperView(db: Db, actor: SeasonActor, leagueId: string, now = new Date()): Promise<KeeperView> {
  const league = await loadLeague(db, leagueId);
  const settings = parseStoredSettings(league.settings);
  const teamRows = await db
    .select({ team: teams, username: users.username })
    .from(teams)
    .innerJoin(users, eq(users.id, teams.ownerId))
    .where(eq(teams.leagueId, leagueId))
    .orderBy(asc(teams.createdAt), asc(teams.name));
  const isCommissioner = league.commissionerId === actor.id;
  const editable = teamRows.filter((t) => isCommissioner || t.team.ownerId === actor.id);
  const chosen = await db.select().from(keepers).where(eq(keepers.leagueId, leagueId));

  const out: KeeperTeamView[] = [];
  for (const t of editable) {
    const ids = await candidatePlayerIds(db, t.team.previousTeamId);
    const selected = chosen.filter((k) => k.teamId === t.team.id).map((k) => k.playerId);
    const players = await loadBoardPlayers(db, [...ids, ...selected], league);
    const candidates = ids.map((id) => players.get(id)).filter((p): p is BoardPlayer => Boolean(p));
    candidates.sort((a, b) => (b.lastFp ?? -1) - (a.lastFp ?? -1) || a.name.localeCompare(b.name));
    out.push({ teamId: t.team.id, teamName: t.team.name, ownerUsername: t.username, candidates, selected });
  }
  const deadline = settings.keeperDeadline;
  return {
    enabled: settings.keepers > 0,
    limit: teamRows.length >= 2 ? Math.min(settings.keepers, keepersRoom(teamRows.length, settings)) : settings.keepers,
    deadline,
    deadlinePassed: Boolean(deadline && etDateString(now) > deadline),
    open: league.status === "setup",
    isCommissioner,
    teams: out,
  };
}

/**
 * Replaces a team's keepers (owner, or the commissioner for any team; setup only). Owners are also
 * stopped by the keeper deadline; the commissioner never is. Validates the limit and that every
 * player is on last season's final roster of this franchise and still active on an NBA roster.
 */
export async function setKeepers(
  db: Db,
  actor: SeasonActor,
  teamId: string,
  playerIds: number[],
  now = new Date(),
): Promise<number[]> {
  if (!uuidOk(teamId)) throw new SeasonError("not_found", "Team not found.");
  const [team] = await db.select().from(teams).where(eq(teams.id, teamId));
  if (!team) throw new SeasonError("not_found", "Team not found.");
  const league = await loadLeague(db, team.leagueId);
  const isCommissioner = league.commissionerId === actor.id;
  if (!isCommissioner && team.ownerId !== actor.id) throw new SeasonError("forbidden");
  if (league.status !== "setup") throw new SeasonError("wrong_status", "Keepers can only be changed before the draft starts.");
  const settings = parseStoredSettings(league.settings);
  if (settings.keepers === 0) throw new SeasonError("keepers_disabled");
  if (!isCommissioner && settings.keeperDeadline && etDateString(now) > settings.keeperDeadline) {
    throw new SeasonError("deadline_passed");
  }
  const ids = [...new Set(playerIds)];
  if (!ids.every((n) => Number.isInteger(n))) throw new SeasonError("invalid_input");

  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(teams).where(eq(teams.leagueId, league.id));
  const limit = n >= 2 ? Math.min(settings.keepers, keepersRoom(n, settings)) : settings.keepers;
  if (ids.length > limit) throw new SeasonError("too_many", `You can keep at most ${limit} player${limit === 1 ? "" : "s"}.`);

  const eligible = new Set(await candidatePlayerIds(db, team.previousTeamId));
  if (!ids.every((id) => eligible.has(id))) throw new SeasonError("ineligible");

  await db.transaction(async (tx) => {
    await tx.delete(keepers).where(eq(keepers.teamId, teamId));
    if (ids.length) {
      await tx.insert(keepers).values(ids.map((playerId) => ({ leagueId: league.id, teamId, playerId, selectedBy: actor.id })));
    }
  });
  return ids;
}
