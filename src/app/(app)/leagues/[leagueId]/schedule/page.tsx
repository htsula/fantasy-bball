import { db } from "@/db";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { getSchedule } from "@/lib/leagues/service";
import { etDateString } from "@/lib/nba/dates";
import { fmtYmd } from "@/lib/nba/format";
import { GenerateScheduleButton } from "./generate-schedule-button";

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
        <p className="text-sm text-muted-foreground">The schedule hasn&apos;t been generated yet.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {periods.map((p) => (
            <Card key={p.id} size="sm" data-testid="schedule-period">
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  {p.isPlayoff ? `Playoffs - round ${p.playoffRound}` : `Week ${p.number}`}
                  {p.startDate <= today && today <= p.endDate && <Badge>Current</Badge>}
                </CardTitle>
                <CardDescription>
                  {fmtYmd(p.startDate)} - {fmtYmd(p.endDate)}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-1">
                {p.isPlayoff ? (
                  <p className="text-muted-foreground">Matchups are set when the regular season ends.</p>
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
                        </span>
                        {mine && <Badge variant="outline">You</Badge>}
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
