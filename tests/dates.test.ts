import { describe, expect, it } from "vitest";
import {
  addDays,
  etDateString,
  etDayRange,
  etStartOfDay,
  etWeekRange,
  isEtDateString,
  seasonYearFor,
  toEspnDate,
  toEspnMonth,
} from "@/lib/nba/dates";

describe("ET date util", () => {
  it("rolls the ET date over at local midnight, not UTC midnight (EST)", () => {
    expect(etDateString(new Date("2026-01-15T04:59:59Z"))).toBe("2026-01-14");
    expect(etDateString(new Date("2026-01-15T05:00:00Z"))).toBe("2026-01-15");
  });

  it("rolls over an hour earlier in UTC during EDT", () => {
    expect(etDateString(new Date("2026-07-15T03:59:59Z"))).toBe("2026-07-14");
    expect(etDateString(new Date("2026-07-15T04:00:00Z"))).toBe("2026-07-15");
  });

  it("keeps a late tip-off on the same ET day", () => {
    expect(etDateString(new Date("2026-03-10T23:00:00Z"))).toBe("2026-03-10");
    expect(etDateString(new Date("2026-03-11T05:30:00Z"))).toBe("2026-03-11");
  });

  it("computes ET day boundaries across DST changes", () => {
    // Spring forward 2026-03-08: 23-hour day, midnight is still EST.
    expect(etStartOfDay("2026-03-08").toISOString()).toBe("2026-03-08T05:00:00.000Z");
    const spring = etDayRange("2026-03-08");
    expect((spring.end.getTime() - spring.start.getTime()) / 3_600_000).toBe(23);
    expect(spring.end.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    // Fall back 2026-11-01: 25-hour day.
    const fall = etDayRange("2026-11-01");
    expect(fall.start.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect((fall.end.getTime() - fall.start.getTime()) / 3_600_000).toBe(25);
    // Ordinary day.
    const plain = etDayRange("2026-02-10");
    expect((plain.end.getTime() - plain.start.getTime()) / 3_600_000).toBe(24);
  });

  it("does calendar arithmetic and ESPN formats", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(toEspnDate("2026-03-10")).toBe("20260310");
    expect(toEspnMonth("2026-03-10")).toBe("202603");
  });

  it("validates date strings", () => {
    expect(isEtDateString("2026-03-10")).toBe(true);
    expect(isEtDateString("2026-02-30")).toBe(false);
    expect(isEtDateString("nope")).toBe(false);
    expect(isEtDateString(undefined)).toBe(false);
  });

  it("finds the Monday-start fantasy week", () => {
    const w = etWeekRange(new Date("2026-03-11T15:00:00Z")); // Wed
    expect(w.startDate).toBe("2026-03-09");
    expect(etDateString(w.start)).toBe("2026-03-09");
    expect(etDateString(w.end)).toBe("2026-03-16");
    // Sunday late night ET still belongs to the week that started the prior Monday.
    expect(etWeekRange(new Date("2026-03-16T03:30:00Z")).startDate).toBe("2026-03-09");
  });

  it("derives the ESPN season year", () => {
    expect(seasonYearFor(new Date("2026-10-13T20:00:00Z"))).toBe(2027);
    expect(seasonYearFor(new Date("2026-03-10T20:00:00Z"))).toBe(2026);
    expect(seasonYearFor(new Date("2026-06-15T20:00:00Z"))).toBe(2026);
  });
});
