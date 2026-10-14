/** Dev-only demo league (4 teams) so the leagues UI is populated. Never call against production. */
import { eq } from "drizzle-orm";
import { leagues } from "@/db/schema";
import type { Db } from "@/db/types";
import { findUserByUsername } from "@/lib/auth/service";
import { createLeague, createLeagueInvite, generateSchedule, redeemLeagueInvite, updateSettings } from "./service";

export const DEMO_LEAGUE_NAME = "Demo League";

export async function seedDemoLeague(db: Db) {
  const [existing] = await db.select().from(leagues).where(eq(leagues.name, DEMO_LEAGUE_NAME));
  if (existing) return { created: false as const, leagueId: existing.id };
  const admin = await findUserByUsername(db, "admin");
  if (!admin) throw new Error('Seed the "admin" user first');

  const league = await createLeague(db, { id: admin.id, isSiteAdmin: admin.isSiteAdmin }, {
    name: DEMO_LEAGUE_NAME,
    season: 2027,
    teamName: "Admin All-Stars",
    teamAbbrev: "ADM",
  });
  const members = [
    ["demo1", "Hardwood Heroes", "HWH"],
    ["demo2", "Splash Brothers", "SPL"],
    ["demo3", "Glass Cleaners", "GLC"],
  ] as const;
  for (const [username, teamName, teamAbbrev] of members) {
    const { token } = await createLeagueInvite(db, { id: admin.id, isSiteAdmin: true }, league.id);
    await redeemLeagueInvite(db, { token, username, password: "password123", teamName, teamAbbrev });
  }
  // Fixture NBA schedule is only one day, so the season dates are entered by hand here.
  await updateSettings(db, { id: admin.id, isSiteAdmin: true }, league.id, {
    regularSeasonStart: "2026-10-20",
    regularSeasonEnd: "2027-04-11",
  });
  await generateSchedule(db, { id: admin.id, isSiteAdmin: true }, league.id, { seed: "demo" });
  return { created: true as const, leagueId: league.id };
}
