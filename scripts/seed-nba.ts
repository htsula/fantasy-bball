/**
 * Loads the saved ESPN fixtures (tests/fixtures/espn) into the local dev database.
 * Dev only: refuses to run against a real Postgres database. Run `npm run db:migrate` first.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { db, resolvePgliteDataDir } from "../src/db";
import { seedNbaFixtures } from "../src/lib/nba/seed-fixtures";

async function main() {
  if (resolvePgliteDataDir() === null) {
    console.error("Refusing to seed fixtures: DATABASE_URL points at a real Postgres database.");
    process.exit(1);
  }
  console.log("Seeded NBA fixtures:", await seedNbaFixtures(db));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
