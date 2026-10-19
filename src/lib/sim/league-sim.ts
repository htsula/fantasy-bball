/**
 * A full 16-team league simulation, draft to playoffs and into the next season, driven through the real
 * service functions on whatever database it is given (in-memory PGlite for tests, a PGlite directory for
 * the dev script). Only NBA source data is inserted directly, because in production it comes from the ESPN
 * sync. Deterministic for a given seed. See README ("League simulation").
 */
import { performance } from "node:perf_hooks";
import type { Db } from "@/db/types";
import {
  checkpoint,
  makeNotifier,
  StopSimulation,
  type CheckpointRecord,
  type Counters,
  type Ctx,
  type SimOptions,
} from "./context";
import {
  buildSchedule,
  buildWorld,
  insertPreviousSeason,
  insertScheduledGames,
  insertTeamsAndPlayers,
  seasonGameDays,
} from "./nba-data";
import { runDraft } from "./phase-draft";
import { runSeason } from "./phase-season";
import { runNextSeason } from "./phase-next";
import { setupLeague } from "./phase-setup";
import { at, rawRows } from "./context";
import { sql } from "drizzle-orm";
import { getStandings } from "@/lib/matchups/service";
import { makeRng } from "./rng";

export type { CheckpointName, CheckpointContext, SimOptions, SimUser } from "./context";
import type { SimUser } from "./context";

export type SimResult = {
  seed: number;
  leagueId: string;
  nextLeagueId?: string;
  completed: boolean;
  stoppedAt?: string;
  champion?: string;
  runnerUp?: string;
  standings: { rank: number; team: string; record: string; pointsFor: number }[];
  bracket: string[];
  counters: Counters;
  checkpoints: CheckpointRecord[];
  notifications: Record<string, number>;
  timings: { label: string; calls: number; avgMs: number; maxMs: number }[];
  slow: { label: string; ms: number }[];
  findings: string[];
  /** Accounts as of the end of the run (log in with these; passwords are the sim's own). */
  users: SimUser[];
  elapsedMs: number;
};

export async function runLeagueSimulation(db: Db, opts: SimOptions = {}): Promise<SimResult> {
  const t0 = performance.now();
  const seed = opts.seed ?? 20270411;
  const rand = makeRng(seed);
  const sent: Ctx["sent"] = [];
  const ctx = {
    db,
    rand,
    opts,
    seed,
    world: buildWorld(rand),
    managers: [],
    nonMember: null,
    extraUsers: [],
    leagueId: "",
    leagueName: "",
    counters: {
      assertions: 0, picks: 0, commissionerPicks: 0, adds: 0, drops: 0, commissionerMoves: 0, autoDrops: 0,
      tradesProposed: 0, tradesExecuted: 0, chatMessages: 0, gamesPlayed: 0, oracleMatchups: 0, liveChecks: 0, smokeCalls: 0, lateMoves: 0, forcedTies: 0,
    },
    sent,
    notify: makeNotifier(sent),
    checkpoints: [],
    slow: [],
    timings: new Map(),
    findings: [],
    now: at("2026-10-01", "09:00"),
    log: opts.log ?? (() => undefined),
  } as unknown as Ctx;

  let stoppedAt: string | undefined;
  let outcome: Awaited<ReturnType<typeof runSeason>> | undefined;
  try {
    // NBA source data exists long before the league does (the ESPN sync loads the whole schedule).
    await insertTeamsAndPlayers(db, ctx.world);
    ctx.world.games = buildSchedule(rand, ctx.world.teams, seasonGameDays(), 2027, ctx.world.nextId.game, { gamesTotal: 1230 });
    ctx.world.nextId.game += ctx.world.games.length + 10;
    await insertScheduledGames(db, ctx.world.games);
    await insertPreviousSeason(db, ctx.world, rand);

    await setupLeague(ctx);
    await checkpoint(ctx, "setup", at("2026-10-15", "10:00"), "16 teams, schedule generated, draft not started");
    const draft = await runDraft(ctx);
    await checkpoint(ctx, "preseason", draft.finishedAt, "draft complete, before opening night");
    const season = await runSeason(ctx);
    outcome = season;
    await runNextSeason(ctx, { teamId: season.championTeamId, runnerUpTeamId: season.runnerUpTeamId });
  } catch (err) {
    if (!(err instanceof StopSimulation)) throw err;
    stoppedAt = err.at;
  }

  let standings: SimResult["standings"] = [];
  let notifications: Record<string, number> = {};
  if (ctx.leagueId && outcome) {
    standings = (await getStandings(db, ctx.leagueId)).map((r) => ({ rank: r.rank, team: r.name, record: `${r.wins}-${r.losses}-${r.ties}`, pointsFor: r.pointsFor }));
    const rows = await rawRows(db, sql`select type, count(*)::int as n from notifications group by type order by type`);
    notifications = Object.fromEntries(rows.map((r) => [String(r.type), Number(r.n)]));
  }
  const nameOf = (id: string | undefined) => ctx.managers.find((m) => m.teamId === id)?.teamName;
  const timings = [...ctx.timings.entries()].map(([label, t]) => ({ label, calls: t.n, avgMs: Math.round(t.total / t.n), maxMs: Math.round(t.max) }));
  return {
    seed,
    leagueId: ctx.leagueId,
    nextLeagueId: ctx.nextLeagueId,
    completed: !stoppedAt,
    stoppedAt,
    champion: nameOf(outcome?.championTeamId),
    runnerUp: nameOf(outcome?.runnerUpTeamId),
    standings,
    bracket: outcome?.bracketText ?? [],
    counters: ctx.counters,
    checkpoints: ctx.checkpoints,
    notifications,
    timings,
    slow: ctx.slow,
    findings: ctx.findings,
    users: [...ctx.managers, ...(ctx.nonMember ? [ctx.nonMember] : []), ...ctx.extraUsers],
    elapsedMs: Math.round(performance.now() - t0),
  };
}
