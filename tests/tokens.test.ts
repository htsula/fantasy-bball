import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { generateToken, hashToken, tokenMatchesHash } from "@/lib/auth/tokens";

describe("tokens", () => {
  it("generates unique base64url tokens of 32 bytes", () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes -> 43 chars unpadded
    expect(generateToken()).not.toBe(a);
  });

  it("hashes deterministically to sha256 hex without exposing the token", () => {
    const t = generateToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toContain(t);
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("verifies a token against its hash", () => {
    const t = generateToken();
    expect(tokenMatchesHash(t, hashToken(t))).toBe(true);
    expect(tokenMatchesHash(generateToken(), hashToken(t))).toBe(false);
    expect(tokenMatchesHash(t, "not-hex")).toBe(false);
  });
});

describe("passwords", () => {
  it("hashes with argon2 and verifies", async () => {
    const h = await hashPassword("correct horse");
    expect(h).toMatch(/^\$argon2/);
    expect(await verifyPassword(h, "correct horse")).toBe(true);
    expect(await verifyPassword(h, "wrong")).toBe(false);
    expect(await verifyPassword("garbage", "x")).toBe(false);
  });
});
