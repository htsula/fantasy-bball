import { NextResponse } from "next/server";
import { db } from "@/db";
import { verifyCronRequest } from "@/lib/cron";
import { createEspnClient } from "@/lib/nba/espn";
import { syncCorrections, syncDaily } from "@/lib/nba/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Vercel Cron issues GET; POST is accepted for manual triggers.
async function handle(req: Request) {
  if (!verifyCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const client = createEspnClient();
  const daily = await syncDaily(db, client, { budgetMs: 40_000 });
  const corrections = await syncCorrections(db, client);
  const ok = daily.ok && corrections.ok;
  return NextResponse.json({ ok, daily, corrections }, { status: ok ? 200 : 500 });
}

export const GET = handle;
export const POST = handle;
