/**
 * Invalidates open trades (proposed / pending_review) that include given players. Kept free of any
 * import from the roster service so the roster service can call it from inside its own
 * transaction (which already holds the league lock) without a circular dependency.
 */
import { and, eq, inArray } from "drizzle-orm";
import { teams, tradeItems, trades } from "@/db/schema";
import type { Db } from "@/db/types";
import type { NotifyInput } from "@/lib/notifications/types";

export const tradeUrl = (leagueId: string, tradeId: string) => `/leagues/${leagueId}/trades/${tradeId}`;

export const INVALIDATION_REASONS = {
  player_dropped: "A player in the trade was dropped.",
  player_moved: "A player in the trade is no longer on the team that was offering him.",
  player_cut: "A player in the trade was cut by the NBA.",
  roster_full: "A team would have been over the roster maximum when the trade executed.",
  league_closed: "The league is no longer in the regular season.",
} as const;
export type InvalidationReason = keyof typeof INVALIDATION_REASONS;

/** Marks a single open trade invalidated and returns the notification for both parties. */
export async function invalidateTradeRow(
  tx: Db,
  trade: { id: string; leagueId: string; proposerTeamId: string; receiverTeamId: string },
  reason: InvalidationReason,
  now: Date,
): Promise<NotifyInput> {
  await tx
    .update(trades)
    .set({ status: "invalidated", resolvedReason: INVALIDATION_REASONS[reason], updatedAt: now })
    .where(eq(trades.id, trade.id));
  const owners = await tx
    .select({ ownerId: teams.ownerId })
    .from(teams)
    .where(inArray(teams.id, [trade.proposerTeamId, trade.receiverTeamId]));
  return {
    userIds: owners.map((o) => o.ownerId),
    leagueId: trade.leagueId,
    type: "trade_updates",
    title: "Trade no longer valid",
    body: `A trade was cancelled automatically. ${INVALIDATION_REASONS[reason]}`,
    url: tradeUrl(trade.leagueId, trade.id),
  };
}

/**
 * Invalidates every open trade in the league that includes any of `playerIds`. Call inside a
 * transaction that holds the league row lock. Returns notifications to send AFTER commit.
 */
export async function invalidateOpenTradesForPlayers(
  tx: Db,
  leagueId: string,
  playerIds: number[],
  reason: InvalidationReason,
  now: Date,
  opts: { excludeTradeId?: string } = {},
): Promise<NotifyInput[]> {
  if (playerIds.length === 0) return [];
  const open = await tx
    .selectDistinct({
      id: trades.id,
      leagueId: trades.leagueId,
      proposerTeamId: trades.proposerTeamId,
      receiverTeamId: trades.receiverTeamId,
    })
    .from(trades)
    .innerJoin(tradeItems, eq(tradeItems.tradeId, trades.id))
    .where(
      and(
        eq(trades.leagueId, leagueId),
        inArray(trades.status, ["proposed", "pending_review"]),
        inArray(tradeItems.playerId, playerIds),
      ),
    );
  const notices: NotifyInput[] = [];
  for (const t of open) {
    if (t.id === opts.excludeTradeId) continue;
    notices.push(await invalidateTradeRow(tx, t, reason, now));
  }
  return notices;
}
