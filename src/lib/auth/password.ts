import { hash, verify } from "@node-rs/argon2";

// @node-rs/argon2 defaults to argon2id with sensible parameters.
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
