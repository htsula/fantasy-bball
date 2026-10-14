/**
 * Pure draft math (no DB). The service derives all state from these helpers, so the stored
 * draft row can always be recomputed from the picks (used after every pick and every undo).
 */

export type DraftConfig = {
  teamCount: number;
  /** Rounds drafted snake-style. */
  snakeRounds: number;
  /** Rounds in the whole draft (== max roster). */
  totalRounds: number;
  /** Picks each team makes in a wave. */
  waveSize: number;
};

/** 0-based index into the draft order of the team making snake pick `pickNo` (1-based). */
export function snakeTeamIndex(pickNo: number, teamCount: number): number {
  if (pickNo < 1 || teamCount < 1) throw new RangeError("pickNo and teamCount must be >= 1");
  const round = Math.floor((pickNo - 1) / teamCount);
  const pos = (pickNo - 1) % teamCount;
  return round % 2 === 0 ? pos : teamCount - 1 - pos;
}

export function snakeTeam<T>(order: readonly T[], pickNo: number): T {
  return order[snakeTeamIndex(pickNo, order.length)];
}

/** 1-based round of snake pick `pickNo`. */
export function snakeRoundOf(pickNo: number, teamCount: number): number {
  return Math.floor((pickNo - 1) / teamCount) + 1;
}

/** 1-based position within its round. */
export function pickInRound(pickNo: number, teamCount: number): number {
  return ((pickNo - 1) % teamCount) + 1;
}

/** Overall pick number of the first pick in `round` (1-based). */
export function firstPickOfRound(round: number, teamCount: number): number {
  return (round - 1) * teamCount + 1;
}

export function totalSnakePicks(cfg: Pick<DraftConfig, "teamCount" | "snakeRounds">): number {
  return cfg.teamCount * cfg.snakeRounds;
}

export function totalPicks(cfg: Pick<DraftConfig, "teamCount" | "totalRounds">): number {
  return cfg.teamCount * cfg.totalRounds;
}

/** Number of waves in the draft (the last may be shorter than waveSize). */
export function waveCount(cfg: Pick<DraftConfig, "snakeRounds" | "totalRounds" | "waveSize">): number {
  return Math.ceil(Math.max(0, cfg.totalRounds - cfg.snakeRounds) / cfg.waveSize);
}

/** Total picks a team has made once it has used up its quota in `wave` (1-based). */
export function waveTarget(cfg: Pick<DraftConfig, "snakeRounds" | "totalRounds" | "waveSize">, wave: number): number {
  return Math.min(cfg.snakeRounds + wave * cfg.waveSize, cfg.totalRounds);
}

/** Picks each team may make in `wave`: min(waveSize, totalRounds - picksAtWaveStart). */
export function waveQuota(cfg: Pick<DraftConfig, "snakeRounds" | "totalRounds" | "waveSize">, wave: number): number {
  const start = cfg.snakeRounds + (wave - 1) * cfg.waveSize;
  return Math.max(0, Math.min(cfg.waveSize, cfg.totalRounds - start));
}

/** Picks a team still owes in `wave` given its total picks so far (never negative). */
export function waveRemaining(
  cfg: Pick<DraftConfig, "snakeRounds" | "totalRounds" | "waveSize">,
  wave: number,
  teamPicks: number,
): number {
  return Math.max(0, waveTarget(cfg, wave) - teamPicks);
}

/** True when every team has used its quota for `wave`. */
export function isWaveComplete(
  cfg: Pick<DraftConfig, "snakeRounds" | "totalRounds" | "waveSize">,
  wave: number,
  teamPickCounts: readonly number[],
): boolean {
  return teamPickCounts.every((c) => c >= waveTarget(cfg, wave));
}

/** Picks plus keepers per team (what counts toward the roster target). */
export function effectiveCounts(teamPickCounts: readonly number[], keeperCounts?: readonly number[]): number[] {
  return teamPickCounts.map((c, i) => c + (keeperCounts?.[i] ?? 0));
}

export type DerivedState =
  | { status: "snake"; currentPick: number }
  | { status: "waves"; currentPick: number; wave: number }
  | { status: "complete"; currentPick: number };

/**
 * Where the draft stands, given how many picks each team has made. Valid because picks in
 * every phase are bounded (snake by turn order, waves by quota), so counts alone identify the
 * phase, and the wave is one past the last wave that every team has finished.
 *
 * Keepers (optional, one count per team) are already on the roster, so they count toward a team's
 * roster total but NOT toward the snake: the snake phase is the same for everyone and is judged
 * on picks made, while wave progress and completion use picks + keepers. A team with k keepers
 * therefore owes k fewer wave picks (it may owe none for a whole wave), and the draft is complete
 * when every team has picks + keepers >= totalRounds (i.e. drafted maxRoster - keepers players).
 */
export function deriveState(
  cfg: DraftConfig,
  teamPickCounts: readonly number[],
  keeperCounts?: readonly number[],
): DerivedState {
  const made = teamPickCounts.reduce((a, b) => a + b, 0);
  const snakeTotal = totalSnakePicks(cfg);
  if (made < snakeTotal) return { status: "snake", currentPick: made + 1 };
  const minPicks = Math.min(...effectiveCounts(teamPickCounts, keeperCounts));
  if (minPicks >= cfg.totalRounds) return { status: "complete", currentPick: snakeTotal + 1 };
  const wave = Math.floor((minPicks - cfg.snakeRounds) / cfg.waveSize) + 1;
  return { status: "waves", currentPick: snakeTotal + 1, wave };
}
