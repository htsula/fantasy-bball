# Fantasy Hoops

Private fantasy NBA app (H2H points) for a friend group. Next.js 15 (App Router) + TypeScript + Tailwind + shadcn/ui,
Postgres via Drizzle ORM, deployed on Vercel with Neon.

Status: **Milestone 1 (Foundation)** - invite/password auth, site-admin page, DB, cron scaffolding. Leagues and the rest follow.

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
ADMIN_PASSWORD='s3cret-pass' npm run create-admin -- --username alice --display-name "Alice"
# PowerShell
$env:ADMIN_PASSWORD='s3cret-pass'; npm run create-admin -- --username alice
```

If `ADMIN_PASSWORD` is unset you are prompted (input hidden). Password minimum is 8 characters.
It uses whatever `DATABASE_URL` points at, so run it against production the same way (see below).

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
| `npm run db:seed` | Dev-only seed (`admin` / `password123`); refuses to run against real Postgres |
| `npm run create-admin -- --username X` | Create a site admin |

## Environment variables

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Postgres URL (Neon). Unset or `pglite:<dir>` uses embedded PGlite. `pglite:memory://` is in-memory. |
| `CRON_SECRET` | Required for `/api/cron/*`; requests need `Authorization: Bearer <secret>`. Vercel Cron sends it automatically. |
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
6. `vercel.json` registers a daily cron hitting `/api/cron/daily` (a stub for now). Verify with
   `curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/cron/daily` -> `{"ok":true}`.

Before deploying a new migration, read the generated SQL in `drizzle/`: added tables/columns are
safe, but drops and renames can destroy data.

## Project layout

```
src/app/(auth)/{login,invite/[token],reset/[token]}   public auth pages
src/app/(app)/{page.tsx,admin}                         signed-in pages (layout enforces requireUser)
src/app/api/cron/daily/route.ts                        cron stub (uses verifyCronRequest)
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
