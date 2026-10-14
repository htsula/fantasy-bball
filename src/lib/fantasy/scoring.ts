/**
 * Per-game fantasy scoring. Pure (no I/O).
 *
 * points = sum(stat x league value) + team-win bonus. The bonus applies when the player's NBA team
 * won the game, the player is in that game's tip-off snapshot, and his snapshot injury status is
 * not Out. Whether he actually played is irrelevant: a 0-minute bench winner, a coach's DNP, a
 * G-League assignee or a suspended player in the snapshot all earn it. A player missing from the
 * snapshot (traded away, signed after tip-off) gets no bonus; his stats still count if he played.
 */
import { STAT_KEYS, type StatLine } from "./points";
import type { ScoringValues } from "./settings";

/** True for an injury-report status that means "will not play" (case-insensitive, incl. "OUT"). */
export function isOut(status: string | null | undefined): boolean {
  if (!status) return false;
  return /^out\b/i.test(status.trim());
}

const CANONICAL_STATUS: Record<string, string> = {
  out: "Out",
  "out for season": "Out For Season",
  "day-to-day": "Day-To-Day",
  "day to day": "Day-To-Day",
  questionable: "Questionable",
  doubtful: "Doubtful",
  probable: "Probable",
  suspension: "Suspension",
};

/** Canonical casing for an injury status as stored in tip-off snapshots. Null/blank -> null. */
export function normalizeInjuryStatus(status: string | null | undefined): string | null {
  const trimmed = status?.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  return CANONICAL_STATUS[trimmed.toLowerCase()] ?? trimmed;
}

export type GameScoreInput = {
  /** The player's box-score line; null when he has no stat row for the game. */
  stats: StatLine | null;
  /** The player's NBA team won (callers pass false until the game is final). */
  teamWon: boolean;
  /** The player is in this game's tip-off snapshot for his team. */
  inSnapshot: boolean;
  /** Injury status recorded in the snapshot. */
  injuryStatus: string | null;
};

export type GameScore = { statPoints: number; winBonus: number; total: number };

export function statPointsFor(stats: StatLine | null, values: ScoringValues): number {
  if (!stats) return 0;
  let total = 0;
  for (const key of STAT_KEYS) total += (stats[key] ?? 0) * values[key];
  return total;
}

export function winBonusApplies(input: Pick<GameScoreInput, "teamWon" | "inSnapshot" | "injuryStatus">): boolean {
  return input.teamWon && input.inSnapshot && !isOut(input.injuryStatus);
}

export function gameFantasyPoints(input: GameScoreInput, values: ScoringValues): GameScore {
  const statPoints = statPointsFor(input.stats, values);
  const winBonus = winBonusApplies(input) ? values.teamWin : 0;
  return { statPoints, winBonus, total: statPoints + winBonus };
}
