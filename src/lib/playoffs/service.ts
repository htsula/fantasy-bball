/**
 * Playoffs (milestone 8): seeding, advancement, completion and commissioner tools.
 *
 * Design:
 *  - The bracket lives in playoff_slots (see schema). A BYE is a round-1 slot with one team: it has
 *    no matchup rows and its winner is set at seeding. Non-playoff teams play no games in playoff
 *    periods (there is no consolation bracket).
 *  - Each real slot gets one matchup row per period of its round (1 or 2 periods), all linked by
 *    matchups.playoff_slot_id, with the better seed as "home". finalizePeriod() finalizes each
 *    matchup as usual; settleSlots() then decides the slot on the COMBINED points of all its
 *    matchups once every one is final. A tie goes to the higher seed.
 *  - Everything here is idempotent: matchups are only created for slots that have none, so a
 *    re-finalization of a recent period (a stat correction) can't create a second set.
 *  - A correction that flips a winner AFTER the next round has matchups (or after the league is
 *    complete) is NOT applied: it logs a warning and leaves the bracket for the commissioner to fix
 *    with overridePlayoffWinner(). Flips before that point are applied.
 *  - After the nightly job finalizes a playoff period, advancePlayoffs() creates the next round's
 *    matchups; after the last slot is decided it writes season_results, sets the league to
 *    "complete" and notifies everyone.
 */
