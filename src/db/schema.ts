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

export const invites = pgTable("invites", {
  id: id(),
  tokenHash: text("token_hash").notNull().unique(),
  // Will reference leagues(id) once leagues exist (milestone 3).
  leagueId: uuid("league_id"),
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
