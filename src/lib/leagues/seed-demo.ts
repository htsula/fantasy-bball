/**
 * Dev-only demo data: a 10-team league mid-season, so `npm run dev` shows a full app. Never call against
 * production (src/db/seed.ts refuses real Postgres).
 *
 * What it builds (all relative to `now`, so the "current week" is always live):
 *  - NBA data: the 30 teams (from the ESPN fixtures, or synthetic ones when none are loaded), ~270 invented
 *    players, last season's games with box scores and this season's games up to today (a few in progress, the
 *    rest of the week scheduled). Players are invented, not real.
 *  - "Demo League": 10 teams (admin + demo1..demo9, password "password123"), settings, schedule, a completed
 *    snake + waves draft (backdated to before opening week), a few trades (done, rejected, pending), free-agent
 *    moves, a trade-block entry, chat messages with a pinned announcement, finalized weeks and standings.
 */
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { leagues, nbaGames, nbaPlayers, nbaTeams, playerGameStats, gameRosterSnapshots, rosterEntries, teams } from "@/db/schema";
import type { Db } from "@/db/types";
import { findUserByUsername } from "@/lib/auth/service";
import { DraftError, getDraftByLeague, makePick, startDraft } from "@/lib/draft/service";
import { snakeTeam } from "@/lib/draft/engine";
import { postAnnouncement, postMessage, setPinned } from "@/lib/chat/service";
import { runNightlyMatchupJob } from "@/lib/matchups/service";
import { addDays, etDateString, etStartOfDay, etWeekRange } from "@/lib/nba/dates";
import { addFreeAgent } from "@/lib/rosters/service";
import { acceptTrade, addToTradeBlock, proposeTrade, rejectTrade } from "@/lib/trades/service";
import { createLeague, createLeagueInvite, generateSchedule, joinLeague, redeemLeagueInvite, updateSettings } from "./service";

export const DEMO_LEAGUE_NAME = "Demo League";
export const DEMO_PASSWORD = "password123";
const SEASON = 2027;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ------------------------------------------------------------------------------------ helpers

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function insertChunks<T>(rows: T[], size: number, insert: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await insert(rows.slice(i, i + size));
}

const FIRST = ["Marcus", "Devin", "Jalen", "Tyrese", "Malik", "Andre", "Isaiah", "Cole", "Darius", "Elijah", "Gabe", "Hakeem", "Jordan", "Kendall", "Luca", "Miles", "Noah", "Omar", "Peyton", "Quincy", "Rashad", "Shai", "Terrence", "Uri", "Victor", "Wesley", "Xavier", "Yusuf", "Zion", "Caleb"];
const LAST = ["Alvarez", "Bennett", "Carver", "Dalton", "Ellison", "Foster", "Grady", "Holloway", "Ingram", "Jefferson", "Kincaid", "Lawson", "Monroe", "Newton", "Okafor", "Pruitt", "Quarles", "Rhodes", "Sampson", "Tatum-Reyes", "Underwood", "Vance", "Whitfield", "Yates", "Zimmer", "Abbott", "Briggs", "Coleman", "Duval", "Everett", "Fontaine", "Gilmore", "Hayes", "Iverson-Cole", "Jovanovic", "Kowalski", "Lindqvist", "Mbeki", "Nakamura", "Ortega"];
const POSITIONS = [["PG"], ["SG"], ["SF"], ["PF"], ["C"], ["PG", "SG"], ["SG", "SF"], ["SF", "PF"], ["PF", "C"]];
const MINUTES_BY_DEPTH = [34, 32, 30, 28, 24, 20, 16, 10, 6];

type DemoPlayer = { id: number; name: string; teamId: number; q: number; injured: boolean };

function line(q: number, minutes: number, rand: () => number) {
  const f = () => 0.6 + rand() * 0.8;
  const pts = Math.round(q * 0.36 * f());
  const reb = Math.round(q * 0.16 * f());
  const ast = Math.round(q * 0.1 * f());
  const fga = Math.max(2, Math.round(pts / 2.1));
  const fgm = Math.min(fga, Math.round(pts / 2.4));
  const fta = Math.round(pts / 8);
  return {
    minutes,
    pts,
    reb,
    oreb: Math.round(reb * 0.25),
    dreb: reb - Math.round(reb * 0.25),
    ast,
    stl: rand() < q / 60 ? 1 + (rand() < 0.2 ? 1 : 0) : 0,
    blk: rand() < q / 80 ? 1 + (rand() < 0.2 ? 1 : 0) : 0,
    to: Math.round(rand() * 3),
    pf: Math.round(rand() * 4),
    fgm,
    fga,
    ftm: Math.min(fta, Math.round(fta * 0.8)),
    fta,
    tpm: Math.round(pts / 9),
    tpa: Math.round(pts / 5),
  };
}

