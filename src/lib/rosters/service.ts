/**
 * Roster moves after the draft: free-agent add/drop, commissioner moves, auto-drop of players the
 * NBA cut, and restoring a wrongly auto-dropped player.
 *
 * Concurrency: every mutation locks the league row (SELECT ... FOR UPDATE) inside one
 * transaction. That serializes all roster moves in a league, so two teams racing for the same
 * player produce exactly one winner (`player_taken`), and the daily-add and roster-size checks
 * can't be beaten by parallel requests. The partial unique index on roster_entries is the
 * backstop. Notifications go out AFTER commit.
 */
import { randomUUID } from "node:crypto";
import { log } from "@/lib/log";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  drafts,
  leagues,
  nbaPlayers,
  rosterEntries,
  teams,
  transactions,
  users,
  type League,
  type Team,
  type Transaction,
  type TransactionType,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { maxRoster } from "@/lib/fantasy/roster-size";
import { parseStoredSettings } from "@/lib/fantasy/settings";
import { addDays, etDateString, etStartOfDay } from "@/lib/nba/dates";
import { logActivity } from "@/lib/activity/service";
import { invalidateOpenTradesForPlayers } from "@/lib/trades/invalidate";
import { notifier, type Notifier, type NotifyInput } from "@/lib/notifications/service";
import { z } from "zod";

export type RosterErrorCode =
  | "not_found"
  | "forbidden"
  | "wrong_status"
  | "team_not_found"
  | "player_unavailable"
  | "player_taken"
  | "not_on_roster"
  | "daily_limit_reached"
  | "roster_full"
  | "not_restorable";

const MESSAGES: Record<RosterErrorCode, string> = {
  not_found: "League not found.",
  forbidden: "You don't have permission to do that.",
  wrong_status: "Free agency is only open during the season (after the draft is complete).",
  team_not_found: "Team not found in this league.",
  player_unavailable: "That player isn't available (inactive or not on an NBA team).",
  player_taken: "Someone else just added that player, or he's already on a team in this league.",
  not_on_roster: "That player isn't on this roster.",
  daily_limit_reached: "Your team has used all of its adds for today. The limit resets at midnight ET.",
  roster_full: "Your roster is full. Pick a player to drop with this add.",
  not_restorable: "That move can't be restored (already restored, or the player is on a team now).",
};

export class RosterError extends Error {
  constructor(
    public code: RosterErrorCode,
    message?: string,
  ) {
    super(message ?? MESSAGES[code]);
  }
}

export type RosterDeps = {
  /** Called after the transaction commits. Defaults to the real in-app + Web Push notifier. */
  notify?: Notifier;
  /** Injectable clock. */
  now?: Date;
};

const uuidSchema = z.string().uuid();
const OPEN_STATUSES: League["status"][] = ["in_season", "playoffs"];

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return (e?.code ?? e?.cause?.code) === "23505";
}

async function sendAll(db: Db, notify: Notifier | undefined, inputs: NotifyInput[]) {
  const send = notify ?? notifier;
  for (const input of inputs) {
    if (input.userIds.length === 0) continue;
    try {
      await send(db, input);
    } catch (err) {
      log.error("rosters.notification_failed", {}, err);
    }
  }
}

const teamUrl = (leagueId: string, teamId: string) => `/leagues/${leagueId}/teams/${teamId}`;

// ------------------------------------------------------------------------------------ helpers

/** Max roster for a league: the value locked at draft start, else the house formula. */
export async function leagueMaxRoster(tx: Db, league: League): Promise<number> {
  const [draft] = await tx
    .select({ maxRoster: drafts.maxRoster, status: drafts.status })
    .from(drafts)
    .where(eq(drafts.leagueId, league.id));
  if (draft && draft.status !== "pending") return draft.maxRoster;
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(teams).where(eq(teams.leagueId, league.id));
  return maxRoster(n, parseStoredSettings(league.settings));
}

async function rosterCount(tx: Db, teamId: string): Promise<number> {
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(rosterEntries)
    .where(and(eq(rosterEntries.teamId, teamId), isNull(rosterEntries.releasedAt)));
  return n;
}

export type AddsToday = { used: number; limit: number; remaining: number; resetsAt: Date; etDate: string };

