"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { requireUser } from "@/lib/auth/session";
import {
  RosterError,
  addFreeAgent,
  commissionerAdd,
  commissionerDrop,
  commissionerRestore,
  dropPlayer,
} from "@/lib/rosters/service";

export type RosterActionResult = { ok: true } | { ok: false; error: string; code?: string };

const ids = z.object({
  leagueId: z.string().uuid(),
  teamId: z.string().uuid(),
  playerId: z.number().int().positive(),
  dropPlayerId: z.number().int().positive().nullish(),
});

async function run(leagueId: string, fn: () => Promise<void>): Promise<RosterActionResult> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof RosterError) return { ok: false, error: err.message, code: err.code };
    throw err;
  }
  revalidatePath(`/leagues/${leagueId}`, "layout");
  return { ok: true };
}

/** The signed-in owner adds a free agent to his own team, optionally dropping a player. */
export async function addFreeAgentAction(
  leagueId: string,
  teamId: string,
  playerId: number,
  dropPlayerId?: number | null,
): Promise<RosterActionResult> {
  const user = await requireUser();
  const parsed = ids.safeParse({ leagueId, teamId, playerId, dropPlayerId });
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  return run(leagueId, () => addFreeAgent(db, { ...parsed.data, actorUserId: user.id }));
}

/**
 * Drops a player from `teamId`: the team's owner drops normally; anyone else is treated as the
 * commissioner (and the service rejects them if they are not).
 */
export async function dropPlayerAction(leagueId: string, teamId: string, playerId: number): Promise<RosterActionResult> {
  const user = await requireUser();
  const parsed = ids.safeParse({ leagueId, teamId, playerId });
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  return run(leagueId, async () => {
    const input = { leagueId, teamId, playerId, actorUserId: user.id };
    try {
      await dropPlayer(db, input);
    } catch (err) {
      // A commissioner dropping another team's player is a different (logged) kind of move.
      if (err instanceof RosterError && err.code === "forbidden") await commissionerDrop(db, input);
      else throw err;
    }
  });
}

export async function commissionerAddAction(
  leagueId: string,
  teamId: string,
  playerId: number,
  dropPlayerId?: number | null,
): Promise<RosterActionResult> {
  const user = await requireUser();
  const parsed = ids.safeParse({ leagueId, teamId, playerId, dropPlayerId });
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  return run(leagueId, () => commissionerAdd(db, { ...parsed.data, actorUserId: user.id }));
}

export async function restorePlayerAction(leagueId: string, transactionId: string): Promise<RosterActionResult> {
  const user = await requireUser();
  const parsed = z.object({ leagueId: z.string().uuid(), transactionId: z.string().uuid() }).safeParse({ leagueId, transactionId });
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  return run(leagueId, () => commissionerRestore(db, { transactionId, actorUserId: user.id }));
}
