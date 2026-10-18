/**
 * Independent scoring oracle for the league simulation. It recomputes fantasy totals and standings from raw
 * rows (roster entries, games, snapshots, box scores, adjustments) with its own small code, deliberately NOT
 * sharing anything with src/lib/fantasy/* or src/lib/matchups/*, so a bug in the app's SQL joins or
 * tiebreaks can't hide behind the same bug in the check.
 *
 * Rules implemented (from the product spec):
 *  - a game's points belong to the fantasy team that had the player on its roster at the game's tip-off
 *    (acquired_at <= start < released_at);
 *  - points = sum(stat x league value) for the player's box-score row (dnp rows score nothing);
 *  - +4 for every player in the game's tip-off snapshot whose NBA team won, unless his snapshot status is Out;
 *  - live games (status "in") count their stats but no win bonus;
 *  - commissioner adjustments are added to the matchup total.
 */
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import {
  gameRosterSnapshots,
  matchupAdjustments,
  nbaGames,
  playerGameStats,
  rosterEntries,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { addDays, etStartOfDay } from "@/lib/nba/dates";

export const ORACLE_VALUES = { pts: 1, reb: 1, ast: 2, stl: 4, blk: 4, to: -2, fgm: 2, fga: -1, ftm: 1, fta: -1, tpm: 1, teamWin: 4 } as const;

type OGame = { id: number; start: number; status: string; home: number; away: number; hs: number | null; as: number | null };
type OEntry = { teamId: string; playerId: number; from: number; to: number | null };
type OStat = { dnp: boolean; teamId: number; pts: number; reb: number; ast: number; stl: number; blk: number; to: number; fgm: number; fga: number; ftm: number; fta: number; tpm: number };

export type OracleData = {
  games: OGame[];
  snaps: Map<string, { nbaTeamId: number; status: string | null }>;
  stats: Map<string, OStat>;
  entries: OEntry[];
  adjustments: { matchupId: string; teamId: string; points: number }[];
};

const key = (gameId: number, playerId: number) => `${gameId}:${playerId}`;

/** Loads every row the oracle needs for games that tipped off between two ET dates (inclusive). */
export async function loadOracleData(db: Db, leagueId: string, fromDate: string, toDate: string): Promise<OracleData> {
  const from = etStartOfDay(fromDate);
  const to = etStartOfDay(addDays(toDate, 1));
  const games = await db
    .select()
    .from(nbaGames)
    .where(and(gte(nbaGames.startTime, from), lt(nbaGames.startTime, to), inArray(nbaGames.status, ["in", "final"])));
  const ids = games.map((g) => g.id);
  const snaps = new Map<string, { nbaTeamId: number; status: string | null }>();
  const stats = new Map<string, OStat>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    for (const s of await db.select().from(gameRosterSnapshots).where(inArray(gameRosterSnapshots.gameId, chunk))) {
      snaps.set(key(s.gameId, s.playerId), { nbaTeamId: s.nbaTeamId, status: s.injuryStatus });
    }
    for (const s of await db.select().from(playerGameStats).where(inArray(playerGameStats.gameId, chunk))) {
      stats.set(key(s.gameId, s.playerId), s);
    }
  }
  const entries = (await db.select().from(rosterEntries).where(eq(rosterEntries.leagueId, leagueId))).map((e) => ({
    teamId: e.teamId,
    playerId: e.playerId,
    from: e.acquiredAt.getTime(),
    to: e.releasedAt ? e.releasedAt.getTime() : null,
  }));
  const adjustments = await db
    .select({ matchupId: matchupAdjustments.matchupId, teamId: matchupAdjustments.teamId, points: matchupAdjustments.points })
    .from(matchupAdjustments)
    .where(eq(matchupAdjustments.leagueId, leagueId));
  return {
    games: games.map((g) => ({ id: g.id, start: g.startTime.getTime(), status: g.status, home: g.homeTeamId, away: g.awayTeamId, hs: g.homeScore, as: g.awayScore })),
    snaps,
    stats,
    entries,
    adjustments,
  };
}

export type OracleTeamTotal = { points: number; winBonus: number; rows: number };

