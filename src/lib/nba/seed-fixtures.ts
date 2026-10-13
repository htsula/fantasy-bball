/**
 * Loads the saved ESPN fixtures into a database so the UI has NBA data offline (dev seed and
 * e2e). One roster (ATL), one scoreboard day with a final game, and that game's box score.
 */
import type { Db } from "@/db/types";
import { createFixtureClient, FIXTURE_GAME_ID } from "./fixture-client";
import { ingestInjuries, ingestNews, ingestRoster, ingestScoreboard, ingestSummary, ingestTeams } from "./sync";

export async function seedNbaFixtures(db: Db, now = new Date()) {
  const client = createFixtureClient();
  const teams = await ingestTeams(db, await client.teams(), now);
  const players = (await ingestRoster(db, await client.roster(1), now)).length;
  const games = await ingestScoreboard(db, await client.scoreboard("20260310"), now);
  const box = await ingestSummary(db, FIXTURE_GAME_ID, await client.summary(FIXTURE_GAME_ID), now);
  const injuries = await ingestInjuries(db, await client.injuries(), now);
  const news = await ingestNews(db, await client.news(), now);
  return { teams, rosterPlayers: players, games, statRows: box.statRows, injuries, news };
}
