import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { notificationPrefs, notifications, pushSubscriptions } from "@/db/schema";
import type { Db } from "@/db/types";
import { createUser } from "@/lib/auth/service";
import { setPushSender, type PushSender } from "@/lib/notifications/push";
import {
  deleteSubscription,
  getPrefs,
  listNotifications,
  markAllRead,
  markRead,
  notify,
  saveSubscription,
  sendTestNotification,
  setPref,
  unreadCount,
} from "@/lib/notifications/service";
import { createTestDb } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
let a: string;
let b: string;

const sub = (name: string) => ({ endpoint: `https://push.example/${name}`, keys: { p256dh: `p-${name}`, auth: `a-${name}` } });
const input = (userIds: string[], type: "draft_on_clock" | "draft_events" | "test" = "draft_on_clock") => ({
  userIds,
  leagueId: null,
  type,
  title: "T",
  body: "B",
  url: "/leagues/x/draft",
});

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  a = (await createUser(db, { username: "alice", password: "password123" })).id;
  b = (await createUser(db, { username: "bob", password: "password123" })).id;
});
afterAll(() => {
  setPushSender(undefined);
  return close();
});
beforeEach(async () => {
  await db.delete(pushSubscriptions);
  await db.delete(notifications);
  await db.delete(notificationPrefs);
  setPushSender(undefined);
});

describe("notify", () => {
  it("writes in-app rows and pushes to every device of the recipients only", async () => {
    await saveSubscription(db, a, sub("a1"));
    await saveSubscription(db, a, sub("a2"));
    await saveSubscription(db, b, sub("b1"));
    const sender = vi.fn<PushSender>().mockResolvedValue();
    await notify(db, input([a]), { sender });
    expect(sender).toHaveBeenCalledTimes(2);
    expect(sender.mock.calls.map((c) => c[0].endpoint).sort()).toEqual(["https://push.example/a1", "https://push.example/a2"]);
    expect(JSON.parse(sender.mock.calls[0][1])).toMatchObject({ title: "T", body: "B", url: "/leagues/x/draft" });
    expect(await unreadCount(db, a)).toBe(1);
    expect(await unreadCount(db, b)).toBe(0);
    const [row] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub("a1").endpoint));
    expect(row.lastSuccessAt).not.toBeNull();
  });

  it("de-duplicates recipients", async () => {
    await notify(db, input([a, a, a]), { sender: null });
    expect(await unreadCount(db, a)).toBe(1);
  });

  it("skips push (but keeps in-app) when push is not configured", async () => {
    await saveSubscription(db, a, sub("a1"));
    await notify(db, input([a]), { sender: null });
    expect(await unreadCount(db, a)).toBe(1);
  });

  it("uses the injected global sender, and does nothing without VAPID env", async () => {
    await saveSubscription(db, a, sub("a1"));
    const sender = vi.fn<PushSender>().mockResolvedValue();
    setPushSender(sender);
    await notify(db, input([a]));
    expect(sender).toHaveBeenCalledOnce();
    setPushSender(undefined);
    const before = { ...process.env };
    delete process.env.VAPID_PUBLIC_KEY;
    await notify(db, input([a])); // would throw/hit network if it tried the real sender
    process.env = before;
    expect(await unreadCount(db, a)).toBe(2);
  });

  it("respects per-type preferences for push and in-app", async () => {
    await saveSubscription(db, a, sub("a1"));
    await saveSubscription(db, b, sub("b1"));
    await setPref(db, a, "draft_on_clock", { push: false });
    await setPref(db, b, "draft_on_clock", { inApp: false });
    const sender = vi.fn<PushSender>().mockResolvedValue();
    await notify(db, input([a, b]), { sender });
    expect(sender.mock.calls.map((c) => c[0].endpoint)).toEqual([sub("b1").endpoint]);
    expect(await unreadCount(db, a)).toBe(1);
    expect(await unreadCount(db, b)).toBe(0);
    // Other types are unaffected.
    await notify(db, input([a, b], "draft_events"), { sender });
    expect(sender).toHaveBeenCalledTimes(3);
    expect((await getPrefs(db, a)).draft_events).toEqual({ push: true, inApp: true });
    expect((await getPrefs(db, a)).draft_on_clock).toEqual({ push: false, inApp: true });
  });

  it("sends league_transactions in-app only by default, until the user turns push on", async () => {
    await saveSubscription(db, a, sub("a1"));
    const sender = vi.fn<PushSender>().mockResolvedValue();
    const move = { ...input([a]), type: "league_transactions" as const };
    await notify(db, move, { sender });
    expect(sender).not.toHaveBeenCalled();
    expect(await unreadCount(db, a)).toBe(1);
    expect((await getPrefs(db, a)).league_transactions).toEqual({ push: false, inApp: true });
    expect((await getPrefs(db, a)).roster_auto_drop).toEqual({ push: true, inApp: true });
    await setPref(db, a, "league_transactions", { push: true });
    await notify(db, move, { sender });
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("deletes a subscription on 410 or 404 and keeps the others", async () => {
    await saveSubscription(db, a, sub("gone"));
    await saveSubscription(db, a, sub("missing"));
    await saveSubscription(db, a, sub("ok"));
    const sender: PushSender = async (t) => {
      if (t.endpoint.endsWith("gone")) throw Object.assign(new Error("Gone"), { statusCode: 410 });
      if (t.endpoint.endsWith("missing")) throw Object.assign(new Error("Not found"), { statusCode: 404 });
    };
    await notify(db, input([a]), { sender });
    const left = await db.select().from(pushSubscriptions);
    expect(left.map((s) => s.endpoint)).toEqual([sub("ok").endpoint]);
  });

  it("counts transient failures and drops a subscription after repeated ones, never throwing", async () => {
    await saveSubscription(db, a, sub("flaky"));
    const sender: PushSender = async () => {
      throw Object.assign(new Error("boom"), { statusCode: 500 });
    };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(notify(db, input([a]), { sender })).resolves.toBeUndefined();
    const [row] = await db.select().from(pushSubscriptions);
    expect(row.failureCount).toBe(1);
    for (let i = 0; i < 4; i++) await notify(db, input([a]), { sender });
    expect(await db.select().from(pushSubscriptions)).toHaveLength(0);
    quiet.mockRestore();
  });

  it("never throws even if the database fails", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { select: () => { throw new Error("db down"); } } as unknown as Db;
    await expect(notify(broken, input([a]))).resolves.toBeUndefined();
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
  });
});

