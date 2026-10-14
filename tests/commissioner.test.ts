import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityLog, draftPicks, drafts, leagues, rosterEntries, teams, type Team } from "@/db/schema";
import type { Db } from "@/db/types";
import { createUser } from "@/lib/auth/service";
import { DraftError, getDraftByLeague, makePick, restartDraft, startDraft } from "@/lib/draft/service";
import {
  LeagueError,
  getLeagueView,
  transferCommissioner,
  transferTeamOwnership,
  updateSettings,
  type LeagueErrorCode,
} from "@/lib/leagues/service";
import { createTestDb } from "./helpers/db";
import { begin, captureNotifier, createAdmin, pickSnake, seedPlayers, setupLeague, type DraftFixture } from "./helpers/draft";
import { rosterPlayer, seasonLeague } from "./helpers/rosters";

let db: Db;
let close: () => Promise<void> | void;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

const lcode = async (p: Promise<unknown>): Promise<LeagueErrorCode | "ok"> => {
  try {
    await p;
    return "ok";
  } catch (err) {
    if (err instanceof LeagueError) return err.code;
    throw err;
  }
};

function roles(fx: DraftFixture) {
  const commish = fx.teams.find((t) => t.ownerId === fx.league.commissionerId)!;
  const [m1, m2] = fx.teams.filter((t) => t.id !== commish.id).sort((a, b) => a.name.localeCompare(b.name));
  return { commish, m1, m2 };
}
const actor = (t: Team) => ({ id: t.ownerId, isSiteAdmin: false });

async function usernameOf(id: string) {
  const v = await db.query.users.findFirst({ where: (u, { eq: e }) => e(u.id, id) });
  return v!.username;
}

describe("transfer team ownership", () => {
  it("moves a team (and its roster) to an existing user without a team here; the old owner loses access", async () => {
    await seedPlayers(db, 10);
    const fx = await seasonLeague(db, 3);
    const { commish, m1 } = roles(fx);
    await rosterPlayer(db, fx, fx.teams.findIndex((t) => t.id === m1.id), 1);
    const newcomer = await createUser(db, { username: "Newcomer", password: "password123" });
    const n = captureNotifier();

    const updated = await transferTeamOwnership(db, actor(commish), m1.id, "newcomer", { notify: n.notify });
    expect(updated.ownerId).toBe(newcomer.id);
    const roster = await db.select().from(rosterEntries).where(and(eq(rosterEntries.teamId, m1.id), isNull(rosterEntries.releasedAt)));
    expect(roster).toHaveLength(1);

    // Access follows the team.
    expect((await getLeagueView(db, { id: newcomer.id, isSiteAdmin: false }, fx.league.id)).myTeam?.id).toBe(m1.id);
    await expect(getLeagueView(db, { id: m1.ownerId, isSiteAdmin: false }, fx.league.id)).rejects.toMatchObject({ code: "forbidden" });

    // Both people are told; the log names the commissioner as actor.
    expect(n.calls.map((c) => [c.type, c.userIds[0]]).sort()).toEqual(
      [
        ["commissioner_actions", newcomer.id],
        ["commissioner_actions", m1.ownerId],
      ].sort(),
    );
    const log = await db.select().from(activityLog).where(eq(activityLog.type, "team_owner_transferred"));
    expect(log).toHaveLength(1);
    expect(log[0].actorUserId).toBe(commish.ownerId);
    expect(log[0].summary).toContain("Newcomer");
  });

  it("enforces the rules: commissioner only, user must exist, must not own a team here, not the commissioner's team", async () => {
    const fx = await seasonLeague(db, 3);
    const { commish, m1, m2 } = roles(fx);
    const n = captureNotifier();
    const go = (who: Team, team: Team, username: string) => transferTeamOwnership(db, actor(who), team.id, username, { notify: n.notify });
    const m2name = await usernameOf(m2.ownerId);
    const m1name = await usernameOf(m1.ownerId);
    const commishName = await usernameOf(commish.ownerId);

    expect(await lcode(go(m1, m1, "whoever"))).toBe("forbidden");
    expect(await lcode(go(commish, m1, "does-not-exist"))).toBe("user_not_found");
    expect(await lcode(go(commish, m1, m2name))).toBe("already_on_team"); // owns a team already
    expect(await lcode(go(commish, m1, m1name))).toBe("same_owner");
    expect(await lcode(go(commish, commish, "someone"))).toBe("cannot_transfer_commissioner_team");
    expect(commishName).toBeTruthy();

    // Owning a team in ANOTHER league doesn't block it.
    const other = await seasonLeague(db, 2);
    const foreign = other.teams.find((t) => t.ownerId !== other.league.commissionerId)!;
    expect(await lcode(go(commish, m1, await usernameOf(foreign.ownerId)))).toBe("ok");
    expect(n.calls.length).toBe(2);
  });

  it("works while the draft is running and keeps the unique-owner rule", async () => {
    await seedPlayers(db, 30);
    const admin = await createAdmin(db);
    const fx = await setupLeague(db, admin, 3, { rosterPool: 6, snakeTarget: 100 });
    await begin(db, fx);
    const { m1 } = roles(fx);
    const fresh = await createUser(db, { username: "midDraft", password: "password123" });
    expect(await lcode(transferTeamOwnership(db, admin, m1.id, "middraft", { notify: captureNotifier().notify }))).toBe("ok");
    expect((await db.select().from(teams).where(eq(teams.id, m1.id)))[0].ownerId).toBe(fresh.id);
  });
});

