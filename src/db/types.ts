import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema";

// Driver-agnostic database type: satisfied by both PGlite and Neon clients (and transactions).
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
