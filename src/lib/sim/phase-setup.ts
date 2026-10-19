/** League setup for the simulation: accounts, invites, joins, renames, settings and the schedule. */
import { eq } from "drizzle-orm";
import { teams, leagues, users as usersTable } from "@/db/schema";
import {
  authenticate,
  createInvite,
  createPasswordReset,
  createSession,
  createUser,
  getInviteStatus,
  getResetStatus,
  redeemInvite,
  redeemPasswordReset,
  validateSession,
} from "@/lib/auth/service";
import { startDraft } from "@/lib/draft/service";
import {
  createLeague,
  createLeagueInvite,
  defaultSeasonDates,
  generateSchedule,
  getLeagueInviteInfo,
  getLeagueView,
  getSchedule,
  joinLeague,
  listLeagueInvites,
  redeemLeagueInvite,
  removeTeam,
  renameTeam,
  revokeLeagueInvite,
  updateSettings,
} from "@/lib/leagues/service";
import { postAnnouncement, postMessage, setPinned, markChatRead, chatUnreadCount } from "@/lib/chat/service";
import { addDays } from "@/lib/nba/dates";
import { unreadCount } from "@/lib/notifications/service";
import { at, eq as same, ok, rejectsWith, type Ctx, type Manager } from "./context";
import { OPENING_NIGHT, SEASON, SEASON_LAST_DAY } from "./nba-data";

export const COMMISH_USERNAME = "commish";
export const LEAGUE_NAME = "Sim Hoops League";
export const TRADE_DEADLINE = "2027-03-04";

const TEAMS: [string, string][] = [
  ["Commish Kings", "CMK"],
  ["Friendly Fire", "FRF"],
  ["Glass Cannons", "GLC"],
  ["Hardwood Heroes", "HWH"],
  ["Fast Break Club", "FBC"],
  ["Triple Doubles", "TRD"],
  ["Pick and Rollers", "PNR"],
  ["Buzzer Beaters", "BZZ"],
  ["Paint Patrol", "PNT"],
  ["Corner Threes", "CRT"],
  ["Rim Rockers", "RMR"],
  ["Splash Zone", "SPZ"],
  ["Zone Busters", "ZNB"],
  ["Full Court Press", "FCP"],
  ["Sixth Men", "SIX"],
  ["Last Second Shots", "LSS"],
];

export const pw = (n: number) => `sim-pass-${String(n).padStart(2, "0")}`;

/** Weekly Mon-Sun periods from opening night with the All-Star break merged; checks the app's schedule. */
export async function assertSchedule(ctx: Ctx, teamCount: number) {
  const { db, leagueId } = ctx;
  const { periods } = await getSchedule(db, leagueId);
  same(ctx, periods.length, 24, "24 periods (21 regular + 3 playoff)");
  const regular = periods.filter((p) => !p.isPlayoff);
  const playoff = periods.filter((p) => p.isPlayoff);
  same(ctx, regular.length, 21, "regular periods");
  same(ctx, playoff.map((p) => p.playoffRound), [1, 2, 3], "playoff rounds");
  same(ctx, periods[0].startDate, OPENING_NIGHT, "first period starts on opening night");
  same(ctx, periods[periods.length - 1].endDate, SEASON_LAST_DAY, "last period ends on the last regular-season day");
  periods.forEach((p, i) => {
    same(ctx, p.number, i + 1, "period numbering");
    if (i > 0) same(ctx, p.startDate, addDays(periods[i - 1].endDate, 1), `period ${p.number} starts the day after ${i}`);
    // Mondays (except opening night), and every period is 7 days except the first (Tue-Sun) and the merged All-Star one.
    if (i > 0) ok(ctx, new Date(`${p.startDate}T00:00:00Z`).getUTCDay() === 1, `period ${p.number} starts on a Monday`);
  });
  const merged = periods.filter((p) => Date.parse(p.endDate) - Date.parse(p.startDate) > 6 * 86_400_000);
  same(ctx, merged.map((p) => [p.startDate, p.endDate]), [["2027-02-08", "2027-02-21"]], "exactly one merged All-Star period covering the break");
  ok(ctx, merged[0].startDate <= "2027-02-12" && merged[0].endDate >= "2027-02-17", "merged period covers the break");

  // Every team plays exactly once per regular period (even team count: no byes), never twice a week.
  const pairs = new Set<string>();
  regular.forEach((p, i) => {
    same(ctx, p.matchups.length, teamCount / 2, `period ${p.number} matchup count`);
    const seen = new Set<string>();
    for (const m of p.matchups) {
      ok(ctx, m.homeTeamId && m.awayTeamId, "no byes with an even team count");
      for (const t of [m.homeTeamId!, m.awayTeamId!]) {
        ok(ctx, !seen.has(t), `team plays twice in period ${p.number}`);
        seen.add(t);
      }
      if (i < teamCount - 1) pairs.add([m.homeTeamId, m.awayTeamId].sort().join("|"));
    }
    same(ctx, seen.size, teamCount, `every team plays in period ${p.number}`);
  });
  same(ctx, pairs.size, (teamCount * (teamCount - 1)) / 2, "every team plays every other team once in the first round-robin cycle");
  for (const p of playoff) same(ctx, p.matchups.length, 0, "playoff periods start empty");
}

