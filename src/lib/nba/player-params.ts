/** Query-string parsing for the Players table (pure, shared by the page components and tests). */
import { z } from "zod";
import { FANTASY_POSITIONS } from "./positions";
import { OWNERSHIP_FILTERS, RANGES, SORT_KEYS } from "./players-query";

export const playerParamsSchema = z.object({
  q: z.string().trim().max(80).optional().catch(undefined),
  pos: z.enum(FANTASY_POSITIONS).optional().catch(undefined),
  team: z.coerce.number().int().positive().optional().catch(undefined),
  inj: z.string().max(40).optional().catch(undefined),
  healthy: z.enum(["1"]).optional().catch(undefined),
  range: z.enum(RANGES).catch("season"),
  /** Season (ESPN end year); absent = default (current season once it has a final game, else last season). */
  season: z.coerce.number().int().min(2000).max(2100).optional().catch(undefined),
  sort: z.enum(SORT_KEYS).catch("fptotal"),
  dir: z.enum(["asc", "desc"]).catch("desc"),
  page: z.coerce.number().int().min(1).max(1000).catch(1),
  /** League mode only. */
  status: z.enum(OWNERSHIP_FILTERS).catch("fa"),
});
export type PlayerParams = z.infer<typeof playerParamsSchema>;

export function parsePlayerParams(search: Record<string, string | string[] | undefined>): PlayerParams {
  const raw = Object.fromEntries(Object.entries(search).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  return playerParamsSchema.parse(raw);
}
