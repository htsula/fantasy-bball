import { describe, expect, it, vi } from "vitest";
import { createEspnClient, espnGetJson, followRef, rewritePvt } from "@/lib/nba/espn";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function setup(responses: (Response | Error)[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  const sleeps: number[] = [];
  const opts = {
    fetch: fetchFn as unknown as typeof fetch,
    sleep: async (ms: number) => void sleeps.push(ms),
    baseDelayMs: 100,
  };
  return { calls, sleeps, opts };
}

describe("espnGetJson", () => {
  it("sends a plain user agent to the primary host", async () => {
    const { calls, opts } = setup([json({ ok: 1 })]);
    await expect(espnGetJson("/apis/site/v2/sports/basketball/nba/teams", opts)).resolves.toEqual({ ok: 1 });
    expect(calls[0].url).toBe("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams");
    expect(calls[0].headers["User-Agent"]).toBe("fantasy-bball/1.0");
  });

  it("retries 5xx and 429 with exponential backoff", async () => {
    const { calls, sleeps, opts } = setup([json({}, 503), json({}, 429), json({ ok: true })]);
    await expect(espnGetJson("/x", opts)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(100);
    expect(sleeps[1]).toBeGreaterThanOrEqual(200);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0] - 100);
  });

  it("retries network errors, then gives up after the retry budget", async () => {
    const { calls, opts } = setup([new Error("ECONNRESET"), new Error("ECONNRESET"), new Error("ECONNRESET")]);
    await expect(espnGetJson("/x", { ...opts, retries: 2 })).rejects.toThrow(/ECONNRESET/);
    expect(calls).toHaveLength(3);
  });

  it("does not retry other 4xx", async () => {
    const { calls, opts } = setup([json({}, 404), json({ ok: true })]);
    await expect(espnGetJson("/x", opts)).rejects.toMatchObject({ status: 404 });
    expect(calls).toHaveLength(1);
  });

  it("retries the same path on the web host after a 403", async () => {
    const { calls, sleeps, opts } = setup([json({}, 403), json({ ok: true })]);
    await expect(espnGetJson("/apis/site/v2/sports/basketball/nba/news?limit=50", opts)).resolves.toEqual({ ok: true });
    expect(calls.map((c) => new URL(c.url).host)).toEqual(["site.api.espn.com", "site.web.api.espn.com"]);
    expect(new URL(calls[1].url).pathname + new URL(calls[1].url).search).toBe(
      "/apis/site/v2/sports/basketball/nba/news?limit=50",
    );
    expect(sleeps).toHaveLength(0);
  });

  it("fails if the fallback host is also forbidden", async () => {
    const { calls, opts } = setup([json({}, 403), json({}, 403)]);
    await expect(espnGetJson("/x", opts)).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(2);
  });
});

describe("$ref handling", () => {
  it("rewrites .pvt to .com", () => {
    expect(rewritePvt("http://sports.core.api.espn.pvt/v2/sports/basketball/leagues/nba/athletes/1?lang=en")).toBe(
      "http://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/athletes/1?lang=en",
    );
    expect(rewritePvt("https://example.com/x")).toBe("https://example.com/x");
  });

  it("follows a ref on the rewritten URL", async () => {
    const { calls, opts } = setup([json({ id: 1 })]);
    await expect(followRef("http://sports.core.api.espn.pvt/v2/a?x=1", opts)).resolves.toEqual({ id: 1 });
    expect(calls[0].url).toBe("http://sports.core.api.espn.com/v2/a?x=1");
  });
});

describe("createEspnClient", () => {
  it("builds the documented endpoints", async () => {
    const { calls, opts } = setup(Array.from({ length: 7 }, () => json({})));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = createEspnClient(opts);
    await c.teams();
    await c.roster(1);
    await c.scoreboard("20260310");
    await c.scoreboard("202603", { limit: 300 });
    await c.summary(401810791);
    await c.injuries();
    await c.news(50);
    warn.mockRestore();
    const paths = calls.map((x) => x.url.replace("https://site.api.espn.com/apis/site/v2/sports/basketball/nba", ""));
    expect(paths).toEqual([
      "/teams",
      "/teams/1/roster",
      "/scoreboard?dates=20260310",
      "/scoreboard?dates=202603&limit=300",
      "/summary?event=401810791",
      "/injuries",
      "/news?limit=50",
    ]);
  });

  it("warns instead of throwing when the response shape drifts", async () => {
    const { opts } = setup([json({ events: "not-an-array" })]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await createEspnClient(opts).scoreboard("20260310");
    expect(res).toBeTruthy();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unexpected scoreboard shape"));
    warn.mockRestore();
  });
});
