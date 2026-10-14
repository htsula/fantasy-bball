"use client";

import useSWR from "swr";
import { Badge } from "@/components/ui/badge";

const fetchCount = async (url: string): Promise<{ count: number }> => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("unread failed");
  return res.json();
};

/** Unread chat count next to the "Chat" tab. Polled every 30s; the chat page refreshes it when it marks read. */
export function ChatNavBadge({ leagueId, initialCount }: { leagueId: string; initialCount: number }) {
  const { data } = useSWR(`/api/leagues/${leagueId}/chat/unread`, fetchCount, {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
    fallbackData: { count: initialCount },
  });
  const count = data?.count ?? 0;
  if (count <= 0) return null;
  return (
    <Badge className="ml-1" data-testid="nav-chat-badge" aria-label={`${count} unread chat message${count === 1 ? "" : "s"}`}>
      {count > 99 ? "99+" : count}
    </Badge>
  );
}
