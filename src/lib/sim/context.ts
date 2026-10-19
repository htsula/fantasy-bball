/** Shared types and helpers for the league simulation. */
import { performance } from "node:perf_hooks";
import { eq as sqlEq, sql } from "drizzle-orm";
import { leagues } from "@/db/schema";
import type { Db } from "@/db/types";
import { etStartOfDay } from "@/lib/nba/dates";
import { notifier, type Notifier, type NotifyInput } from "@/lib/notifications/service";
import { MINUTE, type World } from "./nba-data";
import type { Rng } from "./rng";

export type CheckpointName =
  | "setup"
  | "draft-snake"
  | "draft-waves"
  | "preseason"
  | "regular-season"
  | "playoffs"
  | "complete"
  | "next-season"
  | "next-season-draft";

export type SimUser = {
  username: string;
  password: string;
  userId: string;
  /** Null for site users without a team in the league (the removed 17th joiner). */
  teamId: string | null;
  teamName: string | null;
  role: "commissioner" | "member" | "non-member";
  isSiteAdmin: boolean;
};

export type CheckpointContext = {
  now: Date;
  leagueId: string;
  nextLeagueId?: string;
  users: SimUser[];
};

export type SimOptions = {
  seed?: number;
  onCheckpoint?: (name: CheckpointName, ctx: CheckpointContext) => Promise<void>;
  /** Stop right after this checkpoint (debugging / partial runs). */
  until?: CheckpointName;
  log?: (message: string) => void;
  /** Run ANALYZE at each checkpoint (default true; production Postgres gets statistics from autovacuum). */
  analyze?: boolean;
};

export class StopSimulation extends Error {
  constructor(public at: CheckpointName) {
    super(`stopped after checkpoint ${at}`);
  }
}

export type Manager = SimUser & {
  teamId: string;
  teamName: string;
  abbrev: string;
  style: "value" | "queue" | "sleeper";
  /** Takes days to pick: the commissioner picks for these teams in some rounds. */
  stalled: boolean;
};

export type CheckpointRecord = { name: CheckpointName; now: Date; leagueStatus: string; note: string };

export type Counters = {
  assertions: number;
  picks: number;
  commissionerPicks: number;
  adds: number;
  drops: number;
  commissionerMoves: number;
  autoDrops: number;
  tradesProposed: number;
  tradesExecuted: number;
  chatMessages: number;
  gamesPlayed: number;
  oracleMatchups: number;
  liveChecks: number;
  smokeCalls: number;
  lateMoves: number;
  forcedTies: number;
};

export type Ctx = {
  db: Db;
  rand: Rng;
  world: World;
  opts: SimOptions;
  seed: number;
  admin: SimUser;
  managers: Manager[];
  nonMember: SimUser | null;
  /** Former owners and other accounts without a team, for the checkpoint user list. */
  extraUsers: SimUser[];
  /** Site user created by the single-use site invite (also a manager). */
  leagueId: string;
  leagueName: string;
  nextLeagueId?: string;
  counters: Counters;
  sent: NotifyInput[];
  notify: Notifier;
  checkpoints: CheckpointRecord[];
  slow: { label: string; ms: number }[];
  timings: Map<string, { n: number; total: number; max: number }>;
  findings: string[];
  now: Date;
  log: (message: string) => void;
};

export class SimAssertionError extends Error {}

export function ok(ctx: Pick<Ctx, "counters">, cond: unknown, message: string): asserts cond {
  ctx.counters.assertions++;
  if (!cond) throw new SimAssertionError(message);
}

export function eq<T>(ctx: Pick<Ctx, "counters">, actual: T, expected: T, message: string) {
  ctx.counters.assertions++;
  if (actual !== expected && JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new SimAssertionError(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** Asserts a promise rejects with a service error carrying `code`. */
export async function rejectsWith(ctx: Pick<Ctx, "counters">, promise: Promise<unknown>, code: string, what: string) {
  ctx.counters.assertions++;
  try {
    await promise;
  } catch (err) {
    const got = (err as { code?: string }).code;
    if (got !== code) throw new SimAssertionError(`${what}: expected error "${code}", got ${got ?? (err instanceof Error ? err.message : String(err))}`);
    return;
  }
  throw new SimAssertionError(`${what}: expected error "${code}" but the call succeeded`);
}

/** Times an async call; records every call and flags the ones slower than one second. */
export async function timed<T>(ctx: Pick<Ctx, "slow" | "timings">, label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    const ms = performance.now() - t0;
    const t = ctx.timings.get(label) ?? { n: 0, total: 0, max: 0 };
    t.n++;
    t.total += ms;
    t.max = Math.max(t.max, ms);
    ctx.timings.set(label, t);
    if (ms > 1000) ctx.slow.push({ label, ms: Math.round(ms) });
  }
}

/** Instant at HH:MM wall-clock-ish ET on an ET date (offset from 00:00 ET; off by an hour only on the two DST days). */
export function at(date: string, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(etStartOfDay(date).getTime() + (h * 60 + m) * MINUTE);
}

export function makeNotifier(sent: NotifyInput[]): Notifier {
  return async (db, input) => {
    sent.push(input);
    await notifier(db, input);
  };
}

export const sentTo = (ctx: Pick<Ctx, "sent">, userId: string, type: string) =>
  ctx.sent.filter((n) => n.type === type && n.userIds.includes(userId)).length;

/**
 * Fires the checkpoint hook. Nothing is mid-transaction here (every service call has returned), so a caller
 * may dump the database or crawl pages from inside the hook.
 */
export async function checkpoint(ctx: Ctx, name: CheckpointName, now: Date, note = "") {
  ctx.now = now;
  const statusOf = name.startsWith("next-season") && ctx.nextLeagueId ? ctx.nextLeagueId : ctx.leagueId;
  const [row] = await ctx.db.select({ status: leagues.status }).from(leagues).where(sqlEq(leagues.id, statusOf));
  ctx.checkpoints.push({ name, now, leagueStatus: row.status, note });
  // Fresh PGlite databases have no planner statistics (production Postgres has autovacuum): without them some
  // Players-page queries pick a nested loop and take ~9s. Analyze like autovacuum would before anything reads the data.
  if (ctx.opts.analyze !== false) await ctx.db.execute(sql`analyze`);
  const users: SimUser[] = [...ctx.managers, ...(ctx.nonMember ? [ctx.nonMember] : []), ...ctx.extraUsers];
  ctx.log(`checkpoint ${name} at ${now.toISOString()} (${row.status}) ${note}`);
  if (ctx.opts.onCheckpoint) await ctx.opts.onCheckpoint(name, { now, leagueId: ctx.leagueId, nextLeagueId: ctx.nextLeagueId, users });
  if (ctx.opts.until === name) throw new StopSimulation(name);
}

/** Rows of a raw SQL query (both PGlite and Neon return `{ rows }`). */
export async function rawRows(db: Db, query: Parameters<Db["execute"]>[0]): Promise<Record<string, unknown>[]> {
  return ((await db.execute(query)) as unknown as { rows: Record<string, unknown>[] }).rows;
}
