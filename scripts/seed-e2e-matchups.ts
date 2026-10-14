/**
 * E2E fixture: an in-season 2-team league ("Matchup League") with hand-built NBA games, box scores
 * and tip-off snapshots, so the matchup/standings e2e needs no network and no draft.
 * Dev/e2e only: refuses to run against a real Postgres database. Run after db:migrate + create-admin.
 *
 * Users: admin (commissioner, team "Hoop Dreams") and mfriend / friend-password-1 (team "Buckets").
 * Period 1 (two weeks ago) has two final NBA games between fake teams E2A (home) and E2B:
 *   Wed 7pm ET   E2A 110-100 E2B   (E2A players earn the +4 bonus unless Out)
 *   Sun 10:30pm  E2A  95-99  E2B   (a Monday-UTC tip-off that still belongs to the Sunday period)
 * Expected period-1 totals: Hoop Dreams 48, Buckets 46 (see e2e/matchups.spec.ts).
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

const LEAGUE_NAME = "Matchup League";
const E2A = 9001;
const E2B = 9002;

async function main() {
  if (resolvePgliteDataDir() === null) {
    console.error("Refusing to seed: DATABASE_URL points at a real Postgres database.");
    process.exit(1);
  }
  const [existing] = await db.select().from(leagues).where(eq(leagues.name, LEAGUE_NAME));
  if (existing) {
    console.log("Matchup League already seeded");
    process.exit(0);
  }
  const admin = await findUserByUsername(db, "admin");
  if (!admin) throw new Error('Create the "admin" user first');
  const actor = { id: admin.id, isSiteAdmin: true };

  const league = await createLeague(db, actor, { name: LEAGUE_NAME, season: 2027, teamName: "Hoop Dreams", teamAbbrev: "HDR" });
  const { token } = await createLeagueInvite(db, actor, league.id);
  await redeemLeagueInvite(db, { token, username: "mfriend", password: "friend-password-1", teamName: "Buckets", teamAbbrev: "BKT" });

  // Weeks (Mon-Sun ET): w-2, w-1, w0 are regular; w+1 is the single playoff round.
  const monday = etWeekRange(new Date()).startDate;
  const start = addDays(monday, -14);
  await updateSettings(db, actor, league.id, {
    regularSeasonStart: start,
    regularSeasonEnd: addDays(monday, 13),
    playoffTeams: 2,
    playoffRoundLength: 1,
  });
  await generateSchedule(db, actor, league.id, { seed: "e2e" });

  await db.update(leagues).set({ status: "in_season" }).where(eq(leagues.id, league.id));
  const teamRows = await db.select().from(teams).where(eq(teams.leagueId, league.id));
  const mine = teamRows.find((t) => t.name === "Hoop Dreams")!;
  const theirs = teamRows.find((t) => t.name === "Buckets")!;

  // Fake NBA teams, players and games.
  await db.insert(nbaTeams).values([
    { id: E2A, abbrev: "E2A", name: "Alphas", location: "E2E" },
    { id: E2B, abbrev: "E2B", name: "Betas", location: "E2E" },
  ]);
  const players = [
    { id: 9100001, name: "E2E Starter", team: E2A, fantasy: mine.id },
    { id: 9100002, name: "E2E Bench Winner", team: E2A, fantasy: mine.id },
    { id: 9100003, name: "E2E Injured Out", team: E2A, fantasy: mine.id },
    { id: 9100004, name: "E2E Opp One", team: E2B, fantasy: theirs.id },
    { id: 9100005, name: "E2E Opp Two", team: E2B, fantasy: theirs.id },
  ];
  await db.insert(nbaPlayers).values(
    players.map((p) => ({
      id: p.id,
      fullName: p.name,
      teamId: p.team,
      positions: ["PG"],
      active: true,
      injuryStatus: p.id === 9100003 ? "Out" : null,
    })),
  );
  await db.insert(rosterEntries).values(
    players.map((p) => ({
      leagueId: league.id,
      teamId: p.fantasy,
      playerId: p.id,
      acquiredVia: "draft" as const,
      acquiredAt: new Date("2026-01-01T00:00:00Z"),
    })),
  );

  const wed = new Date(etStartOfDay(addDays(start, 2)).getTime() + 19 * 3_600_000); // 7pm ET
  const sun = new Date(etStartOfDay(addDays(start, 6)).getTime() + 22.5 * 3_600_000); // 10:30pm ET
  await db.insert(nbaGames).values([
    { id: 9200001, season: 2027, seasonType: 2, startTime: wed, homeTeamId: E2A, awayTeamId: E2B, homeScore: 110, awayScore: 100, status: "final" as const, statsFinal: true },
    { id: 9200002, season: 2027, seasonType: 2, startTime: sun, homeTeamId: E2A, awayTeamId: E2B, homeScore: 95, awayScore: 99, status: "final" as const, statsFinal: true },
  ]);

  // Tip-off snapshots: everybody rostered by the NBA teams (the Out player is flagged Out).
  for (const gameId of [9200001, 9200002]) {
    await db.insert(gameRosterSnapshots).values(
      players.map((p) => ({ gameId, playerId: p.id, nbaTeamId: p.team, injuryStatus: p.id === 9100003 ? "Out" : null })),
    );
  }
  // Box scores (default scoring: 1 point per PTS and nothing else here). The bench winner and Out player never play.
  const line = (gameId: number, playerId: number, teamId: number, pts: number) => ({ gameId, playerId, teamId, minutes: 30, pts });
  await db.insert(playerGameStats).values([
    line(9200001, 9100001, E2A, 30),
    line(9200001, 9100004, E2B, 20),
    line(9200001, 9100005, E2B, 10),
    line(9200002, 9100001, E2A, 10),
    line(9200002, 9100004, E2B, 5),
    line(9200002, 9100005, E2B, 3),
  ]);
  console.log("Seeded Matchup League", league.id);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
