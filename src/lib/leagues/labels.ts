import type { LeagueStatus } from "@/db/schema";

export const LEAGUE_STATUS_LABEL: Record<LeagueStatus, string> = {
  setup: "Setup",
  drafting: "Drafting",
  in_season: "In season",
  playoffs: "Playoffs",
  complete: "Complete",
};
