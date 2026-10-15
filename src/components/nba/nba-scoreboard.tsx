import Link from "next/link";
import { and, asc, gte, lt } from "drizzle-orm";
import { db } from "@/db";
import { nbaGames, nbaTeams, type NbaGame, type NbaTeam } from "@/db/schema";
import { AutoRefresh } from "@/components/nba/auto-refresh";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { addDays, etDateString, etDayRange, isEtDateString } from "@/lib/nba/dates";
import { fmtEtDate, fmtEtTime } from "@/lib/nba/format";
import { ensureFreshLive } from "@/lib/nba/sync";

function statusText(g: NbaGame): string {
  switch (g.status) {
    case "scheduled":
      return `${fmtEtTime(g.startTime)} ET`;
    case "in":
      return g.statusDetail ?? "Live";
    case "postponed":
      return "Postponed";
    default:
      return g.statusDetail ?? "Final";
  }
}

function TeamLine({ team, fallbackId, score, winner }: { team?: NbaTeam; fallbackId: number; score: number | null; winner: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        {team?.logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={team.logo} alt="" width={28} height={28} className="size-7" loading="lazy" />
        ) : (
          <span className="size-7" />
        )}
        <span className={winner ? "font-semibold" : ""}>{team ? `${team.location} ${team.name}` : `Team ${fallbackId}`}</span>
      </div>
      <span className={`text-lg tabular-nums ${winner ? "font-bold" : ""}`}>{score ?? ""}</span>
    </div>
  );
}

/**
 * The NBA scoreboard for one ET day. Rendered site-wide (/nba/scoreboard) and inside a league
 * (/leagues/<id>/nba-scoreboard); `basePath` keeps the day navigation on the route it was opened from.
 */
export async function NbaScoreboard({
  searchParams,
  basePath,
  inLeague = false,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  basePath: string;
  inLeague?: boolean;
}) {
  const sp = await searchParams;
  const requested = Array.isArray(sp.date) ? sp.date[0] : sp.date;
  const today = etDateString(new Date());
  const date = isEtDateString(requested) ? requested : today;

  // Viewing today: refresh live data lazily (never throws).
  if (date === today) await ensureFreshLive(db);

  const { start, end } = etDayRange(date);
  const [games, teams] = await Promise.all([
    db.select().from(nbaGames).where(and(gte(nbaGames.startTime, start), lt(nbaGames.startTime, end))).orderBy(asc(nbaGames.startTime), asc(nbaGames.id)),
    db.select().from(nbaTeams),
  ]);
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const anyLive = date === today && games.some((g) => g.status === "in" || (g.status === "scheduled" && g.startTime.getTime() - Date.now() < 3_600_000));
  const label = fmtEtDate(start, { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  return (
    <div className="grid gap-4">
      {anyLive && <AutoRefresh seconds={30} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          {inLeague ? (
            <h2 className="text-xl font-semibold tracking-tight">NBA Scoreboard</h2>
          ) : (
            <h1 className="text-2xl font-bold tracking-tight">NBA Scoreboard</h1>
          )}
          <p className="text-sm text-muted-foreground">{label}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`${basePath}?date=${addDays(date, -1)}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Previous day
          </Link>
          <Link href={basePath} className={buttonVariants({ variant: date === today ? "default" : "outline", size: "sm" })}>
            Today
          </Link>
          <Link href={`${basePath}?date=${addDays(date, 1)}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Next day
          </Link>
          <form method="get" action={basePath} className="flex items-center gap-2">
            <Input type="date" name="date" defaultValue={date} aria-label="Go to date" className="w-auto" />
            <Button type="submit" variant="outline" size="sm">Go</Button>
          </form>
        </div>
      </div>

      {games.length === 0 ? (
        <p className="text-muted-foreground">No games scheduled for this day.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {games.map((g) => {
            const final = g.status === "final";
            const homeWon = final && (g.homeScore ?? 0) > (g.awayScore ?? 0);
            const awayWon = final && (g.awayScore ?? 0) > (g.homeScore ?? 0);
            return (
              <Card key={g.id} data-testid="game-card">
                <CardContent className="grid gap-2">
                  <div className="flex justify-end">
                    <Badge variant={g.status === "in" ? "default" : "secondary"}>{statusText(g)}</Badge>
                  </div>
                  <TeamLine team={teamById.get(g.awayTeamId)} fallbackId={g.awayTeamId} score={g.awayScore} winner={awayWon} />
                  <TeamLine team={teamById.get(g.homeTeamId)} fallbackId={g.homeTeamId} score={g.homeScore} winner={homeWon} />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
