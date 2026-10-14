/** Activity log vocabulary (pure: safe to import from client components). */

export const ACTIVITY_CATEGORIES = ["roster", "trade", "draft", "playoffs", "settings", "teams", "commissioner"] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export const ACTIVITY_CATEGORY_LABELS: Record<ActivityCategory, string> = {
  roster: "Roster moves",
  trade: "Trades",
  draft: "Draft",
  playoffs: "Playoffs and season",
  settings: "Settings",
  teams: "Teams and members",
  commissioner: "Commissioner actions",
};

type Meta = { category: ActivityCategory; label: string; commissioner?: boolean };

/**
 * Every activity type. `commissioner: true` marks actions only the commissioner can take; the
 * "Commissioner actions" filter shows exactly those, whatever their category.
 */
export const ACTIVITY_TYPES = {
  add: { category: "roster", label: "Add" },
  drop: { category: "roster", label: "Drop" },
  auto_drop: { category: "roster", label: "Cut by NBA" },
  commissioner_add: { category: "roster", label: "Commissioner add", commissioner: true },
  commissioner_drop: { category: "roster", label: "Commissioner drop", commissioner: true },
  commissioner_restore: { category: "roster", label: "Commissioner restore", commissioner: true },

  trade_proposed: { category: "trade", label: "Trade offer" },
  trade_accepted: { category: "trade", label: "Trade accepted" },
  trade_rejected: { category: "trade", label: "Trade rejected" },
  trade_executed: { category: "trade", label: "Trade completed" },
  trade_vetoed: { category: "trade", label: "Trade vetoed" },
  trade_commissioner_approved: { category: "trade", label: "Trade approved", commissioner: true },
  trade_commissioner_vetoed: { category: "trade", label: "Trade vetoed", commissioner: true },
  trade_commissioner_cancelled: { category: "trade", label: "Trade cancelled", commissioner: true },
  trade_commissioner_reversed: { category: "trade", label: "Trade reversed", commissioner: true },

  draft_started: { category: "draft", label: "Draft started" },
  draft_completed: { category: "draft", label: "Draft complete" },
  draft_commissioner_pick: { category: "draft", label: "Commissioner pick", commissioner: true },
  draft_undo: { category: "draft", label: "Pick undone", commissioner: true },
  draft_restart: { category: "draft", label: "Draft restarted", commissioner: true },

  playoffs_seeded: { category: "playoffs", label: "Playoffs seeded" },
  playoffs_reseeded: { category: "playoffs", label: "Playoffs re-seeded", commissioner: true },
  playoffs_override: { category: "playoffs", label: "Playoff winner override", commissioner: true },
  season_complete: { category: "playoffs", label: "Season complete" },

  settings_changed: { category: "settings", label: "Settings changed", commissioner: true },

  team_joined: { category: "teams", label: "Team joined" },
  team_renamed: { category: "teams", label: "Team renamed" },
  team_removed: { category: "teams", label: "Team removed", commissioner: true },
  commissioner_team_edit: { category: "teams", label: "Team edited", commissioner: true },
  team_owner_transferred: { category: "teams", label: "Ownership transferred", commissioner: true },
  commissioner_transferred: { category: "teams", label: "Commissioner changed", commissioner: true },

  score_adjustment: { category: "commissioner", label: "Score adjustment", commissioner: true },
  announcement: { category: "commissioner", label: "Announcement", commissioner: true },
  chat_delete: { category: "commissioner", label: "Chat message removed", commissioner: true },
  chat_pin: { category: "commissioner", label: "Chat pin", commissioner: true },
} as const satisfies Record<string, Meta>;

export type ActivityType = keyof typeof ACTIVITY_TYPES;

export function isActivityType(v: unknown): v is ActivityType {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(ACTIVITY_TYPES, v);
}

export function isCommissionerType(type: string): boolean {
  return isActivityType(type) && "commissioner" in ACTIVITY_TYPES[type];
}

export function typeLabel(type: string): string {
  return isActivityType(type) ? ACTIVITY_TYPES[type].label : type.replace(/_/g, " ");
}

/** Filter choices: the categories, plus "commissioner" = only commissioner-only actions. */
export const ACTIVITY_FILTERS = [...ACTIVITY_CATEGORIES.filter((c) => c !== "commissioner"), "commissioner"] as const;
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number];

export function typesForFilter(filter: ActivityFilter): ActivityType[] {
  const all = Object.keys(ACTIVITY_TYPES) as ActivityType[];
  if (filter === "commissioner") return all.filter((t) => isCommissionerType(t));
  return all.filter((t) => ACTIVITY_TYPES[t].category === filter);
}
