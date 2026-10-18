/**
 * Invented NBA source data for the league simulation: 30 teams, ~620 players (never real names), a full
 * 82-game regular-season calendar for 2026-27 (season = 2027) on the real calendar, a lighter finished
 * 2025-26 season so "last season FP" has data, and the per-game box-score generator.
 *
 * In production this data comes from the ESPN sync, so the simulation inserts it directly. Everything
 * is seeded: the same seed always produces the same world.
 */
import { eq } from "drizzle-orm";
import { gameRosterSnapshots, nbaGames, nbaPlayers, nbaTeams, playerGameStats } from "@/db/schema";
import type { Db } from "@/db/types";
import { addDays, etStartOfDay } from "@/lib/nba/dates";
import type { Rng } from "./rng";

export const PREV_SEASON = 2026;
export const SEASON = 2027;
export const NEXT_SEASON = 2028;
export const HOUR = 3_600_000;
export const MINUTE = 60_000;

/** First/last regular-season dates of 2026-27 and the days without games. */
export const OPENING_NIGHT = "2026-10-20";
export const SEASON_LAST_DAY = "2027-04-11";
export const THANKSGIVING = "2026-11-26";
export const CHRISTMAS_EVE = "2026-12-24";
export const ALL_STAR_BREAK = { start: "2027-02-12", end: "2027-02-17" };

const TEAM_PLACES = [
  "Port Alder", "Kestrel Bay", "Mill Harbor", "Stone Ridge", "Aspen Falls", "Cedar Point", "Iron Valley", "Lake Marrow", "Fox Hollow", "Redwater",
  "Silver Plains", "Thorn Creek", "Union Park", "Violet Heights", "West Anchor", "Yarrow Bend", "Zephyr Cove", "Amber Gate", "Birch Landing", "Copper Mesa",
  "Dune Harbor", "Elm Crossing", "Frost Peak", "Gale Island", "Hollow Pine", "Ivory Coast Bay", "Juniper Rock", "Kite Meadow", "Lantern Row", "Maple Reach",
];
const TEAM_NAMES = [
  "Lanterns", "Drifters", "Foundry", "Gulls", "Hammers", "Inkwells", "Jackals", "Kites", "Ledgers", "Mariners",
  "Nettles", "Orchards", "Pylons", "Quills", "Rafters", "Sextants", "Tinkers", "Umbrellas", "Vanguards", "Wardens",
  "Yeomen", "Zeppelins", "Anvils", "Beacons", "Cobblers", "Dredgers", "Embers", "Ferrymen", "Glaziers", "Harriers",
];
const FIRST = ["Marcus", "Devin", "Jalen", "Tyrese", "Malik", "Andre", "Isaiah", "Cole", "Darius", "Elijah", "Gabe", "Hakeem", "Jordan", "Kendall", "Luca", "Miles", "Noah", "Omar", "Peyton", "Quincy", "Rashad", "Shai", "Terrence", "Uri", "Victor", "Wesley", "Xavier", "Yusuf", "Zion", "Caleb", "Bram", "Corin", "Dax", "Emeka", "Finn", "Garrett", "Hollis", "Idris", "Jarek", "Kofi"];
const LAST = ["Alvarez", "Bennett", "Carver", "Dalton", "Ellison", "Foster", "Grady", "Holloway", "Ingram", "Jefferson", "Kincaid", "Lawson", "Monroe", "Newton", "Okafor", "Pruitt", "Quarles", "Rhodes", "Sampson", "Tatum-Reyes", "Underwood", "Vance", "Whitfield", "Yates", "Zimmer", "Abbott", "Briggs", "Coleman", "Duval", "Everett", "Fontaine", "Gilmore", "Hayes", "Iverson-Cole", "Jovanovic", "Kowalski", "Lindqvist", "Mbeki", "Nakamura", "Ortega", "Pellegrino", "Quist", "Radcliffe", "Sorensen", "Thackeray", "Ulloa", "Vandermeer", "Wexler", "Yoon", "Zarate"];
const POSITIONS = [["PG"], ["SG"], ["SF"], ["PF"], ["C"], ["PG", "SG"], ["SG", "SF"], ["SF", "PF"], ["PF", "C"]];

