import { NextResponse } from "next/server";
import { db } from "@/db";
import { verifyCronRequest } from "@/lib/cron";
import { processDueTrades } from "@/lib/trades/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Expires offers older than 7 days and closes trade review windows (executing or invalidating).
// /api/cron/daily, /api/cron/live and /api/cron/matchups run the same job; this is for manual triggers.
async function handle(req: Request) {
  if (!verifyCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const result = await processDueTrades(db);
  const ok = result.errors.length === 0;
  return NextResponse.json({ ok, trades: result }, { status: ok ? 200 : 500 });
}

export const GET = handle;
export const POST = handle;
