import { describe, expect, it } from "vitest";
import { resolvePgliteDataDir } from "@/db";

describe("resolvePgliteDataDir", () => {
  it("uses PGlite locally when DATABASE_URL is unset or pglite:", () => {
    expect(resolvePgliteDataDir(undefined, false)).toBe("memory://");
    expect(resolvePgliteDataDir("pglite:./data", false)).toBe("./data");
  });

  it("uses Postgres for a real connection string", () => {
    expect(resolvePgliteDataDir("postgres://u:p@host/db", true)).toBeNull();
  });

  it("refuses to fall back to PGlite on Vercel", () => {
    expect(() => resolvePgliteDataDir(undefined, true)).toThrow(/DATABASE_URL/);
    expect(() => resolvePgliteDataDir("pglite:./data", true)).toThrow(/DATABASE_URL/);
  });
});
