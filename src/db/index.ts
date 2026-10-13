import { PGlite } from "@electric-sql/pglite";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import * as schema from "./schema";
import type { Db } from "./types";

export type { Db } from "./types";
export { schema };

/**
 * DATABASE_URL modes:
 *  - unset              -> PGlite persisted in ./.pglite (in-memory when NODE_ENV=test)
 *  - pglite:<dir>       -> PGlite persisted in <dir>   (pglite:memory:// for in-memory)
 *  - anything else      -> Postgres via Neon's serverless driver (supports transactions)
 */
export function resolvePgliteDataDir(
  url = process.env.DATABASE_URL,
  onVercel = Boolean(process.env.VERCEL),
): string | null {
  let dataDir: string | null = null;
  if (!url) dataDir = process.env.NODE_ENV === "test" ? "memory://" : "./.pglite";
  else if (url.startsWith("pglite:")) dataDir = url.slice("pglite:".length) || "./.pglite";
  // Vercel's filesystem is ephemeral: PGlite there would silently lose every write.
  if (dataDir !== null && onVercel) {
    throw new Error("DATABASE_URL must point at Postgres (Neon) on Vercel; refusing to fall back to PGlite.");
  }
  return dataDir;
}

function createDb(): Db {
  const dataDir = resolvePgliteDataDir();
  if (dataDir !== null) {
    return drizzlePglite(new PGlite(dataDir), { schema }) as unknown as Db;
  }
  // Node 22+ has a global WebSocket, which the Neon driver picks up automatically.
  neonConfig.poolQueryViaFetch = true;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return drizzleNeon(pool, { schema }) as unknown as Db;
}

// Cache on globalThis so dev hot-reloads don't open a second PGlite/pool on the same data.
const globalForDb = globalThis as unknown as { __db?: Db };

// Lazy proxy: importing this module never opens a connection (keeps `next build` DB-free).
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    globalForDb.__db ??= createDb();
    const value = Reflect.get(globalForDb.__db, prop);
    return typeof value === "function" ? value.bind(globalForDb.__db) : value;
  },
});
