import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
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
    displayName: text("display_name").notNull(),
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

export type User = typeof users.$inferSelect;
export type Invite = typeof invites.$inferSelect;
