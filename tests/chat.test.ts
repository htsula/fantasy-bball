import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityLog, messages, notifications, users, type Team } from "@/db/schema";
import type { Db } from "@/db/types";
import { createUser } from "@/lib/auth/service";
import {
  ChatError,
  EDIT_WINDOW_MS,
  RATE_LIMIT_COUNT,
  chatUnreadCount,
  deleteMessage,
  editMessage,
  encodeCursor,
  latestAnnouncement,
  listMessages,
  listPinned,
  markChatRead,
  parseCursor,
  postAnnouncement,
  postMessage,
  setPinned,
  type ChatErrorCode,
} from "@/lib/chat/service";
import { NOTIFICATION_DEFAULTS, setPref } from "@/lib/notifications/service";
import { createTestDb } from "./helpers/db";
import { captureNotifier, type DraftFixture } from "./helpers/draft";
import { seasonLeague } from "./helpers/rosters";

let db: Db;
let close: () => Promise<void> | void;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

const T0 = new Date("2026-11-02T17:00:00Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

type Cast = { fx: DraftFixture; commish: Team; alice: Team; bob: Team; names: Map<string, string> };

/** In-season league with explicit roles: the commissioner and two members (no reliance on row order). */
async function league(): Promise<Cast> {
  const fx = await seasonLeague(db, 3);
  const commish = fx.teams.find((t) => t.ownerId === fx.league.commissionerId)!;
  const [alice, bob] = fx.teams.filter((t) => t.id !== commish.id).sort((a, b) => a.name.localeCompare(b.name));
  const rows = await db.select({ id: users.id, username: users.username }).from(users);
  return { fx, commish, alice, bob, names: new Map(rows.map((r) => [r.id, r.username])) };
}

const as = (t: Team) => ({ id: t.ownerId });
const code = async (p: Promise<unknown>): Promise<ChatErrorCode | "ok"> => {
  try {
    await p;
    return "ok";
  } catch (err) {
    if (err instanceof ChatError) return err.code;
    throw err;
  }
};

describe("posting", () => {
  it("stores the raw text (trimmed), tags the author's team, and rejects bad input", async () => {
    const c = await league();
    const n = captureNotifier();
    const row = await postMessage(db, as(c.alice), c.fx.league.id, { body: "  <b>hi</b> & bye  " }, { notify: n.notify, now: T0 });
    expect(row.body).toBe("<b>hi</b> & bye");
    expect(row.teamId).toBe(c.alice.id);
    expect(row.kind).toBe("message");

    expect(await code(postMessage(db, as(c.alice), c.fx.league.id, { body: "   " }, { notify: n.notify, now: at(1) }))).toBe("invalid_input");
    expect(await code(postMessage(db, as(c.alice), c.fx.league.id, { body: "x".repeat(2001) }, { notify: n.notify, now: at(2) }))).toBe("invalid_input");
    expect(await code(postMessage(db, as(c.alice), c.fx.league.id, { body: "x".repeat(2000) }, { notify: n.notify, now: at(3) }))).toBe("ok");
  });

  it("only league members can post (a site admin without a team and an outsider can't)", async () => {
    const c = await league();
    const outsider = await createUser(db, { username: "outsider", password: "password123" });
    const n = captureNotifier();
    expect(await code(postMessage(db, { id: outsider.id }, c.fx.league.id, { body: "hi" }, { notify: n.notify, now: T0 }))).toBe("forbidden");
    expect(await code(postMessage(db, { id: outsider.id, isSiteAdmin: true }, c.fx.league.id, { body: "hi" }, { notify: n.notify, now: T0 }))).toBe("forbidden");
    // Reading: a site admin may, an outsider may not.
    await listMessages(db, { id: outsider.id, isSiteAdmin: true }, c.fx.league.id);
    expect(await code(listMessages(db, { id: outsider.id }, c.fx.league.id))).toBe("forbidden");
  });

  it("replies must target a message in the same league", async () => {
    const c = await league();
    const other = await league();
    const n = captureNotifier();
    const parent = await postMessage(db, as(c.alice), c.fx.league.id, { body: "first" }, { notify: n.notify, now: T0 });
    const foreign = await postMessage(db, as(other.alice), other.fx.league.id, { body: "elsewhere" }, { notify: n.notify, now: T0 });
    const ok = await postMessage(db, as(c.bob), c.fx.league.id, { body: "re", replyTo: parent.id }, { notify: n.notify, now: at(1) });
    expect(ok.replyTo).toBe(parent.id);
    expect(await code(postMessage(db, as(c.bob), c.fx.league.id, { body: "re", replyTo: foreign.id }, { notify: n.notify, now: at(2) }))).toBe("invalid_input");
    const page = await listMessages(db, as(c.bob), c.fx.league.id, {}, at(3));
    expect(page.messages.find((m) => m.id === ok.id)?.replyTo).toMatchObject({ id: parent.id, snippet: "first" });
  });
});

describe("rate limit", () => {
  it("allows 10 messages per rolling minute per user, then recovers; other users are unaffected", async () => {
    const c = await league();
    const n = captureNotifier();
    for (let i = 0; i < RATE_LIMIT_COUNT; i++) {
      await postMessage(db, as(c.alice), c.fx.league.id, { body: `m${i}` }, { notify: n.notify, now: at(i) });
    }
    expect(await code(postMessage(db, as(c.alice), c.fx.league.id, { body: "too many" }, { notify: n.notify, now: at(30) }))).toBe("rate_limited");
    expect(await code(postMessage(db, as(c.bob), c.fx.league.id, { body: "fine" }, { notify: n.notify, now: at(30) }))).toBe("ok");
    // The window is rolling: just under a minute after the first message all 10 still count, a bit later one has aged out.
    expect(await code(postMessage(db, as(c.alice), c.fx.league.id, { body: "again" }, { notify: n.notify, now: at(59) }))).toBe("rate_limited");
    expect(await code(postMessage(db, as(c.alice), c.fx.league.id, { body: "again" }, { notify: n.notify, now: at(61) }))).toBe("ok");
  });
});

describe("editing", () => {
  it("the author can edit within 15 minutes; later, by others, or after delete it is refused", async () => {
    const c = await league();
    const n = captureNotifier();
    const m = await postMessage(db, as(c.alice), c.fx.league.id, { body: "typo" }, { notify: n.notify, now: T0 });
    const edited = await editMessage(db, as(c.alice), m.id, " fixed ", { now: new Date(T0.getTime() + EDIT_WINDOW_MS) });
    expect(edited.body).toBe("fixed");
    expect(edited.editedAt).not.toBeNull();

    expect(await code(editMessage(db, as(c.alice), m.id, "late", { now: new Date(T0.getTime() + EDIT_WINDOW_MS + 1) }))).toBe("edit_window_closed");
    expect(await code(editMessage(db, as(c.bob), m.id, "hijack", { now: at(5) }))).toBe("forbidden");
    // The commissioner can delete but not rewrite other people's words.
    expect(await code(editMessage(db, as(c.commish), m.id, "hijack", { now: at(5) }))).toBe("forbidden");
    expect(await code(editMessage(db, as(c.alice), m.id, "  ", { now: at(5) }))).toBe("invalid_input");

    await deleteMessage(db, as(c.alice), m.id, { now: at(6) });
    expect(await code(editMessage(db, as(c.alice), m.id, "zombie", { now: at(7) }))).toBe("not_found");
  });
});

describe("deleting and pinning", () => {
  it("authors soft-delete their own messages; the page hides the body", async () => {
    const c = await league();
    const n = captureNotifier();
    const m = await postMessage(db, as(c.alice), c.fx.league.id, { body: "oops" }, { notify: n.notify, now: T0 });
    expect(await code(deleteMessage(db, as(c.bob), m.id, { now: at(1) }))).toBe("forbidden");
    await deleteMessage(db, as(c.alice), m.id, { now: at(2) });
    const [row] = await db.select().from(messages).where(eq(messages.id, m.id));
    expect(row.deletedAt).not.toBeNull();
    expect(row.body).toBe("oops"); // soft delete keeps the row
    const page = await listMessages(db, as(c.bob), c.fx.league.id, {}, at(3));
    expect(page.messages[0]).toMatchObject({ id: m.id, deleted: true, body: null, canEdit: false, canDelete: false });
    expect(await code(deleteMessage(db, as(c.alice), m.id, { now: at(4) }))).toBe("not_found");
    // Own deletes are not commissioner actions: nothing is logged.
    expect(await db.select().from(activityLog).where(eq(activityLog.type, "chat_delete"))).toHaveLength(0);
  });

  it("the commissioner can delete any message and it is logged with the commissioner as actor", async () => {
    const c = await league();
    const n = captureNotifier();
    const m = await postMessage(db, as(c.alice), c.fx.league.id, { body: "rude" }, { notify: n.notify, now: T0 });
    await deleteMessage(db, as(c.commish), m.id, { now: at(1) });
    const log = await db.select().from(activityLog).where(eq(activityLog.type, "chat_delete"));
    expect(log).toHaveLength(1);
    expect(log[0].actorUserId).toBe(c.commish.ownerId);
    expect(log[0].leagueId).toBe(c.fx.league.id);
    expect(log[0].summary).toContain(c.names.get(c.alice.ownerId)!);
  });

  it("only the commissioner pins; pinned messages are listed first and unpinned on delete", async () => {
    const c = await league();
    const n = captureNotifier();
    const a = await postMessage(db, as(c.alice), c.fx.league.id, { body: "rules: be nice" }, { notify: n.notify, now: T0 });
    const b = await postMessage(db, as(c.bob), c.fx.league.id, { body: "other" }, { notify: n.notify, now: at(1) });
    expect(await code(setPinned(db, as(c.alice), a.id, true, { now: at(2) }))).toBe("forbidden");
    await setPinned(db, as(c.commish), a.id, true, { now: at(2) });
    expect((await listPinned(db, as(c.bob), c.fx.league.id)).map((m) => m.id)).toEqual([a.id]);
    const log = await db.select().from(activityLog).where(eq(activityLog.type, "chat_pin"));
    expect(log).toHaveLength(1);
    expect(log[0].actorUserId).toBe(c.commish.ownerId);

    await setPinned(db, as(c.commish), b.id, true, { now: at(3) });
    expect((await listPinned(db, as(c.bob), c.fx.league.id)).map((m) => m.id)).toEqual([b.id, a.id]);
    await setPinned(db, as(c.commish), a.id, false, { now: at(4) });
    await deleteMessage(db, as(c.commish), b.id, { now: at(5) });
    expect(await listPinned(db, as(c.bob), c.fx.league.id)).toEqual([]);
  });

  it("viewer permissions are reflected on each message (canEdit within the window, canDelete for author/commissioner)", async () => {
    const c = await league();
    const n = captureNotifier();
    const m = await postMessage(db, as(c.alice), c.fx.league.id, { body: "hello" }, { notify: n.notify, now: T0 });
    const view = async (t: Team, now: Date) => (await listMessages(db, as(t), c.fx.league.id, {}, now)).messages.find((x) => x.id === m.id)!;
    expect(await view(c.alice, at(10))).toMatchObject({ canEdit: true, canDelete: true });
    expect(await view(c.alice, new Date(T0.getTime() + EDIT_WINDOW_MS + 1000))).toMatchObject({ canEdit: false, canDelete: true });
    expect(await view(c.bob, at(10))).toMatchObject({ canEdit: false, canDelete: false });
    expect(await view(c.commish, at(10))).toMatchObject({ canEdit: false, canDelete: true });
  });
});

describe("mentions and notifications", () => {
  it("notifies mentioned members with chat_mentions (not the author, not outsiders), others with chat_messages", async () => {
    const c = await league();
    const n = captureNotifier();
    const aliceName = c.names.get(c.alice.ownerId)!;
    const bobName = c.names.get(c.bob.ownerId)!;
    await postMessage(
      db,
      as(c.alice),
      c.fx.league.id,
      { body: `hey @${bobName.toUpperCase()} and @${aliceName} and @ghost_user, see you` },
      { notify: n.notify, now: T0 },
    );
    const mention = n.calls.filter((x) => x.type === "chat_mentions");
    expect(mention).toHaveLength(1);
    expect(mention[0].userIds).toEqual([c.bob.ownerId]);
    expect(mention[0].url).toBe(`/leagues/${c.fx.league.id}/chat`);
    expect(mention[0].leagueId).toBe(c.fx.league.id);
    const all = n.calls.filter((x) => x.type === "chat_messages");
    expect(all).toHaveLength(1);
    expect(all[0].userIds).toEqual([c.commish.ownerId]); // not the author, not the already-mentioned bob
  });

  it("through the real notifier: mentions land in-app by default; plain messages only after opting in", async () => {
    const c = await league();
    const bobName = c.names.get(c.bob.ownerId)!;
    await postMessage(db, as(c.alice), c.fx.league.id, { body: `@${bobName} ping` }, { now: T0 });
    await postMessage(db, as(c.alice), c.fx.league.id, { body: "plain message" }, { now: at(1) });
    const rows = await db.select().from(notifications);
    expect(rows.filter((r) => r.type === "chat_mentions").map((r) => r.userId)).toEqual([c.bob.ownerId]);
    expect(rows.filter((r) => r.type === "chat_messages")).toHaveLength(0);

    await setPref(db, c.commish.ownerId, "chat_messages", { inApp: true });
    await postMessage(db, as(c.alice), c.fx.league.id, { body: "another plain one" }, { now: at(2) });
    const after = await db.select().from(notifications).where(eq(notifications.type, "chat_messages"));
    expect(after.map((r) => r.userId)).toEqual([c.commish.ownerId]);
  });

  it("defaults: mentions and announcements push; every-message is off for both push and in-app", () => {
    expect(NOTIFICATION_DEFAULTS.chat_mentions).toEqual({ push: true, inApp: true });
    expect(NOTIFICATION_DEFAULTS.league_announcements).toEqual({ push: true, inApp: true });
    expect(NOTIFICATION_DEFAULTS.commissioner_actions).toEqual({ push: true, inApp: true });
    expect(NOTIFICATION_DEFAULTS.chat_messages).toEqual({ push: false, inApp: false });
  });
});

describe("announcements", () => {
  it("only the commissioner posts; every other member is notified (league_announcements); shown as the latest", async () => {
    const c = await league();
    const n = captureNotifier();
    expect(await code(postAnnouncement(db, as(c.alice), c.fx.league.id, "I am the boss", { notify: n.notify, now: T0 }))).toBe("forbidden");
    expect(n.calls).toHaveLength(0);

    const row = await postAnnouncement(db, as(c.commish), c.fx.league.id, "Draft is Sunday 8pm", { notify: n.notify, now: at(1) });
    expect(row.kind).toBe("announcement");
    expect(n.calls).toHaveLength(1);
    expect(n.calls[0]).toMatchObject({ type: "league_announcements", leagueId: c.fx.league.id });
    expect([...n.calls[0].userIds].sort()).toEqual([c.alice.ownerId, c.bob.ownerId].sort());
    expect(n.calls[0].body).toContain("Draft is Sunday");

    await postAnnouncement(db, as(c.commish), c.fx.league.id, "Update: draft moved", { notify: n.notify, now: at(2) });
    expect((await latestAnnouncement(db, c.fx.league.id))?.body).toBe("Update: draft moved");
    const log = await db.select().from(activityLog).where(eq(activityLog.type, "announcement"));
    expect(log).toHaveLength(2);
    expect(log.every((l) => l.actorUserId === c.commish.ownerId)).toBe(true);

    // Deleting the newest announcement brings the previous one back.
    const newest = (await db.select().from(messages).where(and(eq(messages.kind, "announcement"), eq(messages.body, "Update: draft moved"))))[0];
    await deleteMessage(db, as(c.commish), newest.id, { now: at(3) });
    expect((await latestAnnouncement(db, c.fx.league.id))?.body).toBe("Draft is Sunday 8pm");
  });

  it("through the real notifier every member gets an in-app row", async () => {
    const c = await league();
    await postAnnouncement(db, as(c.commish), c.fx.league.id, "Welcome!", { now: T0 });
    const rows = await db.select().from(notifications).where(eq(notifications.type, "league_announcements"));
    expect(rows.map((r) => r.userId).sort()).toEqual([c.alice.ownerId, c.bob.ownerId].sort());
  });
});

describe("unread tracking", () => {
  // Real-clock based: with no read marker the baseline is when the team was created.
  // (the base is taken inside each test, after the league was created)
  const clock = () => {
    const base = Date.now() + 5_000;
    return (sec: number) => new Date(base + sec * 1000);
  };

  it("counts other people's visible messages since the last read; reading and posting clear it", async () => {
    const c = await league();
    const t = clock();
    const n = captureNotifier();
    const L = c.fx.league.id;
    await postMessage(db, as(c.alice), L, { body: "one" }, { notify: n.notify, now: t(1) });
    const two = await postMessage(db, as(c.alice), L, { body: "two" }, { notify: n.notify, now: t(2) });
    expect(await chatUnreadCount(db, c.bob.ownerId, L)).toBe(2);
    expect(await chatUnreadCount(db, c.alice.ownerId, L)).toBe(0); // own messages never count

    await deleteMessage(db, as(c.alice), two.id, { now: t(3) });
    expect(await chatUnreadCount(db, c.bob.ownerId, L)).toBe(1); // deleted messages don't count

    await markChatRead(db, c.bob.ownerId, L, t(10));
    expect(await chatUnreadCount(db, c.bob.ownerId, L)).toBe(0);
    // markChatRead never moves backwards.
    await markChatRead(db, c.bob.ownerId, L, t(0));
    expect(await chatUnreadCount(db, c.bob.ownerId, L)).toBe(0);

    await postMessage(db, as(c.alice), L, { body: "three" }, { notify: n.notify, now: t(20) });
    expect(await chatUnreadCount(db, c.bob.ownerId, L)).toBe(1);
    expect(await chatUnreadCount(db, c.commish.ownerId, L)).toBe(2); // one + three (two was deleted)
    // Posting marks the poster's own chat as read.
    await postMessage(db, as(c.bob), L, { body: "reply" }, { notify: n.notify, now: t(21) });
    expect(await chatUnreadCount(db, c.bob.ownerId, L)).toBe(0);
  });

  it("is zero for people with no team in the league and is scoped per league", async () => {
    const c = await league();
    const other = await league();
    const t = clock();
    const n = captureNotifier();
    await postMessage(db, as(c.alice), c.fx.league.id, { body: "hi" }, { notify: n.notify, now: t(1) });
    const outsider = await createUser(db, { username: "lurker", password: "password123" });
    expect(await chatUnreadCount(db, outsider.id, c.fx.league.id)).toBe(0);
    expect(await chatUnreadCount(db, other.bob.ownerId, other.fx.league.id)).toBe(0);
    expect(await chatUnreadCount(db, c.bob.ownerId, c.fx.league.id)).toBe(1);
  });
});

describe("pagination", () => {
  it("returns the newest page oldest-first, then older pages by cursor without overlap", async () => {
    const c = await league();
    const n = captureNotifier();
    const ids: string[] = [];
    // Spread over several minutes to stay under the rate limit.
    for (let i = 0; i < 7; i++) {
      const m = await postMessage(db, as(i % 2 ? c.alice : c.bob), c.fx.league.id, { body: `msg ${i}` }, { notify: n.notify, now: at(i * 100) });
      ids.push(m.id);
    }
    const first = await listMessages(db, as(c.commish), c.fx.league.id, { limit: 3 });
    expect(first.messages.map((m) => m.body)).toEqual(["msg 4", "msg 5", "msg 6"]);
    expect(first.hasMore).toBe(true);

    const cursor = parseCursor(encodeCursor(first.messages[0]));
    expect(cursor?.id).toBe(first.messages[0].id);
    const second = await listMessages(db, as(c.commish), c.fx.league.id, { limit: 3, before: cursor });
    expect(second.messages.map((m) => m.body)).toEqual(["msg 1", "msg 2", "msg 3"]);
    expect(second.hasMore).toBe(true);
    const third = await listMessages(db, as(c.commish), c.fx.league.id, { limit: 3, before: parseCursor(encodeCursor(second.messages[0])) });
    expect(third.messages.map((m) => m.body)).toEqual(["msg 0"]);
    expect(third.hasMore).toBe(false);
    expect(parseCursor("garbage")).toBeNull();
  });
});
