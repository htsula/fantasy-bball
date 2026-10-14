/**
 * League domain logic. Every function takes `db` explicitly (tests pass PGlite). Actors are the
 * already-authenticated user ({ id, isSiteAdmin }); authorization is enforced here, never only in
 * the UI, because server actions are public endpoints.
 */
import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import {
  inviteRedemptions,
  invites,
  leagues,
  matchupPeriods,
  matchups,
  nbaGames,
  teams,
  users,
  type League,
  type MatchupPeriod,
  type Team,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { logActivity } from "@/lib/activity/service";
import { AuthError, createUser, findUserByUsername } from "@/lib/auth/service";
import { generateToken, hashToken } from "@/lib/auth/tokens";
import { keepersRoom } from "@/lib/fantasy/roster-size";
import { buildMatchupPeriods, roundRobin } from "@/lib/fantasy/schedule";
import {
  DRAFT_LOCKED_FIELDS,
  defaultSettings,
  leagueNameSchema,
  leagueSettingsSchema,
  parseStoredSettings,
  seasonSchema,
  teamAbbrevSchema,
  teamNameSchema,
  zodFieldErrors,
  type LeagueSettings,
} from "@/lib/fantasy/settings";
import { etDateString } from "@/lib/nba/dates";
import { notifier, type Notifier } from "@/lib/notifications/service";
import { z } from "zod";

export type Actor = { id: string; isSiteAdmin: boolean };

export type LeagueErrorCode =
  | "not_found"
  | "forbidden"
  | "invalid_input"
  | "settings_locked"
  | "name_taken"
  | "abbrev_taken"
  | "already_on_team"
  | "invalid_invite"
  | "invite_revoked"
  | "invite_full"
  | "wrong_status"
  | "dates_required"
  | "not_enough_teams"
  | "playoff_teams_exceed_teams"
  | "season_too_short"
  | "cannot_remove_commissioner"
  | "user_not_found"
  | "same_owner"
  | "cannot_transfer_commissioner_team"
  | "already_commissioner";

const MESSAGES: Record<LeagueErrorCode, string> = {
  not_found: "League not found.",
  forbidden: "You don't have permission to do that.",
  invalid_input: "Please fix the highlighted fields.",
  settings_locked: "These settings are locked once the draft has started.",
  name_taken: "Another team in this league already uses that name.",
  abbrev_taken: "Another team in this league already uses that abbreviation.",
  already_on_team: "You already have a team in this league.",
  invalid_invite: "This invite link is no longer valid.",
  invite_revoked: "This invite link was turned off by the commissioner.",
  invite_full: "This invite link has reached its maximum number of teams.",
  wrong_status: "That isn't possible once the league has left setup.",
  dates_required: "Set the regular season start and end dates in settings first (the NBA schedule isn't loaded for this season).",
  not_enough_teams: "At least 2 teams are needed to build a schedule.",
  playoff_teams_exceed_teams: "Playoff teams can't exceed the number of teams. Lower it in settings or add teams.",
  season_too_short: "The season is too short for this many playoff rounds.",
  cannot_remove_commissioner: "The commissioner's team can't be removed.",
  user_not_found: "No user with that username exists.",
  same_owner: "That user already owns this team.",
  cannot_transfer_commissioner_team: "The commissioner's own team can't be given away. Transfer the commissioner role first.",
  already_commissioner: "That person is already the commissioner.",
};

export class LeagueError extends Error {
  constructor(
    public code: LeagueErrorCode,
    public fieldErrors?: Record<string, string[]>,
    message?: string,
  ) {
    super(message ?? MESSAGES[code]);
  }
}

const uuidSchema = z.string().uuid();

function constraintOf(err: unknown): string {
  const e = err as { constraint?: string; message?: string; cause?: { constraint?: string; message?: string } };
  return `${e?.constraint ?? e?.cause?.constraint ?? ""} ${e?.message ?? ""} ${e?.cause?.message ?? ""}`;
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/** Maps a teams unique-index violation to a friendly error (races past the pre-checks). */
function rethrowTeamConflict(err: unknown): never {
  if (isUniqueViolation(err)) {
    const c = constraintOf(err);
    if (c.includes("teams_league_name_lower_idx")) throw new LeagueError("name_taken", { teamName: [MESSAGES.name_taken] });
    if (c.includes("teams_league_abbrev_upper_idx")) throw new LeagueError("abbrev_taken", { teamAbbrev: [MESSAGES.abbrev_taken] });
    if (c.includes("teams_league_owner_idx")) throw new LeagueError("already_on_team");
  }
  throw err;
}

function parseTeamInput(input: { name: string; abbrev: string }) {
  const name = teamNameSchema.safeParse(input.name);
  const abbrev = teamAbbrevSchema.safeParse(input.abbrev);
  if (!name.success || !abbrev.success) {
    throw new LeagueError("invalid_input", {
      ...(name.success ? {} : { teamName: name.error.issues.map((i) => i.message) }),
      ...(abbrev.success ? {} : { teamAbbrev: abbrev.error.issues.map((i) => i.message) }),
    });
  }
  return { name: name.data, abbrev: abbrev.data };
}

async function assertTeamFree(db: Db, leagueId: string, name: string, abbrev: string, excludeTeamId?: string) {
  const rows = await db
    .select({ id: teams.id, name: teams.name, abbrev: teams.abbrev })
    .from(teams)
    .where(
      and(
        eq(teams.leagueId, leagueId),
        sql`(lower(${teams.name}) = ${name.toLowerCase()} or upper(${teams.abbrev}) = ${abbrev.toUpperCase()})`,
      ),
    );
  for (const r of rows) {
    if (r.id === excludeTeamId) continue;
    if (r.name.toLowerCase() === name.toLowerCase()) throw new LeagueError("name_taken", { teamName: [MESSAGES.name_taken] });
    if (r.abbrev.toUpperCase() === abbrev.toUpperCase())
      throw new LeagueError("abbrev_taken", { teamAbbrev: [MESSAGES.abbrev_taken] });
  }
}

async function loadLeague(db: Db, leagueId: string): Promise<League> {
  if (!uuidSchema.safeParse(leagueId).success) throw new LeagueError("not_found");
  const [league] = await db.select().from(leagues).where(eq(leagues.id, leagueId));
  if (!league) throw new LeagueError("not_found");
  return league;
}

function assertCommissioner(league: League, actor: Actor) {
  if (league.commissionerId !== actor.id) throw new LeagueError("forbidden");
}

async function clearSchedule(db: Db, leagueId: string) {
  await db.delete(matchups).where(eq(matchups.leagueId, leagueId));
  await db.delete(matchupPeriods).where(eq(matchupPeriods.leagueId, leagueId));
}

// --------------------------------------------------------------------- NBA schedule lookups

/** Sorted distinct ET dates of regular-season NBA games for an ESPN season year. */
export async function regularSeasonGameDates(db: Db, season: number): Promise<string[]> {
  const rows = await db
    .select({ t: nbaGames.startTime })
    .from(nbaGames)
    .where(and(eq(nbaGames.season, season), eq(nbaGames.seasonType, 2)));
  return [...new Set(rows.map((r) => etDateString(r.t)))].sort();
}

/** First/last regular-season game dates, or null when the NBA schedule isn't loaded. */
export async function defaultSeasonDates(db: Db, season: number) {
  const dates = await regularSeasonGameDates(db, season);
  return dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null;
}

// ---------------------------------------------------------------------------- create / read

export async function createLeague(
  db: Db,
  actor: Actor,
  input: { name: string; season: number | string; teamName: string; teamAbbrev: string },
): Promise<League> {
  if (!actor.isSiteAdmin) throw new LeagueError("forbidden");
  const name = leagueNameSchema.safeParse(input.name);
  const season = seasonSchema.safeParse(input.season);
  const fieldErrors: Record<string, string[]> = {};
  if (!name.success) fieldErrors.name = name.error.issues.map((i) => i.message);
  if (!season.success) fieldErrors.season = season.error.issues.map((i) => i.message);
  let team: { name: string; abbrev: string } | undefined;
  try {
    team = parseTeamInput({ name: input.teamName, abbrev: input.teamAbbrev });
  } catch (err) {
    if (!(err instanceof LeagueError) || !err.fieldErrors) throw err;
    Object.assign(fieldErrors, err.fieldErrors);
  }
  if (!name.success || !season.success || !team) throw new LeagueError("invalid_input", fieldErrors);

  const dates = await defaultSeasonDates(db, season.data);
  const settings = defaultSettings({
    regularSeasonStart: dates?.start ?? null,
    regularSeasonEnd: dates?.end ?? null,
  });
  return db.transaction(async (tx) => {
    const [league] = await tx
      .insert(leagues)
      .values({ name: name.data, season: season.data, commissionerId: actor.id, settings })
      .returning();
    await tx.insert(teams).values({ leagueId: league.id, name: team.name, abbrev: team.abbrev, ownerId: actor.id });
    return league;
  });
}

export type TeamWithOwner = Team & { ownerUsername: string };

export type LeagueView = {
  league: League;
  settings: LeagueSettings;
  teams: TeamWithOwner[];
  myTeam: TeamWithOwner | null;
  commissionerUsername: string;
  isCommissioner: boolean;
};

async function listTeams(db: Db, leagueId: string): Promise<TeamWithOwner[]> {
  const rows = await db
    .select({ team: teams, ownerUsername: users.username })
    .from(teams)
    .innerJoin(users, eq(users.id, teams.ownerId))
    .where(eq(teams.leagueId, leagueId))
    .orderBy(asc(teams.createdAt), asc(teams.name));
  return rows.map((r) => ({ ...r.team, ownerUsername: r.ownerUsername }));
}

/** League + teams for members and site admins. Everyone else gets forbidden. */
export async function getLeagueView(db: Db, actor: Actor, leagueId: string): Promise<LeagueView> {
  const league = await loadLeague(db, leagueId);
  const teamList = await listTeams(db, leagueId);
  const myTeam = teamList.find((t) => t.ownerId === actor.id) ?? null;
  if (!myTeam && !actor.isSiteAdmin) throw new LeagueError("forbidden");
  const commissioner = teamList.find((t) => t.ownerId === league.commissionerId);
  let commissionerUsername = commissioner?.ownerUsername;
  if (!commissionerUsername) {
    const [u] = await db.select({ username: users.username }).from(users).where(eq(users.id, league.commissionerId));
    commissionerUsername = u?.username ?? "unknown";
  }
  return {
    league,
    settings: parseStoredSettings(league.settings),
    teams: teamList,
    myTeam,
    commissionerUsername,
    isCommissioner: league.commissionerId === actor.id,
  };
}

export type LeagueSummary = {
  league: League;
  teamCount: number;
  myTeamName: string | null;
  /** A later season has been started from this league. */
  rolledOver: boolean;
};

/** Leagues the user plays in; site admins also get every other league. */
export async function listLeagues(db: Db, actor: Actor): Promise<{ mine: LeagueSummary[]; others: LeagueSummary[] }> {
  const all = await db.select().from(leagues).orderBy(asc(leagues.createdAt));
  const teamRows = await db.select({ leagueId: teams.leagueId, ownerId: teams.ownerId, name: teams.name }).from(teams);
  const rolled = new Set(all.map((l) => l.previousLeagueId).filter((x): x is string => x !== null));
  const summaries = all.map((league): LeagueSummary => {
    const lt = teamRows.filter((t) => t.leagueId === league.id);
    return {
      league,
      teamCount: lt.length,
      myTeamName: lt.find((t) => t.ownerId === actor.id)?.name ?? null,
      rolledOver: rolled.has(league.id),
    };
  });
  return {
    mine: summaries.filter((s) => s.myTeamName !== null),
    others: actor.isSiteAdmin ? summaries.filter((s) => s.myTeamName === null) : [],
  };
}

export async function getTeamView(db: Db, actor: Actor, leagueId: string, teamId: string) {
  const view = await getLeagueView(db, actor, leagueId);
  const team = view.teams.find((t) => t.id === teamId);
  if (!team) throw new LeagueError("not_found");
  return { ...view, team };
}

export type ScheduleView = {
  periods: (MatchupPeriod & {
    matchups: {
      id: string;
      homeTeamId: string | null;
      awayTeamId: string | null;
      status: "scheduled" | "live" | "final";
      winnerTeamId: string | null;
      homePoints: number | null;
      awayPoints: number | null;
    }[];
  })[];
};

export async function getSchedule(db: Db, leagueId: string): Promise<ScheduleView> {
  const periods = await db
    .select()
    .from(matchupPeriods)
    .where(eq(matchupPeriods.leagueId, leagueId))
    .orderBy(asc(matchupPeriods.number));
  const rows = await db.select().from(matchups).where(eq(matchups.leagueId, leagueId));
  return {
    periods: periods.map((p) => ({
      ...p,
      matchups: rows
        .filter((m) => m.periodId === p.id)
        .map((m) => ({
          id: m.id,
          homeTeamId: m.homeTeamId,
          awayTeamId: m.awayTeamId,
          status: m.status,
          winnerTeamId: m.winnerTeamId,
          homePoints: m.homePoints,
          awayPoints: m.awayPoints,
        })),
    })),
  };
}

// -------------------------------------------------------------------------------- settings

/**
 * Commissioner-only. `patch` may contain any subset of settings (scoring is merged key by key).
 * rosterPool/rosterCap/snakeTarget/waveSize can't change once the league leaves "setup".
 */
export async function updateSettings(
  db: Db,
  actor: Actor,
  leagueId: string,
  patch: Record<string, unknown>,
): Promise<LeagueSettings> {
  const league = await loadLeague(db, leagueId);
  assertCommissioner(league, actor);
  const current = parseStoredSettings(league.settings);

  if (league.status !== "setup") {
    const locked = DRAFT_LOCKED_FIELDS.filter((k) => k in patch && patch[k] !== current[k]);
    if (locked.length) {
      throw new LeagueError(
        "settings_locked",
        Object.fromEntries(locked.map((k) => [k, [MESSAGES.settings_locked]])),
      );
    }
  }

  const merged = {
    ...current,
    ...patch,
    scoring: { ...current.scoring, ...((patch.scoring as object | undefined) ?? {}) },
  };
  const parsed = leagueSettingsSchema.safeParse(merged);
  if (!parsed.success) throw new LeagueError("invalid_input", zodFieldErrors(parsed.error));

  // Keepers only displace wave picks: they can't exceed roster space minus the snake rounds.
  if (league.status === "setup" && parsed.data.keepers > 0) {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(teams).where(eq(teams.leagueId, leagueId));
    if (n >= 2) {
      const room = keepersRoom(n, parsed.data);
      if (parsed.data.keepers > room) {
        throw new LeagueError("invalid_input", {
          keepers: [`With ${n} teams a team can keep at most ${room} (roster space left after the snake rounds).`],
        });
      }
    }
  }

  const changes = diffSettings(current as unknown as Record<string, unknown>, parsed.data as unknown as Record<string, unknown>);
  await db.transaction(async (tx) => {
    await tx.update(leagues).set({ settings: parsed.data }).where(eq(leagues.id, leagueId));
    if (changes.length > 0) {
      await logActivity(tx, {
        leagueId,
        actorUserId: actor.id,
        type: "settings_changed",
        summary: `Commissioner changed settings: ${changes.map((c) => c.label).join(", ")}.`,
        data: { changes, url: `/leagues/${leagueId}/settings` },
      });
    }
  });
  return parsed.data;
}

type SettingChange = { key: string; label: string; from: unknown; to: unknown };

/** Flat list of what changed between two settings objects (scoring is compared per stat). */
export function diffSettings(before: Record<string, unknown>, after: Record<string, unknown>): SettingChange[] {
  const out: SettingChange[] = [];
  for (const key of Object.keys(after)) {
    const a = before[key];
    const b = after[key];
    if (key === "scoring" && a && b && typeof a === "object" && typeof b === "object") {
      for (const k of Object.keys(b as object)) {
        const x = (a as Record<string, unknown>)[k];
        const y = (b as Record<string, unknown>)[k];
        if (x !== y) out.push({ key: `scoring.${k}`, label: `${k} ${String(x)} to ${String(y)}`, from: x ?? null, to: y ?? null });
      }
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push({ key, label: `${key} ${JSON.stringify(a ?? null)} to ${JSON.stringify(b ?? null)}`, from: a ?? null, to: b ?? null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------- invites

/**
 * League invites are reusable: one link in a group chat, many redemptions. They never expire by
 * default, and stay valid while not revoked, under max_uses, and the league is in setup. The raw
 * token is stored for league invites only (see schema) so the commissioner can see the link again.
 * Site-level invites (league_id null) are untouched: single-use, 7 days, hash-only.
 */
export async function createLeagueInvite(
  db: Db,
  actor: Actor,
  leagueId: string,
  opts: { maxUses?: number | null; revokeOthers?: boolean } = {},
  now = new Date(),
) {
  const league = await loadLeague(db, leagueId);
  assertCommissioner(league, actor);
  if (league.status !== "setup") throw new LeagueError("wrong_status");
  const maxUses = opts.maxUses ?? null;
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000)) {
    throw new LeagueError("invalid_input", { maxUses: ["Enter a whole number between 1 and 1000, or leave blank."] });
  }
  const token = generateToken();
  const invite = await db.transaction(async (tx) => {
    if (opts.revokeOthers ?? true) {
      await tx
        .update(invites)
        .set({ revokedAt: now })
        .where(and(eq(invites.leagueId, leagueId), isNull(invites.revokedAt)));
    }
    const [row] = await tx
      .insert(invites)
      .values({ tokenHash: hashToken(token), token, createdBy: actor.id, leagueId, expiresAt: null, maxUses })
      .returning({ id: invites.id });
    return row;
  });
  return { id: invite.id, token, expiresAt: null as Date | null };
}

export async function revokeLeagueInvite(db: Db, actor: Actor, leagueId: string, inviteId: string, now = new Date()) {
  const league = await loadLeague(db, leagueId);
  assertCommissioner(league, actor);
  if (!uuidSchema.safeParse(inviteId).success) throw new LeagueError("not_found");
  const res = await db
    .update(invites)
    .set({ revokedAt: now })
    .where(and(eq(invites.id, inviteId), eq(invites.leagueId, leagueId), isNull(invites.revokedAt)))
    .returning({ id: invites.id });
  if (res.length === 0) {
    const [exists] = await db
      .select({ id: invites.id })
      .from(invites)
      .where(and(eq(invites.id, inviteId), eq(invites.leagueId, leagueId)));
    if (!exists) throw new LeagueError("not_found");
  }
}

export type LeagueInviteStatus = "active" | "revoked" | "closed" | "full" | "expired" | "used";

export type LeagueInviteListItem = {
  id: string;
  token: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  maxUses: number | null;
  useCount: number;
  status: LeagueInviteStatus;
  members: { teamId: string; teamName: string; username: string; joinedAt: Date }[];
};

function inviteStatus(
  inv: { revokedAt: Date | null; usedAt: Date | null; expiresAt: Date | null; maxUses: number | null; useCount: number },
  leagueStatus: League["status"],
  now: Date,
): LeagueInviteStatus {
  if (inv.revokedAt) return "revoked";
  if (leagueStatus !== "setup") return "closed";
  if (inv.usedAt) return "used"; // legacy single-use invites
  if (inv.expiresAt && inv.expiresAt <= now) return "expired";
  if (inv.maxUses !== null && inv.useCount >= inv.maxUses) return "full";
  return "active";
}

/** Commissioner only. Newest first, with who joined through each link (teams still in the league). */
export async function listLeagueInvites(db: Db, actor: Actor, leagueId: string, now = new Date()): Promise<LeagueInviteListItem[]> {
  const league = await loadLeague(db, leagueId);
  assertCommissioner(league, actor);
  const rows = await db.select().from(invites).where(eq(invites.leagueId, leagueId)).orderBy(desc(invites.createdAt));
  const joined = await db
    .select({
      inviteId: inviteRedemptions.inviteId,
      teamId: teams.id,
      teamName: teams.name,
      username: users.username,
      joinedAt: inviteRedemptions.createdAt,
    })
    .from(inviteRedemptions)
    .innerJoin(invites, eq(invites.id, inviteRedemptions.inviteId))
    .innerJoin(teams, eq(teams.id, inviteRedemptions.teamId))
    .innerJoin(users, eq(users.id, inviteRedemptions.userId))
    .where(eq(invites.leagueId, leagueId))
    .orderBy(asc(inviteRedemptions.createdAt));
  return rows.map((r) => ({
    id: r.id,
    token: r.token,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    maxUses: r.maxUses,
    useCount: r.useCount,
    status: inviteStatus(r, league.status, now),
    members: joined.filter((j) => j.inviteId === r.id),
  }));
}

export type LeagueInviteInfo =
  | { status: "invalid" | "used" | "expired" | "revoked" | "full"; league: null }
  | { status: "valid"; league: { id: string; name: string; season: number; status: League["status"] } | null };

/** Looks up an invite token; league is null for site-level invites. Public (used by the invite page). */
export async function getLeagueInviteInfo(db: Db, token: string, now = new Date()): Promise<LeagueInviteInfo> {
  const [row] = await db
    .select({ invite: invites, league: leagues })
    .from(invites)
    .leftJoin(leagues, eq(leagues.id, invites.leagueId))
    .where(eq(invites.tokenHash, hashToken(token)));
  if (!row) return { status: "invalid", league: null };
  const inv = row.invite;
  if (inv.revokedAt) return { status: "revoked", league: null };
  if (inv.usedAt) return { status: "used", league: null };
  if (inv.expiresAt && inv.expiresAt <= now) return { status: "expired", league: null };
  const l = row.league;
  if (l && l.status === "setup" && inv.maxUses !== null && inv.useCount >= inv.maxUses) {
    return { status: "full", league: null };
  }
  return { status: "valid", league: l ? { id: l.id, name: l.name, season: l.season, status: l.status } : null };
}

async function requireOpenLeagueInvite(db: Db, token: string, now: Date) {
  const info = await getLeagueInviteInfo(db, token, now);
  if (info.status === "revoked") throw new LeagueError("invite_revoked");
  if (info.status === "full") throw new LeagueError("invite_full");
  if (info.status !== "valid" || !info.league) throw new LeagueError("invalid_invite");
  if (info.league.status !== "setup") throw new LeagueError("wrong_status");
  return info.league;
}

/**
 * Records one use of a league invite. The conditional UPDATE re-checks every rule and row-locks the
 * invite, so concurrent redemptions serialize: all succeed until max_uses is hit, never beyond it.
 */
async function claimLeagueInvite(tx: Db, token: string, userId: string, teamId: string, now: Date) {
  const claimed = await tx
    .update(invites)
    .set({ useCount: sql`${invites.useCount} + 1` })
    .where(
      and(
        eq(invites.tokenHash, hashToken(token)),
        isNotNull(invites.leagueId),
        isNull(invites.revokedAt),
        isNull(invites.usedAt),
        or(isNull(invites.expiresAt), gt(invites.expiresAt, now)),
        or(isNull(invites.maxUses), lt(invites.useCount, invites.maxUses)),
        sql`exists (select 1 from leagues l where l.id = ${invites.leagueId} and l.status = 'setup')`,
      ),
    )
    .returning({ id: invites.id });
  if (claimed.length === 0) {
    await requireOpenLeagueInvite(tx, token, now); // throws the specific reason
    throw new LeagueError("invalid_invite");
  }
  await tx.insert(inviteRedemptions).values({ inviteId: claimed[0].id, userId, teamId });
}

/** Existing logged-in user joins a league through a (reusable) league invite with a new team. */
export async function joinLeague(
  db: Db,
  actor: Actor,
  input: { token: string; teamName: string; teamAbbrev: string },
  now = new Date(),
): Promise<Team> {
  const t = parseTeamInput({ name: input.teamName, abbrev: input.teamAbbrev });
  try {
    return await db.transaction(async (tx) => {
      const league = await requireOpenLeagueInvite(tx, input.token, now);
      const [existing] = await tx
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.leagueId, league.id), eq(teams.ownerId, actor.id)));
      if (existing) throw new LeagueError("already_on_team");
      await assertTeamFree(tx, league.id, t.name, t.abbrev);

      const [team] = await tx
        .insert(teams)
        .values({ leagueId: league.id, name: t.name, abbrev: t.abbrev, ownerId: actor.id })
        .returning();
      await claimLeagueInvite(tx, input.token, actor.id, team.id, now);
      await clearSchedule(tx, league.id); // the old schedule doesn't include the new team
      await logActivity(tx, { leagueId: league.id, actorUserId: actor.id, type: "team_joined", summary: `${team.name} joined the league.`, data: { teamId: team.id }, now });
      return team;
    });
  } catch (err) {
    return rethrowTeamConflict(err);
  }
}

/** Brand-new user redeems a league invite: creates the user and their team in one transaction. */
export async function redeemLeagueInvite(
  db: Db,
  input: { token: string; username: string; password: string; teamName: string; teamAbbrev: string },
  now = new Date(),
) {
  const t = parseTeamInput({ name: input.teamName, abbrev: input.teamAbbrev });
  try {
    return await db.transaction(async (tx) => {
      const league = await requireOpenLeagueInvite(tx, input.token, now);
      await assertTeamFree(tx, league.id, t.name, t.abbrev);
      const user = await createUser(tx, { username: input.username, password: input.password }); // AuthError rolls back everything
      const [team] = await tx
        .insert(teams)
        .values({ leagueId: league.id, name: t.name, abbrev: t.abbrev, ownerId: user.id })
        .returning();
      await claimLeagueInvite(tx, input.token, user.id, team.id, now);
      await clearSchedule(tx, league.id);
      await logActivity(tx, { leagueId: league.id, actorUserId: user.id, type: "team_joined", summary: `${team.name} joined the league.`, data: { teamId: team.id }, now });
      return { user, team, leagueId: league.id };
    });
  } catch (err) {
    if (err instanceof AuthError || err instanceof LeagueError) throw err;
    return rethrowTeamConflict(err);
  }
}

// -------------------------------------------------------------------------------- teams

/** Owner or commissioner. Omit `abbrev` to keep the current one. */
export async function renameTeam(
  db: Db,
  actor: Actor,
  teamId: string,
  input: { name: string; abbrev?: string },
): Promise<Team> {
  if (!uuidSchema.safeParse(teamId).success) throw new LeagueError("not_found");
  const [team] = await db.select().from(teams).where(eq(teams.id, teamId));
  if (!team) throw new LeagueError("not_found");
  const league = await loadLeague(db, team.leagueId);
  if (team.ownerId !== actor.id && league.commissionerId !== actor.id) throw new LeagueError("forbidden");
  const t = parseTeamInput({ name: input.name, abbrev: input.abbrev ?? team.abbrev });
  await assertTeamFree(db, team.leagueId, t.name, t.abbrev, team.id);
  try {
    return await db.transaction(async (tx) => {
      const [updated] = await tx.update(teams).set({ name: t.name, abbrev: t.abbrev }).where(eq(teams.id, teamId)).returning();
      if (team.name !== t.name || team.abbrev !== t.abbrev) {
        const byCommissioner = team.ownerId !== actor.id;
        const parts = [
          team.name !== t.name ? `name "${team.name}" to "${t.name}"` : null,
          team.abbrev !== t.abbrev ? `abbreviation ${team.abbrev} to ${t.abbrev}` : null,
        ].filter(Boolean);
        await logActivity(tx, {
          leagueId: team.leagueId,
          actorUserId: actor.id,
          type: byCommissioner ? "commissioner_team_edit" : "team_renamed",
          summary: `${byCommissioner ? "Commissioner changed" : "Team changed"} ${parts.join(" and ")}.`,
          data: { teamId },
        });
      }
      return updated;
    });
  } catch (err) {
    return rethrowTeamConflict(err);
  }
}

/** Commissioner only, setup only. Clears the schedule (it must be regenerated). */
export async function removeTeam(db: Db, actor: Actor, teamId: string): Promise<void> {
  if (!uuidSchema.safeParse(teamId).success) throw new LeagueError("not_found");
  const [team] = await db.select().from(teams).where(eq(teams.id, teamId));
  if (!team) throw new LeagueError("not_found");
  const league = await loadLeague(db, team.leagueId);
  assertCommissioner(league, actor);
  if (league.status !== "setup") throw new LeagueError("wrong_status");
  if (team.ownerId === league.commissionerId) throw new LeagueError("cannot_remove_commissioner");
  await db.transaction(async (tx) => {
    await clearSchedule(tx, league.id);
    await tx.delete(teams).where(eq(teams.id, teamId));
    const [owner] = await tx.select({ username: users.username }).from(users).where(eq(users.id, team.ownerId));
    await logActivity(tx, {
      leagueId: league.id,
      actorUserId: actor.id,
      type: "team_removed",
      summary: `Commissioner removed team ${team.name} (${owner?.username ?? "unknown"}). The schedule was cleared.`,
      data: { teamName: team.name, ownerUserId: team.ownerId },
    });
  });
}

// --------------------------------------------------------------------- ownership and roles

export type TransferDeps = { notify?: Notifier; now?: Date };

/**
 * Commissioner only, any league status. Gives a team (with its roster, history and trades) to an
 * existing user who doesn't own a team in this league. The commissioner's own team can't be given
 * away (he'd lose access to the league): transfer the role first.
 */
export async function transferTeamOwnership(
  db: Db,
  actor: Actor,
  teamId: string,
  newUsername: string,
  deps: TransferDeps = {},
): Promise<Team> {
  const now = deps.now ?? new Date();
  if (!uuidSchema.safeParse(teamId).success) throw new LeagueError("not_found");
  const result = await db.transaction(async (tx) => {
    const [first] = await tx.select({ leagueId: teams.leagueId }).from(teams).where(eq(teams.id, teamId));
    if (!first) throw new LeagueError("not_found");
    const [league] = await tx.select().from(leagues).where(eq(leagues.id, first.leagueId)).for("update");
    if (!league) throw new LeagueError("not_found");
    assertCommissioner(league, actor);
    const [team] = await tx.select().from(teams).where(eq(teams.id, teamId));
    if (!team) throw new LeagueError("not_found");
    if (team.ownerId === league.commissionerId) throw new LeagueError("cannot_transfer_commissioner_team");
    const target = await findUserByUsername(tx, newUsername.trim());
    if (!target) throw new LeagueError("user_not_found", { username: [MESSAGES.user_not_found] });
    if (target.id === team.ownerId) throw new LeagueError("same_owner", { username: [MESSAGES.same_owner] });
    const [already] = await tx.select({ id: teams.id }).from(teams).where(and(eq(teams.leagueId, league.id), eq(teams.ownerId, target.id)));
    if (already) throw new LeagueError("already_on_team", { username: [MESSAGES.already_on_team] });
    const [oldOwner] = await tx.select({ username: users.username }).from(users).where(eq(users.id, team.ownerId));
    let updated: Team;
    try {
      [updated] = await tx.update(teams).set({ ownerId: target.id }).where(eq(teams.id, teamId)).returning();
    } catch (err) {
      return rethrowTeamConflict(err);
    }
    await logActivity(tx, {
      leagueId: league.id,
      actorUserId: actor.id,
      type: "team_owner_transferred",
      summary: `Commissioner transferred ${team.name} from ${oldOwner?.username ?? "unknown"} to ${target.username}.`,
      data: { teamId, fromUserId: team.ownerId, toUserId: target.id, url: `/leagues/${league.id}/teams/${teamId}` },
      now,
    });
    return { league, team: updated, oldOwnerId: team.ownerId, newOwnerId: target.id };
  });
  const send = deps.notify ?? notifier;
  await send(db, {
    userIds: [result.newOwnerId],
    leagueId: result.league.id,
    type: "commissioner_actions",
    title: "You were given a team",
    body: `The commissioner made you the owner of ${result.team.name} in ${result.league.name}.`,
    url: `/leagues/${result.league.id}/teams/${result.team.id}`,
  });
  await send(db, {
    userIds: [result.oldOwnerId],
    leagueId: result.league.id,
    type: "commissioner_actions",
    title: "You no longer own a team",
    body: `The commissioner moved ${result.team.name} in ${result.league.name} to another owner.`,
    url: "/leagues",
  });
  return result.team;
}

/**
 * Commissioner only. Hands the commissioner role to another team owner in the league (the UI asks
 * for confirmation). The old commissioner immediately loses the tools: every check reads
 * leagues.commissioner_id.
 */
export async function transferCommissioner(
  db: Db,
  actor: Actor,
  leagueId: string,
  newTeamId: string,
  deps: TransferDeps = {},
): Promise<League> {
  const now = deps.now ?? new Date();
  if (!uuidSchema.safeParse(newTeamId).success) throw new LeagueError("not_found");
  if (!uuidSchema.safeParse(leagueId).success) throw new LeagueError("not_found");
  const done = await db.transaction(async (tx) => {
    const [league] = await tx.select().from(leagues).where(eq(leagues.id, leagueId)).for("update");
    if (!league) throw new LeagueError("not_found");
    assertCommissioner(league, actor);
    const [team] = await tx.select().from(teams).where(and(eq(teams.id, newTeamId), eq(teams.leagueId, leagueId)));
    if (!team) throw new LeagueError("not_found");
    if (team.ownerId === league.commissionerId) throw new LeagueError("already_commissioner");
    const [updated] = await tx.update(leagues).set({ commissionerId: team.ownerId }).where(eq(leagues.id, leagueId)).returning();
    const [oldC] = await tx.select({ username: users.username }).from(users).where(eq(users.id, actor.id));
    const [newC] = await tx.select({ username: users.username }).from(users).where(eq(users.id, team.ownerId));
    await logActivity(tx, {
      leagueId,
      actorUserId: actor.id,
      type: "commissioner_transferred",
      summary: `${oldC?.username ?? "The commissioner"} handed the commissioner role to ${newC?.username ?? "another member"}.`,
      data: { fromUserId: actor.id, toUserId: team.ownerId },
      now,
    });
    return { league: updated, newCommissionerId: team.ownerId };
  });
  await (deps.notify ?? notifier)(db, {
    userIds: [done.newCommissionerId],
    leagueId,
    type: "commissioner_actions",
    title: "You are now the commissioner",
    body: `You are the commissioner of ${done.league.name}. The commissioner tools are in the league menu.`,
    url: `/leagues/${leagueId}/commissioner`,
  });
  return done.league;
}

// ------------------------------------------------------------------------------ schedule

export type ScheduleResult = {
  regularPeriods: number;
  playoffPeriods: number;
  /** Human-readable caveats (e.g. NBA schedule not loaded so the All-Star merge was skipped). */
  notices: string[];
};

/**
 * Commissioner only, setup only. Replaces any existing periods/matchups. Dates come from the
 * league settings, falling back to the NBA schedule; without either we ask for dates.
 */
export async function generateSchedule(
  db: Db,
  actor: Actor,
  leagueId: string,
  opts: { seed?: string } = {},
): Promise<ScheduleResult> {
  const league = await loadLeague(db, leagueId);
  assertCommissioner(league, actor);
  if (league.status !== "setup") throw new LeagueError("wrong_status");
  const settings = parseStoredSettings(league.settings);

  const teamList = await db.select().from(teams).where(eq(teams.leagueId, leagueId)).orderBy(asc(teams.createdAt), asc(teams.id));
  if (teamList.length < 2) throw new LeagueError("not_enough_teams");
  if (settings.playoffTeams > teamList.length) throw new LeagueError("playoff_teams_exceed_teams");

  const nbaDates = await regularSeasonGameDates(db, league.season);
  const start = settings.regularSeasonStart ?? nbaDates[0] ?? null;
  const end = settings.regularSeasonEnd ?? nbaDates[nbaDates.length - 1] ?? null;
  if (!start || !end) throw new LeagueError("dates_required");

  const notices: string[] = [];
  const gameDates = nbaDates.filter((d) => d >= start && d <= end);
  if (gameDates.length === 0) {
    notices.push(
      "The NBA schedule isn't loaded for these dates, so the All-Star break week wasn't merged automatically. Re-generate after the next NBA data sync.",
    );
  }
  if (!settings.regularSeasonStart || !settings.regularSeasonEnd) {
    notices.push("Season dates were taken from the NBA schedule.");
  }

  let periods;
  try {
    periods = buildMatchupPeriods(start, end, gameDates, settings.playoffTeams, settings.playoffRoundLength);
  } catch (err) {
    if (err instanceof Error && /too short/.test(err.message)) throw new LeagueError("season_too_short", undefined, err.message);
    throw new LeagueError("invalid_input", { regularSeasonEnd: [(err as Error).message] });
  }
  const regular = periods.filter((p) => !p.isPlayoff);
  const rounds = roundRobin(
    teamList.map((t) => t.id),
    regular.length,
    opts.seed ?? randomBytes(8).toString("hex"),
  );

  await db.transaction(async (tx) => {
    await clearSchedule(tx, leagueId);
    const inserted = await tx
      .insert(matchupPeriods)
      .values(periods.map((p) => ({ ...p, leagueId })))
      .returning({ id: matchupPeriods.id, number: matchupPeriods.number });
    const idByNumber = new Map(inserted.map((p) => [p.number, p.id]));
    const rows = regular.flatMap((p, i) => {
      const periodId = idByNumber.get(p.number)!;
      return [
        ...rounds[i].pairings.map((m) => ({ leagueId, periodId, homeTeamId: m.home, awayTeamId: m.away })),
        ...rounds[i].byes.map((b) => ({ leagueId, periodId, homeTeamId: b, awayTeamId: null })),
      ];
    });
    if (rows.length) await tx.insert(matchups).values(rows);
  });

  return { regularPeriods: regular.length, playoffPeriods: periods.length - regular.length, notices };
}