describe("transfer commissioner role", () => {
  it("hands the role to another team owner; the old commissioner loses the tools, the new one gains them", async () => {
    const fx = await seasonLeague(db, 3);
    const { commish, m1, m2 } = roles(fx);
    const n = captureNotifier();
    expect(await lcode(transferCommissioner(db, actor(m1), fx.league.id, m2.id, { notify: n.notify }))).toBe("forbidden");
    expect(await lcode(transferCommissioner(db, actor(commish), fx.league.id, commish.id, { notify: n.notify }))).toBe("already_commissioner");

    // A team in a different league can't receive the role.
    const other = await seasonLeague(db, 2);
    expect(await lcode(transferCommissioner(db, actor(commish), fx.league.id, other.teams[0].id, { notify: n.notify }))).toBe("not_found");
    expect(await lcode(transferCommissioner(db, actor(commish), fx.league.id, "nope", { notify: n.notify }))).toBe("not_found");

    const updated = await transferCommissioner(db, actor(commish), fx.league.id, m1.id, { notify: n.notify });
    expect(updated.commissionerId).toBe(m1.ownerId);
    expect(n.calls).toHaveLength(1);
    expect(n.calls[0]).toMatchObject({ type: "commissioner_actions", userIds: [m1.ownerId] });

    // Old commissioner: no settings access, view says so.
    expect(await lcode(updateSettings(db, actor(commish), fx.league.id, { addsPerDay: 3 }))).toBe("forbidden");
    expect((await getLeagueView(db, actor(commish), fx.league.id)).isCommissioner).toBe(false);
    // New commissioner has the tools.
    expect(await lcode(updateSettings(db, actor(m1), fx.league.id, { addsPerDay: 3 }))).toBe("ok");
    expect((await getLeagueView(db, actor(m1), fx.league.id)).isCommissioner).toBe(true);
    // The old one can't take it back.
    expect(await lcode(transferCommissioner(db, actor(commish), fx.league.id, commish.id, { notify: n.notify }))).toBe("forbidden");

    const log = await db.select().from(activityLog).where(eq(activityLog.type, "commissioner_transferred"));
    expect(log).toHaveLength(1);
    expect(log[0].actorUserId).toBe(commish.ownerId);
    expect(m2.id).toBeTruthy();
  });
});

