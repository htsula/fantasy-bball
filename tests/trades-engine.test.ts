import { describe, expect, it } from "vitest";
import {
  effectiveReviewMode,
  eligibleVoterCount,
  isPastTradeDeadline,
  isReversible,
  overRosterMax,
  proposalExpiry,
  reviewOutcome,
  reviewWindowEnd,
  rosterCountsAfter,
  validateProposalShape,
  vetoThreshold,
} from "@/lib/trades/engine";

const base = { proposerTeamId: "a", receiverTeamId: "b", give: [1], get: [2] };

describe("validateProposalShape", () => {
  it("accepts uneven and one-sided trades", () => {
    expect(validateProposalShape(base)).toBeNull();
    expect(validateProposalShape({ ...base, give: [1, 2, 3], get: [4] })).toBeNull();
    expect(validateProposalShape({ ...base, give: [], get: [4] })).toBeNull();
    expect(validateProposalShape({ ...base, give: [1], get: [] })).toBeNull();
  });
  it("rejects self trades, empty trades and duplicates", () => {
    expect(validateProposalShape({ ...base, receiverTeamId: "a" })).toBe("same_team");
    expect(validateProposalShape({ ...base, give: [], get: [] })).toBe("empty");
    expect(validateProposalShape({ ...base, give: [1, 1] })).toBe("duplicate_player");
    expect(validateProposalShape({ ...base, give: [1], get: [1] })).toBe("player_on_both_sides");
    expect(validateProposalShape({ ...base, message: "x".repeat(501) })).toBe("message_too_long");
  });
});

describe("roster counts", () => {
  it("computes sizes after an uneven swap and flags the side over the max", () => {
    const after = rosterCountsAfter({ proposer: 10, receiver: 10 }, 3, 1);
    expect(after).toEqual({ proposer: 8, receiver: 12 });
    expect(overRosterMax(after, 10)).toEqual(["receiver"]);
    expect(overRosterMax(after, 12)).toEqual([]);
    expect(overRosterMax(rosterCountsAfter({ proposer: 10, receiver: 10 }, 1, 3), 10)).toEqual(["proposer"]);
  });
});

describe("trade deadline (ET, end of day)", () => {
  it("is open through the end of the deadline day and closed from the next ET midnight", () => {
    expect(isPastTradeDeadline(null, new Date("2030-01-01T00:00:00Z"))).toBe(false);
    // 2026-11-10 is EST: the day ends at 05:00Z on the 11th.
    expect(isPastTradeDeadline("2026-11-10", new Date("2026-11-11T04:59:59Z"))).toBe(false);
    expect(isPastTradeDeadline("2026-11-10", new Date("2026-11-11T05:00:00Z"))).toBe(true);
    // 2026-10-10 is EDT: the day ends at 04:00Z on the 11th.
    expect(isPastTradeDeadline("2026-10-10", new Date("2026-10-11T03:59:59Z"))).toBe(false);
    expect(isPastTradeDeadline("2026-10-10", new Date("2026-10-11T04:00:00Z"))).toBe(true);
  });
});

describe("review", () => {
  const T0 = new Date("2026-11-02T17:00:00Z");
  const end = reviewWindowEnd(T0, 24);
  it("computes the window end and treats a 0-hour window as no review", () => {
    expect(end.toISOString()).toBe("2026-11-03T17:00:00.000Z");
    expect(effectiveReviewMode("commissioner", 0)).toBe("none");
    expect(effectiveReviewMode("league_vote", 24)).toBe("league_vote");
  });
  it("caps the veto threshold at the number of eligible voters", () => {
    expect(eligibleVoterCount(6)).toBe(4);
    expect(eligibleVoterCount(2)).toBe(0);
    expect(vetoThreshold(4, 4)).toBe(4);
    expect(vetoThreshold(4, 2)).toBe(2);
    expect(vetoThreshold(4, 1)).toBe(1);
  });
  const vote = (vetoVotes: number, eligibleVoters: number, now: Date) =>
    reviewOutcome({ mode: "league_vote", vetoVotes, eligibleVoters, vetoVotesNeeded: 4, reviewEndsAt: end, now });
  it("vetoes as soon as the (capped) threshold is reached, otherwise waits then executes", () => {
    expect(vote(3, 6, T0)).toBe("wait");
    expect(vote(4, 6, T0)).toBe("veto");
    expect(vote(2, 2, T0)).toBe("veto"); // needed 4 but only 2 can vote
    expect(vote(1, 2, T0)).toBe("wait");
    expect(vote(3, 6, end)).toBe("execute");
    expect(vote(0, 0, T0)).toBe("wait"); // nobody can vote: never a veto
  });
  it("commissioner review never vetoes by itself; it auto-approves at window end", () => {
    const run = (now: Date) =>
      reviewOutcome({ mode: "commissioner", vetoVotes: 99, eligibleVoters: 5, vetoVotesNeeded: 1, reviewEndsAt: end, now });
    expect(run(new Date(end.getTime() - 1))).toBe("wait");
    expect(run(end)).toBe("execute");
  });
});

describe("time limits", () => {
  it("expires proposals after 7 days and allows reversal for 48 hours", () => {
    expect(proposalExpiry(new Date("2026-11-02T17:00:00Z")).toISOString()).toBe("2026-11-09T17:00:00.000Z");
    const ex = new Date("2026-11-02T17:00:00Z");
    expect(isReversible(ex, new Date("2026-11-04T17:00:00Z"))).toBe(true);
    expect(isReversible(ex, new Date("2026-11-04T17:00:00.001Z"))).toBe(false);
    expect(isReversible(null, ex)).toBe(false);
  });
});
