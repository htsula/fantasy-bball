import { describe, expect, it } from "vitest";
import { defaultStatsSeason, firstWeekEnd } from "@/lib/fantasy/season-default";

// 2027 = 2026-27. Opening night Tuesday 2026-10-20 at 7:30pm EDT (23:30Z).
const OPENING = new Date("2026-10-20T23:30:00Z");
// First Sunday on or after it is 2026-10-25; the first week ends Monday 2026-10-26 00:00 EDT (04:00Z).
const pick = (iso: string, openingNight: Date | null = OPENING) =>
  defaultStatsSeason({ current: 2027, openingNight, now: new Date(iso) });

describe("firstWeekEnd", () => {
  it("is midnight ET after the first Sunday on or after opening night", () => {
    expect(firstWeekEnd(OPENING).toISOString()).toBe("2026-10-26T04:00:00.000Z");
  });

  it("uses the ET date of opening night, not the UTC one", () => {
    // 2026-10-25T01:00Z is still Saturday 9pm ET: the first Sunday is the very next day.
    expect(firstWeekEnd(new Date("2026-10-25T01:00:00Z")).toISOString()).toBe("2026-10-26T04:00:00.000Z");
  });

  it("opening night on a Sunday ends that same night", () => {
    // Sunday 2026-10-25 at 3pm EDT.
    expect(firstWeekEnd(new Date("2026-10-25T19:00:00Z")).toISOString()).toBe("2026-10-26T04:00:00.000Z");
  });

  it("crosses the DST change: Sunday 2026-11-01 is 25 hours long", () => {
    // Opening night Tuesday 2026-10-27; DST ends 2026-11-01 02:00 EDT, so Monday 00:00 is 05:00Z (EST).
    expect(firstWeekEnd(new Date("2026-10-28T00:00:00Z")).toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });
});

describe("defaultStatsSeason", () => {
  it("is the previous season before opening night", () => {
    expect(pick("2026-10-14T15:00:00Z")).toBe(2026);
  });

  it("is the previous season on opening night (Tuesday)", () => {
    expect(pick("2026-10-20T23:30:00Z")).toBe(2026);
    expect(pick("2026-10-21T03:00:00Z")).toBe(2026);
  });

  it("is the previous season through Sunday 11:59:59pm ET", () => {
    expect(pick("2026-10-26T03:59:59Z")).toBe(2026);
  });

  it("is the current season from Monday 00:00 ET", () => {
    expect(pick("2026-10-26T04:00:00Z")).toBe(2027);
    expect(pick("2026-12-01T12:00:00Z")).toBe(2027);
  });

  it("is the previous season when no regular-season schedule is known", () => {
    expect(pick("2026-12-01T12:00:00Z", null)).toBe(2026);
  });

  it("handles the DST boundary inside the first week", () => {
    const opening = new Date("2026-10-28T00:00:00Z"); // Tuesday 8pm EDT
    expect(pick("2026-11-02T04:59:59Z", opening)).toBe(2026); // still Sunday 11:59:59pm EST
    expect(pick("2026-11-02T05:00:00Z", opening)).toBe(2027); // Monday 00:00 EST
  });
});
