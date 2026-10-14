import { NextResponse } from "next/server";
import { db } from "@/db";
import { getCurrentUser } from "@/lib/auth/session";
import { unreadCount } from "@/lib/notifications/service";

export const dynamic = "force-dynamic";

// Polled by the header bell (SWR, ~30s).
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ count: await unreadCount(db, user.id) }, { headers: { "Cache-Control": "no-store" } });
}
