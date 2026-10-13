/**
 * NBA sync jobs. Each takes a `Db` and an `EspnClient` (so tests inject fixtures), records a
 * `sync_runs` row, and only performs idempotent upserts.
 */
import { and, desc, eq, gte, inArray, lt, lte, notInArray, or, sql, type AnyColumn } from "drizzle-orm";
import {
  nbaGames,
  nbaInjuries,
  nbaNews,
  nbaPlayers,
  nbaTeams,
  playerGameStats,
  rawSnapshots,
  syncRuns,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { addDays, etDateString, etDayRange, seasonYearFor, toEspnDate, toEspnMonth } from "./dates";
import { createEspnClient, EspnHttpError, type EspnClient } from "./espn";
import {
  normalizeBoxscore,
  normalizeInjuries,
  normalizeNews,
  normalizeRoster,
  normalizeScoreboard,
  normalizeTeams,
  type GameRow,
  type InjuryRow,
  type NewsRow,
  type PlayerRow,
  type StatRow,
  type TeamRow,
} from "./normalize";

const MIN = 60_000;
const HOUR = 3_600_000;

export type SyncOptions = {
  /** Injectable clock for tests. */
  now?: () => Date;
  /** syncDaily: wall-clock budget for the whole run (default 45s, under Vercel's 60s). */
  budgetMs?: number;
  concurrency?: number;
  /** syncDaily: ESPN season years to backfill (default: the current season). */
  seasons?: number[];
};

export type SyncResult = {
  job: string;
  ok: boolean;
  error?: string;
  skipped?: string;
  counts: Record<string, unknown>;
};

// ---------------------------------------------------------------------------------------------
// helpers

const excluded = (col: AnyColumn) => sql.raw(`excluded."${col.name}"`);

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** Runs `fn` over `items` with bounded concurrency; never rejects (errors go to `onError`). */
async function mapPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  onError: (item: T, err: unknown) => void,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (err) {
        onError(item, err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

const SLIM_DROP = new Set([
  "links", "leaders", "headlines", "highlights", "broadcasts", "geoBroadcasts", "broadcast", "odds",
  "pickcenter", "plays", "videos", "article", "news", "winprobability", "standings", "againstTheSpread",
  "seasonseries", "gameInfo", "contracts", "contract", "college", "birthPlace",
]);

/** Drops bulky, unused ESPN sections before a payload is stored in raw_snapshots. */
export function slimForSnapshot(value: unknown, extraDrop?: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => slimForSnapshot(v, extraDrop));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SLIM_DROP.has(k) || extraDrop?.has(k)) continue;
      out[k] = slimForSnapshot(v, extraDrop);
    }
    return out;
  }
  return value;
}

export async function saveSnapshot(db: Db, kind: string, key: string, payload: unknown, now: Date) {
  await db
    .insert(rawSnapshots)
    .values({ kind, key, payload: payload as never, fetchedAt: now })
    .onConflictDoUpdate({
      target: [rawSnapshots.kind, rawSnapshots.key],
      set: { payload: sql`excluded."payload"`, fetchedAt: now },
    });
}

async function getSnapshot(db: Db, kind: string, key: string) {
  const [row] = await db
    .select({ fetchedAt: rawSnapshots.fetchedAt, payload: rawSnapshots.payload })
    .from(rawSnapshots)
    .where(and(eq(rawSnapshots.kind, kind), eq(rawSnapshots.key, key)));
  return row;
}

