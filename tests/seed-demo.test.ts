import { afterAll, beforeAll, expect, it } from "vitest";
import type { Db } from "@/db/types";
import { createUser } from "@/lib/auth/service";
import { seedDemoLeague } from "@/lib/leagues/seed-demo";
import { getLeagueView, getSchedule } from "@/lib/leagues/service";
import { createTestDb } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

it("seeds a 4-team demo league with a schedule, idempotently", async () => {
  const admin = await createUser(db, { username: "admin", password: "password123", isSiteAdmin: true });
  const first = await seedDemoLeague(db);
  expect(first.created).toBe(true);
  const view = await getLeagueView(db, { id: admin.id, isSiteAdmin: true }, first.leagueId);
  expect(view.teams.map((t) => t.ownerUsername)).toEqual(["admin", "demo1", "demo2", "demo3"]);
  const { periods } = await getSchedule(db, first.leagueId);
  expect(periods.length).toBeGreaterThan(20);
  expect(periods.filter((p) => p.isPlayoff)).toHaveLength(2);
  const second = await seedDemoLeague(db);
  expect(second).toEqual({ created: false, leagueId: first.leagueId });
});
