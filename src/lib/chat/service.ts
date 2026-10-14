/**
 * League chat (message board) and commissioner announcements.
 *
 * Rules: only members (team owners) post; edits by the author within 15 minutes; deletes are soft
 * (the author any time, the commissioner any message, always logged); the commissioner pins.
 * Bodies are stored raw (plain text) and escaped at render time (see text.ts). At most 10 messages
 * per user per minute. @username mentions are validated against the league's members.
 */
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { log } from "@/lib/log";
import { chatReads, leagues, messages, teams, users, type League } from "@/db/schema";
import type { Db } from "@/db/types";
import { logActivity } from "@/lib/activity/service";
import { notifier, type Notifier, type NotifyInput } from "@/lib/notifications/service";
import { z } from "zod";
import type { ChatMessage, ChatPage } from "./shared";
import { cleanBody, extractMentions } from "./text";

export { encodeCursor } from "./shared";
export type { ChatMessage, ChatPage } from "./shared";

export const EDIT_WINDOW_MS = 15 * 60 * 1000;
export const RATE_LIMIT_COUNT = 10;
export const RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const PAGE_SIZE = 50;

export type ChatErrorCode = "not_found" | "forbidden" | "invalid_input" | "rate_limited" | "edit_window_closed";

const MESSAGES: Record<ChatErrorCode, string> = {
  not_found: "Message not found.",
  forbidden: "You don't have permission to do that.",
  invalid_input: "That message isn't valid.",
  rate_limited: "Slow down: you can send at most 10 messages per minute.",
  edit_window_closed: "Messages can only be edited for 15 minutes after they were sent.",
};

export class ChatError extends Error {
  constructor(
    public code: ChatErrorCode,
    message?: string,
  ) {
    super(message ?? MESSAGES[code]);
  }
}

export type ChatDeps = { notify?: Notifier; now?: Date };
export type ChatActor = { id: string; isSiteAdmin?: boolean };

const uuidSchema = z.string().uuid();
const chatUrl = (leagueId: string) => `/leagues/${leagueId}/chat`;
const snippet = (body: string, n = 120) => (body.length > n ? `${body.slice(0, n - 1)}…` : body);

async function sendAll(db: Db, notify: Notifier | undefined, inputs: NotifyInput[]) {
  const send = notify ?? notifier;
  for (const input of inputs) {
    if (input.userIds.length === 0) continue;
    try {
      await send(db, input);
    } catch (err) {
      log.error("chat.notification_failed", {}, err);
    }
  }
}

async function loadLeague(db: Db, leagueId: string): Promise<League> {
  if (!uuidSchema.safeParse(leagueId).success) throw new ChatError("not_found", "League not found.");
  const [league] = await db.select().from(leagues).where(eq(leagues.id, leagueId));
  if (!league) throw new ChatError("not_found", "League not found.");
  return league;
}

type Member = { userId: string; username: string; teamId: string; teamName: string };

async function leagueMembers(db: Db, leagueId: string): Promise<Member[]> {
  return db
    .select({ userId: users.id, username: users.username, teamId: teams.id, teamName: teams.name })
    .from(teams)
    .innerJoin(users, eq(users.id, teams.ownerId))
    .where(eq(teams.leagueId, leagueId))
    .orderBy(asc(teams.createdAt), asc(teams.id));
}

export const listMemberUsernames = async (db: Db, leagueId: string) => (await leagueMembers(db, leagueId)).map((m) => m.username);

// ------------------------------------------------------------------------------------- posting

async function insertMessage(
  db: Db,
  league: League,
  actor: ChatActor,
  input: { body: unknown; replyTo?: string | null; kind: "message" | "announcement" },
  now: Date,
) {
  const members = await leagueMembers(db, league.id);
  const me = members.find((m) => m.userId === actor.id);
  if (!me) throw new ChatError("forbidden", "Only league members can post.");
  const cleaned = cleanBody(input.body);
  if (!cleaned.ok) throw new ChatError("invalid_input", cleaned.error);

  if (input.kind === "message") {
    const since = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(eq(messages.leagueId, league.id), eq(messages.userId, actor.id), gt(messages.createdAt, since)));
    if (n >= RATE_LIMIT_COUNT) throw new ChatError("rate_limited");
  }

  let replyTo: string | null = null;
  if (input.replyTo) {
    if (!uuidSchema.safeParse(input.replyTo).success) throw new ChatError("invalid_input", "That reply target doesn't exist.");
    const [target] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.id, input.replyTo), eq(messages.leagueId, league.id)));
    if (!target) throw new ChatError("invalid_input", "That reply target doesn't exist.");
    replyTo = target.id;
  }

  const [row] = await db
    .insert(messages)
    .values({
      leagueId: league.id,
      userId: actor.id,
      teamId: me.teamId,
      kind: input.kind,
      body: cleaned.body,
      createdAt: now,
      replyTo,
    })
    .returning();
  // Posting counts as reading the chat up to now.
  await markChatRead(db, actor.id, league.id, now);
  return { row, me, members, body: cleaned.body };
}

