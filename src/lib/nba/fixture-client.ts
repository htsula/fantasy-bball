/**
 * An EspnClient backed by the saved fixtures in tests/fixtures/espn. Used by tests and the
 * offline dev seed; it never touches the network. Node-only (reads the filesystem).
 */
import fs from "node:fs";
import path from "node:path";
import type { EspnClient } from "./espn";

export const FIXTURE_DIR = path.resolve(process.cwd(), "tests/fixtures/espn");

export function readFixture<T = unknown>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8")) as T;
}

export const FIXTURE_GAME_ID = 401810791;
export const FIXTURE_GAME_DATE = "2026-03-10";

export function createFixtureClient(overrides: Partial<EspnClient> = {}): EspnClient {
  return {
    async teams() {
      return readFixture("teams.json");
    },
    async roster() {
      return readFixture("roster-1.json");
    },
    async scoreboard() {
      return readFixture("scoreboard-20260310.json");
    },
    async summary() {
      return readFixture("summary-401810791.json");
    },
    async injuries() {
      return readFixture("injuries.json");
    },
    async news() {
      return readFixture("news.json");
    },
    ...overrides,
  };
}
