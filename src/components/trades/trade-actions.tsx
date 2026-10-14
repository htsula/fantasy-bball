"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  acceptTradeAction,
  approveTradeAction,
  cancelTradeAction,
  forceCancelTradeAction,
  rejectTradeAction,
  reverseTradeAction,
  vetoTradeAction,
  voteTradeAction,
  type TradeActionResult,
} from "@/app/(app)/leagues/[leagueId]/trades/actions";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type TradeActionFlags = {
  /** I'm the receiver and the offer is open. */
  canRespond: boolean;
  /** I'm the proposer and the offer is open. */
  canCancel: boolean;
  /** I may cast a league-vote veto/approve. */
  canVote: boolean;
  /** Commissioner review actions (approve / veto). */
  canReview: boolean;
  /** Commissioner can force-cancel an open trade. */
  canForceCancel: boolean;
  /** Commissioner can reverse an executed trade (within 48h). */
  canReverse: boolean;
  myTeamId: string | null;
};

export function TradeActions({ leagueId, tradeId, flags }: { leagueId: string; tradeId: string; flags: TradeActionFlags }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const run = (fn: () => Promise<TradeActionResult>, success: string) => {
    setError(null);
    start(async () => {
      const res = await fn();
      if (res.ok) toast.success(success);
      else setError(res.error);
      router.refresh();
    });
  };
  const r = reason.trim() || undefined;
  const nothing =
    !flags.canRespond && !flags.canCancel && !flags.canVote && !flags.canReview && !flags.canForceCancel && !flags.canReverse;
  if (nothing) return null;
  const isCommissioner = flags.canReview || flags.canForceCancel || flags.canReverse;

  return (
    <div className="grid gap-3" data-testid="trade-actions">
      {error && (
        <div role="alert" className="grid gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="trade-error">
          <p>{error}</p>
          {/Drop players first/.test(error) && flags.myTeamId && (
            <Link href={`/leagues/${leagueId}/teams/${flags.myTeamId}`} className="w-fit underline underline-offset-4">
              Go to my team to drop players
            </Link>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {flags.canRespond && (
          <>
            <Button disabled={pending} onClick={() => run(() => acceptTradeAction(leagueId, tradeId), "Trade accepted")} data-testid="accept-trade">
              Accept
            </Button>
            <Link
              href={`/leagues/${leagueId}/trades/new?counter=${tradeId}`}
              className={buttonVariants({ variant: "outline" })}
              data-testid="counter-trade"
            >
              Counter
            </Link>
            <Button variant="outline" disabled={pending} onClick={() => run(() => rejectTradeAction(leagueId, tradeId), "Trade rejected")} data-testid="reject-trade">
              Reject
            </Button>
          </>
        )}
        {flags.canCancel && (
          <Button variant="outline" disabled={pending} onClick={() => run(() => cancelTradeAction(leagueId, tradeId), "Offer cancelled")} data-testid="cancel-trade">
            Cancel offer
          </Button>
        )}
        {flags.canVote && (
          <>
            <Button variant="destructive" disabled={pending} onClick={() => run(() => voteTradeAction(leagueId, tradeId, "veto"), "Veto vote cast")} data-testid="vote-veto">
              Vote to veto
            </Button>
            <Button variant="outline" disabled={pending} onClick={() => run(() => voteTradeAction(leagueId, tradeId, "approve"), "Approval recorded")} data-testid="vote-approve">
              Approve
            </Button>
          </>
        )}
      </div>
      {isCommissioner && (
        <div className="grid gap-2 rounded-lg border p-3" data-testid="commissioner-trade-actions">
          <p className="text-sm font-medium">Commissioner</p>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Reason (optional)" aria-label="Reason" />
          <div className="flex flex-wrap gap-2">
            {flags.canReview && (
              <>
                <Button disabled={pending} onClick={() => run(() => approveTradeAction(leagueId, tradeId), "Trade approved")} data-testid="approve-trade">
                  Approve trade
                </Button>
                <Button variant="destructive" disabled={pending} onClick={() => run(() => vetoTradeAction(leagueId, tradeId, r), "Trade vetoed")} data-testid="veto-trade">
                  Veto trade
                </Button>
              </>
            )}
            {flags.canForceCancel && (
              <Button variant="outline" disabled={pending} onClick={() => run(() => forceCancelTradeAction(leagueId, tradeId, r), "Trade cancelled")} data-testid="force-cancel-trade">
                Force cancel
              </Button>
            )}
            {flags.canReverse && (
              <Button variant="destructive" disabled={pending} onClick={() => run(() => reverseTradeAction(leagueId, tradeId, r), "Trade reversed")} data-testid="reverse-trade">
                Reverse trade
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
