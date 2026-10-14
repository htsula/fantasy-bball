import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/nba/dates";
import { buildMatchupPeriods, findGameGaps, playoffRounds, roundRobin } from "@/lib/fantasy/schedule";

const range = (start: string, end: string) => {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
};
const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();

// 2025-26 shape: opening night Tue Oct 21, last day Sun Apr 12, All-Star break Feb 13-18 (no games).
const START = "2025-10-21";
const END = "2026-04-12";
const GAMES = range(START, END).filter((d) => d < "2026-02-13" || d > "2026-02-18");

describe("buildMatchupPeriods", () => {
  const periods = buildMatchupPeriods(START, END, GAMES, 4, 1);

  it("starts at opening night and ends the first period on Sunday", () => {
    expect(periods[0]).toMatchObject({ number: 1, startDate: "2025-10-21", endDate: "2025-10-26", isPlayoff: false });
    expect(dow(periods[1].startDate)).toBe(1); // Monday
  });

  it("is contiguous, covers the season and ends on Sundays", () => {
    expect(periods[0].startDate).toBe(START);
    expect(periods.at(-1)!.endDate).toBe(END);
    periods.forEach((p, i) => {
      expect(p.number).toBe(i + 1);
      expect(dow(p.endDate)).toBe(0);
      if (i > 0) expect(p.startDate).toBe(addDays(periods[i - 1].endDate, 1));
    });
  });

  it("merges the All-Star break into one two-week period", () => {
    const merged = periods.find((p) => p.startDate <= "2026-02-13" && p.endDate >= "2026-02-18")!;
    expect(merged).toMatchObject({ startDate: "2026-02-09", endDate: "2026-02-22" });
    const without = buildMatchupPeriods(START, END, [], 4, 1);
    expect(without.length).toBe(periods.length + 1);
  });

  it("reserves the last rounds x roundLength periods for playoffs", () => {
    const playoff = (n: number, len: number) => buildMatchupPeriods(START, END, GAMES, n, len).filter((p) => p.isPlayoff);
    expect(playoff(4, 1).map((p) => p.playoffRound)).toEqual([1, 2]);
    expect(playoff(4, 2).map((p) => p.playoffRound)).toEqual([1, 1, 2, 2]);
    expect(playoff(6, 1).map((p) => p.playoffRound)).toEqual([1, 2, 3]);
    expect(playoff(8, 2)).toHaveLength(6);
    expect(playoff(2, 1)).toHaveLength(1);
    expect(playoffRounds(6)).toBe(3);
    expect(periods.slice(0, -2).every((p) => !p.isPlayoff && p.playoffRound === null)).toBe(true);
  });

  it("rejects seasons too short for the playoffs", () => {
    expect(() => buildMatchupPeriods("2026-10-20", "2026-10-26", [], 4, 1)).toThrow(/too short/);
    expect(() => buildMatchupPeriods("2026-10-26", "2026-10-20", [], 4, 1)).toThrow();
  });

  it("truncates a final partial week at the season end", () => {
    const p = buildMatchupPeriods("2026-10-19", "2026-11-11", [], 2, 1);
    expect(p.at(-1)).toMatchObject({ startDate: "2026-11-09", endDate: "2026-11-11" });
  });

  it("detects gaps of at least 4 empty days only", () => {
    expect(findGameGaps(GAMES, START, END)).toEqual([{ start: "2026-02-13", end: "2026-02-18" }]);
    expect(findGameGaps(["2026-01-01", "2026-01-05"], "2026-01-01", "2026-01-05")).toEqual([]); // 3 empty days
    expect(findGameGaps(["2026-01-01", "2026-01-06"], "2026-01-01", "2026-01-06")).toHaveLength(1); // 4 empty days
  });
});

describe("roundRobin", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
  const meetings = (rounds: ReturnType<typeof roundRobin>, teams: string[]) => {
    const m = new Map<string, number>();
    for (const r of rounds)
      for (const p of r.pairings) {
        const k = [p.home, p.away].sort().join("|");
        m.set(k, (m.get(k) ?? 0) + 1);
      }
    const counts: number[] = [];
    for (let i = 0; i < teams.length; i++)
      for (let j = i + 1; j < teams.length; j++) counts.push(m.get([teams[i], teams[j]].sort().join("|")) ?? 0);
    return counts;
  };

  it.each([2, 3, 4, 5, 6, 7, 8, 10, 12])("%i teams: valid and balanced over 20 periods", (n) => {
    const teams = ids(n);
    const rounds = roundRobin(teams, 20, "seed");
    expect(rounds).toHaveLength(20);
    const homes = new Map(teams.map((t) => [t, 0]));
    const byes = new Map(teams.map((t) => [t, 0]));
    for (const r of rounds) {
      const seen: string[] = [];
      for (const p of r.pairings) {
        expect(p.home).not.toBe(p.away);
        seen.push(p.home, p.away);
        homes.set(p.home, homes.get(p.home)! + 1);
      }
      for (const b of r.byes) {
        seen.push(b);
        byes.set(b, byes.get(b)! + 1);
      }
      expect(seen.sort()).toEqual([...teams].sort()); // everyone exactly once
      expect(r.byes.length).toBe(n % 2);
    }
    const counts = meetings(rounds, teams);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    const h = [...homes.values()];
    expect(Math.max(...h) - Math.min(...h)).toBeLessThanOrEqual(2);
    if (n % 2 === 1) {
      const b = [...byes.values()];
      expect(Math.max(...b) - Math.min(...b)).toBeLessThanOrEqual(1);
      expect(Math.min(...b)).toBeGreaterThan(0);
    }
  });

  it("is deterministic per seed and varies across seeds", () => {
    const a = roundRobin(ids(6), 10, "x");
    expect(roundRobin(ids(6), 10, "x")).toEqual(a);
    expect(roundRobin(ids(6), 10, "y")).not.toEqual(a);
  });

  it("each pair meets once per full cycle, flipping home/away on the next cycle", () => {
    const r = roundRobin(ids(4), 6, "s");
    expect(meetings(r.slice(0, 3), ids(4))).toEqual([1, 1, 1, 1, 1, 1]);
    const first = r[0].pairings[0];
    expect(r[3].pairings.some((p) => p.home === first.away && p.away === first.home)).toBe(true);
  });

  it("rejects bad input", () => {
    expect(() => roundRobin(["a"], 3)).toThrow();
    expect(() => roundRobin(["a", "a"], 3)).toThrow();
  });
});
