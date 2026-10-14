import { eq } from "drizzle-orm";
import { gameRosterSnapshots, leagues, nbaGames, playerGameStats, rosterEntries } from "@/db/schema";
import type { Db } from "@/db/types";
import { createAdmin, setupLeague, type DraftFixture } from "./draft";

/** League with `count` teams already in season (no draft needed), max roster = `max`. */
export async function seasonLeague(
  db: Db,
  count = 2,
  opts: { max?: number; settings?: Record<string, unknown>; status?: "in_season" | "playoffs" | "setup" | "complete" } = {},
): Promise<DraftFixture> {
  const admin = await createAdmin(db);
  const fx = await setupLeague(db, admin, count, { rosterCap: opts.max ?? 5, ...(opts.settings ?? {}) }, { schedule: false });
  const status = opts.status ?? "in_season";
  await db.update(leagues).set({ status }).where(eq(leagues.id, fx.league.id));
  return { ...fx, league: { ...fx.league, status } };
}

export async function rosterPlayer(
  db: Db,
  fx: DraftFixture,
  teamIndex: number,
  playerId: number,
  opts: { acquiredAt?: Date; releasedAt?: Date | null; via?: "draft" | "add" | "trade" | "commissioner"; releasedVia?: string } = {},
) {
  await db.insert(rosterEntries).values({
    leagueId: fx.league.id,
    teamId: fx.teams[teamIndex].id,
    playerId,
    acquiredVia: opts.via ?? "draft",
    acquiredAt: opts.acquiredAt ?? new Date("2026-10-01T00:00:00Z"),
    releasedAt: opts.releasedAt ?? null,
    releasedVia: opts.releasedAt ? (opts.releasedVia ?? "drop") : null,
  });
}

export async function insertGame(
  db: Db,
  id: number,
  startTime: Date,
  status: "scheduled" | "in" | "final",
  home = 1,
  away = 2,
  score: [number, number] | null = status === "scheduled" ? null : [110, 100],
) {
  await db.insert(nbaGames).values({
    id,
    season: 2027,
    seasonType: 2,
    startTime,
    homeTeamId: home,
    awayTeamId: away,
    homeScore: score?.[0] ?? null,
    awayScore: score?.[1] ?? null,
    status,
  });
}

export async function snapshot(
  db: Db,
  gameId: number,
  playerId: number,
  nbaTeamId: number,
  injuryStatus: string | null = null,
  late = false,
) {
  await db.insert(gameRosterSnapshots).values({ gameId, playerId, nbaTeamId, injuryStatus, late });
}

export async function boxScore(
  db: Db,
  gameId: number,
  playerId: number,
  teamId: number,
  line: Partial<typeof playerGameStats.$inferInsert> = {},
) {
  await db.insert(playerGameStats).values({ gameId, playerId, teamId, minutes: 20, ...line });
}
