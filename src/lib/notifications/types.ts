export const NOTIFICATION_TYPES = ["draft_on_clock", "draft_wave_open", "draft_heads_up", "draft_events",
  "roster_auto_drop",
  "league_transactions",
  "matchup_results",
  "trade_offers",
  "trade_updates",
  "trade_review",
  "league_events",
  "chat_mentions",
  "chat_messages",
  "league_announcements",
  "commissioner_actions",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_LABELS: Record<NotificationType, { label: string; description: string }> = {
  draft_on_clock: { label: "You're on the clock", description: "It's your turn to pick in the snake draft." },
  draft_wave_open: { label: "Wave opened", description: "A new simultaneous pick wave is open." },
  draft_heads_up: { label: "Pick coming up", description: "Heads-up when you are 2 picks away." },
  draft_events: { label: "Draft events", description: "Draft started or finished, and commissioner actions." },
  roster_auto_drop: {
    label: "Players cut by the NBA",
    description: "A player on your roster was released and removed from your team.",
  },
  league_transactions: {
    label: "League transactions",
    description: "Adds and drops by other teams in your league. In-app only unless you turn push on.",
  },
  matchup_results: {
    label: "Matchup results",
    description: "Your weekly matchup is final: did you win, lose or tie, and the score.",
  },
  trade_offers: {
    label: "Trade offers",
    description: "Someone sent you a trade offer or a counteroffer.",
  },
  trade_updates: {
    label: "Trade updates",
    description: "Your trades were accepted, rejected, cancelled, expired, vetoed, executed, invalidated or reversed.",
  },
  trade_review: {
    label: "Trade review",
    description: "A trade needs the commissioner's review, or the league is asked to vote on one. League votes are in-app only.",
  },
  league_events: {
    label: "League events",
    description: "Playoff seeding, champions, and the start of a new season.",
  },
  chat_mentions: { label: "Chat mentions", description: "Someone @mentioned you in the league chat." },
  chat_messages: {
    label: "Every chat message",
    description: "Every new message in the league chat. Off by default because it is noisy: turn it on if you want it.",
  },
  league_announcements: { label: "Commissioner announcements", description: "The commissioner posted an announcement to the league." },
  commissioner_actions: {
    label: "Commissioner changes to your team",
    description: "The commissioner changed your roster, your score, or who owns your team.",
  },
};

/** Defaults when the user has no saved preference for a type. */
export const NOTIFICATION_DEFAULTS: Record<NotificationType, { push: boolean; inApp: boolean }> = {
  draft_on_clock: { push: true, inApp: true },
  draft_wave_open: { push: true, inApp: true },
  draft_heads_up: { push: true, inApp: true },
  draft_events: { push: true, inApp: true },
  roster_auto_drop: { push: true, inApp: true },
  league_transactions: { push: false, inApp: true },
  matchup_results: { push: true, inApp: true },
  trade_offers: { push: true, inApp: true },
  trade_updates: { push: true, inApp: true },
  trade_review: { push: true, inApp: true },
  league_events: { push: true, inApp: true },
  chat_mentions: { push: true, inApp: true },
  chat_messages: { push: false, inApp: false },
  league_announcements: { push: true, inApp: true },
  commissioner_actions: { push: true, inApp: true },
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
  /** Never Web Push this one (in-app only), whatever the user's preference says. */
  skipPush?: boolean;
};