/** Wraps a job body: writes the sync_runs row and converts exceptions into a failed result. */
async function recordRun(
  db: Db,
  job: string,
  now: () => Date,
  body: () => Promise<{ counts: Record<string, unknown>; errors?: string[] }>,
): Promise<SyncResult> {
  let runId: number | undefined;
  try {
    const [row] = await db.insert(syncRuns).values({ job, startedAt: now() }).returning({ id: syncRuns.id });
    runId = row.id;
  } catch (err) {
    console.error(`[sync:${job}] could not record run start`, err);
  }
  let result: SyncResult;
  try {
    const { counts, errors = [] } = await body();
    result = { job, ok: errors.length === 0, counts, ...(errors.length ? { error: errors.join("; ").slice(0, 2000) } : {}) };
  } catch (err) {
    result = { job, ok: false, counts: {}, error: (err instanceof Error ? err.message : String(err)).slice(0, 2000) };
  }
  if (!result.ok) console.error(`[sync:${job}] failed: ${result.error}`);
  if (runId !== undefined) {
    try {
      await db
        .update(syncRuns)
        .set({ finishedAt: now(), ok: result.ok, error: result.error ?? null, counts: result.counts })
        .where(eq(syncRuns.id, runId));
    } catch (err) {
      console.error(`[sync:${job}] could not record run end`, err);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// upserts (all idempotent)

export async function upsertTeams(db: Db, rows: TeamRow[], now = new Date()) {
  for (const part of chunk(rows, 100)) {
    await db
      .insert(nbaTeams)
      .values(part.map((r) => ({ ...r, updatedAt: now })))
      .onConflictDoUpdate({
        target: nbaTeams.id,
        set: {
          abbrev: excluded(nbaTeams.abbrev),
          name: excluded(nbaTeams.name),
          location: excluded(nbaTeams.location),
          logo: excluded(nbaTeams.logo),
          color: excluded(nbaTeams.color),
          updatedAt: now,
        },
      });
  }
}

/**
 * "full" refreshes bio/team/positions from a roster; "insert-only" just makes sure a player
 * seen in a box score exists (so stat rows have something to point at) without clobbering.
 * Injury cache columns are never touched here.
 */
export async function upsertPlayers(db: Db, rows: PlayerRow[], mode: "full" | "insert-only", now = new Date()) {
  for (const part of chunk(rows, 100)) {
    const q = db.insert(nbaPlayers).values(part.map((r) => ({ ...r, updatedAt: now })));
    if (mode === "insert-only") {
      await q.onConflictDoNothing();
      continue;
    }
    await q.onConflictDoUpdate({
      target: nbaPlayers.id,
      set: {
        fullName: excluded(nbaPlayers.fullName),
        firstName: excluded(nbaPlayers.firstName),
        lastName: excluded(nbaPlayers.lastName),
        teamId: excluded(nbaPlayers.teamId),
        positions: excluded(nbaPlayers.positions),
        espnPosition: excluded(nbaPlayers.espnPosition),
        jersey: excluded(nbaPlayers.jersey),
        headshotUrl: excluded(nbaPlayers.headshotUrl),
        heightInches: excluded(nbaPlayers.heightInches),
        weightLbs: excluded(nbaPlayers.weightLbs),
        age: excluded(nbaPlayers.age),
        birthDate: excluded(nbaPlayers.birthDate),
        experienceYears: excluded(nbaPlayers.experienceYears),
        active: excluded(nbaPlayers.active),
        updatedAt: now,
      },
    });
  }
}

export async function upsertGames(db: Db, rows: GameRow[], now = new Date()) {
  if (rows.length === 0) return;
  const existing = new Map<number, Date | null>();
  for (const part of chunk(rows, 500)) {
    const found = await db
      .select({ id: nbaGames.id, finishedAt: nbaGames.finishedAt })
      .from(nbaGames)
      .where(inArray(nbaGames.id, part.map((r) => r.id)));
    for (const f of found) existing.set(f.id, f.finishedAt);
  }
  for (const part of chunk(rows, 100)) {
    const values = part.map((r) => {
      let finishedAt: Date | null = existing.get(r.id) ?? null;
      if (r.status === "final" && !finishedAt) {
        // First sighting of the final: "now" if it just ended, else an estimate for old games
        // so backfilled history never looks like it finished this minute.
        finishedAt = now.getTime() - r.startTime.getTime() < 8 * HOUR ? now : new Date(r.startTime.getTime() + 3 * HOUR);
      }
      return { ...r, finishedAt, updatedAt: now };
    });
    await db
      .insert(nbaGames)
      .values(values)
      .onConflictDoUpdate({
        target: nbaGames.id,
        set: {
          season: excluded(nbaGames.season),
          seasonType: excluded(nbaGames.seasonType),
          startTime: excluded(nbaGames.startTime),
          homeTeamId: excluded(nbaGames.homeTeamId),
          awayTeamId: excluded(nbaGames.awayTeamId),
          homeScore: excluded(nbaGames.homeScore),
          awayScore: excluded(nbaGames.awayScore),
          status: excluded(nbaGames.status),
          statusDetail: excluded(nbaGames.statusDetail),
          period: excluded(nbaGames.period),
          clock: excluded(nbaGames.clock),
          finishedAt: excluded(nbaGames.finishedAt),
          updatedAt: now,
        },
      });
  }
}

export async function upsertStats(db: Db, rows: StatRow[], now = new Date()) {
  for (const part of chunk(rows, 100)) {
    await db
      .insert(playerGameStats)
      .values(part.map((r) => ({ ...r, updatedAt: now })))
      .onConflictDoUpdate({
        target: [playerGameStats.gameId, playerGameStats.playerId],
        set: {
          teamId: excluded(playerGameStats.teamId),
          minutes: excluded(playerGameStats.minutes),
          fgm: excluded(playerGameStats.fgm),
          fga: excluded(playerGameStats.fga),
          ftm: excluded(playerGameStats.ftm),
          fta: excluded(playerGameStats.fta),
          tpm: excluded(playerGameStats.tpm),
          tpa: excluded(playerGameStats.tpa),
          reb: excluded(playerGameStats.reb),
          oreb: excluded(playerGameStats.oreb),
          dreb: excluded(playerGameStats.dreb),
          ast: excluded(playerGameStats.ast),
          stl: excluded(playerGameStats.stl),
          blk: excluded(playerGameStats.blk),
          to: excluded(playerGameStats.to),
          pf: excluded(playerGameStats.pf),
          pts: excluded(playerGameStats.pts),
          dnp: excluded(playerGameStats.dnp),
          dnpReason: excluded(playerGameStats.dnpReason),
          updatedAt: now,
        },
      });
  }
}

/** Replaces nba_injuries with the feed and refreshes/clears the cached columns on players. */
export async function applyInjuries(db: Db, rows: InjuryRow[], now = new Date()) {
  const ids = rows.map((r) => r.playerId);
  await db.delete(nbaInjuries).where(ids.length ? notInArray(nbaInjuries.playerId, ids) : sql`true`);
  for (const part of chunk(rows, 100)) {
    await db
      .insert(nbaInjuries)
      .values(part.map((r) => ({ ...r, updatedAt: now })))
      .onConflictDoUpdate({
        target: nbaInjuries.playerId,
        set: {
          teamId: excluded(nbaInjuries.teamId),
          status: excluded(nbaInjuries.status),
          detail: excluded(nbaInjuries.detail),
          shortComment: excluded(nbaInjuries.shortComment),
          longComment: excluded(nbaInjuries.longComment),
          date: excluded(nbaInjuries.date),
          updatedAt: now,
        },
      });
  }
  // Players no longer listed are healthy again.
  await db
    .update(nbaPlayers)
    .set({ injuryStatus: null, injuryDetail: null, injuryUpdatedAt: null })
    .where(
      and(
        sql`${nbaPlayers.injuryStatus} is not null`,
        ids.length ? notInArray(nbaPlayers.id, ids) : sql`true`,
      ),
    );
  for (const part of chunk(rows, 200)) {
    const values = sql.join(
      part.map(
        (r) =>
          sql`(${r.playerId}::integer, ${r.status}::text, ${r.detail ?? r.shortComment}::text, ${(r.date ?? now).toISOString()}::timestamptz)`,
      ),
      sql`, `,
    );
    await db.execute(sql`
      update "nba_players"
      set "injury_status" = v.status, "injury_detail" = v.detail, "injury_updated_at" = v.updated
      from (values ${values}) as v(id, status, detail, updated)
      where "nba_players"."id" = v.id
    `);
  }
}

export async function upsertNews(db: Db, rows: NewsRow[], now = new Date()) {
  for (const part of chunk(rows, 50)) {
    await db
      .insert(nbaNews)
      .values(part.map((r) => ({ ...r, updatedAt: now })))
      .onConflictDoUpdate({
        target: nbaNews.id,
        set: {
          headline: excluded(nbaNews.headline),
          description: excluded(nbaNews.description),
          published: excluded(nbaNews.published),
          link: excluded(nbaNews.link),
          image: excluded(nbaNews.image),
          relatedPlayerIds: excluded(nbaNews.relatedPlayerIds),
          relatedTeamIds: excluded(nbaNews.relatedTeamIds),
          updatedAt: now,
        },
      });
  }
}

// ---------------------------------------------------------------------------------------------
// ingest = normalize + store (shared by the sync jobs and the offline seed)

export async function ingestTeams(db: Db, raw: unknown, now = new Date()) {
  const teams = normalizeTeams(raw);
  await upsertTeams(db, teams, now);
  return teams.length;
}

export async function ingestRoster(db: Db, raw: unknown, now = new Date()) {
  const { team, players } = normalizeRoster(raw);
  if (team) await upsertTeams(db, [team], now);
  await upsertPlayers(db, players, "full", now);
  return players;
}

export async function ingestScoreboard(db: Db, raw: unknown, now = new Date()) {
  const { games, teams } = normalizeScoreboard(raw);
  await upsertTeams(db, teams, now);
  await upsertGames(db, games, now);
  return games.length;
}

/**
 * Stores one box score. `markFinalAfterMs`: once the game is final and has been final for at
 * least this long, flag it stats-final so live syncs stop re-pulling it.
 */
export async function ingestSummary(
  db: Db,
  gameId: number,
  raw: unknown,
  now = new Date(),
  markFinalAfterMs = 10 * MIN,
): Promise<{ statRows: number; final: boolean; known: boolean }> {
  const { game, players, stats } = normalizeBoxscore(raw);
  const [existing] = await db
    .select({ id: nbaGames.id, finishedAt: nbaGames.finishedAt })
    .from(nbaGames)
    .where(eq(nbaGames.id, gameId));
  if (!existing) return { statRows: 0, final: false, known: false };
  if (game && game.id !== gameId) console.warn(`[sync] summary id ${game.id} != requested ${gameId}`);

  await upsertPlayers(db, players, "insert-only", now);
  await upsertStats(db, stats.filter((s) => s.gameId === gameId), now);

  const final = game?.status === "final";
  const finishedAt = existing.finishedAt ?? now;
  const markFinal = final && now.getTime() - finishedAt.getTime() >= markFinalAfterMs;
  await db
    .update(nbaGames)
    .set({
      ...(game
        ? {
            status: game.status,
            statusDetail: game.statusDetail,
            // The summary header may omit live period/clock; never blank out what the scoreboard set.
            ...(game.period !== null ? { period: game.period } : {}),
            ...(game.clock !== null || final ? { clock: game.clock } : {}),
            ...(game.homeScore !== null ? { homeScore: game.homeScore } : {}),
            ...(game.awayScore !== null ? { awayScore: game.awayScore } : {}),
            finishedAt: final ? finishedAt : existing.finishedAt,
          }
        : {}),
      ...(markFinal ? { statsFinal: true } : {}),
      statsSyncedAt: now,
      updatedAt: now,
    })
    .where(eq(nbaGames.id, gameId));
  await saveSnapshot(db, "summary", String(gameId), slimForSnapshot(raw), now);
  return { statRows: stats.length, final: markFinal, known: true };
}

/**
 * Fetch + store one box score for backfill/corrections. A 404 on an old final game means ESPN
 * has no box score for it (seen on some playoff events); flag it settled so it is not retried
 * forever instead of failing the run.
 */
async function pullSummary(db: Db, client: EspnClient, id: number, now: Date, markFinalAfterMs?: number) {
  try {
    const res = await ingestSummary(db, id, await client.summary(id), now, markFinalAfterMs);
    return { statRows: res.statRows, missing: false };
  } catch (err) {
    if (err instanceof EspnHttpError && err.status === 404) {
      const [g] = await db.select({ startTime: nbaGames.startTime }).from(nbaGames).where(eq(nbaGames.id, id));
      if (g && now.getTime() - g.startTime.getTime() > 36 * HOUR) {
        await db.update(nbaGames).set({ statsFinal: true, statsSyncedAt: now }).where(eq(nbaGames.id, id));
        return { statRows: 0, missing: true };
      }
    }
    throw err;
  }
}

export async function ingestInjuries(db: Db, raw: unknown, now = new Date()) {
  const rows = normalizeInjuries(raw);
  await applyInjuries(db, rows, now);
  return rows.length;
}

export async function ingestNews(db: Db, raw: unknown, now = new Date()) {
  const rows = normalizeNews(raw);
  await upsertNews(db, rows, now);
  return rows.length;
}

// ---------------------------------------------------------------------------------------------
// live window

/** Games that need live attention right now. Pure DB check, no network. */
export async function liveWindow(db: Db, now: Date) {
  const rows = await db
    .select({ id: nbaGames.id, status: nbaGames.status, startTime: nbaGames.startTime })
    .from(nbaGames)
    .where(
      or(
        eq(nbaGames.status, "in"),
        // tipping off within the hour, or tipped off recently and we have not seen it start yet
        and(
          eq(nbaGames.status, "scheduled"),
          gte(nbaGames.startTime, new Date(now.getTime() - 3 * HOUR)),
          lte(nbaGames.startTime, new Date(now.getTime() + HOUR)),
        ),
        // finished recently and the post-final box score has not been settled
        and(
          eq(nbaGames.status, "final"),
          eq(nbaGames.statsFinal, false),
          gte(nbaGames.finishedAt, new Date(now.getTime() - 3 * HOUR)),
        ),
      ),
    );
  return {
    active: rows.length > 0,
    games: rows,
    /** A scheduled game whose tip-off has passed: status is stale, so refresh the scoreboard now. */
    overdue: rows.some((r) => r.status === "scheduled" && r.startTime <= now),
  };
}

// ---------------------------------------------------------------------------------------------
// syncDaily

const DEFAULT_CONCURRENCY = 4;
const SCOREBOARD_THROTTLE_MS = 5 * MIN;

async function pullScoreboardDay(db: Db, client: EspnClient, date: string, now: Date) {
  const raw = await client.scoreboard(toEspnDate(date));
  const n = await ingestScoreboard(db, raw, now);
  await saveSnapshot(db, "scoreboard", toEspnDate(date), slimForSnapshot(raw, new Set(["statistics"])), now);
  return n;
}

/** Months (YYYY-MM-01 strings) of a season's schedule: October of the prior year through April. */
export function seasonMonths(seasonYear: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    const month = 10 + i; // Oct..Apr
    const year = month > 12 ? seasonYear : seasonYear - 1;
    out.push(`${year}-${String(((month - 1) % 12) + 1).padStart(2, "0")}-01`);
  }
  return out;
}

export async function syncDaily(db: Db, client: EspnClient, opts: SyncOptions = {}): Promise<SyncResult> {
  const now = opts.now ?? (() => new Date());
  const conc = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const started = performance.now();
  const budget = opts.budgetMs ?? 45_000;
  const overBudget = () => performance.now() - started > budget;

  return recordRun(db, "daily", now, async () => {
    const errors: string[] = [];
    const counts: Record<string, unknown> = {};
    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    const t = now();
    const today = etDateString(t);

    // 1. teams
    let teamIds: number[] = [];
    await step("teams", async () => {
      const raw = await client.teams();
      const rows = normalizeTeams(raw);
      await upsertTeams(db, rows, t);
      teamIds = rows.map((r) => r.id);
      counts.teams = rows.length;
    });
    if (teamIds.length === 0) {
      teamIds = (await db.select({ id: nbaTeams.id }).from(nbaTeams)).map((r) => r.id);
    }

    // 2. rosters
    const seen = new Set<number>();
    let rosterFailures = 0;
    await mapPool(
      teamIds,
      conc,
      async (id) => {
        const raw = await client.roster(id);
        const { players } = normalizeRoster(raw);
        if (players.length < 5) throw new Error(`roster ${id} looked empty (${players.length})`);
        await ingestRoster(db, raw, t);
        for (const p of players) seen.add(p.id);
      },
      (id, err) => {
        rosterFailures++;
        errors.push(`roster ${id}: ${err instanceof Error ? err.message : String(err)}`);
      },
    );
    counts.rosters = { ok: teamIds.length - rosterFailures, failed: rosterFailures };
    counts.rosterPlayers = seen.size;
    // Only when every roster loaded: anyone not on a roster is released/inactive.
    if (teamIds.length >= 25 && rosterFailures === 0 && seen.size > 0) {
      await step("deactivate", async () => {
        await db
          .update(nbaPlayers)
          .set({ active: false, teamId: null, updatedAt: t })
          .where(and(eq(nbaPlayers.active, true), notInArray(nbaPlayers.id, [...seen])));
      });
    }

    // 3. injuries, 4. news
    await step("injuries", async () => {
      counts.injuries = await ingestInjuries(db, await client.injuries(), t);
    });
    await step("news", async () => {
      counts.news = await ingestNews(db, await client.news(50), t);
    });

    // 5. schedule window: yesterday .. today+7
    const dates = Array.from({ length: 9 }, (_, i) => addDays(today, i - 1));
    let windowGames = 0;
    await mapPool(
      dates,
      conc,
      async (date) => {
        windowGames += await pullScoreboardDay(db, client, date, t);
      },
      (date, err) => errors.push(`scoreboard ${date}: ${err instanceof Error ? err.message : String(err)}`),
    );
    counts.windowGames = windowGames;

    // 6. backfill: season schedule month by month, then missing box scores (resumable)
    const seasons = opts.seasons ?? [seasonYearFor(t)];
    let months = 0;
    let monthGames = 0;
    for (const season of seasons) {
      for (const monthStart of seasonMonths(season)) {
        if (overBudget()) break;
        const key = toEspnMonth(monthStart);
        const nextMonth = addDays(monthStart, 31).slice(0, 7) + "-01";
        const complete = nextMonth <= addDays(today, -1); // entirely in the past: fetch once, ever
        const future = monthStart > today;
        const marker = await getSnapshot(db, "schedule-month", key);
        if (marker) {
          const done = (marker.payload as { complete?: boolean } | null)?.complete === true;
          const fresh = t.getTime() - marker.fetchedAt.getTime() < 3 * 24 * HOUR;
          if (done || (future && fresh)) continue;
        }
        await step(`month ${key}`, async () => {
          const raw = await client.scoreboard(key, { limit: 300 });
          const n = await ingestScoreboard(db, raw, t);
          await saveSnapshot(db, "schedule-month", key, { complete, games: n }, t);
          months++;
          monthGames += n;
        });
      }
    }
    counts.scheduleMonths = months;
    counts.scheduleGames = monthGames;

    const pending = await db
      .select({ id: nbaGames.id })
      .from(nbaGames)
      .where(and(eq(nbaGames.status, "final"), eq(nbaGames.statsFinal, false), inArray(nbaGames.season, seasons)))
      .orderBy(desc(nbaGames.startTime))
      .limit(800);
    let summaries = 0;
    let statRows = 0;
    let skipped = 0;
    let missingBoxscores = 0;
    await mapPool(
      pending,
      conc,
      async ({ id }) => {
        if (overBudget()) {
          skipped++;
          return;
        }
        const res = await pullSummary(db, client, id, t);
        if (res.missing) missingBoxscores++;
        else summaries++;
        statRows += res.statRows;
      },
      ({ id }, err) => errors.push(`summary ${id}: ${err instanceof Error ? err.message : String(err)}`),
    );
    counts.backfillSummaries = summaries;
    counts.backfillStatRows = statRows;
    counts.backfillMissing = missingBoxscores;
    counts.backfillRemaining = skipped;

    // 7. housekeeping
    await step("prune", async () => {
      await db.delete(syncRuns).where(lt(syncRuns.startedAt, new Date(t.getTime() - 14 * 24 * HOUR)));
      await db
        .delete(rawSnapshots)
        .where(
          and(
            inArray(rawSnapshots.kind, ["summary", "scoreboard"]),
            lt(rawSnapshots.fetchedAt, new Date(t.getTime() - 30 * 24 * HOUR)),
          ),
        );
      await db.delete(nbaNews).where(lt(nbaNews.published, new Date(t.getTime() - 90 * 24 * HOUR)));
    });

    return { counts, errors };
  });
}

// ---------------------------------------------------------------------------------------------
// syncLive / syncCorrections / ensureFreshLive

export async function syncLive(db: Db, client: EspnClient, opts: SyncOptions = {}): Promise<SyncResult> {
  const now = opts.now ?? (() => new Date());
  const t = now();
  const win = await liveWindow(db, t);
  if (!win.active) return { job: "live", ok: true, skipped: "no live games in window", counts: {} };

  return recordRun(db, "live", now, async () => {
    const errors: string[] = [];
    const counts: Record<string, unknown> = {};

    // Scoreboards for every ET date that has an active game (a 10pm tip is still "yesterday"
    // after midnight), plus today. Throttled to once per 5 minutes unless a tip-off is overdue.
    const dates = new Set<string>([etDateString(t)]);
    for (const g of win.games) dates.add(etDateString(g.startTime));
    let boards = 0;
    for (const date of dates) {
      const snap = await getSnapshot(db, "scoreboard", toEspnDate(date));
      if (!win.overdue && snap && t.getTime() - snap.fetchedAt.getTime() < SCOREBOARD_THROTTLE_MS) continue;
      try {
        await pullScoreboardDay(db, client, date, t);
        boards++;
      } catch (err) {
        errors.push(`scoreboard ${date}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    counts.scoreboards = boards;

    const candidates = await db
      .select({ id: nbaGames.id })
      .from(nbaGames)
      .where(
        or(
          eq(nbaGames.status, "in"),
          and(
            eq(nbaGames.status, "final"),
            eq(nbaGames.statsFinal, false),
            gte(nbaGames.finishedAt, new Date(t.getTime() - 3 * HOUR)),
          ),
        ),
      );
    let summaries = 0;
    let statRows = 0;
    await mapPool(
      candidates,
      opts.concurrency ?? DEFAULT_CONCURRENCY,
      async ({ id }) => {
        const res = await ingestSummary(db, id, await client.summary(id), now());
        summaries++;
        statRows += res.statRows;
      },
      ({ id }, err) => errors.push(`summary ${id}: ${err instanceof Error ? err.message : String(err)}`),
    );
    counts.summaries = summaries;
    counts.statRows = statRows;
    return { counts, errors };
  });
}

/** Re-pulls box scores of yesterday's (ET) final games to pick up stat corrections. */
export async function syncCorrections(db: Db, client: EspnClient, opts: SyncOptions = {}): Promise<SyncResult> {
  const now = opts.now ?? (() => new Date());
  return recordRun(db, "corrections", now, async () => {
    const errors: string[] = [];
    const t = now();
    const { start, end } = etDayRange(addDays(etDateString(t), -1));
    const games = await db
      .select({ id: nbaGames.id })
      .from(nbaGames)
      .where(and(eq(nbaGames.status, "final"), gte(nbaGames.startTime, start), lt(nbaGames.startTime, end)));
    let statRows = 0;
    await mapPool(
      games,
      opts.concurrency ?? DEFAULT_CONCURRENCY,
      async ({ id }) => {
        const res = await pullSummary(db, client, id, t, 0);
        statRows += res.statRows;
      },
      ({ id }, err) => errors.push(`summary ${id}: ${err instanceof Error ? err.message : String(err)}`),
    );
    return { counts: { games: games.length, statRows }, errors };
  });
}

export const LIVE_LOCK_KEY = 7_204_001;

/**
 * Runs `fn` only if the advisory lock is free. Uses a transaction-scoped lock
 * (pg_try_advisory_xact_lock): session-level locks are unreliable behind pooled/serverless
 * connections because unlock may land on a different session; the xact variant is released
 * automatically on commit/rollback.
 */
export async function withAdvisoryLock<T>(
  db: Db,
  key: number,
  fn: (tx: Db) => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  return db.transaction(async (tx) => {
    const res = (await tx.execute(sql`select pg_try_advisory_xact_lock(${key}::bigint) as locked`)) as unknown as {
      rows?: { locked?: boolean }[];
    };
    if (!res.rows?.[0]?.locked) return { acquired: false } as const;
    return { acquired: true, value: await fn(tx as unknown as Db) } as const;
  });
}

export type EnsureFreshResult = { ran: boolean; reason: "fresh" | "idle" | "locked" | "error" | "synced"; result?: SyncResult };

/**
 * Lazy refresh for pages: if a game is live/imminent and the last live sync is stale, run
 * syncLive under an advisory lock. Never throws.
 */
export async function ensureFreshLive(
  db: Db,
  opts: { maxAgeSec?: number; client?: EspnClient; now?: () => Date } = {},
): Promise<EnsureFreshResult> {
  const now = opts.now ?? (() => new Date());
  const maxAgeMs = (opts.maxAgeSec ?? 60) * 1000;
  try {
    const t = now();
    const [last] = await db
      .select({ ok: syncRuns.ok, finishedAt: syncRuns.finishedAt })
      .from(syncRuns)
      .where(and(eq(syncRuns.job, "live"), sql`${syncRuns.finishedAt} is not null`))
      .orderBy(desc(syncRuns.finishedAt))
      .limit(1);
    if (last?.finishedAt) {
      const age = t.getTime() - last.finishedAt.getTime();
      // A failed attempt is retried at most every 30s so a broken upstream cannot slow every page.
      if (age < (last.ok ? maxAgeMs : Math.max(maxAgeMs, 30_000))) return { ran: false, reason: "fresh" };
    }
    if (!(await liveWindow(db, t)).active) return { ran: false, reason: "idle" };

    // Short timeout/retries: this runs inside a page render.
    const client = opts.client ?? createEspnClient({ retries: 1, timeoutMs: 5_000 });
    const locked = await withAdvisoryLock(db, LIVE_LOCK_KEY, (tx) => syncLive(tx, client, { now }));
    if (!locked.acquired) return { ran: false, reason: "locked" };
    return { ran: true, reason: "synced", result: locked.value };
  } catch (err) {
    console.error("[ensureFreshLive] failed", err);
    return { ran: false, reason: "error" };
  }
}
