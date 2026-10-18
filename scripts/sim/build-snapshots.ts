/**
 * Runs the league simulation once and saves a gzipped PGlite data directory (plus the checkpoint's metadata) at each
 * checkpoint under .pglite-sim/_snapshots. `materialize` turns one back into a database directory.
 */
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../../src/db/schema";
import type { Db } from "../../src/db/types";
import { runLeagueSimulation } from "../../tests/sim/lib/league-sim";
import { CHECKPOINTS, SNAP_DIR, dbDir, snapFile, snapMeta } from "./common";

export function snapshotsExist(): boolean {
  return CHECKPOINTS.every((cp) => fs.existsSync(snapFile(cp)) && fs.existsSync(snapMeta(cp)));
}

export async function buildSnapshots(log: (m: string) => void = console.log) {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client), { migrationsFolder: path.resolve("drizzle") });
  const result = await runLeagueSimulation(db, {
    onCheckpoint: async (name, ctx) => {
      const blob = await client.dumpDataDir("gzip");
      fs.writeFileSync(snapFile(name), Buffer.from(await blob.arrayBuffer()));
      fs.writeFileSync(snapMeta(name), JSON.stringify({ name, now: ctx.now.toISOString(), leagueId: ctx.leagueId, nextLeagueId: ctx.nextLeagueId ?? null, users: ctx.users }, null, 1));
      log(`  snapshot ${name} (${(blob.size / 1e6).toFixed(1)} MB) at ${ctx.now.toISOString()}`);
    },
  });
  await client.close();
  if (!result.completed) throw new Error("simulation did not complete");
  return result;
}

/** Restores a snapshot into .pglite-sim/<checkpoint> (replacing it). */
export async function materialize(cp: string) {
  const dir = dbDir(cp);
  fs.rmSync(dir, { recursive: true, force: true });
  const buf = fs.readFileSync(snapFile(cp));
  const client = new PGlite(dir, { loadDataDir: new Blob([buf]) });
  await client.waitReady;
  await client.close();
}
