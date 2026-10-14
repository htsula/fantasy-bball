/**
 * Dev-only seed data. Refuses to run against a real Postgres database.
 * Also loads the saved ESPN fixtures (teams, one roster, a final game with its box score,
 * injuries, news) so the NBA pages have data offline, plus a 10-team mid-season Demo League with invented
 * players (see src/lib/leagues/seed-demo.ts). Log in as admin / demo1..demo9, password "password123" (local only).
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { db, resolvePgliteDataDir } from "./index";
import { createUser, findUserByUsername } from "../lib/auth/service";
import { seedDemoLeague } from "../lib/leagues/seed-demo";
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
  const demo = await seedDemoLeague(db);
  console.log(
    demo.created
      ? "Seeded Demo League (10 teams, mid-season). Log in as admin or demo1..demo9 with password \"password123\"."
      : "Demo League already present.",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
