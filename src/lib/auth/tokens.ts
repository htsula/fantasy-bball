import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Random 32-byte token, base64url encoded. Given to the user; only its hash is stored. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** sha256 hex digest, used as the DB key for sessions, invites and resets. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time check that a raw token matches a stored hash. */
export function tokenMatchesHash(token: string, hash: string): boolean {
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
