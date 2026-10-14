/**
 * Trade rules as pure functions (no DB): proposal shape, post-trade roster sizes, the trade
 * deadline (end of the ET day), review windows and the veto-vote threshold.
 */
import { addDays, etStartOfDay } from "@/lib/nba/dates";
import type { TradeReviewMode } from "@/lib/fantasy/settings";

/** A proposal expires this long after it was made. */
export const PROPOSAL_EXPIRY_DAYS = 7;
/** The commissioner can reverse an executed trade for this long. */
export const REVERSAL_WINDOW_HOURS = 48;
export const MAX_MESSAGE_LENGTH = 500;

const HOUR_MS = 3_600_000;

export type ProposalShapeError =
  | "same_team"
  | "empty"
  | "duplicate_player"
  | "player_on_both_sides"
  | "message_too_long";

export type ProposalShape = {
  proposerTeamId: string;
  receiverTeamId: string;
  /** Players the proposer gives up. */
  give: number[];
  /** Players the proposer receives. */
  get: number[];
  message?: string | null;
};

/** Structural checks that need no database. Returns the first problem, or null when fine. */
export function validateProposalShape(p: ProposalShape): ProposalShapeError | null {
  if (p.proposerTeamId === p.receiverTeamId) return "same_team";
  if (p.give.length + p.get.length === 0) return "empty";
  if (new Set(p.give).size !== p.give.length || new Set(p.get).size !== p.get.length) return "duplicate_player";
  const give = new Set(p.give);
  if (p.get.some((id) => give.has(id))) return "player_on_both_sides";
  if ((p.message ?? "").length > MAX_MESSAGE_LENGTH) return "message_too_long";
  return null;
}

export type RosterCounts = { proposer: number; receiver: number };

/** Roster sizes after the swap, given the current sizes. */
export function rosterCountsAfter(current: RosterCounts, give: number, get: number): RosterCounts {
  return { proposer: current.proposer - give + get, receiver: current.receiver - get + give };
}

/** Which side(s) would end up over the roster max after the trade. */
export function overRosterMax(after: RosterCounts, max: number): ("proposer" | "receiver")[] {
  const out: ("proposer" | "receiver")[] = [];
  if (after.proposer > max) out.push("proposer");
  if (after.receiver > max) out.push("receiver");
  return out;
}

/**
 * The deadline is a calendar date in ET and is inclusive: trades are open through the END of that
 * day. null means no deadline.
 */
export function isPastTradeDeadline(deadline: string | null, now: Date): boolean {
  if (!deadline) return false;
  return now.getTime() >= etStartOfDay(addDays(deadline, 1)).getTime();
}

export function proposalExpiry(createdAt: Date): Date {
  return new Date(createdAt.getTime() + PROPOSAL_EXPIRY_DAYS * 24 * HOUR_MS);
}

/** Review mode actually applied: a 0-hour window means there's nothing to review. */
export function effectiveReviewMode(mode: TradeReviewMode, hours: number): TradeReviewMode {
  return hours <= 0 ? "none" : mode;
}

export function reviewWindowEnd(acceptedAt: Date, hours: number): Date {
  return new Date(acceptedAt.getTime() + hours * HOUR_MS);
}

/** Teams that may vote: everyone except the two parties. */
export function eligibleVoterCount(teamCount: number): number {
  return Math.max(0, teamCount - 2);
}

/** Veto votes needed to kill a trade: the setting, capped at the number of eligible voters. */
export function vetoThreshold(needed: number, eligibleVoters: number): number {
  return Math.min(Math.max(1, needed), eligibleVoters);
}

export type ReviewOutcome = "veto" | "execute" | "wait";

/**
 * What should happen to a trade under review right now?
 * - league_vote: veto as soon as the threshold is reached; execute when the window ends; else wait.
 * - commissioner: nothing happens by itself until the window ends, then it executes (auto-approve).
 */
export function reviewOutcome(input: {
  mode: TradeReviewMode;
  vetoVotes: number;
  eligibleVoters: number;
  vetoVotesNeeded: number;
  reviewEndsAt: Date;
  now: Date;
}): ReviewOutcome {
  if (input.mode === "league_vote" && input.eligibleVoters > 0) {
    if (input.vetoVotes >= vetoThreshold(input.vetoVotesNeeded, input.eligibleVoters)) return "veto";
  }
  return input.now.getTime() >= input.reviewEndsAt.getTime() ? "execute" : "wait";
}

export function isReversible(executedAt: Date | null, now: Date): boolean {
  return executedAt !== null && now.getTime() - executedAt.getTime() <= REVERSAL_WINDOW_HOURS * HOUR_MS;
}

/** Statuses in which a trade is still undecided. */
export const OPEN_TRADE_STATUSES = ["proposed", "pending_review"] as const;
