import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
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

export const leagues = pgTable("leagues", {
  id: id(),
  name: text("name").notNull(),
  season: integer("season").notNull(), // ESPN season year (2027 = 2026-27)
  commissionerId: uuid("commissioner_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  status: text("status").$type<LeagueStatus>().notNull().default("setup"),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull(),
  createdAt: createdAt(),
});

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
  expiresAt: tstz("expires_at").notNull(),
  usedBy: uuid("used_by").references(() => users.id, { onDelete: "set null" }),
  usedAt: tstz("used_at"),
  createdAt: createdAt(),
});

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

export type AcquiredVia = "draft" | "add" | "trade" | "commissioner";

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
