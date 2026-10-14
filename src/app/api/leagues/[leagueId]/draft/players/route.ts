import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { getCurrentUser } from "@/lib/auth/session";
import { DEFAULT_DRAFT_SORT, DRAFT_SORT_KEYS, listDraftablePlayers } from "@/lib/draft/board";
import { LeagueError, getLeagueView } from "@/lib/leagues/service";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

const query = z.object({
  q: z.string().trim().max(80).optional().catch(undefined),
  pos: z.string().max(3).optional().catch(undefined),
  team: z.coerce.number().int().positive().optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(100).catch(1),
  sort: z.enum(DRAFT_SORT_KEYS).catch(DEFAULT_DRAFT_SORT),
  dir: z.enum(["asc", "desc"]).optional().catch(undefined),
  size: z.coerce.number().int().min(1).max(50).catch(PAGE_SIZE),
});

export async function GET(req: Request, { params }: { params: Promise<{ leagueId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { leagueId } = await params;
  try {
    await getLeagueView(db, user, leagueId);
  } catch (err) {
    if (err instanceof LeagueError) return NextResponse.json({ error: "not_found" }, { status: 404 });
    throw err;
  }
  const url = new URL(req.url);
  const p = query.parse(Object.fromEntries(url.searchParams));
  const result = await listDraftablePlayers(db, leagueId, {
    q: p.q,
    pos: p.pos,
    team: p.team,
    sort: p.sort,
    dir: p.dir,
    limit: p.size,
    offset: (p.page - 1) * p.size,
  });
  return NextResponse.json(
    { ...result, page: p.page, pageSize: p.size, pageCount: Math.max(1, Math.ceil(result.total / p.size)) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
