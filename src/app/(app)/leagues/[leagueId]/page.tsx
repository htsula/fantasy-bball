import Link from "next/link";
import { db } from "@/db";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { waveText } from "@/components/leagues/rules-summary";
import { maxRoster, snakeRounds } from "@/lib/fantasy/roster-size";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { getSchedule } from "@/lib/leagues/service";
import { getDraftByLeague } from "@/lib/draft/service";
import { fmtYmd } from "@/lib/nba/format";

export default async function LeagueHomePage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const { view } = await loadLeagueView(leagueId);
  const { league, settings, teams, myTeam, isCommissioner } = view;
  const schedule = await getSchedule(db, league.id);
  const draft = await getDraftByLeague(db, league.id);
  const n = teams.length;
  const regular = schedule.periods.filter((p) => !p.isPlayoff);
  const playoff = schedule.periods.filter((p) => p.isPlayoff);
  const base = `/leagues/${league.id}`;

  return (
    <div className="grid gap-6">
      {settings.playoffTeams > n && (
        <p className="rounded-md bg-muted px-3 py-2 text-sm">
          Playoffs are set to {settings.playoffTeams} teams but the league has {n}. Lower it in settings or add teams
          before generating the schedule.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Teams" value={String(n)} />
        <Stat label="Max roster" value={String(maxRoster(n, settings))} hint={`min(${settings.rosterCap}, ⌊${settings.rosterPool} ÷ ${n}⌋)`} />
        <Stat label="Snake rounds" value={String(snakeRounds(n, settings))} />
        <Stat label="Waves" value={waveText(n, settings)} small />
      </div>

      <Card data-testid="draft-card">
        <CardHeader>
          <CardTitle>Draft</CardTitle>
          <CardDescription>
            {!draft && "Not started. Each team can build a queue before the commissioner starts the draft."}
            {draft?.status === "snake" && "The snake draft is underway."}
            {draft?.status === "waves" && "The wave phase is underway: everyone picks at once."}
            {draft?.status === "complete" && "The draft is complete."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href={`${base}/draft`} className={buttonVariants({ variant: draft?.status === "complete" ? "outline" : "default", size: "sm" }) + " w-fit"}>
            {!draft ? (isCommissioner ? "Set up the draft" : "Build your queue") : draft.status === "complete" ? "View draft recap" : "Go to the draft room"}
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Teams</CardTitle>
          <CardDescription>
            {myTeam ? `You manage ${myTeam.name}.` : "You are viewing this league as a site admin."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Team</TableHead>
                <TableHead>Abbrev</TableHead>
                <TableHead>Owner</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {teams.map((t) => (
                <TableRow key={t.id} data-testid="team-row">
                  <TableCell className="font-medium">
                    <Link href={`${base}/teams/${t.id}`} className="underline-offset-4 hover:underline">
                      {t.name}
                    </Link>{" "}
                    {t.id === myTeam?.id && <Badge variant="outline">You</Badge>}
                  </TableCell>
                  <TableCell>{t.abbrev}</TableCell>
                  <TableCell>
                    {t.ownerUsername}
                    {t.ownerId === league.commissionerId && (
                      <span className="text-muted-foreground"> (commissioner)</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Schedule</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          {schedule.periods.length === 0 ? (
            <p className="text-muted-foreground">
              No schedule yet.{isCommissioner ? " Generate it from the schedule page once your teams have joined." : ""}
            </p>
          ) : (
            <p>
              {regular.length} regular-season weeks ({fmtYmd(regular[0].startDate)} to{" "}
              {fmtYmd(regular[regular.length - 1].endDate)}) followed by {playoff.length} playoff{" "}
              {playoff.length === 1 ? "week" : "weeks"} ending {fmtYmd(schedule.periods[schedule.periods.length - 1].endDate, true)}.
            </p>
          )}
          <Link href={`${base}/schedule`} className={buttonVariants({ variant: "outline", size: "sm" }) + " w-fit"}>
            {schedule.periods.length === 0 && isCommissioner ? "Set up schedule" : "View schedule"}
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, hint, small }: { label: string; value: string; hint?: string; small?: boolean }) {
  return (
    <Card size="sm">
      <CardContent className="grid gap-1">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className={small ? "text-sm font-semibold" : "text-2xl font-bold tabular-nums"}>{value}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </CardContent>
    </Card>
  );
}
