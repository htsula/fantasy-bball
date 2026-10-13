import { NextResponse } from "next/server";
import { db } from "@/db";
import { verifyCronRequest } from "@/lib/cron";
import { createEspnClient } from "@/lib/nba/espn";
import { syncLive } from "@/lib/nba/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Called every 5 minutes by GitHub Actions during game hours (Vercel Hobby cron is daily only).
async function handle(req: Request) {
  if (!verifyCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const live = await syncLive(db, createEspnClient());
  return NextResponse.json({ ok: live.ok, live }, { status: live.ok ? 200 : 500 });
}

export const GET = handle;
export const POST = handle;