/** Adds a team has made on the ET day containing `now`, against the league's daily limit. */
export async function getAddsToday(db: Db, teamId: string, limit: number, now = new Date()): Promise<AddsToday> {
  const etDate = etDateString(now);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(transactions)
    .where(and(eq(transactions.teamId, teamId), eq(transactions.etDate, etDate), eq(transactions.type, "add")));
  return { used: n, limit, remaining: Math.max(0, limit - n), resetsAt: etStartOfDay(addDays(etDate, 1)), etDate };
}

type Ctx = { league: League; team: Team };

async function lockLeagueAndTeam(tx: Db, leagueId: string, teamId: string): Promise<Ctx> {
  if (!uuidSchema.safeParse(leagueId).success) throw new RosterError("not_found");
  if (!uuidSchema.safeParse(teamId).success) throw new RosterError("team_not_found");
  const [league] = await tx.select().from(leagues).where(eq(leagues.id, leagueId)).for("update");
  if (!league) throw new RosterError("not_found");
  const [team] = await tx.select().from(teams).where(and(eq(teams.id, teamId), eq(teams.leagueId, leagueId)));
  if (!team) throw new RosterError("team_not_found");
  return { league, team };
}

function assertOpen(league: League) {
  if (!OPEN_STATUSES.includes(league.status)) throw new RosterError("wrong_status");
}

async function playerName(tx: Db, playerId: number): Promise<string> {
  const [p] = await tx.select({ name: nbaPlayers.fullName }).from(nbaPlayers).where(eq(nbaPlayers.id, playerId));
  return p?.name ?? "a player";
}

async function activeEntry(tx: Db, leagueId: string, playerId: number) {
  const [e] = await tx
    .select()
    .from(rosterEntries)
    .where(and(eq(rosterEntries.leagueId, leagueId), eq(rosterEntries.playerId, playerId), isNull(rosterEntries.releasedAt)));
  return e;
}

async function releaseOwn(tx: Db, ctx: Ctx, playerId: number, via: "drop" | "commissioner", now: Date) {
  const entry = await activeEntry(tx, ctx.league.id, playerId);
  if (!entry || entry.teamId !== ctx.team.id) throw new RosterError("not_on_roster");
  await tx.update(rosterEntries).set({ releasedAt: now, releasedVia: via }).where(eq(rosterEntries.id, entry.id));
}

function txnRow(
  ctx: Ctx,
  type: TransactionType,
  playerId: number,
  actorUserId: string | null,
  now: Date,
  groupId: string | null,
  note?: string,
): typeof transactions.$inferInsert {
  return {
    leagueId: ctx.league.id,
    teamId: ctx.team.id,
    type,
    playerId,
    groupId,
    actorUserId,
    createdAt: now,
    etDate: etDateString(now),
    note: note ?? null,
  };
}

async function leagueMemberNotice(tx: Db, ctx: Ctx, actorUserId: string | null, title: string, body: string): Promise<NotifyInput> {
  const members = await tx.select({ ownerId: teams.ownerId }).from(teams).where(eq(teams.leagueId, ctx.league.id));
  return {
    userIds: members.map((m) => m.ownerId).filter((u) => u !== actorUserId),
    leagueId: ctx.league.id,
    type: "league_transactions",
    title,
    body,
    url: `/leagues/${ctx.league.id}/transactions`,
  };
}

/** Tells a team owner the commissioner changed his team (nothing when the commissioner is the owner). */
function commissionerOwnerNotice(ctx: Ctx, actorUserId: string, body: string): NotifyInput | null {
  if (ctx.team.ownerId === actorUserId) return null;
  return {
    userIds: [ctx.team.ownerId],
    leagueId: ctx.league.id,
    type: "commissioner_actions",
    title: "Commissioner changed your roster",
    body,
    url: teamUrl(ctx.league.id, ctx.team.id),
  };
}

function assertActor(ctx: Ctx, mode: "owner" | "commissioner", actorUserId: string) {
  if (mode === "owner" ? ctx.team.ownerId !== actorUserId : ctx.league.commissionerId !== actorUserId) {
    throw new RosterError("forbidden");
  }
}

// ------------------------------------------------------------------------------------- add/drop

export type AddInput = {
  leagueId: string;
  teamId: string;
  playerId: number;
  /** Dropped in the same action (required when the roster is full). */
  dropPlayerId?: number | null;
  actorUserId: string;
};

type Mode = "owner" | "commissioner";

