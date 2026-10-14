import { NextResponse } from "next/server";
import { db } from "@/db";
import { verifyCronRequest } from "@/lib/cron";
import { createEspnClient } from "@/lib/nba/espn";
import { syncLive } from "@/lib/nba/sync";
import { log } from "@/lib/log";
import { processDueTrades } from "@/lib/trades/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Called every 5 minutes by GitHub Actions during game hours (Vercel Hobby cron is daily only).
async function handle(req: Request) {
  if (!verifyCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const started = Date.now();
  let live;
  try {
    live = await syncLive(db, createEspnClient());
  } catch (err) {
    log.error("cron.live.crashed", { durationMs: Date.now() - started }, err);
    return NextResponse.json({ ok: false, error: "live sync crashed (see logs: event cron.live.crashed)" }, { status: 500 });
  }
  // One cheap query when nothing is due; closes trade review windows promptly during game hours.
  // Never affects the live-sync status.
  const tradeJob = await processDueTrades(db).catch((err) => ({ error: err instanceof Error ? err.message : String(err) }));
  const body = { ok: live.ok, live, trades: tradeJob };
  log[live.ok ? "info" : "error"]("cron.live", { ok: live.ok, durationMs: Date.now() - started, live, trades: tradeJob });
  return NextResponse.json(body, { status: live.ok ? 200 : 500 });
}

export const GET = handle;
export const POST = handle;