import { and, asc, eq, inArray, isNotNull, lte, gte, sql } from "drizzle-orm";
import { log } from "@/lib/log";
import {
  leagues,
  matchupPeriods,
  matchups,
  nbaGames,
  playoffSlots,
  seasonResults,
  teams,
  type League,
  type MatchupPeriod,
  type PlayoffResult,
  type PlayoffSlot,
  type Team,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { logActivity } from "@/lib/activity/service";
import { buildBracket, decideSlotWinner, resultForExit, roundLabel } from "@/lib/fantasy/bracket";
import { parseStoredSettings } from "@/lib/fantasy/settings";
import type { StandingRow } from "@/lib/fantasy/standings";
import { etDateString } from "@/lib/nba/dates";
import { notify as realNotify, type Notifier } from "@/lib/notifications/service";
import { getMatchupTotals, getStandings, periodWindow, refreshStandings } from "@/lib/matchups/service";

export type PlayoffErrorCode =
  | "not_found"
  | "forbidden"
  | "wrong_status"
  | "round_started"
  | "invalid_input"
  | "downstream_started"
  | "cannot_seed";

const MESSAGES: Record<PlayoffErrorCode, string> = {
  not_found: "Playoff game not found.",
  forbidden: "Only the commissioner can do that.",
  wrong_status: "The playoffs aren't in progress.",
  round_started: "Round 1 has already started, so the playoffs can't be re-seeded.",
  invalid_input: "Choose one of the two teams in that game.",
  downstream_started: "The next round already has results. Change that game first.",
  cannot_seed: "The playoffs can't be seeded (not enough teams or no playoff periods).",
};

export class PlayoffError extends Error {
  constructor(
    public code: PlayoffErrorCode,
    message?: string,
  ) {
    super(message ?? MESSAGES[code]);
  }
}

export type PlayoffDeps = { notify?: Notifier };
export type PlayoffActor = { id: string; isSiteAdmin?: boolean };

const uuidOk = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// ------------------------------------------------------------------------------------ loaders

async function loadLeague(db: Db, leagueId: string): Promise<League> {
  if (!uuidOk(leagueId)) throw new PlayoffError("not_found", "League not found.");
  const [league] = await db.select().from(leagues).where(eq(leagues.id, leagueId));
  if (!league) throw new PlayoffError("not_found", "League not found.");
  return league;
}

async function loadSlots(db: Db, leagueId: string): Promise<PlayoffSlot[]> {
  return db
    .select()
    .from(playoffSlots)
    .where(eq(playoffSlots.leagueId, leagueId))
    .orderBy(asc(playoffSlots.round), asc(playoffSlots.slot));
}

async function loadPlayoffPeriods(db: Db, leagueId: string): Promise<MatchupPeriod[]> {
  return db
    .select()
    .from(matchupPeriods)
    .where(and(eq(matchupPeriods.leagueId, leagueId), eq(matchupPeriods.isPlayoff, true)))
    .orderBy(asc(matchupPeriods.number));
}

const totalRounds = (slots: PlayoffSlot[]) => slots.reduce((m, s) => Math.max(m, s.round), 0);

function seedMap(slots: PlayoffSlot[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of slots) {
    if (s.round !== 1) continue;
    if (s.teamAId && s.seedA !== null) out.set(s.teamAId, s.seedA);
    if (s.teamBId && s.seedB !== null) out.set(s.teamBId, s.seedB);
  }
  return out;
}

/** The slot a winner moves into, with the side (A/B) it feeds. */
function downstreamOf(slots: PlayoffSlot[], slot: PlayoffSlot): { next: PlayoffSlot; side: "A" | "B" } | null {
  const next = slots.find((s) => s.sourceASlotId === slot.id || s.sourceBSlotId === slot.id);
  if (!next) return null;
  return { next, side: next.sourceASlotId === slot.id ? "A" : "B" };
}

async function slotMatchups(db: Db, slotId: string) {
  return db.select().from(matchups).where(eq(matchups.playoffSlotId, slotId));
}

// ------------------------------------------------------------------------------------ seeding

/** Inserts the bracket for the top `playoffTeams` of the current standings. Returns the seeded teams. */
async function insertBracket(tx: Db, league: League, now: Date): Promise<{ teamId: string; seed: number }[]> {
  const settings = parseStoredSettings(league.settings);
  const standings = await refreshStandings(tx, league.id, now);
  const n = settings.playoffTeams;
  if (standings.length < n || n < 2) throw new PlayoffError("cannot_seed");
  const playoffPeriods = await loadPlayoffPeriods(tx, league.id);
  const { rounds, slots: specs } = buildBracket(n);
  if (playoffPeriods.length < rounds) throw new PlayoffError("cannot_seed");

  const seeded = standings.slice(0, n).map((r, i) => ({ teamId: r.teamId, seed: i + 1 }));
  const teamBySeed = new Map(seeded.map((s) => [s.seed, s.teamId]));
  const idOf = new Map<string, string>(); // "round:slot" -> slot id

  for (const spec of specs) {
    const a = spec.seedA === null ? null : teamBySeed.get(spec.seedA)!;
    const b = spec.seedB === null ? null : teamBySeed.get(spec.seedB)!;
    const bye = spec.round === 1 && (a === null || b === null);
    const [row] = await tx
      .insert(playoffSlots)
      .values({
        leagueId: league.id,
        round: spec.round,
        slot: spec.slot,
        teamAId: a,
        teamBId: b,
        seedA: spec.seedA,
        seedB: spec.seedB,
        sourceASlotId: spec.sourceA === null ? null : idOf.get(`${spec.round - 1}:${spec.sourceA}`)!,
        sourceBSlotId: spec.sourceB === null ? null : idOf.get(`${spec.round - 1}:${spec.sourceB}`)!,
        winnerTeamId: bye ? (a ?? b) : null,
        decidedAt: bye ? now : null,
      })
      .returning({ id: playoffSlots.id });
    idOf.set(`${spec.round}:${spec.slot}`, row.id);
  }
  await fillSlots(tx, league.id);
  await createMissingMatchups(tx, league.id);
  return seeded;
}

/** Moves decided winners into the empty side of the slot they feed. Returns how many sides were set. */
async function fillSlots(tx: Db, leagueId: string): Promise<number> {
  const slots = await loadSlots(tx, leagueId);
  const byId = new Map(slots.map((s) => [s.id, s]));
  const seeds = seedMap(slots);
  let filled = 0;
  for (const s of slots) {
    if (s.round === 1) continue;
    for (const side of ["A", "B"] as const) {
      const src = byId.get((side === "A" ? s.sourceASlotId : s.sourceBSlotId) ?? "");
      const current = side === "A" ? s.teamAId : s.teamBId;
      if (!src?.winnerTeamId || current !== null) continue;
      const seed = seeds.get(src.winnerTeamId) ?? null;
      await tx
        .update(playoffSlots)
        .set(side === "A" ? { teamAId: src.winnerTeamId, seedA: seed } : { teamBId: src.winnerTeamId, seedB: seed })
        .where(eq(playoffSlots.id, s.id));
      filled++;
    }
  }
  return filled;
}

/** One matchup per period of the round for every ready slot that has none yet. Idempotent. */
async function createMissingMatchups(tx: Db, leagueId: string): Promise<number> {
  const slots = await loadSlots(tx, leagueId);
  const periods = await loadPlayoffPeriods(tx, leagueId);
  const existing = await tx
    .select({ slotId: matchups.playoffSlotId })
    .from(matchups)
    .where(and(eq(matchups.leagueId, leagueId), isNotNull(matchups.playoffSlotId)));
  const has = new Set(existing.map((e) => e.slotId));
  let created = 0;
  for (const s of slots) {
    if (!s.teamAId || !s.teamBId || s.winnerTeamId || has.has(s.id)) continue;
    const legs = periods.filter((p) => p.playoffRound === s.round);
    if (legs.length === 0) continue;
    const aHosts = (s.seedA ?? Number.MAX_SAFE_INTEGER) <= (s.seedB ?? Number.MAX_SAFE_INTEGER);
    const [home, away] = aHosts ? [s.teamAId, s.teamBId] : [s.teamBId, s.teamAId];
    await tx
      .insert(matchups)
      .values(legs.map((p) => ({ leagueId, periodId: p.id, homeTeamId: home, awayTeamId: away, playoffSlotId: s.id })));
    created += legs.length;
  }
  return created;
}

async function regularSeasonDone(db: Db, leagueId: string): Promise<boolean> {
  const rows = await db
    .select({ status: matchups.status })
    .from(matchups)
    .innerJoin(matchupPeriods, eq(matchupPeriods.id, matchups.periodId))
    .where(and(eq(matchups.leagueId, leagueId), eq(matchupPeriods.isPlayoff, false)));
  return rows.length > 0 && rows.every((r) => r.status === "final");
}

async function sendAll(
  db: Db,
  notify: Notifier | undefined,
  inputs: Parameters<Notifier>[1][],
) {
  const send = notify ?? realNotify;
  for (const input of inputs) {
    if (input.userIds.length === 0) continue;
    try {
      await send(db, input);
    } catch (err) {
      log.error("playoffs.notification_failed", {}, err);
    }
  }
}

/** Seeds the bracket when every regular-season matchup is final. Returns true when it did. */
async function seedIfReady(db: Db, league: League, now: Date, deps: PlayoffDeps): Promise<boolean> {
  if (league.status !== "in_season") return false;
  if ((await loadSlots(db, league.id)).length > 0) return false;
  if (!(await regularSeasonDone(db, league.id))) return false;
  if ((await loadPlayoffPeriods(db, league.id)).length === 0) return false;

  let seeded: { teamId: string; seed: number }[];
  try {
    seeded = await db.transaction(async (tx) => {
      const claimed = await tx
        .update(leagues)
        .set({ status: "playoffs" })
        .where(and(eq(leagues.id, league.id), eq(leagues.status, "in_season")))
        .returning({ id: leagues.id });
      if (claimed.length === 0) return []; // another run got there first
      const seededTeams = await insertBracket(tx, league, now);
      await logActivity(tx, {
        leagueId: league.id,
        actorUserId: null,
        type: "playoffs_seeded",
        summary: `The playoffs were seeded (${seededTeams.length} teams).`,
        data: { url: `/leagues/${league.id}/playoffs` },
        now,
      });
      return seededTeams;
    });
  } catch (err) {
    if (err instanceof PlayoffError && err.code === "cannot_seed") {
      log.warn("playoffs.cannot_seed", { leagueId: league.id, reason: err.message });
      return false;
    }
    throw err;
  }
  if (seeded.length === 0) return false;

  const teamRows = await db.select().from(teams).where(eq(teams.leagueId, league.id));
  const owner = new Map(teamRows.map((t) => [t.id, t.ownerId]));
  await sendAll(
    db,
    deps.notify,
    seeded.map((s) => ({
      userIds: [owner.get(s.teamId)!],
      leagueId: league.id,
      type: "league_events" as const,
      title: "You made the playoffs",
      body: `You're the #${s.seed} seed in ${league.name}.`,
      url: `/leagues/${league.id}/playoffs`,
    })),
  );
  return true;
}

// ---------------------------------------------------------------------------------- settling

type SettleResult = { decided: number; warnings: string[] };

/** Decides every slot whose matchups are all final (see the module comment for flips). */
async function settleSlots(db: Db, leagueId: string, leagueStatus: League["status"]): Promise<SettleResult> {
  const slots = await loadSlots(db, leagueId);
  const rounds = totalRounds(slots);
  const seeds = seedMap(slots);
  const out: SettleResult = { decided: 0, warnings: [] };

  for (const s of slots) {
    if (!s.teamAId || !s.teamBId || s.overridden) continue;
    const legs = await slotMatchups(db, s.id);
    if (legs.length === 0 || !legs.every((m) => m.status === "final")) continue;

    const points = new Map<string, number>([
      [s.teamAId, 0],
      [s.teamBId, 0],
    ]);
    for (const m of legs) {
      if (m.homeTeamId) points.set(m.homeTeamId, (points.get(m.homeTeamId) ?? 0) + (m.homePoints ?? 0));
      if (m.awayTeamId) points.set(m.awayTeamId, (points.get(m.awayTeamId) ?? 0) + (m.awayPoints ?? 0));
    }
    const { winnerTeamId } = decideSlotWinner(
      { teamId: s.teamAId, seed: seeds.get(s.teamAId) ?? Number.MAX_SAFE_INTEGER, points: points.get(s.teamAId) ?? 0 },
      { teamId: s.teamBId, seed: seeds.get(s.teamBId) ?? Number.MAX_SAFE_INTEGER, points: points.get(s.teamBId) ?? 0 },
    );
    if (s.winnerTeamId === winnerTeamId) continue;

    if (s.winnerTeamId === null) {
      await db.update(playoffSlots).set({ winnerTeamId, decidedAt: new Date() }).where(eq(playoffSlots.id, s.id));
      out.decided++;
      continue;
    }

    // A correction flipped an already-decided slot.
    const down = downstreamOf(slots, s);
    const downStarted = down ? down.next.winnerTeamId !== null || (await slotMatchups(db, down.next.id)).length > 0 : false;
    const finalDone = s.round === rounds && leagueStatus === "complete";
    if (downStarted || finalDone) {
      const msg = `Playoff round ${s.round} slot ${s.slot + 1} of league ${leagueId}: a stat correction changes the winner, but the ${
        finalDone ? "season is complete" : "next round has already started"
      }. Left unchanged: use the commissioner override if it should change.`;
      log.warn("playoffs.warning", { message: msg });
      out.warnings.push(msg);
      continue;
    }
    await db.update(playoffSlots).set({ winnerTeamId, decidedAt: new Date() }).where(eq(playoffSlots.id, s.id));
    if (down) await setSide(db, down.next, down.side, winnerTeamId, seeds.get(winnerTeamId) ?? null);
    out.decided++;
  }
  return out;
}

async function setSide(db: Db, slot: PlayoffSlot, side: "A" | "B", teamId: string | null, seed: number | null) {
  await db
    .update(playoffSlots)
    .set(side === "A" ? { teamAId: teamId, seedA: seed } : { teamBId: teamId, seedB: seed })
    .where(eq(playoffSlots.id, slot.id));
}

// -------------------------------------------------------------------------------- completion

/** Final rank / result for every team once the last slot is decided. */
function buildResults(
  teamRows: Team[],
  slots: PlayoffSlot[],
  standings: StandingRow[],
): (typeof seasonResults.$inferInsert)[] {
  const rounds = totalRounds(slots);
  const result = new Map<string, { result: PlayoffResult; depth: number }>();
  for (const t of teamRows) result.set(t.id, { result: "missed", depth: 0 });
  for (const s of slots) {
    if (!s.teamAId || !s.teamBId || !s.winnerTeamId) continue;
    const loser = s.winnerTeamId === s.teamAId ? s.teamBId : s.teamAId;
    if (s.round === rounds) {
      result.set(s.winnerTeamId, { result: "champion", depth: rounds + 2 });
      result.set(loser, { result: "runner_up", depth: rounds + 1 });
    } else {
      result.set(loser, { result: resultForExit(s.round, rounds), depth: s.round });
    }
  }
  const rank = new Map(standings.map((r) => [r.teamId, r]));
  const ordered = [...teamRows].sort((a, b) => {
    const ra = result.get(a.id)!;
    const rb = result.get(b.id)!;
    return rb.depth - ra.depth || (rank.get(a.id)?.rank ?? 999) - (rank.get(b.id)?.rank ?? 999) || a.name.localeCompare(b.name);
  });
  return ordered.map((t, i) => {
    const st = rank.get(t.id);
    return {
      leagueId: t.leagueId,
      teamId: t.id,
      ownerUserId: t.ownerId,
      teamName: t.name,
      finalRank: i + 1,
      wins: st?.wins ?? 0,
      losses: st?.losses ?? 0,
      ties: st?.ties ?? 0,
      pointsFor: st?.pointsFor ?? 0,
      pointsAgainst: st?.pointsAgainst ?? 0,
      playoffResult: result.get(t.id)!.result,
    };
  });
}

async function writeResults(tx: Db, leagueId: string) {
  const slots = await loadSlots(tx, leagueId);
  const teamRows = await tx.select().from(teams).where(eq(teams.leagueId, leagueId));
  const standings = await refreshStandings(tx, leagueId);
  const rows = buildResults(teamRows, slots, standings);
  await tx.delete(seasonResults).where(eq(seasonResults.leagueId, leagueId));
  if (rows.length) await tx.insert(seasonResults).values(rows);
  return rows;
}

/** When the last slot has a winner: write season_results, set the league complete, notify everyone. */
async function completeIfDone(db: Db, league: League, deps: PlayoffDeps): Promise<boolean> {
  const slots = await loadSlots(db, league.id);
  if (slots.length === 0) return false;
  const final = slots.find((s) => s.round === totalRounds(slots));
  if (!final?.winnerTeamId) return false;

  const completed = await db.transaction(async (tx) => {
    const claimed = await tx
      .update(leagues)
      .set({ status: "complete" })
      .where(and(eq(leagues.id, league.id), eq(leagues.status, "playoffs")))
      .returning({ id: leagues.id });
    if (claimed.length === 0) return false;
    await writeResults(tx, league.id);
    const [champTeam] = await tx.select({ name: teams.name }).from(teams).where(eq(teams.id, final.winnerTeamId!));
    await logActivity(tx, {
      leagueId: league.id,
      actorUserId: null,
      type: "season_complete",
      summary: `The season is complete. ${champTeam?.name ?? "The winner"} are the champions.`,
      data: { url: `/leagues/${league.id}/history` },
    });
    return true;
  });
  if (!completed) return false;

  const teamRows = await db.select().from(teams).where(eq(teams.leagueId, league.id));
  const champ = teamRows.find((t) => t.id === final.winnerTeamId);
  await sendAll(db, deps.notify, [
    {
      userIds: teamRows.map((t) => t.ownerId),
      leagueId: league.id,
      type: "league_events",
      title: `${league.name} champions`,
      body: `${champ?.name ?? "The winner"} are champions!`,
      url: `/leagues/${league.id}/playoffs`,
    },
  ]);
  return true;
}

// ------------------------------------------------------------------------------------ advance

export type AdvanceResult = {
  seeded: boolean;
  matchupsCreated: number;
  slotsDecided: number;
  completed: boolean;
  warnings: string[];
  /** Something changed that may need another finalize pass (new matchups for an already-ended period). */
  progressed: boolean;
};

/**
 * One idempotent step of the playoff machine for a league: seed (if the regular season is done),
 * decide finished slots, move winners forward, create the next round's matchups, and complete the
 * league after the final. Safe to call any number of times.
 */
export async function advancePlayoffs(
  db: Db,
  leagueId: string,
  now = new Date(),
  deps: PlayoffDeps = {},
): Promise<AdvanceResult> {
  const out: AdvanceResult = { seeded: false, matchupsCreated: 0, slotsDecided: 0, completed: false, warnings: [], progressed: false };
  let league = await loadLeague(db, leagueId);
  if (league.status === "in_season") {
    out.seeded = await seedIfReady(db, league, now, deps);
    if (out.seeded) {
      league = await loadLeague(db, leagueId);
      const made = await db
        .select({ id: matchups.id })
        .from(matchups)
        .where(and(eq(matchups.leagueId, leagueId), isNotNull(matchups.playoffSlotId)));
      out.matchupsCreated += made.length;
    }
  }
  if (league.status !== "playoffs") {
    out.progressed = out.seeded;
    return out;
  }

  for (let i = 0; i < 8; i++) {
    const settled = await settleSlots(db, leagueId, league.status);
    out.warnings.push(...settled.warnings);
    const filled = await fillSlots(db, leagueId);
    const created = await createMissingMatchups(db, leagueId);
    out.slotsDecided += settled.decided;
    out.matchupsCreated += created;
    if (settled.decided === 0 && filled === 0 && created === 0) break;
  }
  out.completed = await completeIfDone(db, league, deps);
  out.progressed = out.seeded || out.matchupsCreated > 0 || out.slotsDecided > 0 || out.completed;
  return out;
}

// ------------------------------------------------------------------------ commissioner tools

function assertCommissioner(league: League, actor: PlayoffActor) {
  if (league.commissionerId !== actor.id) throw new PlayoffError("forbidden");
}

/** True while round 1 hasn't started: nothing final and no NBA game of the round has tipped off. */
export async function canReseed(db: Db, leagueId: string, now = new Date()): Promise<boolean> {
  const league = await loadLeague(db, leagueId);
  if (league.status !== "playoffs") return false;
  const slots = await loadSlots(db, leagueId);
  const round1 = slots.filter((s) => s.round === 1);
  if (round1.length === 0) return false;
  const ms = await db
    .select({ status: matchups.status, periodId: matchups.periodId })
    .from(matchups)
    .where(inArray(matchups.playoffSlotId, round1.map((s) => s.id)));
  if (ms.some((m) => m.status !== "scheduled")) return false;
  const periods = (await loadPlayoffPeriods(db, leagueId)).filter((p) => p.playoffRound === 1);
  if (periods.length === 0) return true;
  const start = periodWindow(periods[0]).start;
  if (now < start) return true;
  const [started] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nbaGames)
    .where(and(gte(nbaGames.startTime, start), lte(nbaGames.startTime, now)));
  return started.n === 0;
}

