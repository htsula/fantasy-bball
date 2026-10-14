/**
 * Draft domain logic (DB). Every function takes `db` explicitly (tests pass PGlite). Authorization
 * is enforced here, never only in the UI: server actions are public endpoints.
 *
 * Concurrency: every state change locks the `drafts` row (SELECT ... FOR UPDATE), so two picks of
 * the same player (or two wave picks racing for the last slot) are serialized and exactly one
 * wins. Notifications are sent AFTER the transaction commits.
 */
import { randomInt } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  draftPicks,
  draftQueue,
  drafts,
  leagues,
  matchups,
  nbaPlayers,
  rosterEntries,
  teams,
  type Draft,
  type DraftPick,
  type League,
  type Team,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { maxRoster, snakeRounds as computeSnakeRounds } from "@/lib/fantasy/roster-size";
import { parseStoredSettings } from "@/lib/fantasy/settings";
import { notifier, type Notifier, type NotifyInput } from "@/lib/notifications/service";
import { z } from "zod";
import {
  deriveState,
  snakeRoundOf,
  snakeTeam,
  totalSnakePicks,
  waveQuota,
  waveTarget,
  type DerivedState,
  type DraftConfig,
} from "./engine";

export type DraftErrorCode =
  | "not_found"
  | "forbidden"
  | "wrong_status"
  | "already_started"
  | "not_enough_teams"
  | "schedule_required"
  | "invalid_config"
  | "draft_not_active"
  | "team_not_found"
  | "not_your_turn"
  | "no_wave_quota"
  | "player_taken"
  | "player_unavailable"
  | "nothing_to_undo"
  | "cannot_undo";

const MESSAGES: Record<DraftErrorCode, string> = {
  not_found: "Draft not found.",
  forbidden: "You don't have permission to do that.",
  wrong_status: "The league isn't in the setup phase.",
  already_started: "The draft has already started.",
  not_enough_teams: "At least 2 teams are needed to start the draft.",
  schedule_required:
    "Generate the schedule first (League > Schedule). It must include every team, and it resets whenever teams join or leave.",
  invalid_config: "The roster settings leave no room for a draft (roster pool is smaller than the number of teams).",
  draft_not_active: "The draft isn't active.",
  team_not_found: "Team not found in this league.",
  not_your_turn: "It's not that team's turn to pick.",
  no_wave_quota: "That team has already made all of its picks for this wave.",
  player_taken: "That player was just drafted or is already on a roster.",
  player_unavailable: "That player isn't available to draft (inactive or not on an NBA team).",
  nothing_to_undo: "There are no picks to undo.",
  cannot_undo: "This draft can't be undone because rosters have changed since it finished.",
};

export class DraftError extends Error {
  constructor(
    public code: DraftErrorCode,
    message?: string,
  ) {
    super(message ?? MESSAGES[code]);
  }
}

export type DraftDeps = {
  /** Called after the transaction commits. Defaults to the real in-app + Web Push notifier. */
  notify?: Notifier;
  /** Random int in [0, max). Defaults to crypto.randomInt. */
  random?: (max: number) => number;
  now?: Date;
};

const uuidSchema = z.string().uuid();
const draftUrl = (leagueId: string) => `/leagues/${leagueId}/draft`;

function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string; message?: string; cause?: { code?: string; constraint?: string; message?: string } };
  const code = e?.code ?? e?.cause?.code;
  if (code !== "23505") return false;
  if (!constraint) return true;
  return `${e?.constraint ?? e?.cause?.constraint ?? ""} ${e?.message ?? ""} ${e?.cause?.message ?? ""}`.includes(constraint);
}

async function sendAll(db: Db, notify: Notifier | undefined, inputs: NotifyInput[]) {
  const send = notify ?? notifier;
  for (const input of inputs) {
    if (input.userIds.length === 0) continue;
    try {
      await send(db, input);
    } catch (err) {
      console.error("[draft] notification failed", err);
    }
  }
}

