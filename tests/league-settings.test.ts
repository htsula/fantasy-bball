import { describe, expect, it } from "vitest";
import { maxRoster, snakeRounds, waves } from "@/lib/fantasy/roster-size";
import {
  DEFAULT_SCORING,
  defaultSettings,
  leagueSettingsSchema,
  parseStoredSettings,
  teamAbbrevSchema,
  teamNameSchema,
} from "@/lib/fantasy/settings";

const s = defaultSettings();

describe("settings schema", () => {
  it("defaults to ESPN points plus the +4 team win bonus", () => {
    expect(s.scoring).toEqual({ ...DEFAULT_SCORING, teamWin: 4 });
    expect(s.scoring.ast).toBe(2);
    expect(s).toMatchObject({
      rosterPool: 520,
      rosterCap: 50,
      snakeTarget: 200,
      waveSize: 2,
      addsPerDay: 2,
      tradeReview: "commissioner",
      tradeReviewHours: 24,
      playoffTeams: 4,
      playoffRoundLength: 1,
      keepers: 0,
      tradeDeadline: null,
      regularSeasonStart: null,
    });
  });

  it("rejects bad values", () => {
    const ok = (patch: object) => leagueSettingsSchema.safeParse({ ...s, ...patch }).success;
    expect(ok({ playoffTeams: 5 })).toBe(false);
    expect(ok({ playoffRoundLength: 3 })).toBe(false);
    expect(ok({ tradeReview: "mob" })).toBe(false);
    expect(ok({ regularSeasonStart: "2026-13-40" })).toBe(false);
    expect(ok({ regularSeasonStart: "2026-12-01", regularSeasonEnd: "2026-11-01" })).toBe(false);
    expect(ok({ waveSize: 0 })).toBe(false);
    expect(ok({ playoffTeams: 6, regularSeasonStart: "2026-10-20", regularSeasonEnd: "2027-04-11" })).toBe(true);
  });

  it("fills missing fields when reading older stored settings", () => {
    const parsed = parseStoredSettings({ scoring: { pts: 2 }, addsPerDay: 5 });
    expect(parsed.scoring.pts).toBe(2);
    expect(parsed.scoring.teamWin).toBe(4);
    expect(parsed.addsPerDay).toBe(5);
    expect(parsed.rosterCap).toBe(50);
  });

  it("validates team names and abbreviations", () => {
    expect(teamNameSchema.safeParse("A").success).toBe(false);
    expect(teamNameSchema.safeParse("x".repeat(31)).success).toBe(false);
    expect(teamNameSchema.parse("  Dunkers ")).toBe("Dunkers");
    expect(teamAbbrevSchema.parse("dnk")).toBe("DNK");
    expect(teamAbbrevSchema.safeParse("D").success).toBe(false);
    expect(teamAbbrevSchema.safeParse("DUNKS").success).toBe(false);
    expect(teamAbbrevSchema.safeParse("D4").success).toBe(false);
  });
});

describe("roster sizing", () => {
  // teams, maxRoster, snakeRounds, waves count, last wave short
  const table: [number, number, number, number, boolean][] = [
    [16, 32, 12, 10, false],
    [12, 43, 16, 14, true], // 27 wave rounds: 13 waves of 2, then a final wave of 1
    [10, 50, 20, 15, false],
    [8, 50, 25, 13, true],
    [4, 50, 50, 0, false],
    [2, 50, 50, 0, false],
  ];
  it.each(table)("%i teams -> max %i, snake %i, %i waves", (teams, max, snake, count, short) => {
    expect(maxRoster(teams, s)).toBe(max);
    expect(snakeRounds(teams, s)).toBe(snake);
    const w = waves(teams, s);
    expect(w.count).toBe(count);
    expect(w.lastWaveShort).toBe(short);
    expect(snake + w.remainingRounds).toBe(max);
  });

  it("describes the 16-team draft as 12 snake rounds then 10 waves of 2", () => {
    expect(snakeRounds(16, s) * 16).toBe(192);
    expect(waves(16, s)).toMatchObject({ fullWaves: 10, lastWaveSize: 2 });
  });

  it("respects custom settings and zero teams", () => {
    const custom = defaultSettings({ rosterPool: 100, rosterCap: 20, snakeTarget: 8, waveSize: 3 });
    expect(maxRoster(4, custom)).toBe(20);
    expect(snakeRounds(4, custom)).toBe(2);
    expect(waves(4, custom)).toMatchObject({ remainingRounds: 18, count: 6, lastWaveShort: false });
    expect(maxRoster(0, s)).toBe(0);
    expect(snakeRounds(0, s)).toBe(0);
  });
});
