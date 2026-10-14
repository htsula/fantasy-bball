import { afterAll, beforeAll, expect, it } from "vitest";
import type { Db } from "@/db/types";
import { createUser } from "@/lib/auth/service";
import { seedDemoLeague } from "@/lib/leagues/seed-demo";
import { getLeagueView, getSchedule } from "@/lib/leagues/service";
import { draftPicks, matchups, messages, standings, trades } from "@/db/schema";
import { createTestDb } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());
const SLOW = 180_000;

it("seeds a 10-team mid-season demo league with a draft, trades, chat and standings, idempotently", async () => {
  const admin = await createUser(db, { username: "admin", password: "password123", isSiteAdmin: true });
  const first = await seedDemoLeague(db);
  expect(first.created).toBe(true);
  const view = await getLeagueView(db, { id: admin.id, isSiteAdmin: true }, first.leagueId);
  expect(view.teams.map((t) => t.ownerUsername)).toEqual(["admin", ...Array.from({ length: 9 }, (_, i) => `demo${i + 1}`)]);
  expect(view.league.status).toBe("in_season");
  const { periods } = await getSchedule(db, first.leagueId);
  expect(periods).toHaveLength(12); // 10 regular weeks + 2 playoff rounds
  expect(periods.filter((p) => p.isPlayoff)).toHaveLength(2);
  // A completed draft, trades in every state, chat, finalized weeks and standings.
  expect(await db.select().from(draftPicks)).toHaveLength(100 + 8 + 15); // the demo league plus two leagues left mid-draft
  expect((await db.select().from(trades)).map((t) => t.status).sort()).toEqual(["executed", "executed", "proposed", "rejected"]);
  expect((await db.select().from(messages)).length).toBeGreaterThanOrEqual(7);
  expect((await db.select().from(standings)).length).toBe(10);
  expect((await db.select().from(matchups)).filter((m) => m.status === "final").length).toBeGreaterThanOrEqual(20);
  const second = await seedDemoLeague(db);
  expect(second).toEqual({ created: false, leagueId: first.leagueId });
}, SLOW);
