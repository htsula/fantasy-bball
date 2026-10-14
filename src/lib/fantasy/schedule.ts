/** Matchup-period and round-robin schedule generation. Pure and deterministic. */
import { addDays } from "@/lib/nba/dates";

export type PeriodSpec = {
  number: number;
  startDate: string; // YYYY-MM-DD (ET), inclusive
  endDate: string;
  isPlayoff: boolean;
  playoffRound: number | null;
};

const dayOfWeek = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** Playoff rounds for a bracket size: 2->1, 4->2, 6->3 (top 2 get byes), 8->3. */
export function playoffRounds(playoffTeams: number): number {
  return playoffTeams <= 1 ? 0 : Math.ceil(Math.log2(playoffTeams));
}

/** Consecutive-game gaps of at least `minGapDays` days with no games (the All-Star break). */
export function findGameGaps(gameDates: string[], start: string, end: string, minGapDays = 4) {
  const dates = [...new Set(gameDates)].filter((d) => d >= start && d <= end).sort();
  const gaps: { start: string; end: string }[] = [];
  for (let i = 1; i < dates.length; i++) {
    const empty = daysBetween(dates[i - 1], dates[i]) - 1;
    if (empty >= minGapDays) gaps.push({ start: addDays(dates[i - 1], 1), end: addDays(dates[i], -1) });
  }
  return gaps;
}

/**
 * Weekly Mon-Sun (ET) periods from opening night, with any week-boundary-crossing no-games gap
 * (All-Star break) merged into one longer period, then the LAST rounds x roundLength periods
 * reserved for the playoffs.
 */
export function buildMatchupPeriods(
  regSeasonStart: string,
  regSeasonEnd: string,
  gameDates: string[],
  playoffTeams: number,
  playoffRoundLength: number,
): PeriodSpec[] {
  if (regSeasonEnd < regSeasonStart) throw new Error("Season end is before season start");

  let weeks: { startDate: string; endDate: string }[] = [];
  let cursor = regSeasonStart;
  while (cursor <= regSeasonEnd) {
    const toSunday = (7 - dayOfWeek(cursor)) % 7; // days until Sunday (0 if already Sunday)
    const sunday = addDays(cursor, toSunday);
    const endDate = sunday < regSeasonEnd ? sunday : regSeasonEnd;
    weeks.push({ startDate: cursor, endDate });
    cursor = addDays(endDate, 1);
  }

  for (const gap of findGameGaps(gameDates, regSeasonStart, regSeasonEnd)) {
    const touched = weeks
      .map((w, i) => (w.startDate <= gap.end && w.endDate >= gap.start ? i : -1))
      .filter((i) => i >= 0);
    if (touched.length < 2) continue;
    const first = touched[0];
    const last = touched[touched.length - 1];
    weeks = [
      ...weeks.slice(0, first),
      { startDate: weeks[first].startDate, endDate: weeks[last].endDate },
      ...weeks.slice(last + 1),
    ];
  }

  const playoffPeriods = playoffRounds(playoffTeams) * playoffRoundLength;
  if (weeks.length <= playoffPeriods) {
    throw new Error(
      `Season is too short: ${weeks.length} period(s) but ${playoffPeriods} are needed for the playoffs plus at least 1 regular period`,
    );
  }
  const regularCount = weeks.length - playoffPeriods;
  return weeks.map((w, i) => ({
    number: i + 1,
    startDate: w.startDate,
    endDate: w.endDate,
    isPlayoff: i >= regularCount,
    playoffRound: i >= regularCount ? Math.floor((i - regularCount) / playoffRoundLength) + 1 : null,
  }));
}

// ------------------------------------------------------------------------------ round robin

export type Pairing = { home: string; away: string };
export type RoundResult = { pairings: Pairing[]; byes: string[] };

function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Circle-method round robin repeated to fill `periodCount` periods. An odd team count adds a bye
 * (each team sits once per cycle). Odd-numbered cycles flip home/away. Team order is shuffled by
 * `seed` so the same inputs always give the same schedule.
 */
export function roundRobin(teamIds: string[], periodCount: number, seed = "default"): RoundResult[] {
  if (new Set(teamIds).size !== teamIds.length) throw new Error("Duplicate team ids");
  if (teamIds.length < 2) throw new Error("A schedule needs at least 2 teams");

  const rand = mulberry32(hashSeed(seed));
  const order = [...teamIds];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const slots: (string | null)[] = order.length % 2 === 1 ? [...order, null] : order;
  const m = slots.length;

  const cycle: RoundResult[] = [];
  const homes = new Map<string, number>();
  let ring = [...slots];
  for (let r = 0; r < m - 1; r++) {
    const pairings: Pairing[] = [];
    const byes: string[] = [];
    for (let i = 0; i < m / 2; i++) {
      const a = ring[i];
      const b = ring[m - 1 - i];
      if (a === null || b === null) {
        byes.push((a ?? b) as string);
        continue;
      }
      // Greedy balance: the team with fewer home games so far hosts (ties: first seat).
      const homeCount = (t: string) => homes.get(t) ?? 0;
      const aHosts = homeCount(a) <= homeCount(b);
      const [home, away] = aHosts ? [a, b] : [b, a];
      homes.set(home, homeCount(home) + 1);
      pairings.push({ home, away });
    }
    cycle.push({ pairings, byes });
    ring = [ring[0], ring[m - 1], ...ring.slice(1, m - 1)];
  }

  const out: RoundResult[] = [];
  for (let p = 0; p < periodCount; p++) {
    const round = cycle[p % cycle.length];
    const flipped = Math.floor(p / cycle.length) % 2 === 1;
    out.push({
      byes: round.byes,
      pairings: flipped ? round.pairings.map((x) => ({ home: x.away, away: x.home })) : round.pairings,
    });
  }
  return out;
}
