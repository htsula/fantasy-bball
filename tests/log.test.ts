import { afterEach, describe, expect, it, vi } from "vitest";
import { formatLog, log } from "@/lib/log";

afterEach(() => vi.restoreAllMocks());

describe("structured logger", () => {
  it("writes one JSON line with level, event and context", () => {
    const parsed = JSON.parse(formatLog("info", "cron.daily", { ok: true, durationMs: 12 }));
    expect(parsed).toMatchObject({ level: "info", event: "cron.daily", ctx: { ok: true, durationMs: 12 } });
    expect(typeof parsed.time).toBe("string");
  });

  it("redacts secrets by key name, at any depth", () => {
    const line = formatLog("error", "push.send_failed", {
      userId: "u1",
      password: "hunter2",
      nested: { sessionToken: "abc", authorization: "Bearer x", endpoint: "https://push.example/abc", p256dh: "k", auth: "a", vapidPrivateKey: "p" },
      list: [{ cookie: "c" }],
    });
    for (const secret of ["hunter2", "abc", "Bearer x", "push.example", "\"k\"", "\"a\"", "\"p\"", "\"c\""]) expect(line).not.toContain(secret);
    expect(JSON.parse(line).ctx.userId).toBe("u1");
    expect(JSON.parse(line).ctx.password).toBe("[redacted]");
  });

  it("serializes errors with name, message and a short stack, and routes by level", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
    log.error("boom", { a: 1 }, new TypeError("bad"));
    log.warn("careful");
    log.info("fine");
    expect(err).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(out).toHaveBeenCalledTimes(1);
    expect(JSON.parse(err.mock.calls[0][0] as string).error).toMatchObject({ name: "TypeError", message: "bad" });
  });
});