describe("subscriptions and test push", () => {
  it("upserts by endpoint, moving it to the latest user", async () => {
    await saveSubscription(db, a, sub("shared"), "UA-1");
    await saveSubscription(db, b, sub("shared"), "UA-2");
    const rows = await db.select().from(pushSubscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: b, userAgent: "UA-2" });
    await deleteSubscription(db, a, sub("shared").endpoint); // not the owner: no-op
    expect(await db.select().from(pushSubscriptions)).toHaveLength(1);
    await deleteSubscription(db, b, sub("shared").endpoint);
    expect(await db.select().from(pushSubscriptions)).toHaveLength(0);
  });

  it("rejects malformed subscriptions", async () => {
    await expect(saveSubscription(db, a, { endpoint: "http://insecure.example/x", keys: { p256dh: "p", auth: "a" } })).rejects.toThrow();
    await expect(saveSubscription(db, a, { endpoint: "https://x.example/y" })).rejects.toThrow();
  });

  it("sendTestNotification explains why nothing was sent", async () => {
    expect(await sendTestNotification(db, a, { sender: null })).toEqual({ ok: false, reason: "not_configured" });
    const sender = vi.fn<PushSender>().mockResolvedValue();
    expect(await sendTestNotification(db, a, { sender })).toEqual({ ok: false, reason: "no_devices" });
    await saveSubscription(db, a, sub("a1"));
    expect(await sendTestNotification(db, a, { sender })).toEqual({ ok: true, delivered: 1 });
  });
});

describe("in-app inbox", () => {
  it("lists newest first and marks read (own rows only)", async () => {
    await notify(db, { ...input([a]), title: "first" }, { sender: null });
    await new Promise((r) => setTimeout(r, 5));
    await notify(db, { ...input([a]), title: "second" }, { sender: null });
    await notify(db, { ...input([b]), title: "bobs" }, { sender: null });
    const list = await listNotifications(db, a);
    expect(list.map((x) => x.title)).toEqual(["second", "first"]);
    await markRead(db, b, list[0].id); // someone else's: ignored
    expect(await unreadCount(db, a)).toBe(2);
    await markRead(db, a, list[0].id);
    expect(await unreadCount(db, a)).toBe(1);
    await markRead(db, a, "not-a-uuid");
    await markAllRead(db, a);
    expect(await unreadCount(db, a)).toBe(0);
    expect(await unreadCount(db, b)).toBe(1);
  });
});
