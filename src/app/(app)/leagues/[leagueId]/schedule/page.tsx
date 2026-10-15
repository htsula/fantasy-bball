import { db } from "@/db";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { getSchedule } from "@/lib/leagues/service";
import { periodLabel } from "@/lib/matchups/labels";
import { etDateString } from "@/lib/nba/dates";
import { fmtYmd } from "@/lib/nba/format";
import { GenerateScheduleButton } from "./generate-schedule-button";

const fmtScore = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export default async function SchedulePage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const { view } = await loadLeagueView(leagueId);
  const { league, teams, myTeam, isCommissioner } = view;
  const { periods } = await getSchedule(db, league.id);
  const byId = new Map(teams.map((t) => [t.id, t]));
  const today = etDateString(new Date());
  const name = (id: string | null) => (id ? (byId.get(id)?.name ?? "Unknown team") : "-");

  return (
    <div className="grid gap-4">
      {isCommissioner && league.status === "setup" && (
        <Card>
          <CardHeader>
            <CardTitle>Build the schedule</CardTitle>
            <CardDescription>
              Round-robin weekly matchups for the regular season; the last playoff rounds are reserved at the end. Do
              this after everyone has joined (adding or removing a team clears it).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <GenerateScheduleButton leagueId={league.id} hasSchedule={periods.length > 0} />
          </CardContent>
        </Card>
      )}

      {periods.length === 0 ? (
        <p className="text-sm text-muted-foreground">The schedule hasn&apos;t been generated yet.{" "}
          {isCommissioner
            ? league.status === "setup"
              ? "Use \"Generate schedule\" above once everyone has joined."
              : "Matchups can only be generated during setup."
            : "The commissioner generates it once everyone has joined, before the draft."}
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {periods.map((p) => (
            <Card key={p.id} size="sm" data-testid="schedule-period">
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  {p.isPlayoff ? `Playoffs: ${periodLabel(p, periods)}` : `Week ${p.number}`}
                  {p.startDate <= today && today <= p.endDate && <Badge>Current</Badge>}
                </CardTitle>
                <CardDescription>
                  {fmtYmd(p.startDate)} - {fmtYmd(p.endDate)}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-1">
                {p.matchups.length === 0 ? (
                  <p className="text-muted-foreground">
                    {p.isPlayoff ? "Matchups are set as the playoff bracket fills in." : "No matchups."}{" "}
                    {p.isPlayoff && <Link href={`/leagues/${league.id}/playoffs`} className="underline underline-offset-4">View bracket</Link>}
                  </p>
                ) : (
                  p.matchups.map((m) => {
                    const mine = myTeam && (m.homeTeamId === myTeam.id || m.awayTeamId === myTeam.id);
                    return (
                      <div
                        key={m.id}
                        data-testid="matchup"
                        data-mine={mine ? "true" : undefined}
                        className={`flex items-center justify-between gap-2 rounded-md px-2 py-1 ${mine ? "bg-primary/10 font-medium" : ""}`}
                      >
                        <span>
                          {m.awayTeamId ? `${name(m.homeTeamId)} vs ${name(m.awayTeamId)}` : `${name(m.homeTeamId)} - bye`}
                          {m.status === "final" && m.awayTeamId && m.homePoints !== null && m.awayPoints !== null && (
                            <span className="ml-2 tabular-nums" data-testid="matchup-score">
                              {fmtScore(m.homePoints)} - {fmtScore(m.awayPoints)}
                            </span>
                          )}
                          {m.status === "live" && <Badge className="ml-2 border-transparent bg-live text-live-foreground">Live</Badge>}
                        </span>
                        <span className="flex items-center gap-2">
                          {mine && <Badge variant="outline">You</Badge>}
                          {m.awayTeamId && (
                            <Link href={`/leagues/${league.id}/matchup/${m.id}`} className="text-xs underline underline-offset-4">
                              Box score
                            </Link>
                          )}
                        </span>
                      </div>
                    );
                  })
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
