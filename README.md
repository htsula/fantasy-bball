# Fantasy Hoops

Private fantasy NBA app (H2H points) for a friend group. Next.js 15 (App Router) + TypeScript + Tailwind + shadcn/ui,
Postgres via Drizzle ORM, deployed on Vercel with Neon.

Status: **Milestone 4 (Draft + push notifications)** on top of Milestone 3 (Leagues), Milestone 2 (NBA data: ESPN sync, crons, Players browser, NBA scoreboard) and Milestone 1 (auth, admin, DB). The draft, rosters, scoring and the rest follow.

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
| `npm run vapid:generate` | Print a new Web Push VAPID key pair to the console (never written to a file) |

## Environment variables

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Postgres URL (Neon). Unset or `pglite:<dir>` uses embedded PGlite. `pglite:memory://` is in-memory. |
| `CRON_SECRET` | Required for `/api/cron/*`; requests need `Authorization: Bearer <secret>`. Vercel Cron sends it automatically. GitHub Actions needs the same value as an Actions **secret** (see Cron setup). |
| `NEXT_PUBLIC_APP_URL` | Base URL used in invite/reset links, e.g. `https://your-app.vercel.app`. Falls back to the request host. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push. All three or push is skipped (in-app notifications still work). See **Notifications and PWA**. |
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

## Leagues

Site admins create leagues (**Leagues -> Create league**); the creator becomes the commissioner and names their own team.
A league's `season` is the ESPN season year (2027 = 2026-27).

- **Invites:** the commissioner makes single-use league invite links (7 days) on the league's **Invite** page. A new person
  sets a username/password and their team name + abbreviation on the link; someone already logged in just names a new team
  ("Join {league} as a new team"). Team names (2-30 chars) and abbreviations (2-4 letters) are unique per league,
  case-insensitively, and each user has one team per league. Site-level invites (Admin page) still create a plain account.
- **House rules** (all in the league settings, validated by `src/lib/fantasy/settings.ts`): H2H points, scoring = ESPN
  defaults plus a +4 team-win bonus (the setting exists; the bonus is applied in the scoring milestone), no lineups,
  max roster = `min(50, floor(520 / teams))`, snake rounds = `min(floor(200 / teams), maxRoster)` then waves of 2,
  2 free-agent adds per team per day. The league page shows the computed roster/snake/wave numbers live; the roster, snake and
  wave fields are locked once the league leaves `setup` (scoring stays editable). Everyone in a league sees a plain-language rules summary.
- **Schedule:** the commissioner generates it from the league's **Schedule** page while the league is in setup. Weekly Mon-Sun (ET) periods
  start on opening night, an All-Star break gap (4+ days without NBA games) is merged into the neighbouring weeks, the last
  playoff-rounds x round-length periods are reserved for the playoffs (their matchups are created later), and regular-season
  matchups are a round robin (byes for odd team counts). Season start/end default to the first/last regular-season game in
  `nba_games`; if the NBA schedule isn't loaded for the season, enter the dates in settings and the generator uses those
  (without the All-Star merge). Adding or removing a team clears the schedule.
- **Access:** only teams' owners and site admins can see a league; only the commissioner edits.
- `npm run db:seed` also creates a **Demo League** (admin plus `demo1`-`demo3`, password `password123`) for local development.

## Draft

The commissioner starts the draft from the league's **Draft** tab (it needs a generated schedule that includes every team).
Starting it locks the roster/snake/wave settings, shuffles the order with a crypto RNG and moves the league to `drafting`.

- **Snake phase:** `snakeRounds = min(floor(200 / teams), maxRoster)` rounds; the team on the clock is shown with how long it has been
  waiting. Pushes: "You're on the clock" to the next picker and "You're 2 picks away" to the team after next.
- **Wave phase:** the remaining rounds are drafted in simultaneous waves of 2 picks per team (the last wave is 1 pick when the remainder is odd).
  A wave ends once every team has used its quota, then the next one opens and everyone gets a push. First come, first served.
- **No timer, no autopick.** The commissioner can **pick for a team** that has the turn / wave quota and **undo the last pick** (steps back through
  waves, into the snake phase, or out of a completed draft). Undoing a finished draft is refused once rosters have changed.
- **Queue:** every team can build a private queue before and during the draft (reorder with the arrows). Drafted players leave every queue.
- **Completion:** when every team has `maxRoster` players the league becomes `in_season`, the board turns into a recap and team pages show rosters
  (`roster_entries`, one active roster per player per league).
- **Concurrency:** every pick runs in one transaction with `SELECT ... FOR UPDATE` on the draft row, so two clicks on the same player produce one pick and one
  "just drafted" error. The draft state is always recomputed from the picks (`src/lib/draft/engine.ts`).
- The board polls every ~10s with SWR (and refreshes right after your own actions).
- **Keepers: deferred.** There are no keepers in the first season; the `keepers` setting exists but nothing uses it yet.

## Notifications and PWA

The app is an installable PWA (`src/app/manifest.ts`, icons in `public/icons`, regenerate with `node scripts/generate-icons.mjs`) with a service worker
(`public/sw.js`) that only handles Web Push. In-app notifications (the header bell, **/notifications**) always work; push needs VAPID keys.

1. Generate keys once: `npm run vapid:generate` (prints to the console only).
2. **Vercel:** Project -> Settings -> Environment Variables, add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (e.g. `mailto:you@example.com`)
   for Production, then redeploy. **Local:** the same three lines in `.env.local`. Never commit them; keep the same pair forever (changing it
   invalidates every device's subscription).
3. Each person opens **Settings -> Notifications** (`/settings/notifications`), taps **Enable notifications on this device**, then **Send test notification**.
   They can switch each type (on the clock, wave open, 2 picks away, draft events) on/off for push and in-app separately.
4. **iPhone/iPad:** push only works for the installed app. Open the site in Safari -> Share -> **Add to Home Screen**, open it from the new icon, then
   enable notifications there (the settings page shows this guidance when it detects iOS Safari outside the Home Screen app).

Push is sent after the database transaction commits, never throws into the request, and subscriptions that return 404/410 (or fail repeatedly) are deleted.
Tests inject a fake sender (`setPushSender`), so no network or keys are needed.

## Project layout

```
src/app/(auth)/{login,invite/[token],reset/[token]}   public auth pages
src/app/(app)/{page.tsx,admin}                         signed-in pages (layout enforces requireUser)
src/app/(app)/{players,players/[id],nba/scoreboard}    Players table, player card, NBA scoreboard
src/app/(app)/leagues/...                              leagues list/new, league home, settings, schedule, teams, invite
src/lib/leagues/                                       league service (create, settings, invites, teams, schedule)
src/lib/draft/                                         draft engine (pure math), service (start/pick/undo/queue), board read models
src/lib/notifications/                                 notify() (in-app + Web Push), preferences, subscriptions
src/app/api/cron/{daily,live}/route.ts                 cron endpoints (use verifyCronRequest)
src/lib/nba/                                           ESPN adapter, normalizers, sync jobs, ET date util, queries
src/lib/fantasy/                                       points scoring, projections, league settings, roster sizing, schedule generator
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