async function addPlayer(db: Db, input: AddInput, mode: Mode, deps: RosterDeps) {
  const now = deps.now ?? new Date();
  if (!Number.isInteger(input.playerId)) throw new RosterError("player_unavailable");
  const dropId = input.dropPlayerId ?? null;
  if (dropId !== null && (!Number.isInteger(dropId) || dropId === input.playerId)) throw new RosterError("not_on_roster");

  const notice = await db.transaction(async (tx) => {
    const ctx = await lockLeagueAndTeam(tx, input.leagueId, input.teamId);
    assertActor(ctx, mode, input.actorUserId);
    assertOpen(ctx.league);

    const [player] = await tx
      .select({ id: nbaPlayers.id, name: nbaPlayers.fullName, active: nbaPlayers.active, teamId: nbaPlayers.teamId })
      .from(nbaPlayers)
      .where(eq(nbaPlayers.id, input.playerId));
    if (!player || !player.active || player.teamId === null) throw new RosterError("player_unavailable");
    if (await activeEntry(tx, ctx.league.id, input.playerId)) throw new RosterError("player_taken");

    if (mode === "owner") {
      const settings = parseStoredSettings(ctx.league.settings);
      const adds = await getAddsToday(tx, ctx.team.id, settings.addsPerDay, now);
      if (adds.remaining <= 0) throw new RosterError("daily_limit_reached");
    }

    const max = await leagueMaxRoster(tx, ctx.league);
    const count = await rosterCount(tx, ctx.team.id);
    if (count - (dropId !== null ? 1 : 0) + 1 > max) throw new RosterError("roster_full");

    const groupId = dropId !== null ? randomUUID() : null;
    let droppedName: string | null = null;
    if (dropId !== null) {
      await releaseOwn(tx, ctx, dropId, mode === "owner" ? "drop" : "commissioner", now);
      droppedName = await playerName(tx, dropId);
      await tx
        .insert(transactions)
        .values(txnRow(ctx, mode === "owner" ? "drop" : "commissioner_drop", dropId, input.actorUserId, now, groupId));
    }
    try {
      await tx.insert(rosterEntries).values({
        leagueId: ctx.league.id,
        teamId: ctx.team.id,
        playerId: input.playerId,
        acquiredVia: mode === "owner" ? "add" : "commissioner",
        acquiredAt: now,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new RosterError("player_taken");
      throw err;
    }
    await tx
      .insert(transactions)
      .values(txnRow(ctx, mode === "owner" ? "add" : "commissioner_add", input.playerId, input.actorUserId, now, groupId));

    const tradeNotices =
      dropId !== null ? await invalidateOpenTradesForPlayers(tx, ctx.league.id, [dropId], "player_dropped", now) : [];
    const dropText = droppedName ? ` and dropped ${droppedName}` : "";
    await logActivity(tx, {
      leagueId: ctx.league.id,
      actorUserId: input.actorUserId,
      type: mode === "owner" ? "add" : "commissioner_add",
      summary:
        mode === "owner"
          ? `${ctx.team.name} added ${player.name}${dropText}.`
          : `Commissioner added ${player.name} to ${ctx.team.name}${dropText}.`,
      data: { teamId: ctx.team.id, playerId: input.playerId, dropPlayerId: dropId },
      now,
    });
    const ownerNotice = mode === "commissioner" ? commissionerOwnerNotice(ctx, input.actorUserId, `The commissioner added ${player.name} to ${ctx.team.name}${dropText}.`) : null;
    const moveNotice = await leagueMemberNotice(
      tx,
      ctx,
      input.actorUserId,
      mode === "owner" ? "Roster move" : "Commissioner roster move",
      mode === "owner"
        ? `${ctx.team.name} added ${player.name}${dropText}.`
        : `The commissioner added ${player.name} to ${ctx.team.name}${dropText}.`,
    );
    return [moveNotice, ...(ownerNotice ? [ownerNotice] : []), ...tradeNotices];
  });
  await sendAll(db, deps.notify, notice);
}

/** A team owner adds a free agent (optionally dropping a player in the same action). */
export async function addFreeAgent(db: Db, input: AddInput, deps: RosterDeps = {}): Promise<void> {
  await addPlayer(db, input, "owner", deps);
}

/** Commissioner adds a free agent to any team: bypasses the daily limit, not the roster max. */
export async function commissionerAdd(db: Db, input: AddInput, deps: RosterDeps = {}): Promise<void> {
  await addPlayer(db, input, "commissioner", deps);
}

export type DropInput = { leagueId: string; teamId: string; playerId: number; actorUserId: string };

async function dropPlayerImpl(db: Db, input: DropInput, mode: Mode, deps: RosterDeps) {
  const now = deps.now ?? new Date();
  if (!Number.isInteger(input.playerId)) throw new RosterError("not_on_roster");
  const notice = await db.transaction(async (tx) => {
    const ctx = await lockLeagueAndTeam(tx, input.leagueId, input.teamId);
    assertActor(ctx, mode, input.actorUserId);
    assertOpen(ctx.league);
    await releaseOwn(tx, ctx, input.playerId, mode === "owner" ? "drop" : "commissioner", now);
    await tx
      .insert(transactions)
      .values(txnRow(ctx, mode === "owner" ? "drop" : "commissioner_drop", input.playerId, input.actorUserId, now, null));
    const name = await playerName(tx, input.playerId);
    await logActivity(tx, {
      leagueId: ctx.league.id,
      actorUserId: input.actorUserId,
      type: mode === "owner" ? "drop" : "commissioner_drop",
      summary: mode === "owner" ? `${ctx.team.name} dropped ${name}.` : `Commissioner dropped ${name} from ${ctx.team.name}.`,
      data: { teamId: ctx.team.id, playerId: input.playerId },
      now,
    });
    const ownerNotice =
      mode === "commissioner" ? commissionerOwnerNotice(ctx, input.actorUserId, `The commissioner dropped ${name} from ${ctx.team.name}.`) : null;
    const tradeNotices = await invalidateOpenTradesForPlayers(tx, ctx.league.id, [input.playerId], "player_dropped", now);
    const moveNotice = await leagueMemberNotice(
      tx,
      ctx,
      input.actorUserId,
      mode === "owner" ? "Roster move" : "Commissioner roster move",
      mode === "owner" ? `${ctx.team.name} dropped ${name}.` : `The commissioner dropped ${name} from ${ctx.team.name}.`,
    );
    return [moveNotice, ...(ownerNotice ? [ownerNotice] : []), ...tradeNotices];
  });
  await sendAll(db, deps.notify, notice);
}

/** A team owner drops one of his players (unlimited). */
export async function dropPlayer(db: Db, input: DropInput, deps: RosterDeps = {}): Promise<void> {
  await dropPlayerImpl(db, input, "owner", deps);
}

export async function commissionerDrop(db: Db, input: DropInput, deps: RosterDeps = {}): Promise<void> {
  await dropPlayerImpl(db, input, "commissioner", deps);
}

// --------------------------------------------------------------------------------- auto-drop

export type RemoveCutResult = { dropped: number; skipped: boolean };

/**
 * Releases every rostered player who is inactive or on no NBA team and logs an auto_drop. Only
 * acts when `allRostersLoaded` is true (the daily sync saw all 30 rosters), so an ESPN glitch
 * can't mass-drop players. Owners are notified (roster_auto_drop).
 */
export async function removeCutPlayers(
  db: Db,
  opts: { allRostersLoaded: boolean; now?: Date },
  deps: Pick<RosterDeps, "notify"> = {},
): Promise<RemoveCutResult> {
  if (!opts.allRostersLoaded) return { dropped: 0, skipped: true };
  const now = opts.now ?? new Date();

  const done = await db.transaction(async (tx) => {
    const cut = await tx
      .select({
        entryId: rosterEntries.id,
        leagueId: rosterEntries.leagueId,
        teamId: rosterEntries.teamId,
        playerId: rosterEntries.playerId,
        playerName: nbaPlayers.fullName,
        teamName: teams.name,
        ownerId: teams.ownerId,
      })
      .from(rosterEntries)
      .innerJoin(nbaPlayers, eq(nbaPlayers.id, rosterEntries.playerId))
      .innerJoin(teams, eq(teams.id, rosterEntries.teamId))
      .where(and(isNull(rosterEntries.releasedAt), sql`(${nbaPlayers.active} = false or ${nbaPlayers.teamId} is null)`))
      .orderBy(asc(rosterEntries.leagueId), asc(rosterEntries.teamId), asc(nbaPlayers.fullName));
    if (cut.length === 0) return { cut, notices: [] as NotifyInput[] };

    await tx
      .update(rosterEntries)
      .set({ releasedAt: now, releasedVia: "auto_drop" })
      .where(inArray(rosterEntries.id, cut.map((c) => c.entryId)));
    await tx.insert(transactions).values(
      cut.map((c) => ({
        leagueId: c.leagueId,
        teamId: c.teamId,
        type: "auto_drop" as const,
        playerId: c.playerId,
        groupId: null,
        actorUserId: null,
        createdAt: now,
        etDate: etDateString(now),
        note: "No longer on an NBA roster",
      })),
    );

    const byTeam = new Map<string, typeof cut>();
    for (const c of cut) byTeam.set(c.teamId, [...(byTeam.get(c.teamId) ?? []), c]);
    for (const list of byTeam.values()) {
      await logActivity(tx, {
        leagueId: list[0].leagueId,
        actorUserId: null,
        type: "auto_drop",
        summary: `${list.map((c) => c.playerName).join(", ")} ${list.length === 1 ? "was" : "were"} cut by the NBA and removed from ${list[0].teamName}.`,
        data: { teamId: list[0].teamId, playerIds: list.map((c) => c.playerId) },
        now,
      });
    }
    const notices: NotifyInput[] = [...byTeam.values()].map((list) => {
      const names = list.map((c) => c.playerName);
      const one = names.length === 1;
      return {
        userIds: [list[0].ownerId],
        leagueId: list[0].leagueId,
        type: "roster_auto_drop",
        title: one ? `${names[0]} was cut` : `${names.length} players were cut`,
        body: `${names.join(", ")} ${one ? "is" : "are"} no longer on an NBA roster and ${one ? "was" : "were"} removed from ${list[0].teamName}.`,
        url: teamUrl(list[0].leagueId, list[0].teamId),
      };
    });
    // A cut player can not change hands: open trades that include him are void.
    const byLeague = new Map<string, number[]>();
    for (const c of cut) byLeague.set(c.leagueId, [...(byLeague.get(c.leagueId) ?? []), c.playerId]);
    for (const [leagueId, ids] of byLeague) {
      notices.push(...(await invalidateOpenTradesForPlayers(tx, leagueId, ids, "player_cut", now)));
    }
    return { cut, notices };
  });
  await sendAll(db, deps.notify, done.notices);
  return { dropped: done.cut.length, skipped: false };
}

/**
 * Commissioner undoes an auto-drop: reopens the original roster entry (so the team is credited as
 * if he was never dropped) when he is still unrostered and the team has room. Logged as a
 * commissioner_add that points back at the auto-drop through group_id.
 */
export async function commissionerRestore(
  db: Db,
  input: { transactionId: string; actorUserId: string },
  deps: RosterDeps = {},
): Promise<void> {
  const now = deps.now ?? new Date();
  if (!uuidSchema.safeParse(input.transactionId).success) throw new RosterError("not_restorable");
  const notice = await db.transaction(async (tx) => {
    const [txn] = await tx.select().from(transactions).where(eq(transactions.id, input.transactionId));
    if (!txn || txn.type !== "auto_drop") throw new RosterError("not_restorable");
    const ctx = await lockLeagueAndTeam(tx, txn.leagueId, txn.teamId);
    if (ctx.league.commissionerId !== input.actorUserId) throw new RosterError("forbidden");

    if (await activeEntry(tx, ctx.league.id, txn.playerId)) throw new RosterError("not_restorable");
    const [already] = await tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.groupId, txn.id), eq(transactions.type, "commissioner_add")));
    if (already) throw new RosterError("not_restorable");

    // The entry this auto-drop released: the team's latest auto_drop release of the player.
    const [entry] = await tx
      .select()
      .from(rosterEntries)
      .where(
        and(
          eq(rosterEntries.teamId, txn.teamId),
          eq(rosterEntries.playerId, txn.playerId),
          eq(rosterEntries.releasedVia, "auto_drop"),
        ),
      )
      .orderBy(desc(rosterEntries.releasedAt))
      .limit(1);
    if (!entry) throw new RosterError("not_restorable");

    const max = await leagueMaxRoster(tx, ctx.league);
    if ((await rosterCount(tx, ctx.team.id)) + 1 > max) throw new RosterError("roster_full");

    try {
      await tx.update(rosterEntries).set({ releasedAt: null, releasedVia: null }).where(eq(rosterEntries.id, entry.id));
    } catch (err) {
      if (isUniqueViolation(err)) throw new RosterError("player_taken");
      throw err;
    }
    await tx
      .insert(transactions)
      .values(txnRow(ctx, "commissioner_add", txn.playerId, input.actorUserId, now, txn.id, "Restored after auto-drop"));
    const name = await playerName(tx, txn.playerId);
    await logActivity(tx, {
      leagueId: ctx.league.id,
      actorUserId: input.actorUserId,
      type: "commissioner_restore",
      summary: `Commissioner restored ${name} to ${ctx.team.name} after an auto-drop.`,
      data: { teamId: ctx.team.id, playerId: txn.playerId },
      now,
    });
    return {
      userIds: [ctx.team.ownerId],
      leagueId: ctx.league.id,
      type: "roster_auto_drop",
      title: `${name} restored`,
      body: `The commissioner put ${name} back on ${ctx.team.name}.`,
      url: teamUrl(ctx.league.id, ctx.team.id),
    } satisfies NotifyInput;
  });
  await sendAll(db, deps.notify, [notice]);
}

