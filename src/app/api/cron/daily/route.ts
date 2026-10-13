import { NextResponse } from "next/server";
import { verifyCronRequest } from "@/lib/cron";

export const dynamic = "force-dynamic";

// Placeholder: later milestones run NBA sync and nightly league jobs here.
export async function GET(req: Request) {
  if (!verifyCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ ok: true });
}
