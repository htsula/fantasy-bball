import { describe, expect, it } from "vitest";
import { decideMatchup, projectFinal, resolveMatchup, roundPoints } from "@/lib/fantasy/matchup";
import { computeStandings, type FinalMatchup } from "@/lib/fantasy/standings";

const T = (id: string) => ({ id, name: id });
const m = (periodNumber: number, homeTeamId: string, awayTeamId: string | null, homePoints: number, awayPoints: number | null): FinalMatchup => ({
  periodNumber,
  homeTeamId,
  awayTeamId,
  homePoints,
  awayPoints,
});

describe("matchup engine", () => {
  it("decides winner, loser and ties at 0.01 precision", () => {
    expect(decideMatchup(300, 250)).toBe("home");
    expect(decideMatchup(250, 300)).toBe("away");
    expect(decideMatchup(250, 250)).toBe("tie");
    expect(decideMatchup(250.004, 250.001)).toBe("tie");
    expect(decideMatchup(250.02, 250.01)).toBe("home");
  });

  it("byes have no result", () => {
    const o = resolveMatchup({ homeTeamId: "a", awayTeamId: null }, { home: 200, away: null });
    expect(o).toMatchObject({ bye: true, result: null, winnerTeamId: null, awayPoints: null });
  });

  it("names the winner", () => {
    expect(resolveMatchup({ homeTeamId: "a", awayTeamId: "b" }, { home: 1, away: 2 }).winnerTeamId).toBe("b");
    expect(resolveMatchup({ homeTeamId: "a", awayTeamId: "b" }, { home: 2, away: 2 }).winnerTeamId).toBeNull();
  });

  it("rounds and projects", () => {
    expect(roundPoints(1.005)).toBe(1.01);
    expect(projectFinal(100, [10, null, 5.5])).toBe(115.5);
  });
});