// ------------------------------------------------------------------------------------- feed

export type TransactionRow = Pick<Transaction, "id" | "type" | "teamId" | "playerId" | "groupId" | "createdAt" | "note"> & {
  teamName: string;
  teamAbbrev: string;
  playerName: string;
  actorUsername: string | null;
  /** auto_drop rows only: the commissioner can undo it right now. */
  restorable: boolean;
};

export const TRANSACTION_TYPES: TransactionType[] = ["add", "drop", "trade", "auto_drop", "commissioner_add", "commissioner_drop"];

export async function listTransactions(
  db: Db,
  leagueId: string,
  opts: { teamId?: string; type?: TransactionType; limit?: number; offset?: number } = {},
): Promise<{ rows: TransactionRow[]; total: number }> {
  const where = and(
    eq(transactions.leagueId, leagueId),
    opts.teamId && uuidSchema.safeParse(opts.teamId).success ? eq(transactions.teamId, opts.teamId) : undefined,
    opts.type && TRANSACTION_TYPES.includes(opts.type) ? eq(transactions.type, opts.type) : undefined,
  );
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  // Pagination counts feed entries, not rows: all player rows of one trade (same group_id) are ONE entry, so a
  // trade never straddles a page boundary and `total` is the number of entries.
  const unit = sql<string>`coalesce(case when ${transactions.type} = 'trade' then ${transactions.groupId} end, ${transactions.id})`;
  const [units, [{ total }]] = await Promise.all([
    db
      .select({ unit, at: sql<Date>`max(${transactions.createdAt})` })
      .from(transactions)
      .where(where)
      .groupBy(unit)
      .orderBy(sql`max(${transactions.createdAt}) desc`, desc(unit))
      .limit(limit)
      .offset(Math.max(0, opts.offset ?? 0)),
    db.select({ total: sql<number>`count(distinct ${unit})::int` }).from(transactions).where(where),
  ]);
  if (units.length === 0) return { rows: [], total };
  const unitIds = units.map((u) => u.unit);
  const rows = await db
    .select({
      id: transactions.id,
      type: transactions.type,
      teamId: transactions.teamId,
      playerId: transactions.playerId,
      groupId: transactions.groupId,
      createdAt: transactions.createdAt,
      note: transactions.note,
      teamName: teams.name,
      teamAbbrev: teams.abbrev,
      playerName: nbaPlayers.fullName,
      actorUsername: users.username,
      restorable: sql<boolean>`(
        ${transactions.type} = 'auto_drop'
        and not exists (select 1 from roster_entries re where re.league_id = ${transactions.leagueId} and re.player_id = ${transactions.playerId} and re.released_at is null)
        and not exists (select 1 from transactions t2 where t2.group_id = ${transactions.id} and t2.type = 'commissioner_add')
      )`,
    })
    .from(transactions)
    .innerJoin(teams, eq(teams.id, transactions.teamId))
    .innerJoin(nbaPlayers, eq(nbaPlayers.id, transactions.playerId))
    .leftJoin(users, eq(users.id, transactions.actorUserId))
    .where(and(where, sql`${unit} in (${sql.join(unitIds.map((u) => sql`${u}::uuid`), sql`, `)})`))
    .orderBy(desc(transactions.createdAt), desc(transactions.id));
  return { rows, total };
}
