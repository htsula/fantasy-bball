import { NextResponse } from "next/server";
import { db } from "@/db";
import { getCurrentUser } from "@/lib/auth/session";
import { getDraftBoard } from "@/lib/draft/board";
import { LeagueError, getLeagueView } from "@/lib/leagues/service";

export const dynamic = "force-dynamic";

// Polled by the draft room every ~10s.
export async function GET(_req: Request, { params }: { params: Promise<{ leagueId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { leagueId } = await params;
  try {
    await getLeagueView(db, user, leagueId); // membership check
  } catch (err) {
    if (err instanceof LeagueError) return NextResponse.json({ error: "not_found" }, { status: 404 });
    throw err;
  }
  const board = await getDraftBoard(db, leagueId, user.id);
  return NextResponse.json(board, { headers: { "Cache-Control": "no-store" } });
}
