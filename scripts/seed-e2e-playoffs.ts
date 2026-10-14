/**
 * E2E fixture for playoffs, season history and keepers: "Playoff League", a 4-team league whose four
 * weekly periods all lie in the FUTURE (starting next Monday ET): 2 regular weeks, then a semifinal
 * week and a final week. Every week has the same two final NBA games between fake teams, so the
 * outcome is fixed: Hoop Squad (admin, commissioner) 44, Alpha Squad 30, Beta Squad 24, Gamma Squad 10
 * points a week. The e2e jumps time with POST /api/cron/matchups?now=...&leagueId=... (honored only
 * against PGlite). Seeds: 1 Hoop Squad, 2 Alpha, 3 Beta, 4 Gamma; Hoop Squad wins the title.
 *
 * Settings: roster cap 6, snake target 8 (2 snake rounds), 1 keeper per team.
 * Users: admin, pfriend1, pfriend2, pfriend3 (password friend-password-1).
 * Each team has one star ("E3 Star One".."E3 Star Four"); Hoop Squad also has "E3 Cut One", an INACTIVE
 * player who must not be offered as a keeper.
 * Dev/e2e only: refuses to run against a real Postgres database. Run after db:migrate + create-admin.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { eq } from "drizzle-orm";
import { db, resolvePgliteDataDir } from "../src/db";
import { gameRosterSnapshots, leagues, nbaGames, nbaPlayers, nbaTeams, playerGameStats, rosterEntries, teams } from "../src/db/schema";
import { findUserByUsername } from "../src/lib/auth/service";
import { createLeague, createLeagueInvite, generateSchedule, redeemLeagueInvite, updateSettings } from "../src/lib/leagues/service";
import { addDays, etStartOfDay, etWeekRange } from "../src/lib/nba/dates";

const LEAGUE_NAME = "Playoff League";
const NBA = [9501, 9502, 9503, 9504];
const PLAYER_BASE = 9_500_000;
const GAME_BASE = 9_600_000;

async function main() {
  if (resolvePgliteDataDir() === null) {
    console.error("Refusing to seed: DATABASE_URL points at a real Postgres database.");
    process.exit(1);
  }
  const [existing] = await db.select().from(leagues).where(eq(leagues.name, LEAGUE_NAME));
  if (existing) {
    console.log("Playoff League already seeded");
    process.exit(0);
  }
  const admin = await findUserByUsername(db, "admin");
  if (!admin) throw new Error('Create the "admin" user first');
  const actor = { id: admin.id, isSiteAdmin: true };

  const league = await createLeague(db, actor, { name: LEAGUE_NAME, season: 2027, teamName: "Hoop Squad", teamAbbrev: "HSQ" });
  const members = [
    { username: "pfriend1", team: "Alpha Squad", abbrev: "ASQ" },
    { username: "pfriend2", team: "Beta Squad", abbrev: "BSQ" },
    { username: "pfriend3", team: "Gamma Squad", abbrev: "GSQ" },
  ];
  for (const m of members) {
    const { token } = await createLeagueInvite(db, actor, league.id, { revokeOthers: false });
    await redeemLeagueInvite(db, { token, username: m.username, password: "friend-password-1", teamName: m.team, teamAbbrev: m.abbrev });
  }

  const start = addDays(etWeekRange(new Date()).startDate, 7); // next Monday: weeks 1-2 regular, 3 semifinal, 4 final
  await updateSettings(db, actor, league.id, {
    regularSeasonStart: start,
    regularSeasonEnd: addDays(start, 27),
    playoffTeams: 4,
    playoffRoundLength: 1,
    rosterCap: 6,
    snakeTarget: 8,
    keepers: 1,
  });
  await generateSchedule(db, actor, league.id, { seed: "e2e-playoffs" });
  await db.update(leagues).set({ status: "in_season" }).where(eq(leagues.id, league.id));

  const names = ["Hoop Squad", "Alpha Squad", "Beta Squad", "Gamma Squad"];
  const teamRows = await db.select().from(teams).where(eq(teams.leagueId, league.id));
  const teamOf = (name: string) => teamRows.find((t) => t.name === name)!;

  await db.insert(nbaTeams).values(NBA.map((id, i) => ({ id, abbrev: `E3${"ABCD"[i]}`, name: `E3 Team ${"ABCD"[i]}`, location: "E2E" })));
  const stars = ["One", "Two", "Three", "Four"].map((n, i) => ({ id: PLAYER_BASE + i + 1, name: `E3 Star ${n}`, nba: NBA[i], team: names[i], pts: 40 - 10 * i }));
  const cut = { id: PLAYER_BASE + 10, name: "E3 Cut One", nba: NBA[0], team: names[0] };
  await db.insert(nbaPlayers).values([
    ...stars.map((p) => ({ id: p.id, fullName: p.name, teamId: p.nba, positions: ["PG"], active: true })),
    { id: cut.id, fullName: cut.name, teamId: cut.nba, positions: ["SG"], active: false },
  ]);
  await db.insert(rosterEntries).values(
    [...stars, cut].map((p) => ({
      leagueId: league.id,
      teamId: teamOf(p.team).id,
      playerId: p.id,
      acquiredVia: "draft" as const,
      acquiredAt: new Date("2026-01-01T00:00:00Z"),
    })),
  );

  // Every week: E3A (home) beats E3B 110-100 and E3C (home) beats E3D 105-95 on Wednesday 7pm ET.
  // Stars score 40/30/20/10 points; the two home winners also earn the +4 bonus: 44, 30, 24, 10.
  let gameId = GAME_BASE;
  for (let week = 0; week < 4; week++) {
    const tip = new Date(etStartOfDay(addDays(start, 7 * week + 2)).getTime() + 19 * 3_600_000);
    for (const [home, away, hs, as] of [[0, 1, 110, 100], [2, 3, 105, 95]] as const) {
      gameId++;
      await db.insert(nbaGames).values({
        id: gameId,
        season: 2027,
        // Type 1 (preseason): regular-season date detection (generateSchedule's All-Star merge) ignores it, so
        // these future-dated games cannot change the schedules other specs generate for season 2027.
        seasonType: 1,
        startTime: tip,
        homeTeamId: NBA[home],
        awayTeamId: NBA[away],
        homeScore: hs,
        awayScore: as,
        status: "final" as const,
        statsFinal: true,
      });
      for (const i of [home, away]) {
        await db.insert(gameRosterSnapshots).values({ gameId, playerId: stars[i].id, nbaTeamId: NBA[i], injuryStatus: null });
        await db.insert(playerGameStats).values({ gameId, playerId: stars[i].id, teamId: NBA[i], minutes: 30, pts: stars[i].pts });
      }
    }
  }
  console.log("Seeded Playoff League", league.id, "starting", start);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
