import { NbaScoreboard } from "@/components/nba/nba-scoreboard";
import { loadLeagueView } from "@/lib/leagues/loaders";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** The site-wide NBA scoreboard, inside the league so its header and tabs stay put. */
export default async function LeagueNbaScoreboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { leagueId } = await params;
  const { view } = await loadLeagueView(leagueId);
  return <NbaScoreboard searchParams={searchParams} basePath={`/leagues/${view.league.id}/nba-scoreboard`} inLeague />;
}
