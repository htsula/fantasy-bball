import Link from "next/link";
import { Trophy } from "lucide-react";
import { db } from "@/db";
import { leagues, teams } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { LEAGUE_STATUS_LABEL } from "@/lib/leagues/labels";
import { PLAYOFF_RESULT_LABEL } from "@/lib/seasons/labels";
import { getLeagueHistory, getNextSeasonId } from "@/lib/seasons/service";
import { fmtNum, seasonLabel } from "@/lib/nba/format";
import { NextSeasonButton } from "./next-season-button";

export const dynamic = "force-dynamic";

export default async function HistoryPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const { user, view } = await loadLeagueView(leagueId);
  const history = await getLeagueHistory(db, view.league.id);
  const nextId = await getNextSeasonId(db, view.league.id);
  // Season pages are members-only: link only the seasons the viewer has a team in (or any, for site admins).
  const mine = user.isSiteAdmin
    ? new Set(history.map((h) => h.leagueId))
    : new Set(
        (
          await db
            .select({ id: leagues.id })
            .from(teams)
            .innerJoin(leagues, eq(leagues.id, teams.leagueId))
            .where(and(eq(teams.ownerId, user.id), inArray(leagues.id, history.map((h) => h.leagueId))))
        ).map((r) => r.id),
      );
  const champions = history.filter((h) => h.champion);
  const canStartNext = view.isCommissioner && view.league.status === "complete" && !nextId;

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="text-xl font-semibold">League history</h2>
        <p className="text-sm text-muted-foreground">Every season of {view.league.name}, newest first.</p>
      </div>

      {canStartNext && (
        <Card size="sm" data-testid="next-season-card">
          <CardHeader>
            <CardTitle>Start the next season</CardTitle>
            <CardDescription>
              Creates a new league for {seasonLabel(view.league.season + 1)} with the same teams, owners and settings (dates
              reset). Then set up keepers, invite anyone new and generate the schedule.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <NextSeasonButton leagueId={view.league.id} />
          </CardContent>
        </Card>
      )}
      {nextId && view.league.status === "complete" && (
        <p className="text-sm">
          The next season has started.{" "}
          <Link href={`/leagues/${nextId}`} className="font-medium underline underline-offset-4">
            Go to it
          </Link>
          .
        </p>
      )}

      <Card size="sm" data-testid="champions-list">
        <CardHeader>
          <CardTitle>Champions</CardTitle>
        </CardHeader>
        <CardContent>
          {champions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No champion yet.</p>
          ) : (
            <ul className="grid gap-1 text-sm">
              {champions.map((h) => (
                <li key={h.leagueId} className="flex flex-wrap items-center gap-2" data-testid="champion-row">
                  <Trophy className="size-4 text-amber-500" aria-hidden />
                  <span className="font-medium">{seasonLabel(h.season)}</span>
                  <span>{h.champion!.teamName}</span>
                  {h.champion!.ownerUsername && <span className="text-muted-foreground">({h.champion!.ownerUsername})</span>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {history.map((h) => (
        <Card key={h.leagueId} size="sm" data-testid="season-card">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {mine.has(h.leagueId) ? (
                <Link href={`/leagues/${h.leagueId}`} className="underline-offset-4 hover:underline">
                  {seasonLabel(h.season)} season
                </Link>
              ) : (
                <span>{seasonLabel(h.season)} season</span>
              )}
              <Badge variant="secondary">{LEAGUE_STATUS_LABEL[h.status]}</Badge>
              {h.leagueId === view.league.id && <Badge variant="outline">This season</Badge>}
            </CardTitle>
            {h.champion && (
              <CardDescription>
                Champion: <span className="font-medium text-foreground">{h.champion.teamName}</span>
              </CardDescription>
            )}
          </CardHeader>
          {h.results.length > 0 && (
            <CardContent>
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8">#</TableHead>
                      <TableHead>Team</TableHead>
                      <TableHead className="text-right">W-L-T</TableHead>
                      <TableHead className="text-right">PF</TableHead>
                      <TableHead className="text-right">PA</TableHead>
                      <TableHead>Playoffs</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {h.results.map((r) => (
                      <TableRow key={`${h.leagueId}-${r.finalRank}`} data-testid="result-row">
                        <TableCell className="tabular-nums">{r.finalRank}</TableCell>
                        <TableCell className="font-medium">
                          {r.playoffResult === "champion" && <Trophy className="mr-1 inline size-4 text-amber-500" aria-label="Champion" />}
                          {r.teamName}
                          {r.ownerUsername && <span className="ml-2 font-normal text-muted-foreground">{r.ownerUsername}</span>}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">
                          {r.wins}-{r.losses}-{r.ties}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNum(r.pointsFor, 1)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNum(r.pointsAgainst, 1)}</TableCell>
                        <TableCell>{PLAYOFF_RESULT_LABEL[r.playoffResult]}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          )}
        </Card>
      ))}
    </div>
  );
}
