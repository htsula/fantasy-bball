import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { buttonVariants } from "@/components/ui/button";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { getFocusPeriod, getMatchupForTeam } from "@/lib/matchups/service";

export const dynamic = "force-dynamic";

// /matchup -> my matchup in the current period (or the next/last one outside the season).
export default async function MyMatchupRedirect({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const { view } = await loadLeagueView(leagueId);
  const base = `/leagues/${view.league.id}`;
  const period = await getFocusPeriod(db, view.league.id);
  if (period && view.myTeam) {
    const m = await getMatchupForTeam(db, period.id, view.myTeam.id);
    if (m) redirect(`${base}/matchup/${m.id}`);
  }
  if (period) redirect(`${base}/scoreboard?period=${period.number}`);
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">There is no schedule yet, so there are no matchups. The commissioner generates it before the draft.</p>
      <Link href={`${base}/schedule`} className={buttonVariants({ variant: "outline", size: "sm" }) + " w-fit"}>
        Go to the schedule
      </Link>
    </div>
  );
}
