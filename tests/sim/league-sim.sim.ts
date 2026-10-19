/**
 * Full 16-team league simulation: setup, draft, a whole 2026-27 season with trades, playoffs, rollover and the
 * next season's draft with keepers. Runs on in-memory PGlite and checks every day against an independent
 * scoring oracle. Slow (minutes), so it is NOT part of `npm test`: run it with `npm run sim`.
 *
 *   npm run sim                     default seed
 *   SIM_SEED=7 npm run sim          another league (PowerShell: $env:SIM_SEED=7; npm run sim)
 */
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { draftPicks, users } from "@/db/schema";
import { runLeagueSimulation, type CheckpointName } from "@/lib/sim/league-sim";
import { smokePages } from "@/lib/sim/page-smoke";
import { createTestDb } from "../helpers/db";

const ALL: CheckpointName[] = ["setup", "draft-snake", "draft-waves", "preseason", "regular-season", "playoffs", "complete", "next-season", "next-season-draft"];

describe("league simulation", () => {
  it("plays a 16-team league from the draft through the playoffs and into the next season", async () => {
    const { db, close } = await createTestDb();
    try {
      const seen: CheckpointName[] = [];
      let smokeCalls = 0;
      const result = await runLeagueSimulation(db, {
        seed: process.env.SIM_SEED ? Number(process.env.SIM_SEED) : undefined,
        log: process.env.SIM_VERBOSE ? (m) => console.log(m) : undefined,
        onCheckpoint: async (name, ctx) => {
          seen.push(name);
          const smoke = await smokePages(db, ctx, name);
          smokeCalls += smoke.calls;
          expect(smoke.slow, `slow loaders at ${name}`).toEqual([]);
          expect(ctx.users.filter((u) => u.role === "commissioner")).toHaveLength(1);
          expect(ctx.users.length).toBeGreaterThanOrEqual(17);
        },
      });
      expect(result.completed).toBe(true);
      expect(seen).toEqual(ALL);
      expect(result.champion).toBeTruthy();
      expect(result.standings).toHaveLength(16);
      expect(result.counters.gamesPlayed).toBeGreaterThanOrEqual(1230);
      expect(result.counters.picks).toBeGreaterThanOrEqual(512);
      expect(result.counters.oracleMatchups).toBeGreaterThanOrEqual(168 + 7);
      expect(result.counters.forcedTies).toBe(2);
      expect(result.counters.lateMoves).toBeGreaterThan(5);
      expect(result.counters.tradesExecuted).toBeGreaterThanOrEqual(6);
      expect(smokeCalls).toBeGreaterThan(800);
      console.log(
        [
          `champion: ${result.champion} (runner-up ${result.runnerUp})`,
          ...result.bracket,
          `assertions: ${result.counters.assertions}, ${Math.round(result.elapsedMs / 1000)}s`,
          ...result.findings,
        ].join("\n"),
      );
    } finally {
      await close();
    }
  });

  it("is deterministic for a seed (same draft, same order of owners)", async () => {
    const picksOf = async () => {
      const { db, close } = await createTestDb();
      try {
        await runLeagueSimulation(db, { seed: 5, until: "preseason" });
        const rows = await db
          .select({ overall: draftPicks.overallPick, player: draftPicks.playerId, owner: users.username })
          .from(draftPicks)
          .innerJoin(users, eq(users.id, draftPicks.madeBy))
          .orderBy(asc(draftPicks.overallPick));
        return rows.map((r) => `${r.overall}:${r.player}:${r.owner}`);
      } finally {
        await close();
      }
    };
    const [a, b] = [await picksOf(), await picksOf()];
    expect(a).toHaveLength(512);
    expect(b).toEqual(a);
  });
});