function configOf(draft: Draft, waveSize: number): DraftConfig {
  return {
    teamCount: draft.order.length,
    snakeRounds: draft.snakeRounds,
    totalRounds: draft.totalRounds,
    waveSize,
  };
}

function shuffle<T>(items: T[], random: (max: number) => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function teamPickCounts(tx: Db, draftId: string, order: string[]): Promise<number[]> {
  const rows = await tx
    .select({ teamId: draftPicks.teamId, n: sql<number>`count(*)::int` })
    .from(draftPicks)
    .where(eq(draftPicks.draftId, draftId))
    .groupBy(draftPicks.teamId);
  const byTeam = new Map(rows.map((r) => [r.teamId, r.n]));
  return order.map((t) => byTeam.get(t) ?? 0);
}

async function lockDraft(tx: Db, draftId: string): Promise<Draft> {
  if (!uuidSchema.safeParse(draftId).success) throw new DraftError("not_found");
  const [draft] = await tx.select().from(drafts).where(eq(drafts.id, draftId)).for("update");
  if (!draft) throw new DraftError("not_found");
  return draft;
}

async function leagueOf(tx: Db, leagueId: string): Promise<League> {
  const [league] = await tx.select().from(leagues).where(eq(leagues.id, leagueId));
  if (!league) throw new DraftError("not_found");
  return league;
}

/** Fields to write to the drafts row so it matches the derived state. */
function stateColumns(draft: Draft, next: DerivedState, now: Date) {
  const wave = next.status === "waves" ? next.wave : null;
  const waveChanged = wave !== null && (draft.status !== "waves" || draft.currentWave !== wave);
  return {
    status: next.status,
    currentPick: next.currentPick,
    currentWave: wave,
    waveOpenedAt: wave === null ? null : waveChanged ? now : (draft.waveOpenedAt ?? now),
    completedAt: next.status === "complete" ? (draft.completedAt ?? now) : null,
  } as const;
}

// ----------------------------------------------------------------------------------- queries

export async function getDraftByLeague(db: Db, leagueId: string): Promise<Draft | null> {
  if (!uuidSchema.safeParse(leagueId).success) return null;
  const [draft] = await db.select().from(drafts).where(eq(drafts.leagueId, leagueId));
  return draft ?? null;
}

/** True when the player can be drafted/queued in this league right now. */
export async function isDraftable(db: Db, leagueId: string, playerId: number): Promise<boolean> {
  const [p] = await db
    .select({ id: nbaPlayers.id, active: nbaPlayers.active, teamId: nbaPlayers.teamId })
    .from(nbaPlayers)
    .where(eq(nbaPlayers.id, playerId));
  if (!p || !p.active || p.teamId === null) return false;
  const [taken] = await db
    .select({ id: rosterEntries.id })
    .from(rosterEntries)
    .where(and(eq(rosterEntries.leagueId, leagueId), eq(rosterEntries.playerId, playerId), isNull(rosterEntries.releasedAt)));
  return !taken;
}

// ------------------------------------------------------------------------------- start draft

/** Commissioner only. Locks settings (league status leaves "setup"), randomizes the order. */
export async function startDraft(db: Db, leagueId: string, userId: string, deps: DraftDeps = {}): Promise<Draft> {
  const now = deps.now ?? new Date();
  const random = deps.random ?? randomInt;
  if (!uuidSchema.safeParse(leagueId).success) throw new DraftError("not_found");

  const result = await db.transaction(async (tx) => {
    const [league] = await tx.select().from(leagues).where(eq(leagues.id, leagueId)).for("update");
    if (!league) throw new DraftError("not_found");
    if (league.commissionerId !== userId) throw new DraftError("forbidden");
    const [existing] = await tx.select({ id: drafts.id }).from(drafts).where(eq(drafts.leagueId, leagueId));
    if (existing) throw new DraftError("already_started");
    if (league.status !== "setup") throw new DraftError("wrong_status");

    const teamList = await tx.select().from(teams).where(eq(teams.leagueId, leagueId)).orderBy(asc(teams.createdAt), asc(teams.id));
    if (teamList.length < 2) throw new DraftError("not_enough_teams");

    // The schedule is cleared whenever teams join/leave, so it must exist and include every team.
    const sched = await tx
      .select({ home: matchups.homeTeamId, away: matchups.awayTeamId })
      .from(matchups)
      .where(eq(matchups.leagueId, leagueId));
    const scheduled = new Set(sched.flatMap((m) => [m.home, m.away]).filter((x): x is string => x !== null));
    if (!teamList.every((t) => scheduled.has(t.id))) throw new DraftError("schedule_required");

    const settings = parseStoredSettings(league.settings);
    const n = teamList.length;
    const max = maxRoster(n, settings);
    if (max < 1) throw new DraftError("invalid_config");
    const snake = computeSnakeRounds(n, settings);
    const order = shuffle(
      teamList.map((t) => t.id),
      random,
    );
    const cfg: DraftConfig = { teamCount: n, snakeRounds: snake, totalRounds: max, waveSize: settings.waveSize };
    const initial = deriveState(cfg, order.map(() => 0));

    let draft: Draft;
    try {
      [draft] = await tx
        .insert(drafts)
        .values({
          leagueId,
          ...stateColumns({ status: "pending", currentWave: null, waveOpenedAt: null, completedAt: null } as Draft, initial, now),
          order,
          maxRoster: max,
          snakeRounds: snake,
          totalRounds: max,
          startedAt: now,
          startedBy: userId,
        })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) throw new DraftError("already_started");
      throw err;
    }
    await tx.update(leagues).set({ status: "drafting" }).where(eq(leagues.id, leagueId));
    return { draft, league, teamList, settings, initial, cfg };
  });

  const { draft, league, teamList, settings, initial, cfg } = result;
  const owner = new Map(teamList.map((t) => [t.id, t.ownerId]));
  const url = draftUrl(leagueId);
  const notices: NotifyInput[] = [
    {
      userIds: teamList.map((t) => t.ownerId),
      leagueId,
      type: "draft_events",
      title: "Draft started",
      body: `The ${league.name} draft has started. ${draft.maxRoster} players per team.`,
      url,
    },
    ...phaseNotices({ league, draft, cfg, owner, before: null, after: initial, teamList, waveSize: settings.waveSize }),
  ];
  await sendAll(db, deps.notify, notices);
  return draft;
}

