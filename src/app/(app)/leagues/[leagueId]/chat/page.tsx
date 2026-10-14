import { db } from "@/db";
import { ChatView, type ChatPayload } from "@/components/chat/chat-view";
import { listMessages, listPinned } from "@/lib/chat/service";
import { loadLeagueView } from "@/lib/leagues/loaders";

export const dynamic = "force-dynamic";

export default async function ChatPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const { user, view } = await loadLeagueView(leagueId);
  const [page, pinned] = await Promise.all([listMessages(db, user, leagueId), listPinned(db, user, leagueId)]);
  const initial: ChatPayload = { ...page, pinned };
  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="text-xl font-semibold">League chat</h2>
        <p className="text-sm text-muted-foreground">
          Plain text only. Links open in a new tab and @username notifies that member. You can edit a message for 15 minutes.
        </p>
      </div>
      <ChatView leagueId={leagueId} initial={initial} canPost={view.myTeam !== null} />
    </div>
  );
}
