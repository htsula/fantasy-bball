/**
 * E2E fixture for the trades flows: two in-season 4-team leagues with hand-made players on a fake
 * NBA team (no network, no draft). Dev/e2e only: refuses to run against a real Postgres database.
 * Run after db:migrate + create-admin.
 *
 * "Trade League": commissioner review (24h). Teams: Trade Admin (admin, commissioner),
 *   Alpha Club (talpha), Bravo Club (tbravo), Charlie Club (tcharlie). Password trade-password-1.
 * "Vote League": league vote, 2 vetoes cancel a trade. Teams: Vote Admin (admin, commissioner),
 *   Vote Alpha (vote-a), Vote Bravo (vote-b), Vote Charlie (vote-c). Password trade-password-1.
 * Every team has 4 players named "<Team> <n>" and a roster maximum of 10.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { eq } from "drizzle-orm";
import { db, resolvePgliteDataDir } from "../src/db";
import { leagues, nbaPlayers, nbaTeams, rosterEntries, teams } from "../src/db/schema";
import { findUserByUsername } from "../src/lib/auth/service";
import { createLeague, createLeagueInvite, generateSchedule, redeemLeagueInvite, updateSettings } from "../src/lib/leagues/service";
import { addDays, etDateString } from "../src/lib/nba/dates";

const PASSWORD = "trade-password-1";
const NBA_TEAM = 9301;

type Spec = {
  name: string;
  review: "commissioner" | "league_vote";
  adminTeam: { name: string; abbrev: string };
  members: { username: string; team: string; abbrev: string }[];
  playerBase: number;
};

const SPECS: Spec[] = [
  {
    name: "Trade League",
    review: "commissioner",
    adminTeam: { name: "Trade Admin", abbrev: "TAD" },
    members: [
      { username: "talpha", team: "Alpha Club", abbrev: "ALP" },
      { username: "tbravo", team: "Bravo Club", abbrev: "BRV" },
      { username: "tcharlie", team: "Charlie Club", abbrev: "CHA" },
    ],
    playerBase: 9_310_000,
  },
  {
    name: "Vote League",
    review: "league_vote",
    adminTeam: { name: "Vote Admin", abbrev: "VAD" },
    members: [
      { username: "vote-a", team: "Vote Alpha", abbrev: "VAL" },
      { username: "vote-b", team: "Vote Bravo", abbrev: "VBR" },
      { username: "vote-c", team: "Vote Charlie", abbrev: "VCH" },
    ],
    playerBase: 9_320_000,
  },
];

async function main() {
  if (resolvePgliteDataDir() === null) {
    console.error("Refusing to seed: DATABASE_URL points at a real Postgres database.");
    process.exit(1);
  }
  const admin = await findUserByUsername(db, "admin");
  if (!admin) throw new Error('Create the "admin" user first');
  const actor = { id: admin.id, isSiteAdmin: true };

  const [existing] = await db.select().from(leagues).where(eq(leagues.name, SPECS[0].name));
  if (existing) {
    console.log("Trade leagues already seeded");
    process.exit(0);
  }
  await db.insert(nbaTeams).values({ id: NBA_TEAM, abbrev: "E2T", name: "Traders", location: "E2E" });

  const today = etDateString(new Date());
  for (const spec of SPECS) {
    const league = await createLeague(db, actor, { name: spec.name, season: 2027, teamName: spec.adminTeam.name, teamAbbrev: spec.adminTeam.abbrev });
    for (const m of spec.members) {
      const { token } = await createLeagueInvite(db, actor, league.id);
      await redeemLeagueInvite(db, { token, username: m.username, password: PASSWORD, teamName: m.team, teamAbbrev: m.abbrev });
    }
    await updateSettings(db, actor, league.id, {
      regularSeasonStart: addDays(today, -7),
      regularSeasonEnd: addDays(today, 60),
      playoffTeams: 2,
      rosterCap: 10,
      tradeReview: spec.review,
      tradeReviewHours: 24,
      vetoVotesNeeded: 2,
    });
    await generateSchedule(db, actor, league.id, { seed: "e2e-trades" });
    await db.update(leagues).set({ status: "in_season" }).where(eq(leagues.id, league.id));

    const teamRows = await db.select().from(teams).where(eq(teams.leagueId, league.id));
    const sorted = [...teamRows].sort((a, b) => a.name.localeCompare(b.name));
    const playerRows: (typeof nbaPlayers.$inferInsert)[] = [];
    const entries: (typeof rosterEntries.$inferInsert)[] = [];
    sorted.forEach((team, ti) => {
      for (let n = 1; n <= 4; n++) {
        const id = spec.playerBase + ti * 10 + n;
        playerRows.push({ id, fullName: `${team.name} ${n}`, teamId: NBA_TEAM, positions: ["SF"], active: true });
        entries.push({
          leagueId: league.id,
          teamId: team.id,
          playerId: id,
          acquiredVia: "draft",
          acquiredAt: new Date("2026-01-01T00:00:00Z"),
        });
      }
    });
    await db.insert(nbaPlayers).values(playerRows);
    await db.insert(rosterEntries).values(entries);
    console.log("Seeded", spec.name, league.id);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
