import { matchupPeriods, matchups } from "@/db/schema";
import type { Db } from "@/db/types";
import { playoffRounds, roundRobin } from "@/lib/fantasy/schedule";
import { addDays } from "@/lib/nba/dates";
import { boxScore, insertGame, rosterPlayer, seasonLeague, snapshot } from "./rosters";
import type { DraftFixture } from "./draft";

export const FIRST_MONDAY = "2026-10-19";

export type SeasonPlan = {
  fx: DraftFixture;
  /** Period numbers: regular 1..regular, then playoff periods. */
  regular: number;
  playoff: number;
  periodStart: (n: number) => string;
  periodEnd: (n: number) => string;
  /** A moment shortly after the last ET day of period n (Monday 12:00 ET the next day). */
  after: (n: number) => Date;
  /** Fantasy points team index i scores in a week (default: stronger for lower i). */
  pts: (week: number, teamIndex: number) => number;
};

type Options = {
  teams: number;
  playoffTeams: number;
  roundLength?: 1 | 2;
  /** Stat points of the team's single player in a week. Team i's player is id i + 1 on NBA team i + 1. */
  pts?: (week: number, teamIndex: number) => number;
  /** Regular periods (default: a full round robin, teams - 1). */
  regular?: number;
};

/**
 * League already in season with a full weekly schedule (real round robin + empty playoff periods),
 * one player per team and a final NBA game per week for every pair of NBA teams (1v2, 3v4, ...;
 * the odd-numbered NBA team always wins, so its player earns the +4 bonus). Needs players
 * 1..teams seeded (seedPlayers gives player i NBA team i).
 *
 * With the default points (stronger for lower team index) every team beats all weaker ones, so a
 * full round robin ranks the teams 1..n exactly in team-index order.
 */
export async function planSeason(db: Db, o: Options): Promise<SeasonPlan> {
  const roundLength = o.roundLength ?? 1;
  const fx = await seasonLeague(db, o.teams, {
    settings: { playoffTeams: o.playoffTeams, playoffRoundLength: roundLength },
  });
  const regular = o.regular ?? o.teams - 1;
  const playoff = playoffRounds(o.playoffTeams) * roundLength;
  const periodStart = (n: number) => addDays(FIRST_MONDAY, 7 * (n - 1));
  const periodEnd = (n: number) => addDays(periodStart(n), 6);
  const pts = o.pts ?? ((_w: number, i: number) => 100 - 10 * i);

  const total = regular + playoff;
  const periods = await db
    .insert(matchupPeriods)
    .values(
      Array.from({ length: total }, (_, k) => {
        const n = k + 1;
        const isPlayoff = n > regular;
        return {
          leagueId: fx.league.id,
          number: n,
          startDate: periodStart(n),
          endDate: periodEnd(n),
          isPlayoff,
          playoffRound: isPlayoff ? Math.floor((n - regular - 1) / roundLength) + 1 : null,
        };
      }),
    )
    .returning();
  const idOf = new Map(periods.map((p) => [p.number, p.id]));

  const order = [...fx.teams].sort((a, b) => a.name.localeCompare(b.name));
  fx.teams.splice(0, fx.teams.length, ...order);
  const rounds = roundRobin(
    fx.teams.map((t) => t.id),
    regular,
    "plan",
  );
  const rows = rounds.flatMap((r, i) =>
    r.pairings.map((m) => ({ leagueId: fx.league.id, periodId: idOf.get(i + 1)!, homeTeamId: m.home, awayTeamId: m.away })),
  );
  if (rows.length) await db.insert(matchups).values(rows);

  for (let i = 0; i < o.teams; i++) await rosterPlayer(db, fx, i, i + 1);
  let gameId = 1000;
  for (let w = 1; w <= total; w++) {
    const tip = new Date(`${addDays(periodStart(w), 2)}T23:00:00Z`); // Wednesday 7pm ET
    for (let pair = 0; pair < o.teams / 2; pair++) {
      const home = 2 * pair + 1;
      const away = 2 * pair + 2;
      await insertGame(db, ++gameId, tip, "final", home, away);
      for (const nba of [home, away]) {
        await snapshot(db, gameId, nba, nba);
        await boxScore(db, gameId, nba, nba, { pts: pts(w, nba - 1) });
      }
    }
  }
  return {
    fx,
    regular,
    playoff,
    periodStart,
    periodEnd,
    after: (n) => new Date(`${addDays(periodEnd(n), 1)}T16:00:00Z`),
    pts,
  };
}
