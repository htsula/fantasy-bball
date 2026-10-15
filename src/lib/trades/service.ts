/**
 * Trades between fantasy teams: propose / counter / accept / reject / cancel, the review period
 * (commissioner or league vote), execution, commissioner tools (reverse, force-cancel), expiry and
 * the trade block.
 *
 * Concurrency: every mutation locks the league row (SELECT ... FOR UPDATE) inside one
 * transaction, exactly like the roster service. All roster moves in a league are therefore
 * serialized: two accepts that share a player execute one-by-one, and the second finds the player
 * gone (`players_moved`) and is invalidated. Notifications are sent AFTER commit.
 *
 * Design decisions (see README, "Trades"):
 * - Trades open only while the league is `in_season` and before the deadline (end of that ET day).
 *   The deadline is checked when a trade is proposed, countered and accepted. A trade ACCEPTED
 *   before the deadline still executes when its review window ends after the deadline.
 * - Nothing is auto-dropped: if a side would exceed the roster max the trade can't execute
 *   (`roster_full`). Accepting such a trade fails and the trade stays open so the owner can drop
 *   players and accept again; a trade that hits the problem at the END of a review window is
 *   invalidated instead (it can't wait forever).
 */
import { and, asc, desc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { log } from "@/lib/log";
import {
  leagues,
  nbaPlayers,
  nbaTeams,
  rosterEntries,
  teams,
  tradeBlock,
  tradeItems,
  tradeVotes,
  trades,
  transactions,
  type League,
  type Team,
  type Trade,
  type TradeStatus,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { logActivity, type ActivityType } from "@/lib/activity/service";
import { loadSeasonFantasy } from "@/lib/fantasy/stats-query";
import { loadProjections } from "@/lib/fantasy/projections";
import { parseStoredSettings, type LeagueSettings } from "@/lib/fantasy/settings";
import { etDateString } from "@/lib/nba/dates";
import { notifier, type Notifier, type NotifyInput } from "@/lib/notifications/service";
import { leagueMaxRoster } from "@/lib/rosters/service";
import {
  OPEN_TRADE_STATUSES,
  eligibleVoterCount,
  effectiveReviewMode,
  isPastTradeDeadline,
  isReversible,
  overRosterMax,
  proposalExpiry,
  reviewOutcome,
  reviewWindowEnd,
  rosterCountsAfter,
  validateProposalShape,
  vetoThreshold,
} from "./engine";
import { invalidateOpenTradesForPlayers, invalidateTradeRow, tradeUrl, type InvalidationReason } from "./invalidate";

export type TradeErrorCode =
  | "not_found"
  | "forbidden"
  | "wrong_status"
  | "deadline_passed"
  | "same_team"
  | "empty"
  | "duplicate_player"
  | "player_on_both_sides"
  | "message_too_long"
  | "not_your_player"
  | "not_their_player"
  | "team_not_found"
  | "wrong_state"
  | "expired"
  | "players_moved"
  | "roster_full"
  | "not_eligible"
  | "already_voted"
  | "review_closed"
  | "not_reversible"
  | "not_on_roster";

const MESSAGES: Record<TradeErrorCode, string> = {
  not_found: "Trade not found.",
  forbidden: "You don't have permission to do that.",
  wrong_status: "Trades are only open while the league is in its regular season.",
  deadline_passed: "The trade deadline has passed.",
  same_team: "You can't trade with your own team.",
  empty: "A trade needs at least one player.",
  duplicate_player: "A player is listed more than once.",
  player_on_both_sides: "A player can't be on both sides of a trade.",
  message_too_long: "The message is too long (500 characters at most).",
  not_your_player: "You can only offer players who are on your roster.",
  not_their_player: "You can only ask for players who are on the other team's roster.",
  team_not_found: "Team not found in this league.",
  wrong_state: "That isn't possible for a trade in its current state.",
  expired: "This offer expired.",
  players_moved: "A player in this trade is no longer on the team that was offering him, so the trade was cancelled.",
  roster_full: "A team would be over the roster maximum after this trade. Drop players first, then try again.",
  not_eligible: "You can't vote on this trade.",
  already_voted: "You already voted on this trade.",
  review_closed: "The review period for this trade is over.",
  not_reversible: "This trade can't be reversed (more than 48 hours ago, already reversed, or players have moved).",
  not_on_roster: "That player isn't on your roster.",
};

export class TradeError extends Error {
  constructor(
    public code: TradeErrorCode,
    message?: string,
  ) {
    super(message ?? MESSAGES[code]);
  }
}

export type TradeDeps = {
  /** Called after the transaction commits. Defaults to the real in-app + Web Push notifier. */
  notify?: Notifier;
  /** Injectable clock. */
  now?: Date;
};

const REASON_LENGTH = 300;

function isUuid(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

async function sendAll(db: Db, notify: Notifier | undefined, inputs: NotifyInput[]) {
  const send = notify ?? notifier;
  for (const input of inputs) {
    if (input.userIds.length === 0) continue;
    try {
      await send(db, input);
    } catch (err) {
      log.error("trades.notification_failed", {}, err);
    }
  }
}

type Outcome<T> = { value: T; notices: NotifyInput[]; error?: TradeError };

/** Runs `fn` in a transaction, sends its notifications after commit, then throws `error` if set. */
async function commit<T>(db: Db, deps: TradeDeps, fn: (tx: Db) => Promise<Outcome<T>>): Promise<T> {
  const out = await db.transaction((tx) => fn(tx as unknown as Db));
  await sendAll(db, deps.notify, out.notices);
  if (out.error) throw out.error;
  return out.value;
}

// ------------------------------------------------------------------------------------ loading

async function lockLeague(tx: Db, leagueId: string): Promise<League> {
  if (!isUuid(leagueId)) throw new TradeError("not_found");
  const [league] = await tx.select().from(leagues).where(eq(leagues.id, leagueId)).for("update");
  if (!league) throw new TradeError("not_found");
  return league;
}

type Locked = { league: League; settings: LeagueSettings; trade: Trade; items: (typeof tradeItems.$inferSelect)[] };

/** Locks the trade's league, then reads the trade fresh (so decisions use post-lock state). */
async function lockTrade(tx: Db, tradeId: string): Promise<Locked> {
  if (!isUuid(tradeId)) throw new TradeError("not_found");
  const [first] = await tx.select({ leagueId: trades.leagueId }).from(trades).where(eq(trades.id, tradeId));
  if (!first) throw new TradeError("not_found");
  const league = await lockLeague(tx, first.leagueId);
  const [trade] = await tx.select().from(trades).where(eq(trades.id, tradeId));
  if (!trade) throw new TradeError("not_found");
  const items = await tx.select().from(tradeItems).where(eq(tradeItems.tradeId, tradeId));
  return { league, settings: parseStoredSettings(league.settings), trade, items };
}

async function teamsOf(tx: Db, leagueId: string): Promise<Map<string, Team>> {
  const rows = await tx.select().from(teams).where(eq(teams.leagueId, leagueId));
  return new Map(rows.map((t) => [t.id, t]));
}

async function playerNames(tx: Db, ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.select({ id: nbaPlayers.id, name: nbaPlayers.fullName }).from(nbaPlayers).where(inArray(nbaPlayers.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** player id -> team id for players currently on an active roster of the league. */
async function holders(tx: Db, leagueId: string, playerIds: number[]): Promise<Map<number, string>> {
  if (playerIds.length === 0) return new Map();
  const rows = await tx
    .select({ playerId: rosterEntries.playerId, teamId: rosterEntries.teamId })
    .from(rosterEntries)
    .where(and(eq(rosterEntries.leagueId, leagueId), isNull(rosterEntries.releasedAt), inArray(rosterEntries.playerId, playerIds)));
  return new Map(rows.map((r) => [r.playerId, r.teamId]));
}

async function rosterSize(tx: Db, teamId: string): Promise<number> {
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(rosterEntries)
    .where(and(eq(rosterEntries.teamId, teamId), isNull(rosterEntries.releasedAt)));
  return n;
}

function assertTradingOpen(league: League, settings: LeagueSettings, now: Date) {
  if (league.status !== "in_season") throw new TradeError("wrong_status");
  if (isPastTradeDeadline(settings.tradeDeadline, now)) throw new TradeError("deadline_passed");
}

const ownerOf = (teamMap: Map<string, Team>, teamId: string) => teamMap.get(teamId)!.ownerId;

function parties(teamMap: Map<string, Team>, t: Pick<Trade, "proposerTeamId" | "receiverTeamId">) {
  return { proposer: teamMap.get(t.proposerTeamId)!, receiver: teamMap.get(t.receiverTeamId)! };
}

function partyOwners(teamMap: Map<string, Team>, t: Pick<Trade, "proposerTeamId" | "receiverTeamId">): string[] {
  const p = parties(teamMap, t);
  return [p.proposer.ownerId, p.receiver.ownerId];
}

/** Writes a trade line to the league activity log (inside the caller's transaction). */
async function logTrade(
  tx: Db,
  trade: Pick<Trade, "id" | "leagueId" | "proposerTeamId" | "receiverTeamId">,
  teamMap: Map<string, Team>,
  type: ActivityType,
  verb: string,
  actorUserId: string | null,
  now: Date,
  extra: Record<string, unknown> = {},
) {
  const p = parties(teamMap, trade);
  await logActivity(tx, {
    leagueId: trade.leagueId,
    actorUserId,
    type,
    summary: `${verb} the trade between ${p.proposer.name} and ${p.receiver.name}.`,
    data: { tradeId: trade.id, url: tradeUrl(trade.leagueId, trade.id), ...extra },
    now,
  });
}

/** Marks the trade expired when its 7 days are up. Returns the notification, or null. */
async function expireIfDue(tx: Db, locked: Locked, teamMap: Map<string, Team>, now: Date): Promise<NotifyInput | null> {
  const { trade } = locked;
  if (trade.status !== "proposed" || now.getTime() < trade.expiresAt.getTime()) return null;
  await tx
    .update(trades)
    .set({ status: "expired", resolvedReason: "No response within 7 days.", updatedAt: now })
    .where(eq(trades.id, trade.id));
  const p = parties(teamMap, trade);
  return {
    userIds: [p.proposer.ownerId, p.receiver.ownerId],
    leagueId: trade.leagueId,
    type: "trade_updates",
    title: "Trade offer expired",
    body: `The offer between ${p.proposer.name} and ${p.receiver.name} expired after 7 days without a response.`,
    url: tradeUrl(trade.leagueId, trade.id),
  };
}

// --------------------------------------------------------------------------------- proposals

export type ProposeInput = {
  leagueId: string;
  proposerTeamId: string;
  receiverTeamId: string;
  /** Players the proposer gives up. */
  give: number[];
  /** Players the proposer receives. */
  get: number[];
  message?: string | null;
  actorUserId: string;
};

type NewProposal = {
  league: League;
  settings: LeagueSettings;
  teamMap: Map<string, Team>;
  proposerTeamId: string;
  receiverTeamId: string;
  give: number[];
  get: number[];
  message: string | null;
  actorUserId: string;
  counteredFrom: string | null;
};

/** Validates and inserts a proposal; the league row must already be locked by the caller. */
async function insertProposal(tx: Db, p: NewProposal, now: Date): Promise<{ trade: Trade; notice: NotifyInput }> {
  assertTradingOpen(p.league, p.settings, now);
  const proposer = p.teamMap.get(p.proposerTeamId);
  const receiver = p.teamMap.get(p.receiverTeamId);
  if (!proposer || !receiver) throw new TradeError("team_not_found");
  if (proposer.ownerId !== p.actorUserId) throw new TradeError("forbidden");
  const message = p.message?.trim() ? p.message.trim() : null;
  const shapeError = validateProposalShape({
    proposerTeamId: p.proposerTeamId,
    receiverTeamId: p.receiverTeamId,
    give: p.give,
    get: p.get,
    message,
  });
  if (shapeError) throw new TradeError(shapeError);
  if ([...p.give, ...p.get].some((id) => !Number.isInteger(id))) throw new TradeError("not_found");

  const held = await holders(tx, p.league.id, [...p.give, ...p.get]);
  if (p.give.some((id) => held.get(id) !== p.proposerTeamId)) throw new TradeError("not_your_player");
  if (p.get.some((id) => held.get(id) !== p.receiverTeamId)) throw new TradeError("not_their_player");

  const [trade] = await tx
    .insert(trades)
    .values({
      leagueId: p.league.id,
      proposerTeamId: p.proposerTeamId,
      receiverTeamId: p.receiverTeamId,
      status: "proposed",
      message,
      counteredFrom: p.counteredFrom,
      proposedBy: p.actorUserId,
      expiresAt: proposalExpiry(now),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  await tx.insert(tradeItems).values([
    ...p.give.map((playerId) => ({ tradeId: trade.id, playerId, fromTeamId: p.proposerTeamId, toTeamId: p.receiverTeamId })),
    ...p.get.map((playerId) => ({ tradeId: trade.id, playerId, fromTeamId: p.receiverTeamId, toTeamId: p.proposerTeamId })),
  ]);
  const counter = p.counteredFrom !== null;
  await logActivity(tx, {
    leagueId: p.league.id,
    actorUserId: p.actorUserId,
    type: "trade_proposed",
    summary: `${proposer.name} ${counter ? "countered with" : "offered"} a trade (${p.give.length} for ${p.get.length}) to ${receiver.name}.`,
    data: { tradeId: trade.id, url: tradeUrl(p.league.id, trade.id) },
    now,
  });
  return {
    trade,
    notice: {
      userIds: [receiver.ownerId],
      leagueId: p.league.id,
      type: "trade_offers",
      title: counter ? `Counteroffer from ${proposer.name}` : `Trade offer from ${proposer.name}`,
      body: `${proposer.name} offers ${p.give.length} player${p.give.length === 1 ? "" : "s"} for ${p.get.length}. Review it in Trades.`,
      url: tradeUrl(p.league.id, trade.id),
    },
  };
}

/** A team owner offers a trade to another team. */
export async function proposeTrade(db: Db, input: ProposeInput, deps: TradeDeps = {}): Promise<Trade> {
  const now = deps.now ?? new Date();
  return commit(db, deps, async (tx) => {
    const league = await lockLeague(tx, input.leagueId);
    const teamMap = await teamsOf(tx, league.id);
    const { trade, notice } = await insertProposal(
      tx,
      {
        league,
        settings: parseStoredSettings(league.settings),
        teamMap,
        proposerTeamId: input.proposerTeamId,
        receiverTeamId: input.receiverTeamId,
        give: input.give,
        get: input.get,
        message: input.message ?? null,
        actorUserId: input.actorUserId,
        counteredFrom: null,
      },
      now,
    );
    return { value: trade, notices: [notice] };
  });
}

export type CounterInput = {
  tradeId: string;
  /** Players the countering team (the original receiver) gives up. */
  give: number[];
  /** Players the countering team receives (from the original proposer). */
  get: number[];
  message?: string | null;
  actorUserId: string;
};

/** The receiver answers with a new offer; the original becomes `countered`. */
export async function counterTrade(db: Db, input: CounterInput, deps: TradeDeps = {}): Promise<Trade> {
  const now = deps.now ?? new Date();
  return commit(db, deps, async (tx) => {
    const locked = await lockTrade(tx, input.tradeId);
    const teamMap = await teamsOf(tx, locked.league.id);
    const expiredNotice = await expireIfDue(tx, locked, teamMap, now);
    if (expiredNotice) return { value: undefined as unknown as Trade, notices: [expiredNotice], error: new TradeError("expired") };
    const { trade } = locked;
    if (trade.status !== "proposed" || trade.kind !== "trade") throw new TradeError("wrong_state");
    if (ownerOf(teamMap, trade.receiverTeamId) !== input.actorUserId) throw new TradeError("forbidden");

    const created = await insertProposal(
      tx,
      {
        league: locked.league,
        settings: locked.settings,
        teamMap,
        proposerTeamId: trade.receiverTeamId,
        receiverTeamId: trade.proposerTeamId,
        give: input.give,
        get: input.get,
        message: input.message ?? null,
        actorUserId: input.actorUserId,
        counteredFrom: trade.id,
      },
      now,
    );
    await tx
      .update(trades)
      .set({ status: "countered", respondedAt: now, resolvedReason: "Countered.", updatedAt: now })
      .where(eq(trades.id, trade.id));
    return { value: created.trade, notices: [created.notice] };
  });
}

/** The receiver turns the offer down. */
export async function rejectTrade(db: Db, input: { tradeId: string; actorUserId: string }, deps: TradeDeps = {}): Promise<void> {
  const now = deps.now ?? new Date();
  await commit(db, deps, async (tx) => {
    const locked = await lockTrade(tx, input.tradeId);
    const teamMap = await teamsOf(tx, locked.league.id);
    const expiredNotice = await expireIfDue(tx, locked, teamMap, now);
    if (expiredNotice) return { value: undefined, notices: [expiredNotice], error: new TradeError("expired") };
    const { trade } = locked;
    if (trade.status !== "proposed") throw new TradeError("wrong_state");
    if (ownerOf(teamMap, trade.receiverTeamId) !== input.actorUserId) throw new TradeError("forbidden");
    await tx
      .update(trades)
      .set({ status: "rejected", respondedAt: now, resolvedReason: "Rejected.", updatedAt: now })
      .where(eq(trades.id, trade.id));
    const p = parties(teamMap, trade);
    await logActivity(tx, {
      leagueId: trade.leagueId,
      actorUserId: input.actorUserId,
      type: "trade_rejected",
      summary: `${p.receiver.name} rejected a trade offer from ${p.proposer.name}.`,
      data: { tradeId: trade.id, url: tradeUrl(trade.leagueId, trade.id) },
      now,
    });
    return {
      value: undefined,
      notices: [
        {
          userIds: [p.proposer.ownerId],
          leagueId: trade.leagueId,
          type: "trade_updates",
          title: "Trade rejected",
          body: `${p.receiver.name} rejected your offer.`,
          url: tradeUrl(trade.leagueId, trade.id),
        },
      ],
    };
  });
}

/** The proposer withdraws an offer that hasn't been answered. */
export async function cancelTrade(db: Db, input: { tradeId: string; actorUserId: string }, deps: TradeDeps = {}): Promise<void> {
  const now = deps.now ?? new Date();
  await commit(db, deps, async (tx) => {
    const locked = await lockTrade(tx, input.tradeId);
    const teamMap = await teamsOf(tx, locked.league.id);
    const expiredNotice = await expireIfDue(tx, locked, teamMap, now);
    if (expiredNotice) return { value: undefined, notices: [expiredNotice], error: new TradeError("expired") };
    const { trade } = locked;
    if (trade.status !== "proposed") throw new TradeError("wrong_state");
    if (ownerOf(teamMap, trade.proposerTeamId) !== input.actorUserId) throw new TradeError("forbidden");
    await tx
      .update(trades)
      .set({ status: "cancelled", respondedAt: now, resolvedReason: "Cancelled by the proposer.", updatedAt: now })
      .where(eq(trades.id, trade.id));
    const p = parties(teamMap, trade);
    return {
      value: undefined,
      notices: [
        {
          userIds: [p.receiver.ownerId],
          leagueId: trade.leagueId,
          type: "trade_updates",
          title: "Trade offer withdrawn",
          body: `${p.proposer.name} withdrew their offer.`,
          url: tradeUrl(trade.leagueId, trade.id),
        },
      ],
    };
  });
}

// ----------------------------------------------------------------------------------- execution

type ExecResult = { ok: true; notices: NotifyInput[] } | { ok: false; reason: InvalidationReason; error: TradeError };

/** Releases and re-creates roster entries for each item at one timestamp, and logs transactions. */
async function moveItems(
  tx: Db,
  league: League,
  items: { playerId: number; fromTeamId: string; toTeamId: string }[],
  now: Date,
  log: (item: { playerId: number; fromTeamId: string; toTeamId: string }) => (typeof transactions.$inferInsert)[],
) {
  const ids = items.map((i) => i.playerId);
  await tx
    .update(rosterEntries)
    .set({ releasedAt: now, releasedVia: "trade" })
    .where(and(eq(rosterEntries.leagueId, league.id), isNull(rosterEntries.releasedAt), inArray(rosterEntries.playerId, ids)));
  await tx.insert(rosterEntries).values(
    items.map((i) => ({
      leagueId: league.id,
      teamId: i.toTeamId,
      playerId: i.playerId,
      acquiredVia: "trade" as const,
      acquiredAt: now,
    })),
  );
  await tx.insert(transactions).values(items.flatMap(log));
  // Players who changed teams are no longer on their old team's block.
  await tx.delete(tradeBlock).where(and(eq(tradeBlock.leagueId, league.id), inArray(tradeBlock.playerId, ids)));
}

/**
 * Executes a locked trade. Checks (in order) that the league is in season, every player is still
 * with the team that offers him, and both rosters fit the maximum afterwards. Never throws for
 * those expected failures: the caller decides whether to invalidate or surface the error.
 */
async function tryExecute(
  tx: Db,
  locked: Locked,
  teamMap: Map<string, Team>,
  now: Date,
  actorUserId: string | null,
  note: string | null,
): Promise<ExecResult> {
  const { league, trade, items } = locked;
  if (league.status !== "in_season") return { ok: false, reason: "league_closed", error: new TradeError("wrong_status") };
  const held = await holders(tx, league.id, items.map((i) => i.playerId));
  if (items.some((i) => held.get(i.playerId) !== i.fromTeamId)) {
    return { ok: false, reason: "player_moved", error: new TradeError("players_moved") };
  }
  const give = items.filter((i) => i.fromTeamId === trade.proposerTeamId).length;
  const get = items.length - give;
  const [proposerCount, receiverCount, max] = await Promise.all([
    rosterSize(tx, trade.proposerTeamId),
    rosterSize(tx, trade.receiverTeamId),
    leagueMaxRoster(tx, league),
  ]);
  const over = overRosterMax(rosterCountsAfter({ proposer: proposerCount, receiver: receiverCount }, give, get), max);
  if (over.length > 0) {
    const names = over.map((side) => teamMap.get(side === "proposer" ? trade.proposerTeamId : trade.receiverTeamId)!.name);
    return {
      ok: false,
      reason: "roster_full",
      error: new TradeError("roster_full", `${names.join(" and ")} would be over the roster maximum of ${max} after this trade. Drop players first, then try again.`),
    };
  }

  await moveItems(tx, league, items, now, (i) => [
    {
      leagueId: league.id,
      teamId: i.toTeamId,
      type: "trade" as const,
      playerId: i.playerId,
      groupId: trade.id,
      actorUserId,
      createdAt: now,
      etDate: etDateString(now),
      note: [`From ${teamMap.get(i.fromTeamId)!.name}`, note].filter(Boolean).join(". "),
    },
  ]);
  await tx
    .update(trades)
    .set({
      status: "executed",
      executedAt: now,
      updatedAt: now,
      ...(note ? { resolvedReason: note } : {}),
    })
    .where(eq(trades.id, trade.id));

  const others = await invalidateOpenTradesForPlayers(
    tx,
    league.id,
    items.map((i) => i.playerId),
    "player_moved",
    now,
    { excludeTradeId: trade.id },
  );
  const p = parties(teamMap, trade);
  const names = await playerNames(tx, items.map((i) => i.playerId));
  const received = (teamId: string) =>
    items.filter((i) => i.toTeamId === teamId).map((i) => names.get(i.playerId) ?? "a player").join(", ") || "nobody";
  await logActivity(tx, {
    leagueId: league.id,
    actorUserId,
    type: "trade_executed",
    summary: `Trade completed: ${p.proposer.name} receives ${received(p.proposer.id)}; ${p.receiver.name} receives ${received(p.receiver.id)}.`,
    data: { tradeId: trade.id, url: tradeUrl(league.id, trade.id) },
    now,
  });
  const notices: NotifyInput[] = [
    {
      userIds: [p.proposer.ownerId, p.receiver.ownerId],
      leagueId: league.id,
      type: "trade_updates",
      title: "Trade completed",
      body: `${p.proposer.name} and ${p.receiver.name} completed a trade. Rosters are updated.`,
      url: tradeUrl(league.id, trade.id),
    },
    {
      userIds: [...teamMap.values()].map((t) => t.ownerId).filter((u) => u !== p.proposer.ownerId && u !== p.receiver.ownerId),
      leagueId: league.id,
      type: "league_transactions",
      title: "Trade completed",
      body: `${p.proposer.name} and ${p.receiver.name} completed a trade.`,
      url: tradeUrl(league.id, trade.id),
    },
    ...others,
  ];
  return { ok: true, notices };
}

/** Executes or invalidates a pending-review trade (shared by approve, vote outcome and the clock). */
async function finishReview(
  tx: Db,
  locked: Locked,
  teamMap: Map<string, Team>,
  now: Date,
  actorUserId: string | null,
  note: string | null,
  failureMode: "throw" | "invalidate",
): Promise<Outcome<void>> {
  const res = await tryExecute(tx, locked, teamMap, now, actorUserId, note);
  if (res.ok) return { value: undefined, notices: res.notices };
  // Moved players and a closed league can never recover; a full roster can, so it only
  // invalidates when nobody is around to fix it (the review window already ended).
  if (res.reason === "roster_full" && failureMode === "throw") throw res.error;
  const notice = await invalidateTradeRow(tx, locked.trade, res.reason, now);
  return { value: undefined, notices: [notice], error: failureMode === "throw" ? res.error : undefined };
}

// ------------------------------------------------------------------------------------ accept

/**
 * The receiver accepts. With review `none` (or a 0-hour window) the trade executes right away;
 * otherwise it goes to `pending_review` for the commissioner or the league vote.
 */
export async function acceptTrade(
  db: Db,
  input: { tradeId: string; actorUserId: string },
  deps: TradeDeps = {},
): Promise<{ status: TradeStatus }> {
  const now = deps.now ?? new Date();
  return commit(db, deps, async (tx) => {
    const locked = await lockTrade(tx, input.tradeId);
    const teamMap = await teamsOf(tx, locked.league.id);
    const expiredNotice = await expireIfDue(tx, locked, teamMap, now);
    if (expiredNotice) return { value: { status: "expired" as TradeStatus }, notices: [expiredNotice], error: new TradeError("expired") };
    const { trade, league, settings } = locked;
    if (trade.status === "invalidated") throw new TradeError("players_moved");
    if (trade.status !== "proposed") throw new TradeError("wrong_state");
    if (ownerOf(teamMap, trade.receiverTeamId) !== input.actorUserId) throw new TradeError("forbidden");
    assertTradingOpen(league, settings, now);

    const mode = effectiveReviewMode(settings.tradeReview, settings.tradeReviewHours);
    await tx
      .update(trades)
      .set({ respondedAt: now, acceptedAt: now, updatedAt: now })
      .where(eq(trades.id, trade.id));
    {
      const ap = parties(teamMap, trade);
      await logActivity(tx, {
        leagueId: league.id,
        actorUserId: input.actorUserId,
        type: "trade_accepted",
        summary: `${ap.receiver.name} accepted a trade offer from ${ap.proposer.name}.`,
        data: { tradeId: trade.id, url: tradeUrl(league.id, trade.id) },
        now: new Date(now.getTime() - 1), // sorts just before the "executed" entry written at `now`
      });
    }

    if (mode === "none") {
      const res = await tryExecute(tx, locked, teamMap, now, input.actorUserId, null);
      if (res.ok) return { value: { status: "executed" as TradeStatus }, notices: res.notices };
      if (res.reason === "roster_full") throw res.error; // rolls back: the offer stays open
      const notice = await invalidateTradeRow(tx, trade, res.reason, now);
      return { value: { status: "invalidated" as TradeStatus }, notices: [notice], error: res.error };
    }

    // Under review: make sure the trade is valid now so a stale offer isn't put up for a vote.
    const held = await holders(tx, league.id, locked.items.map((i) => i.playerId));
    if (locked.items.some((i) => held.get(i.playerId) !== i.fromTeamId)) {
      const notice = await invalidateTradeRow(tx, trade, "player_moved", now);
      return { value: { status: "invalidated" as TradeStatus }, notices: [notice], error: new TradeError("players_moved") };
    }
    const reviewEndsAt = reviewWindowEnd(now, settings.tradeReviewHours);
    await tx.update(trades).set({ status: "pending_review", reviewEndsAt }).where(eq(trades.id, trade.id));

    const p = parties(teamMap, trade);
    const notices: NotifyInput[] = [
      {
        userIds: [p.proposer.ownerId],
        leagueId: league.id,
        type: "trade_updates",
        title: "Trade accepted",
        body: `${p.receiver.name} accepted your offer. It is under ${mode === "commissioner" ? "commissioner" : "league"} review until the window ends.`,
        url: tradeUrl(league.id, trade.id),
      },
    ];
    if (mode === "commissioner") {
      notices.push({
        userIds: [league.commissionerId],
        leagueId: league.id,
        type: "trade_review",
        title: "Trade needs your review",
        body: `${p.proposer.name} and ${p.receiver.name} agreed to a trade. Approve or veto it before the window ends or it goes through automatically.`,
        url: tradeUrl(league.id, trade.id),
      });
    } else {
      notices.push({
        userIds: voterUserIds(teamMap, trade),
        leagueId: league.id,
        type: "trade_review",
        title: "Vote on a trade",
        body: `${p.proposer.name} and ${p.receiver.name} agreed to a trade. You can vote to veto it until the review window ends.`,
        url: tradeUrl(league.id, trade.id),
        skipPush: true,
      });
    }
    return { value: { status: "pending_review" as TradeStatus }, notices };
  });
}

function voterUserIds(teamMap: Map<string, Team>, trade: Pick<Trade, "proposerTeamId" | "receiverTeamId">): string[] {
  return [...teamMap.values()]
    .filter((t) => t.id !== trade.proposerTeamId && t.id !== trade.receiverTeamId)
    .map((t) => t.ownerId);
}

// ------------------------------------------------------------------------------------- voting

/** A non-party team casts a vote on a trade under league-vote review. Only vetoes count. */
export async function castVote(
  db: Db,
  input: { tradeId: string; actorUserId: string; vote: "veto" | "approve" },
  deps: TradeDeps = {},
): Promise<{ status: TradeStatus; vetoVotes: number; threshold: number }> {
  const now = deps.now ?? new Date();
  if (input.vote !== "veto" && input.vote !== "approve") throw new TradeError("not_eligible");
  return commit(db, deps, async (tx) => {
    const locked = await lockTrade(tx, input.tradeId);
    const { trade, settings, league } = locked;
    if (trade.status !== "pending_review" || effectiveReviewMode(settings.tradeReview, settings.tradeReviewHours) !== "league_vote") {
      throw new TradeError("wrong_state");
    }
    if (trade.reviewEndsAt && now.getTime() >= trade.reviewEndsAt.getTime()) throw new TradeError("review_closed");
    const teamMap = await teamsOf(tx, league.id);
    const myTeam = [...teamMap.values()].find((t) => t.ownerId === input.actorUserId);
    if (!myTeam || myTeam.id === trade.proposerTeamId || myTeam.id === trade.receiverTeamId) throw new TradeError("not_eligible");
    const [existing] = await tx
      .select({ teamId: tradeVotes.teamId })
      .from(tradeVotes)
      .where(and(eq(tradeVotes.tradeId, trade.id), eq(tradeVotes.teamId, myTeam.id)));
    if (existing) throw new TradeError("already_voted");
    await tx
      .insert(tradeVotes)
      .values({ tradeId: trade.id, teamId: myTeam.id, voterUserId: input.actorUserId, vote: input.vote, createdAt: now });

    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(tradeVotes)
      .where(and(eq(tradeVotes.tradeId, trade.id), eq(tradeVotes.vote, "veto")));
    const eligible = eligibleVoterCount(teamMap.size);
    const threshold = vetoThreshold(settings.vetoVotesNeeded, eligible);
    const outcome = reviewOutcome({
      mode: "league_vote",
      vetoVotes: n,
      eligibleVoters: eligible,
      vetoVotesNeeded: settings.vetoVotesNeeded,
      reviewEndsAt: trade.reviewEndsAt ?? now,
      now,
    });
    if (outcome === "veto") {
      await tx
        .update(trades)
        .set({ status: "vetoed", resolvedReason: `Vetoed by the league (${n} veto vote${n === 1 ? "" : "s"}).`, updatedAt: now })
        .where(eq(trades.id, trade.id));
      const p = parties(teamMap, trade);
      await logTrade(tx, trade, teamMap, "trade_vetoed", "The league vetoed", null, now);
      return {
        value: { status: "vetoed" as TradeStatus, vetoVotes: n, threshold },
        notices: [
          {
            userIds: [p.proposer.ownerId, p.receiver.ownerId],
            leagueId: league.id,
            type: "trade_updates",
            title: "Trade vetoed",
            body: `The league vetoed the trade between ${p.proposer.name} and ${p.receiver.name}.`,
            url: tradeUrl(league.id, trade.id),
          },
        ],
      };
    }
    return { value: { status: "pending_review" as TradeStatus, vetoVotes: n, threshold }, notices: [] };
  });
}

// ------------------------------------------------------------------------ commissioner actions

function commissionerNote(teamMap: Map<string, Team>, trade: Trade, commissionerId: string, verb: string): string {
  const party = partyOwners(teamMap, trade).includes(commissionerId);
  return `${verb} by the commissioner${party ? " (who is a party to this trade)" : ""}.`;
}

/** Commissioner review: approve and execute now (commissioner-review leagues only). */
export async function commissionerApprove(
  db: Db,
  input: { tradeId: string; actorUserId: string },
  deps: TradeDeps = {},
): Promise<void> {
  const now = deps.now ?? new Date();
  await commit(db, deps, async (tx) => {
    const locked = await lockTrade(tx, input.tradeId);
    const { league, trade, settings } = locked;
    if (league.commissionerId !== input.actorUserId) throw new TradeError("forbidden");
    if (trade.status !== "pending_review" || effectiveReviewMode(settings.tradeReview, settings.tradeReviewHours) !== "commissioner") {
      throw new TradeError("wrong_state");
    }
    const teamMap = await teamsOf(tx, league.id);
    const out = await finishReview(tx, locked, teamMap, now, input.actorUserId, commissionerNote(teamMap, trade, input.actorUserId, "Approved"), "throw");
    if (!out.error) await logTrade(tx, trade, teamMap, "trade_commissioner_approved", "Commissioner approved", input.actorUserId, now);
    return out;
  });
}

/** Commissioner review: veto, with an optional reason. */
export async function commissionerVeto(
  db: Db,
  input: { tradeId: string; actorUserId: string; reason?: string | null },
  deps: TradeDeps = {},
): Promise<void> {
  const now = deps.now ?? new Date();
  await commit(db, deps, async (tx) => {
    const locked = await lockTrade(tx, input.tradeId);
    const { league, trade, settings } = locked;
    if (league.commissionerId !== input.actorUserId) throw new TradeError("forbidden");
    if (trade.status !== "pending_review" || effectiveReviewMode(settings.tradeReview, settings.tradeReviewHours) !== "commissioner") {
      throw new TradeError("wrong_state");
    }
    const teamMap = await teamsOf(tx, league.id);
    const reason = input.reason?.trim().slice(0, REASON_LENGTH);
    const note = commissionerNote(teamMap, trade, input.actorUserId, "Vetoed") + (reason ? ` Reason: ${reason}` : "");
    await tx.update(trades).set({ status: "vetoed", resolvedReason: note, updatedAt: now }).where(eq(trades.id, trade.id));
    await logTrade(tx, trade, teamMap, "trade_commissioner_vetoed", "Commissioner vetoed", input.actorUserId, now, reason ? { reason } : {});
    const p = parties(teamMap, trade);
    return {
      value: undefined,
      notices: [
        {
          userIds: [p.proposer.ownerId, p.receiver.ownerId],
          leagueId: league.id,
          type: "trade_updates",
          title: "Trade vetoed",
          body: `The commissioner vetoed the trade between ${p.proposer.name} and ${p.receiver.name}.${reason ? ` Reason: ${reason}` : ""}`,
          url: tradeUrl(league.id, trade.id),
        },
      ],
    };
  });
}

/** Commissioner cancels any open trade (proposed or under review). */
export async function forceCancelTrade(
  db: Db,
  input: { tradeId: string; actorUserId: string; reason?: string | null },
  deps: TradeDeps = {},
): Promise<void> {
  const now = deps.now ?? new Date();
  await commit(db, deps, async (tx) => {
    const locked = await lockTrade(tx, input.tradeId);
    const { league, trade } = locked;
    if (league.commissionerId !== input.actorUserId) throw new TradeError("forbidden");
    if (!(OPEN_TRADE_STATUSES as readonly string[]).includes(trade.status)) throw new TradeError("wrong_state");
    const teamMap = await teamsOf(tx, league.id);
    const reason = input.reason?.trim().slice(0, REASON_LENGTH);
    await tx
      .update(trades)
      .set({
        status: "cancelled",
        resolvedReason: `Cancelled by the commissioner.${reason ? ` Reason: ${reason}` : ""}`,
        updatedAt: now,
      })
      .where(eq(trades.id, trade.id));
    await logTrade(tx, trade, teamMap, "trade_commissioner_cancelled", "Commissioner cancelled", input.actorUserId, now, reason ? { reason } : {});
    const p = parties(teamMap, trade);
    return {
      value: undefined,
      notices: [
        {
          userIds: [p.proposer.ownerId, p.receiver.ownerId],
          leagueId: league.id,
          type: "trade_updates",
          title: "Trade cancelled",
          body: `The commissioner cancelled the trade between ${p.proposer.name} and ${p.receiver.name}.${reason ? ` Reason: ${reason}` : ""}`,
          url: tradeUrl(league.id, trade.id),
        },
      ],
    };
  });
}

/**
 * Commissioner undoes an executed trade within 48 hours, provided every player is still on the
 * team he went to and both rosters fit. Creates a `reversal` trade record that moves everyone
 * back; the original becomes `reversed`.
 */
export async function commissionerReverse(
  db: Db,
  input: { tradeId: string; actorUserId: string; reason?: string | null },
  deps: TradeDeps = {},
): Promise<Trade> {
  const now = deps.now ?? new Date();
  return commit(db, deps, async (tx) => {
    const locked = await lockTrade(tx, input.tradeId);
    const { league, trade, items } = locked;
    if (league.commissionerId !== input.actorUserId) throw new TradeError("forbidden");
    if (trade.kind !== "trade" || trade.status !== "executed" || trade.reversedByTradeId) throw new TradeError("not_reversible");
    if (!isReversible(trade.executedAt, now)) throw new TradeError("not_reversible");
    if (league.status !== "in_season" && league.status !== "playoffs") throw new TradeError("wrong_status");

    const held = await holders(tx, league.id, items.map((i) => i.playerId));
    if (items.some((i) => held.get(i.playerId) !== i.toTeamId)) throw new TradeError("not_reversible");

    const back = items.map((i) => ({ playerId: i.playerId, fromTeamId: i.toTeamId, toTeamId: i.fromTeamId }));
    // Original proposer sent `give` players away and received `get`; the reversal sends them back.
    const sentBackByProposer = back.filter((b) => b.fromTeamId === trade.proposerTeamId).length;
    const [proposerCount, receiverCount, max] = await Promise.all([
      rosterSize(tx, trade.proposerTeamId),
      rosterSize(tx, trade.receiverTeamId),
      leagueMaxRoster(tx, league),
    ]);
    const over = overRosterMax(
      rosterCountsAfter({ proposer: proposerCount, receiver: receiverCount }, sentBackByProposer, back.length - sentBackByProposer),
      max,
    );
    if (over.length > 0) throw new TradeError("roster_full");

    const teamMap = await teamsOf(tx, league.id);
    const reason = input.reason?.trim().slice(0, REASON_LENGTH);
    const [reversal] = await tx
      .insert(trades)
      .values({
        leagueId: league.id,
        kind: "reversal",
        proposerTeamId: trade.receiverTeamId,
        receiverTeamId: trade.proposerTeamId,
        status: "executed",
        counteredFrom: null,
        proposedBy: input.actorUserId,
        respondedAt: now,
        acceptedAt: now,
        executedAt: now,
        expiresAt: now,
        resolvedReason: `Reversal of a trade by the commissioner.${reason ? ` Reason: ${reason}` : ""}`,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await tx.insert(tradeItems).values(back.map((b) => ({ tradeId: reversal.id, ...b })));
    const names = await playerNames(tx, items.map((i) => i.playerId));
    await moveItems(tx, league, back, now, (b) => [
      {
        leagueId: league.id,
        teamId: b.fromTeamId,
        type: "commissioner_drop" as const,
        playerId: b.playerId,
        groupId: reversal.id,
        actorUserId: input.actorUserId,
        createdAt: now,
        etDate: etDateString(now),
        note: `Trade reversed by the commissioner (${names.get(b.playerId) ?? "player"} returns to ${teamMap.get(b.toTeamId)!.name})`,
      },
      {
        leagueId: league.id,
        teamId: b.toTeamId,
        type: "commissioner_add" as const,
        playerId: b.playerId,
        groupId: reversal.id,
        actorUserId: input.actorUserId,
        createdAt: now,
        etDate: etDateString(now),
        note: "Trade reversed by the commissioner",
      },
    ]);
    await tx
      .update(trades)
      .set({ status: "reversed", reversedByTradeId: reversal.id, updatedAt: now })
      .where(eq(trades.id, trade.id));
    const others = await invalidateOpenTradesForPlayers(
      tx,
      league.id,
      items.map((i) => i.playerId),
      "player_moved",
      now,
      { excludeTradeId: reversal.id },
    );
    await logTrade(tx, trade, teamMap, "trade_commissioner_reversed", "Commissioner reversed", input.actorUserId, now, reason ? { reason } : {});
    const p = parties(teamMap, trade);
    return {
      value: reversal,
      notices: [
        {
          userIds: [p.proposer.ownerId, p.receiver.ownerId],
          leagueId: league.id,
          type: "trade_updates",
          title: "Trade reversed",
          body: `The commissioner reversed the trade between ${p.proposer.name} and ${p.receiver.name}.${reason ? ` Reason: ${reason}` : ""}`,
          url: tradeUrl(league.id, trade.id),
        },
        ...others,
      ],
    };
  });
}

// ------------------------------------------------------------------------------- due processing

export type ProcessDueResult = { expired: number; executed: number; vetoed: number; invalidated: number; errors: string[] };

/**
 * Expires proposals older than 7 days and finishes review windows that have ended (executes the
 * trade, or invalidates it if it can no longer execute). Idempotent and cheap when nothing is due
 * (one indexed query), so it runs from the nightly job, the live cron and page loads.
 */
export async function processDueTrades(
  db: Db,
  now: Date = new Date(),
  deps: Pick<TradeDeps, "notify"> = {},
  opts: { leagueId?: string } = {},
): Promise<ProcessDueResult> {
  const result: ProcessDueResult = { expired: 0, executed: 0, vetoed: 0, invalidated: 0, errors: [] };
  const due = await db
    .select({ id: trades.id })
    .from(trades)
    .where(
      and(
        opts.leagueId ? eq(trades.leagueId, opts.leagueId) : undefined,
        or(
          and(eq(trades.status, "proposed"), lte(trades.expiresAt, now)),
          and(eq(trades.status, "pending_review"), lte(trades.reviewEndsAt, now)),
        ),
      ),
    )
    .orderBy(asc(trades.reviewEndsAt), asc(trades.createdAt));

  for (const { id } of due) {
    try {
      const kind = await commit<"expired" | "executed" | "vetoed" | "invalidated" | "skip">(db, deps, async (tx) => {
        const locked = await lockTrade(tx, id);
        const { trade, settings } = locked;
        const teamMap = await teamsOf(tx, locked.league.id);
        if (trade.status === "proposed") {
          const notice = await expireIfDue(tx, locked, teamMap, now);
          return { value: notice ? "expired" : "skip", notices: notice ? [notice] : [] };
        }
        if (trade.status !== "pending_review" || !trade.reviewEndsAt) return { value: "skip", notices: [] };
        const [{ n }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(tradeVotes)
          .where(and(eq(tradeVotes.tradeId, trade.id), eq(tradeVotes.vote, "veto")));
        const decision = reviewOutcome({
          mode: effectiveReviewMode(settings.tradeReview, settings.tradeReviewHours),
          vetoVotes: n,
          eligibleVoters: eligibleVoterCount(teamMap.size),
          vetoVotesNeeded: settings.vetoVotesNeeded,
          reviewEndsAt: trade.reviewEndsAt,
          now,
        });
        if (decision === "wait") return { value: "skip", notices: [] };
        if (decision === "veto") {
          await tx
            .update(trades)
            .set({ status: "vetoed", resolvedReason: `Vetoed by the league (${n} veto votes).`, updatedAt: now })
            .where(eq(trades.id, trade.id));
          await logTrade(tx, trade, teamMap, "trade_vetoed", "The league vetoed", null, now);
          return { value: "vetoed", notices: [] };
        }
        const out = await finishReview(tx, locked, teamMap, now, null, "Review window ended: approved automatically.", "invalidate");
        const executed = (await tx.select({ s: trades.status }).from(trades).where(eq(trades.id, trade.id)))[0]?.s === "executed";
        return { value: executed ? "executed" : "invalidated", notices: out.notices };
      });
      if (kind === "expired") result.expired++;
      else if (kind === "executed") result.executed++;
      else if (kind === "vetoed") result.vetoed++;
      else if (kind === "invalidated") result.invalidated++;
    } catch (err) {
      log.error("trades.due_trade_failed", { tradeId: id }, err);
      result.errors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

/** Cron entry point: every league. */
export async function runTradeJob(db: Db, now: Date = new Date(), deps: Pick<TradeDeps, "notify"> = {}) {
  return processDueTrades(db, now, deps);
}

// ------------------------------------------------------------------------------------ the block

export async function addToTradeBlock(
  db: Db,
  input: { leagueId: string; teamId: string; playerId: number; note?: string | null; actorUserId: string },
  deps: TradeDeps = {},
): Promise<void> {
  const now = deps.now ?? new Date();
  await commit(db, deps, async (tx) => {
    const league = await lockLeague(tx, input.leagueId);
    if (!isUuid(input.teamId) || !Number.isInteger(input.playerId)) throw new TradeError("team_not_found");
    const [team] = await tx.select().from(teams).where(and(eq(teams.id, input.teamId), eq(teams.leagueId, league.id)));
    if (!team) throw new TradeError("team_not_found");
    if (team.ownerId !== input.actorUserId) throw new TradeError("forbidden");
    const held = await holders(tx, league.id, [input.playerId]);
    if (held.get(input.playerId) !== team.id) throw new TradeError("not_on_roster");
    const note = input.note?.trim().slice(0, 200) || null;
    await tx
      .insert(tradeBlock)
      .values({ leagueId: league.id, teamId: team.id, playerId: input.playerId, note, createdAt: now })
      .onConflictDoUpdate({ target: [tradeBlock.teamId, tradeBlock.playerId], set: { note } });
    return { value: undefined, notices: [] };
  });
}

export async function removeFromTradeBlock(
  db: Db,
  input: { leagueId: string; teamId: string; playerId: number; actorUserId: string },
): Promise<void> {
  if (!isUuid(input.leagueId) || !isUuid(input.teamId)) throw new TradeError("team_not_found");
  const [team] = await db.select().from(teams).where(and(eq(teams.id, input.teamId), eq(teams.leagueId, input.leagueId)));
  if (!team) throw new TradeError("team_not_found");
  if (team.ownerId !== input.actorUserId) throw new TradeError("forbidden");
  await db.delete(tradeBlock).where(and(eq(tradeBlock.teamId, team.id), eq(tradeBlock.playerId, input.playerId)));
}

// ---------------------------------------------------------------------------------- read models

export type TradePlayer = {
  playerId: number;
  name: string;
  positions: string[];
  nbaAbbrev: string | null;
  injuryStatus: string | null;
  injuryDetail: string | null;
  /** Season FP per game including the win bonus. */
  seasonAvg: number | null;
  /** Previous season (league season - 1): FP per game and total, win bonus and league scoring included. */
  lastAvg: number | null;
  lastFp: number | null;
  /** Current season (league season): FP per game and total, win bonus and league scoring included. */
  curAvg: number | null;
  curFp: number | null;
  /** Projected FP per game (includes the expected win bonus). */
  projection: number | null;
  /** Expected win-bonus FP per game (0 when Out). */
  winBonusPerGame: number;
};

export async function loadTradePlayers(db: Db, playerIds: number[], league: League, now = new Date()): Promise<Map<number, TradePlayer>> {
  const scoring = parseStoredSettings(league.settings).scoring;
  const out = new Map<number, TradePlayer>();
  if (playerIds.length === 0) return out;
  const rows = await db
    .select({
      id: nbaPlayers.id,
      name: nbaPlayers.fullName,
      positions: nbaPlayers.positions,
      injuryStatus: nbaPlayers.injuryStatus,
      injuryDetail: nbaPlayers.injuryDetail,
      abbrev: nbaTeams.abbrev,
    })
    .from(nbaPlayers)
    .leftJoin(nbaTeams, eq(nbaTeams.id, nbaPlayers.teamId))
    .where(inArray(nbaPlayers.id, playerIds));
  const [proj, seasonRows] = await Promise.all([
    loadProjections(db, { playerIds, now, teamWin: scoring.teamWin, points: scoring }),
    loadSeasonFantasy(db, { seasons: [league.season, league.season - 1], playerIds, points: scoring, teamWin: scoring.teamWin }),
  ]);
  const bySeason = (season: number) => new Map(seasonRows.filter((r) => r.season === season).map((r) => [r.playerId, r]));
  const last = bySeason(league.season - 1);
  const cur = bySeason(league.season);
  for (const r of rows) {
    const p = proj.get(r.id);
    const l = last.get(r.id);
    const c = cur.get(r.id);
    out.set(r.id, {
      playerId: r.id,
      name: r.name,
      positions: r.positions,
      nbaAbbrev: r.abbrev ?? null,
      injuryStatus: r.injuryStatus,
      injuryDetail: r.injuryDetail,
      seasonAvg: p?.seasonAvg ?? null,
      lastAvg: l?.fpAvg ?? null,
      lastFp: l && l.fgp > 0 ? l.totalFp : null,
      curAvg: c?.fpAvg ?? null,
      curFp: c && c.fgp > 0 ? c.totalFp : null,
      projection: p?.projection ?? null,
      winBonusPerGame: p?.winBonusPerGame ?? 0,
    });
  }
  return out;
}

export type TeamRef = { id: string; name: string; abbrev: string; ownerId: string };

export type TradeSummary = {
  id: string;
  leagueId: string;
  kind: Trade["kind"];
  status: TradeStatus;
  proposer: TeamRef;
  receiver: TeamRef;
  message: string | null;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  reviewEndsAt: Date | null;
  executedAt: Date | null;
  respondedAt: Date | null;
  resolvedReason: string | null;
  counteredFrom: string | null;
  reversedByTradeId: string | null;
  /** Names the proposer gives / receives. */
  give: { playerId: number; name: string }[];
  get: { playerId: number; name: string }[];
  vetoVotes: number;
};

const teamRef = (t: Team): TeamRef => ({ id: t.id, name: t.name, abbrev: t.abbrev, ownerId: t.ownerId });

async function summarize(db: Db, rows: Trade[], teamMap: Map<string, Team>): Promise<TradeSummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const items = await db
    .select({ tradeId: tradeItems.tradeId, playerId: tradeItems.playerId, fromTeamId: tradeItems.fromTeamId, name: nbaPlayers.fullName })
    .from(tradeItems)
    .innerJoin(nbaPlayers, eq(nbaPlayers.id, tradeItems.playerId))
    .where(inArray(tradeItems.tradeId, ids))
    .orderBy(asc(nbaPlayers.fullName));
  const votes = await db
    .select({ tradeId: tradeVotes.tradeId, n: sql<number>`count(*)::int` })
    .from(tradeVotes)
    .where(and(inArray(tradeVotes.tradeId, ids), eq(tradeVotes.vote, "veto")))
    .groupBy(tradeVotes.tradeId);
  const voteMap = new Map(votes.map((v) => [v.tradeId, v.n]));
  return rows.map((t) => {
    const mine = items.filter((i) => i.tradeId === t.id);
    return {
      id: t.id,
      leagueId: t.leagueId,
      kind: t.kind,
      status: t.status,
      proposer: teamRef(teamMap.get(t.proposerTeamId)!),
      receiver: teamRef(teamMap.get(t.receiverTeamId)!),
      message: t.message,
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
      acceptedAt: t.acceptedAt,
      reviewEndsAt: t.reviewEndsAt,
      executedAt: t.executedAt,
      respondedAt: t.respondedAt,
      resolvedReason: t.resolvedReason,
      counteredFrom: t.counteredFrom,
      reversedByTradeId: t.reversedByTradeId,
      give: mine.filter((i) => i.fromTeamId === t.proposerTeamId).map((i) => ({ playerId: i.playerId, name: i.name })),
      get: mine.filter((i) => i.fromTeamId !== t.proposerTeamId).map((i) => ({ playerId: i.playerId, name: i.name })),
      vetoVotes: voteMap.get(t.id) ?? 0,
    };
  });
}

/** Every trade in the league (newest first), optionally only those involving a team. */
export async function listLeagueTrades(
  db: Db,
  leagueId: string,
  opts: { teamId?: string; statuses?: TradeStatus[]; limit?: number; excludeReversals?: boolean } = {},
): Promise<TradeSummary[]> {
  if (!isUuid(leagueId)) return [];
  const rows = await db
    .select()
    .from(trades)
    .where(
      and(
        eq(trades.leagueId, leagueId),
        opts.teamId ? or(eq(trades.proposerTeamId, opts.teamId), eq(trades.receiverTeamId, opts.teamId)) : undefined,
        opts.statuses ? inArray(trades.status, opts.statuses) : undefined,
        opts.excludeReversals ? ne(trades.kind, "reversal") : undefined,
      ),
    )
    .orderBy(desc(trades.createdAt), desc(trades.id))
    .limit(Math.min(500, opts.limit ?? 200));
  return summarize(db, rows, await teamsOf(db, leagueId));
}

export const listTradesForTeam = (db: Db, leagueId: string, teamId: string, opts: { statuses?: TradeStatus[]; limit?: number } = {}) =>
  listLeagueTrades(db, leagueId, { ...opts, teamId });

/** Offers waiting for this team's answer (the nav badge). */
export async function countReceivedOffers(db: Db, leagueId: string, teamId: string): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(trades)
    .where(and(eq(trades.leagueId, leagueId), eq(trades.receiverTeamId, teamId), eq(trades.status, "proposed")));
  return n;
}

export type TradeDetail = {
  trade: TradeSummary;
  players: (TradePlayer & { fromTeamId: string; toTeamId: string })[];
  myVote: "veto" | "approve" | null;
  eligibleVoters: number;
  vetoThreshold: number;
  reviewMode: LeagueSettings["tradeReview"];
  counteredBy: string | null;
  reversalOf: string | null;
  /** Commissioner can still reverse (executed, within 48 hours, not yet reversed). */
  reversible: boolean;
};

export async function getTrade(
  db: Db,
  leagueId: string,
  tradeId: string,
  viewerUserId: string | null,
  now: Date = new Date(),
): Promise<TradeDetail | null> {
  if (!isUuid(leagueId) || !isUuid(tradeId)) return null;
  const [row] = await db.select().from(trades).where(and(eq(trades.id, tradeId), eq(trades.leagueId, leagueId)));
  if (!row) return null;
  const [league] = await db.select().from(leagues).where(eq(leagues.id, leagueId));
  const settings = parseStoredSettings(league.settings);
  const teamMap = await teamsOf(db, leagueId);
  const [summary] = await summarize(db, [row], teamMap);
  const items = await db.select().from(tradeItems).where(eq(tradeItems.tradeId, tradeId));
  const stats = await loadTradePlayers(db, items.map((i) => i.playerId), league, now);
  const viewerTeam = viewerUserId ? [...teamMap.values()].find((t) => t.ownerId === viewerUserId) : undefined;
  const [vote] = viewerTeam
    ? await db
        .select({ vote: tradeVotes.vote })
        .from(tradeVotes)
        .where(and(eq(tradeVotes.tradeId, tradeId), eq(tradeVotes.teamId, viewerTeam.id)))
    : [];
  const [counteredBy] = await db.select({ id: trades.id }).from(trades).where(eq(trades.counteredFrom, tradeId));
  const [reversalOf] = await db.select({ id: trades.id }).from(trades).where(eq(trades.reversedByTradeId, tradeId));
  const eligible = eligibleVoterCount(teamMap.size);
  return {
    trade: summary,
    players: items
      .map((i) => ({ ...stats.get(i.playerId)!, fromTeamId: i.fromTeamId, toTeamId: i.toTeamId }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    myVote: vote?.vote ?? null,
    eligibleVoters: eligible,
    vetoThreshold: vetoThreshold(settings.vetoVotesNeeded, eligible),
    reviewMode: effectiveReviewMode(settings.tradeReview, settings.tradeReviewHours),
    counteredBy: counteredBy?.id ?? null,
    reversalOf: reversalOf?.id ?? null,
    reversible: row.kind === "trade" && row.status === "executed" && !row.reversedByTradeId && isReversible(row.executedAt, now),
  };
}

/** A team's current roster with the stats the trade builder shows. */
export async function listRosterForTrade(db: Db, league: League, teamId: string, now = new Date()): Promise<TradePlayer[]> {
  const ids = (
    await db
      .select({ playerId: rosterEntries.playerId })
      .from(rosterEntries)
      .where(and(eq(rosterEntries.teamId, teamId), isNull(rosterEntries.releasedAt)))
  ).map((r) => r.playerId);
  const stats = await loadTradePlayers(db, ids, league, now);
  return [...stats.values()].sort((a, b) => (b.seasonAvg ?? -1) - (a.seasonAvg ?? -1) || a.name.localeCompare(b.name));
}

export type BlockEntry = TradePlayer & { teamId: string; teamName: string; teamAbbrev: string; note: string | null; addedAt: Date };

/** The trade block: only players who are still on the team that listed them. */
export async function listTradeBlock(db: Db, league: League, opts: { teamId?: string } = {}, now = new Date()): Promise<BlockEntry[]> {
  const rows = await db
    .select({
      teamId: tradeBlock.teamId,
      playerId: tradeBlock.playerId,
      note: tradeBlock.note,
      addedAt: tradeBlock.createdAt,
      teamName: teams.name,
      teamAbbrev: teams.abbrev,
    })
    .from(tradeBlock)
    .innerJoin(teams, eq(teams.id, tradeBlock.teamId))
    .innerJoin(
      rosterEntries,
      and(eq(rosterEntries.teamId, tradeBlock.teamId), eq(rosterEntries.playerId, tradeBlock.playerId), isNull(rosterEntries.releasedAt)),
    )
    .where(and(eq(tradeBlock.leagueId, league.id), opts.teamId ? eq(tradeBlock.teamId, opts.teamId) : undefined))
    .orderBy(asc(teams.name), desc(tradeBlock.createdAt));
  const stats = await loadTradePlayers(db, rows.map((r) => r.playerId), league, now);
  return rows.flatMap((r) => {
    const s = stats.get(r.playerId);
    return s ? [{ ...s, teamId: r.teamId, teamName: r.teamName, teamAbbrev: r.teamAbbrev, note: r.note, addedAt: r.addedAt }] : [];
  });
}
