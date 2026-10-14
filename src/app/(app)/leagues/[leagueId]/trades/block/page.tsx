import Link from "next/link";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { nbaPlayers, rosterEntries } from "@/db/schema";
import { InjuryBadge } from "@/components/nba/injury-badge";
import { BlockAddForm, BlockToggle } from "@/components/trades/block-controls";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { fmtNum } from "@/lib/nba/format";
import { isPastTradeDeadline } from "@/lib/trades/engine";
import { listTradeBlock } from "@/lib/trades/service";

export const dynamic = "force-dynamic";

export default async function TradeBlockPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const { view } = await loadLeagueView(leagueId);
  const { league, myTeam, settings } = view;
  const entries = await listTradeBlock(db, league);
  const tradingOpen = league.status === "in_season" && !isPastTradeDeadline(settings.tradeDeadline, new Date());
  const base = `/leagues/${leagueId}`;

  const mineIds = new Set(entries.filter((e) => e.teamId === myTeam?.id).map((e) => e.playerId));
  const candidates = myTeam
    ? (
        await db
          .select({ id: nbaPlayers.id, name: nbaPlayers.fullName })
          .from(rosterEntries)
          .innerJoin(nbaPlayers, eq(nbaPlayers.id, rosterEntries.playerId))
          .where(and(eq(rosterEntries.teamId, myTeam.id), isNull(rosterEntries.releasedAt)))
          .orderBy(nbaPlayers.fullName)
      ).filter((p) => !mineIds.has(p.id))
    : [];

  const byTeam = new Map<string, typeof entries>();
  for (const e of entries) byTeam.set(e.teamId, [...(byTeam.get(e.teamId) ?? []), e]);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold">Trade block</h2>
        <Link href={`${base}/trades`} className={buttonVariants({ variant: "outline", size: "sm" }) + " ml-auto"}>
          Back to trades
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        Players their owners are shopping. A player leaves the block automatically when he is traded or dropped.
      </p>

      {myTeam && (
        <Card size="sm">
          <CardHeader>
            <CardTitle>Add one of your players</CardTitle>
            <CardDescription>You can also use the Block button on your team page.</CardDescription>
          </CardHeader>
          <CardContent>
            <BlockAddForm leagueId={leagueId} teamId={myTeam.id} candidates={candidates} />
          </CardContent>
        </Card>
      )}

      {byTeam.size === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="block-empty">
          Nobody has listed a player yet.
        </p>
      )}
      <div className="grid gap-3" data-testid="block-list">
        {[...byTeam.entries()].map(([teamId, list]) => (
          <Card size="sm" key={teamId} data-testid="block-team">
            <CardHeader>
              <CardTitle>
                <Link href={`${base}/teams/${teamId}`} className="underline-offset-4 hover:underline">
                  {list[0].teamName}
                </Link>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              {list.map((e) => (
                <div key={e.playerId} className="flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-sm" data-testid="block-entry" data-player-id={e.playerId}>
                  <span className="font-medium">{e.name}</span>
                  <InjuryBadge status={e.injuryStatus} detail={e.injuryDetail} />
                  <span className="text-xs text-muted-foreground">
                    {e.nbaAbbrev ?? "FA"} &middot; {e.positions.join("/") || "-"} &middot; {fmtNum(e.seasonAvg)} FP/G &middot; proj {fmtNum(e.projection)} &middot;{" "}
                    <span data-testid="block-last-fp" title="Total fantasy points last season">last season {fmtNum(e.lastFp, 0)} FP</span>
                  </span>
                  {e.note && <span className="w-full text-xs italic text-muted-foreground">&ldquo;{e.note}&rdquo;</span>}
                  <span className="ml-auto flex items-center gap-1">
                    {myTeam && teamId !== myTeam.id && tradingOpen && (
                      <Link
                        href={`${base}/trades/new?with=${teamId}&get=${e.playerId}`}
                        className={buttonVariants({ variant: "outline", size: "xs" })}
                        data-testid="trade-for-block"
                      >
                        Trade for
                      </Link>
                    )}
                    {myTeam && teamId === myTeam.id && (
                      <BlockToggle leagueId={leagueId} teamId={teamId} playerId={e.playerId} playerName={e.name} onBlock />
                    )}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
