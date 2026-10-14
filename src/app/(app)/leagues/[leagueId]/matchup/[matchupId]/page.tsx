import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { BoxScoreView } from "@/components/matchups/box-score-view";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { getMatchupBoxScore, parseView } from "@/lib/matchups/box-score";
import { matchupStatusLabel, periodLabel } from "@/lib/matchups/labels";
import { listPeriodsLite } from "@/lib/playoffs/service";
import { MatchupError, loadMatchupContext } from "@/lib/matchups/service";
import { etDateString } from "@/lib/nba/dates";
import { fmtYmd } from "@/lib/nba/format";
import { ensureFreshLive } from "@/lib/nba/sync";

export const dynamic = "force-dynamic";

export default async function MatchupPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string; matchupId: string }>;
  searchParams: Promise<{ day?: string }>;
}) {
  const { leagueId, matchupId } = await params;
  const { day } = await searchParams;
  const { view } = await loadLeagueView(leagueId);
  let ctx;
  try {
    ctx = await loadMatchupContext(db, matchupId);
  } catch (err) {
    if (err instanceof MatchupError) notFound();
    throw err;
  }
  if (ctx.matchup.leagueId !== view.league.id) notFound();

  await ensureFreshLive(db); // lazy refresh of live scores when stale (never throws)
  const now = new Date();
  const today = etDateString(now);
  const initialView = day ? parseView(day, ctx.period, today) : null;
  const box = await getMatchupBoxScore(db, matchupId, initialView, now);
  const base = `/leagues/${view.league.id}`;
  const label = periodLabel(box.period, await listPeriodsLite(db, view.league.id));
  const statusLabel = matchupStatusLabel(box.matchup.status, box.period.endDate, now);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold">{label}</h2>
        <Badge variant={box.matchup.status === "final" ? "secondary" : "outline"} data-testid="matchup-status">
          {statusLabel}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {fmtYmd(box.period.startDate)} - {fmtYmd(box.period.endDate)}
        </span>
        <Link
          href={`${base}/scoreboard?period=${box.period.number}`}
          className={buttonVariants({ variant: "ghost", size: "xs" }) + " ml-auto"}
        >
          Scoreboard
        </Link>
      </div>
      <BoxScoreView leagueId={view.league.id} initial={box} myTeamId={view.myTeam?.id ?? null} />
    </div>
  );
}
