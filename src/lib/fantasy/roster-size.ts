/** House-rule sizing: max roster, snake rounds and wave count. Pure. */
import type { LeagueSettings } from "./settings";

type SizeSettings = Pick<LeagueSettings, "rosterPool" | "rosterCap" | "snakeTarget" | "waveSize">;

/** min(cap, floor(pool / teams)); 0 for fewer than one team. */
export function maxRoster(teams: number, settings: SizeSettings): number {
  if (teams < 1) return 0;
  return Math.min(settings.rosterCap, Math.floor(settings.rosterPool / teams));
}

/** Rounds drafted snake-style: min(floor(target / teams), maxRoster). */
export function snakeRounds(teams: number, settings: SizeSettings): number {
  if (teams < 1) return 0;
  return Math.min(Math.floor(settings.snakeTarget / teams), maxRoster(teams, settings));
}

/**
 * Most keepers a team may hold: the roster space left after the snake rounds (the snake phase is
 * the same for everyone, so keepers can only displace WAVE picks).
 */
export function keepersRoom(teams: number, settings: SizeSettings): number {
  return Math.max(0, maxRoster(teams, settings) - snakeRounds(teams, settings));
}

export type WavePlan = {
  /** Rounds left after the snake phase (each team makes this many wave picks). */
  remainingRounds: number;
  /** Total number of waves, including a short final wave. */
  count: number;
  /** Waves that have a full `waveSize` picks per team. */
  fullWaves: number;
  /** Picks per team in the final wave (== waveSize unless the remainder is short). */
  lastWaveSize: number;
  /** True when the final wave is shorter than waveSize (e.g. a single pick). */
  lastWaveShort: boolean;
};

export function waves(teams: number, settings: SizeSettings): WavePlan {
  const remainingRounds = Math.max(0, maxRoster(teams, settings) - snakeRounds(teams, settings));
  const size = settings.waveSize;
  const fullWaves = Math.floor(remainingRounds / size);
  const rem = remainingRounds % size;
  return {
    remainingRounds,
    count: fullWaves + (rem > 0 ? 1 : 0),
    fullWaves,
    lastWaveSize: rem > 0 ? rem : remainingRounds > 0 ? size : 0,
    lastWaveShort: rem > 0,
  };
}
