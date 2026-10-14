import { NextResponse } from "next/server";
import { db } from "@/db";
import { verifyCronRequest } from "@/lib/cron";
import { emptyNightlyResult, runNightlyMatchupJob } from "@/lib/matchups/service";
import { createEspnClient } from "@/lib/nba/espn";
import { syncCorrections, syncDaily } from "@/lib/nba/sync";
import { log } from "@/lib/log";
import { processDueTrades } from "@/lib/trades/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Vercel Cron issues GET; POST is accepted for manual triggers.
async function handle(req: Request) {
  if (!verifyCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const started = Date.now();
  const client = createEspnClient();
  let daily, corrections;
  try {
    daily = await syncDaily(db, client, { budgetMs: 40_000 });
    corrections = await syncCorrections(db, client);
  } catch (err) {
    log.error("cron.daily.crashed", { durationMs: Date.now() - started }, err);
    return NextResponse.json({ ok: false, error: "daily sync crashed (see logs: event cron.daily.crashed)" }, { status: 500 });
  }
  // After the NBA data is as fresh as it will get: finalize ended matchup periods and refresh standings.
  // A failure here must not hide the sync results, so it is reported rather than thrown.
  const matchups = await runNightlyMatchupJob(db).catch((err) =>
    emptyNightlyResult([err instanceof Error ? err.message : String(err)]),
  );
  // Expire old offers and close trade review windows (also done by /api/cron/live and on page loads).
  const tradeJob = await processDueTrades(db).catch((err) => ({
    expired: 0,
    executed: 0,
    vetoed: 0,
    invalidated: 0,
    errors: [err instanceof Error ? err.message : String(err)],
  }));
  const ok = daily.ok && corrections.ok && matchups.errors.length === 0 && tradeJob.errors.length === 0;
  log[ok ? "info" : "error"]("cron.daily", { ok, durationMs: Date.now() - started, daily, corrections, matchups, trades: tradeJob });
  return NextResponse.json({ ok, daily, corrections, matchups, trades: tradeJob }, { status: ok ? 200 : 500 });
}

export const GET = handle;
export const POST = handle;
