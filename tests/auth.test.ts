import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { loginAttempts, sessions } from "@/db/schema";
import type { Db } from "@/db/types";
import {
  LOCKOUT_MS,
  MAX_FAILED_LOGINS,
  RESET_TTL_MS,
  SESSION_TTL_MS,
  authenticate,
  createPasswordReset,
  createSession,
  createUser,
  AuthError,
  deleteSession,
  redeemPasswordReset,
  setPasswordByUsername,
  validateSession,
} from "@/lib/auth/service";
import { hashToken } from "@/lib/auth/tokens";
import { createTestDb } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
let userId: string;
let adminId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  adminId = (await createUser(db, { username: "boss", password: "password123", isSiteAdmin: true })).id;
  userId = (await createUser(db, { username: "Bob", password: "password123" })).id;
});
afterAll(() => close());

describe("login", () => {
  it("succeeds with correct credentials (case-insensitive username)", async () => {
    const res = await authenticate(db, "bob", "password123");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.user.id).toBe(userId);
  });

  it("fails with a wrong password or unknown user, with the same error", async () => {
    expect(await authenticate(db, "Bob", "wrongpass")).toEqual({ ok: false, reason: "invalid" });
    expect(await authenticate(db, "nobody", "password123")).toEqual({ ok: false, reason: "invalid" });
  });

  it("locks the account after repeated failures, then recovers", async () => {
    const t0 = new Date();
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) await authenticate(db, "boss", "bad-password", t0);
    // Even the correct password is refused while locked.
    const locked = await authenticate(db, "boss", "password123", t0);
    expect(locked).toMatchObject({ ok: false, reason: "locked" });
    const later = new Date(t0.getTime() + LOCKOUT_MS + 1000);
    expect((await authenticate(db, "boss", "password123", later)).ok).toBe(true);
  });
});

describe("sessions", () => {
  it("stores only the hash, validates, and deletes on logout", async () => {
    const { token } = await createSession(db, userId);
    expect(await db.select().from(sessions).where(eq(sessions.id, token))).toHaveLength(0);
    expect(await db.select().from(sessions).where(eq(sessions.id, hashToken(token)))).toHaveLength(1);
    expect((await validateSession(db, token))?.id).toBe(userId);
    await deleteSession(db, token);
    expect(await validateSession(db, token)).toBeNull();
  });

  it("rejects expired sessions and slides valid ones", async () => {
    const old = new Date(Date.now() - SESSION_TTL_MS - 1000);
    const expired = await createSession(db, userId, old);
    expect(await validateSession(db, expired.token)).toBeNull();

    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const { token } = await createSession(db, userId, twoDaysAgo);
    expect(await validateSession(db, token)).not.toBeNull();
    const [row] = await db.select().from(sessions).where(eq(sessions.id, hashToken(token)));
    expect(row.expiresAt.getTime()).toBeGreaterThan(twoDaysAgo.getTime() + SESSION_TTL_MS + 24 * 60 * 60 * 1000);
  });
});

describe("password reset", () => {
  it("sets the new password and invalidates all of the user's sessions", async () => {
    const s1 = await createSession(db, userId);
    const s2 = await createSession(db, userId);
    const other = await createSession(db, adminId);

    const now = new Date();
    const { token, expiresAt } = await createPasswordReset(db, { userId, createdBy: adminId }, now);
    expect(expiresAt.getTime() - now.getTime()).toBe(RESET_TTL_MS);
    await redeemPasswordReset(db, { token, password: "brand-new-pass" });

    expect(await validateSession(db, s1.token)).toBeNull();
    expect(await validateSession(db, s2.token)).toBeNull();
    expect(await validateSession(db, other.token)).not.toBeNull(); // other users unaffected
    expect((await authenticate(db, "Bob", "password123")).ok).toBe(false);
    expect((await authenticate(db, "Bob", "brand-new-pass")).ok).toBe(true);
  });

  it("is single-use and rejects expired tokens", async () => {
    const { token } = await createPasswordReset(db, { userId, createdBy: adminId });
    await redeemPasswordReset(db, { token, password: "another-pass-1" });
    await expect(redeemPasswordReset(db, { token, password: "another-pass-2" })).rejects.toMatchObject({
      code: "invalid_token",
    });

    const past = new Date(Date.now() - RESET_TTL_MS - 1000);
    const expired = await createPasswordReset(db, { userId, createdBy: adminId }, past);
    await expect(redeemPasswordReset(db, { token: expired.token, password: "another-pass-3" })).rejects.toMatchObject({
      code: "invalid_token",
    });
  });
});

describe("setPasswordByUsername (owner recovery)", () => {
  it("replaces the password, kills sessions, clears lockout, keeps admin flag", async () => {
    const admin = await createUser(db, { username: "Recover", password: "old-password1", isSiteAdmin: true });
    await createSession(db, admin.id);
    await createSession(db, admin.id);
    const t0 = new Date();
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) await authenticate(db, "recover", "bad-password", t0);
    expect(await authenticate(db, "recover", "old-password1", t0)).toMatchObject({ reason: "locked" });

    const updated = await setPasswordByUsername(db, "RECOVER", "new-password1");
    expect(updated.id).toBe(admin.id);
    expect(updated.isSiteAdmin).toBe(true);

    expect(await db.select().from(sessions).where(eq(sessions.userId, admin.id))).toHaveLength(0);
    expect(await db.select().from(loginAttempts).where(eq(loginAttempts.usernameKey, "recover"))).toHaveLength(0);
    expect((await authenticate(db, "recover", "old-password1", t0)).ok).toBe(false);
    const ok = await authenticate(db, "recover", "new-password1", t0);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.user.isSiteAdmin).toBe(true);
  });

  it("does not promote a non-admin", async () => {
    const u = await createUser(db, { username: "plain", password: "old-password1" });
    const updated = await setPasswordByUsername(db, "plain", "new-password1");
    expect(updated.id).toBe(u.id);
    expect(updated.isSiteAdmin).toBe(false);
  });

  it("throws for an unknown username and creates nothing", async () => {
    await expect(setPasswordByUsername(db, "ghost", "new-password1")).rejects.toMatchObject({
      code: "user_not_found",
    });
    await expect(setPasswordByUsername(db, "ghost", "new-password1")).rejects.toBeInstanceOf(AuthError);
    expect((await authenticate(db, "ghost", "new-password1")).ok).toBe(false);
  });
});
