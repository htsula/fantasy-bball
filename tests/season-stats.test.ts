import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nbaGames, nbaPlayers, playerGameStats } from "@/db/schema";
import type { Db } from "@/db/types";
import { DEFAULT_SCORING } from "@/lib/fantasy/settings";
import { DEFAULT_DRAFT_SORT, listDraftablePlayers } from "@/lib/draft/board";
import { loadLastSeasonFp } from "@/lib/fantasy/last-season";
import { calendarSeason, currentSeason, loadSeasonFantasy, previousSeason, resolveSeason } from "@/lib/fantasy/stats-query";
import { getPlayerCard, listPlayers } from "@/lib/nba/players-query";
import { parsePlayerParams } from "@/lib/nba/player-params";
import { updateSettings } from "@/lib/leagues/service";
import { createAdmin, setupLeague } from "./helpers/draft";
import { createTestDb } from "./helpers/db";

// Mid-October 2026: 2027 (2026-27) is the upcoming season and has no regular-season games yet.
const NOW = new Date("2026-10-14T15:00:00Z");

let db: Db;
let close: () => Promise<void>;

type Line = Partial<typeof playerGameStats.$inferInsert>;
async function game(id: number, season: number, iso: string, home: number, away: number, score: [number, number] | null, status: "final" | "scheduled" = "final") {
  await db.insert(nbaGames).values({
    id, season, seasonType: 2, startTime: new Date(iso), homeTeamId: home, awayTeamId: away,
    homeScore: score?.[0] ?? null, awayScore: score?.[1] ?? null, status,
  });
}
const box = (gameId: number, playerId: number, teamId: number, line: Line = {}) =>
  db.insert(playerGameStats).values({ gameId, playerId, teamId, minutes: 30, ...line });

// Last season (2026): g1 team 1 beats team 2, g2 team 2 beats team 1.
//   A (id 101, team 1): g1 20 pts + 10 reb = 30 (+4 win), g2 10 pts = 10 (loss) -> 44 total, 22/G
//   B (id 102, team 1): g1 DNP coach's decision in a win (+4), g2 DNP injury in a loss -> 4 total, 1 game scored in
//   C (id 103, team 2): g1 30 pts (loss), g2 5 pts (+4 win) -> 39 total, 19.5/G
//   D (id 104, team 2): g1 25 pts (loss) -> 25
//   E (id 105, team 1): g1 35 pts (+4 win) -> 39 total (ties C; projection breaks the tie: 37 vs 19.5)
//   F (id 106, team 3): no games
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const p = (id: number, name: string, teamId: number) => ({ id, fullName: name, teamId, positions: ["PG"], active: true });
  await db.insert(nbaPlayers).values([
    p(101, "Alpha A", 1), p(102, "Bravo B", 1), p(103, "Charlie C", 2), p(104, "Delta D", 2), p(105, "Echo E", 1), p(106, "Foxtrot F", 3),
  ]);
  await game(9001, 2026, "2026-01-05T00:00:00Z", 1, 2, [110, 100]);
  await game(9002, 2026, "2026-01-07T00:00:00Z", 2, 1, [105, 95]);
  await box(9001, 101, 1, { pts: 20, reb: 10 });
  await box(9002, 101, 1, { pts: 10 });
  await box(9001, 102, 1, { dnp: true, minutes: null, dnpReason: "COACH'S DECISION" });
  await box(9002, 102, 1, { dnp: true, minutes: null, dnpReason: "Left knee injury" });
  await box(9001, 103, 2, { pts: 30 });
  await box(9002, 103, 2, { pts: 5 });
  await box(9001, 104, 2, { pts: 25 });
  await box(9001, 105, 1, { pts: 35 });
  // An older season (2025) for the by-season table, a playoff game that must not count.
  await game(9003, 2025, "2025-01-05T00:00:00Z", 1, 2, [100, 90]);
  await box(9003, 101, 1, { pts: 7 });
  await db.insert(nbaGames).values({
    id: 9004, season: 2026, seasonType: 3, startTime: new Date("2026-05-01T00:00:00Z"), homeTeamId: 1, awayTeamId: 2,
    homeScore: 100, awayScore: 90, status: "final",
  });
  await box(9004, 101, 1, { pts: 99 });
  // Upcoming 2027 schedule (no final games).
  await game(9100, 2027, "2026-10-21T23:00:00Z", 1, 2, null, "scheduled");
});
afterAll(() => close());

