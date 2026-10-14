/**
 * Standings from FINAL regular-season matchups. Pure (no I/O).
 *
 * Ranking, applied in order:
 *  1. win% where a tie counts as half a win;
 *  2. head-to-head record (same half-win rule) in the games played only among the teams still tied
 *     (teams that never met score 0.5, i.e. neutral);
 *  3. points for (higher is better);
 *  4. points against (LOWER is better);
 *  5. team name (case-insensitive), then team id, so the order is always deterministic.
 * Head-to-head is applied once to the whole tied group (not recursively), which is what makes a
 * 3-way tie well defined: each team's mini-record is taken over games inside the group.
 * Byes and unfinished matchups are ignored.
 */
import { isBye, resolveMatchup } from "./matchup";

export type StandingsTeam = { id: string; name: string };

export type FinalMatchup = {
  periodNumber: number;
  homeTeamId: string;
  awayTeamId: string | null;
  homePoints: number;
  awayPoints: number | null;
};

export type StandingRow = {
  teamId: string;
  name: string;
  wins: number;
  losses: number;
  ties: number;
  gamesPlayed: number;
  /** (wins + ties/2) / games; 0 with no games. */
  winPct: number;
  pointsFor: number;
  pointsAgainst: number;
  /** "W3", "L1", "T1" or "" before any game. */
  streak: string;
  rank: number;
  /** Games behind the leader: ((leaderW - leaderL) - (W - L)) / 2. */
  gamesBack: number;
};

type Game = { period: number; a: string; b: string; aPts: number; bPts: number; result: "home" | "away" | "tie" };

function toGames(matchups: FinalMatchup[]): Game[] {
  const games: Game[] = [];
  for (const m of matchups) {
    if (isBye(m) || m.awayTeamId === null || m.awayPoints === null) continue;
    const o = resolveMatchup({ homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId }, { home: m.homePoints, away: m.awayPoints });
    games.push({ period: m.periodNumber, a: m.homeTeamId, b: m.awayTeamId, aPts: m.homePoints, bPts: m.awayPoints, result: o.result! });
  }
  return games.sort((x, y) => x.period - y.period);
}

export function computeStandings(teamList: StandingsTeam[], matchups: FinalMatchup[]): StandingRow[] {
  const games = toGames(matchups);
  const rows = new Map<string, StandingRow>(
    teamList.map((t) => [
      t.id,
      { teamId: t.id, name: t.name, wins: 0, losses: 0, ties: 0, gamesPlayed: 0, winPct: 0, pointsFor: 0, pointsAgainst: 0, streak: "", rank: 0, gamesBack: 0 },
    ]),
  );
  const history = new Map<string, ("W" | "L" | "T")[]>(teamList.map((t) => [t.id, []]));

  for (const g of games) {
    const a = rows.get(g.a);
    const b = rows.get(g.b);
    if (!a || !b) continue; // team removed from the league
    a.pointsFor += g.aPts;
    a.pointsAgainst += g.bPts;
    b.pointsFor += g.bPts;
    b.pointsAgainst += g.aPts;
    if (g.result === "tie") {
      a.ties++;
      b.ties++;
      history.get(g.a)!.push("T");
      history.get(g.b)!.push("T");
    } else {
      const [w, l] = g.result === "home" ? [a, b] : [b, a];
      w.wins++;
      l.losses++;
      history.get(w.teamId)!.push("W");
      history.get(l.teamId)!.push("L");
    }
  }
  for (const r of rows.values()) {
    r.gamesPlayed = r.wins + r.losses + r.ties;
    r.winPct = r.gamesPlayed ? (r.wins + r.ties / 2) / r.gamesPlayed : 0;
    r.pointsFor = Math.round(r.pointsFor * 100) / 100;
    r.pointsAgainst = Math.round(r.pointsAgainst * 100) / 100;
    const h = history.get(r.teamId)!;
    if (h.length) {
      const last = h[h.length - 1];
      let n = 0;
      for (let i = h.length - 1; i >= 0 && h[i] === last; i--) n++;
      r.streak = `${last}${n}`;
    }
  }

  const byPct = [...rows.values()].sort((x, y) => y.winPct - x.winPct);
  const ordered: StandingRow[] = [];
  for (let i = 0; i < byPct.length; ) {
    let j = i + 1;
    while (j < byPct.length && Math.abs(byPct[i].winPct - byPct[j].winPct) < 1e-9) j++;
    const group = byPct.slice(i, j);
    ordered.push(...(group.length > 1 ? breakTies(group, games) : group));
    i = j;
  }

  ordered.forEach((r, idx) => (r.rank = idx + 1));
  const lead = ordered[0];
  for (const r of ordered) r.gamesBack = lead ? (lead.wins - lead.losses - (r.wins - r.losses)) / 2 : 0;
  return ordered;
}

function breakTies(group: StandingRow[], games: Game[]): StandingRow[] {
  const ids = new Set(group.map((r) => r.teamId));
  const h2h = new Map<string, { half: number; games: number }>(group.map((r) => [r.teamId, { half: 0, games: 0 }]));
  for (const g of games) {
    if (!ids.has(g.a) || !ids.has(g.b)) continue;
    const a = h2h.get(g.a)!;
    const b = h2h.get(g.b)!;
    a.games++;
    b.games++;
    if (g.result === "tie") {
      a.half++;
      b.half++;
    } else if (g.result === "home") a.half += 2;
    else b.half += 2;
  }
  const h2hPct = (id: string) => {
    const r = h2h.get(id)!;
    return r.games ? r.half / (2 * r.games) : 0.5;
  };
  return [...group].sort(
    (x, y) =>
      h2hPct(y.teamId) - h2hPct(x.teamId) ||
      y.pointsFor - x.pointsFor ||
      x.pointsAgainst - y.pointsAgainst ||
      x.name.toLowerCase().localeCompare(y.name.toLowerCase()) ||
      x.teamId.localeCompare(y.teamId),
  );
}