// ------------------------------------------------------------------------------------ NBA data

async function seedDemoNba(db: Db, now: Date, seasonStart: string) {
  const rand = rng(2027);
  let teamRows = await db.select({ id: nbaTeams.id }).from(nbaTeams).orderBy(nbaTeams.id);
  if (teamRows.length < 12) {
    const synth = Array.from({ length: 30 }, (_, i) => ({ id: 9_300_001 + i, abbrev: `D${String(i + 1).padStart(2, "0")}`, name: `Demo ${i + 1}`, location: "Demo City" }));
    await db.insert(nbaTeams).values(synth).onConflictDoNothing();
    teamRows = synth.map((t) => ({ id: t.id }));
  }
  const teamIds = teamRows.map((t) => t.id).slice(0, 30);

  // Players: quality (average fantasy points per game) falls from ~52 to ~9, spread across teams.
  const total = teamIds.length * 9;
  const used = new Set<string>();
  const players: DemoPlayer[] = [];
  const order = [...Array(total).keys()].sort(() => rand() - 0.5);
  for (let i = 0; i < total; i++) {
    let name = "";
    for (let k = 0; ; k++) {
      name = `${FIRST[(i * 7 + k) % FIRST.length]} ${LAST[(i * 3 + Math.floor(i / FIRST.length) + k) % LAST.length]}`;
      if (!used.has(name)) break;
    }
    used.add(name);
    const rank = i;
    players.push({
      id: 9_500_001 + i,
      name,
      teamId: teamIds[order[i] % teamIds.length],
      q: Math.round((52 - rank * (43 / total)) * 10) / 10,
      injured: i % 29 === 7,
    });
  }
  // Balanced rosters: re-deal teams round-robin by rank within a shuffled order.
  players.forEach((p, i) => (p.teamId = teamIds[i % teamIds.length]));

  await db.insert(nbaPlayers).values(
    players.map((p, i) => ({
      id: p.id,
      fullName: p.name,
      firstName: p.name.split(" ")[0],
      lastName: p.name.split(" ").slice(1).join(" "),
      teamId: p.teamId,
      positions: POSITIONS[i % POSITIONS.length],
      active: true,
      injuryStatus: p.injured ? (i % 2 === 0 ? "Out" : "Day-To-Day") : null,
      injuryDetail: p.injured ? (i % 2 === 0 ? "Ankle" : "Knee soreness") : null,
      age: 20 + (i % 15),
    })),
  ).onConflictDoNothing();

  const byTeam = new Map<number, DemoPlayer[]>();
  for (const p of players) byTeam.set(p.teamId, [...(byTeam.get(p.teamId) ?? []), p]);
  for (const list of byTeam.values()) list.sort((a, b) => b.q - a.q);

  let gameId = 9_600_000;
  const games: (typeof nbaGames.$inferInsert)[] = [];
  const stats: (typeof playerGameStats.$inferInsert)[] = [];
  const snaps: (typeof gameRosterSnapshots.$inferInsert)[] = [];

  const play = (season: number, start: Date, home: number, away: number, status: "final" | "in" | "scheduled") => {
    const id = ++gameId;
    const hs = 92 + Math.floor(rand() * 40);
    const as = 92 + Math.floor(rand() * 40);
    const hasScore = status !== "scheduled";
    games.push({
      id,
      season,
      seasonType: 2,
      startTime: start,
      homeTeamId: home,
      awayTeamId: away,
      homeScore: hasScore ? hs : null,
      awayScore: hasScore ? (hs === as ? as + 1 : as) : null,
      status,
      period: status === "in" ? 3 : null,
      clock: status === "in" ? "6:42" : null,
      statusDetail: status === "final" ? "Final" : status === "in" ? "3rd Quarter" : null,
      finishedAt: status === "final" ? new Date(start.getTime() + 2.5 * HOUR) : null,
      statsFinal: status === "final",
    });
    if (status === "scheduled") return;
    for (const tid of [home, away]) {
      (byTeam.get(tid) ?? []).forEach((p, depth) => {
        snaps.push({ gameId: id, playerId: p.id, nbaTeamId: tid, injuryStatus: p.injured ? "Out" : null, late: false, capturedAt: start });
        if (p.injured && p.q > 0 && depth % 2 === 0) return; // an Out player does not play
        const scale = status === "in" ? 0.6 : 1;
        const minutes = Math.round((MINUTES_BY_DEPTH[Math.min(depth, 8)] + rand() * 4) * scale);
        stats.push({ gameId: id, playerId: p.id, teamId: tid, ...line(p.q * scale, minutes, rand) });
      });
    }
  };

  // Last season: a game day every other day, 10 teams... all 30 teams paired each day (15 games).
  const lastStart = "2026-01-04";
  for (let k = 0; k < 28; k++) {
    const day = etStartOfDay(addDays(lastStart, k * 2));
    const shuffled = [...teamIds].sort(() => rand() - 0.5);
    for (let g = 0; g + 1 < shuffled.length; g += 2) play(SEASON - 1, new Date(day.getTime() + 19 * HOUR + (g % 3) * 0.5 * HOUR), shuffled[g], shuffled[g + 1], "final");
  }

  // This season: every day from opening day to a week from now; 10 games a day.
  const today = etDateString(now);
  for (let d = seasonStart; d <= addDays(today, 7); d = addDays(d, 1)) {
    const day = etStartOfDay(d);
    const shuffled = [...teamIds].sort(() => rand() - 0.5).slice(0, 20);
    for (let g = 0; g + 1 < shuffled.length; g += 2) {
      let start = new Date(day.getTime() + 19 * HOUR + (g % 4) * 0.5 * HOUR);
      let status: "final" | "in" | "scheduled" = d < today ? "final" : "scheduled";
      if (d === today) {
        // Today's slate is spread around "now": some finished, some in progress, some still to come.
        const slot = g / 2; // 0..9
        start = new Date(now.getTime() + (slot - 3.5) * 0.9 * HOUR);
        status = start.getTime() < now.getTime() - 3 * HOUR ? "final" : start.getTime() < now.getTime() ? "in" : "scheduled";
      }
      play(SEASON, start, shuffled[g], shuffled[g + 1], status);
    }
  }

  await insertChunks(games, 200, (c) => db.insert(nbaGames).values(c).onConflictDoNothing());
  await insertChunks(snaps, 1000, (c) => db.insert(gameRosterSnapshots).values(c).onConflictDoNothing());
  await insertChunks(stats, 400, (c) => db.insert(playerGameStats).values(c).onConflictDoNothing());
  return players;
}