/** A member posts to the league chat. Mentioned members get `chat_mentions`; everyone else `chat_messages` (opt-in). */
export async function postMessage(
  db: Db,
  actor: ChatActor,
  leagueId: string,
  input: { body: unknown; replyTo?: string | null },
  deps: ChatDeps = {},
) {
  const now = deps.now ?? new Date();
  const league = await loadLeague(db, leagueId);
  const { row, me, members, body } = await insertMessage(db, league, actor, { ...input, kind: "message" }, now);

  const mentionNames = new Set(extractMentions(body));
  const mentioned = members.filter((m) => m.userId !== actor.id && mentionNames.has(m.username.toLowerCase()));
  const mentionedIds = new Set(mentioned.map((m) => m.userId));
  const others = members.filter((m) => m.userId !== actor.id && !mentionedIds.has(m.userId));
  await sendAll(db, deps.notify, [
    {
      userIds: mentioned.map((m) => m.userId),
      leagueId,
      type: "chat_mentions",
      title: `${me.username} mentioned you`,
      body: snippet(body),
      url: chatUrl(leagueId),
    },
    {
      userIds: others.map((m) => m.userId),
      leagueId,
      type: "chat_messages",
      title: `${me.username} in ${league.name}`,
      body: snippet(body),
      url: chatUrl(leagueId),
    },
  ]);
  return row;
}

/** Commissioner only. Highlighted message that notifies every other member (push on by default). */
export async function postAnnouncement(db: Db, actor: ChatActor, leagueId: string, bodyRaw: unknown, deps: ChatDeps = {}) {
  const now = deps.now ?? new Date();
  const league = await loadLeague(db, leagueId);
  if (league.commissionerId !== actor.id) throw new ChatError("forbidden", "Only the commissioner can post announcements.");
  const { row, me, members, body } = await db.transaction(async (tx) => {
    const res = await insertMessage(tx as unknown as Db, league, actor, { body: bodyRaw, kind: "announcement" }, now);
    await logActivity(tx as unknown as Db, {
      leagueId,
      actorUserId: actor.id,
      type: "announcement",
      summary: `${res.me.username} posted an announcement: ${snippet(res.body, 140)}`,
      data: { messageId: res.row.id, url: chatUrl(leagueId) },
      now,
    });
    return res;
  });
  await sendAll(db, deps.notify, [
    {
      userIds: members.filter((m) => m.userId !== actor.id).map((m) => m.userId),
      leagueId,
      type: "league_announcements",
      title: `Announcement from ${me.username}`,
      body: snippet(body),
      url: `/leagues/${leagueId}`,
    },
  ]);
  return row;
}

// ------------------------------------------------------------------- edit / delete / pin

async function loadMessage(db: Db, messageId: string) {
  if (!uuidSchema.safeParse(messageId).success) throw new ChatError("not_found");
  const [row] = await db.select().from(messages).where(eq(messages.id, messageId));
  if (!row) throw new ChatError("not_found");
  const league = await loadLeague(db, row.leagueId);
  return { row, league };
}

/** Author only, within 15 minutes of sending. */
export async function editMessage(db: Db, actor: ChatActor, messageId: string, bodyRaw: unknown, deps: ChatDeps = {}) {
  const now = deps.now ?? new Date();
  const { row } = await loadMessage(db, messageId);
  if (row.deletedAt) throw new ChatError("not_found");
  if (row.userId !== actor.id) throw new ChatError("forbidden", "You can only edit your own messages.");
  if (now.getTime() - row.createdAt.getTime() > EDIT_WINDOW_MS) throw new ChatError("edit_window_closed");
  const cleaned = cleanBody(bodyRaw);
  if (!cleaned.ok) throw new ChatError("invalid_input", cleaned.error);
  const [updated] = await db
    .update(messages)
    .set({ body: cleaned.body, editedAt: now })
    .where(and(eq(messages.id, row.id), isNull(messages.deletedAt)))
    .returning();
  if (!updated) throw new ChatError("not_found");
  return updated;
}

