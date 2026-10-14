/** Types and helpers shared by the chat service and the chat UI (no server-only imports). */

export type ChatMessage = {
  id: string;
  userId: string;
  username: string;
  teamName: string | null;
  kind: "message" | "announcement";
  /** Null once deleted. */
  body: string | null;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  pinned: boolean;
  replyTo: { id: string; username: string; snippet: string | null } | null;
  canEdit: boolean;
  canDelete: boolean;
};

export type ChatPage = {
  messages: ChatMessage[];
  /** Older messages exist beyond the first one returned. */
  hasMore: boolean;
  viewer: { userId: string; isCommissioner: boolean };
  members: string[];
};

export function encodeCursor(m: { createdAt: string; id: string }) {
  return `${m.createdAt}_${m.id}`;
}
