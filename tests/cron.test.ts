import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyCronRequest } from "@/lib/cron";

const req = (auth?: string) => new Request("http://x/api/cron/daily", { headers: auth ? { authorization: auth } : {} });

describe("verifyCronRequest", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts the correct bearer token only", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(verifyCronRequest(req("Bearer s3cret"))).toBe(true);
    expect(verifyCronRequest(req("Bearer wrong"))).toBe(false);
    expect(verifyCronRequest(req())).toBe(false);
  });

  it("fails closed when CRON_SECRET is unset", () => {
    vi.stubEnv("CRON_SECRET", "");
    expect(verifyCronRequest(req("Bearer "))).toBe(false);
  });
});