/** Soft delete: the author any time, the commissioner any message (logged with the commissioner as actor). */
export async function deleteMessage(db: Db, actor: ChatActor, messageId: string, deps: ChatDeps = {}) {
  const now = deps.now ?? new Date();
  const { row, league } = await loadMessage(db, messageId);
  if (row.deletedAt) throw new ChatError("not_found");
  const own = row.userId === actor.id;
  const commissioner = league.commissionerId === actor.id;
  if (!own && !commissioner) throw new ChatError("forbidden", "You can only delete your own messages.");
  await db.transaction(async (tx) => {
    await tx.update(messages).set({ deletedAt: now, pinned: false }).where(eq(messages.id, row.id));
    if (!own) {
      const [author] = await tx.select({ username: users.username }).from(users).where(eq(users.id, row.userId));
      await logActivity(tx as unknown as Db, {
        leagueId: league.id,
        actorUserId: actor.id,
        type: "chat_delete",
        summary: `Commissioner removed a ${row.kind === "announcement" ? "announcement" : "chat message"} by ${author?.username ?? "a member"}`,
        data: { messageId: row.id, authorUserId: row.userId },
        now,
      });
    }
  });
}

/** Commissioner only. */
export async function setPinned(db: Db, actor: ChatActor, messageId: string, pinned: boolean, deps: ChatDeps = {}) {
  const now = deps.now ?? new Date();
  const { row, league } = await loadMessage(db, messageId);
  if (league.commissionerId !== actor.id) throw new ChatError("forbidden", "Only the commissioner can pin messages.");
  if (row.deletedAt) throw new ChatError("not_found");
  if (row.pinned === pinned) return;
  await db.transaction(async (tx) => {
    await tx.update(messages).set({ pinned }).where(eq(messages.id, row.id));
    await logActivity(tx as unknown as Db, {
      leagueId: league.id,
      actorUserId: actor.id,
      type: "chat_pin",
      summary: `Commissioner ${pinned ? "pinned" : "unpinned"} a message: ${snippet(row.body, 80)}`,
      data: { messageId: row.id },
      now,
    });
  });
}

// ------------------------------------------------------------------------------------ reading

export function parseCursor(raw: string | null | undefined): { createdAt: Date; id: string } | null {
  if (!raw) return null;
  const [iso, id] = raw.split("_");
  const d = new Date(iso ?? "");
  if (Number.isNaN(d.getTime()) || !uuidSchema.safeParse(id).success) return null;
  return { createdAt: d, id };
}

async function assertCanRead(db: Db, actor: ChatActor, leagueId: string): Promise<League> {
  const league = await loadLeague(db, leagueId);
  if (actor.isSiteAdmin) return league;
  const [mine] = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.leagueId, leagueId), eq(teams.ownerId, actor.id)));
  if (!mine) throw new ChatError("forbidden");
  return league;
}

type Row = typeof messages.$inferSelect & { username: string; teamName: string | null };

async function hydrate(db: Db, rows: Row[], league: League, actor: ChatActor, now: Date): Promise<ChatMessage[]> {
  const replyIds = [...new Set(rows.map((r) => r.replyTo).filter((x): x is string => x !== null))];
  const replies = replyIds.length
    ? await db
        .select({ id: messages.id, body: messages.body, deletedAt: messages.deletedAt, username: users.username })
        .from(messages)
        .innerJoin(users, eq(users.id, messages.userId))
        .where(inArray(messages.id, replyIds))
    : [];
  const replyById = new Map(replies.map((r) => [r.id, r]));
  const commissioner = league.commissionerId === actor.id;
  return rows.map((r) => {
    const deleted = r.deletedAt !== null;
    const reply = r.replyTo ? replyById.get(r.replyTo) : undefined;
    const own = r.userId === actor.id;
    return {
      id: r.id,
      userId: r.userId,
      username: r.username,
      teamName: r.teamName,
      kind: r.kind,
      body: deleted ? null : r.body,
      createdAt: r.createdAt.toISOString(),
      editedAt: r.editedAt?.toISOString() ?? null,
      deleted,
      pinned: r.pinned && !deleted,
      replyTo: reply ? { id: reply.id, username: reply.username, snippet: reply.deletedAt ? null : snippet(reply.body, 80) } : null,
      canEdit: own && !deleted && now.getTime() - r.createdAt.getTime() <= EDIT_WINDOW_MS,
      canDelete: !deleted && (own || commissioner),
    };
  });
}

