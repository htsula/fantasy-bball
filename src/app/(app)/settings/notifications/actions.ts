"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requireUser } from "@/lib/auth/session";
import {
  deleteSubscription,
  isNotificationType,
  saveSubscription,
  sendTestNotification,
  setPref,
} from "@/lib/notifications/service";

export type SimpleResult = { ok: true } | { ok: false; error: string };

/** `subscription` is PushSubscription.toJSON() from the browser. */
export async function saveSubscriptionAction(subscription: unknown): Promise<SimpleResult> {
  const user = await requireUser();
  try {
    await saveSubscription(db, user.id, subscription, (await headers()).get("user-agent"));
    return { ok: true };
  } catch {
    return { ok: false, error: "That device's push subscription was not valid." };
  }
}

export async function deleteSubscriptionAction(endpoint: string): Promise<SimpleResult> {
  const user = await requireUser();
  await deleteSubscription(db, user.id, String(endpoint));
  return { ok: true };
}

export async function sendTestNotificationAction(): Promise<SimpleResult> {
  const user = await requireUser();
  const r = await sendTestNotification(db, user.id);
  if (r.ok) return { ok: true };
  const error = {
    not_configured: "Push isn't configured on the server yet (the VAPID keys are missing). In-app notifications still work.",
    no_devices: "No device is subscribed yet. Enable notifications on this device first.",
    failed: "The push service rejected the message. Try turning notifications off and on again on this device.",
  }[r.reason];
  return { ok: false, error };
}

export async function setPrefAction(type: string, channel: "push" | "inApp", value: boolean): Promise<SimpleResult> {
  const user = await requireUser();
  if (!isNotificationType(type) || (channel !== "push" && channel !== "inApp")) return { ok: false, error: "Invalid request." };
  await setPref(db, user.id, type, { [channel]: Boolean(value) });
  revalidatePath("/settings/notifications");
  return { ok: true };
}
