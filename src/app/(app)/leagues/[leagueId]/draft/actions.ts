"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { teams } from "@/db/schema";
import { requireUser } from "@/lib/auth/session";
import {
  DraftError,
  addToQueue,
  getDraftByLeague,
  makePick,
  removeFromQueue,
  reorderQueue,
  startDraft,
  undoLastPick,
} from "@/lib/draft/service";

export type DraftActionResult = { ok: true } | { ok: false; error: string; code?: string };

const ids = z.object({ leagueId: z.string().uuid(), playerId: z.number().int().positive() });

async function run(fn: () => Promise<void>): Promise<DraftActionResult> {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    if (err instanceof DraftError) return { ok: false, error: err.message, code: err.code };
    throw err;
  }
}

async function myTeamId(leagueId: string, userId: string): Promise<string> {
  const [t] = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.leagueId, leagueId), eq(teams.ownerId, userId)));
  if (!t) throw new DraftError("forbidden", "You don't have a team in this league.");
  return t.id;
}

function refresh(leagueId: string) {
  revalidatePath(`/leagues/${leagueId}`, "layout");
}

export async function startDraftAction(leagueId: string): Promise<DraftActionResult> {
  const user = await requireUser();
  const result = await run(async () => {
    await startDraft(db, leagueId, user.id);
  });
  refresh(leagueId);
  return result;
}

/** Pick for my own team, or (commissioner) for `teamId` when it differs from mine. */
export async function makePickAction(leagueId: string, playerId: number, teamId?: string): Promise<DraftActionResult> {
  const user = await requireUser();
  const parsed = ids.safeParse({ leagueId, playerId });
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const result = await run(async () => {
    const draft = await getDraftByLeague(db, leagueId);
    if (!draft) throw new DraftError("not_found");
    const mine = await myTeamId(leagueId, user.id).catch(() => null);
    const target = teamId ?? mine;
    if (!target) throw new DraftError("forbidden", "You don't have a team in this league.");
    await makePick(db, draft.id, target, playerId, user.id, { asCommissioner: target !== mine });
  });
  if (result.ok) refresh(leagueId);
  return result;
}

export async function undoLastPickAction(leagueId: string): Promise<DraftActionResult> {
  const user = await requireUser();
  const result = await run(async () => {
    const draft = await getDraftByLeague(db, leagueId);
    if (!draft) throw new DraftError("not_found");
    await undoLastPick(db, draft.id, user.id);
  });
  if (result.ok) refresh(leagueId);
  return result;
}

export async function addToQueueAction(leagueId: string, playerId: number): Promise<DraftActionResult> {
  const user = await requireUser();
  const parsed = ids.safeParse({ leagueId, playerId });
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  return run(async () => addToQueue(db, await myTeamId(leagueId, user.id), playerId, user.id));
}

export async function removeFromQueueAction(leagueId: string, playerId: number): Promise<DraftActionResult> {
  const user = await requireUser();
  const parsed = ids.safeParse({ leagueId, playerId });
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  return run(async () => removeFromQueue(db, await myTeamId(leagueId, user.id), playerId, user.id));
}

export async function reorderQueueAction(leagueId: string, playerIds: number[]): Promise<DraftActionResult> {
  const user = await requireUser();
  const parsed = z.object({ leagueId: z.string().uuid(), playerIds: z.array(z.number().int()).max(1000) }).safeParse({ leagueId, playerIds });
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  return run(async () => reorderQueue(db, await myTeamId(leagueId, user.id), playerIds, user.id));
}
