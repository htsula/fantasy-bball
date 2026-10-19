import { hydrationDiff } from "./diag";
/**
 * Shared helpers for the simulation browser pass (`npm run e2e:sim`): sessions at the checkpoint's clock, the visit()
 * check (status, error boundaries, console, overflow, timing, screenshot) and the result recorder.
 */
import fs from "node:fs";
import path from "node:path";
import { type Browser, type BrowserContext, type Page, type Response } from "@playwright/test";
import type { Meta, SimUserMeta } from "../scripts/sim/common";

export const CP = process.env.SIM_CHECKPOINT ?? "";
export const meta: Meta = JSON.parse(fs.readFileSync(path.resolve(".pglite-sim", `${CP}.meta.json`), "utf8"));
export const SIM_NOW = new Date(meta.now);
export const RESULT_FILE = path.resolve(".pglite-sim", "_results", `${CP}.jsonl`);
export const SHOT_DIR = path.resolve("screenshots", "sim", CP);

export type Role = "signed-out" | "non-member" | "member" | "commissioner" | "flow";

export type VisitRecord = {
  cp: string;
  role: Role;
  name: string;
  url: string;
  finalPath: string;
  status: number | null;
  ttfbMs: number | null;
  loadMs: number;
  ok: boolean;
  problems: string[];
};

/** Console messages that are known to be harmless. Everything else is a failure. */
export const BENIGN_CONSOLE: RegExp[] = [];

export type Expect = {
  /** Expected HTTP status of the final response (default 200). */
  status?: number;
  /** The final URL path must match (for intended redirects). */
  redirect?: string | RegExp;
  /** Text that must be visible somewhere on the page. */
  text?: (string | RegExp)[];
  /** Text that must NOT appear. */
  absent?: (string | RegExp)[];
  /** Page is the app's not-found view (404). */
  notFound?: boolean;
  /** Save a phone screenshot under this name. */
  shot?: string;
  /** Skip the horizontal-overflow check (not for real pages). */
  noOverflow?: boolean;
  /** Extra settle time for client-side data (ms). */
  settle?: number;
};

const ERROR_TEXT = /Application error|Something went wrong|This page couldn.t load|Unhandled Runtime Error|Internal Server Error|Failed to load/i;

export const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true } as const;
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1";

export type Session = {
  role: Role;
  user: SimUserMeta | null;
  context: BrowserContext;
  page: Page;
  buffer: string[];
  records: VisitRecord[];
};

export function record(r: VisitRecord) {
  fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
  fs.appendFileSync(RESULT_FILE, JSON.stringify(r) + "\n");
}

export async function newSession(browser: Browser, role: Role, user: SimUserMeta | null, opts: { login?: boolean } = {}): Promise<Session> {
  const context = await browser.newContext({
    ...PHONE,
    userAgent: IPHONE_UA,
    colorScheme: "light",
    baseURL: process.env.SIM_BASE_URL,
    // SIM_BLOCK_SW=1 runs without the PWA service worker (debug aid for the intermittent overview hydration error).
    ...(process.env.SIM_BLOCK_SW ? { serviceWorkers: "block" as const } : {}),
  });
  if (!process.env.SIM_NO_PAGE_CLOCK) await context.clock.install({ time: SIM_NOW });
  const page = await context.newPage();
  const s: Session = { role, user, context, page, buffer: [], records: [] };
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (BENIGN_CONSOLE.some((re) => re.test(text))) return;
    s.buffer.push(`console.error: ${text.slice(0, 300)} @ ${m.location().url}`);
  });
  // The document that is showing when an error fires: a late error from the previous page (thrown while the next
  // navigation is still loading) would otherwise be blamed on the page being visited.
  let docPath = "";
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) docPath = new URL(f.url()).pathname;
  });
  page.on("pageerror", (e) => s.buffer.push(`pageerror: ${e.message.slice(0, 300)} (document ${docPath})`));
  page.on("response", (r: Response) => {
    const u = r.url();
    if (!u.startsWith(process.env.SIM_BASE_URL ?? "http://localhost")) return;
    if (r.status() >= 500) s.buffer.push(`HTTP ${r.status()} from ${u}`);
  });
  if (user && opts.login !== false) await login(s, user);
  return s;
}

