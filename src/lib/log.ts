/**
 * Tiny structured logger: one JSON object per line on stdout/stderr, which Vercel's log viewer
 * (Project -> Logs) can filter by `level` and `event`.
 *
 *   log.info("cron.daily", { ok: true, durationMs: 812 });
 *   log.error("push.send_failed", { userId }, err);
 *
 * Context is scrubbed: any key that looks like a secret (password, token, secret, authorization, cookie,
 * key, auth, endpoint, p256dh, session) is replaced with "[redacted]". Never pass secrets on purpose anyway.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const REDACT = /pass(word)?|token|secret|authorization|cookie|key|auth|endpoint|p256dh|session|credential/i;
const MAX_DEPTH = 4;
const MAX_STRING = 500;

function scrub(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...` : value;
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return errorFields(value);
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT.test(k) ? "[redacted]" : scrub(v, depth + 1);
  }
  return out;
}

/** name / message / first stack lines of an unknown thrown value. */
export function errorFields(err: unknown): { name: string; message: string; stack?: string; code?: unknown } {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      name: err.name,
      message: err.message.slice(0, MAX_STRING),
      stack: err.stack?.split("\n").slice(0, 6).join("\n"),
      ...(code !== undefined ? { code } : {}),
    };
  }
  return { name: "NonError", message: String(err).slice(0, MAX_STRING) };
}

/** The serialized line (exported for tests). */
export function formatLog(level: LogLevel, event: string, context?: Record<string, unknown>, err?: unknown): string {
  const entry: Record<string, unknown> = { time: new Date().toISOString(), level, event };
  if (context) Object.assign(entry, { ctx: scrub(context) });
  if (err !== undefined) entry.error = errorFields(err);
  try {
    return JSON.stringify(entry);
  } catch {
    return JSON.stringify({ time: entry.time, level, event, ctx: "[unserializable]" });
  }
}

function emit(level: LogLevel, event: string, context?: Record<string, unknown>, err?: unknown) {
  const line = formatLog(level, event, context, err);
  // Looked up at call time so tests can spy on console.
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, context?: Record<string, unknown>) => emit("debug", event, context),
  info: (event: string, context?: Record<string, unknown>) => emit("info", event, context),
  warn: (event: string, context?: Record<string, unknown>, err?: unknown) => emit("warn", event, context, err),
  error: (event: string, context?: Record<string, unknown>, err?: unknown) => emit("error", event, context, err),
};
