import Link from "next/link";
import { db } from "@/db";
import { buttonVariants } from "@/components/ui/button";
import { seasonChoiceFor } from "@/lib/fantasy/stats-query";
import { TradeBuilder } from "@/components/trades/trade-builder";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { fmtYmd } from "@/lib/nba/format";
import { leagueMaxRoster } from "@/lib/rosters/service";
import { isPastTradeDeadline } from "@/lib/trades/engine";
import { getTrade, listRosterForTrade, processDueTrades } from "@/lib/trades/service";

export const dynamic = "force-dynamic";

const ids = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((x) => Number(x))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 60);

export default async function NewTradePage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string }>;
  searchParams: Promise<{ with?: string; get?: string; give?: string; counter?: string }>;
}) {
  const { leagueId } = await params;
  const q = await searchParams;
  const { view } = await loadLeagueView(leagueId);
  const { league, settings, myTeam } = view;
  const base = `/leagues/${leagueId}/trades`;

  const back = (
    <Link href={base} className={buttonVariants({ variant: "outline", size: "sm" }) + " w-fit"}>
      Back to trades
    </Link>
  );
  const note = (text: string) => (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground" data-testid="trade-closed">
        {text}
      </p>
      {back}
    </div>
  );

  if (!myTeam) return note("You don't have a team in this league, so you can't trade.");
  if (league.status !== "in_season") return note("Trades are only open during the regular season.");
  if (isPastTradeDeadline(settings.tradeDeadline, new Date())) {
    return note(`The trade deadline (${fmtYmd(settings.tradeDeadline!, true)}) has passed.`);
  }

  let partnerId = q.with ?? null;
  let initialGive = ids(q.give);
  let initialGet = ids(q.get);
  const message = "";
  let counterOf: string | null = null;

  if (q.counter) {
    await processDueTrades(db, new Date(), {}, { leagueId });
    const original = await getTrade(db, leagueId, q.counter, null);
    if (!original || original.trade.status !== "proposed" || original.trade.receiver.id !== myTeam.id) {
      return note("That offer can't be countered (it's gone, already answered, or not addressed to you).");
    }
    counterOf = original.trade.id;
    partnerId = original.trade.proposer.id;
    // Prefill with the mirror image of the offer: I give what they asked for, I get what they offered.
    initialGive = original.trade.get.map((p) => p.playerId);
    initialGet = original.trade.give.map((p) => p.playerId);
  }

  const others = view.teams.filter((t) => t.id !== myTeam.id);
  const partner = others.find((t) => t.id === partnerId) ?? null;
  const seasonInfo = await seasonChoiceFor(db, league.season, new Date());
  const [myRoster, theirRoster, max] = await Promise.all([
    listRosterForTrade(db, league, myTeam.id),
    partner ? listRosterForTrade(db, league, partner.id) : Promise.resolve([]),
    leagueMaxRoster(db, league),
  ]);
  const myIds = new Set(myRoster.map((p) => p.playerId));
  const theirIds = new Set(theirRoster.map((p) => p.playerId));

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="text-xl font-semibold">{counterOf ? "Counteroffer" : "Propose a trade"}</h2>
        <p className="text-sm text-muted-foreground">
          Pick any number of players on each side (uneven trades are fine). Both rosters must be at or under {max} players after
          the trade; nobody is dropped automatically.
        </p>
      </div>
      <TradeBuilder
        key={`${partner?.id ?? "none"}-${counterOf ?? "new"}`}
        leagueId={leagueId}
        myTeam={{ id: myTeam.id, name: myTeam.name }}
        partner={partner ? { id: partner.id, name: partner.name } : null}
        otherTeams={others.map((t) => ({ id: t.id, name: t.name }))}
        myRoster={myRoster}
        theirRoster={theirRoster}
        max={max}
        initialGive={initialGive.filter((id) => myIds.has(id))}
        initialGet={initialGet.filter((id) => theirIds.has(id))}
        initialMessage={message}
        counterOf={counterOf}
        seasons={{ current: seasonInfo.current, previous: seasonInfo.previous, default: seasonInfo.default }}
      />
    </div>
  );
}
