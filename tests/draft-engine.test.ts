import { describe, expect, it } from "vitest";
import {
  deriveState,
  isWaveComplete,
  pickInRound,
  snakeRoundOf,
  snakeTeam,
  snakeTeamIndex,
  totalPicks,
  totalSnakePicks,
  waveCount,
  waveQuota,
  waveRemaining,
  waveTarget,
  type DraftConfig,
} from "@/lib/draft/engine";
import { maxRoster, snakeRounds } from "@/lib/fantasy/roster-size";
import { defaultSettings } from "@/lib/fantasy/settings";

describe("snake order", () => {
  it("runs forward then reverses each round", () => {
    const order = ["a", "b", "c", "d"];
    const picks = Array.from({ length: 12 }, (_, i) => snakeTeam(order, i + 1)).join("");
    expect(picks).toBe("abcd" + "dcba" + "abcd");
  });

  it("gives the last team back-to-back picks at the turn", () => {
    expect(snakeTeamIndex(4, 4)).toBe(3);
    expect(snakeTeamIndex(5, 4)).toBe(3);
    expect(snakeTeamIndex(8, 4)).toBe(0);
    expect(snakeTeamIndex(9, 4)).toBe(0);
  });

  it("maps overall pick to round and pick in round", () => {
    expect([1, 4, 5, 8, 9].map((p) => snakeRoundOf(p, 4))).toEqual([1, 1, 2, 2, 3]);
    expect([1, 4, 5, 8, 9].map((p) => pickInRound(p, 4))).toEqual([1, 4, 1, 4, 1]);
  });

  it("every team gets exactly one pick per round", () => {
    for (const n of [2, 3, 7, 16]) {
      for (let round = 0; round < 5; round++) {
        const teams = new Set(Array.from({ length: n }, (_, i) => snakeTeamIndex(round * n + i + 1, n)));
        expect(teams.size).toBe(n);
      }
    }
  });

  it("rejects invalid input", () => {
    expect(() => snakeTeamIndex(0, 4)).toThrow(RangeError);
    expect(() => snakeTeamIndex(1, 0)).toThrow(RangeError);
  });
});

describe("waves", () => {
  // 16 teams: 12 snake rounds, 32 total -> 10 waves of 2.
  const big: DraftConfig = { teamCount: 16, snakeRounds: 12, totalRounds: 32, waveSize: 2 };
  // 4 teams, rosterPool 20 -> 5 rounds, 2 snake, remaining 3 -> waves of 2 then 1.
  const odd: DraftConfig = { teamCount: 4, snakeRounds: 2, totalRounds: 5, waveSize: 2 };

  it("counts waves and quotas for the house config", () => {
    expect(waveCount(big)).toBe(10);
    expect(waveQuota(big, 1)).toBe(2);
    expect(waveQuota(big, 10)).toBe(2);
    expect(waveTarget(big, 10)).toBe(32);
    expect(totalSnakePicks(big)).toBe(192);
    expect(totalPicks(big)).toBe(512);
  });

  it("makes the last wave a single pick when the remainder is odd", () => {
    expect(waveCount(odd)).toBe(2);
    expect(waveQuota(odd, 1)).toBe(2);
    expect(waveQuota(odd, 2)).toBe(1);
    expect(waveTarget(odd, 2)).toBe(5);
  });

  it("quota is min(waveSize, totalRounds - picksSoFar)", () => {
    for (let wave = 1; wave <= 2; wave++) {
      const soFar = odd.snakeRounds + (wave - 1) * odd.waveSize;
      expect(waveQuota(odd, wave)).toBe(Math.min(odd.waveSize, odd.totalRounds - soFar));
    }
  });

  it("tracks per-team remaining and wave completion", () => {
    expect(waveRemaining(odd, 1, 2)).toBe(2);
    expect(waveRemaining(odd, 1, 3)).toBe(1);
    expect(waveRemaining(odd, 1, 4)).toBe(0);
    expect(isWaveComplete(odd, 1, [4, 4, 4, 3])).toBe(false);
    expect(isWaveComplete(odd, 1, [4, 4, 4, 4])).toBe(true);
    expect(isWaveComplete(odd, 2, [5, 5, 4, 5])).toBe(false);
  });

  it("is zero waves when the draft is all snake", () => {
    expect(waveCount({ snakeRounds: 6, totalRounds: 6, waveSize: 2 })).toBe(0);
  });
});

describe("deriveState", () => {
  const cfg: DraftConfig = { teamCount: 4, snakeRounds: 2, totalRounds: 5, waveSize: 2 };

  it("is in the snake until every snake pick is made", () => {
    expect(deriveState(cfg, [0, 0, 0, 0])).toEqual({ status: "snake", currentPick: 1 });
    expect(deriveState(cfg, [2, 2, 2, 1])).toEqual({ status: "snake", currentPick: 8 });
  });

  it("moves to wave 1, then to the next wave only when every team is done", () => {
    expect(deriveState(cfg, [2, 2, 2, 2])).toMatchObject({ status: "waves", wave: 1 });
    expect(deriveState(cfg, [4, 3, 2, 2])).toMatchObject({ status: "waves", wave: 1 });
    expect(deriveState(cfg, [4, 4, 4, 4])).toMatchObject({ status: "waves", wave: 2 });
    expect(deriveState(cfg, [5, 4, 4, 4])).toMatchObject({ status: "waves", wave: 2 });
  });

  it("completes when every team has totalRounds picks", () => {
    expect(deriveState(cfg, [5, 5, 5, 5]).status).toBe("complete");
  });

  it("goes straight to waves when there are no snake rounds", () => {
    expect(deriveState({ ...cfg, snakeRounds: 0 }, [0, 0, 0, 0])).toMatchObject({ status: "waves", wave: 1 });
  });
});

describe("house formula (reused from roster-size)", () => {
  it("16 teams: 32 max roster, 12 snake rounds", () => {
    const s = defaultSettings();
    expect(maxRoster(16, s)).toBe(32);
    expect(snakeRounds(16, s)).toBe(12);
  });
  it("4 teams: all snake (50 cap, 50 snake rounds)", () => {
    const s = defaultSettings();
    expect(maxRoster(4, s)).toBe(50);
    expect(snakeRounds(4, s)).toBe(50);
  });
});