describe("season helpers", () => {
  it("derives the current and previous season", async () => {
    expect(calendarSeason(new Date("2026-10-14T00:00:00Z"))).toBe(2027);
    expect(calendarSeason(new Date("2026-03-01T00:00:00Z"))).toBe(2026);
    expect(await currentSeason(db, NOW)).toBe(2027);
    expect(previousSeason(2027)).toBe(2026);
  });

  it("preseason: previous season is the default and the only option with data", async () => {
    const c = await resolveSeason(db, NOW);
    expect(c).toMatchObject({ current: 2027, previous: 2026, options: [2026], default: 2026, selected: 2026 });
    // The current season has no data, so asking for it falls back to the default.
    expect((await resolveSeason(db, NOW, 2027)).selected).toBe(2026);
    // Seasons other than current/previous are not offered.
    expect((await resolveSeason(db, NOW, 2025)).selected).toBe(2026);
  });
});

describe("loadSeasonFantasy", () => {
  const byPlayer = async (opts: Parameters<typeof loadSeasonFantasy>[1] = {}) =>
    new Map((await loadSeasonFantasy(db, { seasons: [2026], ...opts })).map((r) => [r.playerId, r]));

  it("totals fantasy points with the approximated win bonus (regular season only)", async () => {
    const m = await byPlayer();
    expect(m.get(101)).toMatchObject({ gp: 2, fgp: 2, statFp: 40, bonusFp: 4, totalFp: 44, fpAvg: 22 });
    expect(m.get(103)).toMatchObject({ gp: 2, statFp: 35, bonusFp: 4, totalFp: 39, fpAvg: 19.5 });
    expect(m.get(104)).toMatchObject({ gp: 1, totalFp: 25 });
    // Coach's decision DNP in a win earns the bonus; the injury DNP in a loss earns nothing and does not count.
    expect(m.get(102)).toMatchObject({ gp: 0, fgp: 1, statFp: 0, bonusFp: 4, totalFp: 4, fpAvg: 4 });
    expect(m.has(106)).toBe(false);
  });

  it("groups by season", async () => {
    const rows = (await loadSeasonFantasy(db, { playerIds: [101] })).sort((a, b) => b.season - a.season);
    expect(rows.map((r) => [r.season, r.totalFp])).toEqual([[2026, 44], [2025, 11]]);
  });

  it("honors league scoring values and the win bonus", async () => {
    const scoring = { ...DEFAULT_SCORING, pts: 2, teamWin: 10 };
    const m = await byPlayer({ points: scoring, teamWin: scoring.teamWin });
    // g1: 20*2 + 10 = 50 (+10 win); g2: 10*2 = 20.
    expect(m.get(101)).toMatchObject({ statFp: 70, bonusFp: 10, totalFp: 80 });
    const last = await loadLastSeasonFp(db, { season: 2026, playerIds: [101], scoring });
    expect(last.get(101)).toMatchObject({ season: 2026, gp: 2, total: 80, avg: 40 });
  });
});

describe("Players table and player card", () => {
  it("defaults to the previous season in the preseason and locks the ranges", async () => {
    const res = await listPlayers(db, { now: NOW, range: "7" });
    expect(res).toMatchObject({ season: 2026, seasons: [2026], currentSeason: 2027, range: "season", rangeLocked: true });
    const a = res.rows.find((r) => r.id === 101)!;
    expect(a).toMatchObject({ gp: 2, fpTotal: 44, fpAvg: 22 });
    // An explicit season that has data works; one that has none falls back.
    expect((await listPlayers(db, { now: NOW, season: 2026 })).season).toBe(2026);
    expect((await listPlayers(db, { now: NOW, season: 2027 })).season).toBe(2026);
  });

  it("uses league scoring in a league context", async () => {
    const admin = await createAdmin(db);
    const fx = await setupLeague(db, admin, 2, {});
    await updateSettings(db, admin, fx.league.id, { scoring: { ...DEFAULT_SCORING, pts: 2, teamWin: 10 } });
    const inLeague = await listPlayers(db, { now: NOW, league: { id: fx.league.id, status: "all" } });
    expect(inLeague.rows.find((r) => r.id === 101)).toMatchObject({ fpTotal: 80, fpAvg: 40 });
    const global = await listPlayers(db, { now: NOW });
    expect(global.rows.find((r) => r.id === 101)!.fpTotal).toBe(44);
  });

  it("parses the season param", () => {
    expect(parsePlayerParams({}).season).toBeUndefined();
    expect(parsePlayerParams({ season: "2026" }).season).toBe(2026);
    expect(parsePlayerParams({ season: ["2027", "2026"] }).season).toBe(2027);
    expect(parsePlayerParams({ season: "abc" }).season).toBeUndefined();
    expect(parsePlayerParams({ season: "1" }).season).toBeUndefined();
  });

  it("player card lists fantasy by season (current and previous always) and a season-filtered log", async () => {
    const card = (await getPlayerCard(db, 101, NOW))!;
    expect(card.bySeason.map((r) => r.season)).toEqual([2027, 2026, 2025]);
    expect(card.bySeason[0]).toMatchObject({ gp: 0, totalFp: null, fpAvg: null });
    expect(card.bySeason[1]).toMatchObject({ gp: 2, totalFp: 44, bonusFp: 4, fpAvg: 22, minAvg: 30 });
    expect(card.bySeason[2]).toMatchObject({ gp: 1, totalFp: 11, bonusFp: 4 });
    expect(card.logSeason).toBe(2026);
    expect(card.gameLog.map((g) => g.gameId).sort()).toEqual([9001, 9002, 9004]);
    const old = (await getPlayerCard(db, 101, NOW, { logSeason: 2025 }))!;
    expect(old.logSeason).toBe(2026); // 2025 is not an offered season
  });
});

