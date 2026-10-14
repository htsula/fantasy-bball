import { NextResponse } from "next/server";
import { db } from "@/db";
import { getCurrentUser } from "@/lib/auth/session";
import { chatUnreadCount } from "@/lib/chat/service";

export const dynamic = "force-dynamic";

// Polled by the league nav badge (~30s).
export async function GET(_req: Request, { params }: { params: Promise<{ leagueId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { leagueId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(leagueId)) return NextResponse.json({ count: 0 });
  return NextResponse.json({ count: await chatUnreadCount(db, user.id, leagueId) }, { headers: { "Cache-Control": "no-store" } });
}
