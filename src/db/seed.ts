/**
 * Dev-only seed data. Refuses to run against a real Postgres database.
 * Later milestones extend this with demo leagues, players and stats.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { db, resolvePgliteDataDir } from "./index";
import { createUser, findUserByUsername } from "../lib/auth/service";

async function main() {
  if (resolvePgliteDataDir() === null) {
    console.error("Refusing to seed: DATABASE_URL points at a real Postgres database.");
    process.exit(1);
  }
  if (!(await findUserByUsername(db, "admin"))) {
    await createUser(db, {
      username: "admin",
      displayName: "Admin",
      password: "password123",
      isSiteAdmin: true,
    });
    console.log('Seeded admin user "admin" / "password123".');
  } else {
    console.log("Seed data already present.");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
