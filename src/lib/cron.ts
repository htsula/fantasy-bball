import { timingSafeEqual } from "node:crypto";

/**
 * Verifies `Authorization: Bearer ${CRON_SECRET}`. Vercel Cron sends this header
 * automatically when CRON_SECRET is set in the project's env vars.
 */
export function verifyCronRequest(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed when unconfigured
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(req.headers.get("authorization") ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
