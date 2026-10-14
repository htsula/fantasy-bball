import { eq } from "drizzle-orm";
import { nbaPlayers, teams, type Draft, type League, type Team } from "@/db/schema";
import type { Db } from "@/db/types";
import { createUser } from "@/lib/auth/service";
import { snakeTeam } from "@/lib/draft/engine";
import { makePick, startDraft, type DraftDeps } from "@/lib/draft/service";
import {
  createLeague,
  createLeagueInvite,
  generateSchedule,
  redeemLeagueInvite,
  updateSettings,
  type Actor,
} from "@/lib/leagues/service";
import type { Notifier } from "@/lib/notifications/service";
import type { NotifyInput } from "@/lib/notifications/types";

let counter = 0;
const LETTERS = "ABCDEFGHIJKLMNOP";

export async function createAdmin(db: Db): Promise<Actor> {
  const u = await createUser(db, { username: `root${++counter}`, password: "password123", isSiteAdmin: true });
  return { id: u.id, isSiteAdmin: true };
}

/** Inserts `count` draftable players with ids starting at `from`. */
export async function seedPlayers(db: Db, count: number, from = 1) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: from + i,
    fullName: `Player ${from + i}`,
    teamId: 1 + (i % 30),
    positions: ["PG"],
    active: true,
  }));
  await db.insert(nbaPlayers).values(rows);
  return rows.map((r) => r.id);
}

export type DraftFixture = {
  admin: Actor;
  league: League;
  teams: Team[];
  /** user id by team id */
  owner: Map<string, string>;
};

/** League in setup with `count` teams, settings applied and a generated schedule. */
export async function setupLeague(
  db: Db,
  admin: Actor,
  count: number,
  settings: Record<string, unknown> = {},
  opts: { schedule?: boolean } = {},
): Promise<DraftFixture> {
  const league = await createLeague(db, admin, { name: `League ${++counter}`, season: 2027, teamName: "Commish FC", teamAbbrev: "CFC" });
  for (let i = 1; i < count; i++) {
    const { token } = await createLeagueInvite(db, admin, league.id);
    await redeemLeagueInvite(db, {
      token,
      username: `mem${++counter}`,
      password: "password123",
      teamName: `Team ${i}`,
      teamAbbrev: `T${LETTERS[i]}X`,
    });
  }
  await updateSettings(db, admin, league.id, {
    regularSeasonStart: "2026-10-20",
    regularSeasonEnd: "2027-01-31",
    playoffTeams: 2,
    ...settings,
  });
  if (opts.schedule !== false) await generateSchedule(db, admin, league.id, { seed: "t" });
  const teamList = await db.select().from(teams).where(eq(teams.leagueId, league.id));
  return { admin, league, teams: teamList, owner: new Map(teamList.map((t) => [t.id, t.ownerId])) };
}

export function captureNotifier() {
  const calls: NotifyInput[] = [];
  const notify: Notifier = async (_db, input) => {
    calls.push(input);
  };
  return { calls, notify, deps: { notify } satisfies DraftDeps };
}

export async function begin(db: Db, fx: DraftFixture, deps: DraftDeps = {}): Promise<Draft> {
  return startDraft(db, fx.league.id, fx.admin.id, deps);
}

/** Makes the next snake pick with the first free player id in `pool`. */
export async function pickSnake(db: Db, fx: DraftFixture, draft: Draft, pickNo: number, playerId: number, deps: DraftDeps = {}) {
  const teamId = snakeTeam(draft.order, pickNo);
  return makePick(db, draft.id, teamId, playerId, fx.owner.get(teamId)!, deps);
}
