/** Display helpers (all times in America/New_York so server timezone never matters). */

const TZ = "America/New_York";

export function fmtEtTime(d: Date): string {
  return d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
}

export function fmtEtDate(d: Date, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }): string {
  return d.toLocaleDateString("en-US", { timeZone: TZ, ...opts });
}

export function fmtEtDateTime(d: Date): string {
  return d.toLocaleString("en-US", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" });
}

/** 77 -> 6'5" */
export function fmtHeight(inches: number | null | undefined): string | null {
  if (!inches) return null;
  return `${Math.floor(inches / 12)}'${inches % 12}"`;
}

/** Fixed-decimals number, or an em dash for null. */
export function fmtNum(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined || Number.isNaN(v) ? "-" : v.toFixed(digits);
}

export function fmtPct(v: number | null | undefined): string {
  return v === null || v === undefined ? "-" : `${(v * 100).toFixed(1)}%`;
}

/** ESPN season year -> "2025-26". */
export function seasonLabel(season: number): string {
  return `${season - 1}-${String(season).slice(2)}`;
}
