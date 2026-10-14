import { notFound } from "next/navigation";
import { db } from "@/db";
import { InjuryBadge } from "@/components/nba/injury-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getTeamRoster } from "@/lib/draft/board";
import { fmtNum } from "@/lib/nba/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { maxRoster } from "@/lib/fantasy/roster-size";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { removeTeamAction } from "../../../actions";
import { RenameTeamForm } from "./team-forms";

export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string; teamId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { leagueId, teamId } = await params;
  const { error } = await searchParams;
  const { user, view } = await loadLeagueView(leagueId);
  const team = view.teams.find((t) => t.id === teamId);
  if (!team) notFound();
  const canEdit = team.ownerId === user.id || view.isCommissioner;
  const roster = await getTeamRoster(db, team.id);
  const max = maxRoster(view.teams.length, view.settings);
  const canRemove = view.isCommissioner && view.league.status === "setup" && team.ownerId !== view.league.commissionerId;

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="text-xl font-semibold">
          {team.name} <Badge variant="outline">{team.abbrev}</Badge>
        </h2>
        <p className="text-sm text-muted-foreground">
          Owner: {team.ownerUsername}
          {team.ownerId === view.league.commissionerId ? " (commissioner)" : ""}
        </p>
      </div>
      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <Card data-testid="team-roster">
        <CardHeader>
          <CardTitle>
            Roster ({roster.length}/{max})
          </CardTitle>
          <CardDescription>
            {roster.length === 0
              ? view.league.status === "setup"
                ? "Roster appears after the draft."
                : "No players on this roster."
              : "Positions are informational: every player scores every day."}
          </CardDescription>
        </CardHeader>
        {roster.length > 0 && (
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Player</TableHead>
                    <TableHead>Pos</TableHead>
                    <TableHead>NBA</TableHead>
                    <TableHead className="text-right">FP/G</TableHead>
                    <TableHead className="text-right">Proj</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {roster.map((p) => (
                    <TableRow key={p.id} data-testid="roster-row">
                      <TableCell className="font-medium">
                        <span className="mr-1">{p.name}</span>
                        <InjuryBadge status={p.injuryStatus} detail={p.injuryDetail} />
                      </TableCell>
                      <TableCell>{p.positions.join("/") || "-"}</TableCell>
                      <TableCell>{p.nbaTeam ?? "-"}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(p.avg)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(p.proj)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        )}
      </Card>

      {canEdit && (
        <Card>
          <CardHeader>
            <CardTitle>Team details</CardTitle>
          </CardHeader>
          <CardContent>
            <RenameTeamForm leagueId={leagueId} teamId={team.id} name={team.name} abbrev={team.abbrev} />
          </CardContent>
        </Card>
      )}

      {canRemove && (
        <Card>
          <CardHeader>
            <CardTitle>Remove team</CardTitle>
            <CardDescription>Only possible during setup. The schedule will need to be regenerated.</CardDescription>
          </CardHeader>
          <CardContent>
            <form action={removeTeamAction.bind(null, leagueId, team.id)}>
              <Button type="submit" variant="destructive">
                Remove team
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
