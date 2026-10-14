"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import useSWR, { mutate as globalMutate } from "swr";
import { toast } from "sonner";
import {
  deleteMessageAction,
  editMessageAction,
  markChatReadAction,
  pinMessageAction,
  postMessageAction,
} from "@/app/(app)/leagues/[leagueId]/chat/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { encodeCursor, type ChatMessage, type ChatPage } from "@/lib/chat/shared";
import { MAX_BODY_LENGTH } from "@/lib/chat/text";
import { fmtEtDateTime } from "@/lib/nba/format";
import { ChatText } from "./chat-text";

export type ChatPayload = ChatPage & { pinned: ChatMessage[] };

const POLL_MS = 10_000;

const fetcher = async (url: string): Promise<ChatPayload> => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
};

export const unreadKey = (leagueId: string) => `/api/leagues/${leagueId}/chat/unread`;

export function ChatView({ leagueId, initial, canPost }: { leagueId: string; initial: ChatPayload; canPost: boolean }) {
  const key = `/api/leagues/${leagueId}/chat`;
  const { data, error, mutate } = useSWR(key, fetcher, {
    fallbackData: initial,
    refreshInterval: POLL_MS,
    revalidateOnFocus: true,
  });
  const latest = data ?? initial;
  const [older, setOlder] = useState<ChatMessage[]>([]);
  const [olderHasMore, setOlderHasMore] = useState<boolean | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [draft, setDraft] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const all = useMemo(() => {
    const byId = new Map<string, ChatMessage>();
    for (const m of older) byId.set(m.id, m);
    for (const m of latest.messages) byId.set(m.id, m);
    return [...byId.values()].sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1));
  }, [older, latest.messages]);
  const hasMore = olderHasMore ?? latest.hasMore;
  const lastId = all.length ? all[all.length - 1].id : null;

  // Newest at the bottom: keep it pinned there unless the reader scrolled up.
  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lastId]);

  // Reading the chat clears the nav badge.
  useEffect(() => {
    if (document.visibilityState === "hidden") return;
    void markChatReadAction(leagueId).then(() => globalMutate(unreadKey(leagueId)));
  }, [leagueId, lastId]);

  async function loadOlder() {
    if (!all.length) return;
    setLoadingOlder(true);
    try {
      const first = all[0];
      const res = await fetch(`${key}?before=${encodeURIComponent(encodeCursor(first))}`, { cache: "no-store" });
      if (!res.ok) throw new Error("Could not load older messages");
      const page = (await res.json()) as ChatPayload;
      stickRef.current = false;
      setOlder((o) => [...page.messages, ...o]);
      setOlderHasMore(page.hasMore);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load older messages");
    } finally {
      setLoadingOlder(false);
    }
  }

  /**
   * Re-fetches the older pages the reader has loaded, so edits and deletes made there show up (the live page
   * refreshes by polling, older pages are otherwise static). Walks back from the oldest message of the live page
   * until it has covered the oldest loaded message.
   */
  async function refreshOlder() {
    if (older.length === 0 || latest.messages.length === 0) return;
    const oldestLoaded = older[0];
    const collected: ChatMessage[] = [];
    let cursor = latest.messages[0];
    try {
      for (let i = 0; i < 20; i++) {
        const res = await fetch(`${key}?before=${encodeURIComponent(encodeCursor(cursor))}`, { cache: "no-store" });
        if (!res.ok) return;
        const page = (await res.json()) as ChatPayload;
        if (page.messages.length === 0) break;
        collected.unshift(...page.messages);
        cursor = page.messages[0];
        const reached = page.messages.some((m) => m.id === oldestLoaded.id) || !page.hasMore;
        if (reached) break;
      }
      const latestIds = new Set(latest.messages.map((m) => m.id));
      setOlder(collected.filter((m) => !latestIds.has(m.id)));
    } catch {
      /* keep what is on screen */
    }
  }
  const refreshOlderRef = useRef(refreshOlder);
  refreshOlderRef.current = refreshOlder;
  // Other people's edits/deletes of older messages: refresh the loaded older pages now and then and on return to the tab.
  const hasOlder = older.length > 0;
  useEffect(() => {
    if (!hasOlder) return;
    const tick = () => void refreshOlderRef.current();
    const id = setInterval(tick, 60_000);
    const onVisible = () => document.visibilityState === "visible" && tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [hasOlder]);

  function submit() {
    const body = draft.trim();
    if (!body) return;
    setFormError(null);
    start(async () => {
      const res = editing ? await editMessageAction(editing.id, body) : await postMessageAction(leagueId, body, replyTo?.id ?? null);
      if (!res.ok) {
        setFormError(res.error);
        return;
      }
      setDraft("");
      setReplyTo(null);
      setEditing(null);
      stickRef.current = true;
      await Promise.all([mutate(), refreshOlder()]);
    });
  }

  function act(fn: () => Promise<{ ok: true } | { ok: false; error: string }>, ok?: string) {
    start(async () => {
      const res = await fn();
      if (!res.ok) toast.error(res.error);
      else {
        if (ok) toast.success(ok);
        await Promise.all([mutate(), refreshOlder()]);
      }
    });
  }

  const members = latest.members;
  const isCommissioner = latest.viewer.isCommissioner;

  return (
    <div className="grid gap-3" data-testid="chat">
      {latest.pinned.length > 0 && (
        <section className="grid gap-2 rounded-lg border bg-muted/40 p-3" aria-label="Pinned messages" data-testid="chat-pinned">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pinned</h3>
          {latest.pinned.map((m) => (
            <MessageBody key={m.id} m={m} members={members} compact />
          ))}
        </section>
      )}

      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="grid max-h-[60vh] min-h-48 content-start gap-2 overflow-y-auto rounded-lg border p-3"
        data-testid="chat-list"
        aria-live="polite"
      >
        {hasMore && (
          <Button type="button" size="sm" variant="outline" className="mx-auto" disabled={loadingOlder} onClick={() => void loadOlder()} data-testid="chat-load-older">
            {loadingOlder ? "Loading..." : "Load older messages"}
          </Button>
        )}
        {all.length === 0 && <p className="text-sm text-muted-foreground">No messages yet. Say hello.</p>}
        {all.map((m) => (
          <div key={m.id} data-testid="chat-message" data-kind={m.kind} className={`grid gap-1 rounded-md px-2 py-1.5 ${m.kind === "announcement" ? "border border-primary/40 bg-primary/5" : ""}`}>
            <MessageBody m={m} members={members} />
            {!m.deleted && (
              <div className="flex flex-wrap gap-1">
                {canPost && (
                  <Button type="button" size="xs" variant="ghost" onClick={() => { setEditing(null); setReplyTo(m); }}>
                    Reply
                  </Button>
                )}
                {m.canEdit && (
                  <Button type="button" size="xs" variant="ghost" onClick={() => { setReplyTo(null); setEditing(m); setDraft(m.body ?? ""); }}>
                    Edit
                  </Button>
                )}
                {m.canDelete && (
                  <Button type="button" size="xs" variant="ghost" disabled={pending} onClick={() => { if (window.confirm("Delete this message?")) act(() => deleteMessageAction(m.id), "Message deleted"); }}>
                    Delete
                  </Button>
                )}
                {isCommissioner && (
                  <Button type="button" size="xs" variant="ghost" disabled={pending} onClick={() => act(() => pinMessageAction(m.id, !m.pinned), m.pinned ? "Unpinned" : "Pinned")}>
                    {m.pinned ? "Unpin" : "Pin"}
                  </Button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      {error && <p role="alert" className="text-xs text-destructive">Could not refresh the chat: {error.message}</p>}

      {canPost ? (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {replyTo && (
            <p className="flex items-center justify-between gap-2 rounded bg-muted px-2 py-1 text-xs">
              <span className="truncate">Replying to {replyTo.username}: {replyTo.body}</span>
              <button type="button" className="underline" onClick={() => setReplyTo(null)}>Cancel</button>
            </p>
          )}
          {editing && (
            <p className="flex items-center justify-between gap-2 rounded bg-muted px-2 py-1 text-xs">
              <span>Editing your message</span>
              <button type="button" className="underline" onClick={() => { setEditing(null); setDraft(""); }}>Cancel</button>
            </p>
          )}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            maxLength={MAX_BODY_LENGTH}
            rows={2}
            placeholder="Message the league. Use @username to mention someone."
            aria-label="Message"
            className="w-full rounded-lg border border-input bg-transparent px-2 py-1.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
            data-testid="chat-input"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {draft.length}/{MAX_BODY_LENGTH} &middot; Enter to send, Shift+Enter for a new line
            </span>
            <Button type="submit" size="sm" disabled={pending || !draft.trim()} data-testid="chat-send">
              {pending ? "Sending..." : editing ? "Save" : "Send"}
            </Button>
          </div>
          {formError && (
            <p role="alert" className="text-xs text-destructive" data-testid="chat-error">
              {formError}
            </p>
          )}
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">You can read the chat but only league members can post.</p>
      )}
    </div>
  );
}

function MessageBody({ m, members, compact }: { m: ChatMessage; members: readonly string[]; compact?: boolean }) {
  return (
    <div className="grid gap-0.5 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-semibold">{m.username}</span>
        {m.teamName && <span className="text-xs text-muted-foreground">{m.teamName}</span>}
        <span className="text-xs text-muted-foreground">{fmtEtDateTime(new Date(m.createdAt))}</span>
        {m.editedAt && !m.deleted && <span className="text-xs text-muted-foreground">(edited)</span>}
        {m.kind === "announcement" && <Badge>Announcement</Badge>}
        {m.pinned && !compact && <Badge variant="outline">Pinned</Badge>}
      </div>
      {m.replyTo && !compact && (
        <div className="border-l-2 pl-2 text-xs text-muted-foreground">
          {m.replyTo.username}: {m.replyTo.snippet ?? "message removed"}
        </div>
      )}
      {m.deleted || m.body === null ? (
        <span className="italic text-muted-foreground">Message removed</span>
      ) : (
        <ChatText body={m.body} members={members} />
      )}
    </div>
  );
}