describe("standings", () => {
  it("counts records, points and streaks; byes are ignored", () => {
    const rows = computeStandings(
      [T("a"), T("b"), T("c")],
      [m(1, "a", "b", 100, 90), m(1, "c", null, 80, null), m(2, "a", "c", 50, 50), m(3, "b", "a", 10, 20)],
    );
    const a = rows.find((r) => r.teamId === "a")!;
    const b = rows.find((r) => r.teamId === "b")!;
    const c = rows.find((r) => r.teamId === "c")!;
    expect([a.wins, a.losses, a.ties, a.pointsFor, a.pointsAgainst, a.streak]).toEqual([2, 0, 1, 170, 150, "W1"]);
    expect([b.wins, b.losses, b.ties, b.streak]).toEqual([0, 2, 0, "L2"]);
    expect([c.wins, c.losses, c.ties, c.pointsFor, c.gamesPlayed]).toEqual([0, 0, 1, 50, 1]); // bye 80 not counted
    expect(rows.map((r) => r.teamId)).toEqual(["a", "c", "b"]);
    expect(rows[0].rank).toBe(1);
    expect(rows[2].gamesBack).toBe(2);
  });

  it("ties count as half a win for win%", () => {
    const rows = computeStandings([T("a"), T("b"), T("c"), T("d")], [m(1, "a", "b", 5, 5), m(1, "c", "d", 9, 1), m(2, "a", "d", 9, 1), m(2, "c", "b", 1, 9)]);
    // a: 1-0-1 (.75), c: 1-1 (.5), b: 1-0-1 (.75), d: 0-2
    expect(rows.find((r) => r.teamId === "a")!.winPct).toBe(0.75);
    expect(rows.map((r) => r.teamId).slice(2)).toEqual(["c", "d"]);
  });

  it("two-team tie: the head-to-head winner ranks first even with fewer points for", () => {
    // a and b both finish 2-1. b beat a head to head, a has far more points.
    const rows = computeStandings(
      [T("a"), T("b"), T("x"), T("y")],
      [m(1, "a", "b", 100, 120), m(2, "a", "x", 100, 1), m(3, "a", "y", 100, 1), m(2, "b", "y", 1, 90), m(3, "b", "x", 90, 1)],
    );
    const a = rows.find((r) => r.teamId === "a")!;
    const b = rows.find((r) => r.teamId === "b")!;
    expect([a.wins, a.losses]).toEqual([2, 1]);
    expect([b.wins, b.losses]).toEqual([2, 1]);
    expect(a.pointsFor).toBeGreaterThan(b.pointsFor);
    expect(b.rank).toBeLessThan(a.rank);
  });

  it("two-team tie with an even head-to-head falls through to points for", () => {
    const rows = computeStandings([T("a"), T("b")], [m(1, "a", "b", 100, 90), m(2, "a", "b", 80, 85)]);
    expect(rows.map((r) => [r.teamId, r.wins])).toEqual([["a", 1], ["b", 1]]);
    expect(rows[0].pointsFor).toBe(180);
  });

  it("3-way tie in a cycle: points for, then points against, then name", () => {
    // a beats b, b beats c, c beats a: every team is 1-1 and 1-1 inside the group.
    const equalPoints = [m(1, "a", "b", 10, 5), m(2, "b", "c", 10, 5), m(3, "c", "a", 10, 5)]; // PF and PA all 15
    expect(computeStandings([T("c"), T("b"), T("a")], equalPoints).map((r) => r.teamId)).toEqual(["a", "b", "c"]);

    // PF a 35, b 15, c 15; PA b 35 vs c 15 -> c is ahead of b.
    const pf = [m(1, "a", "b", 30, 5), m(2, "b", "c", 10, 5), m(3, "c", "a", 10, 5)];
    expect(computeStandings([T("a"), T("b"), T("c")], pf).map((r) => r.teamId)).toEqual(["a", "c", "b"]);

    // PF a 28, b 25, c 25; PA b 30 vs c 28 -> lower PA (c) beats b even though "b" sorts first by name.
    const pa = [m(1, "a", "b", 20, 5), m(2, "b", "c", 20, 10), m(3, "c", "a", 15, 8)];
    expect(computeStandings([T("a"), T("b"), T("c")], pa).map((r) => r.teamId)).toEqual(["a", "c", "b"]);
  });

  it("3-way tie: the mini-league record outranks points for", () => {
    // a, b, c all finish 2-2. Inside the trio a beat b and c, b beat c. c has by far the most points.
    const rows = computeStandings(
      [T("a"), T("b"), T("c"), T("o1"), T("o2")],
      [
        m(1, "a", "b", 10, 1),
        m(2, "a", "c", 10, 1),
        m(3, "b", "c", 10, 1),
        m(4, "o1", "a", 100, 1),
        m(5, "o2", "a", 100, 1),
        m(6, "b", "o1", 50, 1),
        m(7, "o2", "b", 100, 1),
        m(8, "c", "o1", 500, 1),
        m(9, "c", "o2", 500, 1),
      ],
    );
    expect(rows.map((r) => r.teamId)).toEqual(["o2", "a", "b", "c", "o1"]);
    const c = rows.find((r) => r.teamId === "c")!;
    expect(c.winPct).toBe(0.5);
    expect(c.pointsFor).toBeGreaterThan(rows.find((r) => r.teamId === "a")!.pointsFor);
  });

  it("is deterministic regardless of input order", () => {
    const games = [m(1, "a", "b", 5, 5), m(1, "c", "d", 5, 5)];
    const one = computeStandings([T("a"), T("b"), T("c"), T("d")], games).map((r) => r.teamId);
    const two = computeStandings([T("d"), T("c"), T("b"), T("a")], [...games].reverse()).map((r) => r.teamId);
    expect(one).toEqual(two);
    expect(one).toEqual(["a", "b", "c", "d"]);
  });

  it("empty season ranks everyone by name", () => {
    const rows = computeStandings([T("z"), T("y")], []);
    expect(rows.map((r) => r.teamId)).toEqual(["y", "z"]);
    expect(rows.every((r) => r.streak === "" && r.gamesBack === 0)).toBe(true);
  });
});
