/**
 * Runs the NBA daily sync against whatever DATABASE_URL points at, using the live ESPN API.
 *   npm run sync:daily [-- --season 2026 --season 2027] [--budget-seconds 300]
 * Run `npm run db:migrate` first. Each run backfills as many box scores as the time budget
 * allows and resumes where it stopped on the next run.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { parseArgs } from "node:util";
import { db } from "../src/db";
import { createEspnClient } from "../src/lib/nba/espn";
import { syncCorrections, syncDaily } from "../src/lib/nba/sync";

async function main() {
  const { values } = parseArgs({
    options: { season: { type: "string", multiple: true }, "budget-seconds": { type: "string" } },
  });
  const seasons = values.season?.map(Number).filter((n) => Number.isInteger(n) && n > 2000);
  const budgetMs = values["budget-seconds"] ? Number(values["budget-seconds"]) * 1000 : 45_000;
  const client = createEspnClient();

  const daily = await syncDaily(db, client, { budgetMs, ...(seasons?.length ? { seasons } : {}) });
  console.log(JSON.stringify(daily, null, 2));
  const corrections = await syncCorrections(db, client);
  console.log(JSON.stringify(corrections, null, 2));
  process.exit(daily.ok && corrections.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
