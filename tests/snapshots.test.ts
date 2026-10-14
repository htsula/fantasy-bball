/* eslint-disable @typescript-eslint/no-explicit-any */
import { and, count, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gameRosterSnapshots, nbaGames, nbaPlayers, rosterEntries, transactions } from "@/db/schema";
import type { Db } from "@/db/types";
import type { EspnClient } from "@/lib/nba/espn";
import { createFixtureClient, readFixture } from "@/lib/nba/fixture-client";
import { captureTipoffSnapshots, injuryRefreshDue, lastInjuryRefresh, markInjuryRefresh } from "@/lib/nba/snapshots";
import { ingestScoreboard, syncDaily, syncLive } from "@/lib/nba/sync";
import { createTestDb } from "./helpers/db";
import { seedPlayers } from "./helpers/draft";
import { rosterPlayer, seasonLeague } from "./helpers/rosters";

let db: Db;
let close: () => Promise<void> | void;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await seedPlayers(db, 60); // teams 20 and 29 (the fixture game) have players {20, 50} and {29, 59}
});
afterEach(async () => {
  await close();
});

const TIP = new Date("2026-03-12T00:00:00Z"); // 8pm ET
const GAME = 900001;
const min = (n: number) => new Date(TIP.getTime() + n * 60_000);

function scoreboardFor(id: number, state: "pre" | "in" | "post") {
  const raw = readFixture<any>("scoreboard-20260310.json");
  const ev = raw.events[0];
  ev.id = String(id);
  ev.date = TIP.toISOString();
  ev.competitions[0].date = TIP.toISOString();
  const type = {
    pre: { name: "STATUS_SCHEDULED", state: "pre", completed: false, shortDetail: "8:00 PM" },
    in: { name: "STATUS_IN_PROGRESS", state: "in", completed: false, shortDetail: "4:12 - 2nd" },
    post: { name: "STATUS_FINAL", state: "post", completed: true, shortDetail: "Final" },
  }[state];
  ev.competitions[0].status = { clock: 252, displayClock: "4:12", period: state === "post" ? 4 : 2, type };
  return { events: [ev] };
}

function clientFor(state: () => "pre" | "in" | "post", extra: Partial<EspnClient> = {}) {
  const calls = { injuries: 0, scoreboard: 0 };
  const client = createFixtureClient({
    async scoreboard() {
      calls.scoreboard++;
      return scoreboardFor(GAME, state()) as any;
    },
    async summary() {
      const raw = readFixture<any>("summary-401810791.json");
      raw.header.id = String(GAME);
      raw.header.competitions[0].status = {
        type: state() === "post"
          ? { name: "STATUS_FINAL", state: "post", completed: true }
          : { name: "STATUS_IN_PROGRESS", state: "in", completed: false },
      };
      return raw;
    },
    async injuries() {
      calls.injuries++;
      return readFixture("injuries.json");
    },
    ...extra,
  });
  return { client, calls };
}

const snaps = () => db.select().from(gameRosterSnapshots).where(eq(gameRosterSnapshots.gameId, GAME));
const total = async () => (await db.select({ n: count() }).from(gameRosterSnapshots))[0].n;

async function scheduleGame() {
  await ingestScoreboard(db, scoreboardFor(GAME, "pre"), new Date(TIP.getTime() - 86_400_000));
}

