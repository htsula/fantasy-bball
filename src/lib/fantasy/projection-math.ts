/** Pure projection math (no I/O). */

export const RECENT_DAYS = 15;
export const MIN_RECENT_GAMES = 5;
export const RECENT_WEIGHT = 0.6;

export type ProjectionInput = {
  seasonGames: number;
  seasonFantasyPoints: number;
  recentGames: number;
  recentFantasyPoints: number;
};

/** Average per game; null when no games. */
export function perGame(total: number, games: number): number | null {
  return games > 0 ? total / games : null;
}

/**
 * Projected fantasy points per game: 0.6 x last-15-days average + 0.4 x season average when
 * there are at least 5 recent games, otherwise the season average. Null with no games at all.
 */
export function blendProjection(input: ProjectionInput): number | null {
  const season = perGame(input.seasonFantasyPoints, input.seasonGames);
  if (season === null) return null;
  const recent = perGame(input.recentFantasyPoints, input.recentGames);
  if (recent !== null && input.recentGames >= MIN_RECENT_GAMES) {
    return RECENT_WEIGHT * recent + (1 - RECENT_WEIGHT) * season;
  }
  return season;
}

/** Projected total over `games` remaining games. */
export function projectTotal(perGameProjection: number | null, games: number): number | null {
  return perGameProjection === null ? null : perGameProjection * games;
}
