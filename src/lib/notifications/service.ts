/** In-app notifications + Web Push fan-out. `notify` never throws into the caller. */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { notificationPrefs, notifications, pushSubscriptions, type AppNotification } from "@/db/schema";
import type { Db } from "@/db/types";
import { z } from "zod";
import { getPushSender, type PushSender } from "./push";
import { NOTIFICATION_TYPES, isNotificationType, type NotificationType, type NotifyInput } from "./types";

export * from "./types";

/** Signature the draft service depends on, so tests can capture notifications. */
export type Notifier = (db: Db, input: NotifyInput) => Promise<void>;

const MAX_FAILURES = 5;

type PrefMap = Record<NotificationType, { push: boolean; inApp: boolean }>;

export async function getPrefs(db: Db, userId: string): Promise<PrefMap> {
  const rows = await db.select().from(notificationPrefs).where(eq(notificationPrefs.userId, userId));
  const out = Object.fromEntries(NOTIFICATION_TYPES.map((t) => [t, { push: true, inApp: true }])) as PrefMap;
  for (const r of rows) if (isNotificationType(r.type)) out[r.type] = { push: r.push, inApp: r.inApp };
  return out;
}

export async function setPref(
  db: Db,
  userId: string,
  type: string,
  patch: { push?: boolean; inApp?: boolean },
): Promise<void> {
  if (!isNotificationType(type)) throw new Error("Unknown notification type");
  const current = (await getPrefs(db, userId))[type];
  const next = { push: patch.push ?? current.push, inApp: patch.inApp ?? current.inApp };
  await db
    .insert(notificationPrefs)
    .values({ userId, type, ...next })
    .onConflictDoUpdate({ target: [notificationPrefs.userId, notificationPrefs.type], set: next });
}

const subscriptionSchema = z.object({
  endpoint: z.string().url().max(2048).startsWith("https://"),
  keys: z.object({ p256dh: z.string().min(1).max(512), auth: z.string().min(1).max(256) }),
});

/** Stores (or moves) a device's push subscription. Throws on malformed input. */
export async function saveSubscription(db: Db, userId: string, raw: unknown, userAgent?: string | null) {
  const sub = subscriptionSchema.parse(raw);
  const ua = userAgent?.slice(0, 300) ?? null;
  await db
    .insert(pushSubscriptions)
    .values({ userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: ua })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: ua, failureCount: 0 },
    });
}

export async function deleteSubscription(db: Db, userId: string, endpoint: string) {
  await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
}

export async function countSubscriptions(db: Db, userId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));
  return r.n;
}

function statusOf(err: unknown): number | undefined {
  return (err as { statusCode?: number } | null)?.statusCode;
}

/** Sends to every subscription of the given users. Returns the number of successful deliveries. */
async function pushToUsers(db: Db, userIds: string[], payload: string, sender: PushSender): Promise<number> {
  if (userIds.length === 0) return 0;
  const subs = await db.select().from(pushSubscriptions).where(inArray(pushSubscriptions.userId, userIds));
  const results = await Promise.allSettled(
    subs.map(async (s) => {
      try {
        await sender({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, payload);
      } catch (err) {
        const status = statusOf(err);
        if (status === 404 || status === 410 || s.failureCount + 1 >= MAX_FAILURES) {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
        } else {
          await db
            .update(pushSubscriptions)
            .set({ failureCount: sql`${pushSubscriptions.failureCount} + 1` })
            .where(eq(pushSubscriptions.id, s.id));
        }
        throw err;
      }
      await db
        .update(pushSubscriptions)
        .set({ lastSuccessAt: new Date(), failureCount: 0 })
        .where(eq(pushSubscriptions.id, s.id));
    }),
  );
  return results.filter((r) => r.status === "fulfilled").length;
}

/**
 * Writes in-app rows for users who have them enabled and pushes to users who have push enabled.
 * Call AFTER the originating transaction commits. Errors are logged, never thrown.
 */
export async function notify(db: Db, input: NotifyInput, opts: { sender?: PushSender | null } = {}): Promise<void> {
  try {
    const userIds = [...new Set(input.userIds)];
    if (userIds.length === 0) return;
    const prefRows =
      input.type === "test"
        ? []
        : await db
            .select()
            .from(notificationPrefs)
            .where(and(inArray(notificationPrefs.userId, userIds), eq(notificationPrefs.type, input.type)));
    const prefs = new Map(prefRows.map((p) => [p.userId, p]));
    const inApp = userIds.filter((u) => prefs.get(u)?.inApp !== false);
    const push = userIds.filter((u) => prefs.get(u)?.push !== false);

    if (inApp.length) {
      await db.insert(notifications).values(
        inApp.map((userId) => ({
          userId,
          leagueId: input.leagueId,
          type: input.type,
          title: input.title,
          body: input.body,
          url: input.url,
        })),
      );
    }

    const sender = opts.sender === undefined ? getPushSender() : opts.sender;
    if (sender && push.length) {
      const payload = JSON.stringify({ title: input.title, body: input.body, url: input.url, tag: input.type });
      await pushToUsers(db, push, payload, sender).catch((err) => console.error("[notify] push failed", err));
    }
  } catch (err) {
    console.error("[notify] failed", err);
  }
}

/** The default Notifier used by the app. */
export const notifier: Notifier = (db, input) => notify(db, input);

/** Test push to one user's devices. Reports why nothing was sent so the UI can explain. */
export async function sendTestNotification(
  db: Db,
  userId: string,
  opts: { sender?: PushSender | null } = {},
): Promise<{ ok: true; delivered: number } | { ok: false; reason: "not_configured" | "no_devices" | "failed" }> {
  const sender = opts.sender === undefined ? getPushSender() : opts.sender;
  if (!sender) return { ok: false, reason: "not_configured" };
  if ((await countSubscriptions(db, userId)) === 0) return { ok: false, reason: "no_devices" };
  const payload = JSON.stringify({
    title: "Fantasy Hoops",
    body: "Test notification. Push is working on this device.",
    url: "/settings/notifications",
    tag: "test",
  });
  try {
    const delivered = await pushToUsers(db, [userId], payload, sender);
    return delivered > 0 ? { ok: true, delivered } : { ok: false, reason: "failed" };
  } catch (err) {
    console.error("[notify] test push failed", err);
    return { ok: false, reason: "failed" };
  }
}

// ----------------------------------------------------------------------------- in-app reads

export async function listNotifications(db: Db, userId: string, limit = 50): Promise<AppNotification[]> {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit);
}

export async function unreadCount(db: Db, userId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return r.n;
}

export async function markRead(db: Db, userId: string, id: string): Promise<void> {
  if (!z.string().uuid().safeParse(id).success) return;
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId), isNull(notifications.readAt)));
}

export async function markAllRead(db: Db, userId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
}
