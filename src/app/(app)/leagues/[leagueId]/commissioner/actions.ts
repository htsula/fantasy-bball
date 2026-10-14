"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { requireUser } from "@/lib/auth/session";
import { DraftError, restartDraft } from "@/lib/draft/service";
import { LeagueError, removeTeam, renameTeam, transferCommissioner, transferTeamOwnership } from "@/lib/leagues/service";
import { MatchupError, adjustMatchupScore } from "@/lib/matchups/service";
import { TradeError, forceCancelTrade } from "@/lib/trades/service";

export type CommissionerResult = { ok: true; message?: string; warnings?: string[] } | { ok: false; error: string };

const uuid = z.string().uuid();

function leagueMessage(err: LeagueError): string {
  const first = err.fieldErrors ? Object.values(err.fieldErrors).flat()[0] : undefined;
  return first ?? err.message;
}

async function run(leagueId: string, fn: () => Promise<Omit<Extract<CommissionerResult, { ok: true }>, "ok"> | void>): Promise<CommissionerResult> {
  if (!uuid.safeParse(leagueId).success) return { ok: false, error: "Invalid request." };
  try {
    const out = await fn();
    revalidatePath(`/leagues/${leagueId}`, "layout");
    return { ok: true, ...(out ?? {}) };
  } catch (err) {
    if (err instanceof LeagueError) return { ok: false, error: leagueMessage(err) };
    if (err instanceof MatchupError || err instanceof DraftError || err instanceof TradeError) return { ok: false, error: err.message };
    throw err;
  }
}

export async function editTeamAction(leagueId: string, teamId: string, name: string, abbrev: string): Promise<CommissionerResult> {
  const user = await requireUser();
  return run(leagueId, async () => {
    await renameTeam(db, user, teamId, { name, abbrev });
    return { message: "Team updated." };
  });
}

export async function transferOwnershipAction(leagueId: string, teamId: string, username: string): Promise<CommissionerResult> {
  const user = await requireUser();
  return run(leagueId, async () => {
    const team = await transferTeamOwnership(db, user, teamId, username);
    return { message: `${team.name} now belongs to ${username.trim()}.` };
  });
}

export async function removeTeamAction(leagueId: string, teamId: string): Promise<CommissionerResult> {
  const user = await requireUser();
  return run(leagueId, async () => {
    await removeTeam(db, user, teamId);
    return { message: "Team removed. Regenerate the schedule." };
  });
}

export async function transferCommissionerAction(leagueId: string, teamId: string): Promise<CommissionerResult> {
  const user = await requireUser();
  return run(leagueId, async () => {
    await transferCommissioner(db, user, leagueId, teamId);
    return { message: "You are no longer the commissioner." };
  });
}

export async function adjustScoreAction(
  leagueId: string,
  matchupId: string,
  teamId: string,
  points: number,
  reason: string,
): Promise<CommissionerResult> {
  const user = await requireUser();
  if (!uuid.safeParse(matchupId).success || !uuid.safeParse(teamId).success) return { ok: false, error: "Invalid request." };
  return run(leagueId, async () => {
    const res = await adjustMatchupScore(db, user, matchupId, teamId, points, reason);
    return { message: "Adjustment saved. Totals were recalculated.", warnings: res.warnings };
  });
}

export async function restartDraftAction(leagueId: string, confirmName: string): Promise<CommissionerResult> {
  const user = await requireUser();
  return run(leagueId, async () => {
    const res = await restartDraft(db, leagueId, user.id, confirmName);
    return { message: `Draft restarted (${res.picksRemoved} picks removed). The league is back in setup.` };
  });
}

export async function forceCancelTradeAction(leagueId: string, tradeId: string, reason: string): Promise<CommissionerResult> {
  const user = await requireUser();
  return run(leagueId, async () => {
    await forceCancelTrade(db, { tradeId, actorUserId: user.id, reason });
    return { message: "Trade cancelled." };
  });
}
