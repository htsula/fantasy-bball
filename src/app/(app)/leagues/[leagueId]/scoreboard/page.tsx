import Link from "next/link";
import { db } from "@/db";
import { AutoRefresh } from "@/components/nba/auto-refresh";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { getSchedule } from "@/lib/leagues/service";
import { matchupStatusLabel, periodLabel } from "@/lib/matchups/labels";
import { getFocusPeriod, getPeriodScoreboard } from "@/lib/matchups/service";
import { fmtNum, fmtYmd } from "@/lib/nba/format";
import { ensureFreshLive } from "@/lib/nba/sync";

export const dynamic = "force-dynamic";

export default async function ScoreboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { leagueId } = await params;
  const { period: periodParam } = await searchParams;
  const { view } = await loadLeagueView(leagueId);
  const base = `/leagues/${view.league.id}`;
  const { periods } = await getSchedule(db, view.league.id);
  if (periods.length === 0) {
    return <p className="text-sm text-muted-foreground">The schedule hasn&apos;t been generated yet.</p>;
  }
  const now = new Date();
  const requested = periods.find((p) => p.number === Number(periodParam));
  const defaultPeriod = requested ?? (await getFocusPeriod(db, view.league.id, now));
  const period = periods.find((p) => p.id === defaultPeriod?.id) ?? periods[0];

  await ensureFreshLive(db);
  const entries = period.matchups.length === 0 ? [] : await getPeriodScoreboard(db, period.id, now);
  const names = new Map(view.teams.map((t) => [t.id, t.name]));
  const anyLive = entries.some((e) => e.matchup.status === "live");
  const prev = periods.find((p) => p.number === period.number - 1);
  const next = periods.find((p) => p.number === period.number + 1);
  const label = (p: { number: number; isPlayoff: boolean; playoffRound: number | null }) => periodLabel(p, periods);

  return (
    <div className="grid gap-4">
      {anyLive && <AutoRefresh seconds={45} />}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold" data-testid="scoreboard-title">
          {label(period)}
        </h2>
        <span className="text-sm text-muted-foreground">
          {fmtYmd(period.startDate)} - {fmtYmd(period.endDate)}
        </span>
        <nav className="ml-auto flex gap-1" aria-label="Period navigation">
          {prev ? (
            <Link href={`${base}/scoreboard?period=${prev.number}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Previous
            </Link>
          ) : null}
          {next ? (
            <Link href={`${base}/scoreboard?period=${next.number}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Next
            </Link>
          ) : null}
        </nav>
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {period.isPlayoff ? "Playoff matchups are set as the bracket fills in." : "No matchups this period."}
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {entries.map(({ matchup, totals }) => {
            const mine = view.myTeam && (matchup.homeTeamId === view.myTeam.id || matchup.awayTeamId === view.myTeam.id);
            const rows = [totals.home, totals.away].filter((t): t is NonNullable<typeof t> => t !== null);
            return (
              <Card key={matchup.id} size="sm" data-testid="scoreboard-matchup" data-status={matchup.status} data-mine={mine ? "true" : undefined}>
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge variant={matchup.status === "final" ? "secondary" : "outline"}>{matchupStatusLabel(matchup.status, period.endDate, now)}</Badge>
                    {mine && <Badge variant="outline">You</Badge>}
                    {!matchup.awayTeamId && <Badge variant="outline">Bye</Badge>}
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid gap-2">
                  {rows.map((t) => (
                    <div
                      key={t.teamId}
                      className={`flex items-baseline justify-between gap-2 rounded-md px-2 py-1 ${matchup.winnerTeamId === t.teamId ? "bg-primary/10 font-semibold" : ""}`}
                      data-testid="scoreboard-team"
                    >
                      <span>{names.get(t.teamId) ?? "Unknown team"}</span>
                      <span className="flex items-baseline gap-3">
                        {matchup.status !== "final" && (
                          <span className="text-xs font-normal text-muted-foreground">
                            proj {fmtNum(t.projected, 1)} &middot; {t.gamesRemaining} left
                          </span>
                        )}
                        <span className="text-lg tabular-nums" data-testid="scoreboard-points">
                          {fmtNum(t.points, 1)}
                        </span>
                      </span>
                    </div>
                  ))}
                  <Link href={`${base}/matchup/${matchup.id}`} className={buttonVariants({ variant: "outline", size: "sm" }) + " w-fit"}>
                    Box score
                  </Link>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
