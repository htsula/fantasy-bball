import type { Team } from "@/db/schema";
import type { Db } from "@/db/types";
import { TradeError, type TradeErrorCode } from "@/lib/trades/service";
import { seedPlayers, type DraftFixture } from "./draft";
import { rosterPlayer, seasonLeague } from "./rosters";

export const NOON = new Date("2026-11-02T17:00:00Z"); // noon ET, Nov 2

export type TradeFixture = DraftFixture & {
  /** The team the commissioner owns. */
  commish: Team;
  /** The other teams, in a fixed (by name) order. */
  others: Team[];
};

/**
 * In-season league with `count` teams. Roles are explicit: `commish` is the commissioner's team,
 * `others` are the rest (never pick teams by draft order).
 */
export async function tradeLeague(
  db: Db,
  count = 4,
  settings: Record<string, unknown> = {},
  max = 10,
  players = 40,
): Promise<TradeFixture> {
  await seedPlayers(db, players);
  const fx = await seasonLeague(db, count, { max, settings });
  const commish = fx.teams.find((t) => t.ownerId === fx.league.commissionerId)!;
  const others = fx.teams.filter((t) => t.id !== commish.id).sort((a, b) => a.name.localeCompare(b.name));
  return { ...fx, commish, others };
}

/** Puts players on a team's roster (acquired well before any test clock). */
export async function stock(db: Db, fx: DraftFixture, team: Team, playerIds: number[], acquiredAt?: Date) {
  const index = fx.teams.findIndex((t) => t.id === team.id);
  for (const id of playerIds) await rosterPlayer(db, fx, index, id, { acquiredAt });
}

export async function tradeCode(p: Promise<unknown>): Promise<TradeErrorCode | "ok"> {
  try {
    await p;
    return "ok";
  } catch (err) {
    if (err instanceof TradeError) return err.code;
    throw err;
  }
}
