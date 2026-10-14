/**
 * E2E fixture: an in-season 2-team league ("Social League") for the chat / announcement /
 * commissioner-tools e2e. No NBA games, so every matchup scores 0-0 until the commissioner adjusts it.
 * Dev/e2e only: refuses to run against a real Postgres database. Run after db:migrate + create-admin.
 *
 * Users: admin (commissioner, team "Chat Crew"), sfriend / social-pass-1 (team "Hoopers"), and
 * newguy / newguy-pass-1 (no team yet: the target of an ownership transfer).
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { eq } from "drizzle-orm";
import { db, resolvePgliteDataDir } from "../src/db";
import { leagues } from "../src/db/schema";
import { createUser, findUserByUsername } from "../src/lib/auth/service";
import { createLeague, createLeagueInvite, generateSchedule, redeemLeagueInvite, updateSettings } from "../src/lib/leagues/service";
import { addDays, etWeekRange } from "../src/lib/nba/dates";

const LEAGUE_NAME = "Social League";

async function main() {
  if (resolvePgliteDataDir() === null) {
    console.error("Refusing to seed: DATABASE_URL points at a real Postgres database.");
    process.exit(1);
  }
  const [existing] = await db.select().from(leagues).where(eq(leagues.name, LEAGUE_NAME));
  if (existing) {
    console.log("Social League already seeded");
    process.exit(0);
  }
  const admin = await findUserByUsername(db, "admin");
  if (!admin) throw new Error('Create the "admin" user first');
  const actor = { id: admin.id, isSiteAdmin: true };

  const league = await createLeague(db, actor, { name: LEAGUE_NAME, season: 2027, teamName: "Chat Crew", teamAbbrev: "CHC" });
  const { token } = await createLeagueInvite(db, actor, league.id);
  await redeemLeagueInvite(db, { token, username: "sfriend", password: "social-pass-1", teamName: "Hoopers", teamAbbrev: "HPR" });
  await createUser(db, { username: "newguy", password: "newguy-pass-1" });

  const monday = etWeekRange(new Date()).startDate;
  await updateSettings(db, actor, league.id, {
    regularSeasonStart: addDays(monday, -14),
    regularSeasonEnd: addDays(monday, 13),
    playoffTeams: 2,
    playoffRoundLength: 1,
  });
  await generateSchedule(db, actor, league.id, { seed: "e2e-social" });
  await db.update(leagues).set({ status: "in_season" }).where(eq(leagues.id, league.id));
  console.log("Seeded Social League", league.id);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
