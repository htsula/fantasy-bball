/**
 * Tip-off snapshots (the basis of the team-win bonus). The first time a sync sees a game in
 * progress (or already final) without a snapshot, we record every active player on the two
 * teams with the injury status cached at that moment. Rows are insert-only (ON CONFLICT DO
 * NOTHING), so later trades or injury-report edits can't change a past game's eligibility.
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { gameRosterSnapshots, nbaGames, nbaPlayers, rawSnapshots } from "@/db/schema";
import type { Db } from "@/db/types";
import { normalizeInjuryStatus } from "@/lib/fantasy/scoring";

const MIN = 60_000;
/** A snapshot first taken this long after the scheduled tip-off (or after the final) is "late". */
export const LATE_AFTER_MS = 10 * MIN;
/** Only games that started recently get a snapshot: old games' rosters have moved on. */
export const SNAPSHOT_MAX_AGE_MS = 8 * 60 * MIN;

export type SnapshotResult = { games: number; rows: number };

/**
 * Snapshots games that are in progress/final, started within the last 8 hours and have no
 * snapshot yet. Pass `gameIds` to restrict the check (e.g. to the games of one scoreboard).
 */
export async function captureTipoffSnapshots(db: Db, now: Date, gameIds?: number[]): Promise<SnapshotResult> {
  if (gameIds && gameIds.length === 0) return { games: 0, rows: 0 };
  const earliest = new Date(now.getTime() - SNAPSHOT_MAX_AGE_MS);
  const games = await db
    .select({
      id: nbaGames.id,
      status: nbaGames.status,
      startTime: nbaGames.startTime,
      homeTeamId: nbaGames.homeTeamId,
      awayTeamId: nbaGames.awayTeamId,
    })
    .from(nbaGames)
    .where(
      and(
        inArray(nbaGames.status, ["in", "final"]),
        sql`${nbaGames.startTime} >= ${earliest.toISOString()}::timestamptz`,
        sql`not exists (select 1 from ${gameRosterSnapshots} s where s.game_id = ${nbaGames.id})`,
        gameIds ? inArray(nbaGames.id, gameIds) : undefined,
      ),
    );
  if (games.length === 0) return { games: 0, rows: 0 };

  const teamIds = [...new Set(games.flatMap((g) => [g.homeTeamId, g.awayTeamId]))];
  const players = await db
    .select({ id: nbaPlayers.id, teamId: nbaPlayers.teamId, injuryStatus: nbaPlayers.injuryStatus })
    .from(nbaPlayers)
    .where(and(eq(nbaPlayers.active, true), isNotNull(nbaPlayers.teamId), inArray(nbaPlayers.teamId, teamIds)));
  const byTeam = new Map<number, typeof players>();
  for (const p of players) byTeam.set(p.teamId!, [...(byTeam.get(p.teamId!) ?? []), p]);

  const rows = games.flatMap((g) => {
    const late = g.status === "final" || now.getTime() - g.startTime.getTime() >= LATE_AFTER_MS;
    return [g.homeTeamId, g.awayTeamId].flatMap((teamId) =>
      (byTeam.get(teamId) ?? []).map((p) => ({
        gameId: g.id,
        playerId: p.id,
        nbaTeamId: teamId,
        injuryStatus: normalizeInjuryStatus(p.injuryStatus),
        late,
        capturedAt: now,
      })),
    );
  });
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const res = await db
      .insert(gameRosterSnapshots)
      .values(rows.slice(i, i + 500))
      .onConflictDoNothing()
      .returning({ gameId: gameRosterSnapshots.gameId });
    inserted += res.length;
  }
  return { games: games.length, rows: inserted };
}

// ---------------------------------------------------------------------------------------------
// Injury refresh throttle (so tip-off snapshots carry fresh statuses)

export const INJURY_REFRESH_KIND = "injuries-refresh";
export const INJURY_REFRESH_EVERY_MS = 30 * MIN;
export const INJURY_LOOKAHEAD_MS = 90 * MIN;

export async function lastInjuryRefresh(db: Db): Promise<Date | null> {
  const [row] = await db
    .select({ fetchedAt: rawSnapshots.fetchedAt })
    .from(rawSnapshots)
    .where(and(eq(rawSnapshots.kind, INJURY_REFRESH_KIND), eq(rawSnapshots.key, "latest")));
  return row?.fetchedAt ?? null;
}

export async function markInjuryRefresh(db: Db, now: Date) {
  await db
    .insert(rawSnapshots)
    .values({ kind: INJURY_REFRESH_KIND, key: "latest", payload: {}, fetchedAt: now })
    .onConflictDoUpdate({ target: [rawSnapshots.kind, rawSnapshots.key], set: { fetchedAt: now } });
}

/** True when a game tips within the lookahead and the injury feed is older than the throttle. */
export async function injuryRefreshDue(db: Db, now: Date, hasUpcomingTip: boolean): Promise<boolean> {
  if (!hasUpcomingTip) return false;
  const last = await lastInjuryRefresh(db);
  return !last || now.getTime() - last.getTime() >= INJURY_REFRESH_EVERY_MS;
}