/**
 * Commissioner only. Recomputes the seeds from the current standings and rebuilds the bracket (and
 * its round-1 matchups). Only before round 1 starts: use it after fixing data that changed the
 * regular-season standings.
 */
export async function reseedPlayoffs(db: Db, actor: PlayoffActor, leagueId: string, now = new Date()) {
  const league = await loadLeague(db, leagueId);
  assertCommissioner(league, actor);
  if (league.status !== "playoffs") throw new PlayoffError("wrong_status");
  if (!(await canReseed(db, leagueId, now))) throw new PlayoffError("round_started");
  return db.transaction(async (tx) => {
    await tx.delete(playoffSlots).where(eq(playoffSlots.leagueId, leagueId)); // matchups cascade
    const seeded = await insertBracket(tx, league, now);
    await logActivity(tx, {
      leagueId,
      actorUserId: actor.id,
      type: "playoffs_reseeded",
      summary: "Commissioner re-seeded the playoffs from the current standings.",
      data: { url: `/leagues/${leagueId}/playoffs` },
      now,
    });
    return seeded;
  });
}

/**
 * Commissioner only. Sets the winner of a playoff game by hand (data problems). The decision is
 * logged on the slot (who, when, note) and the nightly job never recomputes it. Allowed while the
 * playoffs run or after the league completes (season results are then rewritten, without notifying
 * again). Refused when the next round's game already has results: change that one first.
 */
