"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requireUser } from "@/lib/auth/session";
import {
  ChatError,
  deleteMessage,
  editMessage,
  markChatRead,
  postAnnouncement,
  postMessage,
  setPinned,
} from "@/lib/chat/service";

export type ChatActionResult = { ok: true } | { ok: false; error: string };

async function run(fn: () => Promise<unknown>): Promise<ChatActionResult> {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    if (err instanceof ChatError) return { ok: false, error: err.message };
    throw err;
  }
}

export async function postMessageAction(leagueId: string, body: string, replyTo?: string | null): Promise<ChatActionResult> {
  const user = await requireUser();
  return run(() => postMessage(db, user, leagueId, { body, replyTo }));
}

export async function editMessageAction(messageId: string, body: string): Promise<ChatActionResult> {
  const user = await requireUser();
  return run(() => editMessage(db, user, messageId, body));
}

export async function deleteMessageAction(messageId: string): Promise<ChatActionResult> {
  const user = await requireUser();
  return run(() => deleteMessage(db, user, messageId));
}

export async function pinMessageAction(messageId: string, pinned: boolean): Promise<ChatActionResult> {
  const user = await requireUser();
  return run(() => setPinned(db, user, messageId, pinned));
}

/** Marks the chat read up to now (called when the page is open). No revalidation: the badge polls. */
export async function markChatReadAction(leagueId: string): Promise<void> {
  const user = await requireUser();
  if (!/^[0-9a-f-]{36}$/i.test(leagueId)) return;
  await markChatRead(db, user.id, leagueId);
}

export async function postAnnouncementAction(leagueId: string, body: string): Promise<ChatActionResult> {
  const user = await requireUser();
  const res = await run(() => postAnnouncement(db, user, leagueId, body));
  if (res.ok) revalidatePath(`/leagues/${leagueId}`, "layout");
  return res;
}
