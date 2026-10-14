import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { tradeVotes } from "@/db/schema";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { TradeActions } from "@/components/trades/trade-actions";
import { TradeCard } from "@/components/trades/trade-card";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { fmtYmd } from "@/lib/nba/format";
import { eligibleVoterCount, isPastTradeDeadline } from "@/lib/trades/engine";
import { processDueTrades, listLeagueTrades } from "@/lib/trades/service";

export const dynamic = "force-dynamic";

const TABS = ["received", "sent", "league", "history"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = { received: "Received", sent: "Sent", league: "League", history: "History" };

export default async function TradesPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { leagueId } = await params;
  const { tab: tabParam } = await searchParams;
  const { view } = await loadLeagueView(leagueId);
  const tab: Tab = (TABS as readonly string[]).includes(tabParam ?? "") ? (tabParam as Tab) : "received";
  const { league, settings, myTeam } = view;
  const now = new Date();

  // Lazy close of review windows / expiry, so things move promptly even without a cron run.
  await processDueTrades(db, now, {}, { leagueId });
  const all = await listLeagueTrades(db, leagueId, { excludeReversals: true });
  const myVotes = myTeam
    ? new Set((await db.select({ id: tradeVotes.tradeId }).from(tradeVotes).where(eq(tradeVotes.teamId, myTeam.id))).map((v) => v.id))
    : new Set<string>();

  const received = myTeam ? all.filter((t) => t.status === "proposed" && t.receiver.id === myTeam.id) : [];
  const sent = myTeam ? all.filter((t) => t.status === "proposed" && t.proposer.id === myTeam.id) : [];
  const review = all.filter((t) => t.status === "pending_review");
  const history = all.filter((t) => t.status !== "proposed" && t.status !== "pending_review");
  const lists: Record<Tab, typeof all> = { received, sent, league: review, history };
  const counts: Record<Tab, number> = { received: received.length, sent: sent.length, league: review.length, history: history.length };

  const base = `/leagues/${leagueId}/trades`;
  const open = league.status === "in_season";
  const deadlinePassed = isPastTradeDeadline(settings.tradeDeadline, now);
  const voteMode = settings.tradeReview === "league_vote" && settings.tradeReviewHours > 0;
  const eligible = eligibleVoterCount(view.teams.length);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold">Trades</h2>
        {myTeam && open && !deadlinePassed && (
          <Link href={`${base}/new`} className={buttonVariants({ size: "sm" }) + " ml-auto"} data-testid="new-trade">
            Propose a trade
          </Link>
        )}
        <Link href={`${base}/block`} className={buttonVariants({ variant: "outline", size: "sm" }) + (myTeam && open ? "" : " ml-auto")}>
          Trade block
        </Link>
      </div>
      <p className="text-sm text-muted-foreground" data-testid="trade-status-note">
        {!open
          ? "Trades are only open during the regular season."
          : deadlinePassed
            ? `The trade deadline (${fmtYmd(settings.tradeDeadline!, true)}) has passed.`
            : settings.tradeDeadline
              ? `Trades are open until the end of ${fmtYmd(settings.tradeDeadline, true)} (ET).`
              : "Trades are open (no deadline)."}{" "}
        {settings.tradeReview === "none" || settings.tradeReviewHours === 0
          ? "Accepted trades go through immediately."
          : settings.tradeReview === "commissioner"
            ? `Accepted trades wait up to ${settings.tradeReviewHours}h for the commissioner to approve or veto, then go through automatically.`
            : `Accepted trades wait ${settings.tradeReviewHours}h for a league vote: ${Math.min(settings.vetoVotesNeeded, eligible)} veto vote${Math.min(settings.vetoVotesNeeded, eligible) === 1 ? "" : "s"} cancel it.`}{" "}
        Trades don&apos;t count against the daily add limit.
      </p>

      <nav className="flex flex-wrap gap-1" aria-label="Trade tabs">
        {TABS.map((t) => (
          <Link
            key={t}
            href={t === "received" ? base : `${base}?tab=${t}`}
            aria-current={t === tab ? "true" : undefined}
            className={buttonVariants({ variant: t === tab ? "secondary" : "ghost", size: "sm" })}
            data-testid={`tab-${t}`}
          >
            {TAB_LABEL[t]}
            {counts[t] > 0 && (
              <Badge variant={t === "received" || t === "league" ? "default" : "outline"} className="ml-1" data-testid={`tab-count-${t}`}>
                {counts[t]}
              </Badge>
            )}
          </Link>
        ))}
      </nav>

      <div className="grid gap-3" data-testid={`trade-list-${tab}`}>
        {lists[tab].length === 0 && (
          <p className="text-sm text-muted-foreground" data-testid="trade-empty">
            {tab === "received" && "No offers waiting for you. Offers from other teams show up here."}
            {tab === "sent" && "You have no open offers. Use \"Propose a trade\" or check the trade block for players on the market."}
            {tab === "league" && "No trades are under review right now."}
            {tab === "history" && "No finished trades yet."}
          </p>
        )}
        {lists[tab].map((t) => {
          const party = myTeam ? t.proposer.id === myTeam.id || t.receiver.id === myTeam.id : false;
          const canVote = tab === "league" && voteMode && !!myTeam && !party && !myVotes.has(t.id) && !!t.reviewEndsAt && t.reviewEndsAt > now;
          return (
            <TradeCard
              key={t.id}
              trade={t}
              myTeamId={myTeam?.id ?? null}
              extra={
                canVote ? (
                  <TradeActions
                    leagueId={leagueId}
                    tradeId={t.id}
                    flags={{ canRespond: false, canCancel: false, canVote: true, canReview: false, canForceCancel: false, canReverse: false, myTeamId: myTeam?.id ?? null }}
                  />
                ) : undefined
              }
            />
          );
        })}
      </div>
    </div>
  );
}
