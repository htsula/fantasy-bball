/**
 * ESPN unofficial public JSON API adapter. The UI never calls ESPN; only sync jobs do, through
 * an `EspnClient` that tests replace with fixtures.
 */
import {
  injuriesResponseSchema,
  newsResponseSchema,
  parseLoose,
  rosterResponseSchema,
  scoreboardResponseSchema,
  summaryResponseSchema,
  teamsResponseSchema,
  type RawInjuries,
  type RawNews,
  type RawRoster,
  type RawScoreboard,
  type RawSummary,
  type RawTeams,
} from "./espn-schemas";

export * from "./normalize";
export type { RawInjuries, RawNews, RawRoster, RawScoreboard, RawSummary, RawTeams };

export const ESPN_PRIMARY_HOST = "site.api.espn.com";
export const ESPN_FALLBACK_HOST = "site.web.api.espn.com";
export const ESPN_NBA_PATH = "/apis/site/v2/sports/basketball/nba";
export const USER_AGENT = "fantasy-bball/1.0";

/** What sync jobs need from ESPN. Implemented by `createEspnClient` and by test fakes. */
export interface EspnClient {
  teams(): Promise<RawTeams>;
  roster(teamId: number): Promise<RawRoster>;
  /** `dates` is YYYYMMDD (one day) or YYYYMM (a month; pass `limit`). Ranges are broken upstream. */
  scoreboard(dates: string, opts?: { limit?: number }): Promise<RawScoreboard>;
  summary(eventId: number): Promise<RawSummary>;
  injuries(): Promise<RawInjuries>;
  news(limit?: number): Promise<RawNews>;
}

export class EspnHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "EspnHttpError";
  }
}

export type EspnFetchOptions = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Retries after the first attempt, for 429 / 5xx / network errors. */
  retries?: number;
  timeoutMs?: number;
  baseDelayMs?: number;
};

/** ESPN `$ref` links sometimes point at the internal `.pvt` domain; the public one is `.com`. */
export function rewritePvt(url: string): string {
  return url.replace(/\.pvt(?=[/:?#]|$)/g, ".com");
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * GET JSON with a plain UA, timeout, exponential backoff on 429/5xx/network errors, and a
 * one-time switch to the `site.web.api.espn.com` host on 403. `target` is either a path on the
 * ESPN site API host (starting with "/") or an absolute URL (e.g. a followed `$ref`).
 */
export async function espnGetJson(target: string, options: EspnFetchOptions = {}): Promise<unknown> {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.retries ?? 3;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = options.baseDelayMs ?? 500;

  const absolute = target.startsWith("http");
  const buildUrl = (host: string) => (absolute ? rewritePvt(target) : `https://${host}${target}`);
  let host = ESPN_PRIMARY_HOST;
  let switchedHost = false;
  let attempt = 0;

  for (;;) {
    const url = buildUrl(host);
    let retryAfterMs = 0;
    let failure: EspnHttpError;
    try {
      const res = await doFetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return await res.json();
      if (res.status === 403 && !absolute && !switchedHost) {
        host = ESPN_FALLBACK_HOST;
        switchedHost = true;
        continue;
      }
      failure = new EspnHttpError(`ESPN ${res.status} for ${url}`, res.status);
      if (res.status !== 429 && res.status < 500) throw failure;
      const ra = Number(res.headers.get("retry-after"));
      if (Number.isFinite(ra) && ra > 0) retryAfterMs = Math.min(ra * 1000, 10_000);
    } catch (err) {
      if (err instanceof EspnHttpError && err.status !== undefined && err.status !== 429 && err.status < 500) throw err;
      failure = err instanceof EspnHttpError ? err : new EspnHttpError(`ESPN request failed for ${url}: ${String(err)}`);
    }
    if (attempt >= retries) throw failure;
    await sleep(Math.max(retryAfterMs, base * 2 ** attempt + Math.random() * base));
    attempt++;
  }
}

/** Follows an ESPN `$ref` (rewriting `.pvt` -> `.com`). */
export function followRef(ref: string, options: EspnFetchOptions = {}): Promise<unknown> {
  return espnGetJson(rewritePvt(ref), options);
}

export function createEspnClient(options: EspnFetchOptions = {}): EspnClient {
  const get = (path: string) => espnGetJson(`${ESPN_NBA_PATH}${path}`, options);
  return {
    async teams() {
      return parseLoose(teamsResponseSchema, await get("/teams"), "teams");
    },
    async roster(teamId) {
      return parseLoose(rosterResponseSchema, await get(`/teams/${teamId}/roster`), "roster");
    },
    async scoreboard(dates, opts) {
      const q = `dates=${encodeURIComponent(dates)}${opts?.limit ? `&limit=${opts.limit}` : ""}`;
      return parseLoose(scoreboardResponseSchema, await get(`/scoreboard?${q}`), "scoreboard");
    },
    async summary(eventId) {
      return parseLoose(summaryResponseSchema, await get(`/summary?event=${eventId}`), "summary");
    },
    async injuries() {
      return parseLoose(injuriesResponseSchema, await get("/injuries"), "injuries");
    },
    async news(limit = 50) {
      return parseLoose(newsResponseSchema, await get(`/news?limit=${limit}`), "news");
    },
  };
}