describe("tip-off snapshots", () => {
  it("snapshots both teams' active players with normalized injury statuses when a game is first seen in progress", async () => {
    await scheduleGame();
    await db.update(nbaPlayers).set({ injuryStatus: "OUT" }).where(eq(nbaPlayers.id, 20));
    await db.update(nbaPlayers).set({ injuryStatus: "day-to-day" }).where(eq(nbaPlayers.id, 29));
    await db.update(nbaPlayers).set({ active: false }).where(eq(nbaPlayers.id, 50));
    await markInjuryRefresh(db, min(-5)); // fresh feed: keep the statuses set above
    const { client } = clientFor(() => "in");

    expect(await total()).toBe(0); // scheduled games have none
    const res = await syncLive(db, client, { now: () => min(2) });
    expect(res.ok).toBe(true);

    const rows = await snaps();
    const by = new Map(rows.map((r) => [r.playerId, r]));
    expect([...by.keys()].sort((a, b) => a - b)).toEqual([20, 29, 59]); // 50 is inactive; other teams excluded
    expect(by.get(20)).toMatchObject({ nbaTeamId: 20, injuryStatus: "Out", late: false });
    expect(by.get(29)).toMatchObject({ nbaTeamId: 29, injuryStatus: "Day-To-Day", late: false });
    expect(by.get(59)).toMatchObject({ nbaTeamId: 29, injuryStatus: null });
    expect(res.counts.snapshots).toBeDefined();
  });

  it("is idempotent and never overwrites an existing snapshot", async () => {
    await scheduleGame();
    const { client } = clientFor(() => "in");
    await syncLive(db, client, { now: () => min(2) });
    const before = await snaps();
    expect(before).toHaveLength(4);

    // Later changes to rosters/injuries must not alter the recorded tip-off state.
    await db.update(nbaPlayers).set({ injuryStatus: "Out" }).where(eq(nbaPlayers.id, 20));
    await db.update(nbaPlayers).set({ teamId: 5 }).where(eq(nbaPlayers.id, 29));
    await db.update(nbaPlayers).set({ teamId: 20, active: true }).where(eq(nbaPlayers.id, 1));
    await syncLive(db, client, { now: () => min(8) });
    expect(await captureTipoffSnapshots(db, min(9))).toEqual({ games: 0, rows: 0 });

    const after = await snaps();
    expect(after).toHaveLength(4);
    expect(after.map((r) => [r.playerId, r.nbaTeamId, r.injuryStatus, r.late])).toEqual(
      before.map((r) => [r.playerId, r.nbaTeamId, r.injuryStatus, r.late]),
    );
    expect(after.find((r) => r.playerId === 20)!.capturedAt).toEqual(before.find((r) => r.playerId === 20)!.capturedAt);
  });

  it("flags a snapshot late when first observed 10+ minutes after tip-off, not before", async () => {
    await scheduleGame();
    await captureTipoffSnapshots(db, min(9)); // game is still "scheduled" in the table: nothing yet
    expect(await total()).toBe(0);

    await db.update(nbaGames).set({ status: "in" }).where(eq(nbaGames.id, GAME));
    await captureTipoffSnapshots(db, min(9));
    expect((await snaps()).every((r) => r.late === false)).toBe(true);

    await db.delete(gameRosterSnapshots);
    await captureTipoffSnapshots(db, min(10));
    expect((await snaps()).every((r) => r.late === true)).toBe(true);
  });

  it("snapshots a game first seen already final, flagged late", async () => {
    await scheduleGame();
    const { client } = clientFor(() => "post");
    await syncLive(db, client, { now: () => min(150) });
    const rows = await snaps();
    expect(rows.length).toBe(4);
    expect(rows.every((r) => r.late)).toBe(true);
  });

  it("does not snapshot long-finished games (rosters have moved on) or scheduled ones", async () => {
    await ingestScoreboard(db, scoreboardFor(GAME, "post"), min(60 * 10)); // observed 10h after tip-off
    expect(await total()).toBe(0);
    await ingestScoreboard(db, scoreboardFor(GAME, "pre"), min(-60));
    expect(await total()).toBe(0);
  });

  it("is created when the scoreboard ingest flips a game to in-progress", async () => {
    await scheduleGame();
    await ingestScoreboard(db, scoreboardFor(GAME, "in"), min(1));
    expect(await total()).toBe(4);
  });
});

