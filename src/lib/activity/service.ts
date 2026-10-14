/**
 * League activity log: one append-only timeline fed by the services that change league state.
 * `logActivity` takes any Db (a transaction included), so callers write the entry in the same
 * transaction as the change: if the change rolls back, so does its log line. Commissioner actions
 * are always logged with their actor. Logging never throws into a caller that isn't in a
 * transaction (see `logActivitySafe`).
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { log } from "@/lib/log";
import { activityLog, users } from "@/db/schema";
import type { Db } from "@/db/types";
import { ACTIVITY_FILTERS, typesForFilter, type ActivityFilter, type ActivityType } from "./types";

export * from "./types";

export type LogInput = {
  leagueId: string;
  /** Null for system actions (auto-drops, nightly jobs). */
  actorUserId: string | null;
  type: ActivityType;
  summary: string;
  data?: Record<string, unknown>;
  now?: Date;
};

export async function logActivity(db: Db, input: LogInput): Promise<void> {
  await db.insert(activityLog).values({
    leagueId: input.leagueId,
    actorUserId: input.actorUserId,
    type: input.type,
    summary: input.summary.slice(0, 1000),
    data: input.data ?? null,
    createdAt: input.now ?? new Date(),
  });
}

/** For code paths outside a transaction where a logging hiccup must not undo the real change. */
export async function logActivitySafe(db: Db, input: LogInput): Promise<void> {
  try {
    await logActivity(db, input);
  } catch (err) {
    log.error("activity.log_failed", { type: input.type }, err);
  }
}

export type ActivityEntry = {
  id: string;
  type: string;
  summary: string;
  data: Record<string, unknown> | null;
  createdAt: Date;
  actorUserId: string | null;
  actorUsername: string | null;
};

export type ActivityPage = { entries: ActivityEntry[]; total: number };

export function parseFilter(v: unknown): ActivityFilter | undefined {
  return typeof v === "string" && (ACTIVITY_FILTERS as readonly string[]).includes(v) ? (v as ActivityFilter) : undefined;
}

export async function listActivity(
  db: Db,
  leagueId: string,
  opts: { filter?: ActivityFilter; limit?: number; offset?: number } = {},
): Promise<ActivityPage> {
  const where = and(
    eq(activityLog.leagueId, leagueId),
    opts.filter ? inArray(activityLog.type, typesForFilter(opts.filter)) : undefined,
  );
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: activityLog.id,
        type: activityLog.type,
        summary: activityLog.summary,
        data: activityLog.data,
        createdAt: activityLog.createdAt,
        actorUserId: activityLog.actorUserId,
        actorUsername: users.username,
      })
      .from(activityLog)
      .leftJoin(users, eq(users.id, activityLog.actorUserId))
      .where(where)
      .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
      .limit(limit)
      .offset(Math.max(0, opts.offset ?? 0)),
    db.select({ total: sql<number>`count(*)::int` }).from(activityLog).where(where),
  ]);
  return { entries: rows, total };
}