/** Typical minutes by depth on a healthy roster (index = depth). */
const MINUTES_BY_DEPTH = [35, 33, 31, 29, 27, 24, 21, 17, 13, 9, 6, 4, 3];

/** Injury report entry as ESPN may send it: "Out", "OUT", "Out For Season", "Day-To-Day", "Suspension", "Questionable"... */
export type Health = { status: string | null; detail: string | null; untilDate: string | null };

export type SimPlayer = {
  id: number;
  name: string;
  nbaTeamId: number | null;
  /** True fantasy points per game when he plays his usual minutes. */
  q: number;
  /** Last season's quality (null = rookie / no 2025-26 games). */
  prevQ: number | null;
  rookie: boolean;
  active: boolean;
  positions: string[];
  health: Health;
};

export type SimNbaTeam = { id: number; abbrev: string; name: string; location: string; strength: number };

export type SimGame = { id: number; season: number; seasonType: number; startTime: Date; date: string; home: number; away: number };

export type World = {
  teams: SimNbaTeam[];
  players: SimPlayer[];
  byId: Map<number, SimPlayer>;
  /** Games of the 2026-27 regular season in start order. */
  games: SimGame[];
  prevGames: SimGame[];
  nextId: { player: number; game: number };
};

export const healthy = (): Health => ({ status: null, detail: null, untilDate: null });

export function buildWorld(rand: Rng): World {
  const teams: SimNbaTeam[] = TEAM_PLACES.map((place, i) => ({
    id: 9_900_001 + i,
    abbrev: `T${String(i + 1).padStart(2, "0")}`,
    name: TEAM_NAMES[i],
    location: place,
    strength: 0,
  }));

  const usable = teams.length * 20; // 600
  const players: SimPlayer[] = [];
  const usedNames = new Set<string>();
  const nameFor = (i: number) => {
    for (let k = 0; ; k++) {
      const name = `${FIRST[(i * 7 + k * 3) % FIRST.length]} ${LAST[(i * 11 + Math.floor(i / FIRST.length) * 5 + k) % LAST.length]}`;
      if (!usedNames.has(name)) {
        usedNames.add(name);
        return name;
      }
    }
  };

  // Quality curve (fantasy points per game): ~56 for the best down to ~6.
  const base = Array.from({ length: usable }, (_, i) => 6 + 50 * Math.pow(1 - i / usable, 2.3) + rand.normal() * 1.2);
  base.sort((a, b) => b - a);
  const rookieIdx = new Set(rand.shuffle(Array.from({ length: usable - 120 }, (_, i) => i + 90)).slice(0, 30));
  for (let i = 0; i < usable; i++) {
    const rookie = rookieIdx.has(i);
    const q = rookie ? 26 + rand.next() * 22 : base[i]; // breakout rookies are better than their (empty) track record
    const prevQ = rookie ? null : Math.max(3, base[i] + rand.normal() * 4);
    players.push({
      id: 9_800_001 + i,
      name: nameFor(i),
      nbaTeamId: null,
      q: Math.round(q * 10) / 10,
      prevQ: prevQ === null ? null : Math.round(prevQ * 10) / 10,
      rookie,
      active: true,
      positions: POSITIONS[(i * 5 + (i >> 3)) % POSITIONS.length],
      health: healthy(),
    });
  }
  // Deal the players out in tiers of 30: every NBA team gets one player of each tier.
  for (let tier = 0; tier < 20; tier++) {
    const order = rand.shuffle(teams.map((t) => t.id));
    for (let k = 0; k < 30; k++) players[tier * 30 + k].nbaTeamId = order[k];
  }

  // Extras the draft/free agency must handle: retired (inactive) players and players on no NBA team.
  let extra = usable;
  for (let k = 0; k < 8; k++, extra++) {
    players.push({ id: 9_800_001 + extra, name: nameFor(extra), nbaTeamId: teams[k].id, q: 20, prevQ: 20, rookie: false, active: false, positions: ["SF"], health: healthy() });
  }
  for (let k = 0; k < 12; k++, extra++) {
    players.push({ id: 9_800_001 + extra, name: nameFor(extra), nbaTeamId: null, q: 18, prevQ: 18, rookie: false, active: true, positions: ["PG"], health: healthy() });
  }

  // Team strength from its best eight players.
  const sums = teams.map((t) => players.filter((p) => p.nbaTeamId === t.id && p.active).map((p) => p.q).sort((a, b) => b - a).slice(0, 8).reduce((a, b) => a + b, 0));
  const mean = sums.reduce((a, b) => a + b, 0) / sums.length;
  teams.forEach((t, i) => (t.strength = (sums[i] - mean) * 0.1));

  return {
    teams,
    players,
    byId: new Map(players.map((p) => [p.id, p])),
    games: [],
    prevGames: [],
    nextId: { player: 9_800_001 + extra + 100, game: 9_700_001 },
  };
}

