/**
 * Plays a full 16-team league (draft, 2026-27 season, playoffs, next season with keepers) into a PGlite
 * directory so you can browse it with `npm run dev`, and prints a summary. Dev only: refuses to run against a
 * real Postgres database, and never touches the default ./.pglite dev database.
 *
 *   DATABASE_URL=pglite:.pglite-sim npm run db:simulate
 *   npm run db:simulate -- --db .pglite-sim [--seed 7] [--until playoffs] [--no-smoke] [--force]
 *
 * Log in as `commish` (password `sim-pass-01`), `friend` (`sim-pass-02`), `mgr03` ... `mgr16` (`sim-pass-NN`;
 * mgr09 uses `sim-new-pass-09`, one team was handed to `newguy` / `sim-pass-18`). `--until <checkpoint>` stops
 * right after that checkpoint (setup, draft-snake, draft-waves, preseason, regular-season, playoffs, complete,
 * next-season, next-season-draft) and leaves the database in that state.
 */
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../src/db/schema";
import type { Db } from "../src/db/types";
import { runLeagueSimulation, type CheckpointName } from "../src/lib/sim/league-sim";
import { smokePages } from "../src/lib/sim/page-smoke";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const url = process.env.DATABASE_URL;
  if (url && !url.startsWith("pglite:") && !arg("db")) {
    console.error("Refusing to simulate: DATABASE_URL points at a real Postgres database.");
    process.exit(1);
  }
  const dirArg = arg("db") ?? (url?.startsWith("pglite:") ? url.slice("pglite:".length) : undefined);
  if (!dirArg || dirArg.startsWith("memory:")) {
    console.error("Pass a PGlite directory: DATABASE_URL=pglite:.pglite-sim npm run db:simulate (or --db .pglite-sim).");
    process.exit(1);
  }
  const dir = path.resolve(dirArg);
  if (dir === path.resolve(".pglite")) {
    console.error("Refusing to simulate into the default dev database (./.pglite). Use another directory, e.g. .pglite-sim.");
    process.exit(1);
  }
  if (existsSync(dir)) {
    if (!flag("force")) {
      console.error(`${dir} already exists. Pass --force to delete it and start over.`);
      process.exit(1);
    }
    rmSync(dir, { recursive: true, force: true });
  }

  const client = new PGlite(dir);
  const db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client), { migrationsFolder: path.resolve("drizzle") });
  const t0 = Date.now();
  const smoke = !flag("no-smoke");
  const result = await runLeagueSimulation(db, {
    seed: arg("seed") ? Number(arg("seed")) : undefined,
    until: arg("until") as CheckpointName | undefined,
    log: (m) => console.log(`  ${m}`),
    onCheckpoint: smoke ? async (name, ctx) => void (await smokePages(db, ctx, name)) : undefined,
  });
  await client.close();

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\nSimulation ${result.completed ? "finished" : `stopped after "${result.stoppedAt}"`} in ${secs}s (seed ${result.seed}); database: ${dir}`);
  console.log(`League ${result.leagueId}${result.nextLeagueId ? `, next season ${result.nextLeagueId}` : ""}`);
  if (result.champion) console.log(`Champion: ${result.champion}   Runner-up: ${result.runnerUp}`);
  if (result.standings.length) {
    console.log("\nFinal regular-season standings");
    for (const r of result.standings) console.log(`  ${String(r.rank).padStart(2)}. ${r.team.padEnd(22)} ${r.record.padEnd(8)} PF ${r.pointsFor.toFixed(0)}`);
    console.log("\nPlayoff bracket");
    for (const line of result.bracket) console.log(`  ${line}`);
  }
  const c = result.counters;
  console.log(`\nDraft picks ${c.picks} (commissioner ${c.commissionerPicks}), owner adds ${c.adds}, drops ${c.drops}, commissioner moves ${c.commissionerMoves}, NBA cuts ${c.autoDrops}`);
  console.log(`Trades proposed ${c.tradesProposed}, executed ${c.tradesExecuted}; chat messages ${c.chatMessages}; games ${c.gamesPlayed}`);
  console.log(`Oracle-checked matchups ${c.oracleMatchups}, live mid-game checks ${c.liveChecks}, forced ties ${c.forcedTies}, moves during games ${c.lateMoves}, assertions ${c.assertions}`);
  console.log(`Notifications: ${Object.entries(result.notifications).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log("\nCheckpoints");
  for (const cp of result.checkpoints) console.log(`  ${cp.name.padEnd(18)} ${cp.now.toISOString()}  ${cp.leagueStatus.padEnd(10)} ${cp.note}`);
  console.log("\nAccounts (username / password / role / team)");
  for (const u of result.users) console.log(`  ${u.username.padEnd(9)} ${u.password.padEnd(15)} ${u.role.padEnd(12)} ${u.teamName ?? "-"}`);
  if (result.slow.length) console.log("\nSlow calls (>1s):", result.slow);
  if (result.findings.length) console.log("\nNotes:\n  " + result.findings.join("\n  "));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
