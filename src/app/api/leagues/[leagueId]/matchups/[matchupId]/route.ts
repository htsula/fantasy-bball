import { NextResponse } from "next/server";
import { db } from "@/db";
import { getCurrentUser } from "@/lib/auth/session";
import { LeagueError, getLeagueView } from "@/lib/leagues/service";
import { getMatchupBoxScore } from "@/lib/matchups/box-score";
import { MatchupError, loadMatchupContext } from "@/lib/matchups/service";
import { ensureFreshLive } from "@/lib/nba/sync";

export const dynamic = "force-dynamic";

// Polled by the matchup page every ~30s while a game is live. ?view=total or ?view=YYYY-MM-DD.
export async function GET(req: Request, { params }: { params: Promise<{ leagueId: string; matchupId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { leagueId, matchupId } = await params;
  try {
    await getLeagueView(db, user, leagueId); // membership check
    const ctx = await loadMatchupContext(db, matchupId);
    if (ctx.matchup.leagueId !== leagueId) throw new MatchupError("not_found");
    await ensureFreshLive(db);
    const view = new URL(req.url).searchParams.get("view");
    const box = await getMatchupBoxScore(db, matchupId, view ?? null);
    return NextResponse.json(box, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof LeagueError || err instanceof MatchupError) return NextResponse.json({ error: "not_found" }, { status: 404 });
    throw err;
  }
}
