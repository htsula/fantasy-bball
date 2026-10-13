# Fantasy Hoops

Private fantasy NBA app (H2H points) for a friend group. Next.js 15 (App Router) + TypeScript + Tailwind + shadcn/ui,
Postgres via Drizzle ORM, deployed on Vercel with Neon.

Status: **Milestone 2 (NBA data)** on top of Milestone 1 (auth, admin, DB): ESPN data sync, crons, a Players browser with player cards, and an NBA scoreboard. Leagues and the rest follow.

## Local setup

Requires Node 20+ and npm. No Postgres install needed: with no `DATABASE_URL`, the app uses
[PGlite](https://pglite.dev) (embedded Postgres) stored in `./.pglite`.

```bash
npm install
cp .env.example .env.local        # optional for local dev; defaults work
npm run db:migrate                # creates ./.pglite and applies migrations
ADMIN_PASSWORD='choose-a-password' npm run create-admin -- --username yourname
npm run dev                       # http://localhost:3000
```

Log in as your admin, open **Admin**, and generate an invite link for a friend (single-use, 7 days).
Reset links for forgotten passwords are generated per user on the same page (24 hours).

Stop the dev server before running `db:migrate`, `db:seed`, `create-admin` or `db:studio` against PGlite
(the embedded database should only be opened by one process at a time). To start over, delete `./.pglite`.

### create-admin

```bash
# bash / zsh
ADMIN_PASSWORD='s3cret-pass' npm run create-admin -- --username alice
# PowerShell
$env:ADMIN_PASSWORD='s3cret-pass'; npm run create-admin -- --username alice
```

If `ADMIN_PASSWORD` is unset you are prompted (input hidden, typed twice to confirm). Password minimum is 8 characters.
It uses whatever `DATABASE_URL` points at, so run it against production the same way (see below).

**Forgotten password?** Add `--reset` to set a new password for an existing user (case-insensitive
username). It signs that user out everywhere and clears any login lockout; it never creates a user or
changes admin status. Exits 1 if the user doesn't exist.

```bash
# bash / zsh
DATABASE_URL='...' npm run create-admin -- --username yourname --reset
# PowerShell
$env:DATABASE_URL='...'; npm run create-admin -- --username yourname --reset
```

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js |
| `npm run lint`, `npm run typecheck` | ESLint, `tsc --noEmit` |
| `npm test` | Vitest (in-memory PGlite, migrations applied per test file) |
| `npm run e2e` | Playwright smoke test (starts its own dev server on :3100 with a throwaway DB). First time: `npx playwright install chromium` |
| `npm run db:generate` | Generate a SQL migration into `drizzle/` after editing `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations (PGlite or Postgres, depending on `DATABASE_URL`) |
| `npm run db:studio` | Drizzle Studio |
| `npm run db:seed` | Dev-only seed: `admin` / `password123` plus the saved ESPN fixtures (one roster, a final game with box score, injuries, news) so the NBA pages have data offline; refuses to run against real Postgres |
| `npm run db:seed-nba` | Just the NBA fixtures part of the seed |
| `npm run sync:daily [-- --season 2026] [--budget-seconds 300]` | Run the daily NBA sync against the **live ESPN API** into whatever `DATABASE_URL` points at (see below) |
| `npm run create-admin -- --username X` | Create a site admin (`--reset` resets an existing user's password) |

## Environment variables

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Postgres URL (Neon). Unset or `pglite:<dir>` uses embedded PGlite. `pglite:memory://` is in-memory. |
| `CRON_SECRET` | Required for `/api/cron/*`; requests need `Authorization: Bearer <secret>`. Vercel Cron sends it automatically. GitHub Actions needs the same value as an Actions **secret** (see Cron setup). |
| `NEXT_PUBLIC_APP_URL` | Base URL used in invite/reset links, e.g. `https://your-app.vercel.app`. Falls back to the request host. |
| `ADMIN_PASSWORD` | Only for `create-admin`. |

There is no `SESSION_SECRET`: sessions are random 32-byte tokens whose sha256 hash is stored in the DB
(so nothing needs signing). Passwords use argon2id.

## Deploy to Vercel + Neon

1. Push the repo to GitHub and import it in Vercel (framework: Next.js, defaults are fine).
2. In the Vercel project: **Storage / Marketplace -> Neon** and connect it; this sets `DATABASE_URL`.
3. Add env vars (Production + Preview): `CRON_SECRET` (random, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`) and `NEXT_PUBLIC_APP_URL`.
4. Deploy. Vercel runs the `vercel-build` script, which applies pending migrations and then builds,
   so the schema always matches the deployed code. Only **production** deploys migrate; preview
   deploys skip it so unmerged code can't alter the live league's schema. If you enable Neon's
   per-preview database branches, set `MIGRATE_ON_PREVIEW=1` for the Preview environment.
   On Vercel the app refuses to start without a Postgres `DATABASE_URL` (no silent PGlite fallback).
5. Create the first admin from your machine against the Neon database:
   ```bash
   # PowerShell: $env:DATABASE_URL='postgres://...'; $env:ADMIN_PASSWORD='...'
   DATABASE_URL='postgres://...neon...' ADMIN_PASSWORD='...' npm run create-admin -- --username yourname
   ```
   (Use the unpooled or pooled connection string; both work.)
6. `vercel.json` registers a daily cron hitting `/api/cron/daily` (NBA daily sync, see below). Verify with
   `curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/cron/daily` (takes up to ~60s).
7. Set up the live-score pings (GitHub Actions) as described under **Cron setup**.

Before deploying a new migration, read the generated SQL in `drizzle/`: added tables/columns are
safe, but drops and renames can destroy data.

## NBA data

**Source: ESPN's unofficial public JSON API** (`site.api.espn.com/apis/site/v2/sports/basketball/nba`): teams, rosters,
scoreboard, box scores (`/summary`), injuries and news. No key is needed and it is the best free source, but it is
**undocumented and can change or disappear without notice**, and ESPN's terms do not cover automated use. Treat it as
best-effort for a small private league:

- The app never calls ESPN from the UI; only sync jobs do (`src/lib/nba/espn.ts`), through a plain `fantasy-bball/1.0`
  User-Agent, 10s timeout, retry with exponential backoff on 429/5xx/network errors, a switch to
  `site.web.api.espn.com` on 403, and `.pvt` -> `.com` rewriting for followed `$ref` links.
- Responses are validated loosely (zod `looseObject`): shape drift logs a warning instead of crashing a sync. Normalizers
  (`src/lib/nba/normalize.ts`) are pure and tested against saved fixtures in `tests/fixtures/espn/`; tests never hit the network.
- Latest raw payloads (slimmed) are kept in `raw_snapshots` (one row per kind+key) so stats can be recomputed if parsing changes.
- Every sync writes a `sync_runs` row; the **Admin** page shows the last run per job and has "Run now" buttons.
- Known quirks: ESPN returns 404 for the box score of a few completed playoff events (the daily sync marks those as settled
  after 36h rather than failing); some two-way/exhibit players have position `NA` (no fantasy positions); injuries come
  from a separate feed and are cached on the player row; date *ranges* on the scoreboard are broken, so we use single days
  (`YYYYMMDD`) and whole months (`YYYYMM&limit=300`).
- **Fallbacks:** if ESPN breaks, the plan is `cdn.nba.com/static/json/liveData/...` for box scores (needs an ESPN<->NBA id map).
  TODO: not implemented yet (`nba-cdn.ts`); the adapter interface (`EspnClient`) is the seam to add it behind.

Jobs (`src/lib/nba/sync.ts`):

| Job | What it does | Triggered by |
| --- | --- | --- |
| `syncDaily` | teams, 30 rosters, injuries (also caches status on players), news, scoreboard for yesterday..+7 days, the season's schedule month by month, and a resumable backfill of final games' box scores (stops at ~40s, continues next run) | Vercel cron `/api/cron/daily` (09:00 UTC) |
| `syncCorrections` | re-pulls yesterday's (ET) final box scores for stat corrections | same daily cron |
| `syncLive` | today's (ET) scoreboard, then box scores for live games and games that finished in the last 3h. A fast no-op (no network) unless a game is live or tips off within the hour | GitHub Actions `/api/cron/live` every 5 min |
| `ensureFreshLive` | lazy refresh called by the scoreboard page: if a game is live/imminent and the last live sync is older than 60s, runs `syncLive` under a Postgres advisory lock; never throws into the page | page views |

The first daily run only backfills the **current** season. To load last season for draft prep run
`npm run sync:daily -- --season 2026` (repeat until `backfillRemaining` is 0; ~700 box scores take about 40s on a fast connection).

### Cron setup

1. **Vercel daily cron**: already in `vercel.json`; needs the `CRON_SECRET` env var on the Vercel project (Vercel sends it as the bearer token).
2. **GitHub Actions live sync** (`.github/workflows/live-sync.yml`, every 5 minutes from 21:00 to 07:59 UTC, about 5pm-2am Eastern in
   both DST and standard time). In the GitHub repo: **Settings -> Secrets and variables -> Actions**:
   - **Secret** `CRON_SECRET`: the same value as on Vercel.
   - **Variable** `APP_URL`: the deployed base URL, e.g. `https://your-app.vercel.app` (no trailing slash).
   Until `APP_URL` is set the workflow just logs a notice and succeeds. Run it by hand from the Actions tab (`workflow_dispatch`) to test.
   Scheduled workflows are paused by GitHub after 60 days without repo activity.
3. Even without the Action, opening the NBA Scoreboard during games refreshes live scores (at most once a minute).

### Local real data

```bash
npm run db:migrate
npm run sync:daily                      # live ESPN -> your local PGlite (or whatever DATABASE_URL is)
npm run sync:daily -- --season 2026     # also backfill last season's box scores
```

For a throwaway database: `DATABASE_URL=pglite:./.pglite-synctest npm run db:migrate && DATABASE_URL=pglite:./.pglite-synctest npm run sync:daily`, then delete the folder.
Offline, `npm run db:seed` loads the fixtures instead.

## Project layout

```
src/app/(auth)/{login,invite/[token],reset/[token]}   public auth pages
src/app/(app)/{page.tsx,admin}                         signed-in pages (layout enforces requireUser)
src/app/(app)/{players,players/[id],nba/scoreboard}    Players table, player card, NBA scoreboard
src/app/api/cron/{daily,live}/route.ts                 cron endpoints (use verifyCronRequest)
src/lib/nba/                                           ESPN adapter, normalizers, sync jobs, ET date util, queries
src/lib/fantasy/                                       default points scoring, projections
src/lib/auth/                                          tokens, argon2, session cookie, service (DB logic), zod schemas
src/lib/cron.ts                                        verifyCronRequest
src/db/{schema,index,migrate,seed}.ts   drizzle/       schema, client (PGlite or Neon), migrations
src/middleware.ts                                      redirects cookie-less visitors to /login
tests/  e2e/                                           Vitest and Playwright
```

## Security notes

- Session/invite/reset tokens are 32 random bytes (base64url); only sha256 hashes are stored.
- Session cookie: httpOnly, `secure` in production, sameSite=lax, 30-day sliding expiry.
- Login lockout: 5 consecutive failures lock that username for 15 minutes (stored in `login_attempts`).
- Middleware only checks that a session cookie is present; every page/action re-validates it in the DB
  via `requireUser()` / `requireAdmin()`.
