"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requireUser } from "@/lib/auth/session";
import { SeasonError, startNextSeason } from "@/lib/seasons/service";

export type NextSeasonResult = { ok: true; leagueId: string } | { ok: false; error: string; leagueId?: string };

export async function startNextSeasonAction(leagueId: string): Promise<NextSeasonResult> {
  const user = await requireUser();
  try {
    const next = await startNextSeason(db, user, leagueId);
    revalidatePath("/leagues");
    revalidatePath(`/leagues/${leagueId}`, "layout");
    return { ok: true, leagueId: next.id };
  } catch (err) {
    if (err instanceof SeasonError) return { ok: false, error: err.message, leagueId: err.nextLeagueId };
    throw err;
  }
}
