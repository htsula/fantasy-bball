import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Countdown } from "@/components/trades/countdown";
import { TradeActions } from "@/components/trades/trade-actions";
import { TradePlayerTable } from "@/components/trades/player-table";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { fmtEtDateTime } from "@/lib/nba/format";
import { TRADE_STATUS_LABEL } from "@/lib/trades/labels";
import { getTrade, processDueTrades } from "@/lib/trades/service";

export const dynamic = "force-dynamic";

export default async function TradeDetailPage({ params }: { params: Promise<{ leagueId: string; tradeId: string }> }) {
  const { leagueId, tradeId } = await params;
  const { user, view } = await loadLeagueView(leagueId);
  const now = new Date();
  await processDueTrades(db, now, {}, { leagueId });
  const detail = await getTrade(db, leagueId, tradeId, user.id, now);
  if (!detail) notFound();
  const { trade } = detail;
  const myTeam = view.myTeam;
  const isProposer = myTeam?.id === trade.proposer.id;
  const isReceiver = myTeam?.id === trade.receiver.id;
  const isParty = isProposer || isReceiver;
  const open = trade.status === "proposed" || trade.status === "pending_review";
  const base = `/leagues/${leagueId}/trades`;

  const reviewActive =
    trade.status === "pending_review" && !!trade.reviewEndsAt && trade.reviewEndsAt > now;
  const flags = {
    canRespond: isReceiver && trade.status === "proposed",
    canCancel: isProposer && trade.status === "proposed",
    canVote: reviewActive && detail.reviewMode === "league_vote" && !!myTeam && !isParty && detail.myVote === null,
    canReview: view.isCommissioner && trade.status === "pending_review" && detail.reviewMode === "commissioner",
    canForceCancel: view.isCommissioner && open,
    canReverse: view.isCommissioner && detail.reversible,
    myTeamId: myTeam?.id ?? null,
  };

  const give = detail.players.filter((p) => p.fromTeamId === trade.proposer.id);
  const get = detail.players.filter((p) => p.fromTeamId === trade.receiver.id);

  const timeline: { at: Date; text: string }[] = [
    { at: trade.createdAt, text: `${trade.proposer.name} ${trade.counteredFrom ? "countered with an offer to" : "offered a trade to"} ${trade.receiver.name}` },
  ];
  if (trade.acceptedAt) timeline.push({ at: trade.acceptedAt, text: `${trade.receiver.name} accepted` });
  if (trade.reviewEndsAt && trade.acceptedAt) {
    timeline.push({
      at: trade.reviewEndsAt,
      text: `Review window ${trade.reviewEndsAt > now && trade.status === "pending_review" ? "ends" : "ended"}`,
    });
  }
  if (trade.respondedAt && !trade.acceptedAt) {
    timeline.push({ at: trade.respondedAt, text: TRADE_STATUS_LABEL[trade.status] });
  }
  if (trade.executedAt) timeline.push({ at: trade.executedAt, text: "Trade completed, rosters updated" });
  timeline.sort((a, b) => a.at.getTime() - b.at.getTime());

  const terminal = !open && trade.status !== "executed";

  return (
    <div className="grid gap-4" data-testid="trade-detail" data-status={trade.status}>
      <Link href={base} className={buttonVariants({ variant: "ghost", size: "sm" }) + " w-fit"}>
        &larr; All trades
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold">
          {trade.proposer.name} &harr; {trade.receiver.name}
        </h2>
        <Badge variant={trade.status === "executed" ? "secondary" : open ? "default" : "outline"} data-testid="trade-status">
          {TRADE_STATUS_LABEL[trade.status]}
        </Badge>
        {trade.kind === "reversal" && <Badge variant="outline">Reversal</Badge>}
      </div>
      {trade.message && (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="trade-message">
          <span className="text-muted-foreground">{trade.proposer.name}:</span> {trade.message}
        </p>
      )}
      {trade.resolvedReason && !open && (
        <p className="text-sm text-muted-foreground" data-testid="trade-reason">
          {trade.resolvedReason}
        </p>
      )}

      {trade.status === "pending_review" && trade.reviewEndsAt && (
        <Card size="sm" data-testid="review-card">
          <CardHeader>
            <CardTitle>{detail.reviewMode === "league_vote" ? "League vote" : "Commissioner review"}</CardTitle>
            <CardDescription>
              <Countdown endsAt={trade.reviewEndsAt.toISOString()} label={`Window ends ${fmtEtDateTime(trade.reviewEndsAt)} ET`} />
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-1 text-sm">
            {detail.reviewMode === "league_vote" ? (
              <>
                <p data-testid="veto-count">
                  {trade.vetoVotes} of {detail.vetoThreshold} veto vote{detail.vetoThreshold === 1 ? "" : "s"} needed to cancel
                  ({detail.eligibleVoters} team{detail.eligibleVoters === 1 ? "" : "s"} can vote).
                </p>
                <p className="text-muted-foreground">
                  {detail.myVote
                    ? `You voted ${detail.myVote === "veto" ? "to veto" : "to approve"}.`
                    : isParty
                      ? "You are part of this trade, so you can't vote."
                      : myTeam
                        ? "You haven't voted yet."
                        : ""}{" "}
                  If the veto threshold isn&apos;t reached, the trade goes through when the window ends.
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">
                The commissioner can approve or veto this trade. If nobody acts, it goes through automatically when the window ends.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="grid gap-2" aria-label={`${trade.proposer.name} gives`}>
          <h3 className="text-sm font-semibold">
            {trade.proposer.name} gives <span className="font-normal text-muted-foreground">(to {trade.receiver.name})</span>
          </h3>
          <TradePlayerTable players={give} testId="give-table" />
        </section>
        <section className="grid gap-2" aria-label={`${trade.receiver.name} gives`}>
          <h3 className="text-sm font-semibold">
            {trade.receiver.name} gives <span className="font-normal text-muted-foreground">(to {trade.proposer.name})</span>
          </h3>
          <TradePlayerTable players={get} testId="get-table" />
        </section>
      </div>

      <TradeActions leagueId={leagueId} tradeId={trade.id} flags={flags} />

      <Card size="sm">
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-1 text-sm" data-testid="trade-timeline">
            {timeline.map((e, i) => (
              <li key={i} className="flex flex-wrap gap-x-2">
                <span className="text-muted-foreground">{fmtEtDateTime(e.at)}</span>
                <span>{e.text}</span>
              </li>
            ))}
            {terminal && (
              <li className="flex flex-wrap gap-x-2">
                <span className="text-muted-foreground">{fmtEtDateTime(trade.respondedAt ?? trade.createdAt)}</span>
                <span>{TRADE_STATUS_LABEL[trade.status]}</span>
              </li>
            )}
          </ol>
          <div className="mt-2 flex flex-wrap gap-3 text-sm">
            {trade.counteredFrom && (
              <Link href={`${base}/${trade.counteredFrom}`} className="underline underline-offset-4">
                Original offer
              </Link>
            )}
            {detail.counteredBy && (
              <Link href={`${base}/${detail.counteredBy}`} className="underline underline-offset-4">
                Counteroffer
              </Link>
            )}
            {trade.reversedByTradeId && (
              <Link href={`${base}/${trade.reversedByTradeId}`} className="underline underline-offset-4">
                Reversal record
              </Link>
            )}
            {detail.reversalOf && (
              <Link href={`${base}/${detail.reversalOf}`} className="underline underline-offset-4">
                Reversed trade
              </Link>
            )}
          </div>
          {open && trade.status === "proposed" && (
            <p className="mt-2 text-xs text-muted-foreground">Expires {fmtEtDateTime(trade.expiresAt)} ET if nobody answers.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
