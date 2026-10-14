import { NextResponse } from "next/server";
import { db } from "@/db";
import { getCurrentUser } from "@/lib/auth/session";
import { ChatError, listMessages, listPinned, parseCursor } from "@/lib/chat/service";

export const dynamic = "force-dynamic";

// Polled by the chat page (~10s). ?before=<cursor> loads an older page (no pinned list then).
export async function GET(req: Request, { params }: { params: Promise<{ leagueId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { leagueId } = await params;
  const url = new URL(req.url);
  const before = parseCursor(url.searchParams.get("before"));
  const limit = Number(url.searchParams.get("limit")) || undefined;
  try {
    const page = await listMessages(db, user, leagueId, { before, limit });
    const pinned = before ? [] : await listPinned(db, user, leagueId);
    return NextResponse.json({ ...page, pinned }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof ChatError) {
      return NextResponse.json({ error: err.code }, { status: err.code === "forbidden" ? 403 : 404 });
    }
    throw err;
  }
}