// --------------------------------------------------------------------------- notifications

type NoticeCtx = {
  league: League;
  draft: Draft;
  cfg: DraftConfig;
  owner: Map<string, string>;
  teamList: Team[];
  waveSize: number;
  before: { status: Draft["status"]; wave: number | null } | null;
  after: DerivedState;
};

/** Notifications implied by moving into `after`: on the clock, heads-up, wave open, complete. */
function phaseNotices(ctx: NoticeCtx): NotifyInput[] {
  const { league, draft, cfg, owner, after, before, teamList } = ctx;
  const url = draftUrl(league.id);
  const all = teamList.map((t) => t.ownerId);
  const out: NotifyInput[] = [];
  if (after.status === "snake") {
    const pick = after.currentPick;
    const team = snakeTeam(draft.order, pick);
    out.push({
      userIds: [owner.get(team)!],
      leagueId: league.id,
      type: "draft_on_clock",
      title: "You're on the clock",
      body: `Pick #${pick} (round ${snakeRoundOf(pick, cfg.teamCount)}) in ${league.name}.`,
      url,
    });
    const ahead = pick + 2;
    if (ahead <= totalSnakePicks(cfg)) {
      const headsUp = snakeTeam(draft.order, ahead);
      const soon = new Set([team, snakeTeam(draft.order, pick + 1)]);
      if (!soon.has(headsUp)) {
        out.push({
          userIds: [owner.get(headsUp)!],
          leagueId: league.id,
          type: "draft_heads_up",
          title: "You're 2 picks away",
          body: `Your pick (#${ahead}) in ${league.name} is coming up.`,
          url,
        });
      }
    }
  } else if (after.status === "waves") {
    if (!before || before.status !== "waves" || before.wave !== after.wave) {
      const quota = waveQuota(cfg, after.wave);
      out.push({
        userIds: all,
        leagueId: league.id,
        type: "draft_wave_open",
        title: `Wave ${after.wave} open: pick ${quota}`,
        body: `Everyone picks at the same time in ${league.name}. First come, first served.`,
        url,
      });
    }
  } else if (after.status === "complete" && before?.status !== "complete") {
    out.push({
      userIds: all,
      leagueId: league.id,
      type: "draft_events",
      title: "Draft complete",
      body: `The ${league.name} draft is finished. The season is on!`,
      url,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------- make pick

export type PickResult = { pick: DraftPick; state: DerivedState };

export async function makePick(
  db: Db,
  draftId: string,
  teamId: string,
  playerId: number,
  actorUserId: string,
  opts: { asCommissioner?: boolean } & DraftDeps = {},
): Promise<PickResult> {
  const now = opts.now ?? new Date();
  if (!uuidSchema.safeParse(teamId).success) throw new DraftError("team_not_found");
  if (!Number.isInteger(playerId)) throw new DraftError("player_unavailable");

  const done = await db.transaction(async (tx) => {
    const draft = await lockDraft(tx, draftId);
    if (draft.status !== "snake" && draft.status !== "waves") throw new DraftError("draft_not_active");
    const league = await leagueOf(tx, draft.leagueId);
    const teamList = await tx.select().from(teams).where(eq(teams.leagueId, league.id));
    const team = teamList.find((t) => t.id === teamId);
    if (!team) throw new DraftError("team_not_found");

    if (opts.asCommissioner) {
      if (league.commissionerId !== actorUserId) throw new DraftError("forbidden");
    } else if (team.ownerId !== actorUserId) {
      throw new DraftError("forbidden");
    }

    const settings = parseStoredSettings(league.settings);
    const cfg = configOf(draft, settings.waveSize);
    const counts = await teamPickCounts(tx, draft.id, draft.order);
    const teamIdx = draft.order.indexOf(teamId);
    if (teamIdx < 0) throw new DraftError("team_not_found");

    if (draft.status === "snake") {
      if (snakeTeam(draft.order, draft.currentPick) !== teamId) throw new DraftError("not_your_turn");
    } else if (counts[teamIdx] >= waveTarget(cfg, draft.currentWave ?? 1)) {
      throw new DraftError("no_wave_quota");
    }

    const [player] = await tx
      .select({ id: nbaPlayers.id, active: nbaPlayers.active, teamId: nbaPlayers.teamId })
      .from(nbaPlayers)
      .where(eq(nbaPlayers.id, playerId));
    if (!player || !player.active || player.teamId === null) throw new DraftError("player_unavailable");
    const [onRoster] = await tx
      .select({ id: rosterEntries.id })
      .from(rosterEntries)
      .where(and(eq(rosterEntries.leagueId, league.id), eq(rosterEntries.playerId, playerId), isNull(rosterEntries.releasedAt)));
    const [picked] = await tx
      .select({ id: draftPicks.id })
      .from(draftPicks)
      .where(and(eq(draftPicks.draftId, draft.id), eq(draftPicks.playerId, playerId)));
    if (onRoster || picked) throw new DraftError("player_taken");

    const overall = counts.reduce((a, b) => a + b, 0) + 1;
    let pick: DraftPick;
    try {
      [pick] = await tx
        .insert(draftPicks)
        .values({
          draftId: draft.id,
          overallPick: overall,
          round: counts[teamIdx] + 1,
          phase: draft.status === "snake" ? "snake" : "wave",
          wave: draft.status === "waves" ? draft.currentWave : null,
          teamId,
          playerId,
          madeBy: actorUserId,
          madeByCommissioner: Boolean(opts.asCommissioner),
          createdAt: now,
        })
        .returning();
      await tx.insert(rosterEntries).values({
        leagueId: league.id,
        teamId,
        playerId,
        acquiredVia: "draft",
        acquiredAt: now,
      });
    } catch (err) {
      // The pre-checks above run under the draft lock, so this is only a backstop.
      if (isUniqueViolation(err)) throw new DraftError("player_taken");
      throw err;
    }

    // The player leaves every team's queue in this league.
    await tx.delete(draftQueue).where(and(eq(draftQueue.playerId, playerId), inArray(draftQueue.teamId, teamList.map((t) => t.id))));

    counts[teamIdx] += 1;
    const next = deriveState(cfg, counts);
    await tx.update(drafts).set(stateColumns(draft, next, now)).where(eq(drafts.id, draft.id));
    if (next.status === "complete") await tx.update(leagues).set({ status: "in_season" }).where(eq(leagues.id, league.id));

    return { pick, next, notices: phaseNotices({
      league,
      draft,
      cfg,
      owner: new Map(teamList.map((t) => [t.id, t.ownerId])),
      teamList,
      waveSize: settings.waveSize,
      before: { status: draft.status, wave: draft.currentWave },
      after: next,
    }) };
  });

  await sendAll(db, opts.notify, done.notices);
  return { pick: done.pick, state: done.next };
}

// ------------------------------------------------------------------------------------- undo

/** Commissioner only. Removes the most recent pick overall and restores state from the picks. */
export async function undoLastPick(db: Db, draftId: string, actorUserId: string, deps: DraftDeps = {}): Promise<DraftPick> {
  const now = deps.now ?? new Date();
  const done = await db.transaction(async (tx) => {
    const draft = await lockDraft(tx, draftId);
    const league = await leagueOf(tx, draft.leagueId);
    if (league.commissionerId !== actorUserId) throw new DraftError("forbidden");
    if (draft.status === "pending") throw new DraftError("draft_not_active");

    const [last] = await tx
      .select()
      .from(draftPicks)
      .where(eq(draftPicks.draftId, draft.id))
      .orderBy(desc(draftPicks.overallPick))
      .limit(1);
    if (!last) throw new DraftError("nothing_to_undo");

    const entries = await tx
      .select()
      .from(rosterEntries)
      .where(eq(rosterEntries.leagueId, league.id));
    if (draft.status === "complete") {
      // Once the season is underway, rosters may have moved; don't silently rewrite them.
      const moved = entries.some((e) => e.acquiredVia !== "draft" || e.releasedAt !== null);
      if (moved || league.status !== "in_season") throw new DraftError("cannot_undo");
    }

    await tx
      .delete(rosterEntries)
      .where(
        and(
          eq(rosterEntries.leagueId, league.id),
          eq(rosterEntries.teamId, last.teamId),
          eq(rosterEntries.playerId, last.playerId),
          eq(rosterEntries.acquiredVia, "draft"),
          isNull(rosterEntries.releasedAt),
        ),
      );
    await tx.delete(draftPicks).where(eq(draftPicks.id, last.id));

    const settings = parseStoredSettings(league.settings);
    const cfg = configOf(draft, settings.waveSize);
    const counts = await teamPickCounts(tx, draft.id, draft.order);
    const next = deriveState(cfg, counts);
    await tx.update(drafts).set(stateColumns(draft, next, now)).where(eq(drafts.id, draft.id));
    if (draft.status === "complete") await tx.update(leagues).set({ status: "drafting" }).where(eq(leagues.id, league.id));

    const teamList = await tx.select().from(teams).where(eq(teams.leagueId, league.id));
    const owner = new Map(teamList.map((t) => [t.id, t.ownerId]));
    const [player] = await tx.select({ name: nbaPlayers.fullName }).from(nbaPlayers).where(eq(nbaPlayers.id, last.playerId));
    const notices: NotifyInput[] = [
      {
        userIds: [owner.get(last.teamId)!],
        leagueId: league.id,
        type: "draft_events",
        title: "Pick undone",
        body: `The commissioner undid your pick of ${player?.name ?? "a player"}.`,
        url: draftUrl(league.id),
      },
    ];
    if (next.status === "snake") {
      notices.push(
        ...phaseNotices({
          league,
          draft,
          cfg,
          owner,
          teamList,
          waveSize: settings.waveSize,
          before: { status: draft.status, wave: draft.currentWave },
          after: next,
        }).filter((n) => n.type === "draft_on_clock"),
      );
    } else if (next.status === "waves" && (draft.status !== "waves" || draft.currentWave !== next.wave)) {
      notices.push(
        ...phaseNotices({ league, draft, cfg, owner, teamList, waveSize: settings.waveSize, before: null, after: next }),
      );
    }
    return { last, notices };
  });

  await sendAll(db, deps.notify, done.notices);
  return done.last;
}

// ------------------------------------------------------------------------------------ queue

async function ownedTeam(db: Db, teamId: string, userId: string): Promise<Team & { leagueStatus: League["status"] }> {
  if (!uuidSchema.safeParse(teamId).success) throw new DraftError("team_not_found");
  const [row] = await db
    .select({ team: teams, leagueStatus: leagues.status })
    .from(teams)
    .innerJoin(leagues, eq(leagues.id, teams.leagueId))
    .where(eq(teams.id, teamId));
  if (!row) throw new DraftError("team_not_found");
  if (row.team.ownerId !== userId) throw new DraftError("forbidden");
  return { ...row.team, leagueStatus: row.leagueStatus };
}

function assertQueueOpen(status: League["status"]) {
  if (status !== "setup" && status !== "drafting") throw new DraftError("draft_not_active", "The draft is over; queues are closed.");
}

export async function addToQueue(db: Db, teamId: string, playerId: number, userId: string): Promise<void> {
  const team = await ownedTeam(db, teamId, userId);
  assertQueueOpen(team.leagueStatus);
  if (!(await isDraftable(db, team.leagueId, playerId))) throw new DraftError("player_unavailable");
  await db.transaction(async (tx) => {
    const [max] = await tx
      .select({ m: sql<number>`coalesce(max(${draftQueue.rank}), 0)::int` })
      .from(draftQueue)
      .where(eq(draftQueue.teamId, teamId));
    await tx
      .insert(draftQueue)
      .values({ teamId, playerId, rank: max.m + 1 })
      .onConflictDoNothing({ target: [draftQueue.teamId, draftQueue.playerId] });
  });
}

export async function removeFromQueue(db: Db, teamId: string, playerId: number, userId: string): Promise<void> {
  await ownedTeam(db, teamId, userId);
  await db.delete(draftQueue).where(and(eq(draftQueue.teamId, teamId), eq(draftQueue.playerId, playerId)));
}

/** Players not mentioned keep their relative order after the listed ones. */
export async function reorderQueue(db: Db, teamId: string, orderedPlayerIds: number[], userId: string): Promise<void> {
  await ownedTeam(db, teamId, userId);
  await db.transaction(async (tx) => {
    const current = await tx.select().from(draftQueue).where(eq(draftQueue.teamId, teamId)).orderBy(asc(draftQueue.rank), asc(draftQueue.createdAt));
    const have = new Set(current.map((q) => q.playerId));
    const listed = [...new Set(orderedPlayerIds)].filter((id) => have.has(id));
    const rest = current.map((q) => q.playerId).filter((id) => !listed.includes(id));
    const finalOrder = [...listed, ...rest];
    for (let i = 0; i < finalOrder.length; i++) {
      await tx
        .update(draftQueue)
        .set({ rank: i + 1 })
        .where(and(eq(draftQueue.teamId, teamId), eq(draftQueue.playerId, finalOrder[i])));
    }
  });
}
