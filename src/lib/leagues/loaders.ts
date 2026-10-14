/** Per-request cached loaders for league pages (layout and page share one query). */
import { cache } from "react";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { requireUser } from "@/lib/auth/session";
import { LeagueError, getLeagueView } from "./service";

/**
 * Current user plus the league view. Non-members get a 404 (same as a missing league) so league
 * ids don't leak.
 */
export const loadLeagueView = cache(async (leagueId: string) => {
  const user = await requireUser();
  try {
    return { user, view: await getLeagueView(db, user, leagueId) };
  } catch (err) {
    if (err instanceof LeagueError && (err.code === "not_found" || err.code === "forbidden")) notFound();
    throw err;
  }
});
