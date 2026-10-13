import { describe, expect, it } from "vitest";
import { DEFAULT_POINTS, fantasyPoints, type PointValues } from "@/lib/fantasy/points";

describe("fantasyPoints", () => {
  it("applies the default scoring", () => {
    // 11 pts, 6 reb, 0 ast, 2 stl, 1 blk, 2 to, 4/6 fg, 2/3 ft, 1 three
    const line = { pts: 11, reb: 6, ast: 0, stl: 2, blk: 1, to: 2, fgm: 4, fga: 6, ftm: 2, fta: 3, tpm: 1 };
    // 11 + 6 + 0 + 8 + 4 - 4 + 8 - 6 + 2 - 3 + 1
    expect(fantasyPoints(line)).toBe(27);
  });

  it("uses the documented default values", () => {
    expect(DEFAULT_POINTS).toEqual({
      pts: 1, reb: 1, ast: 2, stl: 4, blk: 4, to: -2, fgm: 2, fga: -1, ftm: 1, fta: -1, tpm: 1,
    });
  });

  it("treats missing and null stats as zero", () => {
    expect(fantasyPoints({})).toBe(0);
    expect(fantasyPoints({ pts: 10, ast: null })).toBe(10);
  });

  it("accepts custom point values", () => {
    const values: PointValues = { ...DEFAULT_POINTS, pts: 0.5, to: -1, ast: 1.5 };
    expect(fantasyPoints({ pts: 20, to: 3, ast: 4 }, values)).toBe(10 - 3 + 6);
  });

  it("ignores extra keys on a full stat row", () => {
    expect(fantasyPoints({ pts: 2, minutes: 30, pf: 5 } as never)).toBe(2);
  });
});
