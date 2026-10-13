"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { db } from "@/db";
import { createInvite, createPasswordReset } from "@/lib/auth/service";
import { requireAdmin } from "@/lib/auth/session";
import { createEspnClient } from "@/lib/nba/espn";
import { syncDaily, syncLive } from "@/lib/nba/sync";

export type LinkState = { url?: string; expiresAt?: string; error?: string };

/** Absolute base URL for links we hand out; prefers NEXT_PUBLIC_APP_URL. */
async function baseUrl() {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured) return configured.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

export async function createInviteAction(): Promise<LinkState> {
  const admin = await requireAdmin(); // always re-check: actions are public endpoints
  const { token, expiresAt } = await createInvite(db, { createdBy: admin.id });
  revalidatePath("/admin");
  return { url: `${await baseUrl()}/invite/${token}`, expiresAt: expiresAt.toISOString() };
}

export async function createResetAction(userId: string): Promise<LinkState> {
  const admin = await requireAdmin();
  if (!z.string().uuid().safeParse(userId).success) return { error: "Invalid user" };
  const { token, expiresAt } = await createPasswordReset(db, { userId, createdBy: admin.id });
  return { url: `${await baseUrl()}/reset/${token}`, expiresAt: expiresAt.toISOString() };
}

/** Runs an NBA data sync immediately (admin only; the result shows up in the Data sync table). */
export async function runSyncAction(job: "daily" | "live"): Promise<void> {
  await requireAdmin();
  if (job !== "daily" && job !== "live") return;
  const client = createEspnClient();
  if (job === "daily") await syncDaily(db, client, { budgetMs: 40_000 });
  else await syncLive(db, client);
  revalidatePath("/admin");
}
