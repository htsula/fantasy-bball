/* eslint-disable @typescript-eslint/no-explicit-any */
import { and, count, desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nbaGames, nbaInjuries, nbaNews, nbaPlayers, nbaTeams, playerGameStats, rawSnapshots, syncRuns } from "@/db/schema";
import type { Db } from "@/db/types";
import { EspnHttpError, type EspnClient } from "@/lib/nba/espn";
import { createFixtureClient, FIXTURE_GAME_ID, readFixture } from "@/lib/nba/fixture-client";
import {
  ensureFreshLive,
  liveWindow,
  syncCorrections,
  syncDaily,
  syncLive,
  withAdvisoryLock,
} from "@/lib/nba/sync";
import { createTestDb } from "./helpers/db";

let db: Db;
let close: () => Promise<void> | void;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
  vi.restoreAllMocks();
});

const total = async (table: any) => (await db.select({ n: count() }).from(table))[0].n;

/** A fixture client whose summary() rewrites the header id so every game gets a box score. */
function clientWithSummaries(overrides: Partial<EspnClient> = {}) {
  return createFixtureClient({
    async summary(id) {
      const raw = readFixture<any>("summary-401810791.json");
      raw.header.id = String(id);
      return raw;
    },
    ...overrides,
  });
}

const DAILY_NOW = new Date("2026-03-11T15:00:00Z"); // 11am ET, day after the fixture games

