import { NextResponse } from "next/server";
import { db, resolvePgliteDataDir } from "@/db";
import { verifyCronRequest } from "@/lib/cron";
import { runNightlyMatchupJob } from "@/lib/matchups/service";
import { processDueTrades } from "@/lib/trades/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Runs only the matchup/standings part of the nightly job (no NBA network calls). Handy for manual
// triggers and tests; /api/cron/daily runs the same job after its syncs.
async function handle(req: Request) {
  if (!verifyCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  // ?leagueId=<id> limits the run to one league. Test hook: ?now=<ISO instant> runs the job as of that
  // moment, only against a local PGlite database (dev/e2e) so it can never time-travel a real league.
  const params = new URL(req.url).searchParams;
  const nowParam = params.get("now");
  const asOf = nowParam && resolvePgliteDataDir() !== null ? new Date(nowParam) : null;
  const result = await runNightlyMatchupJob(
    db,
    asOf && !Number.isNaN(asOf.getTime()) ? asOf : new Date(),
    {},
    { leagueId: /^[0-9a-f-]{36}$/i.test(params.get("leagueId") ?? "") ? params.get("leagueId")! : undefined },
  );
  const tradeJob = await processDueTrades(db);
  const ok = result.errors.length === 0 && tradeJob.errors.length === 0;
  return NextResponse.json({ ok, matchups: result, trades: tradeJob }, { status: ok ? 200 : 500 });
}

export const GET = handle;
export const POST = handle;
