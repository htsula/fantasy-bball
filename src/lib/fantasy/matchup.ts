/**
 * Matchup outcomes. Pure (no I/O).
 *
 * Points are compared at 0.01 precision (scoring values may be fractional), so 100.004 vs 100.001
 * is a tie. A BYE (a matchup with no away team) is not a game: it is never a win, loss or tie, adds
 * no points for/against, and is skipped by standings and streaks. Its row is still finalized
 * ("final", no winner) so the period is complete.
 */

export const POINT_PRECISION = 100;

/** Rounds to 2 decimals (what the UI shows and what ties are judged on). */
export function roundPoints(n: number): number {
  return Math.round((n + Number.EPSILON) * POINT_PRECISION) / POINT_PRECISION;
}

export type MatchupResult = "home" | "away" | "tie";

export function decideMatchup(homePoints: number, awayPoints: number): MatchupResult {
  const h = Math.round(homePoints * POINT_PRECISION);
  const a = Math.round(awayPoints * POINT_PRECISION);
  if (h === a) return "tie";
  return h > a ? "home" : "away";
}

export type MatchupSides = { homeTeamId: string; awayTeamId: string | null };

export function isBye(m: Pick<MatchupSides, "awayTeamId">): boolean {
  return m.awayTeamId === null;
}

export type MatchupOutcome = {
  bye: boolean;
  result: MatchupResult | null;
  winnerTeamId: string | null;
  homePoints: number;
  awayPoints: number | null;
};

/** Result of one matchup given each side's period total. Byes have no result. */
export function resolveMatchup(m: MatchupSides, totals: { home: number; away: number | null }): MatchupOutcome {
  if (m.awayTeamId === null || totals.away === null) {
    return { bye: true, result: null, winnerTeamId: null, homePoints: roundPoints(totals.home), awayPoints: null };
  }
  const result = decideMatchup(totals.home, totals.away);
  return {
    bye: false,
    result,
    winnerTeamId: result === "home" ? m.homeTeamId : result === "away" ? m.awayTeamId : null,
    homePoints: roundPoints(totals.home),
    awayPoints: roundPoints(totals.away),
  };
}

/** Projected final = points so far + expected points of remaining games. */
export function projectFinal(actual: number, remainingProjections: Iterable<number | null | undefined>): number {
  let sum = actual;
  for (const p of remainingProjections) sum += p ?? 0;
  return roundPoints(sum);
}
