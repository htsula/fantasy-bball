/**
 * Opens a restored checkpoint database, adds the throwaway rows the browser pass needs (site invite links, reset
 * links, one of each used) and collects the ids it will visit into .pglite-sim/<checkpoint>.meta.json.
 */
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../../src/db/schema";
import { draftPicks, drafts, keepers as keepersTable, leagues, seasonResults, matchupPeriods, matchups, nbaPlayers, rosterEntries, teams, trades, users } from "../../src/db/schema";
import type { Db } from "../../src/db/types";
import { createInvite, createPasswordReset, createUser, redeemInvite, redeemPasswordReset } from "../../src/lib/auth/service";
import { listLeagueInvites } from "../../src/lib/leagues/service";
import { getFocusPeriod, getMatchupForTeam } from "../../src/lib/matchups/service";
import { type Checkpoint, type LeagueMeta, type Meta, type SimUserMeta, dbDir, metaFile, snapMeta } from "./common";

export async function prepare(cp: Checkpoint): Promise<Meta> {
  const snap = JSON.parse(fs.readFileSync(snapMeta(cp), "utf8")) as { now: string; leagueId: string; nextLeagueId: string | null; users: SimUserMeta[] };
  const now = new Date(snap.now);
  const client = new PGlite(dbDir(cp));
  const db = drizzle(client, { schema }) as unknown as Db;
  const commissioner = snap.users.find((u) => u.role === "commissioner")!;
  const nonMember = snap.users.find((u) => u.username === "intruder")!;
  const members = snap.users.filter((u) => u.role === "member");
  const member = members.find((u) => u.username === "mgr06") ?? members[0];

  async function leagueMeta(leagueId: string): Promise<LeagueMeta> {
    const [lg] = await db.select().from(leagues).where(eq(leagues.id, leagueId));
    const teamRows = await db
      .select({ team: teams, owner: users.username })
      .from(teams)
      .innerJoin(users, eq(users.id, teams.ownerId))
      .where(eq(teams.leagueId, leagueId))
      .orderBy(asc(teams.name));
    const [draft] = await db.select().from(drafts).where(eq(drafts.leagueId, leagueId));
    const periods = await db.select().from(matchupPeriods).where(eq(matchupPeriods.leagueId, leagueId)).orderBy(asc(matchupPeriods.number));
    const myTeam = teamRows.find((t) => t.team.ownerId === member.userId)?.team;
    const mm: LeagueMeta["matchups"] = {};
    if (myTeam && periods.length) {
      const focus = await getFocusPeriod(db, leagueId, now);
      if (focus) mm.current = (await getMatchupForTeam(db, focus.id, myTeam.id))?.id;
      // The commissioner's team may sit out the focus period (e.g. missed the playoffs).
      const commishTeam = teamRows.find((t) => t.team.ownerId === commissioner.userId)?.team;
      if (focus && commishTeam) mm.commishCurrent = (await getMatchupForTeam(db, focus.id, commishTeam.id))?.id;
      const p3 = periods.find((p) => p.number === 3)!;
      const past = await getMatchupForTeam(db, p3.id, myTeam.id);
      if (past && past.status === "final") mm.past = past.id;
    }
    const playoffRows = await db.select({ id: matchups.id, status: matchups.status }).from(matchups).where(eq(matchups.leagueId, leagueId));
    const po = await db.select({ id: matchups.id, status: matchups.status, slot: matchups.playoffSlotId }).from(matchups).where(eq(matchups.leagueId, leagueId)).orderBy(desc(matchups.status));
    void playoffRows;
    const poRows = po.filter((r) => r.slot !== null);
    if (poRows.length) {
      mm.playoff = (poRows.find((r) => r.status === "final") ?? poRows[0]).id;
      mm.otherPlayoff = poRows[poRows.length - 1].id;
    }
    const tradeRows = await db.select().from(trades).where(eq(trades.leagueId, leagueId)).orderBy(asc(trades.createdAt));
    const tradeIds: Record<string, string> = {};
    for (const t of tradeRows) tradeIds[t.kind === "reversal" ? "reversal" : t.status] ??= t.id;
    const rostered = myTeam ? (await db.select().from(rosterEntries).where(and(eq(rosterEntries.teamId, myTeam.id), isNull(rosterEntries.releasedAt))).limit(1))[0]?.playerId : undefined;
    const taken = new Set((await db.select({ id: rosterEntries.playerId }).from(rosterEntries).where(and(eq(rosterEntries.leagueId, leagueId), isNull(rosterEntries.releasedAt)))).map((r) => r.id));
    const all = await db.select({ id: nbaPlayers.id, active: nbaPlayers.active, team: nbaPlayers.teamId }).from(nbaPlayers).orderBy(asc(nbaPlayers.id));
    const freeAgent = all.find((p) => p.active && p.team !== null && !taken.has(p.id))?.id;
    const retired = all.find((p) => !p.active)?.id;
    const invites: LeagueMeta["invites"] = {};
    try {
      for (const i of await listLeagueInvites(db, { id: commissioner.userId, isSiteAdmin: true }, leagueId, now)) {
        if (!i.token) continue;
        if (i.status === "active") invites.active ??= i.token;
        else if (i.status === "closed") invites.closed ??= i.token;
        else if (i.status === "revoked") invites.revoked ??= i.token;
      }
    } catch {
      /* commissioner changed hands in this checkpoint's data: no invites to list */
    }
    // The closed link may show as revoked once other links exist; keep any token for the "closed" page.
    void draftPicks;
    const results = await db.select().from(seasonResults).where(eq(seasonResults.leagueId, leagueId));
    const keeperRows = await db.select({ team: keepersTable.teamId, name: nbaPlayers.fullName }).from(keepersTable).innerJoin(nbaPlayers, eq(nbaPlayers.id, keepersTable.playerId)).where(eq(keepersTable.leagueId, leagueId));
    const keeperMap: Record<string, string[]> = {};
    for (const k of keeperRows) (keeperMap[k.team] ??= []).push(k.name);
    return {
      champion: results.find((r) => r.playoffResult === "champion")?.teamName,
      runnerUp: results.find((r) => r.playoffResult === "runner_up")?.teamName,
      keepers: keeperMap,
      id: leagueId,
      name: lg.name,
      season: lg.season,
      status: lg.status,
      teams: teamRows.map((r) => ({ id: r.team.id, name: r.team.name, abbrev: r.team.abbrev, ownerId: r.team.ownerId, ownerUsername: r.owner })),
      draft: draft ? { status: draft.status, currentPick: draft.currentPick, currentWave: draft.currentWave, order: draft.order } : null,
      matchups: mm,
      trades: tradeIds,
      playerIds: { rostered, freeAgent, retired },
      invites,
      periods: periods.map((p) => ({ number: p.number, isPlayoff: p.isPlayoff, startDate: p.startDate, endDate: p.endDate })),
    };
  }

  const league = await leagueMeta(snap.leagueId);
  const next = snap.nextLeagueId ? await leagueMeta(snap.nextLeagueId) : undefined;

  // Throwaway auth rows (this database is a disposable copy).
  const [siteValid, siteUsed] = [await createInvite(db, { createdBy: commissioner.userId }, now), await createInvite(db, { createdBy: commissioner.userId }, now)];
  await redeemInvite(db, { token: siteUsed.token, username: "sitejoiner", password: "sim-site-joiner-1" }, now);
  const dummy = await createUser(db, { username: "resetdummy", password: "sim-reset-dummy-1" });
  const resetUsed = await createPasswordReset(db, { userId: dummy.id, createdBy: commissioner.userId }, now);
  await redeemPasswordReset(db, { token: resetUsed.token, password: "sim-reset-dummy-2" }, now);
  const resetValid = await createPasswordReset(db, { userId: dummy.id, createdBy: commissioner.userId }, now);
  await client.close();

  // Users as of this checkpoint, with the team they own in the CURRENT league.
  const meta: Meta = {
    checkpoint: cp,
    now: snap.now,
    users: snap.users,
    member,
    commissioner,
    nonMember,
    league,
    next,
    tokens: { siteValid: siteValid.token, siteUsed: siteUsed.token, resetValid: resetValid.token, resetUsed: resetUsed.token },
  };
  fs.writeFileSync(metaFile(cp), JSON.stringify(meta, null, 1));
  return meta;
}
