export const NOTIFICATION_TYPES = ["draft_on_clock", "draft_wave_open", "draft_heads_up", "draft_events"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_LABELS: Record<NotificationType, { label: string; description: string }> = {
  draft_on_clock: { label: "You're on the clock", description: "It's your turn to pick in the snake draft." },
  draft_wave_open: { label: "Wave opened", description: "A new simultaneous pick wave is open." },
  draft_heads_up: { label: "Pick coming up", description: "Heads-up when you are 2 picks away." },
  draft_events: { label: "Draft events", description: "Draft started or finished, and commissioner actions." },
};

export function isNotificationType(v: unknown): v is NotificationType {
  return typeof v === "string" && (NOTIFICATION_TYPES as readonly string[]).includes(v);
}

export type NotifyInput = {
  userIds: string[];
  leagueId: string | null;
  /** "test" ignores the user's preferences (used by the "send test notification" button). */
  type: NotificationType | "test";
  title: string;
  body: string;
  url: string;
};
