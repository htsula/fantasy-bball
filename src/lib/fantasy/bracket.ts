/**
 * Playoff bracket structure. Pure (no I/O).
 *
 * The bracket is fixed at seeding time (no re-seeding between rounds): the standard single-
 * elimination layout for the next power of two, with seeds beyond the field missing, so the top
 * seeds get byes. Round 1 pairs by seed order [1,8,4,5,2,7,3,6] (size 8), [1,4,2,3] (size 4) or
 * [1,2]; each later slot takes the winners of the two slots above it (2s and 2s+1).
 *   2 teams: final.  4 teams: 1v4, 2v3 -> final.  6 teams: 1 and 2 bye, 3v6, 4v5 -> 1v(4/5), 2v(3/6) -> final.
 *   8 teams: 1v8, 4v5, 2v7, 3v6 -> 1v4, 2v3 -> final.
 */

export type BracketSlotSpec = {
  round: number; // 1-based
  slot: number; // 0-based within the round
  /** Seeds of round-1 slots (null = bye); both null for later rounds. */
  seedA: number | null;
  seedB: number | null;
  /** Slot index in the previous round that feeds each side (null in round 1). */
  sourceA: number | null;
  sourceB: number | null;
};

export function bracketSize(playoffTeams: number): number {
  let size = 2;
  while (size < playoffTeams) size *= 2;
  return size;
}

/** Seed positions of round 1 for a bracket of `size` (a power of two): [1,8,4,5,2,7,3,6]. */
export function seedOrder(size: number): number[] {
  let order = [1, 2];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  // order is [1,8,4,5,2,7,3,6] style when built this way for 8; verify pairs meet only in later rounds.
  return order;
}

export function buildBracket(playoffTeams: number): { rounds: number; slots: BracketSlotSpec[] } {
  if (!Number.isInteger(playoffTeams) || playoffTeams < 2) throw new RangeError("A bracket needs at least 2 teams");
  const size = bracketSize(playoffTeams);
  const rounds = Math.log2(size);
  const order = seedOrder(size);
  const slots: BracketSlotSpec[] = [];
  for (let s = 0; s < size / 2; s++) {
    const a = order[2 * s];
    const b = order[2 * s + 1];
    slots.push({
      round: 1,
      slot: s,
      seedA: a <= playoffTeams ? a : null,
      seedB: b <= playoffTeams ? b : null,
      sourceA: null,
      sourceB: null,
    });
  }
  for (let r = 2; r <= rounds; r++) {
    for (let s = 0; s < size / 2 ** r; s++) {
      slots.push({ round: r, slot: s, seedA: null, seedB: null, sourceA: 2 * s, sourceB: 2 * s + 1 });
    }
  }
  return { rounds, slots };
}

/** "Final", "Semifinal", "Quarterfinal" counted from the last round; earlier rounds are "Round N". */
export function roundLabel(round: number, rounds: number): string {
  const fromEnd = rounds - round;
  if (fromEnd === 0) return "Final";
  if (fromEnd === 1) return "Semifinal";
  if (fromEnd === 2) return "Quarterfinal";
  return `Round ${round}`;
}

/**
 * Winner of a slot from the combined points of both sides (one or more periods). Ties go to the
 * higher seed (the lower seed number). Points are compared at 0.01 precision like every matchup.
 */
export function decideSlotWinner(
  a: { teamId: string; seed: number; points: number },
  b: { teamId: string; seed: number; points: number },
): { winnerTeamId: string; tiebreak: boolean } {
  const pa = Math.round(a.points * 100);
  const pb = Math.round(b.points * 100);
  if (pa !== pb) return { winnerTeamId: pa > pb ? a.teamId : b.teamId, tiebreak: false };
  return { winnerTeamId: a.seed <= b.seed ? a.teamId : b.teamId, tiebreak: true };
}

/** Playoff result of a team knocked out in `round` of `rounds` (or the winner/runner-up of the last). */
export function resultForExit(round: number, rounds: number): "runner_up" | "semifinal" | "quarterfinal" {
  const fromEnd = rounds - round;
  if (fromEnd <= 0) return "runner_up";
  if (fromEnd === 1) return "semifinal";
  return "quarterfinal";
}