// ------------------------------------------------------------------------------------ league

const MEMBERS = [
  ["demo1", "Hardwood Heroes", "HWH"],
  ["demo2", "Splash Brothers", "SPL"],
  ["demo3", "Glass Cleaners", "GLC"],
  ["demo4", "Fast Break Club", "FBC"],
  ["demo5", "Triple Doubles", "TRD"],
  ["demo6", "Pick and Rollers", "PNR"],
  ["demo7", "Buzzer Beaters", "BZZ"],
  ["demo8", "Paint Patrol", "PNT"],
  ["demo9", "Corner Threes", "CRT"],
] as const;

/**
 * Auto-drafts a started draft by rating (commissioner picks for everyone). `maxPicks` stops it part-way so the
 * league is left mid-draft (snake or waves). Picks are timestamped one minute apart from `from`.
 */
async function autoDraft(db: Db, leagueId: string, adminId: string, available: number[], rand: () => number, from: Date, maxPicks = Infinity) {
  let minute = 0;
  let made = 0;
  const pickFor = async (draftId: string, teamId: string) => {
    for (let attempt = 0; attempt < 5 && made < maxPicks; attempt++) {
      const idx = Math.min(Math.floor(rand() * rand() * 4), available.length - 1);
      try {
        await makePick(db, draftId, teamId, available[idx], adminId, { asCommissioner: true, now: new Date(from.getTime() + ++minute * 60_000) });
        available.splice(idx, 1);
        made++;
        return;
      } catch (err) {
        if (err instanceof DraftError && (err.code === "no_wave_quota" || err.code === "not_your_turn")) return;
        if (err instanceof DraftError && (err.code === "player_taken" || err.code === "player_unavailable")) {
          available.splice(idx, 1);
          continue;
        }
        throw err;
      }
    }
  };
  for (let guard = 0; guard < 400 && made < maxPicks; guard++) {
    const d = await getDraftByLeague(db, leagueId);
    if (!d || d.status === "complete") return;
    if (d.status === "snake") await pickFor(d.id, snakeTeam(d.order, d.currentPick));
    else for (const teamId of d.order) await pickFor(d.id, teamId);
  }
}