export async function overridePlayoffWinner(
  db: Db,
  actor: PlayoffActor,
  slotId: string,
  winnerTeamId: string,
  note?: string,
  now = new Date(),
  deps: PlayoffDeps = {},
): Promise<PlayoffSlot> {
  if (!uuidOk(slotId)) throw new PlayoffError("not_found");
  const [slot] = await db.select().from(playoffSlots).where(eq(playoffSlots.id, slotId));
  if (!slot) throw new PlayoffError("not_found");
  const league = await loadLeague(db, slot.leagueId);
  assertCommissioner(league, actor);
  if (league.status !== "playoffs" && league.status !== "complete") throw new PlayoffError("wrong_status");
  if (!slot.teamAId || !slot.teamBId) throw new PlayoffError("invalid_input", "That game doesn't have two teams yet.");
  if (winnerTeamId !== slot.teamAId && winnerTeamId !== slot.teamBId) throw new PlayoffError("invalid_input");

  const slots = await loadSlots(db, slot.leagueId);
  const seeds = seedMap(slots);
  const down = downstreamOf(slots, slot);
  if (down) {
    const dm = await slotMatchups(db, down.next.id);
    if (down.next.winnerTeamId !== null || dm.some((m) => m.status !== "scheduled")) {
      throw new PlayoffError("downstream_started");
    }
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(playoffSlots)
      .set({
        winnerTeamId,
        decidedAt: now,
        overridden: true,
        overriddenBy: actor.id,
        overriddenAt: now,
        overrideNote: note?.trim().slice(0, 500) || null,
      })
      .where(eq(playoffSlots.id, slotId))
      .returning();
    const [winner] = await tx.select({ name: teams.name }).from(teams).where(eq(teams.id, winnerTeamId));
    await logActivity(tx, {
      leagueId: slot.leagueId,
      actorUserId: actor.id,
      type: "playoffs_override",
      summary: `Commissioner set ${winner?.name ?? "a team"} as the winner of round ${slot.round}, game ${slot.slot + 1}${note?.trim() ? ` (${note.trim().slice(0, 200)})` : ""}.`,
      data: { slotId, winnerTeamId, url: `/leagues/${slot.leagueId}/playoffs` },
      now,
    });
    if (down) {
      // Drop the (unplayed) next-round matchups, move the new winner in, recreate them.
      await tx.delete(matchups).where(eq(matchups.playoffSlotId, down.next.id));
      await setSide(tx, down.next, down.side, winnerTeamId, seeds.get(winnerTeamId) ?? null);
      await createMissingMatchups(tx, slot.leagueId);
    }
    return row;
  });
  log.warn("playoffs.commissioner_override", { actorId: actor.id, leagueId: slot.leagueId, round: slot.round, slot: slot.slot + 1, winnerTeamId, note: note ?? null });

  if (league.status === "complete") {
    const finalSlot = slots.find((s) => s.round === totalRounds(slots))!;
    if (finalSlot.id === slotId) await db.transaction((tx) => writeResults(tx, league.id));
  } else {
    await advancePlayoffs(db, slot.leagueId, now, deps);
  }
  return updated;
}

