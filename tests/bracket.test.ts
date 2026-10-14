import { describe, expect, it } from "vitest";
import { buildBracket, decideSlotWinner, resultForExit, roundLabel, seedOrder } from "@/lib/fantasy/bracket";
import { playoffRounds } from "@/lib/fantasy/schedule";

const round1 = (n: number) =>
  buildBracket(n)
    .slots.filter((s) => s.round === 1)
    .map((s) => [s.seedA, s.seedB]);

describe("bracket structure", () => {
  it("orders seeds so the top seeds meet last", () => {
    expect(seedOrder(2)).toEqual([1, 2]);
    expect(seedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });

  it("2 teams: a single final", () => {
    const b = buildBracket(2);
    expect(b.rounds).toBe(1);
    expect(b.slots).toHaveLength(1);
    expect(round1(2)).toEqual([[1, 2]]);
  });

  it("4 teams: 1v4, 2v3, then the final", () => {
    const b = buildBracket(4);
    expect(b.rounds).toBe(2);
    expect(round1(4)).toEqual([
      [1, 4],
      [2, 3],
    ]);
    expect(b.slots.find((s) => s.round === 2)).toMatchObject({ slot: 0, sourceA: 0, sourceB: 1 });
  });

  it("6 teams: seeds 1 and 2 get byes; 3v6 and 4v5 play round 1", () => {
    const b = buildBracket(6);
    expect(b.rounds).toBe(3);
    expect(round1(6)).toEqual([
      [1, null],
      [4, 5],
      [2, null],
      [3, 6],
    ]);
    // 1 meets the 4/5 winner, 2 meets the 3/6 winner.
    expect(b.slots.filter((s) => s.round === 2).map((s) => [s.sourceA, s.sourceB])).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it("8 teams: 1v8, 4v5, 2v7, 3v6 then 1v4-side and 2v3-side", () => {
    const b = buildBracket(8);
    expect(b.rounds).toBe(3);
    expect(round1(8)).toEqual([
      [1, 8],
      [4, 5],
      [2, 7],
      [3, 6],
    ]);
    expect(b.slots).toHaveLength(4 + 2 + 1);
  });

  it("matches the schedule's reserved round count", () => {
    for (const n of [2, 4, 6, 8]) expect(buildBracket(n).rounds).toBe(playoffRounds(n));
  });

  it("rejects a bracket of fewer than 2 teams", () => {
    expect(() => buildBracket(1)).toThrow();
  });
});

describe("bracket helpers", () => {
  it("labels rounds from the end", () => {
    expect([1, 2, 3].map((r) => roundLabel(r, 3))).toEqual(["Quarterfinal", "Semifinal", "Final"]);
    expect([1, 2].map((r) => roundLabel(r, 2))).toEqual(["Semifinal", "Final"]);
    expect(roundLabel(1, 4)).toBe("Round 1");
  });

  it("maps the round a team is knocked out in to its result", () => {
    expect(resultForExit(3, 3)).toBe("runner_up");
    expect(resultForExit(2, 3)).toBe("semifinal");
    expect(resultForExit(1, 3)).toBe("quarterfinal");
    expect(resultForExit(1, 2)).toBe("semifinal");
  });

  it("decides by combined points and breaks exact ties for the higher seed", () => {
    expect(decideSlotWinner({ teamId: "a", seed: 3, points: 100 }, { teamId: "b", seed: 2, points: 100.5 })).toEqual({
      winnerTeamId: "b",
      tiebreak: false,
    });
    expect(decideSlotWinner({ teamId: "a", seed: 3, points: 100 }, { teamId: "b", seed: 2, points: 100 })).toEqual({
      winnerTeamId: "b",
      tiebreak: true,
    });
    expect(decideSlotWinner({ teamId: "a", seed: 1, points: 100.004 }, { teamId: "b", seed: 2, points: 100.001 }).tiebreak).toBe(true);
  });
});