export async function insertTeamsAndPlayers(db: Db, world: World) {
  await db.insert(nbaTeams).values(world.teams.map((t) => ({ id: t.id, abbrev: t.abbrev, name: t.name, location: t.location })));
  await chunked(world.players, 200, (rows) =>
    db.insert(nbaPlayers).values(
      rows.map((p) => ({
        id: p.id,
        fullName: p.name,
        firstName: p.name.split(" ")[0],
        lastName: p.name.split(" ").slice(1).join(" "),
        teamId: p.nbaTeamId,
        positions: p.positions,
        active: p.active,
        age: 20 + (p.id % 15),
      })),
    ),
  );
}

export async function chunked<T>(rows: T[], size: number, fn: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

// ------------------------------------------------------------------------------------ calendar

/** Dates with games in 2026-27: opening night to the last day, minus Thanksgiving, Christmas Eve and the All-Star break. */
export function seasonGameDays(): string[] {
  return gameDaysBetween(OPENING_NIGHT, SEASON_LAST_DAY, [THANKSGIVING, CHRISTMAS_EVE], ALL_STAR_BREAK);
}

/** Dates with games in 2027-28 (opening night Tue 2027-10-19 to Sun 2028-04-09). */
export const NEXT_OPENING_NIGHT = "2027-10-19";
export const NEXT_SEASON_LAST_DAY = "2028-04-09";
export const NEXT_ALL_STAR_BREAK = { start: "2028-02-18", end: "2028-02-23" };
export function nextSeasonGameDays(): string[] {
  return gameDaysBetween(NEXT_OPENING_NIGHT, NEXT_SEASON_LAST_DAY, ["2027-11-25", "2027-12-24"], NEXT_ALL_STAR_BREAK);
}

export function gameDaysBetween(first: string, last: string, off: string[], brk: { start: string; end: string }): string[] {
  const out: string[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) {
    if (off.includes(d)) continue;
    if (d >= brk.start && d <= brk.end) continue;
    out.push(d);
  }
  return out;
}

const SLOTS = [19 * 60, 19 * 60 + 30, 19 * 60 + 30, 20 * 60, 21 * 60, 22 * 60, 22 * 60 + 30, 20 * 60 + 30];

/**
 * An 82-game schedule: every day the 2g teams with the fewest games (plus noise) play g games, g = 7 or 8
 * (opening night: 2). Nobody plays twice in a day; game counts end within one or two games of 82.
 */
export function buildSchedule(rand: Rng, teams: SimNbaTeam[], days: string[], season: number, firstId: number, opts: { gamesTotal?: number; opening?: number } = {}): SimGame[] {
  const total = opts.gamesTotal ?? (teams.length * 82) / 2;
  const opening = opts.opening ?? 2;
  const rest = days.length - 1;
  const remaining = total - opening;
  const base = Math.floor(remaining / rest);
  const extraDays = remaining - base * rest; // days with base + 1 games
  const bigDays = new Set(rand.shuffle(Array.from({ length: rest }, (_, i) => i + 1)).slice(0, extraDays));
  const played = new Map(teams.map((t) => [t.id, 0]));
  const games: SimGame[] = [];
  let id = firstId;
  days.forEach((date, di) => {
    const g = di === 0 ? opening : base + (bigDays.has(di) ? 1 : 0);
    const chosen = teams
      .map((t) => ({ id: t.id, key: (played.get(t.id) ?? 0) + rand.next() * 1.6 }))
      .sort((a, b) => a.key - b.key)
      .slice(0, g * 2)
      .map((t) => t.id);
    const order = rand.shuffle(chosen);
    const start = etStartOfDay(date).getTime();
    const slots = [...SLOTS.slice(0, g)].sort((a, b) => a - b);
    for (let k = 0; k < g; k++) {
      const [home, away] = rand.chance(0.5) ? [order[2 * k], order[2 * k + 1]] : [order[2 * k + 1], order[2 * k]];
      played.set(home, (played.get(home) ?? 0) + 1);
      played.set(away, (played.get(away) ?? 0) + 1);
      games.push({ id: id++, season, seasonType: 2, startTime: new Date(start + slots[k] * MINUTE), date, home, away });
    }
  });
  return games;
}

export async function insertScheduledGames(db: Db, games: SimGame[]) {
  await chunked(games, 300, (rows) =>
    db.insert(nbaGames).values(
      rows.map((g) => ({
        id: g.id,
        season: g.season,
        seasonType: g.seasonType,
        startTime: g.startTime,
        homeTeamId: g.home,
        awayTeamId: g.away,
        status: "scheduled" as const,
      })),
    ),
  );
}

// ------------------------------------------------------------------------------------ box scores

export type Line = {
  minutes: number;
  pts: number;
  reb: number;
  oreb: number;
  dreb: number;
  ast: number;
  stl: number;
  blk: number;
  to: number;
  pf: number;
  fgm: number;
  fga: number;
  ftm: number;
  fta: number;
  tpm: number;
  tpa: number;
};

/** A coherent stat line (pts = 2*two-pointers + 3*threes + free throws) worth roughly `fp` fantasy points. */
export function statLine(fp: number, minutes: number, rand: Rng): Line {
  const f = () => 0.6 + rand.next() * 0.8;
  let pts = Math.max(0, Math.round(fp * 0.36 * f()));
  let tpm = Math.round(pts * 0.11 * f());
  let ftm = Math.round(pts * 0.15 * f());
  if (3 * tpm + ftm > pts) {
    tpm = 0;
    ftm = Math.min(ftm, pts);
  }
  const rem = pts - 3 * tpm - ftm;
  const twos = Math.floor(rem / 2);
  ftm += rem - 2 * twos;
  pts = 2 * twos + 3 * tpm + ftm;
  const fgm = twos + tpm;
  const fga = fgm + Math.round(fgm * (0.7 + rand.next() * 0.7));
  const tpa = tpm + Math.round(tpm * (1.2 + rand.next()));
  const fta = ftm + Math.round(ftm * 0.25 + rand.next() * 1.5);
  const reb = Math.round(fp * 0.16 * f());
  const oreb = Math.round(reb * 0.25);
  return {
    minutes,
    pts,
    reb,
    oreb,
    dreb: reb - oreb,
    ast: Math.round(fp * 0.1 * f()),
    stl: rand.chance(Math.min(0.9, fp / 60)) ? 1 + (rand.chance(0.2) ? 1 : 0) : 0,
    blk: rand.chance(Math.min(0.9, fp / 80)) ? 1 + (rand.chance(0.2) ? 1 : 0) : 0,
    to: Math.round(rand.next() * 3),
    pf: Math.round(rand.next() * 4),
    fgm,
    fga: Math.max(fga, fgm),
    ftm,
    fta: Math.max(fta, ftm),
    tpm,
    tpa: Math.max(tpa, tpm),
  };
}

/** Fantasy points of a line under the ESPN defaults (the sim's own copy, used only to rank free agents). */
export function lineFp(l: Pick<Line, "pts" | "reb" | "ast" | "stl" | "blk" | "to" | "fgm" | "fga" | "ftm" | "fta" | "tpm">): number {
  return l.pts + l.reb + 2 * l.ast + 4 * l.stl + 4 * l.blk - 2 * l.to + 2 * l.fgm - l.fga + l.ftm - l.fta + l.tpm;
}

export type PlayerGame = { player: SimPlayer; nbaTeamId: number; line: Line | null; dnp: boolean; dnpReason: string | null };

/** Natural depth (healthy roster) of a player on his team, used to scale minutes. */
function naturalMinutes(team: SimPlayer[], p: SimPlayer): number {
  const depth = [...team].sort((a, b) => b.q - a.q).findIndex((x) => x.id === p.id);
  return MINUTES_BY_DEPTH[Math.min(depth, MINUTES_BY_DEPTH.length - 1)] ?? 3;
}

/**
 * Plans one team's box score for a game from the world state at tip-off. Healthy rotation players play, the
 * next man up gets their minutes, "Out" players mostly produce a dnp row, Day-To-Day players play 60% of the
 * time, and the end of the bench is a coach's decision.
 */
export function planTeamGame(rand: Rng, players: SimPlayer[], nbaTeamId: number, scoreFactor: number): PlayerGame[] {
  const roster = players.filter((p) => p.active && p.nbaTeamId === nbaTeamId);
  const out: PlayerGame[] = [];
  const avail: SimPlayer[] = [];
  for (const p of roster) {
    const st = (p.health.status ?? "").trim().toLowerCase();
    if (/^out\b/.test(st)) {
      if (rand.chance(0.7)) out.push({ player: p, nbaTeamId, line: null, dnp: true, dnpReason: `Injury: ${p.health.detail ?? "Out"}` });
    } else if (st === "suspension") {
      out.push({ player: p, nbaTeamId, line: null, dnp: true, dnpReason: "Suspension" });
    } else if ((st === "day-to-day" && !rand.chance(0.6)) || (st === "questionable" && !rand.chance(0.8)) || (st === "doubtful" && !rand.chance(0.3))) {
      out.push({ player: p, nbaTeamId, line: null, dnp: true, dnpReason: `Injury: ${p.health.detail ?? st}` });
    } else avail.push(p);
  }
  avail.sort((a, b) => b.q - a.q);
  avail.forEach((p, depth) => {
    if (depth >= 13) {
      if (rand.chance(0.3)) out.push({ player: p, nbaTeamId, line: null, dnp: true, dnpReason: "Coach's decision" });
      return;
    }
    if (depth >= 10 && rand.chance(0.5)) {
      out.push({ player: p, nbaTeamId, line: null, dnp: true, dnpReason: "Coach's decision" });
      return;
    }
    const minutes = Math.max(1, Math.round(MINUTES_BY_DEPTH[depth] + rand.normal() * 3));
    const per = p.q / naturalMinutes(roster, p);
    const fp = per * minutes * (0.45 + rand.next() * 1.1) * scoreFactor;
    out.push({ player: p, nbaTeamId, line: statLine(fp, minutes, rand), dnp: false, dnpReason: null });
  });
  return out;
}

export function statRow(gameId: number, pg: PlayerGame, scale = 1): typeof playerGameStats.$inferInsert {
  if (pg.dnp || !pg.line) {
    return { gameId, playerId: pg.player.id, teamId: pg.nbaTeamId, minutes: 0, dnp: true, dnpReason: pg.dnpReason };
  }
  const s = (n: number) => (scale === 1 ? n : Math.floor(n * scale));
  const l = pg.line;
  const fgm = s(l.fgm);
  const tpm = Math.min(s(l.tpm), fgm);
  const ftm = s(l.ftm);
  return {
    gameId,
    playerId: pg.player.id,
    teamId: pg.nbaTeamId,
    minutes: s(l.minutes),
    pts: scale === 1 ? l.pts : 2 * (fgm - tpm) + 3 * tpm + ftm,
    reb: s(l.reb),
    oreb: Math.min(s(l.oreb), s(l.reb)),
    dreb: Math.max(0, s(l.reb) - Math.min(s(l.oreb), s(l.reb))),
    ast: s(l.ast),
    stl: s(l.stl),
    blk: s(l.blk),
    to: s(l.to),
    pf: s(l.pf),
    fgm,
    fga: Math.max(s(l.fga), fgm),
    ftm,
    fta: Math.max(s(l.fta), ftm),
    tpm,
    tpa: Math.max(s(l.tpa), tpm),
    dnp: false,
  };
}

/** Final score from team strengths (home edge, noise). Never a tie. */
export function finalScore(rand: Rng, home: SimNbaTeam, away: SimNbaTeam): { home: number; away: number } {
  const margin = Math.round(home.strength - away.strength + 2.5 + rand.normal() * 8);
  const total = 214 + Math.round(rand.normal() * 10);
  const m = margin === 0 ? (rand.chance(0.5) ? 1 : -1) : margin;
  const h = Math.round((total + m) / 2);
  return { home: h, away: h - m };
}

// ------------------------------------------------------------------------------- previous season

/**
 * A finished 2025-26 season subset: 34 game days (all 30 teams play each day) between January and mid-April
 * 2026, with full box scores and tip-off snapshots, written directly (it is history).
 */
export async function insertPreviousSeason(db: Db, world: World, rand: Rng): Promise<number> {
  const rows: (typeof nbaGames.$inferInsert)[] = [];
  const stats: (typeof playerGameStats.$inferInsert)[] = [];
  const snaps: (typeof gameRosterSnapshots.$inferInsert)[] = [];
  const teamIds = world.teams.map((t) => t.id);
  const teamOf = new Map(world.teams.map((t) => [t.id, t]));
  // Last season's world: rookies did not exist; everyone else played at last season's quality.
  const prevPlayers = world.players
    .filter((p) => p.active && p.nbaTeamId !== null && p.prevQ !== null)
    .map((p) => ({ ...p, q: p.prevQ! }));
  const dayList = Array.from({ length: 34 }, (_, k) => addDays("2026-01-27", k * 2));
  let id = 9_600_001;
  for (const date of dayList) {
    const day = etStartOfDay(date).getTime();
    const order = rand.shuffle(teamIds);
    for (let k = 0; k + 1 < order.length; k += 2) {
      const [home, away] = [order[k], order[k + 1]];
      const start = new Date(day + (19 * 60 + (k % 4) * 30) * MINUTE);
      const score = finalScore(rand, teamOf.get(home)!, teamOf.get(away)!);
      const gid = id++;
      world.prevGames.push({ id: gid, season: PREV_SEASON, seasonType: 2, startTime: start, date, home, away });
      rows.push({
        id: gid,
        season: PREV_SEASON,
        seasonType: 2,
        startTime: start,
        homeTeamId: home,
        awayTeamId: away,
        homeScore: score.home,
        awayScore: score.away,
        status: "final",
        statusDetail: "Final",
        finishedAt: new Date(start.getTime() + 150 * MINUTE),
        statsFinal: true,
      });
      for (const nbaTeam of [home, away]) {
        for (const pg of planTeamGame(rand, prevPlayers, nbaTeam, 1)) {
          snaps.push({ gameId: gid, playerId: pg.player.id, nbaTeamId: nbaTeam, injuryStatus: null, late: false, capturedAt: start });
          stats.push(statRow(gid, pg));
        }
      }
    }
  }
  await chunked(rows, 300, (c) => db.insert(nbaGames).values(c));
  await chunked(snaps, 1500, (c) => db.insert(gameRosterSnapshots).values(c));
  await chunked(stats, 300, (c) => db.insert(playerGameStats).values(c));
  return rows.length;
}

/** Marks a game postponed (no scores, no snapshot). */
export async function postponeGame(db: Db, gameId: number) {
  await db.update(nbaGames).set({ status: "postponed", statusDetail: "Postponed" }).where(eq(nbaGames.id, gameId));
}

export async function setHealth(db: Db, p: SimPlayer, h: Health) {
  p.health = h;
  await db
    .update(nbaPlayers)
    .set({ injuryStatus: h.status, injuryDetail: h.detail, injuryUpdatedAt: new Date() })
    .where(eq(nbaPlayers.id, p.id));
}
