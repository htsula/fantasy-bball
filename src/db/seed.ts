/**
 * Dev-only seed data. Refuses to run against a real Postgres database.
 * Also loads the saved ESPN fixtures (teams, one roster, a final game with its box score,
 * injuries, news) so the NBA pages have data offline. Later milestones add demo leagues.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { db, resolvePgliteDataDir } from "./index";
import { createUser, findUserByUsername } from "../lib/auth/service";
import { seedNbaFixtures } from "../lib/nba/seed-fixtures";

async function main() {
  if (resolvePgliteDataDir() === null) {
    console.error("Refusing to seed: DATABASE_URL points at a real Postgres database.");
    process.exit(1);
  }
  if (!(await findUserByUsername(db, "admin"))) {
    await createUser(db, {
      username: "admin",
      password: "password123",
      isSiteAdmin: true,
    });
    console.log('Seeded admin user "admin" / "password123".');
  } else {
    console.log("Seed data already present.");
  }
  console.log("Seeded NBA fixtures:", await seedNbaFixtures(db));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
