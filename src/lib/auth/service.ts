/**
 * Auth domain logic. Every function takes the `db` explicitly so tests can
 * pass an in-memory PGlite instance; server actions pass the app-wide db.
 */
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { invites, loginAttempts, passwordResets, sessions, users, type User } from "@/db/schema";
import type { Db } from "@/db/types";
import { hashPassword, verifyPassword } from "./password";
import { generateToken, hashToken } from "./tokens";

const DAY = 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 30 * DAY;
export const INVITE_TTL_MS = 7 * DAY;
export const RESET_TTL_MS = 1 * DAY;
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;
// Only extend a session in the DB when at least a day has elapsed since the last extension.
const SLIDE_AFTER_MS = 1 * DAY;

export class AuthError extends Error {
  constructor(public code: "username_taken" | "invalid_token") {
    super(code);
  }
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

const lowerUsername = (name: string) => name.trim().toLowerCase();

// ---------------------------------------------------------------- users

export async function createUser(
  db: Db,
  input: { username: string; displayName: string; password: string; isSiteAdmin?: boolean },
): Promise<User> {
  try {
    const [user] = await db
      .insert(users)
      .values({
        username: input.username.trim(),
        displayName: input.displayName.trim(),
        passwordHash: await hashPassword(input.password),
        isSiteAdmin: input.isSiteAdmin ?? false,
      })
      .returning();
    return user;
  } catch (err) {
    if (isUniqueViolation(err)) throw new AuthError("username_taken");
    throw err;
  }
}

export async function findUserByUsername(db: Db, username: string): Promise<User | undefined> {
  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = ${lowerUsername(username)}`)
    .limit(1);
  return user;
}

// ------------------------------------------------------------- sessions

export async function createSession(db: Db, userId: string, now = new Date()) {
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({ id: hashToken(token), userId, expiresAt });
  return { token, expiresAt };
}

/** Returns the session's user, or null. Slides the expiry forward when due. */
export async function validateSession(
  db: Db,
  token: string,
  now = new Date(),
): Promise<User | null> {
  const id = hashToken(token);
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .limit(1);
  if (!row) return null;
  if (row.session.expiresAt <= now) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }
  const newExpiry = new Date(now.getTime() + SESSION_TTL_MS);
  if (newExpiry.getTime() - row.session.expiresAt.getTime() >= SLIDE_AFTER_MS) {
    await db.update(sessions).set({ expiresAt: newExpiry }).where(eq(sessions.id, id));
  }
  return row.user;
}

export async function deleteSession(db: Db, token: string) {
  await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
}

export async function deleteUserSessions(db: Db, userId: string) {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

// ---------------------------------------------------------------- login

export type AuthResult =
  | { ok: true; user: User }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "locked"; retryAfterMs: number };

// A throwaway hash so unknown usernames cost the same time as wrong passwords.
let dummyHash: Promise<string> | undefined;

/** Checks credentials with per-username lockout after repeated failures. */
export async function authenticate(
  db: Db,
  username: string,
  password: string,
  now = new Date(),
): Promise<AuthResult> {
  const key = lowerUsername(username);
  const [attempt] = await db.select().from(loginAttempts).where(eq(loginAttempts.usernameKey, key));

  if (attempt?.lockedUntil && attempt.lockedUntil > now) {
    return { ok: false, reason: "locked", retryAfterMs: attempt.lockedUntil.getTime() - now.getTime() };
  }

  const user = await findUserByUsername(db, username);
  let valid = false;
  if (user) {
    valid = await verifyPassword(user.passwordHash, password);
  } else {
    dummyHash ??= hashPassword("not-a-real-password");
    await verifyPassword(await dummyHash, password);
  }

  if (valid && user) {
    if (attempt) await db.delete(loginAttempts).where(eq(loginAttempts.usernameKey, key));
    return { ok: true, user };
  }

  // Failures older than the lockout window start a fresh count.
  const stale = !attempt || now.getTime() - attempt.lastFailedAt.getTime() > LOCKOUT_MS;
  const failures = stale ? 1 : attempt.failures + 1;
  const lockedUntil = failures >= MAX_FAILED_LOGINS ? new Date(now.getTime() + LOCKOUT_MS) : null;
  await db
    .insert(loginAttempts)
    .values({ usernameKey: key, failures, lastFailedAt: now, lockedUntil })
    .onConflictDoUpdate({
      target: loginAttempts.usernameKey,
      set: { failures, lastFailedAt: now, lockedUntil },
    });
  return { ok: false, reason: "invalid" };
}

// -------------------------------------------------------------- invites

export async function createInvite(
  db: Db,
  input: { createdBy: string; leagueId?: string | null },
  now = new Date(),
) {
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  await db.insert(invites).values({
    tokenHash: hashToken(token),
    createdBy: input.createdBy,
    leagueId: input.leagueId ?? null,
    expiresAt,
  });
  return { token, expiresAt };
}

export type TokenStatus = "valid" | "used" | "expired" | "invalid";

export async function getInviteStatus(db: Db, token: string, now = new Date()): Promise<TokenStatus> {
  const [invite] = await db.select().from(invites).where(eq(invites.tokenHash, hashToken(token)));
  if (!invite) return "invalid";
  if (invite.usedAt) return "used";
  if (invite.expiresAt <= now) return "expired";
  return "valid";
}

/** Creates the user and consumes the invite atomically. Throws AuthError on failure. */
export async function redeemInvite(
  db: Db,
  input: { token: string; username: string; displayName: string; password: string },
  now = new Date(),
): Promise<User> {
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    let user: User;
    try {
      [user] = await tx
        .insert(users)
        .values({
          username: input.username.trim(),
          displayName: input.displayName.trim(),
          passwordHash,
        })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) throw new AuthError("username_taken");
      throw err;
    }
    // Conditional update makes redemption single-use even under concurrent requests.
    const claimed = await tx
      .update(invites)
      .set({ usedBy: user.id, usedAt: now })
      .where(
        and(
          eq(invites.tokenHash, hashToken(input.token)),
          isNull(invites.usedAt),
          gt(invites.expiresAt, now),
        ),
      )
      .returning({ id: invites.id });
    if (claimed.length === 0) throw new AuthError("invalid_token"); // rolls back the user insert
    return user;
  });
}

// ------------------------------------------------------ password resets

export async function createPasswordReset(
  db: Db,
  input: { userId: string; createdBy: string },
  now = new Date(),
) {
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + RESET_TTL_MS);
  await db.insert(passwordResets).values({
    tokenHash: hashToken(token),
    userId: input.userId,
    createdBy: input.createdBy,
    expiresAt,
  });
  return { token, expiresAt };
}

export async function getResetStatus(db: Db, token: string, now = new Date()): Promise<TokenStatus> {
  const [reset] = await db
    .select()
    .from(passwordResets)
    .where(eq(passwordResets.tokenHash, hashToken(token)));
  if (!reset) return "invalid";
  if (reset.usedAt) return "used";
  if (reset.expiresAt <= now) return "expired";
  return "valid";
}

/** Sets a new password, consumes the token and signs the user out everywhere. */
export async function redeemPasswordReset(
  db: Db,
  input: { token: string; password: string },
  now = new Date(),
) {
  const passwordHash = await hashPassword(input.password);
  await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(passwordResets)
      .set({ usedAt: now })
      .where(
        and(
          eq(passwordResets.tokenHash, hashToken(input.token)),
          isNull(passwordResets.usedAt),
          gt(passwordResets.expiresAt, now),
        ),
      )
      .returning({ userId: passwordResets.userId });
    if (!claimed) throw new AuthError("invalid_token");
    const [user] = await tx
      .update(users)
      .set({ passwordHash })
      .where(eq(users.id, claimed.userId))
      .returning({ username: users.username });
    await tx.delete(sessions).where(eq(sessions.userId, claimed.userId));
    // A reset also clears any login lockout for that account.
    await tx.delete(loginAttempts).where(eq(loginAttempts.usernameKey, lowerUsername(user.username)));
  });
}