describe("syncDaily", () => {
  it("loads teams, rosters, injuries, news, games and box scores, and records the run", async () => {
    const res = await syncDaily(db, clientWithSummaries(), { now: () => DAILY_NOW });
    expect(res).toMatchObject({ job: "daily", ok: true });
    expect(await total(nbaTeams)).toBe(30);
    expect(await total(nbaGames)).toBe(11);
    expect(await total(nbaNews)).toBeGreaterThan(5);
    expect(await total(nbaInjuries)).toBeGreaterThan(5);
    expect(res.counts).toMatchObject({ teams: 30, rosters: { ok: 30, failed: 0 }, backfillSummaries: 11 });

    const [atlRosterPlayer] = await db.select().from(nbaPlayers).where(eq(nbaPlayers.id, 4278039));
    expect(atlRosterPlayer).toMatchObject({ fullName: "Nickeil Alexander-Walker", teamId: 1, positions: ["PG", "SG"] });

    // The injury feed updates the cached columns on players.
    const [gilbert] = await db.select().from(nbaPlayers).where(eq(nbaPlayers.id, 4585618));
    expect(gilbert).toMatchObject({ injuryStatus: "Day-To-Day", injuryDetail: "Knee - Tendinitis" });

    const [game] = await db.select().from(nbaGames).where(eq(nbaGames.id, FIXTURE_GAME_ID));
    expect(game).toMatchObject({ status: "final", homeScore: 139, awayScore: 129, statsFinal: true });
    expect(
      await db.select({ n: count() }).from(playerGameStats).where(eq(playerGameStats.gameId, FIXTURE_GAME_ID)),
    ).toEqual([{ n: 26 }]);

    const [run] = await db.select().from(syncRuns).where(eq(syncRuns.job, "daily"));
    expect(run.ok).toBe(true);
    expect(run.finishedAt).toBeTruthy();
    expect(run.counts).toMatchObject({ teams: 30 });
  });

  it("is idempotent", async () => {
    await syncDaily(db, clientWithSummaries(), { now: () => DAILY_NOW });
    const before = [
      await total(nbaTeams), await total(nbaPlayers), await total(nbaGames),
      await total(playerGameStats), await total(nbaInjuries), await total(nbaNews),
    ];
    const second = await syncDaily(db, clientWithSummaries(), { now: () => new Date(DAILY_NOW.getTime() + 3600_000) });
    expect(second.ok).toBe(true);
    const after = [
      await total(nbaTeams), await total(nbaPlayers), await total(nbaGames),
      await total(playerGameStats), await total(nbaInjuries), await total(nbaNews),
    ];
    expect(after).toEqual(before);
    // Past months are marked complete: only the current month is re-fetched on the second run.
    expect(second.counts.scheduleMonths).toBe(1);
    expect(second.counts.backfillSummaries).toBe(0);
  });

  it("keeps raw_snapshots to the latest payload per kind+key", async () => {
    await syncDaily(db, clientWithSummaries(), { now: () => DAILY_NOW });
    const n1 = await total(rawSnapshots);
    await syncDaily(db, clientWithSummaries(), { now: () => new Date(DAILY_NOW.getTime() + 60_000) });
    expect(await total(rawSnapshots)).toBe(n1);
  });

  it("clears injuries that disappear from the feed", async () => {
    await syncDaily(db, clientWithSummaries(), { now: () => DAILY_NOW });
    const res = await syncDaily(db, clientWithSummaries({ injuries: async () => ({ injuries: [] }) }), {
      now: () => DAILY_NOW,
    });
    expect(res.ok).toBe(true);
    expect(await total(nbaInjuries)).toBe(0);
    const [gilbert] = await db.select().from(nbaPlayers).where(eq(nbaPlayers.id, 4585618));
    expect(gilbert.injuryStatus).toBeNull();
    expect(gilbert.injuryDetail).toBeNull();
  });

  it("deactivates players missing from all rosters, but only when every roster loaded", async () => {
    await syncDaily(db, clientWithSummaries(), { now: () => DAILY_NOW });
    // Player 4595400 only exists via a box score placeholder (not on the ATL roster fixture).
    const second = await syncDaily(db, clientWithSummaries(), { now: () => DAILY_NOW });
    expect(second.ok).toBe(true);
    expect((await db.select().from(nbaPlayers).where(eq(nbaPlayers.id, 4595400)))[0]).toMatchObject({
      active: false,
      teamId: null,
    });

    // A failing roster fetch must not trigger deactivation (and is reported).
    await db.update(nbaPlayers).set({ active: true, teamId: 29 }).where(eq(nbaPlayers.id, 4595400));
    let n = 0;
    const flaky = clientWithSummaries({
      async roster() {
        if (++n === 3) throw new Error("boom");
        return readFixture("roster-1.json");
      },
    });
    const third = await syncDaily(db, flaky, { now: () => DAILY_NOW });
    expect(third.ok).toBe(false);
    expect(third.error).toContain("roster");
    expect(third.counts.rosters).toEqual({ ok: 29, failed: 1 });
    expect((await db.select().from(nbaPlayers).where(eq(nbaPlayers.id, 4595400)))[0].active).toBe(true);
  });

  it("reports sub-step failures but still completes the other steps", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await syncDaily(db, clientWithSummaries({ news: async () => { throw new Error("news down"); } }), {
      now: () => DAILY_NOW,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("news: news down");
    expect(await total(nbaGames)).toBe(11);
    const [run] = await db.select().from(syncRuns).where(eq(syncRuns.job, "daily"));
    expect(run).toMatchObject({ ok: false });
    expect(err).toHaveBeenCalled();
  });

  it("treats a 404 box score for an old final game as settled instead of failing the run", async () => {
    const later = new Date("2026-03-14T15:00:00Z");
    const client = clientWithSummaries({
      async summary(id) {
        if (id === 401810792) throw new EspnHttpError("ESPN 404", 404);
        const raw = readFixture<any>("summary-401810791.json");
        raw.header.id = String(id);
        return raw;
      },
    });
    const res = await syncDaily(db, client, { now: () => later });
    expect(res.ok).toBe(true);
    expect(res.counts).toMatchObject({ backfillSummaries: 10, backfillMissing: 1 });
    const [g] = await db.select().from(nbaGames).where(eq(nbaGames.id, 401810792));
    expect(g.statsFinal).toBe(true);
    // A 404 on a game that ended hours ago is still an error (box score may simply not be up yet).
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await db.update(nbaGames).set({ statsFinal: false }).where(eq(nbaGames.id, 401810792));
    const soon = await syncDaily(db, client, { now: () => DAILY_NOW });
    expect(soon.ok).toBe(false);
    expect(soon.error).toContain("401810792");
    expect(err).toHaveBeenCalled();
  });

  it("resumes the backfill across runs when the time budget runs out", async () => {
    const first = await syncDaily(db, clientWithSummaries(), { now: () => DAILY_NOW, budgetMs: -1 });
    expect(first.counts.scheduleMonths).toBe(0); // out of budget before any month
    expect(first.counts.backfillSummaries).toBe(0);
    // The scoreboard window still ran, so the games exist and await box scores.
    const pending = await db.select({ n: count() }).from(nbaGames).where(and(eq(nbaGames.statsFinal, false)));
    expect(pending[0].n).toBe(11);
    const second = await syncDaily(db, clientWithSummaries(), { now: () => DAILY_NOW });
    expect(second.counts.backfillSummaries).toBe(11);
  });
});

// -------------------------------------------------------------------------------------------

const TIP = new Date("2026-03-12T00:00:00Z"); // 8pm ET

function scoreboardFor(id: number, state: "pre" | "in" | "post", start = TIP) {
  const raw = readFixture<any>("scoreboard-20260310.json");
  const ev = raw.events[0];
  ev.id = String(id);
  ev.date = start.toISOString();
  ev.competitions[0].date = start.toISOString();
  const type = {
    pre: { name: "STATUS_SCHEDULED", state: "pre", completed: false, shortDetail: "8:00 PM" },
    in: { name: "STATUS_IN_PROGRESS", state: "in", completed: false, shortDetail: "4:12 - 2nd" },
    post: { name: "STATUS_FINAL", state: "post", completed: true, shortDetail: "Final" },
  }[state];
  ev.competitions[0].status = { clock: 252, displayClock: "4:12", period: state === "post" ? 4 : 2, type };
  return { events: [ev] };
}

function summaryFor(id: number, state: "in" | "post") {
  const raw = readFixture<any>("summary-401810791.json");
  raw.header.id = String(id);
  raw.header.competitions[0].status = {
    type: state === "post"
      ? { name: "STATUS_FINAL", state: "post", completed: true }
      : { name: "STATUS_IN_PROGRESS", state: "in", completed: false },
  };
  return raw;
}

function spyClient(board: () => unknown, summary: () => unknown) {
  const calls = { scoreboard: 0, summary: 0 };
  const client = createFixtureClient({
    async scoreboard() {
      calls.scoreboard++;
      return board() as any;
    },
    async summary() {
      calls.summary++;
      return summary() as any;
    },
  });
  return { client, calls };
}

async function insertScheduledGame(id: number, start: Date) {
  const { ingestScoreboard } = await import("@/lib/nba/sync");
  await ingestScoreboard(db, scoreboardFor(id, "pre", start), new Date(start.getTime() - 86400_000));
}

describe("syncLive window logic", () => {
  const noNetwork = () =>
    createFixtureClient({
      scoreboard: async () => { throw new Error("network must not be touched"); },
      summary: async () => { throw new Error("network must not be touched"); },
    });

  it("is a fast no-op on an empty database", async () => {
    const res = await syncLive(db, noNetwork(), { now: () => TIP });
    expect(res).toMatchObject({ ok: true, skipped: "no live games in window", counts: {} });
    expect(await total(syncRuns)).toBe(0);
  });

  it("is a no-op when the next tip-off is more than 90 minutes away", async () => {
    await insertScheduledGame(900001, TIP);
    const res = await syncLive(db, noNetwork(), { now: () => new Date(TIP.getTime() - 91 * 60_000) });
    expect(res.skipped).toBeTruthy();
    expect((await liveWindow(db, new Date(TIP.getTime() - 89 * 60_000))).active).toBe(true);
  });

  it("is a no-op for a long-finished game with settled stats", async () => {
    await syncDaily(db, clientWithSummaries(), { now: () => DAILY_NOW });
    expect((await liveWindow(db, DAILY_NOW)).active).toBe(false);
    const res = await syncLive(db, noNetwork(), { now: () => DAILY_NOW });
    expect(res.skipped).toBeTruthy();
  });

  it("runs from 90 minutes before tip-off through the game and settles after the final", async () => {
    await insertScheduledGame(900001, TIP);
    let state: "pre" | "in" | "post" = "pre";
    const { client, calls } = spyClient(
      () => scoreboardFor(900001, state),
      () => summaryFor(900001, state === "post" ? "post" : "in"),
    );

    // 30 minutes before tip: in window, scoreboard refreshed, nothing live to pull yet.
    let t = new Date(TIP.getTime() - 30 * 60_000);
    let res = await syncLive(db, client, { now: () => t });
    expect(res).toMatchObject({ ok: true, counts: { scoreboards: 1, summaries: 0 } });
    expect((await db.select().from(nbaGames).where(eq(nbaGames.id, 900001)))[0].status).toBe("scheduled");

    // Tip-off passed with a stale "scheduled" status: scoreboard is force-refreshed despite the 5 min throttle.
    state = "in";
    t = new Date(TIP.getTime() + 2 * 60_000);
    res = await syncLive(db, client, { now: () => t });
    expect(res.counts).toMatchObject({ scoreboards: 1, summaries: 1 });
    let [game] = await db.select().from(nbaGames).where(eq(nbaGames.id, 900001));
    expect(game).toMatchObject({ status: "in", period: 2, clock: "4:12", homeScore: 139 });
    const statCount = await total(playerGameStats);
    expect(statCount).toBe(26);

    // One minute later: scoreboard throttled (5 min), summary still pulled; upsert idempotent.
    const before = calls.scoreboard;
    t = new Date(t.getTime() + 60_000);
    res = await syncLive(db, client, { now: () => t });
    expect(res.counts).toMatchObject({ scoreboards: 0, summaries: 1 });
    expect(calls.scoreboard).toBe(before);
    expect(await total(playerGameStats)).toBe(statCount);

    // Final: stays "unsettled" until 10 minutes after we first saw the final, then is marked stats-final.
    state = "post";
    t = new Date(t.getTime() + 6 * 60_000);
    await syncLive(db, client, { now: () => t });
    [game] = await db.select().from(nbaGames).where(eq(nbaGames.id, 900001));
    expect(game).toMatchObject({ status: "final", statsFinal: false });
    expect(game.finishedAt).toBeTruthy();
    t = new Date(t.getTime() + 11 * 60_000);
    await syncLive(db, client, { now: () => t });
    [game] = await db.select().from(nbaGames).where(eq(nbaGames.id, 900001));
    expect(game.statsFinal).toBe(true);

    // And then it goes quiet again.
    const noop = await syncLive(db, client, { now: () => new Date(t.getTime() + 60_000) });
    expect(noop.skipped).toBeTruthy();
    expect(await total(playerGameStats)).toBe(statCount);
  });

  it("uses the ET date for the scoreboard it requests", async () => {
    // 01:30 ET on Mar 12 = 05:30Z; the 10pm-ET tip on Mar 11 is still live and belongs to Mar 11.
    const start = new Date("2026-03-12T03:00:00Z");
    await insertScheduledGame(900002, start);
    const dates: string[] = [];
    const client = createFixtureClient({
      async scoreboard(d) {
        dates.push(d);
        return scoreboardFor(900002, "in", start) as any;
      },
      summary: async () => summaryFor(900002, "in") as any,
    });
    await syncLive(db, client, { now: () => new Date("2026-03-12T05:30:00Z") });
    expect(dates.sort()).toEqual(["20260311", "20260312"]);
  });

  it("records failures without throwing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await insertScheduledGame(900001, TIP);
    const client = createFixtureClient({ scoreboard: async () => { throw new Error("espn down"); } });
    const res = await syncLive(db, client, { now: () => new Date(TIP.getTime() + 60_000) });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("espn down");
    const [run] = await db.select().from(syncRuns).orderBy(desc(syncRuns.id));
    expect(run).toMatchObject({ job: "live", ok: false });
  });
});

