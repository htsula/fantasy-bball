/** Previous-season fantasy totals per player (league scoring), shared by the draft, My Team and trades. */
import type { Db } from "@/db/types";
import type { ScoringValues } from "./settings";
import { loadSeasonFantasy } from "./stats-query";

export type LastSeasonFp = {
  season: number;
  /** Games he scored in. */
  gp: number;
  /** Total fantasy points including the (approximated) win bonus. */
  total: number;
  /** Per game scored in. */
  avg: number | null;
};

/** One aggregation for all `playerIds` (every player when omitted); players without games are absent. */
export async function loadLastSeasonFp(
  db: Db,
  opts: { season: number; playerIds?: number[]; scoring?: ScoringValues },
): Promise<Map<number, LastSeasonFp>> {
  const rows = await loadSeasonFantasy(db, {
    seasons: [opts.season],
    playerIds: opts.playerIds,
    points: opts.scoring,
    teamWin: opts.scoring?.teamWin,
  });
  return new Map(rows.map((r) => [r.playerId, { season: r.season, gp: r.fgp, total: r.totalFp, avg: r.fpAvg }]));
}
