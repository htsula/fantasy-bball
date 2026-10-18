/**
 * Calls the server-side loaders behind every page and API route (src/app/**), as the commissioner, a regular
 * member and a non-member site user, and checks that nothing throws and every result has a sane shape. It is the
 * service-layer stand-in for crawling the pages (the browser pass uses the same checkpoints). Pages that call
 * `ensureFreshLive` (a network refresh from ESPN) are covered through the loaders they call after it.
 */
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { messages as messagesTable, nbaGames, notifications, users } from "@/db/schema";
import type { Db } from "@/db/types";
import { ACTIVITY_FILTERS } from "@/lib/activity/types";
import { listActivity } from "@/lib/activity/service";
import { chatUnreadCount, latestAnnouncement, listMessages, listPinned } from "@/lib/chat/service";
import { getDraftBoard, listDraftablePlayers } from "@/lib/draft/board";
import { getDraftByLeague } from "@/lib/draft/service";
import { seasonChoiceFor } from "@/lib/fantasy/stats-query";
import { getLeagueInviteInfo, getLeagueView, getSchedule, getTeamView, listLeagueInvites, listLeagues } from "@/lib/leagues/service";
import { getMatchupBoxScore } from "@/lib/matchups/box-score";
import {
  getFocusPeriod,
  getMatchupForTeam,
  getMatchupTotals,
  getPeriodScoreboard,
  getCurrentPeriod,
  getStandings,
  listLeagueAdjustments,
} from "@/lib/matchups/service";
import { addDays, etDateString, etDayRange } from "@/lib/nba/dates";
import { getPlayerCard, listFilterOptions, listPlayers, SORT_KEYS } from "@/lib/nba/players-query";
import { countSubscriptions, getPrefs, listNotifications, unreadCount } from "@/lib/notifications/service";
import { getBracket, previewSeeds } from "@/lib/playoffs/service";
import { TEAM_RANGES, loadTeamRoster } from "@/lib/rosters/team-view";
import { getAddsToday, leagueMaxRoster, listTransactions } from "@/lib/rosters/service";
import { getKeeperView, getLeagueHistory, getNextSeasonId, getOwnerPastSeasons } from "@/lib/seasons/service";
import { countReceivedOffers, getTrade, listLeagueTrades, listRosterForTrade, listTradeBlock } from "@/lib/trades/service";
import type { CheckpointContext, CheckpointName } from "./context";
import { loadOracleData, oracleTeamTotal } from "./oracle";

class SmokeError extends Error {}

function must(cond: unknown, message: string): asserts cond {
  if (!cond) throw new SmokeError(message);
}

export type SmokeResult = { calls: number; slow: { label: string; ms: number }[]; slowest: { label: string; ms: number }[] };

