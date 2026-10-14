import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { fmtEtDateTime } from "@/lib/nba/format";
import { TRADE_STATUS_LABEL } from "@/lib/trades/labels";
import type { TradeSummary } from "@/lib/trades/service";
import { Countdown } from "./countdown";

function names(list: { name: string }[]) {
  return list.length === 0 ? "nothing" : list.map((p) => p.name).join(", ");
}

const VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  proposed: "outline",
  pending_review: "default",
  executed: "secondary",
  vetoed: "destructive",
  invalidated: "destructive",
};

/** One trade in a list: who offers what to whom, with status and a link to the detail page. */
export function TradeCard({
  trade,
  myTeamId,
  extra,
}: {
  trade: TradeSummary;
  myTeamId: string | null;
  extra?: React.ReactNode;
}) {
  const href = `/leagues/${trade.leagueId}/trades/${trade.id}`;
  const mine = myTeamId === trade.proposer.id ? "You" : trade.proposer.name;
  const them = myTeamId === trade.receiver.id ? "you" : trade.receiver.name;
  return (
    <Card size="sm" data-testid="trade-card" data-status={trade.status} data-trade-id={trade.id}>
      <CardContent className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={VARIANT[trade.status] ?? "secondary"}>{TRADE_STATUS_LABEL[trade.status]}</Badge>
          <span className="text-sm font-medium">
            {mine} &rarr; {them}
          </span>
          <span className="ml-auto text-xs text-muted-foreground">{fmtEtDateTime(trade.createdAt)}</span>
        </div>
        <p className="text-sm">
          <span className="text-muted-foreground">{trade.proposer.name} gives:</span> {names(trade.give)}
        </p>
        <p className="text-sm">
          <span className="text-muted-foreground">{trade.receiver.name} gives:</span> {names(trade.get)}
        </p>
        {trade.status === "pending_review" && trade.reviewEndsAt && (
          <p className="text-xs text-muted-foreground">
            <Countdown endsAt={trade.reviewEndsAt.toISOString()} label={`Review ends ${fmtEtDateTime(trade.reviewEndsAt)} ET`} />
            {trade.vetoVotes > 0 ? ` · ${trade.vetoVotes} veto vote${trade.vetoVotes === 1 ? "" : "s"}` : ""}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Link href={href} className="text-sm underline-offset-4 hover:underline" data-testid="trade-link">
            View trade
          </Link>
          {extra}
        </div>
      </CardContent>
    </Card>
  );
}
