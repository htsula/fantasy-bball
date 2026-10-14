"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requireUser } from "@/lib/auth/session";
import { PlayoffError, overridePlayoffWinner, reseedPlayoffs } from "@/lib/playoffs/service";

export type PlayoffActionResult = { ok: true } | { ok: false; error: string };

async function run(leagueId: string, fn: () => Promise<unknown>): Promise<PlayoffActionResult> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof PlayoffError) return { ok: false, error: err.message };
    throw err;
  }
  revalidatePath(`/leagues/${leagueId}`, "layout");
  return { ok: true };
}

export async function reseedPlayoffsAction(leagueId: string): Promise<PlayoffActionResult> {
  const user = await requireUser();
  return run(leagueId, () => reseedPlayoffs(db, user, leagueId));
}

export async function overrideWinnerAction(
  leagueId: string,
  slotId: string,
  winnerTeamId: string,
  note: string,
): Promise<PlayoffActionResult> {
  const user = await requireUser();
  return run(leagueId, () => overridePlayoffWinner(db, user, slotId, winnerTeamId, note));
}