describe("syncCorrections", () => {
  it("re-pulls yesterday's finals and picks up corrected stats", async () => {
    await syncDaily(db, clientWithSummaries(), { now: () => DAILY_NOW });
    const [before] = await db
      .select()
      .from(playerGameStats)
      .where(and(eq(playerGameStats.gameId, FIXTURE_GAME_ID), eq(playerGameStats.playerId, 4595400)));
    expect(before.pts).toBe(11);

    let pulls = 0;
    const corrected = createFixtureClient({
      async summary(id) {
        pulls++;
        const raw = readFixture<any>("summary-401810791.json");
        raw.header.id = String(id);
        const a = raw.boxscore.players[0].statistics[0].athletes.find((x: any) => x.athlete.id === "4595400");
        a.stats[1] = "14"; // PTS 11 -> 14
        return raw;
      },
    });
    const res = await syncCorrections(db, corrected, { now: () => DAILY_NOW });
    expect(res).toMatchObject({ job: "corrections", ok: true, counts: { games: 11 } });
    expect(pulls).toBe(11);
    const [after] = await db
      .select()
      .from(playerGameStats)
      .where(and(eq(playerGameStats.gameId, FIXTURE_GAME_ID), eq(playerGameStats.playerId, 4595400)));
    expect(after.pts).toBe(14);
    expect(await total(playerGameStats)).toBe(26 * 11); // row count unchanged
  });

  it("does nothing for days without games", async () => {
    const res = await syncCorrections(db, createFixtureClient(), { now: () => DAILY_NOW });
    expect(res.counts).toMatchObject({ games: 0 });
  });
});

