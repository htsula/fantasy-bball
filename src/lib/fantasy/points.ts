/** Fantasy scoring. Pure; per-league overrides arrive in a later milestone. */

export const STAT_KEYS = ["pts", "reb", "ast", "stl", "blk", "to", "fgm", "fga", "ftm", "fta", "tpm"] as const;
export type StatKey = (typeof STAT_KEYS)[number];

export type StatLine = Partial<Record<StatKey, number | null>>;
export type PointValues = Record<StatKey, number>;

/** ESPN-style default H2H points values. */
export const DEFAULT_POINTS: PointValues = {
  pts: 1,
  reb: 1,
  ast: 2,
  stl: 4,
  blk: 4,
  to: -2,
  fgm: 2,
  fga: -1,
  ftm: 1,
  fta: -1,
  tpm: 1,
};

/** Σ(stat × value). Missing or null stats count as 0. */
export function fantasyPoints(line: StatLine, values: PointValues = DEFAULT_POINTS): number {
  let total = 0;
  for (const key of STAT_KEYS) total += (line[key] ?? 0) * values[key];
  return total;
}