/** Runs every loader for the league the checkpoint is about. Throws (with the loader's name) on the first failure. */
export async function smokePages(db: Db, c: CheckpointContext, name: CheckpointName): Promise<SmokeResult> {
  const out: SmokeResult = { calls: 0, slow: [], slowest: [] };
  const leagueId = name.startsWith("next-season") && c.nextLeagueId ? c.nextLeagueId : c.leagueId;
  const commish = c.users.find((u) => u.role === "commissioner")!;
  const members = c.users.filter((u) => u.role === "member");
  const member = members[Math.min(4, members.length - 1)];
  const outsider = c.users.find((u) => u.role === "non-member");
  const now = c.now;

  const call = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      const v = await fn();
      out.calls++;
      return v;
    } catch (err) {
      throw new SmokeError(`[${name}] ${label}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      const ms = Date.now() - t0;
      if (ms > 1500) out.slow.push({ label: `${name} ${label}`, ms });
      out.slowest.push({ label, ms });
      out.slowest.sort((a, b) => b.ms - a.ms);
      out.slowest.length = Math.min(out.slowest.length, 3);
    }
  };
  const denied = async (label: string, fn: () => Promise<unknown>, code = "forbidden") => {
    try {
      await fn();
    } catch (err) {
      const got = (err as { code?: string }).code;
      if (got === code) {
        out.calls++;
        return;
      }
      throw new SmokeError(`[${name}] ${label}: expected ${code}, got ${got ?? String(err)}`);
    }
    throw new SmokeError(`[${name}] ${label}: expected ${code} but it was allowed`);
  };
  const actorOf = (u: { userId: string; isSiteAdmin: boolean }) => ({ id: u.userId, isSiteAdmin: u.isSiteAdmin });

  // ---- home / leagues list / league view (every league page starts here)
  const mine = await call("listLeagues(member)", () => listLeagues(db, actorOf(member)));
  must(mine.mine.some((l) => l.league.id === leagueId), "member's league missing from /leagues");
  const adminList = await call("listLeagues(commissioner)", () => listLeagues(db, actorOf(commish)));
  must(adminList.mine.length >= 1, "commissioner has leagues");
  if (outsider) {
    const theirs = await call("listLeagues(non-member)", () => listLeagues(db, actorOf(outsider)));
    must(!theirs.mine.some((l) => l.league.id === leagueId), "non-member sees the league as his own");
    await denied("getLeagueView(non-member)", () => getLeagueView(db, actorOf(outsider), leagueId));
  }
  const view = await call("getLeagueView(member)", () => getLeagueView(db, actorOf(member), leagueId));
  must(view.teams.length === 16 && view.myTeam, "league view has 16 teams and my team");
  const cView = await call("getLeagueView(commissioner)", () => getLeagueView(db, actorOf(commish), leagueId));
  must(cView.isCommissioner && !view.isCommissioner, "commissioner flag");
  const team = await call("getTeamView", () => getTeamView(db, actorOf(member), leagueId, view.teams[3].id));
  must(team.team.id === view.teams[3].id, "team view");
  await call("getLeagueInviteInfo", () => getLeagueInviteInfo(db, "not-a-token", now));

  // ---- schedule / standings / scoreboard / matchup pages
  const schedule = await call("getSchedule", () => getSchedule(db, leagueId));
  must(schedule.periods.length === 0 || schedule.periods.length >= 20, "schedule shape");
  if (schedule.periods.length) {
    for (const p of schedule.periods) {
      for (const m of p.matchups) must(m.homeTeamId !== null, "matchup has a home team");
    }
  }
  const standings = await call("getStandings", () => getStandings(db, leagueId));
  must(standings.length === 16, "standings has 16 rows");
  must(new Set(standings.map((r) => r.rank)).size === 16 && standings.every((r, i) => r.rank === i + 1), "standings ranks are 1..16 in order");
  must(standings.every((r) => r.gamesPlayed === r.wins + r.losses + r.ties && Number.isFinite(r.pointsFor)), "standings arithmetic");
  const focus = await call("getFocusPeriod", () => getFocusPeriod(db, leagueId, now));
  await call("getCurrentPeriod", () => getCurrentPeriod(db, leagueId, now));
  if (focus) {
    const myMatchup = await call("getMatchupForTeam", () => getMatchupForTeam(db, focus.id, view.myTeam!.id));
    const board = await call("getPeriodScoreboard", () => getPeriodScoreboard(db, focus.id, now));
    must(board.length === (focus.isPlayoff ? board.length : 8), "scoreboard has one entry per matchup");
    for (const e of board) must(e.totals.home.points === e.matchup.homePoints || e.matchup.status !== "final", "scoreboard totals agree with a final matchup");
    const matchupIds = [myMatchup, board[0]?.matchup].filter((m): m is NonNullable<typeof m> => Boolean(m));
    for (const m of matchupIds) {
      const totals = await call("getMatchupTotals", () => getMatchupTotals(db, m.id, now));
      must(totals.home.teamId === m.homeTeamId, "totals belong to the matchup");
      const box = await call("getMatchupBoxScore(default)", () => getMatchupBoxScore(db, m.id, null, now));
      const boxTotal = await call("getMatchupBoxScore(total)", () => getMatchupBoxScore(db, m.id, "total", now));
      const rostered = view.league.status === "in_season" || view.league.status === "playoffs" || view.league.status === "complete";
      must(!rostered || boxTotal.home.players.length > 0 || m.status === "scheduled", "box score lists players");
      const sumPlayers = boxTotal.home.players.reduce((a, p) => a + p.total, 0) + boxTotal.home.adjustmentTotal;
      must(Math.abs(sumPlayers - boxTotal.home.totals.points) < 0.011, `box score players (${sumPlayers}) add up to the team total (${boxTotal.home.totals.points})`);
      if (boxTotal.away) {
        const sumAway = boxTotal.away.players.reduce((a, p) => a + p.total, 0) + boxTotal.away.adjustmentTotal;
        must(Math.abs(sumAway - boxTotal.away.totals.points) < 0.011, "away box score adds up");
      }
      // Day views partition the period: their points add up to the period total (minus adjustments, which are period-level).
      let dayHome = 0;
      for (const day of boxTotal.days) {
        const dayBox = await call(`getMatchupBoxScore(${day})`, () => getMatchupBoxScore(db, m.id, day, now));
        dayHome += dayBox.home.viewPoints;
      }
      must(Math.abs(dayHome - (boxTotal.home.totals.points - boxTotal.home.adjustmentTotal)) < 0.011, `day views of the box score add up to the period (${dayHome} vs ${boxTotal.home.totals.points - boxTotal.home.adjustmentTotal})`);
      must(box.days.length >= 1 && box.period.startDate <= box.period.endDate, "box score period");
    }
  }

  // ---- draft room
  const draft = await call("getDraftByLeague", () => getDraftByLeague(db, leagueId));
  const draftBoard = await call("getDraftBoard", () => getDraftBoard(db, leagueId, member.userId));
  must(draftBoard.teams.length === 16 && draftBoard.format.maxRoster === 32, "draft board format");
  if (draft) {
    must(draftBoard.draft?.status === draft.status, "board status matches the draft row");
    if (draft.status === "snake") must(draftBoard.draft?.onClock, "snake draft has a team on the clock");
    if (draft.status === "waves") must(draftBoard.draft?.wave && draftBoard.draft.wave.number === draft.currentWave, "wave info on the board");
  }
  const list = await call("listDraftablePlayers", () => listDraftablePlayers(db, leagueId, { now, limit: 50 }));
  must(list.players.length > 0 || draft?.status === "complete", "draftable players");
  await call("listDraftablePlayers(search)", () => listDraftablePlayers(db, leagueId, { now, q: "an", sort: "name" }));
  await call("listDraftablePlayers(team,fpavg)", () => listDraftablePlayers(db, leagueId, { now, sort: "fpavg", dir: "asc", offset: 10 }));
  await call("listDraftablePlayers(proj)", () => listDraftablePlayers(db, leagueId, { now, sort: "proj", season: list.defaultSeason }));
  await call("listFilterOptions", () => listFilterOptions(db));

  // ---- players pages (site-wide and in-league), player card
  const filters = await call("listFilterOptions", () => listFilterOptions(db));
  must(filters.teams.length === 30, "30 NBA teams in the filter");
  const choice = await call("seasonChoiceFor", () => seasonChoiceFor(db, view.league.season, now));
  must(choice.options.length === 2, "two stats seasons on offer");
  const all = await call("listPlayers(global)", () => listPlayers(db, { now }));
  must(all.rows.length > 0, "global players list");
  for (const status of ["fa", "rostered", "all"] as const) {
    const res = await call(`listPlayers(league ${status})`, () => listPlayers(db, { now, league: { id: leagueId, status } }));
    must(res.rows.length > 0 || (status === "rostered" && draft?.status !== "complete" && view.league.status === "setup"), `players ${status} list`);
  }
  for (const sort of SORT_KEYS) await call(`listPlayers(sort ${sort})`, () => listPlayers(db, { now, sort, dir: "desc", league: { id: leagueId, status: "all" }, page: 2 }));
  for (const range of ["7", "15", "30"] as const) await call(`listPlayers(range ${range})`, () => listPlayers(db, { now, range, healthy: true }));
  await call("listPlayers(search+team)", () => listPlayers(db, { now, q: "a", team: filters.teams[0].id, inj: "Out" }));
  await call("listPlayers(previous season)", () => listPlayers(db, { now, season: choice.previous }));
  const sample = all.rows[0] as unknown as { id?: number; playerId?: number };
  const pid = (sample.id ?? sample.playerId)!;
  const card = await call("getPlayerCard", () => getPlayerCard(db, pid, now));
  must(card, "player card");
  await call("getPlayerCard(season)", () => getPlayerCard(db, pid, now, { logSeason: choice.previous }));
  must((await getPlayerCard(db, 1, now)) === null, "unknown player id has no card");

  // ---- my team page, free agency, trades pages
  const myTeamId = view.myTeam!.id;
  for (const range of TEAM_RANGES) {
    const roster = await call(`loadTeamRoster(${range})`, () => loadTeamRoster(db, { leagueId, teamId: myTeamId, range, now }));
    const rows = roster.groups.flatMap((g) => g.rows);
    must(roster.count === rows.length, "roster count equals the rows");
    if (range === "season" && rows.length && view.league.season === 2027 && view.league.status !== "setup" && view.league.status !== "drafting") {
      // The page's team total is everything the team earned this season, dropped players included: it must equal the oracle.
      const data = await loadOracleData(db, leagueId, "2026-10-01", etDateString(now));
      const mine = oracleTeamTotal(data, myTeamId).points;
      must(Math.abs(mine - roster.totals.total) < 0.011, `roster page total (${roster.totals.total}) equals the independent oracle (${mine})`);
      must(roster.totals.statPoints + roster.totals.winBonus === roster.totals.total, "roster page total = stat points + win bonus");
    }
  }
  await call("loadTeamRoster(previous season)", () => loadTeamRoster(db, { leagueId, teamId: myTeamId, now, season: choice.previous }));
  const adds = await call("getAddsToday", () => getAddsToday(db, myTeamId, 2, now));
  must(adds.limit === 2 && adds.used >= 0 && adds.used <= 2, "adds today");
  const max = await call("leagueMaxRoster", () => leagueMaxRoster(db, view.league));
  must(max === 32, "max roster 32");
  const trades = await call("listLeagueTrades", () => listLeagueTrades(db, leagueId, { excludeReversals: true }));
  await call("listLeagueTrades(open)", () => listLeagueTrades(db, leagueId, { statuses: ["proposed", "pending_review"] }));
  await call("listLeagueTrades(team)", () => listLeagueTrades(db, leagueId, { teamId: myTeamId }));
  for (const t of trades.slice(0, 4)) {
    const detail = await call("getTrade", () => getTrade(db, leagueId, t.id, member.userId, now));
    must(detail && detail.players.length > 0, "trade detail lists players");
  }
  await call("countReceivedOffers", () => countReceivedOffers(db, leagueId, myTeamId));
  await call("listRosterForTrade", () => listRosterForTrade(db, view.league, myTeamId, now));
  await call("listTradeBlock", () => listTradeBlock(db, view.league, {}, now));
  await call("seasonChoiceFor(trades)", () => seasonChoiceFor(db, view.league.season, now));

  // ---- transactions / activity / commissioner pages
  const txns = await call("listTransactions", () => listTransactions(db, leagueId, { limit: 50 }));
  const units = new Set(txns.rows.map((r) => (r.type === "trade" ? r.groupId : r.id)));
  must(units.size <= 50 && units.size <= txns.total, "transactions page paginates feed entries (a trade is one entry)");
  await call("listTransactions(filtered)", () => listTransactions(db, leagueId, { type: "add", teamId: myTeamId, limit: 20, offset: 0 }));
  await call("listTransactions(auto_drop)", () => listTransactions(db, leagueId, { type: "auto_drop", limit: 50 }));
  const act = await call("listActivity", () => listActivity(db, leagueId, { limit: 50 }));
  must(name.startsWith("next-season") || act.entries.length > 0, "activity feed has entries");
  for (const filter of ACTIVITY_FILTERS) await call(`listActivity(${filter})`, () => listActivity(db, leagueId, { filter, limit: 20 }));
  await call("listLeagueAdjustments", () => listLeagueAdjustments(db, leagueId, 15));
  const invites = await call("listLeagueInvites(commissioner)", () => listLeagueInvites(db, actorOf(commish), leagueId, now));
  must(name.startsWith("next-season") || invites.length >= 1, "invite links listed (a rolled-over league starts with none)");
  await denied("listLeagueInvites(member)", () => listLeagueInvites(db, actorOf(member), leagueId, now));

  // ---- chat
  const page = await call("listMessages", () => listMessages(db, { id: member.userId }, leagueId, {}, now));
  must((name.startsWith("next-season") || page.messages.length > 0) && page.members.length === 16, "chat page (a rolled-over league starts with an empty chat)");
  await call("listPinned", () => listPinned(db, { id: member.userId }, leagueId, now));
  await call("latestAnnouncement", () => latestAnnouncement(db, leagueId));
  const unreadChat = await call("chatUnreadCount", () => chatUnreadCount(db, member.userId, leagueId));
  must(unreadChat >= 0, "chat unread");
  if (outsider) await denied("listMessages(non-member)", () => listMessages(db, { id: outsider.userId }, leagueId, {}, now));

  // ---- paging never skips or repeats an item
  const seenPlayers = new Set<number>();
  const first = await call("listPlayers(page 1)", () => listPlayers(db, { now, sort: "name", dir: "asc" }));
  for (let pg = 1; pg <= first.pageCount; pg++) {
    const res = await call(`listPlayers(page ${pg})`, () => listPlayers(db, { now, sort: "name", dir: "asc", page: pg }));
    for (const r of res.rows) seenPlayers.add(r.id);
  }
  must(seenPlayers.size === first.total, `player pages cover every player exactly once (${seenPlayers.size} of ${first.total})`);
  const seenTxn = new Set<string>();
  for (let off = 0; off < 2000; off += 50) {
    const res = await call(`listTransactions(offset ${off})`, () => listTransactions(db, leagueId, { limit: 50, offset: off }));
    if (res.rows.length === 0) break;
    for (const r of res.rows) seenTxn.add(r.type === "trade" ? String(r.groupId) : r.id);
  }
  must(seenTxn.size === txns.total, `transaction pages cover every feed entry once (${seenTxn.size} of ${txns.total})`);
  const seenAct = new Set<string>();
  for (let off = 0; off < 5000; off += 50) {
    const res = await call(`listActivity(offset ${off})`, () => listActivity(db, leagueId, { limit: 50, offset: off }));
    if (res.entries.length === 0) break;
    for (const e of res.entries) seenAct.add(e.id);
  }
  must(seenAct.size === act.total, `activity pages cover every entry once (${seenAct.size} of ${act.total})`);
  const seenChat = new Set<string>();
  let chatPage = await call("listMessages(newest)", () => listMessages(db, { id: member.userId }, leagueId, { limit: 20 }, now));
  for (let guard = 0; guard < 100; guard++) {
    for (const msg of chatPage.messages) {
      must(!seenChat.has(msg.id), "chat message repeated across pages");
      seenChat.add(msg.id);
    }
    if (!chatPage.hasMore) break;
    const oldest = chatPage.messages[0];
    chatPage = await call("listMessages(older)", () => listMessages(db, { id: member.userId }, leagueId, { limit: 20, before: { createdAt: new Date(oldest.createdAt), id: oldest.id } }, now));
  }
  const chatRows = await db.select({ id: messagesTable.id }).from(messagesTable).where(eq(messagesTable.leagueId, leagueId));
  must(seenChat.size === chatRows.length, `chat pages cover every message once (${seenChat.size} of ${chatRows.length})`);

  // ---- notifications
  const notes = await call("listNotifications", () => listNotifications(db, member.userId, 50));
  const unread = await call("unreadCount", () => unreadCount(db, member.userId));
  must(notes.length > 0 && unread <= (await db.select().from(notifications).where(eq(notifications.userId, member.userId))).length, "notifications");
  const prefs = await call("getPrefs", () => getPrefs(db, member.userId));
  must(prefs.chat_messages.inApp === false || prefs.chat_messages.inApp === true, "prefs");
  await call("countSubscriptions", () => countSubscriptions(db, member.userId));

  // ---- playoffs / history / keepers
  const bracket = await call("getBracket", () => getBracket(db, leagueId, now));
  if (view.league.status === "playoffs" || view.league.status === "complete") {
    must(bracket.seeded && bracket.rounds.length === 3 && bracket.rounds[0].slots.length === 4, "bracket shape");
    if (view.league.status === "complete") must(bracket.champion, "complete league has a champion");
  } else await call("previewSeeds", () => previewSeeds(db, leagueId, view.settings.playoffTeams));
  const history = await call("getLeagueHistory", () => getLeagueHistory(db, leagueId));
  must(history.length >= 1, "history");
  if (view.league.status === "complete") must(history[0].champion && history[0].results.length === 16, "history shows the finished season");
  await call("getOwnerPastSeasons", () => getOwnerPastSeasons(db, leagueId, view.myTeam!.ownerId));
  await call("getNextSeasonId", () => getNextSeasonId(db, leagueId));
  const keepers = await call("getKeeperView(member)", () => getKeeperView(db, actorOf(member), leagueId, now));
  must(keepers.teams.length <= 1, "an owner sees only his own keepers");
  const keepersC = await call("getKeeperView(commissioner)", () => getKeeperView(db, actorOf(commish), leagueId, now));
  must(keepersC.teams.length === 16, "the commissioner sees every team's keepers");

  // ---- NBA scoreboards (site-wide and in-league): the games of a day, and neighbouring days
  for (const day of [etDateString(now), addDays(etDateString(now), -1), addDays(etDateString(now), 1)]) {
    const { start, end } = etDayRange(day);
    const games = await call(`nba scoreboard ${day}`, () => db.select().from(nbaGames).where(and(gte(nbaGames.startTime, start), lt(nbaGames.startTime, end))).orderBy(asc(nbaGames.startTime)));
    must(games.every((g) => g.homeTeamId !== g.awayTeamId), "scoreboard rows");
  }

  // ---- the per-user parts of the pages, for three more members (first, middle, last team)
  for (const other of [members[0], members[Math.floor(members.length / 2)], members[members.length - 1]]) {
    if (!other || other.userId === member.userId) continue;
    const v = await call(`getLeagueView(${other.username})`, () => getLeagueView(db, actorOf(other), leagueId));
    must(v.myTeam && v.myTeam.ownerId === other.userId, "each member sees his own team");
    await call(`getDraftBoard(${other.username})`, () => getDraftBoard(db, leagueId, other.userId));
    await call(`getKeeperView(${other.username})`, () => getKeeperView(db, actorOf(other), leagueId, now));
    await call(`loadTeamRoster(${other.username})`, () => loadTeamRoster(db, { leagueId, teamId: v.myTeam!.id, now }));
    await call(`getAddsToday(${other.username})`, () => getAddsToday(db, v.myTeam!.id, 2, now));
    await call(`listRosterForTrade(${other.username})`, () => listRosterForTrade(db, v.league, v.myTeam!.id, now));
    await call(`chatUnreadCount(${other.username})`, () => chatUnreadCount(db, other.userId, leagueId));
    await call(`listNotifications(${other.username})`, () => listNotifications(db, other.userId, 50));
    const f = await call("getFocusPeriod", () => getFocusPeriod(db, leagueId, now));
    const mm = f ? await call("getMatchupForTeam", () => getMatchupForTeam(db, f.id, v.myTeam!.id)) : null;
    if (mm) await call(`getMatchupBoxScore(${other.username})`, () => getMatchupBoxScore(db, mm.id, null, now));
    await call(`getOwnerPastSeasons(${other.username})`, () => getOwnerPastSeasons(db, leagueId, other.userId));
  }

  // ---- admin page counts
  await call("admin users", () => db.select({ id: users.id, name: users.username }).from(users));
  return out;
}
