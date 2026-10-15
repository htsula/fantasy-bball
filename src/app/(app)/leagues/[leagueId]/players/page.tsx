import Link from "next/link";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { nbaPlayers, rosterEntries } from "@/db/schema";
import { PlayersBrowser, parsePlayerParams } from "@/components/players/players-browser";
import { AddPlayerButton, type RosterChoice } from "@/components/rosters/roster-controls";
import { buttonVariants } from "@/components/ui/button";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { fmtEtDateTime } from "@/lib/nba/format";
import { getAddsToday, leagueMaxRoster } from "@/lib/rosters/service";
import { isPastTradeDeadline } from "@/lib/trades/engine";

export const dynamic = "force-dynamic";

export default async function LeaguePlayersPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { leagueId } = await params;
  const { user, view } = await loadLeagueView(leagueId);
  const query = parsePlayerParams(await searchParams);
  const { league, settings, myTeam } = view;
  const open = league.status === "in_season" || league.status === "playoffs";
  const basePath = `/leagues/${leagueId}/players`;
  const tradingOpen = league.status === "in_season" && !isPastTradeDeadline(settings.tradeDeadline, new Date());

  let roster: RosterChoice[] = [];
  let max = 0;
  let adds: Awaited<ReturnType<typeof getAddsToday>> | null = null;
  if (myTeam && open) {
    const [rows, m, a] = await Promise.all([
      db
        .select({ id: nbaPlayers.id, name: nbaPlayers.fullName, positions: nbaPlayers.positions })
        .from(rosterEntries)
        .innerJoin(nbaPlayers, eq(nbaPlayers.id, rosterEntries.playerId))
        .where(and(eq(rosterEntries.teamId, myTeam.id), isNull(rosterEntries.releasedAt)))
        .orderBy(nbaPlayers.fullName),
      leagueMaxRoster(db, league),
      getAddsToday(db, myTeam.id, settings.addsPerDay),
    ]);
    roster = rows.map((r) => ({ id: r.id, name: r.name, detail: r.positions.join("/") || undefined }));
    max = m;
    adds = a;
  }
  const full = roster.length >= max;

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="text-xl font-semibold">Players</h2>
        {!open ? (
          <p className="text-sm text-muted-foreground" data-testid="fa-closed">
            Free agency opens once the draft is complete. You can still browse who is available.
          </p>
        ) : myTeam && adds ? (
          <p className="text-sm text-muted-foreground" data-testid="adds-status">
            <span className="font-medium text-foreground" data-testid="adds-left">
              Adds left today: {adds.remaining}/{adds.limit}
            </span>{" "}
            &middot; resets at midnight ET ({fmtEtDateTime(adds.resetsAt)}) &middot; roster {roster.length} / {max}
            {full ? " (full: adding requires dropping a player)" : ""}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">You don&apos;t have a team in this league, so you can browse only.</p>
        )}
      </div>
      <PlayersBrowser
        basePath={basePath}
        params={query}
        league={{ id: leagueId }}
        isAdmin={user.isSiteAdmin}
        renderAction={
          myTeam && open && adds
            ? (row) =>
                row.rosteredBy ? (
                  tradingOpen && row.rosteredBy.id !== myTeam.id ? (
                    <Link
                      href={`/leagues/${leagueId}/trades/new?with=${row.rosteredBy.id}&get=${row.id}`}
                      className={buttonVariants({ variant: "outline", size: "xs" })}
                      data-testid="trade-for-button"
                      aria-label={`Trade for ${row.fullName}`}
                    >
                      Trade for
                    </Link>
                  ) : null
                ) : !row.teamAbbrev ? null : (
                  <AddPlayerButton
                    leagueId={leagueId}
                    teamId={myTeam.id}
                    playerId={row.id}
                    playerName={row.fullName}
                    rosterFull={full}
                    roster={roster}
                    addsRemaining={adds.remaining}
                  />
                )
            : undefined
        }
      />
    </div>
  );
}