describe("ensureFreshLive", () => {
  it("does nothing when idle, without touching ESPN", async () => {
    const client = createFixtureClient({ scoreboard: async () => { throw new Error("no network"); } });
    expect(await ensureFreshLive(db, { client, now: () => TIP })).toMatchObject({ ran: false, reason: "idle" });
  });

  it("syncs when a game is live and the last sync is stale, then stays fresh for maxAge", async () => {
    await insertScheduledGame(900001, TIP);
    const { client, calls } = spyClient(() => scoreboardFor(900001, "in"), () => summaryFor(900001, "in"));
    let t = new Date(TIP.getTime() + 5 * 60_000);
    const first = await ensureFreshLive(db, { client, now: () => t });
    expect(first).toMatchObject({ ran: true, reason: "synced" });
    expect(first.result?.ok).toBe(true);
    expect(calls.summary).toBe(1);

    t = new Date(t.getTime() + 30_000);
    expect(await ensureFreshLive(db, { client, now: () => t })).toMatchObject({ ran: false, reason: "fresh" });
    expect(calls.summary).toBe(1);

    t = new Date(t.getTime() + 40_000); // 70s since last run > 60s
    expect(await ensureFreshLive(db, { client, now: () => t })).toMatchObject({ ran: true });
    expect(calls.summary).toBe(2);
  });

  it("never throws, even when ESPN fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await insertScheduledGame(900001, TIP);
    const client = createFixtureClient({ scoreboard: async () => { throw new Error("espn down"); } });
    const t = new Date(TIP.getTime() + 60_000);
    const res = await ensureFreshLive(db, { client, now: () => t });
    expect(res.ran).toBe(true);
    expect(res.result?.ok).toBe(false);
    // A failed attempt is not hammered: still "fresh" 20s later.
    expect(await ensureFreshLive(db, { client, now: () => new Date(t.getTime() + 20_000) })).toMatchObject({
      ran: false,
      reason: "fresh",
    });
  });

  it("returns an error result instead of throwing when the database fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const brokenDb = new Proxy({} as Db, {
      get() {
        throw new Error("db down");
      },
    });
    await expect(ensureFreshLive(brokenDb)).resolves.toEqual({ ran: false, reason: "error" });
  });
});