export async function setupLeague(ctx: Ctx): Promise<void> {
  const { db, rand, counters } = ctx;
  const t = (day: string, hhmm = "10:00") => at(day, hhmm);

  // ---- accounts
  const adminRow = await createUser(db, { username: COMMISH_USERNAME, password: pw(1), isSiteAdmin: true });
  const actor = { id: adminRow.id, isSiteAdmin: true };
  const users = new Map<string, { id: string; password: string }>();
  users.set(COMMISH_USERNAME, { id: adminRow.id, password: pw(1) });

  // A single-use SITE invite brings the first friend in; a second redemption must fail.
  const site = await createInvite(db, { createdBy: adminRow.id }, t("2026-10-01", "09:00"));
  const friend = await redeemInvite(db, { token: site.token, username: "friend", password: pw(2) }, t("2026-10-01", "09:30"));
  users.set("friend", { id: friend.id, password: pw(2) });
  same(ctx, await getInviteStatus(db, site.token, t("2026-10-01", "10:00")), "used", "site invite is single-use");
  await rejectsWith(ctx, redeemInvite(db, { token: site.token, username: "latecomer", password: pw(3) }, t("2026-10-01", "10:00")), "invalid_token", "reusing a site invite");
  const expired = await createInvite(db, { createdBy: adminRow.id }, t("2026-09-01"));
  await rejectsWith(ctx, redeemInvite(db, { token: expired.token, username: "stale", password: pw(3) }, t("2026-10-01")), "invalid_token", "expired site invite");
  const session = await createSession(db, adminRow.id, t("2026-10-01", "10:00"));
  ok(ctx, (await validateSession(db, session.token, t("2026-10-01", "11:00")))?.id === adminRow.id, "admin session validates");

  // ---- league with the NBA-derived default dates
  const dates = await defaultSeasonDates(db, SEASON);
  same(ctx, dates, { start: OPENING_NIGHT, end: SEASON_LAST_DAY }, "default season dates come from the NBA schedule");
  const league = await createLeague(db, actor, { name: LEAGUE_NAME, season: SEASON, teamName: TEAMS[0][0], teamAbbrev: TEAMS[0][1] });
  ctx.leagueId = league.id;
  same(ctx, league.status, "setup", "new league is in setup");
  const initial = (await getLeagueView(db, actor, league.id)).settings;
  same(ctx, [initial.regularSeasonStart, initial.regularSeasonEnd], [OPENING_NIGHT, SEASON_LAST_DAY], "league settings carry the NBA dates");
  await rejectsWith(ctx, createLeague(db, { id: friend.id, isSiteAdmin: false }, { name: "Nope League", season: SEASON, teamName: "Nope", teamAbbrev: "NOP" }), "forbidden", "non-admin creating a league");

  const joined: { username: string; teamId: string; teamName: string; abbrev: string }[] = [];
  joined.push({ username: COMMISH_USERNAME, teamId: (await db.select().from(teams).where(eq(teams.leagueId, league.id)))[0].id, teamName: TEAMS[0][0], abbrev: TEAMS[0][1] });

  // ---- invite link A: two joins, then revoked
  const linkA = await createLeagueInvite(db, actor, league.id, {}, t("2026-10-02", "09:00"));
  await rejectsWith(ctx, createLeagueInvite(db, { id: friend.id, isSiteAdmin: false }, league.id, {}), "forbidden", "non-commissioner creating an invite");
  const join = async (username: string, n: number, token: string, teamIdx: number, when: Date, override?: [string, string]) => {
    const [teamName, abbrev] = override ?? TEAMS[teamIdx];
    const res = await redeemLeagueInvite(db, { token, username, password: pw(n), teamName, teamAbbrev: abbrev }, when);
    users.set(username, { id: res.user.id, password: pw(n) });
    joined.push({ username, teamId: res.team.id, teamName, abbrev });
    return res;
  };
  await join("mgr03", 3, linkA.token, 2, t("2026-10-02", "10:00"));
  // Duplicate checks (case-insensitive name, abbreviation, username) leave no half-created team or user behind.
  await rejectsWith(ctx, redeemLeagueInvite(db, { token: linkA.token, username: "dupe1", password: pw(4), teamName: "glass CANNONS", teamAbbrev: "DUP" }, t("2026-10-02", "10:05")), "name_taken", "duplicate team name");
  await rejectsWith(ctx, redeemLeagueInvite(db, { token: linkA.token, username: "dupe2", password: pw(4), teamName: "Brand New Name", teamAbbrev: "glc" }, t("2026-10-02", "10:06")), "abbrev_taken", "duplicate abbreviation");
  await rejectsWith(ctx, redeemLeagueInvite(db, { token: linkA.token, username: "dupe3", password: pw(4), teamName: "X", teamAbbrev: "XYZ" }, t("2026-10-02", "10:07")), "invalid_input", "one-letter team name");
  await rejectsWith(ctx, redeemLeagueInvite(db, { token: linkA.token, username: "dupe4", password: pw(4), teamName: "Fine Name", teamAbbrev: "A1" }, t("2026-10-02", "10:08")), "invalid_input", "bad abbreviation");
  await rejectsWith(ctx, redeemLeagueInvite(db, { token: linkA.token, username: "MGR03", password: pw(4), teamName: "Fine Name", teamAbbrev: "FNM" }, t("2026-10-02", "10:09")), "username_taken", "duplicate username");
  same(ctx, (await db.select().from(teams).where(eq(teams.leagueId, league.id))).length, 2, "failed joins left no teams behind");
  same(ctx, (await listLeagueInvites(db, actor, league.id, t("2026-10-02", "10:10"))).find((i) => i.id === linkA.id)!.useCount, 1, "failed joins did not use up the invite");
  same(ctx, (await db.select().from(usersTable).where(eq(usersTable.username, "dupe1"))).length, 0, "failed joins left no user behind");
  await join("mgr04", 4, linkA.token, 3, t("2026-10-02", "11:00"));

  const listed = await listLeagueInvites(db, actor, league.id, t("2026-10-02", "12:00"));
  same(ctx, [listed[0].status, listed[0].useCount, listed[0].members.map((m) => m.username)], ["active", 2, ["mgr03", "mgr04"]], "invite A lists who joined");
  await revokeLeagueInvite(db, actor, league.id, linkA.id, t("2026-10-02", "12:30"));
  same(ctx, (await getLeagueInviteInfo(db, linkA.token, t("2026-10-02", "13:00"))).status, "revoked", "revoked link info");
  await rejectsWith(ctx, redeemLeagueInvite(db, { token: linkA.token, username: "mgr05", password: pw(5), teamName: TEAMS[4][0], teamAbbrev: TEAMS[4][1] }, t("2026-10-02", "13:00")), "invite_revoked", "joining through a revoked link");

  // ---- invite link B: the one everybody uses
  const linkB = await createLeagueInvite(db, actor, league.id, {}, t("2026-10-03", "09:00"));
  const friendTeam = await joinLeague(db, { id: friend.id, isSiteAdmin: false }, { token: linkB.token, teamName: TEAMS[1][0], teamAbbrev: TEAMS[1][1] }, t("2026-10-03", "10:00"));
  joined.push({ username: "friend", teamId: friendTeam.id, teamName: TEAMS[1][0], abbrev: TEAMS[1][1] });
  await rejectsWith(ctx, joinLeague(db, { id: friend.id, isSiteAdmin: false }, { token: linkB.token, teamName: "Second Team", teamAbbrev: "SEC" }, t("2026-10-03", "10:05")), "already_on_team", "joining twice");
  for (let k = 5; k <= 10; k++) await join(`mgr${String(k).padStart(2, "0")}`, k, linkB.token, k - 1, t("2026-10-0" + Math.min(9, k - 1), "10:00"));

  // A schedule built now will be cleared by the next join.
  await updateSettings(db, actor, league.id, { playoffTeams: 8, playoffRoundLength: 1, tradeDeadline: TRADE_DEADLINE, keepers: 2 });
  await generateSchedule(db, actor, league.id, { seed: `early-${ctx.seed}` });
  ok(ctx, (await getSchedule(db, league.id)).periods.length > 0, "early schedule exists");
  for (let k = 11; k <= 16; k++) {
    // mgr15 and mgr16 sign up with placeholder names and rename later.
    const override: [string, string] | undefined = k === 15 ? ["Sixth Mn", "SXM"] : k === 16 ? ["Last Shots FC", "LSF"] : undefined;
    await join(`mgr${k}`, k, linkB.token, k - 1, t("2026-10-1" + Math.min(2, k - 11), "10:00"), override);
  }
  same(ctx, (await getSchedule(db, league.id)).periods.length, 0, "joining clears the schedule");

  // ---- the unwanted 17th joiner, removed by the commissioner
  // A one-use link (kept alongside B) lets exactly one stranger in.
  const linkC = await createLeagueInvite(db, actor, league.id, { maxUses: 1, revokeOthers: false }, t("2026-10-12", "19:00"));
  const intruder = await redeemLeagueInvite(db, { token: linkC.token, username: "intruder", password: pw(17), teamName: "Uninvited Guests", teamAbbrev: "UNG" }, t("2026-10-12", "20:00"));
  same(ctx, (await getLeagueInviteInfo(db, linkC.token, t("2026-10-12", "20:01"))).status, "full", "a one-use link is full after one join");
  await rejectsWith(ctx, redeemLeagueInvite(db, { token: linkC.token, username: "intruder2", password: pw(19), teamName: "More Guests", teamAbbrev: "MOG" }, t("2026-10-12", "20:02")), "invite_full", "a second join through a one-use link");
  await rejectsWith(ctx, createLeagueInvite(db, actor, league.id, { maxUses: 0 }, t("2026-10-12", "20:03")), "invalid_input", "an invite limit of zero");
  same(ctx, (await getLeagueInviteInfo(db, linkB.token, t("2026-10-12", "20:04"))).status, "valid", "link B is still open next to the one-use link");
  same(ctx, (await db.select().from(teams).where(eq(teams.leagueId, league.id))).length, 17, "17 teams before removal");
  await rejectsWith(ctx, removeTeam(db, { id: friend.id, isSiteAdmin: false }, intruder.team.id), "forbidden", "non-commissioner removing a team");
  await rejectsWith(ctx, removeTeam(db, actor, joined[0].teamId), "cannot_remove_commissioner", "removing the commissioner's team");
  await removeTeam(db, actor, intruder.team.id);
  same(ctx, (await db.select().from(teams).where(eq(teams.leagueId, league.id))).length, 16, "16 teams after removal");
  ok(ctx, (await listLeagueInvites(db, actor, league.id)).find((i) => i.id === linkC.id)!.members.every((m) => m.username !== "intruder"), "removed team no longer listed under the link");

  // ---- renames
  const renamer = joined.find((j) => j.username === "mgr16")!;
  const renamed = await renameTeam(db, { id: users.get("mgr16")!.id, isSiteAdmin: false }, renamer.teamId, { name: "Last Second Shots", abbrev: "LSS" });
  same(ctx, [renamed.name, renamed.abbrev], ["Last Second Shots", "LSS"], "owner renamed his team");
  Object.assign(renamer, { teamName: "Last Second Shots", abbrev: "LSS" });
  await rejectsWith(ctx, renameTeam(db, { id: friend.id, isSiteAdmin: false }, renamer.teamId, { name: "Hijacked" }), "forbidden", "renaming someone else's team");
  await rejectsWith(ctx, renameTeam(db, { id: friend.id, isSiteAdmin: false }, friendTeam.id, { name: "glass cannons" }), "name_taken", "renaming onto an existing name");
  await rejectsWith(ctx, renameTeam(db, { id: friend.id, isSiteAdmin: false }, friendTeam.id, { name: "Friendly Fire", abbrev: "GLC" }), "abbrev_taken", "renaming onto an existing abbreviation");
  const sixth = joined.find((j) => j.username === "mgr15")!;
  const byCommish = await renameTeam(db, actor, sixth.teamId, { name: "Sixth Men", abbrev: "SIX" });
  same(ctx, [byCommish.name, byCommish.abbrev], ["Sixth Men", "SIX"], "commissioner renamed a team");
  Object.assign(sixth, { teamName: "Sixth Men", abbrev: "SIX" });

  // ---- password reset for one user
  const target = users.get("mgr09")!;
  const reset = await createPasswordReset(db, { userId: target.id, createdBy: adminRow.id }, t("2026-10-13", "09:00"));
  same(ctx, await getResetStatus(db, reset.token, t("2026-10-13", "09:30")), "valid", "reset link valid");
  await redeemPasswordReset(db, { token: reset.token, password: "sim-new-pass-09" }, t("2026-10-13", "09:30"));
  same(ctx, (await authenticate(db, "mgr09", pw(9), t("2026-10-13", "10:00"))).ok, false, "old password rejected after a reset");
  same(ctx, (await authenticate(db, "MGR09", "sim-new-pass-09", t("2026-10-13", "10:01"))).ok, true, "new password works (case-insensitive username)");
  await rejectsWith(ctx, redeemPasswordReset(db, { token: reset.token, password: "another-pass-09" }, t("2026-10-13", "11:00")), "invalid_token", "reusing a reset link");
  target.password = "sim-new-pass-09";

  // ---- settings validation, then the real schedule
  await rejectsWith(ctx, updateSettings(db, { id: friend.id, isSiteAdmin: false }, league.id, { addsPerDay: 5 }), "forbidden", "non-commissioner changing settings");
  await rejectsWith(ctx, updateSettings(db, actor, league.id, { playoffTeams: 5 }), "invalid_input", "5 playoff teams");
  await rejectsWith(ctx, updateSettings(db, actor, league.id, { keepers: 21 }), "invalid_input", "21 keepers");
  const settings = await updateSettings(db, actor, league.id, { playoffTeams: 8, playoffRoundLength: 1, tradeDeadline: TRADE_DEADLINE, keepers: 2 });
  same(ctx, [settings.rosterPool, settings.rosterCap, settings.snakeTarget, settings.waveSize, settings.addsPerDay, settings.tradeReview], [520, 50, 200, 2, 2, "commissioner"], "defaults kept");

  await rejectsWith(ctx, startDraft(db, league.id, actor.id, { now: t("2026-10-13", "12:00") }), "schedule_required", "starting the draft without a schedule");
  await generateSchedule(db, actor, league.id, { seed: `sim-${ctx.seed}` });
  await rejectsWith(ctx, startDraft(db, league.id, friend.id, { now: t("2026-10-13", "12:00") }), "forbidden", "non-commissioner starting the draft");
  await assertSchedule(ctx, 16);

  // ---- chat while still in setup: welcome announcement (pinned) and a mention
  const chatAt = t("2026-10-14", "08:00");
  for (const m of joined) await markChatRead(db, users.get(m.username)!.id, league.id, t("2026-10-03", "00:00"));
  const welcome = await postAnnouncement(db, actor, league.id, "Welcome to the league! Draft opens Oct 16, no pick timer. Trade deadline is March 4.", { now: chatAt, notify: ctx.notify });
  await setPinned(db, actor, welcome.id, true, { now: chatAt });
  const friendActor = { id: friend.id };
  await postMessage(db, friendActor, league.id, { body: "Hyped. @commish is the draft order random?" }, { now: t("2026-10-14", "08:10"), notify: ctx.notify });
  counters.chatMessages += 2;
  ok(ctx, (await chatUnreadCount(db, users.get("mgr05")!.id, league.id)) === 2, "unread chat counter before reading");
  await markChatRead(db, users.get("mgr05")!.id, league.id, t("2026-10-14", "09:00"));
  same(ctx, await chatUnreadCount(db, users.get("mgr05")!.id, league.id), 0, "markChatRead clears unread");
  ok(ctx, (await unreadCount(db, friend.id)) >= 0, "unread notification count readable");
  ok(ctx, ctx.sent.some((n) => n.type === "chat_mentions" && n.userIds.includes(adminRow.id)), "mention notified the commissioner");
  ok(ctx, !ctx.sent.some((n) => n.type === "chat_mentions" && n.userIds.includes(users.get("mgr05")!.id)), "non-mentioned member got no mention");

  // ---- managers
  const styles = rand.shuffle(["queue", "queue", "queue", "queue", "sleeper", "sleeper", "sleeper", "sleeper", "value", "value", "value", "value", "value", "value"] as const);
  const stalledNames = new Set(["mgr07", "mgr12"]);
  let si = 0;
  ctx.managers = joined.map((j): Manager => {
    const u = users.get(j.username)!;
    const style = j.username === COMMISH_USERNAME ? "value" : j.username === "friend" ? "queue" : styles[si++];
    return {
      username: j.username,
      password: u.password,
      userId: u.id,
      teamId: j.teamId,
      teamName: j.teamName,
      abbrev: j.abbrev,
      role: j.username === COMMISH_USERNAME ? "commissioner" : "member",
      isSiteAdmin: j.username === COMMISH_USERNAME,
      style,
      stalled: stalledNames.has(j.username),
    };
  });
  ctx.admin = { username: COMMISH_USERNAME, password: pw(1), userId: adminRow.id, teamId: joined[0].teamId, teamName: TEAMS[0][0], role: "commissioner", isSiteAdmin: true };
  ctx.nonMember = { username: "intruder", password: pw(17), userId: intruder.user.id, teamId: null, teamName: null, role: "non-member", isSiteAdmin: false };
  same(ctx, ctx.managers.length, 16, "16 managers");
  const view = await getLeagueView(db, actor, league.id);
  same(ctx, view.teams.length, 16, "16 teams in the league view");
  // Keep the league row's status honest.
  const [row] = await db.select().from(leagues).where(eq(leagues.id, league.id));
  same(ctx, row.status, "setup", "still in setup");
}
