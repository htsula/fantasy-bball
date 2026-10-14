"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requireUser } from "@/lib/auth/session";
import { markAllRead, markRead } from "@/lib/notifications/service";

export async function markReadAction(id: string): Promise<void> {
  const user = await requireUser();
  await markRead(db, user.id, id);
  revalidatePath("/", "layout");
}

export async function markAllReadAction(): Promise<void> {
  const user = await requireUser();
  await markAllRead(db, user.id);
  revalidatePath("/", "layout");
}