// -------------------------------------------------------------------------------------- views

/** Number / round of every period, for labeling ("Semifinal", "Final (week 2 of 2)", ...). */
export async function listPeriodsLite(db: Db, leagueId: string) {
  return db
    .select({ number: matchupPeriods.number, isPlayoff: matchupPeriods.isPlayoff, playoffRound: matchupPeriods.playoffRound })
    .from(matchupPeriods)
    .where(eq(matchupPeriods.leagueId, leagueId))
    .orderBy(asc(matchupPeriods.number));
}

export type BracketTeam = { teamId: string; name: string; seed: number | null };

export type BracketLeg = {
  matchupId: string;
  periodNumber: number;
  status: "scheduled" | "live" | "final";
  /** Points keyed by team. */
  points: Record<string, number | null>;
};

export type BracketSlotView = {
  id: string;
  round: number;
  slot: number;
  teamA: BracketTeam | null;
  teamB: BracketTeam | null;
  bye: boolean;
  winnerTeamId: string | null;
  /** Combined points across the slot's periods (null before any matchup exists). */
  scoreA: number | null;
  scoreB: number | null;
  legs: BracketLeg[];
  /** Status of the slot's matchups: all final / any live / otherwise upcoming. */
  status: "tbd" | "scheduled" | "live" | "final";
  overridden: boolean;
  overrideNote: string | null;
  /** Both seeds' ordering used for display (better seed first). */
};

