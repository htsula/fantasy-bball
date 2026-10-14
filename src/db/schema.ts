import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const tstz = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => tstz("created_at").notNull().defaultNow();

export const users = pgTable(
  "users",
  {
    id: id(),
    // Stored as typed; uniqueness is enforced case-insensitively via lower().
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    isSiteAdmin: boolean("is_site_admin").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_username_lower_idx").on(sql`lower(${t.username})`)],
);

// `id` is the sha256 hex of the cookie token; the raw token is never stored.
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: tstz("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

// ---------------------------------------------------------------------------------------------
// Leagues (milestone 3). Settings are validated jsonb (see src/lib/fantasy/settings.ts).
// ---------------------------------------------------------------------------------------------

export type LeagueStatus = "setup" | "drafting" | "in_season" | "playoffs" | "complete";

export const leagues = pgTable(
  "leagues",
  {
    id: id(),
    name: text("name").notNull(),
    season: integer("season").notNull(), // ESPN season year (2027 = 2026-27)
    commissionerId: uuid("commissioner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    status: text("status").$type<LeagueStatus>().notNull().default("setup"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    // Milestone 8 (additive): each season is its own league row, linked to the season before it.
    previousLeagueId: uuid("previous_league_id").references((): AnyPgColumn => leagues.id, { onDelete: "set null" }),
  },
  // A season can be rolled over only once (NULLs are distinct, so unlinked leagues are unaffected).
  (t) => [uniqueIndex("leagues_previous_league_idx").on(t.previousLeagueId)],
);

export const teams = pgTable(
  "teams",
  {
    id: id(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    abbrev: text("abbrev").notNull(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    // Milestone 8 (additive): the same franchise in the previous season (for keepers and history).
    previousTeamId: uuid("previous_team_id").references((): AnyPgColumn => teams.id, { onDelete: "set null" }),
  },
  (t) => [
    uniqueIndex("teams_league_name_lower_idx").on(t.leagueId, sql`lower(${t.name})`),
    uniqueIndex("teams_league_abbrev_upper_idx").on(t.leagueId, sql`upper(${t.abbrev})`),
    uniqueIndex("teams_league_owner_idx").on(t.leagueId, t.ownerId),
    index("teams_owner_idx").on(t.ownerId),
  ],
);

export const matchupPeriods = pgTable(
  "matchup_periods",
  {
    id: id(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    startDate: date("start_date", { mode: "string" }).notNull(), // ET dates, inclusive
    endDate: date("end_date", { mode: "string" }).notNull(),
    isPlayoff: boolean("is_playoff").notNull().default(false),
    playoffRound: integer("playoff_round"),
  },
  (t) => [uniqueIndex("matchup_periods_league_number_idx").on(t.leagueId, t.number)],
);

export type MatchupStatus = "scheduled" | "live" | "final";

// A bye is a row with homeTeamId set and awayTeamId null. Playoff matchups are created later.
export const matchups = pgTable(
  "matchups",
  {
    id: id(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    periodId: uuid("period_id")
      .notNull()
      .references(() => matchupPeriods.id, { onDelete: "cascade" }),
    homeTeamId: uuid("home_team_id").references(() => teams.id, { onDelete: "cascade" }),
    awayTeamId: uuid("away_team_id").references(() => teams.id, { onDelete: "cascade" }),
    // Milestone 6 (additive): results. Byes stay "scheduled" until finalized as "final" with no winner.
    status: text("status").$type<MatchupStatus>().notNull().default("scheduled"),
    winnerTeamId: uuid("winner_team_id").references(() => teams.id, { onDelete: "set null" }),
    homePoints: numeric("home_points", { mode: "number" }),
    awayPoints: numeric("away_points", { mode: "number" }),
    // Milestone 8 (additive): playoff matchups belong to a bracket slot (one row per period of the round).
    playoffSlotId: uuid("playoff_slot_id").references((): AnyPgColumn => playoffSlots.id, { onDelete: "cascade" }),
  },
  (t) => [index("matchups_league_period_idx").on(t.leagueId, t.periodId)],
);

export const invites = pgTable("invites", {
  id: id(),
  tokenHash: text("token_hash").notNull().unique(),
  // Set for league invites: redeeming one also puts the user on a new team in that league.
  leagueId: uuid("league_id").references(() => leagues.id, { onDelete: "cascade" }),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // Site-level invites always expire (7 days). League invites are reusable and have no expiry (null).
  expiresAt: tstz("expires_at"),
  // Single-use bookkeeping for site-level invites (league invites use invite_redemptions instead).
  usedBy: uuid("used_by").references(() => users.id, { onDelete: "set null" }),
  usedAt: tstz("used_at"),
  createdAt: createdAt(),
  // Reusable league invites (additive columns).
  // Raw token, LEAGUE invites only: these links are meant to be pasted into a group chat, and the
  // commissioner needs to see the active link again later. Site invites and password resets stay hash-only.
  token: text("token"),
  revokedAt: tstz("revoked_at"),
  maxUses: integer("max_uses"), // null = unlimited
  useCount: integer("use_count").notNull().default(0),
});

// One row per person who joined through a (reusable) league invite. team_id is nulled when the
// commissioner removes the team; the use still counts toward max_uses.
export const inviteRedemptions = pgTable(
  "invite_redemptions",
  {
    id: id(),
    inviteId: uuid("invite_id")
      .notNull()
      .references(() => invites.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("invite_redemptions_invite_idx").on(t.inviteId)],
);

export const passwordResets = pgTable("password_resets", {
  id: id(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: tstz("expires_at").notNull(),
  usedAt: tstz("used_at"),
  createdAt: createdAt(),
});

// Failed-login counter used for simple brute-force throttling (keyed by lowercased username).
export const loginAttempts = pgTable("login_attempts", {
  usernameKey: text("username_key").primaryKey(),
  failures: integer("failures").notNull().default(0),
  lastFailedAt: tstz("last_failed_at").notNull().defaultNow(),
  lockedUntil: tstz("locked_until"),
});

// ---------------------------------------------------------------------------------------------
// NBA data (milestone 2). Primary keys are ESPN ids. Teams/players are deliberately not FK-linked
// from games/players so ingestion order never matters (ESPN can reference a team or player we
// have not synced yet).
// ---------------------------------------------------------------------------------------------

export const nbaTeams = pgTable("nba_teams", {
  id: integer("id").primaryKey(), // ESPN team id
  abbrev: text("abbrev").notNull(),
  name: text("name").notNull(), // "Hawks"
  location: text("location").notNull(), // "Atlanta"
  logo: text("logo"),
  color: text("color"), // hex without "#"
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});

export const nbaPlayers = pgTable(
  "nba_players",
  {
    id: integer("id").primaryKey(), // ESPN athlete id
    fullName: text("full_name").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    teamId: integer("team_id"),
    // Fantasy positions (PG/SG/SF/PF/C) derived from ESPN's position.
    positions: text("positions").array().notNull().default(sql`'{}'::text[]`),
    espnPosition: text("espn_position"),
    jersey: text("jersey"),
    headshotUrl: text("headshot_url"),
    heightInches: integer("height_inches"),
    weightLbs: integer("weight_lbs"),
    age: integer("age"),
    birthDate: date("birth_date", { mode: "string" }),
    experienceYears: integer("experience_years"),
    active: boolean("active").notNull().default(true),
    // Denormalized cache of the player's current injury (null = healthy).
    injuryStatus: text("injury_status"),
    injuryDetail: text("injury_detail"),
    injuryUpdatedAt: tstz("injury_updated_at"),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("nba_players_team_id_idx").on(t.teamId),
    index("nba_players_full_name_lower_idx").on(sql`lower(${t.fullName})`),
  ],
);

export type GameStatus = "scheduled" | "in" | "final" | "postponed";

export const nbaGames = pgTable(
  "nba_games",
  {
    id: integer("id").primaryKey(), // ESPN event id
    season: integer("season").notNull(), // ESPN season year (2026 = 2025-26)
    seasonType: integer("season_type").notNull(), // 1 pre, 2 regular, 3 post, 4 off, 5 play-in
    startTime: tstz("start_time").notNull(),
    homeTeamId: integer("home_team_id").notNull(),
    awayTeamId: integer("away_team_id").notNull(),
    homeScore: integer("home_score"),
    awayScore: integer("away_score"),
    status: text("status").$type<GameStatus>().notNull().default("scheduled"),
    statusDetail: text("status_detail"),
    period: integer("period"),
    clock: text("clock"),
    // When we first saw the game as final, and whether its box score has been pulled post-final.
    finishedAt: tstz("finished_at"),
    statsFinal: boolean("stats_final").notNull().default(false),
    statsSyncedAt: tstz("stats_synced_at"),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("nba_games_start_time_idx").on(t.startTime),
    index("nba_games_status_idx").on(t.status),
    index("nba_games_home_team_idx").on(t.homeTeamId, t.startTime),
    index("nba_games_away_team_idx").on(t.awayTeamId, t.startTime),
  ],
);

export const playerGameStats = pgTable(
  "player_game_stats",
  {
    id: serial("id").primaryKey(),
    gameId: integer("game_id")
      .notNull()
      .references(() => nbaGames.id, { onDelete: "cascade" }),
    playerId: integer("player_id")
      .notNull()
      .references(() => nbaPlayers.id, { onDelete: "cascade" }),
    teamId: integer("team_id").notNull(),
    minutes: integer("minutes"),
    fgm: integer("fgm").notNull().default(0),
    fga: integer("fga").notNull().default(0),
    ftm: integer("ftm").notNull().default(0),
    fta: integer("fta").notNull().default(0),
    tpm: integer("tpm").notNull().default(0),
    tpa: integer("tpa").notNull().default(0),
    reb: integer("reb").notNull().default(0),
    oreb: integer("oreb").notNull().default(0),
    dreb: integer("dreb").notNull().default(0),
    ast: integer("ast").notNull().default(0),
    stl: integer("stl").notNull().default(0),
    blk: integer("blk").notNull().default(0),
    to: integer("turnovers").notNull().default(0),
    pf: integer("pf").notNull().default(0),
    pts: integer("pts").notNull().default(0),
    dnp: boolean("dnp").notNull().default(false),
    dnpReason: text("dnp_reason"),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("player_game_stats_game_player_idx").on(t.gameId, t.playerId),
    index("player_game_stats_player_idx").on(t.playerId),
  ],
);

export const nbaInjuries = pgTable("nba_injuries", {
  playerId: integer("player_id").primaryKey(),
  teamId: integer("team_id"),
  status: text("status").notNull(),
  detail: text("detail"),
  shortComment: text("short_comment"),
  longComment: text("long_comment"),
  date: tstz("date"),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});

export const nbaNews = pgTable(
  "nba_news",
  {
    id: text("id").primaryKey(), // ESPN article id
    headline: text("headline").notNull(),
    description: text("description"),
    published: tstz("published").notNull(),
    link: text("link"),
    image: text("image"),
    relatedPlayerIds: integer("related_player_ids").array().notNull().default(sql`'{}'::integer[]`),
    relatedTeamIds: integer("related_team_ids").array().notNull().default(sql`'{}'::integer[]`),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [index("nba_news_published_idx").on(t.published)],
);

// Latest raw ESPN payload per (kind, key); upserted so the table never grows per fetch.
export const rawSnapshots = pgTable(
  "raw_snapshots",
  {
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    fetchedAt: tstz("fetched_at").notNull().defaultNow(),
    payload: jsonb("payload").notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.key] })],
);

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: serial("id").primaryKey(),
    job: text("job").notNull(),
    startedAt: tstz("started_at").notNull().defaultNow(),
    finishedAt: tstz("finished_at"),
    ok: boolean("ok"),
    error: text("error"),
    counts: jsonb("counts").$type<Record<string, unknown>>(),
  },
  (t) => [index("sync_runs_job_started_idx").on(t.job, t.startedAt)],
);

export type NbaTeam = typeof nbaTeams.$inferSelect;
export type NbaPlayer = typeof nbaPlayers.$inferSelect;
export type NbaGame = typeof nbaGames.$inferSelect;
export type PlayerGameStat = typeof playerGameStats.$inferSelect;
export type NbaInjury = typeof nbaInjuries.$inferSelect;
export type NbaNewsItem = typeof nbaNews.$inferSelect;
export type SyncRun = typeof syncRuns.$inferSelect;

export type User = typeof users.$inferSelect;
export type Invite = typeof invites.$inferSelect;
export type InviteRedemption = typeof inviteRedemptions.$inferSelect;
export type League = typeof leagues.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type MatchupPeriod = typeof matchupPeriods.$inferSelect;
export type Matchup = typeof matchups.$inferSelect;

// ---------------------------------------------------------------------------------------------
// Draft, rosters and notifications (milestone 4). All additive.
// ---------------------------------------------------------------------------------------------

export type DraftStatus = "pending" | "snake" | "waves" | "complete";
export type DraftPhase = "snake" | "wave";

export const drafts = pgTable("drafts", {
  id: id(),
  leagueId: uuid("league_id")
    .notNull()
    .unique()
    .references(() => leagues.id, { onDelete: "cascade" }),
  status: text("status").$type<DraftStatus>().notNull().default("pending"),
  // Team ids in first-round order (randomized at start).
  order: uuid("order").array().notNull(),
  maxRoster: integer("max_roster").notNull(),
  snakeRounds: integer("snake_rounds").notNull(),
  totalRounds: integer("total_rounds").notNull(),
  // Next snake overall pick (1-based). Stays at snakeRounds * teams + 1 once the snake is over.
  currentPick: integer("current_pick").notNull().default(1),
  currentWave: integer("current_wave"),
  waveOpenedAt: tstz("wave_opened_at"),
  startedAt: tstz("started_at"),
  completedAt: tstz("completed_at"),
  startedBy: uuid("started_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export const draftPicks = pgTable(
  "draft_picks",
  {
    id: id(),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => drafts.id, { onDelete: "cascade" }),
    overallPick: integer("overall_pick").notNull(),
    round: integer("round").notNull(), // the team's nth pick
    phase: text("phase").$type<DraftPhase>().notNull(),
    wave: integer("wave"),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    playerId: integer("player_id")
      .notNull()
      .references(() => nbaPlayers.id, { onDelete: "restrict" }),
    madeBy: uuid("made_by").references(() => users.id, { onDelete: "set null" }),
    madeByCommissioner: boolean("made_by_commissioner").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("draft_picks_draft_player_idx").on(t.draftId, t.playerId),
    uniqueIndex("draft_picks_draft_overall_idx").on(t.draftId, t.overallPick),
    index("draft_picks_team_idx").on(t.teamId),
  ],
);

export const draftQueue = pgTable(
  "draft_queue",
  {
    id: id(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    playerId: integer("player_id")
      .notNull()
      .references(() => nbaPlayers.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("draft_queue_team_player_idx").on(t.teamId, t.playerId)],
);

export type AcquiredVia = "draft" | "add" | "trade" | "commissioner" | "keeper";

export const rosterEntries = pgTable(
  "roster_entries",
  {
    id: id(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    playerId: integer("player_id")
      .notNull()
      .references(() => nbaPlayers.id, { onDelete: "restrict" }),
    acquiredVia: text("acquired_via").$type<AcquiredVia>().notNull(),
    acquiredAt: tstz("acquired_at").notNull().defaultNow(),
    releasedAt: tstz("released_at"),
    releasedVia: text("released_via"),
  },
  (t) => [
    // A player is on at most one active roster per league.
    uniqueIndex("roster_entries_active_player_idx")
      .on(t.leagueId, t.playerId)
      .where(sql`${t.releasedAt} is null`),
    index("roster_entries_team_idx").on(t.teamId),
    index("roster_entries_league_player_idx").on(t.leagueId, t.playerId),
  ],
);

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    lastSuccessAt: tstz("last_success_at"),
    failureCount: integer("failure_count").notNull().default(0),
  },
  (t) => [index("push_subscriptions_user_idx").on(t.userId)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    leagueId: uuid("league_id").references(() => leagues.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    url: text("url"),
    readAt: tstz("read_at"),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_created_idx").on(t.userId, t.createdAt)],
);

// One row per (user, type) the user changed; missing rows mean "everything on".
export const notificationPrefs = pgTable(
  "notification_prefs",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    push: boolean("push").notNull().default(true),
    inApp: boolean("in_app").notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.userId, t.type] })],
);

export type Draft = typeof drafts.$inferSelect;
export type DraftPick = typeof draftPicks.$inferSelect;
export type RosterEntry = typeof rosterEntries.$inferSelect;
export type AppNotification = typeof notifications.$inferSelect;

// ---------------------------------------------------------------------------------------------
// Rosters milestone (5): tip-off snapshots and the transaction log. All additive.
// ---------------------------------------------------------------------------------------------

// Who was on each NBA team (and their injury status) when a game tipped off. Insert-only: once a
// game has rows they are never rewritten, so later trades or injury-report edits can't change
// past win bonuses. `late` marks snapshots taken after the real tip-off (the sync missed it).
export const gameRosterSnapshots = pgTable(
  "game_roster_snapshots",
  {
    gameId: integer("game_id")
      .notNull()
      .references(() => nbaGames.id, { onDelete: "cascade" }),
    playerId: integer("player_id")
      .notNull()
      .references(() => nbaPlayers.id, { onDelete: "cascade" }),
    nbaTeamId: integer("nba_team_id").notNull(),
    injuryStatus: text("injury_status"),
    late: boolean("late").notNull().default(false),
    capturedAt: tstz("captured_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.gameId, t.playerId] }),
    // Team points join from a team's roster entries (by player) to the games they were in.
    index("game_roster_snapshots_player_idx").on(t.playerId),
  ],
);

export type TransactionType = "add" | "drop" | "trade" | "auto_drop" | "commissioner_add" | "commissioner_drop";

export const transactions = pgTable(
  "transactions",
  {
    id: id(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    type: text("type").$type<TransactionType>().notNull(),
    playerId: integer("player_id")
      .notNull()
      .references(() => nbaPlayers.id, { onDelete: "restrict" }),
    // Shared by the rows of one action (an add paired with its drop).
    groupId: uuid("group_id"),
    // Null for system actions (auto-drops).
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    // ET calendar day of the action: the daily add limit counts adds per (team, etDate).
    etDate: date("et_date", { mode: "string" }).notNull(),
    note: text("note"),
  },
  (t) => [
    index("transactions_team_day_type_idx").on(t.teamId, t.etDate, t.type),
    index("transactions_league_created_idx").on(t.leagueId, t.createdAt),
  ],
);

export type GameRosterSnapshot = typeof gameRosterSnapshots.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;

// ---------------------------------------------------------------------------------------------
// Scoring milestone (6): cached matchup totals and standings. Both are caches of values derived
// from roster_entries + player_game_stats + game_roster_snapshots and can be rebuilt any time.
// ---------------------------------------------------------------------------------------------

export const matchupTeamTotals = pgTable(
  "matchup_team_totals",
  {
    matchupId: uuid("matchup_id")
      .notNull()
      .references(() => matchups.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    // points INCLUDES win_bonus; win_bonus is the bonus portion of it.
    points: numeric("points", { mode: "number" }).notNull().default(0),
    winBonus: numeric("win_bonus", { mode: "number" }).notNull().default(0),
    gamesPlayed: integer("games_played").notNull().default(0),
    gamesRemaining: integer("games_remaining").notNull().default(0),
    projected: numeric("projected", { mode: "number" }).notNull().default(0),
    computedAt: tstz("computed_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.matchupId, t.teamId] })],
);

export const standings = pgTable(
  "standings",
  {
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    wins: integer("wins").notNull().default(0),
    losses: integer("losses").notNull().default(0),
    ties: integer("ties").notNull().default(0),
    pointsFor: numeric("points_for", { mode: "number" }).notNull().default(0),
    pointsAgainst: numeric("points_against", { mode: "number" }).notNull().default(0),
    streak: text("streak").notNull().default(""),
    rank: integer("rank").notNull(),
    computedAt: tstz("computed_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.leagueId, t.teamId] }), index("standings_league_rank_idx").on(t.leagueId, t.rank)],
);

export type MatchupTeamTotalsRow = typeof matchupTeamTotals.$inferSelect;
export type StandingsRow = typeof standings.$inferSelect;

// ---------------------------------------------------------------------------------------------
// Trades milestone (7): proposals, their player lists, league votes and the trade block. Additive.
// ---------------------------------------------------------------------------------------------

export type TradeStatus =
  | "proposed"
  | "countered"
  | "rejected"
  | "cancelled"
  | "expired"
  | "pending_review"
  | "vetoed"
  | "executed"
  | "invalidated"
  | "reversed";

/** "trade" = a normal proposal; "reversal" = the record a commissioner reversal creates. */
export type TradeKind = "trade" | "reversal";

export const trades = pgTable(
  "trades",
  {
    id: id(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    kind: text("kind").$type<TradeKind>().notNull().default("trade"),
    proposerTeamId: uuid("proposer_team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    receiverTeamId: uuid("receiver_team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    status: text("status").$type<TradeStatus>().notNull().default("proposed"),
    message: text("message"),
    // The offer this one counters (the original becomes "countered").
    counteredFrom: uuid("countered_from").references((): AnyPgColumn => trades.id, { onDelete: "set null" }),
    proposedBy: uuid("proposed_by").references(() => users.id, { onDelete: "set null" }),
    respondedAt: tstz("responded_at"),
    acceptedAt: tstz("accepted_at"),
    reviewEndsAt: tstz("review_ends_at"),
    executedAt: tstz("executed_at"),
    // Proposals expire 7 days after they are made.
    expiresAt: tstz("expires_at").notNull(),
    resolvedReason: text("resolved_reason"),
    reversedByTradeId: uuid("reversed_by_trade_id").references((): AnyPgColumn => trades.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("trades_league_status_idx").on(t.leagueId, t.status),
    index("trades_status_idx").on(t.status),
  ],
);

export const tradeItems = pgTable(
  "trade_items",
  {
    tradeId: uuid("trade_id")
      .notNull()
      .references(() => trades.id, { onDelete: "cascade" }),
    playerId: integer("player_id")
      .notNull()
      .references(() => nbaPlayers.id, { onDelete: "restrict" }),
    fromTeamId: uuid("from_team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    toTeamId: uuid("to_team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.tradeId, t.playerId] }),
    index("trade_items_trade_idx").on(t.tradeId),
    index("trade_items_player_idx").on(t.playerId),
  ],
);

export type TradeVoteValue = "veto" | "approve";

// One vote per team (the voter is that team's owner). Only vetoes count; approvals are recorded.
export const tradeVotes = pgTable(
  "trade_votes",
  {
    tradeId: uuid("trade_id")
      .notNull()
      .references(() => trades.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    voterUserId: uuid("voter_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    vote: text("vote").$type<TradeVoteValue>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("trade_votes_trade_team_idx").on(t.tradeId, t.teamId)],
);

export const tradeBlock = pgTable(
  "trade_block",
  {
    id: id(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    playerId: integer("player_id")
      .notNull()
      .references(() => nbaPlayers.id, { onDelete: "cascade" }),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("trade_block_team_player_idx").on(t.teamId, t.playerId),
    index("trade_block_league_idx").on(t.leagueId),
  ],
);

export type Trade = typeof trades.$inferSelect;
export type TradeItem = typeof tradeItems.$inferSelect;
export type TradeVote = typeof tradeVotes.$inferSelect;
export type TradeBlockEntry = typeof tradeBlock.$inferSelect;

// ---------------------------------------------------------------------------------------------
// Playoffs, season history and keepers (milestone 8). All additive.
// ---------------------------------------------------------------------------------------------

// One row per bracket game. A round-1 slot with a single team is a BYE: it has no matchup rows and
// its winner is set at seeding. Later-round slots fill from the winners of their two source slots.
// A round spanning two periods has two matchup rows per slot; the slot winner is decided on the
// combined points (ties go to the higher seed).
export const playoffSlots = pgTable(
  "playoff_slots",
  {
    id: id(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    round: integer("round").notNull(), // 1-based
    slot: integer("slot").notNull(), // 0-based within the round
    teamAId: uuid("team_a_id").references(() => teams.id, { onDelete: "set null" }),
    teamBId: uuid("team_b_id").references(() => teams.id, { onDelete: "set null" }),
    seedA: integer("seed_a"),
    seedB: integer("seed_b"),
    // Where the teams come from (null in round 1).
    sourceASlotId: uuid("source_a_slot_id").references((): AnyPgColumn => playoffSlots.id, { onDelete: "set null" }),
    sourceBSlotId: uuid("source_b_slot_id").references((): AnyPgColumn => playoffSlots.id, { onDelete: "set null" }),
    winnerTeamId: uuid("winner_team_id").references(() => teams.id, { onDelete: "set null" }),
    decidedAt: tstz("decided_at"),
    // Commissioner override (logged here): the nightly job never recomputes an overridden slot.
    overridden: boolean("overridden").notNull().default(false),
    overriddenBy: uuid("overridden_by").references(() => users.id, { onDelete: "set null" }),
    overriddenAt: tstz("overridden_at"),
    overrideNote: text("override_note"),
  },
  (t) => [uniqueIndex("playoff_slots_league_round_slot_idx").on(t.leagueId, t.round, t.slot)],
);

export type PlayoffResult = "champion" | "runner_up" | "semifinal" | "quarterfinal" | "missed";

// Written when a league completes: one row per team, a durable record that survives roster churn.
export const seasonResults = pgTable(
  "season_results",
  {
    id: id(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    teamName: text("team_name").notNull(), // as of season end
    finalRank: integer("final_rank").notNull(),
    wins: integer("wins").notNull().default(0),
    losses: integer("losses").notNull().default(0),
    ties: integer("ties").notNull().default(0),
    pointsFor: numeric("points_for", { mode: "number" }).notNull().default(0),
    pointsAgainst: numeric("points_against", { mode: "number" }).notNull().default(0),
    playoffResult: text("playoff_result").$type<PlayoffResult>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("season_results_league_rank_idx").on(t.leagueId, t.finalRank),
    index("season_results_owner_idx").on(t.ownerUserId),
  ],
);

// Players a team keeps from last season. Rows are chosen during setup and turned into roster
// entries (acquired_via = keeper) when the draft starts; the rows stay as the record of who was kept.
export const keepers = pgTable(
  "keepers",
  {
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    playerId: integer("player_id")
      .notNull()
      .references(() => nbaPlayers.id, { onDelete: "cascade" }),
    selectedBy: uuid("selected_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.playerId] }),
    uniqueIndex("keepers_league_player_idx").on(t.leagueId, t.playerId),
  ],
);

export type PlayoffSlot = typeof playoffSlots.$inferSelect;
export type SeasonResult = typeof seasonResults.$inferSelect;
export type Keeper = typeof keepers.$inferSelect;

// ---------------------------------------------------------------------------------------------
// Social and commissioner tools (milestone 9). All additive.
// ---------------------------------------------------------------------------------------------

export type MessageKind = "message" | "announcement";

// League chat / message board. Bodies are stored RAW (plain text) and escaped at render time.
// Deletes are soft (deleted_at) so reply previews and the unread count stay consistent.
export const messages = pgTable(
  "messages",
  {
    id: id(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    kind: text("kind").$type<MessageKind>().notNull().default("message"),
    body: text("body").notNull(),
    createdAt: createdAt(),
    editedAt: tstz("edited_at"),
    deletedAt: tstz("deleted_at"),
    replyTo: uuid("reply_to").references((): AnyPgColumn => messages.id, { onDelete: "set null" }),
    pinned: boolean("pinned").notNull().default(false),
  },
  (t) => [
    index("messages_league_created_idx").on(t.leagueId, t.createdAt),
    index("messages_league_user_created_idx").on(t.leagueId, t.userId, t.createdAt),
  ],
);

// When each member last opened the chat (drives the unread badge).
export const chatReads = pgTable(
  "chat_reads",
  {
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastReadAt: tstz("last_read_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.leagueId, t.userId] })],
);

// Unified, append-only league timeline. Commissioner actions are always written with their actor.
export const activityLog = pgTable(
  "activity_log",
  {
    id: id(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    summary: text("summary").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("activity_log_league_created_idx").on(t.leagueId, t.createdAt)],
);

// Commissioner score corrections: a signed point adjustment for one team in one matchup.
export const matchupAdjustments = pgTable(
  "matchup_adjustments",
  {
    id: id(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    matchupId: uuid("matchup_id")
      .notNull()
      .references(() => matchups.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    points: numeric("points", { mode: "number" }).notNull(),
    reason: text("reason").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("matchup_adjustments_matchup_idx").on(t.matchupId)],
);

export type Message = typeof messages.$inferSelect;
export type ActivityLogRow = typeof activityLog.$inferSelect;
export type MatchupAdjustment = typeof matchupAdjustments.$inferSelect;
