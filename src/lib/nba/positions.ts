export const FANTASY_POSITIONS = ["PG", "SG", "SF", "PF", "C"] as const;
export type FantasyPosition = (typeof FANTASY_POSITIONS)[number];

const SINGLE: Record<string, FantasyPosition[]> = {
  PG: ["PG"],
  SG: ["SG"],
  SF: ["SF"],
  PF: ["PF"],
  C: ["C"],
  G: ["PG", "SG"],
  F: ["SF", "PF"],
};

// Hybrid labels where the plain union of both halves would be too generous.
const COMBO: Record<string, FantasyPosition[]> = {
  "G-F": ["SG", "SF"],
  "F-G": ["SG", "SF"],
  "F-C": ["PF", "C"],
  "C-F": ["PF", "C"],
  "G-C": ["SG", "C"],
  "C-G": ["SG", "C"],
};

/** Maps an ESPN position abbreviation (G, F, C, G-F, F-C, PG, ...) to fantasy positions. */
export function mapPosition(abbr: string | null | undefined): FantasyPosition[] {
  if (!abbr) return [];
  const key = abbr.trim().toUpperCase().replace(/[\s/,]+/g, "-");
  if (COMBO[key]) return [...COMBO[key]];
  const found = new Set<FantasyPosition>();
  for (const token of key.split("-")) for (const p of SINGLE[token] ?? []) found.add(p);
  return FANTASY_POSITIONS.filter((p) => found.has(p));
}
