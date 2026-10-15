/**
 * Which season the player lists show by default. Pure (no database): the caller passes the current
 * season's opening night. Until the first week of the regular season is over the previous season is
 * the better guide (a few games say little), after that the current season takes over.
 */
import { addDays, etDateString, etStartOfDay } from "@/lib/nba/dates";

/**
 * The instant the first week ends: 00:00 ET on the Monday after the first Sunday on or after the
 * opening night's ET date (i.e. Sunday 23:59:59 ET is still inside the first week). Uses calendar-day
 * math, so DST changes in that week do not matter.
 */
export function firstWeekEnd(openingNight: Date): Date {
  const date = etDateString(openingNight);
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  const sunday = addDays(date, (7 - dow) % 7);
  return etStartOfDay(addDays(sunday, 1));
}

/** `current` once the first week of its regular season has ended, otherwise `current - 1`. */
export function defaultStatsSeason(o: { current: number; openingNight: Date | null; now: Date }): number {
  if (!o.openingNight) return o.current - 1;
  return o.now.getTime() >= firstWeekEnd(o.openingNight).getTime() ? o.current : o.current - 1;
}
