import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { migrate as migrateNeon } from "drizzle-orm/neon-serverless/migrator";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { resolvePgliteDataDir } from "./index";

// Applies SQL migrations from ./drizzle to whichever database DATABASE_URL points at.
async function main() {
  // On Vercel (via `vercel-build`) only production deploys migrate by default, so a preview
  // build of unmerged code can't alter the live league's schema. Set MIGRATE_ON_PREVIEW=1
  // once previews get their own Neon branch.
  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv && vercelEnv !== "production" && process.env.MIGRATE_ON_PREVIEW !== "1") {
    console.log(`Skipping migrations on Vercel ${vercelEnv} build (set MIGRATE_ON_PREVIEW=1 to enable).`);
    return;
  }
  const dataDir = resolvePgliteDataDir();
  if (dataDir !== null) {
    const client = new PGlite(dataDir);
    await migratePglite(drizzlePglite(client), { migrationsFolder: "drizzle" });
    await client.close();
    console.log(`Migrated PGlite database at ${dataDir}`);
  } else {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await migrateNeon(drizzleNeon(pool), { migrationsFolder: "drizzle" });
    await pool.end();
    console.log("Migrated Postgres database");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