describe("listDraftablePlayers default order", () => {
  it("sorts by previous-season total FP descending, ties by projection, then the rest", async () => {
    const admin = await createAdmin(db);
    const fx = await setupLeague(db, admin, 2, {});
    const res = await listDraftablePlayers(db, fx.league.id, { limit: 200 });
    expect(res.sort).toBe(DEFAULT_DRAFT_SORT);
    expect(res.dir).toBe("desc");
    const ids = res.players.map((p) => p.id);
    // A 44; E and C tie on 39 (E projects higher); D 25; B 4; F has no last season and goes last.
    expect(ids).toEqual([101, 105, 103, 104, 102, 106]);
    const a = res.players[0];
    expect(a).toMatchObject({ lastFp: 44, lastAvg: 22, lastGp: 2, curAvg: null });
    expect(res.players[5]).toMatchObject({ lastFp: null, lastAvg: null });
  });

  it("supports other sort keys and directions with nulls last", async () => {
    const admin = await createAdmin(db);
    const fx = await setupLeague(db, admin, 2, {});
    const byAvg = await listDraftablePlayers(db, fx.league.id, { sort: "lastavg", limit: 200 });
    expect(byAvg.players.map((p) => p.id)).toEqual([105, 104, 101, 103, 102, 106]);
    const asc = await listDraftablePlayers(db, fx.league.id, { sort: "lastfp", dir: "asc", limit: 200 });
    expect(asc.players.map((p) => p.id)).toEqual([102, 104, 105, 103, 101, 106]);
    const name = await listDraftablePlayers(db, fx.league.id, { sort: "name", limit: 200 });
    expect(name.players.map((p) => p.name)).toEqual(["Alpha A", "Bravo B", "Charlie C", "Delta D", "Echo E", "Foxtrot F"]);
    const bogus = await listDraftablePlayers(db, fx.league.id, { sort: "nope" as never, limit: 200 });
    expect(bogus.sort).toBe("lastfp");
  });

  it("uses the league's scoring for last-season FP", async () => {
    const admin = await createAdmin(db);
    const fx = await setupLeague(db, admin, 2, { scoring: { ...DEFAULT_SCORING, pts: 2, teamWin: 10 } });
    const res = await listDraftablePlayers(db, fx.league.id, { limit: 200 });
    expect(res.players.find((p) => p.id === 101)).toMatchObject({ lastFp: 80, lastAvg: 40 });
    // Paging keeps the order.
    const page2 = await listDraftablePlayers(db, fx.league.id, { limit: 2, offset: 2 });
    expect(page2.players.map((p) => p.id)).toEqual(res.players.slice(2, 4).map((p) => p.id));
  });
});

describe("once the new season has a final game", () => {
  it("defaults to the current season, offers both, and unlocks the ranges", async () => {
    await db.insert(nbaGames).values({
      id: 9101, season: 2027, seasonType: 2, startTime: new Date("2026-10-22T00:00:00Z"), homeTeamId: 1, awayTeamId: 2,
      homeScore: 100, awayScore: 99, status: "final",
    });
    await box(9101, 101, 1, { pts: 12 });
    const c = await resolveSeason(db, new Date("2026-10-25T00:00:00Z"));
    expect(c).toMatchObject({ current: 2027, options: [2027, 2026], default: 2027, selected: 2027 });
    expect((await resolveSeason(db, new Date("2026-10-25T00:00:00Z"), 2026)).selected).toBe(2026);
    const now = new Date("2026-10-25T00:00:00Z");
    const cur = await listPlayers(db, { now });
    expect(cur).toMatchObject({ season: 2027, rangeLocked: false });
    expect(cur.rows.find((r) => r.id === 101)).toMatchObject({ gp: 1, fpTotal: 16 });
    const week = await listPlayers(db, { now, range: "7" });
    expect(week.range).toBe("7");
    const last = await listPlayers(db, { now, season: 2026, range: "7" });
    expect(last).toMatchObject({ season: 2026, rangeLocked: true, range: "season" });
    expect(last.rows.find((r) => r.id === 101)!.fpTotal).toBe(44);
  });
});
