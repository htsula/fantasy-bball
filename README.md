# Fantasy Hoops

Private fantasy NBA app (H2H points) for a friend group. Next.js 15 (App Router) + TypeScript + Tailwind + shadcn/ui,
Postgres via Drizzle ORM, deployed on Vercel with Neon.

Status: feature complete (milestones 1-10), tuned for ~10-16 friends on phones using the site as a Home Screen app.

## Feature overview

- **Invite-only accounts**: the owner creates the first admin; everyone else joins through a league invite link (or a one-off site link).
- **Leagues**: points-only H2H, per-league scoring (ESPN defaults + a +4 team-win bonus), weekly round-robin schedule, playoffs (2/4/6/8 teams), standings, history and next-season rollover with keepers.
- **Draft**: async snake draft followed by simultaneous "waves", per-player queue, commissioner pick/undo, recap. Last season's FP is the default sort.
- **Rosters**: free agency with a daily add limit, drops, NBA cuts handled automatically, transactions feed.
- **Trades**: offers/counters, commissioner review or league veto vote, trade block.
- **Live scoring**: ESPN data synced by cron, live matchup page with box scores, scoreboard, projections.
- **Social**: league chat with @mentions and pinned announcements, activity log, in-app notifications and Web Push.
- **PWA**: installable, offline notice page, safe-area aware, works in light and dark mode.

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

