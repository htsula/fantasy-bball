import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { inviteRedemptions, invites, teams, users } from "@/db/schema";
import { createLeague, createLeagueInvite, redeemLeagueInvite } from "@/lib/leagues/service";
import type { Db } from "@/db/types";
import {
  AuthError,
  INVITE_TTL_MS,
  createInvite,
  createUser,
  getInviteStatus,
  redeemInvite,
} from "@/lib/auth/service";
import { hashToken } from "@/lib/auth/tokens";
import { createTestDb } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
let adminId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  adminId = (await createUser(db, { username: "root", password: "password123", isSiteAdmin: true })).id;
});
afterAll(() => close());

const form = (token: string, username: string) => ({
  token,
  username,
  password: "password123",
});

describe("invite redemption", () => {
  it("stores only the token hash and expires in 7 days", async () => {
    const now = new Date();
    const { token, expiresAt } = await createInvite(db, { createdBy: adminId }, now);
    expect(expiresAt.getTime() - now.getTime()).toBe(INVITE_TTL_MS);
    const [row] = await db.select().from(invites).where(eq(invites.tokenHash, hashToken(token)));
    expect(row.tokenHash).not.toBe(token);
    expect(await getInviteStatus(db, token)).toBe("valid");
  });

  it("redeems a valid invite: creates the user and marks it used", async () => {
    const { token } = await createInvite(db, { createdBy: adminId });
    const user = await redeemInvite(db, form(token, "Alice"));
    expect(user.username).toBe("Alice");
    expect(user.isSiteAdmin).toBe(false);
    const [row] = await db.select().from(invites).where(eq(invites.tokenHash, hashToken(token)));
    expect(row.usedBy).toBe(user.id);
    expect(row.usedAt).not.toBeNull();
    expect(await getInviteStatus(db, token)).toBe("used");
  });

  it("rejects an expired invite and creates no user", async () => {
    const past = new Date(Date.now() - INVITE_TTL_MS - 60_000);
    const { token } = await createInvite(db, { createdBy: adminId }, past);
    expect(await getInviteStatus(db, token)).toBe("expired");
    await expect(redeemInvite(db, form(token, "expired_user"))).rejects.toMatchObject({ code: "invalid_token" });
    expect(await db.select().from(users).where(eq(users.username, "expired_user"))).toHaveLength(0);
  });

  it("rejects a reused invite", async () => {
    const { token } = await createInvite(db, { createdBy: adminId });
    await redeemInvite(db, form(token, "first_use"));
    await expect(redeemInvite(db, form(token, "second_use"))).rejects.toBeInstanceOf(AuthError);
    expect(await db.select().from(users).where(eq(users.username, "second_use"))).toHaveLength(0);
  });

  it("rejects an unknown token", async () => {
    expect(await getInviteStatus(db, "nope")).toBe("invalid");
    await expect(redeemInvite(db, form("nope", "ghost"))).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("rejects duplicate usernames case-insensitively without burning the invite", async () => {
    const { token } = await createInvite(db, { createdBy: adminId });
    await expect(redeemInvite(db, form(token, "ROOT"))).rejects.toMatchObject({ code: "username_taken" });
    expect(await getInviteStatus(db, token)).toBe("valid");
  });
});

describe("site-level vs league invites", () => {
  it("site invites stay single-use, hash-only, and expire after 7 days", async () => {
    const { token, expiresAt } = await createInvite(db, { createdBy: adminId });
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(INVITE_TTL_MS - 60_000);
    const [row] = await db.select().from(invites).where(eq(invites.tokenHash, hashToken(token)));
    expect(row).toMatchObject({ token: null, leagueId: null, useCount: 0, revokedAt: null, maxUses: null });
    await redeemInvite(db, form(token, "site_once"));
    expect(await getInviteStatus(db, token)).toBe("used");
    await expect(redeemInvite(db, form(token, "site_twice"))).rejects.toMatchObject({ code: "invalid_token" });
    const past = new Date(Date.now() - INVITE_TTL_MS - 1000);
    const old = await createInvite(db, { createdBy: adminId }, past);
    expect(await getInviteStatus(db, old.token)).toBe("expired");
  });

  it("league invites are multi-use with no expiry and a stored token", async () => {
    const commissioner = { id: adminId, isSiteAdmin: true };
    const league = await createLeague(db, commissioner, { name: "Multi", season: 2027, teamName: "Boss", teamAbbrev: "BOS" });
    const { token, expiresAt } = await createLeagueInvite(db, commissioner, league.id);
    expect(expiresAt).toBeNull();
    const [row] = await db.select().from(invites).where(eq(invites.tokenHash, hashToken(token)));
    expect(row).toMatchObject({ token, expiresAt: null });
    for (const i of [1, 2, 3]) {
      await redeemLeagueInvite(db, {
        token,
        username: `multi${i}`,
        password: "password123",
        teamName: `Multi ${i}`,
        teamAbbrev: `M${"ABC"[i - 1]}X`,
      });
    }
    expect((await db.select().from(teams).where(eq(teams.leagueId, league.id)))).toHaveLength(4);
    expect((await db.select().from(inviteRedemptions).where(eq(inviteRedemptions.inviteId, row.id)))).toHaveLength(3);
  });
});
