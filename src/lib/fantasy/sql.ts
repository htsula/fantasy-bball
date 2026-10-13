import { sql, type SQL } from "drizzle-orm";
import { playerGameStats } from "@/db/schema";
import { DEFAULT_POINTS, STAT_KEYS, type PointValues } from "./points";

/** SQL expression for fantasy points of one player_game_stats row (values are inlined numbers). */
export function fantasyPointsSql(values: PointValues = DEFAULT_POINTS): SQL<number> {
  const terms = STAT_KEYS.map((k) => sql`${playerGameStats[k]} * ${sql.raw(String(Number(values[k])))}`);
  return sql<number>`(${sql.join(terms, sql` + `)})`;
}