export async function login(s: Session, user: SimUserMeta) {
  await s.page.goto("/login");
  await s.page.getByLabel("Username").fill(user.username);
  await s.page.getByLabel("Password").fill(user.password);
  await s.page.getByRole("button", { name: "Log in" }).click();
  await s.page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
  s.buffer.length = 0;
}

async function overflowOf(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const over = doc.scrollWidth - doc.clientWidth;
    if (over <= 1) return { over: 0, culprits: [] as string[] };
    const culprits: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      if (r.right > doc.clientWidth + 1 && r.width > 0) {
        culprits.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${String(el.className).slice(0, 50)} right=${Math.round(r.right)}`);
        if (culprits.length >= 4) break;
      }
    }
    return { over, culprits };
  });
}

const matches = (hay: string, needle: string | RegExp) => (typeof needle === "string" ? hay.includes(needle) : needle.test(hay));

export async function visit(s: Session, name: string, url: string, e: Expect = {}): Promise<VisitRecord> {
  const { page } = s;
  const problems: string[] = [];
  s.buffer.length = 0;
  const t0 = Date.now();
  let resp: Response | null = null;
  try {
    resp = await page.goto(url, { waitUntil: "load", timeout: 90_000 });
  } catch (err) {
    problems.push(`navigation failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
  }
  const loadMs = Date.now() - t0;
  await page.waitForTimeout(e.settle ?? 600);
  const status = resp?.status() ?? null;
  const timing = resp ? resp.request().timing() : null;
  const ttfbMs = timing && timing.responseStart > 0 ? Math.round(timing.responseStart - Math.max(0, timing.requestStart)) : null;
  const finalPath = (() => {
    const u = new URL(page.url());
    return u.pathname + u.search;
  })();

  const wantStatus = e.notFound ? 404 : (e.status ?? 200);
  if (status !== wantStatus) problems.push(`status ${status}, expected ${wantStatus}`);
  if (e.redirect !== undefined && !matches(finalPath, e.redirect)) problems.push(`ended at ${finalPath}, expected ${String(e.redirect)}`);

  const body = (await page.locator("body").innerText().catch(() => "")) ?? "";
  if (e.notFound) {
    if (!(await page.getByTestId("not-found-view").count())) problems.push("expected the not-found view");
  } else if (ERROR_TEXT.test(body) || (await page.getByTestId("error-view").count())) {
    problems.push(`error boundary text on page: ${(body.match(ERROR_TEXT) ?? [""])[0]}`);
  }
  for (const t of e.text ?? []) if (!matches(body, t)) problems.push(`missing text ${String(t)}`);
  for (const t of e.absent ?? []) if (matches(body, t)) problems.push(`unexpected text ${String(t)}`);

  if (!e.noOverflow) {
    const o = await overflowOf(page);
    if (o.over > 0) problems.push(`page is ${o.over}px wider than the phone: ${o.culprits.join(" | ")}`);
  }
  // Chrome logs "Failed to load resource ... 404" for the document itself when a page is (intentionally) not found.
  const own = (m: string) => e.notFound === true && /Failed to load resource: the server responded with a status of 404/.test(m) && m.endsWith(url.startsWith("http") ? url : `${process.env.SIM_BASE_URL}${url}`);
  problems.push(...s.buffer.filter((m) => !own(m)));
  if (s.buffer.some((m) => m.includes("#418")) && process.env.SIM_DIAG && resp) problems.push(await hydrationDiff(resp, page));
  s.buffer.length = 0;

  if (e.shot && (s.role === "member" || s.role === "commissioner" || s.role === "flow")) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOT_DIR, `${s.role === "commissioner" ? "commish" : "member"}__${e.shot}.png`), fullPage: true }).catch(() => undefined);
  }
  const rec: VisitRecord = { cp: CP, role: s.role, name, url, finalPath, status, ttfbMs, loadMs, ok: problems.length === 0, problems };
  s.records.push(rec);
  record(rec);
  return rec;
}

/** Runs a list of visits and returns the failures formatted for an assertion message. */
export function failures(recs: VisitRecord[]): string[] {
  return recs.filter((r) => !r.ok).map((r) => `${r.role} ${r.name} ${r.url}: ${r.problems.join("; ")}`);
}