/** Total for one fantasy team over the loaded games (adjustments NOT included). */
export function oracleTeamTotal(data: OracleData, teamId: string): OracleTeamTotal {
  const mine = data.entries.filter((e) => e.teamId === teamId);
  let points = 0;
  let winBonus = 0;
  let rows = 0;
  for (const g of data.games) {
    for (const e of mine) {
      if (!(e.from <= g.start && (e.to === null || e.to > g.start))) continue;
      const snap = data.snaps.get(key(g.id, e.playerId));
      const st = data.stats.get(key(g.id, e.playerId));
      if (!snap && !st) continue;
      rows++;
      if (st && !st.dnp) {
        const v = ORACLE_VALUES;
        points += st.pts * v.pts + st.reb * v.reb + st.ast * v.ast + st.stl * v.stl + st.blk * v.blk + st.to * v.to + st.fgm * v.fgm + st.fga * v.fga + st.ftm * v.ftm + st.fta * v.fta + st.tpm * v.tpm;
      }
      if (snap && g.status === "final" && g.hs !== null && g.as !== null) {
        const side = snap.nbaTeamId === g.home ? "home" : "away";
        const won = side === "home" ? g.hs > g.as : g.as > g.hs;
        const out = /^out\b/i.test((snap.status ?? "").trim());
        if (won && !out) {
          points += ORACLE_VALUES.teamWin;
          winBonus += ORACLE_VALUES.teamWin;
        }
      }
    }
  }
  return { points, winBonus, rows };
}

export const adjustmentFor = (data: OracleData, matchupId: string, teamId: string) =>
  data.adjustments.filter((a) => a.matchupId === matchupId && a.teamId === teamId).reduce((s, a) => s + a.points, 0);

// ------------------------------------------------------------------------------------ standings

export type OracleGame = { period: number; home: string; away: string; hp: number; ap: number };
export type OracleRow = { teamId: string; name: string; w: number; l: number; t: number; pf: number; pa: number; rank: number; streak: string; gamesBack: number };

const cents = (n: number) => Math.round(n * 100);

/** W-L-T and the documented tiebreaks: win % (tie = half), head-to-head inside the tied group, PF, PA (low), name. */
export function oracleStandings(teams: { id: string; name: string }[], games: OracleGame[]): OracleRow[] {
  const rows = new Map<string, OracleRow>(teams.map((t) => [t.id, { teamId: t.id, name: t.name, w: 0, l: 0, t: 0, pf: 0, pa: 0, rank: 0, streak: "", gamesBack: 0 }]));
  const seq = new Map<string, string[]>(teams.map((t) => [t.id, []]));
  for (const g of [...games].sort((x, y) => x.period - y.period)) {
    const h = rows.get(g.home)!;
    const a = rows.get(g.away)!;
    h.pf += g.hp;
    h.pa += g.ap;
    a.pf += g.ap;
    a.pa += g.hp;
    if (cents(g.hp) === cents(g.ap)) {
      h.t++;
      a.t++;
      seq.get(g.home)!.push("T");
      seq.get(g.away)!.push("T");
    } else if (cents(g.hp) > cents(g.ap)) {
      h.w++;
      a.l++;
      seq.get(g.home)!.push("W");
      seq.get(g.away)!.push("L");
    } else {
      a.w++;
      h.l++;
      seq.get(g.home)!.push("L");
      seq.get(g.away)!.push("W");
    }
  }
  for (const [id, results] of seq) {
    if (!results.length) continue;
    const last = results[results.length - 1];
    let n = 0;
    for (let i = results.length - 1; i >= 0 && results[i] === last; i--) n++;
    rows.get(id)!.streak = `${last}${n}`;
  }
  const pct = (r: OracleRow) => (r.w + r.t / 2) / Math.max(1, r.w + r.l + r.t);
  const sorted = [...rows.values()].sort((x, y) => pct(y) - pct(x));
  const out: OracleRow[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i + 1;
    while (j < sorted.length && Math.abs(pct(sorted[j]) - pct(sorted[i])) < 1e-9) j++;
    const group = sorted.slice(i, j);
    if (group.length > 1) {
      const ids = new Set(group.map((r) => r.teamId));
      const half = new Map<string, number>(group.map((r) => [r.teamId, 0]));
      const played = new Map<string, number>(group.map((r) => [r.teamId, 0]));
      for (const g of games) {
        if (!ids.has(g.home) || !ids.has(g.away)) continue;
        played.set(g.home, played.get(g.home)! + 1);
        played.set(g.away, played.get(g.away)! + 1);
        if (cents(g.hp) === cents(g.ap)) {
          half.set(g.home, half.get(g.home)! + 1);
          half.set(g.away, half.get(g.away)! + 1);
        } else if (cents(g.hp) > cents(g.ap)) half.set(g.home, half.get(g.home)! + 2);
        else half.set(g.away, half.get(g.away)! + 2);
      }
      const h2h = (id: string) => (played.get(id)! ? half.get(id)! / (2 * played.get(id)!) : 0.5);
      group.sort((x, y) => h2h(y.teamId) - h2h(x.teamId) || cents(y.pf) - cents(x.pf) || cents(x.pa) - cents(y.pa) || x.name.toLowerCase().localeCompare(y.name.toLowerCase()) || x.teamId.localeCompare(y.teamId));
    }
    out.push(...group);
    i = j;
  }
  out.forEach((r, idx) => (r.rank = idx + 1));
  for (const r of out) r.gamesBack = out.length ? (out[0].w - out[0].l - (r.w - r.l)) / 2 : 0;
  return out;
}