describe("pre-tip-off injury refresh", () => {
  const tipSoon = (n: number) => new Date(TIP.getTime() - n * 60_000);

  it("refreshes injuries when a game tips within 90 minutes, at most every 30 minutes", async () => {
    await scheduleGame();
    const { client, calls } = clientFor(() => "pre");

    // Too early: the live window isn't open and ESPN isn't touched.
    let res = await syncLive(db, client, { now: () => tipSoon(100) });
    expect(res.skipped).toBeTruthy();
    expect(calls.injuries).toBe(0);

    res = await syncLive(db, client, { now: () => tipSoon(85) });
    expect(calls.injuries).toBe(1);
    expect(res.counts.injuriesRefreshed).toBe(true);
    expect(await lastInjuryRefresh(db)).toEqual(tipSoon(85));

    await syncLive(db, client, { now: () => tipSoon(60) }); // 25 min later: throttled
    expect(calls.injuries).toBe(1);
    await syncLive(db, client, { now: () => tipSoon(55) }); // 30 min after the first: due
    expect(calls.injuries).toBe(2);
    await syncLive(db, client, { now: () => tipSoon(30) });
    expect(calls.injuries).toBe(2);
    await syncLive(db, client, { now: () => tipSoon(25) });
    expect(calls.injuries).toBe(3);
  });

  it("applies fresh statuses before the tip-off snapshot is taken", async () => {
    await scheduleGame();
    const injuries = readFixture<any>("injuries.json");
    const first = injuries.injuries.find((t: any) => t.injuries?.length);
    const athleteId = Number(first.injuries[0].athlete?.id ?? /\/id\/(\d+)/.exec(first.injuries[0].athlete.links[0].href)![1]);
    first.injuries[0].status = "Out";
    await db.update(nbaPlayers).set({ teamId: 20 }).where(eq(nbaPlayers.id, 1));
    await db.insert(nbaPlayers).values({ id: athleteId, fullName: "Injured Guy", teamId: 20, active: true }).onConflictDoUpdate({
      target: nbaPlayers.id,
      set: { teamId: 20, active: true },
    });
    let state: "pre" | "in" = "pre";
    const { client } = clientFor(() => state, { injuries: async () => injuries });
    await syncLive(db, client, { now: () => tipSoon(20) });
    state = "in";
    await syncLive(db, client, { now: () => min(1) });
    const row = (await snaps()).find((r) => r.playerId === athleteId);
    expect(row?.injuryStatus).toBe("Out");
  });

  it("does not refresh when no game is about to tip, and the daily sync resets the throttle", async () => {
    const t = tipSoon(60);
    expect(await injuryRefreshDue(db, t, false)).toBe(false);
    expect(await injuryRefreshDue(db, t, true)).toBe(true);
    await markInjuryRefresh(db, t);
    expect(await injuryRefreshDue(db, new Date(t.getTime() + 29 * 60_000), true)).toBe(false);
    expect(await injuryRefreshDue(db, new Date(t.getTime() + 30 * 60_000), true)).toBe(true);

    const daily = new Date("2026-03-11T15:00:00Z");
    await syncDaily(db, createFixtureClient(), { now: () => daily });
    expect(await lastInjuryRefresh(db)).toEqual(daily);
  });
});

describe("syncDaily auto-drop of cut players", () => {
  const daily = new Date("2026-03-11T15:00:00Z");

  async function leagueWithCutPlayer() {
    const fx = await seasonLeague(db, 2);
    await db.insert(nbaPlayers).values({ id: 999_001, fullName: "Cut Guy", teamId: 7, active: true });
    await rosterPlayer(db, fx, 0, 999_001);
    return fx;
  }
  const activeCount = async (fx: Awaited<ReturnType<typeof seasonLeague>>) =>
    (
      await db
        .select({ n: count() })
        .from(rosterEntries)
        .where(and(eq(rosterEntries.leagueId, fx.league.id), eq(rosterEntries.playerId, 999_001)))
    )[0].n;

  it("drops players missing from every ESPN roster when all 30 rosters loaded", async () => {
    const fx = await leagueWithCutPlayer();
    const res = await syncDaily(db, createFixtureClient(), { now: () => daily });
    expect(res.counts.autoDrops).toBe(1);
    const [p] = await db.select().from(nbaPlayers).where(eq(nbaPlayers.id, 999_001));
    expect(p).toMatchObject({ active: false, teamId: null });
    const [entry] = await db.select().from(rosterEntries).where(eq(rosterEntries.playerId, 999_001));
    expect(entry).toMatchObject({ releasedVia: "auto_drop" });
    expect((await db.select().from(transactions).where(eq(transactions.leagueId, fx.league.id)))[0]).toMatchObject({
      type: "auto_drop",
      actorUserId: null,
    });
  });

  it("drops nobody when any roster failed to load", async () => {
    const fx = await leagueWithCutPlayer();
    await db.update(nbaPlayers).set({ active: false, teamId: null }).where(eq(nbaPlayers.id, 999_001));
    let n = 0;
    const client = createFixtureClient({
      async roster(id) {
        if (id === 7) throw new Error("espn hiccup");
        n++;
        return readFixture("roster-1.json");
      },
    });
    const res = await syncDaily(db, client, { now: () => daily });
    expect(n).toBeGreaterThan(20);
    expect(res.counts.autoDrops).toBe(0);
    expect(res.ok).toBe(false);
    expect(await activeCount(fx)).toBe(1);
    expect((await db.select().from(rosterEntries).where(eq(rosterEntries.playerId, 999_001)))[0].releasedAt).toBeNull();
  });
});
