"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { requireUser } from "@/lib/auth/session";
import { SeasonError, setKeepers } from "@/lib/seasons/service";

export type KeeperActionResult = { ok: true; saved: number } | { ok: false; error: string };

const input = z.object({ leagueId: z.string().uuid(), teamId: z.string().uuid(), playerIds: z.array(z.number().int()).max(100) });

export async function saveKeepersAction(leagueId: string, teamId: string, playerIds: number[]): Promise<KeeperActionResult> {
  const user = await requireUser();
  const parsed = input.safeParse({ leagueId, teamId, playerIds });
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  try {
    const saved = await setKeepers(db, user, teamId, playerIds);
    revalidatePath(`/leagues/${leagueId}/keepers`);
    revalidatePath(`/leagues/${leagueId}/draft`);
    return { ok: true, saved: saved.length };
  } catch (err) {
    if (err instanceof SeasonError) return { ok: false, error: err.message };
    throw err;
  }
}