const baseSelect = (db: Db) =>
  db
    .select({
      id: messages.id,
      leagueId: messages.leagueId,
      userId: messages.userId,
      teamId: messages.teamId,
      kind: messages.kind,
      body: messages.body,
      createdAt: messages.createdAt,
      editedAt: messages.editedAt,
      deletedAt: messages.deletedAt,
      replyTo: messages.replyTo,
      pinned: messages.pinned,
      username: users.username,
      teamName: teams.name,
    })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.userId))
    .leftJoin(teams, eq(teams.id, messages.teamId));

/** Newest `limit` messages (or the page before `before`), oldest first. */
export async function listMessages(
  db: Db,
  actor: ChatActor,
  leagueId: string,
  opts: { before?: { createdAt: Date; id: string } | null; limit?: number; includeDeleted?: boolean } = {},
  now = new Date(),
): Promise<ChatPage> {
  const league = await assertCanRead(db, actor, leagueId);
  const limit = Math.min(100, Math.max(1, opts.limit ?? PAGE_SIZE));
  const before = opts.before;
  const rows = await baseSelect(db)
    .where(
      and(
        eq(messages.leagueId, leagueId),
        opts.includeDeleted === false ? isNull(messages.deletedAt) : undefined,
        before
          ? or(lt(messages.createdAt, before.createdAt), and(eq(messages.createdAt, before.createdAt), lt(messages.id, before.id)))
          : undefined,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  return {
    messages: await hydrate(db, page, league, actor, now),
    hasMore,
    viewer: { userId: actor.id, isCommissioner: league.commissionerId === actor.id },
    members: await listMemberUsernames(db, leagueId),
  };
}

/** Pinned (not deleted) messages, newest first. */
export async function listPinned(db: Db, actor: ChatActor, leagueId: string, now = new Date()): Promise<ChatMessage[]> {
  const league = await assertCanRead(db, actor, leagueId);
  const rows = await baseSelect(db)
    .where(and(eq(messages.leagueId, leagueId), eq(messages.pinned, true), isNull(messages.deletedAt)))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(10);
  return hydrate(db, rows, league, actor, now);
}

/** The newest announcement that hasn't been deleted. */
export async function latestAnnouncement(db: Db, leagueId: string) {
  const [row] = await baseSelect(db)
    .where(and(eq(messages.leagueId, leagueId), eq(messages.kind, "announcement"), isNull(messages.deletedAt)))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  return row ?? null;
}

// ------------------------------------------------------------------------------------ unread

export async function markChatRead(db: Db, userId: string, leagueId: string, now = new Date()): Promise<void> {
  const [member] = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.leagueId, leagueId), eq(teams.ownerId, userId)));
  if (!member) return;
  await db
    .insert(chatReads)
    .values({ leagueId, userId, lastReadAt: now })
    .onConflictDoUpdate({
      target: [chatReads.leagueId, chatReads.userId],
      set: { lastReadAt: sql`greatest(${chatReads.lastReadAt}, ${now.toISOString()}::timestamptz)` },
    });
}

/** Messages from other people since the user last opened the chat (or since he joined, if never). */
export async function chatUnreadCount(db: Db, userId: string, leagueId: string): Promise<number> {
  const [team] = await db.select({ createdAt: teams.createdAt }).from(teams).where(and(eq(teams.leagueId, leagueId), eq(teams.ownerId, userId)));
  if (!team) return 0;
  const [read] = await db.select({ at: chatReads.lastReadAt }).from(chatReads).where(and(eq(chatReads.leagueId, leagueId), eq(chatReads.userId, userId)));
  const since = read?.at ?? team.createdAt;
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(eq(messages.leagueId, leagueId), ne(messages.userId, userId), isNull(messages.deletedAt), gt(messages.createdAt, since)));
  return n;
}
