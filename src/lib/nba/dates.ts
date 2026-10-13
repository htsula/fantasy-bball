/** America/New_York date helpers built on Intl (no date library). "ET date" = YYYY-MM-DD in New York. */

const TZ = "America/New_York";
const DAY_MS = 86_400_000;

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
});

function etParts(d: Date) {
  const p: Record<string, string> = {};
  for (const part of partsFmt.formatToParts(d)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: p.weekday,
  };
}

/** The ET calendar date of an instant, as YYYY-MM-DD. */
export function etDateString(d: Date): string {
  const p = etParts(d);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Hour (0-23) in ET. */
export function etHour(d: Date): number {
  return etParts(d).hour;
}

/** Offset of ET from UTC at the given instant, in ms (negative: -4h EDT / -5h EST). */
function etOffsetMs(d: Date): number {
  const p = etParts(d);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

function parseYmd(s: string): { y: number; m: number; d: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`Invalid date "${s}", expected YYYY-MM-DD`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

export function isEtDateString(s: string | undefined | null): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const { y, m, d } = parseYmd(s);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Adds calendar days to a YYYY-MM-DD string (pure calendar math, DST-proof). */
export function addDays(date: string, n: number): string {
  const { y, m, d } = parseYmd(date);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The UTC instant at which the given ET calendar date begins (00:00 ET). */
export function etStartOfDay(date: string): Date {
  const { y, m, d } = parseYmd(date);
  const midnightUtc = Date.UTC(y, m - 1, d);
  // 05:00Z is 00:00 EST / 01:00 EDT on that date: always before the 02:00 DST switch, so the
  // offset sampled there is the offset in effect at ET midnight.
  const offset = etOffsetMs(new Date(midnightUtc + 5 * 3_600_000));
  return new Date(midnightUtc - offset);
}

/** Half-open [start, end) instants covering one ET day (23 or 25 hours on DST days). */
export function etDayRange(date: string): { start: Date; end: Date } {
  return { start: etStartOfDay(date), end: etStartOfDay(addDays(date, 1)) };
}

/** ESPN date param: YYYY-MM-DD -> YYYYMMDD. */
export function toEspnDate(date: string): string {
  return date.replace(/-/g, "");
}

/** YYYY-MM-DD -> YYYYMM (month form of the scoreboard endpoint). */
export function toEspnMonth(date: string): string {
  return date.slice(0, 7).replace("-", "");
}

/** Monday-start ET week containing `now`: [start, end) instants plus the Monday date. */
export function etWeekRange(now: Date): { start: Date; end: Date; startDate: string } {
  const today = etDateString(now);
  const { y, m, d } = parseYmd(today);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  const startDate = addDays(today, -((dow + 6) % 7));
  return { start: etStartOfDay(startDate), end: etStartOfDay(addDays(startDate, 7)), startDate };
}

/**
 * ESPN season year (the year the season ends): Aug-Dec belong to the season ending next year,
 * Jan-Jul to the one ending this year.
 */
export function seasonYearFor(now: Date): number {
  const p = etParts(now);
  return p.month >= 8 ? p.year + 1 : p.year;
}

export const MS_PER_DAY = DAY_MS;
