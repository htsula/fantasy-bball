/**
 * Pure normalizers: raw ESPN JSON in, our row shapes out. No I/O, so they are unit-tested
 * against saved fixtures. Every normalizer accepts `unknown`, validates loosely, and skips
 * (rather than throws on) entries missing the fields we cannot do without.
 */
import type { GameStatus } from "@/db/schema";
import { seasonYearFor } from "./dates";
import {
  type RawRoster,
  injuriesResponseSchema,
  newsResponseSchema,
  parseLoose,
  rosterResponseSchema,
  scoreboardResponseSchema,
  summaryResponseSchema,
  teamsResponseSchema,
} from "./espn-schemas";
import { mapPosition } from "./positions";

export type TeamRow = {
  id: number;
  abbrev: string;
  name: string;
  location: string;
  logo: string | null;
  color: string | null;
};

export type PlayerRow = {
  id: number;
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  teamId: number | null;
  positions: string[];
  espnPosition: string | null;
  jersey: string | null;
  headshotUrl: string | null;
  heightInches: number | null;
  weightLbs: number | null;
  age: number | null;
  birthDate: string | null;
  experienceYears: number | null;
  active: boolean;
};

export type GameRow = {
  id: number;
  season: number;
  seasonType: number;
  startTime: Date;
  homeTeamId: number;
  awayTeamId: number;
  homeScore: number | null;
  awayScore: number | null;
  status: GameStatus;
  statusDetail: string | null;
  period: number | null;
  clock: string | null;
};

export type StatRow = {
  gameId: number;
  playerId: number;
  teamId: number;
  minutes: number | null;
  fgm: number;
  fga: number;
  ftm: number;
  fta: number;
  tpm: number;
  tpa: number;
  reb: number;
  oreb: number;
  dreb: number;
  ast: number;
  stl: number;
  blk: number;
  to: number;
  pf: number;
  pts: number;
  dnp: boolean;
  dnpReason: string | null;
};

export type InjuryRow = {
  playerId: number;
  teamId: number | null;
  status: string;
  detail: string | null;
  shortComment: string | null;
  longComment: string | null;
  date: Date | null;
};

export type NewsRow = {
  id: string;
  headline: string;
  description: string | null;
  published: Date;
  link: string | null;
  image: string | null;
  relatedPlayerIds: number[];
  relatedTeamIds: number[];
};

// ---------------------------------------------------------------------------------------------
// primitives

/** Integer from a number or numeric string ("12", "12.0"); null when absent or not numeric. */
export function toInt(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v) : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  return null;
}

function toDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "11-22" -> [11, 22]; anything unparseable -> [0, 0]. */
export function splitMadeAttempted(v: string | undefined): [number, number] {
  const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(v ?? "");
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

/** "34" or "34:12" -> whole minutes; "--"/empty -> null. */
export function parseMinutes(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^(\d+)(?::(\d{1,2}))?$/.exec(v.trim());
  if (!m) return null;
  return Number(m[1]) + (m[2] && Number(m[2]) >= 30 ? 1 : 0);
}

/** Maps ESPN's status object onto our four statuses. */
export function mapGameStatus(type: { name?: string; state?: string; completed?: boolean } | undefined): GameStatus {
  const name = (type?.name ?? "").toUpperCase();
  if (name.includes("POSTPONED") || name.includes("CANCELED") || name.includes("CANCELLED")) return "postponed";
  if (type?.state === "post" || type?.completed || name.startsWith("STATUS_FINAL")) return "final";
  if (type?.state === "in" || name === "STATUS_IN_PROGRESS" || name === "STATUS_HALFTIME" || name === "STATUS_END_PERIOD")
    return "in";
  return "scheduled";
}

type RawTeam = {
  id?: string | number;
  abbreviation?: string;
  displayName?: string;
  name?: string;
  location?: string;
  color?: string;
  logo?: string;
  logos?: { href?: string }[];
};

function teamRow(t: RawTeam | undefined): TeamRow | null {
  const id = toInt(t?.id);
  if (id === null || !t?.abbreviation) return null;
  return {
    id,
    abbrev: t.abbreviation,
    name: t.name ?? t.displayName ?? t.abbreviation,
    location: t.location ?? "",
    logo: t.logo ?? t.logos?.[0]?.href ?? null,
    color: t.color ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// teams / roster

export function normalizeTeams(raw: unknown): TeamRow[] {
  const data = parseLoose(teamsResponseSchema, raw, "teams");
  const out: TeamRow[] = [];
  for (const sport of data.sports ?? [])
    for (const league of sport.leagues ?? [])
      for (const entry of league.teams ?? []) {
        const row = teamRow(entry.team);
        if (row) out.push(row);
      }
  return out;
}

type RawAthlete = NonNullable<RawRoster["athletes"]>[number];

function flatAthletes(data: RawRoster): RawAthlete[] {
  const out: RawAthlete[] = [];
  for (const a of data.athletes ?? []) {
    if (a.items) out.push(...a.items);
    else out.push(a);
  }
  return out;
}

function athleteToPlayer(a: RawAthlete, teamId: number | null): PlayerRow | null {
  const id = toInt(a.id);
  const fullName = a.fullName ?? a.displayName ?? [a.firstName, a.lastName].filter(Boolean).join(" ");
  if (id === null || !fullName) return null;
  const pos = a.position?.abbreviation ?? null;
  return {
    id,
    fullName,
    firstName: a.firstName ?? null,
    lastName: a.lastName ?? null,
    teamId,
    positions: mapPosition(pos),
    espnPosition: pos,
    jersey: a.jersey ?? null,
    headshotUrl: a.headshot?.href ?? null,
    heightInches: toInt(a.height),
    weightLbs: toInt(a.weight),
    age: toInt(a.age),
    birthDate: a.dateOfBirth ? a.dateOfBirth.slice(0, 10) : null,
    experienceYears: toInt(a.experience?.years),
    active: a.status?.type ? a.status.type === "active" : true,
  };
}

export function normalizeRoster(raw: unknown): { team: TeamRow | null; players: PlayerRow[] } {
  const data = parseLoose(rosterResponseSchema, raw, "roster");
  const team = teamRow(data.team);
  const players: PlayerRow[] = [];
  for (const a of flatAthletes(data)) {
    const row = athleteToPlayer(a, team?.id ?? null);
    if (row) players.push(row);
  }
  return { team, players };
}

// ---------------------------------------------------------------------------------------------
// scoreboard

type RawCompetition = {
  competitors?: { homeAway?: string; score?: string | number; team?: RawTeam }[];
  status?: { clock?: string | number; displayClock?: string; period?: string | number; type?: Parameters<typeof mapGameStatus>[0] & { detail?: string; shortDetail?: string } };
};

function gameFields(comp: RawCompetition | undefined, fallbackStatus?: RawCompetition["status"]) {
  const status = comp?.status ?? fallbackStatus;
  const home = comp?.competitors?.find((c) => c.homeAway === "home");
  const away = comp?.competitors?.find((c) => c.homeAway === "away");
  const mapped = mapGameStatus(status?.type);
  const period = toInt(status?.period);
  const hasScore = mapped !== "scheduled" && mapped !== "postponed";
  return {
    homeTeamId: toInt(home?.team?.id),
    awayTeamId: toInt(away?.team?.id),
    homeScore: hasScore ? toInt(home?.score) : null,
    awayScore: hasScore ? toInt(away?.score) : null,
    status: mapped,
    statusDetail: status?.type?.shortDetail ?? status?.type?.detail ?? null,
    period: mapped === "scheduled" ? null : period,
    clock: mapped === "in" ? (status?.displayClock ?? null) : null,
  };
}

export function normalizeScoreboard(raw: unknown): { games: GameRow[]; teams: TeamRow[] } {
  const data = parseLoose(scoreboardResponseSchema, raw, "scoreboard");
  const games: GameRow[] = [];
  const teams = new Map<number, TeamRow>();
  for (const ev of data.events ?? []) {
    const id = toInt(ev.id);
    const comp = ev.competitions?.[0];
    const start = toDate(comp?.date ?? ev.date);
    const f = gameFields(comp, ev.status);
    if (id === null || !start || f.homeTeamId === null || f.awayTeamId === null) continue;
    for (const c of comp?.competitors ?? []) {
      const t = teamRow(c.team);
      if (t) teams.set(t.id, t);
    }
    games.push({
      id,
      season: toInt(ev.season?.year) ?? seasonYearFor(start),
      seasonType: toInt(ev.season?.type) ?? 2,
      startTime: start,
      ...f,
      homeTeamId: f.homeTeamId,
      awayTeamId: f.awayTeamId,
    });
  }
  return { games, teams: [...teams.values()] };
}

// ---------------------------------------------------------------------------------------------
// box score

export type BoxscoreGame = {
  id: number;
  status: GameStatus;
  statusDetail: string | null;
  period: number | null;
  clock: string | null;
  homeScore: number | null;
  awayScore: number | null;
};


/**
 * Box score -> per-player stat rows (parsed by label, never by fixed position), placeholder
 * player rows for athletes we have not seen on a roster, and the game's live header.
 */
export function normalizeBoxscore(raw: unknown): { game: BoxscoreGame | null; players: PlayerRow[]; stats: StatRow[] } {
  const data = parseLoose(summaryResponseSchema, raw, "summary");
  const gameId = toInt(data.header?.id);
  const comp = data.header?.competitions?.[0];
  let game: BoxscoreGame | null = null;
  if (gameId !== null && comp) {
    const f = gameFields(comp);
    game = {
      id: gameId,
      status: f.status,
      statusDetail: f.statusDetail,
      period: f.period,
      clock: f.clock,
      homeScore: f.homeScore,
      awayScore: f.awayScore,
    };
  }

  const players = new Map<number, PlayerRow>();
  const stats: StatRow[] = [];
  if (gameId === null) return { game, players: [], stats };

  for (const block of data.boxscore?.players ?? []) {
    const teamId = toInt(block.team?.id);
    if (teamId === null) continue;
    for (const group of block.statistics ?? []) {
      const idx = new Map<string, number>();
      (group.labels ?? []).forEach((l, i) => idx.set(l.toUpperCase(), i));
      if (!idx.has("PTS") && !idx.has("MIN")) continue; // not a stat table we understand
      for (const entry of group.athletes ?? []) {
        const a = entry.athlete;
        const playerId = toInt(a?.id);
        if (!a || playerId === null) continue;
        const cell = (label: string) => {
          const i = idx.get(label);
          return i === undefined ? undefined : entry.stats?.[i];
        };
        const num = (label: string) => toInt(cell(label)) ?? 0;
        const [fgm, fga] = splitMadeAttempted(cell("FG"));
        const [tpm, tpa] = splitMadeAttempted(cell("3PT"));
        const [ftm, fta] = splitMadeAttempted(cell("FT"));
        const minutes = parseMinutes(cell("MIN"));
        const line = {
          fgm, fga, ftm, fta, tpm, tpa,
          reb: num("REB"), oreb: num("OREB"), dreb: num("DREB"),
          ast: num("AST"), stl: num("STL"), blk: num("BLK"),
          to: num("TO"), pf: num("PF"), pts: num("PTS"),
        };
        const noStats = !entry.stats || entry.stats.length === 0;
        const allZero = Object.values(line).every((v) => v === 0);
        const dnp = Boolean(entry.didNotPlay) || noStats || (minutes === 0 && allZero);
        stats.push({
          gameId,
          playerId,
          teamId,
          minutes: dnp ? null : minutes,
          ...(dnp ? { ...line, fgm: 0, fga: 0, ftm: 0, fta: 0, tpm: 0, tpa: 0, reb: 0, oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, to: 0, pf: 0, pts: 0 } : line),
          dnp,
          dnpReason: dnp ? (entry.reason ?? null) : null,
        });
        const row = athleteToPlayer(a, teamId);
        if (row) players.set(row.id, { ...row, active: true });
      }
    }
  }
  return { game, players: [...players.values()], stats };
}

// ---------------------------------------------------------------------------------------------
// injuries / news

export function normalizeInjuries(raw: unknown): InjuryRow[] {
  const data = parseLoose(injuriesResponseSchema, raw, "injuries");
  const out = new Map<number, InjuryRow>();
  for (const team of data.injuries ?? []) {
    const teamId = toInt(team.id);
    for (const inj of team.injuries ?? []) {
      const href = inj.athlete?.links?.find((l) => l.href?.includes("/id/"))?.href;
      const playerId = toInt(inj.athlete?.id) ?? toInt(/\/id\/(\d+)/.exec(href ?? "")?.[1]);
      if (playerId === null || !inj.status) continue;
      const detail = [inj.details?.type, inj.details?.detail].filter(Boolean).join(" - ");
      out.set(playerId, {
        playerId,
        teamId,
        status: inj.status.trim(),
        detail: detail || null,
        shortComment: inj.shortComment ?? null,
        longComment: inj.longComment ?? null,
        date: toDate(inj.date),
      });
    }
  }
  return [...out.values()];
}

export function normalizeNews(raw: unknown): NewsRow[] {
  const data = parseLoose(newsResponseSchema, raw, "news");
  const out: NewsRow[] = [];
  for (const a of data.articles ?? []) {
    const published = toDate(a.published);
    if (a.id === undefined || !a.headline || !published) continue;
    const cats = a.categories ?? [];
    const ids = (type: string, key: "athleteId" | "teamId") => {
      const set = new Set<number>();
      for (const c of cats) {
        const n = c.type === type ? toInt(c[key]) : null;
        if (n !== null) set.add(n);
      }
      return [...set];
    };
    out.push({
      id: String(a.id),
      headline: a.headline,
      description: a.description ?? null,
      published,
      link: a.links?.web?.href ?? null,
      image: a.images?.[0]?.url ?? null,
      relatedPlayerIds: ids("athlete", "athleteId"),
      relatedTeamIds: ids("team", "teamId"),
    });
  }
  return out;
}
