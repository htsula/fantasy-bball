import type { PlayoffResult } from "@/db/schema";

export const PLAYOFF_RESULT_LABEL: Record<PlayoffResult, string> = {
  champion: "Champion",
  runner_up: "Runner-up",
  semifinal: "Lost in the semifinal",
  quarterfinal: "Lost in the quarterfinal",
  missed: "Missed the playoffs",
};
