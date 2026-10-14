import { db } from "@/db";
import { DraftRoom } from "@/components/draft/draft-room";
import { getDraftBoard } from "@/lib/draft/board";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { listFilterOptions } from "@/lib/nba/players-query";

export const dynamic = "force-dynamic";

export default async function DraftPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const { user, view } = await loadLeagueView(leagueId);
  const [board, options] = await Promise.all([getDraftBoard(db, view.league.id, user.id), listFilterOptions(db)]);
  return (
    <DraftRoom
      initial={board}
      nbaTeams={options.teams.map((t) => ({ id: t.id, abbrev: t.abbrev }))}
    />
  );
}