Log in as your admin, open **Admin**, and generate a site-level invite link for a friend (single-use, 7 days; creates a plain account). League invites are different, see [Leagues](#leagues).
Reset links for forgotten passwords are generated per user on the same page (24 hours).

Stop the dev server before running `db:migrate`, `db:seed`, `create-admin` or `db:studio` against PGlite
(the embedded database should only be opened by one process at a time). To start over, delete `./.pglite`.

### Demo data (`npm run db:seed`)

`npm run db:seed` (local PGlite only, it refuses a real Postgres `DATABASE_URL`) loads the ESPN fixtures plus a realistic demo so `npm run dev` shows a full app:

- **Demo League**: 10 teams, mid-season, a completed snake + waves draft, finished weeks with standings, a live-ish current week (some games in progress), 2 executed trades, 1 rejected, 1 pending offer to `admin`, free-agent moves, a trade-block entry, chat with a pinned announcement.
- **Draft Night: Not Started / Snake / Waves**: three small leagues left at each stage of the draft room.
- NBA players and games are **invented** (the fixtures only hold one real roster); they use ids from 9,000,000 and are never refreshed from ESPN.

Local-only demo logins (values live in `src/db/seed.ts` and `src/lib/leagues/seed-demo.ts`): `admin` and `demo1` ... `demo9`, all with password `password123`.
Stop the dev server first and delete `./.pglite` to re-seed from scratch.

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
| `npm run e2e` | Playwright suite against a **production build** (`next build` + `next start` on :3100, throwaway PGlite DB). `E2E_DEV=1 npm run e2e` uses `next dev` instead. Both share `.next`, so stop your dev server first. First time: `npx playwright install chromium` |
| `npm run e2e:mobile` | Mobile pass on the demo data: every main page at 390x844 (iPhone-ish) and 412x915 (Android), light and dark; fails on sideways page overflow and saves screenshots to `./screenshots/<device>-<scheme>/` (gitignored) |
| `npm run db:generate` | Generate a SQL migration into `drizzle/` after editing `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations (PGlite or Postgres, depending on `DATABASE_URL`) |
| `npm run db:studio` | Drizzle Studio |
| `npm run db:seed` | Dev-only demo: `admin` / `password123`, ESPN fixtures and a 10-team mid-season Demo League (see Demo data); refuses to run against real Postgres |
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
| trade job (`processDueTrades`) | expires 7-day-old offers and finishes ended trade review windows (also runs on every live call and on page loads); see Trades | `/api/cron/daily`, `/api/cron/live`, `/api/cron/matchups`, `/api/cron/trades` |
| nightly matchup job | finalizes ended matchup periods (after all their games are final) and refreshes standings; see Matchups and standings | same daily cron, after the two syncs |
| `syncLive` | today's (ET) scoreboard, then box scores for live games and games that finished in the last 3h. Also refreshes `/injuries` (at most every 30 min) when a game tips within 90 minutes and takes tip-off snapshots. A fast no-op (no network) unless a game is live or tips off within 90 minutes | GitHub Actions `/api/cron/live` every 5 min |
| `ensureFreshLive` | lazy refresh called by the scoreboard page: if a game is live/imminent and the last live sync is older than 60s, runs `syncLive` under a Postgres advisory lock; never throws into the page | page views |

The first daily run only backfills the **current** season. To load last season for draft prep run
`npm run sync:daily -- --season 2026` (repeat until `backfillRemaining` is 0; ~700 box scores take about 40s on a fast connection).

### Cron setup

1. **Vercel daily cron**: already in `vercel.json`; needs the `CRON_SECRET` env var on the Vercel project (Vercel sends it as the bearer token).
2. **GitHub Actions live sync** (`.github/workflows/live-sync.yml`, every 5 minutes from 16:00 to 07:59 UTC, about noon-3am Eastern in
   both DST and standard time, so early tip-offs, the pre-game injury refresh and tip-off snapshots are covered). In the GitHub repo: **Settings -> Secrets and variables -> Actions**:
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

- **Invites:** the commissioner drops ONE reusable league invite link in the group chat (league's **Invite** page, with a Copy
  button) and everyone uses it. The link never expires; it works while it is not revoked, the optional "maximum teams" limit
  isn't reached, and the league is still in `setup` (it closes when the draft starts). A new person sets a
  username/password and their team name + abbreviation on the link; someone already logged in just names a new team
  ("Join {league} as a new team"). Every use creates a new user + team in one transaction and is recorded in
  `invite_redemptions`. Team names (2-30 chars) and abbreviations (2-4 letters) are unique per league, case-insensitively,
  and each user has one team per league. The Invite page lists each link (created, uses, Active/Revoked/Closed/Full) and who
  joined through it, with **Remove team** (setup only) to drop unwanted teams before the draft, **Revoke** to turn a link
  off, and **Create new link** (by default it revokes the old one). Raw tokens of league invites are stored (so the active
  link can be shown again; they are meant to be pasted in a chat). Site-level invites (Admin page), password resets and
  sessions stay hash-only; site invites are still single-use with a 7-day expiry and create a plain account.
- **House rules** (all in the league settings, validated by `src/lib/fantasy/settings.ts`): H2H points, scoring = ESPN
  defaults plus a +4 team-win bonus (see [Scoring](#scoring-and-the-win-bonus)), no lineups,
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
- **Player list order:** the draft list defaults to **last season's total fantasy points, descending** (league scoring, win bonus included), ties broken by
  projection, then name; players without a last season go last. It shows Last FP, Last FP/G, this season's FP/G and Proj; click a header to sort
  (`/api/leagues/:id/draft/players?sort=lastfp|lastavg|curavg|proj|name&dir=`). The "#" column is the rank under the active sort. "Last season" = the league season - 1.
- **Completion:** when every team has `maxRoster` players the league becomes `in_season`, the board turns into a recap and team pages show rosters
  (`roster_entries`, one active roster per player per league).
- **Concurrency:** every pick runs in one transaction with `SELECT ... FOR UPDATE` on the draft row, so two clicks on the same player produce one pick and one
  "just drafted" error. The draft state is always recomputed from the picks (`src/lib/draft/engine.ts`).
- The board polls every ~10s with SWR (and refreshes right after your own actions).
- **Keepers:** see [Seasons, history and keepers](#seasons-history-and-keepers). With keepers, each team drafts `maxRoster - keepers` players.

## Scoring and the win bonus

A player's fantasy points for one game = `sum(stat x league point value)` + the **team-win bonus** (default +4, editable in settings).

- The bonus applies when the player's NBA team won (the game is final), the player is in that game's **tip-off snapshot**, and the
  injury status recorded in that snapshot is not **Out** (case-insensitive). Playing time is irrelevant: a 0-minute bench winner, a
  coach's-decision DNP, a G-League assignee or a suspended player in the snapshot all earn it. Day-to-day/questionable players who sit still earn it too.
- A player **not** in the snapshot (traded away, signed after tip-off) gets no bonus for that game; his stats still count if he played.
- **Tip-off snapshots** (`game_roster_snapshots`): the first time a sync sees a game in progress (or already final), it records every active player on
  the two NBA teams with the injury status cached at that moment. Rows are insert-only, so later trades or injury-report edits never change
  past bonuses. A snapshot first taken 10+ minutes after the scheduled tip-off (or after the final) is flagged `late` but still counts.
  Snapshots are only taken for games that started in the last 8 hours (nothing is back-filled for old games).
  `syncLive` refreshes injuries at most every 30 minutes while a game is scheduled to tip within 90 minutes, so snapshots carry fresh statuses.
- **Who gets a game's points:** the fantasy team that had the player on its roster *at that game's tip-off*
  (`acquired_at <= tip-off < coalesce(released_at, infinity)`). A free agent added at 6pm scores in a 7pm game for his new team;
  a player dropped at 6pm scores nothing for the team that dropped him. Stats count live during a game; the bonus appears once it is final.
  The engine is `src/lib/fantasy/scoring.ts` (pure) and `src/lib/fantasy/team-points.ts` (per team/day/player; used by the matchup engine).
- **Players page / projections:** the Players table and draft ranking use FP including the bonus. For past games without snapshots the bonus is
  *approximated*: eligible when the player has a box-score row and is not a DNP whose reason mentions an injury or illness. FP/G averages over
  the games he scored in (played, or an eligible DNP). Projection = blended stat projection + expected bonus (`teamWin x team win%`, 0 when currently Out).
- **Season selector:** the Players table has a **Season** select (current season and last season, labelled like `2025-26`; only seasons with a final
  regular-season game are offered). Default = the current season once it has a final game, otherwise last season (so preseason shows last year). The 7/15/30-day ranges
  look back from today, so they apply to the current season only and are disabled for last season. In a league the Players tab uses that league's scoring values
  and win bonus. The FP column header explains that it includes the +4 win bonus. The player card has a **Fantasy by season** table (GP, MIN, FP/G, FP, win bonus)
  and a game log season switch; My Team and the trade builder show Last FP/G and Last FP. "Current season" = the newest regular-season schedule held, never behind the
  calendar (July onwards counts as next season).

## Matchups and standings

Pages (league nav): **Matchup** (redirects to your current matchup), **Scoreboard** (`?period=N`, previous/next), **Standings**, and the
**Schedule** (now with scores and box-score links). The overview shows your matchup card, a standings snapshot and recent transactions;
the draft card disappears once the draft is complete.

- **A period's score** = the sum of `team-points.ts` over the period's ET date range: 00:00 ET on the start date through 23:59:59 ET on the end
  date, judged by **tip-off**. A 10:30pm ET Sunday game (Monday in UTC) belongs to that Sunday's period. Totals include the win bonus
  (shown separately as "Bonus"); the bonus only appears once a game is final, stats count live.
- **Games played / left / projected:** *played* = player-games that scored for the team (stat row and/or tip-off snapshot, in-progress or final);
  *left* = scheduled games in the period for the players **currently** on the roster; *projected* = points so far + the sum of each remaining
  game's per-game projection (`projections.ts`, bonus included). Ended periods project to their actual score.
- **Caching:** `matchup_team_totals` holds the last computed totals. Viewing a matchup/scoreboard runs `ensureFreshLive` first, then reuses the cache
  if it is under ~60s old, otherwise recomputes. The matchup page polls `/api/leagues/:id/matchups/:matchupId?view=` every 30s (SWR) only while a
  game is live. `standings` caches the ranked table (rebuilt at finalization and by the nightly job; computed on the fly when the cache is empty).
- **Finalizing a period** (`finalizePeriod` in `src/lib/matchups/service.ts`) happens only when the period's last ET day is over **and** every NBA
  game in its window is final/postponed. The nightly job runs from `/api/cron/daily` right after `syncDaily` + `syncCorrections` (so the correction
  re-pull of yesterday's finals has landed), finalizes each in-season league's ended periods, and re-finalizes periods that ended in the last 3 days so
  a late stat correction can fix a score or flip a winner. It is idempotent; owners are notified (`matchup_results`, in-app and push on by default)
  only the first time a matchup becomes final. `/api/cron/matchups` (same `CRON_SECRET` bearer) runs just this job, without any NBA network calls.
- **Results:** a tie is an equal score at 0.01 precision. **Byes** are not games: no W/L/T, no points for/against, no notification, no streak entry.
  Playoff periods are not part of the standings.
- **Standings tiebreakers** (`src/lib/fantasy/standings.ts`): win % (a tie is half a win), then head-to-head among the tied teams (applied once to the
  whole tied group; teams that never met are neutral), then points for, then points against (lower is better), then team name. Games back =
  ((leader W - L) - (W - L)) / 2. The line under rank `playoffTeams` marks the playoff cut; clinch markers are not implemented.
- **E2E fixture:** `npm run db:seed-e2e-matchups` (run by the Playwright web server) builds an in-season league with hand-made games, box scores and
  snapshots, so `e2e/matchups.spec.ts` needs no network. It refuses to run against a real Postgres database.

## Playoffs

The last `rounds x playoffRoundLength` periods of the schedule are the playoffs (`rounds = ceil(log2(playoffTeams))`). Code: `src/lib/playoffs/service.ts`
(DB) and `src/lib/fantasy/bracket.ts` (pure bracket math). Page: **Playoffs** in the league nav (rounds as columns, stacked on mobile).

- **Seeding:** the nightly job (`runNightlyMatchupJob`) seeds the bracket as soon as **every regular-season matchup is final**: the top `playoffTeams` of the final
  standings, league status `playoffs`, owners notified ("You made the playoffs", `league_events`). Standard bracket: 8 teams 1v8, 4v5, 2v7, 3v6 then 1v4-side
  and 2v3-side; 4 teams 1v4, 2v3; 2 teams a single final; **6 teams: seeds 1 and 2 get a bye**, 3v6 and 4v5 play, then 1 meets the 4/5 winner and 2 the 3/6 winner.
  The bracket is fixed (no re-seeding between rounds). Labels: Quarterfinal, Semifinal, Final (counted from the last round).
- **Storage:** `playoff_slots` (league, round, slot, both teams and seeds, the two source slots, winner). A **bye** is a round-1 slot with a single team: it has
  **no matchup row** (it is not a game) and its winner is set at seeding. Real slots get **one `matchups` row per period of the round**
  (`matchups.playoff_slot_id`), the better seed as home, so scoreboard, schedule, box score and notifications work unchanged.
- **2-period rounds** (`playoffRoundLength = 2`): both periods get a matchup row, and the slot winner is decided on the **combined points** of both once both
  are final. **Ties** (0.01 precision) go to the **higher seed**.
- **Advancing:** after a playoff period is finalized, finished slots get winners, winners move into the next slot and the next round matchups are created
  (only for slots that have none, so re-running never duplicates). After the final: champion and runner-up are recorded, `season_results` is written, the league
  becomes `complete` and everyone gets "{team} are champions!" (`league_events`, in the notification preferences). The job loops until nothing changes, so a
  missed night catches up. Non-playoff teams simply play nothing during the playoff periods (**no consolation bracket**).
- **Corrections:** the nightly job still re-finalizes periods for 3 days. A stat correction that **flips a decided playoff game is applied only while the next
  round has no matchups yet**; afterwards (or after the league is complete) it logs a warning (also in the job result `warnings`) and leaves the winner alone for
  the commissioner to fix. Regular-season corrections after seeding do not re-seed (use Re-seed while it is allowed).
- **Commissioner tools** (Playoffs page): **Re-seed playoffs** rebuilds the bracket from the current standings, only before round 1 starts (no round-1 matchup is
  final and no NBA game of round 1 has tipped off). **Set winner manually** overrides one game (it needs both teams; the unplayed matchups of the next round are rebuilt;
  refused if the next round already has a decided game). The override is logged on the slot (who, when, note, shown on the bracket) and the nightly job never
  recomputes it. Overriding the final of a completed league rewrites the season results without announcing a second champion.
- **Standings page:** the line under the playoff cut is shown; clinch/elimination markers are not implemented.
- **E2E hook:** `POST /api/cron/matchups?leagueId=...&now=<ISO>` runs the job for one league as of a given moment. `now` is honored **only against PGlite** (dev/e2e),
  never against a real database. `npm run db:seed-e2e-playoffs` builds the 4-team "Playoff League" used by `e2e/playoffs.spec.ts`.

## Seasons, history and keepers

Every season is its own league row. `leagues.previous_league_id` links a season to the one before it (unique, so a season can be rolled over once) and
`teams.previous_team_id` links the same franchise. Code: `src/lib/seasons/service.ts`.

- **Start next season** (commissioner, league `complete`; button on **History**): creates a league with the same name and commissioner, season + 1, status `setup`, settings
  copied with **all dates cleared** (season start/end, trade deadline, keeper deadline: the season dates re-derive from the NBA schedule when you generate
  the schedule), and a new team for every old team (same owner, name, abbreviation). Rosters do not carry over. Owners can rename teams, the commissioner can
  remove teams and invite new people with the normal reusable invite link, then generate the schedule and start the draft as usual. Owners are notified.
- **History** (`/leagues/:id/history`): the whole chain of seasons (back and forward from any season), a champions list with trophies, and each season final
  standings from `season_results` (rank, record, points, playoff result: champion, runner-up, semifinal, quarterfinal, missed). Season links appear only for
  seasons you have a team in. `season_results` is written when the league completes: final rank = champion, runner-up, then by how deep a team went in the playoffs,
  then regular-season rank. Team pages show that owner past finishes; **/leagues** groups past seasons (ones a newer season was started from) separately.
- **Keepers** (`keepers` setting, default 0): during `setup` each owner picks up to `keepers` players from their **previous season final roster** who are still
  **active on an NBA roster** (**Keepers** page in the nav; the commissioner can edit every team, and may set an optional **keeper deadline** that only stops owners).
  The limit is capped by roster space: `keepers <= maxRoster - snakeRounds` (checked when you save the setting for the current team count, on selection, and again
  when the draft starts, since the team count changes the numbers). With the default draft settings and 4 or fewer teams the whole draft is snake, so there is no room for keepers.
  The setting locks once the draft starts.
- **In the draft:** starting it re-checks every keeper (anyone no longer active is dropped), puts the keepers on their rosters (`roster_entries.acquired_via = keeper`), and
  removes them from the pool and all queues. The **snake phase is unchanged**; keepers only shorten the **wave** phase: a team with k keepers has `picks + k` toward every
  wave target and the completion check, so it owes k fewer wave picks (possibly none for a whole wave) and drafts `maxRoster - k` players in total. Undo never removes a keeper.

## Free agency and rosters

Open only while the league is `in_season` or `playoffs` (not during setup/drafting). It is instant and first come, first served; no waivers.

- **2 adds per team per ET day** (`addsPerDay` setting; resets at midnight ET). **Drops are unlimited.** An add with a drop in the same action is allowed;
  the drop doesn't count against the limit, the add does. The league **Players** tab shows "Adds left today".
- **Max roster** = `min(50, floor(520 / teams))` (the value locked when the draft started). A team may be under it, never over: at the max, **Add** opens a
  dialog to choose the player to drop.
- Concurrency: each move runs in one transaction that locks the league row, so two teams adding the same player produce one winner and a `player_taken` error.
- **My Team** (`/leagues/:id/teams/:id`): roster grouped by NBA team (record, games this week), roster count, injury badges, today's game, season/last-15 averages,
  projection, and the FP/win-bonus the player earned *for this team* over season / 7 / 15 / 30 days. Drop has a confirmation.
- **Transactions** tab: adds, drops, cuts and commissioner moves with team/type filters. Everyone gets an in-app note for league transactions (push is off by default).
- **Cut players disappear:** after a daily sync in which **all 30 rosters loaded**, players who are inactive or on no NBA team are released from every
  fantasy roster (`auto_drop`, logged, owner notified). If any roster failed to load nobody is dropped. The commissioner can **restore** an auto-dropped
  player from the Transactions tab (reopens the original roster entry if he is still unrostered and the team has room).
- **Commissioner tools:** add a free agent to any team (skips the daily limit, not the roster max) from that team's page, and drop any player.

## Trades

Trades are the main way to improve (almost every NBA player is owned). They are open only while the league is `in_season` (not setup, drafting, playoffs
or complete) and until the **trade deadline** setting, which is the end of that ET day (empty = no deadline). They don't count against the 2-adds-per-day limit.

- **Proposing:** one team offers any number of its players for any number of another team's players (1+ in total, uneven is fine, one-sided is fine) plus an
  optional message. Builder: `/leagues/:id/trades/new?with=<teamId>` (also reached from a team's **Propose trade** button, a **Trade for** button on rostered
  players in the Players tab and the trade block). It shows NBA team, positions, injury, FP/G, projection and expected win bonus per game, a side-by-side summary
  with total projected FP/G and the roster size after the trade against the max (with a warning when over).
- **Lifecycle:** `proposed` -> the receiver can **accept**, **reject** or **counter** (a new offer back with edited lists, linked via `countered_from`; the original
  becomes `countered`); the proposer can **cancel** while it is `proposed`. Offers **expire after 7 days** (`expired`).
- **Review** (the `tradeReview` league setting):
  - `none`: accepting executes the trade immediately.
  - `commissioner`: accepting makes it `pending_review` for `tradeReviewHours` (default 24). The commissioner can **approve** (executes now) or **veto** (optional
    reason). If nobody acts the trade is **auto-approved and executed when the window ends**. A commissioner who is a party to the trade may still decide; this is
    recorded on the trade and its transactions.
  - `league_vote`: `pending_review` for the window; the teams that are not part of the trade can vote (veto counts, approve is stored). When veto votes reach
    `vetoVotesNeeded` (**capped at the number of eligible voters**, e.g. 4 needed with 2 eligible teams means 2) the trade is `vetoed` immediately; otherwise it
    executes when the window ends. Each team votes once. League-vote requests are in-app only (no push).
  - A review window of 0 hours means no review.
- **Execution** is one transaction that locks the league row. It checks that every player is still on the team offering him (else the trade is `invalidated`,
  `players_moved`), the league is still `in_season`, and **both rosters are at or under the max after the swap** (else `roster_full`: nothing is auto-dropped; the
  UI says to drop players first, and accepting such an offer fails and leaves it open). A trade that runs into `roster_full` when its review window ends is
  `invalidated` instead (it can't wait forever); a commissioner approval just errors and the trade stays pending. Roster entries are released and re-created at one
  timestamp (`released_via`/`acquired_via` = `trade`), so a game tipping at or after that instant scores for the new team and earlier games stay with the old one.
  Each moved player is logged as a `trade` transaction (grouped by the trade id; the Transactions tab shows one row per trade).
- **Deadline vs. review:** the deadline is checked when a trade is proposed, countered and accepted. A trade accepted before the deadline still executes when its
  review window ends after the deadline.
- **Auto-invalidation:** executing a trade, dropping or cutting a player (drop, add-with-drop, commissioner drop, NBA auto-drop) invalidates every other open
  (`proposed`/`pending_review`) trade that includes that player, and both parties are notified. Two simultaneous accepts of trades sharing a player: one executes,
  the other is `invalidated`.
- **Commissioner tools** (on the trade page): force-cancel any open trade, and **reverse** an executed trade within 48 hours, provided every player is still on the
  team he went to and both rosters fit. A reversal creates a `reversal` trade record that moves everyone back (logged as commissioner add/drop transactions); the
  original becomes `reversed`.
- **Trade block** (`/leagues/:id/trades/block`): owners list players with a note (also from the Block button on their team page). Everyone sees them, and an
  "On the block" badge shows on the team page. Entries disappear when the player is traded or dropped.
- **Pages:** `/trades` hub (Received / Sent / League (pending review, with vote buttons and countdown) / History), `/trades/new`, `/trades/:tradeId` (players,
  stats, timeline, actions by role). The league nav shows a badge with the number of offers waiting for you.
- **Closing windows without waiting for a person:** `processDueTrades` expires old offers and finishes ended review windows. It runs in `/api/cron/daily`, on every
  `/api/cron/live` call (one cheap query when nothing is due), in `/api/cron/matchups`, in `/api/cron/trades` (same `CRON_SECRET` bearer), and lazily whenever someone
  opens the Trades hub or a trade page, so windows close promptly even if a cron run is missed.
- **Notifications** (Settings -> Notifications): `trade_offers` (offer/counteroffer received), `trade_updates` (accepted, rejected, cancelled, expired, vetoed, executed,
  invalidated, reversed) and `trade_review` (commissioner asked to review: push on; league asked to vote: in-app only). Other teams also get an in-app
  `league_transactions` note when a trade completes.
- **Schema:** `trades` (with `kind` = `trade` | `reversal`, `expires_at`), `trade_items`, `trade_votes` (one per team), `trade_block`. Engine (pure): `src/lib/trades/engine.ts`;
  service: `src/lib/trades/service.ts`; invalidation helper (called by the roster service): `src/lib/trades/invalidate.ts`.

## Chat and announcements

Every league has a chat at `/leagues/<id>/chat` (nav: **Chat**, with an unread badge).

- Members post plain text (max 2000 characters, at most 10 messages per minute). Bodies are stored raw and rendered as React text nodes, so HTML is never interpreted. Only `http(s)` URLs become links. `@username` is highlighted when it names a league member and notifies that member (`chat_mentions`, push on by default). Everyone else can opt in to `chat_messages` (off by default for push and in-app).
- Authors edit their own messages for 15 minutes and delete them any time (soft delete). The commissioner can delete any message and pin or unpin messages (pinned ones sit at the top). Commissioner deletes and pins are written to the activity log.
- The page polls every 10 seconds, newest at the bottom, with "Load older messages".
- The commissioner posts **announcements** from the commissioner page. They are highlighted in the chat, shown on the league overview, and notify every member (`league_announcements`, push on).

## Activity

`/leagues/<id>/activity` is one filterable timeline for the league: roster moves (adds, drops, NBA cuts, commissioner moves), trade events, draft events (start, commissioner picks, undos, restarts, completion), playoffs, settings changes, team joins/renames/removals/ownership changes, and other commissioner actions. It is written by the services themselves (`logActivity`, inside the same transaction as the change). There is no backfill: it starts when the feature ships. Commissioner actions always show their actor. The older **Transactions** page (adds and drops only) stays and is linked from the activity page.

## Commissioner tools

`/leagues/<id>/commissioner` (commissioner only; the nav item is hidden for everyone else) collects:

- **Announcements**, **members and teams** (rename, abbreviation, transfer a team to another existing user who has no team in the league, remove a team in setup, invite link). The commissioner's own team can't be given away: hand over the role first.
- **Commissioner role**: transfer to another team owner (confirmation; the old commissioner loses the tools immediately).
- **Rosters**: add or drop for any team and restore players the NBA cut. Affected owners get a `commissioner_actions` notification.
- **Score adjustments**: a signed point change with a required reason, per team per matchup. It counts in the matchup total, results, standings and playoff advancement, and the matchup page shows "Commissioner adjustment +X (reason)". Final matchups are recalculated at once. In the playoffs, if the next round already started the bracket is not changed and a warning is shown (use the playoff winner override); adjusting a regular-season matchup after seeding warns that the seeds were not recomputed.
- **Draft**: restart while the draft is in progress (type the league name). It deletes all picks and drafted/kept roster entries, removes the draft row and returns the league to setup so it can be started again. Teams' queues and keeper selections are kept.
- **Trades and playoffs**: open trades with force-cancel, plus links to the existing tools and settings.

Every action is logged with the commissioner's username.

## Notifications and PWA

The app is an installable PWA (`src/app/manifest.ts`, icons in `public/icons`, regenerate with `node scripts/generate-icons.mjs`) with a service worker
(`public/sw.js`) that handles Web Push and shows `public/offline.html` when a page load fails offline (it deliberately caches nothing else: stale fantasy data is worse than an offline notice). A new worker takes over immediately and the app offers a "Reload" toast. In-app notifications (the header bell, **/notifications**) always work; push needs VAPID keys.

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

## Deploy checklist

1. **Vercel env vars** (Production; Preview as needed): `DATABASE_URL` (set by the Neon integration), `CRON_SECRET`, `NEXT_PUBLIC_APP_URL` (`https://your-app.vercel.app`), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:you@example.com`). Never commit them.
2. **GitHub Actions** (live scores every 5 min): secret `CRON_SECRET` (same value as Vercel) and variable `APP_URL` (same as `NEXT_PUBLIC_APP_URL`, no trailing slash).
3. Deploy (`vercel-build` migrates, then builds). Create the owner account: `DATABASE_URL='postgres://...' ADMIN_PASSWORD='...' npm run create-admin -- --username you`.
4. One-time backfill of last season for draft prep: `DATABASE_URL='postgres://...' npm run sync:daily -- --season 2026` (repeat until `backfillRemaining` is 0).
5. Check the daily cron: `curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/cron/daily` returns JSON with `"ok": true`.
6. On your phone: open the site, Add to Home Screen, **Settings -> Notifications -> Enable**, send a test.

## Owner how-tos

- **Create the owner account**: `ADMIN_PASSWORD='...' npm run create-admin -- --username you` (against production by setting `DATABASE_URL`). Helper scripts for Windows live in `./local/` (gitignored).
- **Reset a password**: `npm run create-admin -- --username them --reset`, or generate a 24-hour reset link on the **Admin** page.
- **Invite friends**: open the league, **Invite -> Create invite link**, paste it in the group chat. It is reusable until the draft starts; new people create their account from it, existing users just pick a team name.
- **Start the draft**: generate the schedule first (league **Schedule**), check **Settings** (roster pool, snake target, dates), then **Draft -> Start draft**. The order is randomized; stalled teams can be picked for under **Commissioner controls**.
- **Fix a mistake**: the **Commissioner** page can adjust matchup scores, restore a player cut by the NBA, reverse a trade and transfer ownership; every action is in the **Activity** log.

## Logs and monitoring

The server writes structured JSON lines (`src/lib/log.ts`): `{"time","level","event","ctx":{...},"error":{...}}`. Secrets (passwords, tokens, cookies, push keys/endpoints) are redacted by key name.
In Vercel open **Project -> Logs**, then filter by **Level** (error/warning) or search for an `event`, for example:

| Event | Meaning |
| --- | --- |
| `cron.daily`, `cron.live` | One summary per cron run (`ok`, `durationMs`, per-job results). Level `error` when something failed. |
| `cron.daily.crashed`, `cron.live.crashed` | The job threw; the error and stack are in the line. |
| `sync.failed`, `sync.run_*_not_recorded` | An NBA sync job failed (also visible on the **Admin** page). |
| `push.send_failed`, `notify.failed` | Web Push / notification delivery problems (never break the request). |
| `request.error` | Any unhandled server error (page, route handler or server action) with the route and its `digest`. |

The error page shows "Reference: <digest>" to the user: search that digest in the logs to find the matching `request.error`.
Cron endpoints return the same summary as JSON, so a failing GitHub Action run shows the cause in its log.

## Troubleshooting

- **Live scores are stale**: check the GitHub Action runs (Actions tab; scheduled workflows pause after 60 days without repo activity), that `APP_URL`/`CRON_SECRET` match, and the `cron.live` lines in Vercel Logs. Opening the NBA Scoreboard also refreshes at most once a minute.
- **Cron returns 401**: `CRON_SECRET` differs between caller and Vercel, or is unset (fails closed).
- **No push on iPhone**: only works from the Home Screen app (iOS 16.4+); enable it inside the installed app. Check the three VAPID variables exist in Production and redeploy.
- **Players list is empty / no last-season stats**: run the sync (**Admin -> Run syncDaily now**) and the one-time `--season 2026` backfill.
- **Old version after a deploy**: the app shows "A new version is available. Reload" when the service worker updates; force-quit the Home Screen app if you never see it.
- **`db:seed` / `create-admin` hang or fail locally**: PGlite allows one process; stop `npm run dev` first.
- **`npm run e2e` fails immediately**: stop any server on :3100, and a running `next dev` (it shares `.next`).

## Project layout

```
src/app/(auth)/{login,invite/[token],reset/[token]}   public auth pages
src/app/(app)/{page.tsx,admin}                         signed-in pages (layout enforces requireUser)
src/app/(app)/{players,players/[id],nba/scoreboard}    Players table, player card, NBA scoreboard
src/app/(app)/leagues/...                              leagues list/new, league home, settings, schedule, teams, invite
src/lib/leagues/                                       league service (create, settings, invites, teams, schedule)
src/lib/draft/                                         draft engine (pure math), service (start/pick/undo/queue), board read models
src/lib/notifications/                                 notify() (in-app + Web Push), preferences, subscriptions
src/app/api/cron/{daily,live,matchups,trades}/route.ts        cron endpoints (use verifyCronRequest)
src/lib/trades/                                        trade engine (pure), service (propose/counter/review/execute/reverse/block), invalidation
src/lib/matchups/                                      matchup totals, finalization, standings cache, box-score read model, nightly job
src/lib/playoffs/                                      bracket seeding, advancement, completion, re-seed / override (bracket math in fantasy/bracket.ts)
src/lib/seasons/                                       season rollover, history, keepers
src/lib/nba/                                           ESPN adapter, normalizers, sync jobs, ET date util, queries
src/lib/fantasy/                                       points scoring, projections, league settings, roster sizing, schedule generator
src/lib/auth/                                          tokens, argon2, session cookie, service (DB logic), zod schemas
src/lib/cron.ts                                        verifyCronRequest
src/lib/log.ts, src/instrumentation.ts                 structured logging, onRequestError hook
src/components/{nav,ui/skeleton,error-view}            scrollable nav, loading skeletons, error / not-found views
src/db/{schema,index,migrate,seed}.ts   drizzle/       schema, client (PGlite or Neon), migrations
src/middleware.ts                                      redirects cookie-less visitors to /login
tests/  e2e/  e2e-mobile/                              Vitest, Playwright (production build), mobile screenshot pass
```

## Security notes

- Session/invite/reset tokens are 32 random bytes (base64url); only sha256 hashes are stored (exception: reusable league invite links also keep the raw token so the commissioner can re-copy them).
- Session cookie: httpOnly, `secure` in production, sameSite=lax, 400-day sliding expiry (the browser maximum), refreshed on every visit, so players effectively never sign in again on the same browser. Logout or a password reset ends it.
- Login lockout: 5 consecutive failures lock that username for 15 minutes (stored in `login_attempts`).
- Middleware only checks that a session cookie is present; every page/action re-validates it in the DB
  via `requireUser()` / `requireAdmin()`.
