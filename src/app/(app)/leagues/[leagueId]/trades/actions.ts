"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { requireUser } from "@/lib/auth/session";
import {
  TradeError,
  acceptTrade,
  addToTradeBlock,
  cancelTrade,
  castVote,
  commissionerApprove,
  commissionerReverse,
  commissionerVeto,
  counterTrade,
  forceCancelTrade,
  proposeTrade,
  rejectTrade,
  removeFromTradeBlock,
} from "@/lib/trades/service";

export type TradeActionResult = { ok: true; tradeId?: string; status?: string } | { ok: false; error: string; code?: string };

const uuid = z.string().uuid();
const playerIds = z.array(z.number().int().positive()).max(60);
const message = z.string().max(500).nullish();

async function run(leagueId: string, fn: () => Promise<Omit<Extract<TradeActionResult, { ok: true }>, "ok"> | void>): Promise<TradeActionResult> {
  let extra: Omit<Extract<TradeActionResult, { ok: true }>, "ok"> | void;
  try {
    extra = await fn();
  } catch (err) {
    if (err instanceof TradeError) {
      revalidatePath(`/leagues/${leagueId}`, "layout"); // the failure may have invalidated/expired the trade
      return { ok: false, error: err.message, code: err.code };
    }
    throw err;
  }
  revalidatePath(`/leagues/${leagueId}`, "layout");
  return { ok: true, ...(extra ?? {}) };
}

const bad = (): TradeActionResult => ({ ok: false, error: "Invalid request." });

export async function proposeTradeAction(
  leagueId: string,
  input: { proposerTeamId: string; receiverTeamId: string; give: number[]; get: number[]; message?: string | null },
): Promise<TradeActionResult> {
  const user = await requireUser();
  const parsed = z
    .object({ leagueId: uuid, proposerTeamId: uuid, receiverTeamId: uuid, give: playerIds, get: playerIds, message })
    .safeParse({ leagueId, ...input });
  if (!parsed.success) return bad();
  return run(leagueId, async () => {
    const t = await proposeTrade(db, { ...parsed.data, actorUserId: user.id });
    return { tradeId: t.id };
  });
}

export async function counterTradeAction(
  leagueId: string,
  tradeId: string,
  input: { give: number[]; get: number[]; message?: string | null },
): Promise<TradeActionResult> {
  const user = await requireUser();
  const parsed = z.object({ leagueId: uuid, tradeId: uuid, give: playerIds, get: playerIds, message }).safeParse({ leagueId, tradeId, ...input });
  if (!parsed.success) return bad();
  return run(leagueId, async () => {
    const t = await counterTrade(db, { tradeId, give: parsed.data.give, get: parsed.data.get, message: parsed.data.message, actorUserId: user.id });
    return { tradeId: t.id };
  });
}

const tradeIds = z.object({ leagueId: uuid, tradeId: uuid });

export async function acceptTradeAction(leagueId: string, tradeId: string): Promise<TradeActionResult> {
  const user = await requireUser();
  if (!tradeIds.safeParse({ leagueId, tradeId }).success) return bad();
  return run(leagueId, async () => ({ status: (await acceptTrade(db, { tradeId, actorUserId: user.id })).status }));
}

export async function rejectTradeAction(leagueId: string, tradeId: string): Promise<TradeActionResult> {
  const user = await requireUser();
  if (!tradeIds.safeParse({ leagueId, tradeId }).success) return bad();
  return run(leagueId, () => rejectTrade(db, { tradeId, actorUserId: user.id }));
}

export async function cancelTradeAction(leagueId: string, tradeId: string): Promise<TradeActionResult> {
  const user = await requireUser();
  if (!tradeIds.safeParse({ leagueId, tradeId }).success) return bad();
  return run(leagueId, () => cancelTrade(db, { tradeId, actorUserId: user.id }));
}

export async function voteTradeAction(leagueId: string, tradeId: string, vote: "veto" | "approve"): Promise<TradeActionResult> {
  const user = await requireUser();
  if (!tradeIds.safeParse({ leagueId, tradeId }).success || (vote !== "veto" && vote !== "approve")) return bad();
  return run(leagueId, async () => ({ status: (await castVote(db, { tradeId, actorUserId: user.id, vote })).status }));
}

export async function approveTradeAction(leagueId: string, tradeId: string): Promise<TradeActionResult> {
  const user = await requireUser();
  if (!tradeIds.safeParse({ leagueId, tradeId }).success) return bad();
  return run(leagueId, () => commissionerApprove(db, { tradeId, actorUserId: user.id }));
}

export async function vetoTradeAction(leagueId: string, tradeId: string, reason?: string): Promise<TradeActionResult> {
  const user = await requireUser();
  if (!tradeIds.safeParse({ leagueId, tradeId }).success) return bad();
  return run(leagueId, () => commissionerVeto(db, { tradeId, actorUserId: user.id, reason }));
}

export async function forceCancelTradeAction(leagueId: string, tradeId: string, reason?: string): Promise<TradeActionResult> {
  const user = await requireUser();
  if (!tradeIds.safeParse({ leagueId, tradeId }).success) return bad();
  return run(leagueId, () => forceCancelTrade(db, { tradeId, actorUserId: user.id, reason }));
}

export async function reverseTradeAction(leagueId: string, tradeId: string, reason?: string): Promise<TradeActionResult> {
  const user = await requireUser();
  if (!tradeIds.safeParse({ leagueId, tradeId }).success) return bad();
  return run(leagueId, async () => ({ tradeId: (await commissionerReverse(db, { tradeId, actorUserId: user.id, reason })).id }));
}

export async function addToBlockAction(leagueId: string, teamId: string, playerId: number, note?: string): Promise<TradeActionResult> {
  const user = await requireUser();
  const parsed = z.object({ leagueId: uuid, teamId: uuid, playerId: z.number().int().positive(), note: z.string().max(200).optional() }).safeParse({ leagueId, teamId, playerId, note });
  if (!parsed.success) return bad();
  return run(leagueId, () => addToTradeBlock(db, { ...parsed.data, actorUserId: user.id }));
}

export async function removeFromBlockAction(leagueId: string, teamId: string, playerId: number): Promise<TradeActionResult> {
  const user = await requireUser();
  if (!z.object({ leagueId: uuid, teamId: uuid, playerId: z.number().int().positive() }).safeParse({ leagueId, teamId, playerId }).success) return bad();
  return run(leagueId, () => removeFromTradeBlock(db, { leagueId, teamId, playerId, actorUserId: user.id }));
}
