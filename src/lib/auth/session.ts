/** Cookie-aware helpers for server components and actions (uses next/headers). */
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import type { User } from "@/db/schema";
import { SESSION_COOKIE } from "./constants";
import { createSession, deleteSession, validateSession } from "./service";

export async function startSession(userId: string) {
  const { token, expiresAt } = await createSession(db, userId);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

/** Deduped per request, so layouts and pages can both call it cheaply. */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return validateSession(db, token);
});

export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireAdmin(): Promise<User> {
  const user = await requireUser();
  if (!user.isSiteAdmin) redirect("/");
  return user;
}

export async function endSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await deleteSession(db, token);
  jar.delete(SESSION_COOKIE);
}