/** Three small leagues left at different draft stages (pre-draft, mid-snake, mid-wave) for the draft room UI. */
async function seedDraftStages(db: Db, actor: { id: string; isSiteAdmin: boolean }, players: DemoPlayer[], now: Date, rand: () => number) {
  const monday = etWeekRange(now).startDate;
  const stages = [
    { name: "Draft Night: Not Started", picks: null },
    { name: "Draft Night: Snake", picks: 8 },
    { name: "Draft Night: Waves", picks: 15 },
  ] as const;
  for (const stage of stages) {
    const league = await createLeague(db, actor, { name: stage.name, season: SEASON, teamName: "Admin All-Stars", teamAbbrev: "ADM" });
    for (const [username, teamName, teamAbbrev] of MEMBERS.slice(0, 5)) {
      const { token } = await createLeagueInvite(db, actor, league.id);
      const user = await findUserByUsername(db, username); // created with the main league
      await joinLeague(db, { id: user!.id, isSiteAdmin: false }, { token, teamName, teamAbbrev });
    }
    await updateSettings(db, actor, league.id, {
      regularSeasonStart: addDays(monday, 7),
      regularSeasonEnd: addDays(monday, 7 * 9 - 1),
      rosterPool: 36,
      rosterCap: 6,
      snakeTarget: 12,
      waveSize: 2,
      playoffTeams: 2,
    });
    await generateSchedule(db, actor, league.id, { seed: stage.name });
    if (stage.picks === null) continue;
    await startDraft(db, league.id, actor.id, { now, random: (n) => Math.floor(rand() * n) });
    await autoDraft(db, league.id, actor.id, [...players].sort((a, b) => b.q - a.q).map((p) => p.id), rand, new Date(now.getTime() - 60 * 60_000), stage.picks);
  }
}