describe("withAdvisoryLock", () => {
  it("runs the callback when the lock is acquired (real Postgres call)", async () => {
    const res = await withAdvisoryLock(db, 123, async () => "done");
    expect(res).toEqual({ acquired: true, value: "done" });
  });

  it("skips the callback when someone else holds the lock", async () => {
    const fn = vi.fn();
    const fakeDb = {
      transaction: async (cb: (tx: unknown) => unknown) => cb({ execute: async () => ({ rows: [{ locked: false }] }) }),
    } as unknown as Db;
    expect(await withAdvisoryLock(fakeDb, 1, fn)).toEqual({ acquired: false });
    expect(fn).not.toHaveBeenCalled();
  });

  it("ensureFreshLive reports 'locked' and does not sync when the lock is taken", async () => {
    await insertScheduledGame(900001, TIP);
    const sync = vi.fn();
    const client = createFixtureClient({ scoreboard: sync, summary: sync });
    const real = db;
    const lockedDb = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === "transaction") {
          return async (cb: (tx: unknown) => unknown) => cb({ execute: async () => ({ rows: [{ locked: false }] }) });
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const res = await ensureFreshLive(lockedDb, { client, now: () => new Date(TIP.getTime() + 60_000) });
    expect(res).toEqual({ ran: false, reason: "locked" });
    expect(sync).not.toHaveBeenCalled();
  });
});