describe("restart draft", () => {
  async function drafting() {
    const admin = await createAdmin(db);
    const ids = await seedPlayers(db, 40);
    const fx = await setupLeague(db, admin, 2, { rosterPool: 4, snakeTarget: 100 }); // 2 per team, all snake
    const n = captureNotifier();
    const draft = await begin(db, fx, n.deps);
    return { admin, ids, fx, n, draft };
  }
  const status = async (id: string) => (await db.select().from(leagues).where(eq(leagues.id, id)))[0].status;
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return "ok";
    } catch (err) {
      if (err instanceof DraftError) return err.code;
      throw err;
    }
  };

  it("deletes every pick and roster entry, removes the draft and returns the league to setup (typed name required)", async () => {
    const { admin, ids, fx, n, draft } = await drafting();
    await pickSnake(db, fx, draft, 1, ids[0], n.deps);
    await pickSnake(db, fx, draft, 2, ids[1], n.deps);
    expect(await db.select().from(draftPicks)).toHaveLength(2);
    expect(await status(fx.league.id)).toBe("drafting");

    const other = captureNotifier();
    expect(await code(restartDraft(db, fx.league.id, admin.id, "wrong name", { notify: other.notify }))).toBe("confirm_mismatch");
    const member = fx.teams.find((t) => t.ownerId !== admin.id)!;
    expect(await code(restartDraft(db, fx.league.id, member.ownerId, fx.league.name, { notify: other.notify }))).toBe("forbidden");
    expect(await db.select().from(draftPicks)).toHaveLength(2); // refusals changed nothing

    const res = await restartDraft(db, fx.league.id, admin.id, `  ${fx.league.name.toUpperCase()} `, { notify: other.notify });
    expect(res.picksRemoved).toBe(2);
    expect(await db.select().from(draftPicks)).toHaveLength(0);
    expect(await db.select().from(rosterEntries).where(eq(rosterEntries.leagueId, fx.league.id))).toHaveLength(0);
    expect(await getDraftByLeague(db, fx.league.id)).toBeNull();
    expect(await db.select().from(drafts)).toHaveLength(0);
    expect(await status(fx.league.id)).toBe("setup");

    const told = other.calls.filter((c) => c.type === "draft_events");
    expect(told).toHaveLength(1);
    expect([...told[0].userIds].sort()).toEqual(fx.teams.map((t) => t.ownerId).sort());
    const log = await db.select().from(activityLog).where(eq(activityLog.type, "draft_restart"));
    expect(log).toHaveLength(1);
    expect(log[0].actorUserId).toBe(admin.id);

    // Fully reset: it can be started again, and the same players are draftable again.
    const again = await startDraft(db, fx.league.id, admin.id, other.deps);
    expect(again.status).toBe("snake");
    const first = again.order[0];
    await makePick(db, again.id, first, ids[0], fx.owner.get(first)!, other.deps);
    expect(await db.select().from(draftPicks)).toHaveLength(1);
  });

  it("is refused before the draft starts and after it completes", async () => {
    const admin = await createAdmin(db);
    const ids = await seedPlayers(db, 40);
    const fx = await setupLeague(db, admin, 2, { rosterPool: 4, snakeTarget: 100 });
    expect(await code(restartDraft(db, fx.league.id, admin.id, fx.league.name))).toBe("cannot_restart"); // setup, no draft
    const n = captureNotifier();
    const draft = await begin(db, fx, n.deps);
    for (let i = 1; i <= 4; i++) await pickSnake(db, fx, draft, i, ids[i - 1], n.deps);
    expect(await status(fx.league.id)).toBe("in_season");
    expect(await code(restartDraft(db, fx.league.id, admin.id, fx.league.name, { notify: n.notify }))).toBe("cannot_restart");
    expect(await db.select().from(draftPicks)).toHaveLength(4);
  });
});