export type BracketRound = {
  round: number;
  label: string;
  periods: { number: number; startDate: string; endDate: string }[];
  slots: BracketSlotView[];
};

export type BracketView = {
  seeded: boolean;
  rounds: BracketRound[];
  champion: BracketTeam | null;
  runnerUp: BracketTeam | null;
  /** Re-seeding is still possible (commissioner only). */
  canReseed: boolean;
};

/** Bracket with scores. Live legs (period started, not final) refresh their cached totals first. */
export async function getBracket(db: Db, leagueId: string, now = new Date()): Promise<BracketView> {
  const slots = await loadSlots(db, leagueId);
  if (slots.length === 0) return { seeded: false, rounds: [], champion: null, runnerUp: null, canReseed: false };
  const periods = await loadPlayoffPeriods(db, leagueId);
  const teamRows = await db.select().from(teams).where(eq(teams.leagueId, leagueId));
  const seeds = seedMap(slots);
  const name = new Map(teamRows.map((t) => [t.id, t.name]));
  const team = (id: string | null): BracketTeam | null =>
    id ? { teamId: id, name: name.get(id) ?? "Unknown team", seed: seeds.get(id) ?? null } : null;

  const today = etDateString(now);
  const periodById = new Map(periods.map((p) => [p.id, p]));
  const allLegs = await db.select().from(matchups).where(and(eq(matchups.leagueId, leagueId), isNotNull(matchups.playoffSlotId)));
  for (const m of allLegs) {
    const p = periodById.get(m.periodId);
    if (m.status !== "final" && p && p.startDate <= today) {
      await getMatchupTotals(db, m.id, now).catch(() => undefined); // never break the page over a live refresh
    }
  }
  const legs = await db.select().from(matchups).where(and(eq(matchups.leagueId, leagueId), isNotNull(matchups.playoffSlotId)));
  const rounds = totalRounds(slots);

  const rows: BracketRound[] = [];
  for (let r = 1; r <= rounds; r++) {
    rows.push({
      round: r,
      label: roundLabel(r, rounds),
      periods: periods.filter((p) => p.playoffRound === r).map((p) => ({ number: p.number, startDate: p.startDate, endDate: p.endDate })),
      slots: slots
        .filter((s) => s.round === r)
        .map((s): BracketSlotView => {
          const mine = legs.filter((m) => m.playoffSlotId === s.id);
          const sum = (teamId: string | null) =>
            teamId && mine.length
              ? mine.reduce((acc, m) => acc + (m.homeTeamId === teamId ? (m.homePoints ?? 0) : m.awayTeamId === teamId ? (m.awayPoints ?? 0) : 0), 0)
              : null;
          const status: BracketSlotView["status"] =
            mine.length === 0 ? "tbd" : mine.every((m) => m.status === "final") ? "final" : mine.some((m) => m.status === "live" || m.status === "final") ? "live" : "scheduled";
          return {
            id: s.id,
            round: r,
            slot: s.slot,
            teamA: team(s.teamAId),
            teamB: team(s.teamBId),
            bye: r === 1 && (s.teamAId === null || s.teamBId === null),
            winnerTeamId: s.winnerTeamId,
            scoreA: sum(s.teamAId),
            scoreB: sum(s.teamBId),
            legs: mine
              .map((m) => ({
                matchupId: m.id,
                periodNumber: periodById.get(m.periodId)?.number ?? 0,
                status: m.status,
                points: { ...(m.homeTeamId ? { [m.homeTeamId]: m.homePoints } : {}), ...(m.awayTeamId ? { [m.awayTeamId]: m.awayPoints } : {}) },
              }))
              .sort((a, b) => a.periodNumber - b.periodNumber),
            status,
            overridden: s.overridden,
            overrideNote: s.overrideNote,
          };
        }),
    });
  }
  const final = slots.find((s) => s.round === rounds);
  const league = await loadLeague(db, leagueId);
  const champion = league.status === "complete" && final?.winnerTeamId ? final.winnerTeamId : null;
  const runnerUp = champion && final ? (final.teamAId === champion ? final.teamBId : final.teamAId) : null;
  return {
    seeded: true,
    rounds: rows,
    champion: team(champion),
    runnerUp: team(runnerUp),
    canReseed: await canReseed(db, leagueId, now),
  };
}

/** Team seeds (1..N) for the current standings when the bracket isn't set yet. */
export async function previewSeeds(db: Db, leagueId: string, playoffTeams: number) {
  const rows = await getStandings(db, leagueId);
  return rows.slice(0, playoffTeams).map((r) => ({ teamId: r.teamId, name: r.name, seed: r.rank }));
}