export async function seedDemoLeague(db: Db, now: Date = new Date()) {
  const [existing] = await db.select().from(leagues).where(eq(leagues.name, DEMO_LEAGUE_NAME));
  if (existing) return { created: false as const, leagueId: existing.id };
  const admin = await findUserByUsername(db, "admin");
  if (!admin) throw new Error('Seed the "admin" user first');
  const actor = { id: admin.id, isSiteAdmin: admin.isSiteAdmin };

  // Season window: opening day was four Mondays ago; eight more weeks of regular season, then 2 playoff rounds.
  const monday = etWeekRange(now).startDate;
  const seasonStart = addDays(monday, -28);
  const seasonEnd = addDays(monday, 7 * 8 - 1);
  const players = await seedDemoNba(db, now, seasonStart);
  const rand = rng(7);

  const league = await createLeague(db, actor, { name: DEMO_LEAGUE_NAME, season: SEASON, teamName: "Admin All-Stars", teamAbbrev: "ADM" });
  for (const [username, teamName, teamAbbrev] of MEMBERS) {
    const { token } = await createLeagueInvite(db, actor, league.id);
    await redeemLeagueInvite(db, { token, username, password: DEMO_PASSWORD, teamName, teamAbbrev });
  }
  await updateSettings(db, actor, league.id, {
    regularSeasonStart: seasonStart,
    regularSeasonEnd: seasonEnd,
    rosterPool: 100,
    rosterCap: 10,
    snakeTarget: 60,
    waveSize: 2,
    playoffTeams: 4,
    playoffRoundLength: 1,
    tradeReview: "none",
  });
  await generateSchedule(db, actor, league.id, { seed: "demo" });

  // ---- Draft (backdated to the day before opening day): snake rounds, then waves, picked by rating.
  const draftTime = new Date(etStartOfDay(seasonStart).getTime() - 6 * HOUR);
  await startDraft(db, league.id, admin.id, { now: draftTime, random: (n) => Math.floor(rand() * n) });
  const available = [...players].sort((a, b) => b.q - a.q).map((p) => p.id);
  await autoDraft(db, league.id, admin.id, available, rand, draftTime);

  // ---- Trades, moves, chat (all at times in the past, after the draft).
  const teamRows = await db.select().from(teams).where(eq(teams.leagueId, league.id));
  const team = (abbrev: string) => teamRows.find((t) => t.abbrev === abbrev)!;
  const roster = async (teamId: string) =>
    (await db.select({ id: rosterEntries.playerId }).from(rosterEntries).where(and(eq(rosterEntries.teamId, teamId), isNull(rosterEntries.releasedAt))).orderBy(rosterEntries.playerId)).map((r) => r.id);
  const swap = async (a: string, b: string, n: number, at: Date, outcome: "accept" | "reject" | "pending") => {
    const [ra, rb] = [await roster(team(a).id), await roster(team(b).id)];
    const trade = await proposeTrade(
      db,
      { leagueId: league.id, proposerTeamId: team(a).id, receiverTeamId: team(b).id, give: ra.slice(-n), get: rb.slice(-n), message: outcome === "pending" ? "Fair swap? I need depth." : null, actorUserId: team(a).ownerId },
      { now: at },
    );
    const later = new Date(at.getTime() + 3 * HOUR);
    if (outcome === "accept") await acceptTrade(db, { tradeId: trade.id, actorUserId: team(b).ownerId }, { now: later });
    if (outcome === "reject") await rejectTrade(db, { tradeId: trade.id, actorUserId: team(b).ownerId }, { now: later });
  };
  await swap("HWH", "SPL", 1, new Date(now.getTime() - 12 * DAY), "accept");
  await swap("GLC", "ADM", 2, new Date(now.getTime() - 9 * DAY), "accept");
  await swap("FBC", "TRD", 1, new Date(now.getTime() - 6 * DAY), "reject");
  await swap("PNR", "ADM", 1, new Date(now.getTime() - 1 * DAY), "pending");

  const rosteredNow = (await db.select({ id: rosterEntries.playerId }).from(rosterEntries).where(and(eq(rosterEntries.leagueId, league.id), isNull(rosterEntries.releasedAt)))).map((r) => r.id);
  const freeAgents = (await db.select({ id: nbaPlayers.id }).from(nbaPlayers).where(and(eq(nbaPlayers.active, true), notInArray(nbaPlayers.id, rosteredNow), inArray(nbaPlayers.id, players.map((p) => p.id)))).orderBy(nbaPlayers.id)).map((r) => r.id);
  const moves: [string, number][] = [["BZZ", 20], ["PNT", 17], ["CRT", 14], ["HWH", 11], ["TRD", 8], ["SPL", 3]];
  for (const [i, [abbrev, daysAgo]] of moves.entries()) {
    const t = team(abbrev);
    const drop = (await roster(t.id)).slice(-1)[0];
    await addFreeAgent(db, { leagueId: league.id, teamId: t.id, playerId: freeAgents[i], dropPlayerId: drop, actorUserId: t.ownerId }, { now: new Date(now.getTime() - daysAgo * DAY) });
  }
  const mine = team("ADM");
  const blockPlayer = (await roster(mine.id))[0];
  await addToTradeBlock(db, { leagueId: league.id, teamId: mine.id, playerId: blockPlayer, note: "Open to offers for a big", actorUserId: admin.id });
  const hw = team("HWH");
  await addToTradeBlock(db, { leagueId: league.id, teamId: hw.id, playerId: (await roster(hw.id))[1], note: null, actorUserId: hw.ownerId });

  const say = async (username: string, body: string, minutesAgo: number) => {
    const u = username === "admin" ? admin : await findUserByUsername(db, username);
    return postMessage(db, { id: u!.id }, league.id, { body }, { now: new Date(now.getTime() - minutesAgo * 60_000), notify: async () => undefined });
  };
  const ann = await postAnnouncement(db, actor, league.id, "Welcome to the league! Trade deadline is end of next month. Good luck everyone.", {
    now: new Date(now.getTime() - 5 * DAY),
    notify: async () => undefined,
  });
  await setPinned(db, actor, ann.id, true, { now: new Date(now.getTime() - 5 * DAY) });
  await say("demo1", "Who wants to trade a big man? I have guards to spare.", 3000);
  await say("demo2", "@demo1 check the trade block, I put someone up.", 2900);
  await say("demo3", "That waiver add last week paid off big time", 1500);
  await say("demo4", "Anyone else's star on the injury report tonight?", 600);
  await say("admin", "Reminder: add/drop is limited to 2 per day.", 300);
  await say("demo5", "Beating the commish this week, sorry not sorry", 90);
  await say("demo6", "@admin I sent you an offer, take a look", 45);

  await seedDraftStages(db, actor, players, now, rand);

  // ---- Back to the commissioner's review mode, then finalize the finished weeks and build standings.
  await updateSettings(db, actor, league.id, { tradeReview: "commissioner" });
  await runNightlyMatchupJob(db, now, { notify: async () => undefined });
  return { created: true as const, leagueId: league.id };
}
