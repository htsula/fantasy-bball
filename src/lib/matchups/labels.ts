import { roundLabel } from "@/lib/fantasy/bracket";
import { etDateString } from "@/lib/nba/dates";

export type MatchupStatusValue = "scheduled" | "live" | "final";

/** What to show for a matchup: an ended period that isn't final yet is waiting on the nightly job. */
export function matchupStatusLabel(status: MatchupStatusValue, periodEndDate: string, now = new Date()): string {
  if (status === "final") return "Final";
  if (etDateString(now) > periodEndDate) return "Pending final";
  return status === "live" ? "Live" : "Upcoming";
}

type LabelPeriod = { number: number; isPlayoff: boolean; playoffRound: number | null };

/**
 * "Week 7", or for playoff periods the round: "Quarterfinal", "Semifinal", "Final" (counted from
 * the last round of `periods`), with "(week 1 of 2)" when a round spans two periods.
 */
export function periodLabel(period: LabelPeriod, periods: readonly LabelPeriod[]): string {
  if (!period.isPlayoff || period.playoffRound === null) return `Week ${period.number}`;
  const rounds = periods.reduce((m, p) => Math.max(m, p.playoffRound ?? 0), 0);
  const label = roundLabel(period.playoffRound, rounds);
  const legs = periods.filter((p) => p.playoffRound === period.playoffRound).sort((a, b) => a.number - b.number);
  return legs.length > 1 ? `${label} (week ${legs.findIndex((p) => p.number === period.number) + 1} of ${legs.length})` : label;
}
